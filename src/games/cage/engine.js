// Pure physics engine for CAGE FOOTBALL — last side standing.
//
// A square cage with a goal mouth in each wall. 2–4 sides play at once, each
// side owned by a team of 1–2 players. TWO balls are live so everyone attacks
// and defends. Concede 5 and your side is eliminated — the goal seals into
// solid wall and your players leave the pitch. Every goal resets positions
// (short freeze). Last side standing wins.
//
// Pure + deterministic: fixed 30Hz timestep, no Date.now, no Math.random —
// step(state, inputsBySeat) is the whole simulation. Loaded by BOTH the
// Durable Object (authoritative, runs ~DELAY_MS behind real time and applies
// inputs at the tick they were PRESSED — chicken-style latency fairness) and
// the client (same step function powers local prediction of your own player).
//
// Controls per player: 8-direction movement + one KICK button. Kicking a ball
// within reach fires it along your movement direction (or away from you if
// standing still) — a tap toward your teammate is a pass, a sprint + kick is
// a shot. Short cooldown.

export const TICK_RATE = 30;
export const TICK_MS = 1000 / TICK_RATE;
export const DELAY_MS = 120;            // authoritative sim runs this far behind
export const ARENA = 600;               // square side length, world units
export const GOAL_W = 180;              // goal mouth width, centered per wall
export const PLAYER_R = 14;
export const BALL_R = 9;
export const MAX_SIDES = 4;
export const MIN_SIDES = 2;
export const MAX_PER_SIDE = 2;
export const LOSE_AT = 5;               // conceded goals → eliminated

export const ACCEL = 0.75;              // per tick, applied along input dir
export const FRICTION = 0.88;           // player velocity damping per tick
export const MAX_SPEED = 5.2;           // player units/tick (now reachable: terminal ≈ ACCEL·F/(1−F) ≈ 5.5)
export const BALL_FRICTION = 0.985;     // rolling resistance
export const WALL_RESTITUTION = 0.92;
export const BALL_PLAYER_PUSH = 1.05;   // body-touch transfer of player velocity
export const BALL_MIN_SPEED = 0.02;     // below this the ball stops
export const BALL_MAX_SPEED = 16;       // hard cap so accumulated pushes/kicks can't tunnel
export const KICK_RANGE = PLAYER_R + BALL_R + 10;
export const KICK_POWER = 11;
export const KICK_CARRY = 0.35;         // fraction of player velocity added
export const KICK_CD_TICKS = 9;         // 0.3s
export const FREEZE_TICKS = 45;         // 1.5s opening countdown
export const GOAL_FREEZE_TICKS = 30;    // 1.0s reset pause after each goal (snappier than the kickoff)
export const MAX_MATCH_TICKS = TICK_RATE * 600; // 10 min hard stop

// Walls / sides, indexed 0..3. Each wall owns one goal mouth.
export const WALLS = ["top", "right", "bottom", "left"];
export const SIDE_COLORS = ["#ff1f7a", "#00ff9d", "#ffd400", "#4da6ff"];

// Input bitmask
export const KEY_UP = 1, KEY_DOWN = 2, KEY_LEFT = 4, KEY_RIGHT = 8, KEY_KICK = 16;

const GOAL_LO = (ARENA - GOAL_W) / 2;
const GOAL_HI = (ARENA + GOAL_W) / 2;

function inMouth(v) {
  return v >= GOAL_LO && v <= GOAL_HI;
}

// Spawn positions: team stands in front of its own goal; two players offset
// along the wall.
function spawnFor(wall, slot, teamSize) {
  const inset = 70;
  const off = teamSize === 1 ? 0 : slot === 0 ? -45 : 45;
  switch (WALLS[wall]) {
    case "top": return { x: ARENA / 2 + off, y: inset };
    case "right": return { x: ARENA - inset, y: ARENA / 2 + off };
    case "bottom": return { x: ARENA / 2 + off, y: ARENA - inset };
    case "left": return { x: inset, y: ARENA / 2 + off };
    default: return { x: ARENA / 2, y: ARENA / 2 };
  }
}

function ballSpawns() {
  return [
    { x: ARENA / 2, y: ARENA / 2 - 50, vx: 0, vy: 0 },
    { x: ARENA / 2, y: ARENA / 2 + 50, vx: 0, vy: 0 },
  ];
}

// sides: [{ wall: 0..3, players: [{ seatId, name }] }] — 2..4 entries,
// 1..MAX_PER_SIDE players each.
export function createMatch(sides) {
  if (sides.length < MIN_SIDES) throw new Error(`Need at least ${MIN_SIDES} sides`);
  if (sides.length > MAX_SIDES) throw new Error(`Max ${MAX_SIDES} sides`);
  const walls = new Set(sides.map((s) => s.wall));
  if (walls.size !== sides.length) throw new Error("Duplicate walls");
  for (const s of sides) {
    if (!s.players?.length || s.players.length > MAX_PER_SIDE) {
      throw new Error(`Each side needs 1–${MAX_PER_SIDE} players`);
    }
  }
  const players = [];
  for (const s of sides) {
    s.players.forEach((p, slot) => {
      const at = spawnFor(s.wall, slot, s.players.length);
      players.push({
        seatId: p.seatId,
        name: p.name,
        wall: s.wall,
        slot,
        x: at.x,
        y: at.y,
        vx: 0,
        vy: 0,
        dirX: 0,
        dirY: 0,           // last non-zero movement dir (kick aim)
        kickCd: 0,
        kickedTick: -99,   // for client kick animation
      });
    });
  }
  return {
    tick: 0,
    freeze: FREEZE_TICKS,  // opening countdown uses the same freeze
    sides: sides.map((s) => ({
      wall: s.wall,
      conceded: 0,
      eliminated: false,
      eliminatedAtTick: null,
    })),
    players,
    balls: ballSpawns(),
    events: [],            // rolling: goal, eliminated, match_over
    results: null,         // ranked walls when over
  };
}

function pushEvent(state, e) {
  state.events.push({ tick: state.tick, ...e });
  if (state.events.length > 30) state.events.splice(0, state.events.length - 30);
}

// Bound a ball's velocity so kicks-on-kicks, body pushes and ball↔ball swaps
// can't compound into a speed that skips through a wall in one tick.
function clampBallSpeed(ball) {
  const s = Math.hypot(ball.vx, ball.vy);
  if (s > BALL_MAX_SPEED) {
    ball.vx = (ball.vx / s) * BALL_MAX_SPEED;
    ball.vy = (ball.vy / s) * BALL_MAX_SPEED;
  }
}

function activeSides(state) {
  return state.sides.filter((s) => !s.eliminated);
}

function sideByWall(state, wall) {
  return state.sides.find((s) => s.wall === wall);
}

// A wall's goal mouth is open only while its side is alive.
function mouthOpen(state, wall) {
  const s = sideByWall(state, wall);
  return !!s && !s.eliminated;
}

function resetPositions(state) {
  for (const p of state.players) {
    const side = sideByWall(state, p.wall);
    if (side?.eliminated) continue;
    const team = state.players.filter((q) => q.wall === p.wall);
    const at = spawnFor(p.wall, p.slot, team.length);
    p.x = at.x; p.y = at.y; p.vx = 0; p.vy = 0; p.kickCd = 0;
  }
  state.balls = ballSpawns();
  state.freeze = GOAL_FREEZE_TICKS;
}

function finishMatch(state) {
  // Rank: survivors first (fewest conceded), then by elimination recency.
  state.results = state.sides
    .slice()
    .sort((a, b) => {
      if (a.eliminated !== b.eliminated) return a.eliminated ? 1 : -1;
      if (!a.eliminated) return a.conceded - b.conceded;
      return b.eliminatedAtTick - a.eliminatedAtTick;
    })
    .map((s) => ({ wall: s.wall, conceded: s.conceded, eliminated: s.eliminated }));
  pushEvent(state, { kind: "match_over", winnerWall: state.results[0].wall });
}

// Advance one tick. inputsBySeat: { seatId: bitmask }.
// Mutates and returns state (the DO owns its copy; clients predict on clones).
export function step(state, inputsBySeat = {}) {
  if (state.results) return state;
  state.tick += 1;

  if (state.freeze > 0) {
    state.freeze -= 1;
    return state;
  }

  // ── Players ─────────────────────────────────────────────────────
  for (const p of state.players) {
    const side = sideByWall(state, p.wall);
    if (side.eliminated) continue;
    const keys = Number(inputsBySeat[p.seatId]) || 0;
    let ax = 0, ay = 0;
    if (keys & KEY_UP) ay -= 1;
    if (keys & KEY_DOWN) ay += 1;
    if (keys & KEY_LEFT) ax -= 1;
    if (keys & KEY_RIGHT) ax += 1;
    if (ax || ay) {
      const n = Math.hypot(ax, ay);
      p.dirX = ax / n;
      p.dirY = ay / n;
      p.vx += (ax / n) * ACCEL;
      p.vy += (ay / n) * ACCEL;
    }
    p.vx *= FRICTION;
    p.vy *= FRICTION;
    const sp = Math.hypot(p.vx, p.vy);
    if (sp > MAX_SPEED) {
      p.vx = (p.vx / sp) * MAX_SPEED;
      p.vy = (p.vy / sp) * MAX_SPEED;
    }
    p.x += p.vx;
    p.y += p.vy;
    // Players never leave the cage (goal mouths included — only balls score).
    p.x = Math.max(PLAYER_R, Math.min(ARENA - PLAYER_R, p.x));
    p.y = Math.max(PLAYER_R, Math.min(ARENA - PLAYER_R, p.y));
    if (p.kickCd > 0) p.kickCd -= 1;
  }

  // Player↔player separation (equal mass push-apart).
  const alive = state.players.filter((p) => !sideByWall(state, p.wall).eliminated);
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const a = alive[i], b = alive[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      const min = PLAYER_R * 2;
      if (d > 0 && d < min) {
        const push = (min - d) / 2;
        const nx = dx / d, ny = dy / d;
        a.x -= nx * push; a.y -= ny * push;
        b.x += nx * push; b.y += ny * push;
      }
    }
  }

  // ── Kicks ───────────────────────────────────────────────────────
  for (const p of alive) {
    const keys = Number(inputsBySeat[p.seatId]) || 0;
    if (!(keys & KEY_KICK) || p.kickCd > 0) continue;
    // Nearest ball in reach
    let best = null, bestD = Infinity;
    for (const ball of state.balls) {
      const d = Math.hypot(ball.x - p.x, ball.y - p.y);
      if (d < KICK_RANGE && d < bestD) { best = ball; bestD = d; }
    }
    if (!best) continue;
    let aimX = p.dirX, aimY = p.dirY;
    if (!aimX && !aimY) {
      const d = Math.max(0.001, bestD);
      aimX = (best.x - p.x) / d;
      aimY = (best.y - p.y) / d;
    }
    best.vx = aimX * KICK_POWER + p.vx * KICK_CARRY;
    best.vy = aimY * KICK_POWER + p.vy * KICK_CARRY;
    clampBallSpeed(best);
    p.kickCd = KICK_CD_TICKS;
    p.kickedTick = state.tick;
  }

  // ── Balls ───────────────────────────────────────────────────────
  // Each ball scores at most once per tick (the first open mouth it crosses);
  // several balls finding open goals on the same tick all count.
  const scoredWalls = [];
  for (const ball of state.balls) {
    clampBallSpeed(ball);          // bound travel this tick (anti-tunnel)
    ball.x += ball.vx;
    ball.y += ball.vy;
    ball.vx *= BALL_FRICTION;
    ball.vy *= BALL_FRICTION;
    if (Math.hypot(ball.vx, ball.vy) < BALL_MIN_SPEED) { ball.vx = 0; ball.vy = 0; }

    // Walls + goals. A ball whose center crosses a wall inside an OPEN mouth
    // scores against that wall's side; otherwise it bounces. `goalWall` latches
    // per ball so a corner crossing can't double-count one ball.
    let goalWall = null;
    if (ball.y < BALL_R) {
      if (goalWall === null && mouthOpen(state, 0) && inMouth(ball.x)) goalWall = 0;
      else { ball.y = BALL_R; ball.vy = Math.abs(ball.vy) * WALL_RESTITUTION; }
    }
    if (ball.y > ARENA - BALL_R) {
      if (goalWall === null && mouthOpen(state, 2) && inMouth(ball.x)) goalWall = 2;
      else { ball.y = ARENA - BALL_R; ball.vy = -Math.abs(ball.vy) * WALL_RESTITUTION; }
    }
    if (ball.x < BALL_R) {
      if (goalWall === null && mouthOpen(state, 3) && inMouth(ball.y)) goalWall = 3;
      else { ball.x = BALL_R; ball.vx = Math.abs(ball.vx) * WALL_RESTITUTION; }
    }
    if (ball.x > ARENA - BALL_R) {
      if (goalWall === null && mouthOpen(state, 1) && inMouth(ball.y)) goalWall = 1;
      else { ball.x = ARENA - BALL_R; ball.vx = -Math.abs(ball.vx) * WALL_RESTITUTION; }
    }
    if (goalWall !== null) scoredWalls.push(goalWall);

    // Ball↔player: push out + reflect, inheriting body velocity.
    for (const p of alive) {
      const dx = ball.x - p.x, dy = ball.y - p.y;
      const d = Math.hypot(dx, dy);
      const min = PLAYER_R + BALL_R;
      if (d > 0 && d < min) {
        const nx = dx / d, ny = dy / d;
        ball.x = p.x + nx * min;
        ball.y = p.y + ny * min;
        const vn = ball.vx * nx + ball.vy * ny;
        if (vn < 0) {
          ball.vx -= 2 * vn * nx;
          ball.vy -= 2 * vn * ny;
        }
        ball.vx += p.vx * BALL_PLAYER_PUSH * 0.5;
        ball.vy += p.vy * BALL_PLAYER_PUSH * 0.5;
        clampBallSpeed(ball);
      }
    }
  }

  // Ball↔ball (elastic swap along the normal) — all pairs, so the engine is
  // correct for any number of balls, not only two.
  for (let i = 0; i < state.balls.length; i++) {
    for (let j = i + 1; j < state.balls.length; j++) {
      const b1 = state.balls[i], b2 = state.balls[j];
      const dx = b2.x - b1.x, dy = b2.y - b1.y;
      const d = Math.hypot(dx, dy);
      const min = BALL_R * 2;
      if (d > 0 && d < min) {
        const nx = dx / d, ny = dy / d;
        const push = (min - d) / 2;
        b1.x -= nx * push; b1.y -= ny * push;
        b2.x += nx * push; b2.y += ny * push;
        const v1n = b1.vx * nx + b1.vy * ny;
        const v2n = b2.vx * nx + b2.vy * ny;
        b1.vx += (v2n - v1n) * nx; b1.vy += (v2n - v1n) * ny;
        b2.vx += (v1n - v2n) * nx; b2.vy += (v1n - v2n) * ny;
        clampBallSpeed(b1); clampBallSpeed(b2);
      }
    }
  }

  // Safety net: a ball that scored (passes through its mouth) or one shoved by
  // a wall-pinned body can land a center a few units past the boundary. Goals
  // are already recorded above, so keep every ball inside the cage for the
  // snapshot — no ball is ever drawn in or beyond a wall.
  for (const ball of state.balls) {
    ball.x = Math.max(BALL_R, Math.min(ARENA - BALL_R, ball.x));
    ball.y = Math.max(BALL_R, Math.min(ARENA - BALL_R, ball.y));
  }

  // ── Goals ────────────────────────────────────────────────────────
  // Apply every ball that scored this tick (usually one); a side already
  // sealed this tick by an earlier goal can't be conceded against twice.
  if (scoredWalls.length > 0) {
    for (const wall of scoredWalls) {
      const side = sideByWall(state, wall);
      if (!side || side.eliminated) continue;
      side.conceded += 1;
      pushEvent(state, { kind: "goal", wall, conceded: side.conceded });
      if (side.conceded >= LOSE_AT) {
        side.eliminated = true;
        side.eliminatedAtTick = state.tick;
        pushEvent(state, { kind: "eliminated", wall });
      }
    }
    if (activeSides(state).length <= 1) {
      finishMatch(state);
      return state;
    }
    resetPositions(state);
  }

  if (state.tick >= MAX_MATCH_TICKS && !state.results) finishMatch(state);
  return state;
}

// Compact public snapshot (nothing is secret; trim what clients don't draw).
export function snapshot(state) {
  return {
    tick: state.tick,
    freeze: state.freeze,
    sides: state.sides,
    players: state.players.map((p) => ({
      seatId: p.seatId,
      name: p.name,
      wall: p.wall,
      x: Math.round(p.x * 10) / 10,
      y: Math.round(p.y * 10) / 10,
      vx: Math.round(p.vx * 100) / 100,
      vy: Math.round(p.vy * 100) / 100,
      kickedTick: p.kickedTick,
    })),
    balls: state.balls.map((b) => ({
      x: Math.round(b.x * 10) / 10,
      y: Math.round(b.y * 10) / 10,
      vx: Math.round(b.vx * 100) / 100,
      vy: Math.round(b.vy * 100) / 100,
    })),
    events: state.events.slice(-6),
    results: state.results,
  };
}

// Client-side prediction step for YOUR player only: same movement physics,
// walls only (balls and other players stay server-authoritative).
export function predictPlayer(p, keys) {
  const out = { ...p };
  let ax = 0, ay = 0;
  if (keys & KEY_UP) ay -= 1;
  if (keys & KEY_DOWN) ay += 1;
  if (keys & KEY_LEFT) ax -= 1;
  if (keys & KEY_RIGHT) ax += 1;
  if (ax || ay) {
    const n = Math.hypot(ax, ay);
    out.vx += (ax / n) * ACCEL;
    out.vy += (ay / n) * ACCEL;
  }
  out.vx *= FRICTION;
  out.vy *= FRICTION;
  const sp = Math.hypot(out.vx, out.vy);
  if (sp > MAX_SPEED) {
    out.vx = (out.vx / sp) * MAX_SPEED;
    out.vy = (out.vy / sp) * MAX_SPEED;
  }
  out.x = Math.max(PLAYER_R, Math.min(ARENA - PLAYER_R, out.x + out.vx));
  out.y = Math.max(PLAYER_R, Math.min(ARENA - PLAYER_R, out.y + out.vy));
  return out;
}
