// Node test script for the cage football engine.
// Run: node src/games/cage/engine.test.mjs
import assert from "node:assert/strict";
import {
  createMatch, step, snapshot, predictPlayer,
  ARENA, GOAL_W, PLAYER_R, BALL_R, LOSE_AT, FREEZE_TICKS, MAX_MATCH_TICKS,
  KEY_UP, KEY_DOWN, KEY_LEFT, KEY_RIGHT, KEY_KICK,
  KICK_CD_TICKS, MAX_SPEED,
} from "./engine.js";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(e);
    process.exit(1);
  }
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SIDES4 = [
  { wall: 0, players: [{ seatId: "a", name: "A" }] },
  { wall: 1, players: [{ seatId: "b", name: "B" }] },
  { wall: 2, players: [{ seatId: "c", name: "C" }] },
  { wall: 3, players: [{ seatId: "d", name: "D" }] },
];

function thaw(state) {
  while (state.freeze > 0) step(state, {});
  return state;
}

console.log("setup");

test("createMatch validates sides and teams", () => {
  assert.throws(() => createMatch([SIDES4[0]]));
  assert.throws(() => createMatch([...SIDES4, { wall: 0, players: [{ seatId: "x", name: "X" }] }]));
  assert.throws(() => createMatch([
    { wall: 0, players: [] },
    { wall: 1, players: [{ seatId: "b", name: "B" }] },
  ]));
  assert.throws(() => createMatch([
    { wall: 0, players: [{ seatId: "1" }, { seatId: "2" }, { seatId: "3" }] },
    { wall: 1, players: [{ seatId: "b", name: "B" }] },
  ]));
  const m = createMatch(SIDES4);
  assert.equal(m.players.length, 4);
  assert.equal(m.balls.length, 2);
  assert.equal(m.freeze, FREEZE_TICKS);
});

test("teams of two spawn side by side in front of their goal", () => {
  const m = createMatch([
    { wall: 0, players: [{ seatId: "a1", name: "A1" }, { seatId: "a2", name: "A2" }] },
    { wall: 2, players: [{ seatId: "c1", name: "C1" }] },
  ]);
  const [a1, a2] = m.players.filter((p) => p.wall === 0);
  assert.ok(a1.y < ARENA / 2 && a2.y < ARENA / 2, "team 0 near top");
  assert.ok(Math.abs(a1.x - a2.x) > 50, "teammates offset apart");
});

console.log("movement & physics");

test("freeze holds everyone still, then movement works", () => {
  const m = createMatch(SIDES4);
  const x0 = m.players[0].x;
  step(m, { a: KEY_RIGHT });
  assert.equal(m.players[0].x, x0, "frozen players don't move");
  thaw(m);
  for (let i = 0; i < 20; i++) step(m, { a: KEY_RIGHT });
  assert.ok(m.players[0].x > x0, "player moves right after thaw");
});

test("players are speed-capped and never leave the cage", () => {
  const m = thaw(createMatch(SIDES4));
  for (let i = 0; i < 300; i++) {
    step(m, { a: KEY_LEFT | KEY_UP, b: KEY_RIGHT, c: KEY_DOWN, d: KEY_LEFT });
    for (const p of m.players) {
      assert.ok(p.x >= PLAYER_R - 1e-9 && p.x <= ARENA - PLAYER_R + 1e-9);
      assert.ok(p.y >= PLAYER_R - 1e-9 && p.y <= ARENA - PLAYER_R + 1e-9);
      assert.ok(Math.hypot(p.vx, p.vy) <= MAX_SPEED + 1e-9);
    }
  }
});

test("players push apart instead of overlapping", () => {
  const m = thaw(createMatch(SIDES4));
  m.players[0].x = 300; m.players[0].y = 300;
  m.players[1].x = 305; m.players[1].y = 300;
  step(m, {});
  const d = Math.hypot(m.players[1].x - m.players[0].x, m.players[1].y - m.players[0].y);
  assert.ok(d >= PLAYER_R * 2 - 1e-6, `separated (d=${d.toFixed(1)})`);
});

test("ball bounces off solid wall sections", () => {
  const m = thaw(createMatch(SIDES4));
  // Aim at top wall OUTSIDE the mouth (mouth is centered).
  m.balls[0].x = 50; m.balls[0].y = 30; m.balls[0].vx = 0; m.balls[0].vy = -10;
  for (let i = 0; i < 5 && m.balls[0].vy <= 0; i++) step(m, {});
  assert.ok(m.balls[0].vy > 0, "ball reflected downward");
  assert.equal(m.sides[0].conceded, 0);
});

console.log("kicking");

test("kick fires the ball along movement direction with cooldown", () => {
  const m = thaw(createMatch(SIDES4));
  const p = m.players[0];
  p.x = 300; p.y = 300; p.dirX = 1; p.dirY = 0;
  m.balls[0].x = 318; m.balls[0].y = 300; m.balls[0].vx = 0; m.balls[0].vy = 0;
  m.balls[1].x = 100; m.balls[1].y = 100;
  step(m, { a: KEY_KICK });
  assert.ok(m.balls[0].vx > 8, `ball fired right (vx=${m.balls[0].vx.toFixed(1)})`);
  assert.equal(m.players[0].kickCd, KICK_CD_TICKS - 0); // set this tick
  // Cooldown blocks immediate re-kick
  m.balls[0].x = m.players[0].x + 18; m.balls[0].y = m.players[0].y;
  m.balls[0].vx = 0; m.balls[0].vy = 0;
  step(m, { a: KEY_KICK });
  assert.ok(Math.abs(m.balls[0].vx) < 8, "cooldown prevents instant re-kick");
});

test("kick out of range does nothing", () => {
  const m = thaw(createMatch(SIDES4));
  m.players[0].x = 300; m.players[0].y = 300;
  m.balls[0].x = 400; m.balls[0].y = 300; m.balls[0].vx = 0; m.balls[0].vy = 0;
  m.balls[1].x = 100; m.balls[1].y = 100; m.balls[1].vx = 0; m.balls[1].vy = 0;
  step(m, { a: KEY_KICK });
  assert.equal(m.balls[0].vx, 0);
});

console.log("goals & elimination");

function scoreOn(m, wall) {
  // Place ball just inside the mouth of `wall`, moving out.
  const mid = ARENA / 2;
  const b = m.balls[0];
  m.balls[1].x = mid; m.balls[1].y = mid; m.balls[1].vx = 0; m.balls[1].vy = 0;
  if (wall === 0) { b.x = mid; b.y = BALL_R + 2; b.vx = 0; b.vy = -8; }
  if (wall === 1) { b.x = ARENA - BALL_R - 2; b.y = mid; b.vx = 8; b.vy = 0; }
  if (wall === 2) { b.x = mid; b.y = ARENA - BALL_R - 2; b.vx = 0; b.vy = 8; }
  if (wall === 3) { b.x = BALL_R + 2; b.y = mid; b.vx = -8; b.vy = 0; }
  // keep players away from the ball
  for (const p of m.players) { p.x = 300; p.y = 300; p.vx = 0; p.vy = 0; }
  m.players.forEach((p, i) => { p.x = 200 + i * 40; });
  step(m, {});
}

test("ball through an open mouth scores and resets with a freeze", () => {
  const m = thaw(createMatch(SIDES4));
  scoreOn(m, 0);
  assert.equal(m.sides[0].conceded, 1);
  assert.equal(m.freeze, FREEZE_TICKS, "post-goal freeze");
  assert.ok(Math.abs(m.balls[0].x - ARENA / 2) < 1, "balls re-centered");
  const ev = m.events[m.events.length - 1];
  assert.equal(ev.kind, "goal");
  assert.equal(ev.wall, 0);
});

test("5 conceded eliminates the side and seals its goal", () => {
  const m = thaw(createMatch(SIDES4));
  for (let g = 0; g < LOSE_AT; g++) {
    thaw(m);
    scoreOn(m, 0);
  }
  assert.equal(m.sides[0].eliminated, true);
  assert.ok(m.events.some((e) => e.kind === "eliminated" && e.wall === 0));
  assert.equal(m.results, null, "3 sides still alive");
  // Sealed mouth now bounces instead of scoring
  thaw(m);
  m.balls[0].x = ARENA / 2; m.balls[0].y = BALL_R + 2; m.balls[0].vx = 0; m.balls[0].vy = -8;
  m.balls[1].x = 300; m.balls[1].y = 300; m.balls[1].vx = 0; m.balls[1].vy = 0;
  for (const p of m.players) { p.x = 300; p.y = 350; p.vx = 0; p.vy = 0; }
  const conceded = m.sides[0].conceded;
  step(m, {});
  assert.equal(m.sides[0].conceded, conceded, "sealed goal can't concede");
  assert.ok(m.balls[0].vy > 0, "ball bounced off sealed mouth");
});

test("last side standing wins; results ranked by elimination order", () => {
  const m = thaw(createMatch(SIDES4));
  const order = [0, 1, 2]; // eliminate top, right, bottom → left (3) wins
  for (const wall of order) {
    for (let g = 0; g < LOSE_AT; g++) {
      thaw(m);
      if (m.results) break;
      scoreOn(m, wall);
    }
  }
  assert.ok(m.results, "match over");
  assert.equal(m.results[0].wall, 3, "left side wins");
  assert.equal(m.results[0].eliminated, false);
  // Last eliminated ranks ahead of earlier eliminations
  assert.equal(m.results[1].wall, 2);
  assert.equal(m.results[3].wall, 0);
});

test("two-side duel: one elimination ends the match", () => {
  const m = thaw(createMatch([
    { wall: 1, players: [{ seatId: "b", name: "B" }] },
    { wall: 3, players: [{ seatId: "d", name: "D" }] },
  ]));
  // Unused walls (0, 2) behave as sealed: no side exists there.
  m.balls[0].x = ARENA / 2; m.balls[0].y = BALL_R + 2; m.balls[0].vx = 0; m.balls[0].vy = -8;
  step(m, {});
  assert.ok(m.balls[0].vy > 0, "no goal on unowned wall");
  for (let g = 0; g < LOSE_AT; g++) {
    thaw(m);
    scoreOn(m, 1);
  }
  assert.ok(m.results, "duel over after one elimination");
  assert.equal(m.results[0].wall, 3);
});

console.log("misc");

test("match hard-stops at MAX_MATCH_TICKS with conceded-based ranking", () => {
  const m = thaw(createMatch(SIDES4));
  m.sides[1].conceded = 3;
  m.tick = MAX_MATCH_TICKS - 1;
  step(m, {});
  assert.ok(m.results);
  assert.notEqual(m.results[0].wall, 1, "most-conceded side can't win on timeout");
});

test("simulation is deterministic", () => {
  const run = () => {
    const m = createMatch(SIDES4);
    const rng = mulberry32(5);
    for (let i = 0; i < 600 && !m.results; i++) {
      const keys = () => Math.floor(rng() * 32);
      step(m, { a: keys(), b: keys(), c: keys(), d: keys() });
    }
    return JSON.stringify(snapshot(m));
  };
  assert.equal(run(), run());
});

test("snapshot is lean and JSON-safe", () => {
  const m = thaw(createMatch(SIDES4));
  for (let i = 0; i < 30; i++) step(m, { a: KEY_RIGHT | KEY_KICK });
  const s = JSON.parse(JSON.stringify(snapshot(m)));
  assert.equal(s.players.length, 4);
  assert.ok(!("kickCd" in s.players[0]));
  assert.ok(!("dirX" in s.players[0]));
});

test("predictPlayer matches engine movement physics for a free player", () => {
  const m = thaw(createMatch(SIDES4));
  // isolate player a away from others/balls
  m.players[0].x = 150; m.players[0].y = 300;
  m.balls[0].x = 450; m.balls[0].y = 450; m.balls[1].x = 470; m.balls[1].y = 470;
  let ghost = { ...m.players[0] };
  for (let i = 0; i < 40; i++) {
    step(m, { a: KEY_RIGHT | KEY_DOWN });
    ghost = predictPlayer(ghost, KEY_RIGHT | KEY_DOWN);
  }
  assert.ok(Math.abs(ghost.x - m.players[0].x) < 0.001, "prediction tracks server x");
  assert.ok(Math.abs(ghost.y - m.players[0].y) < 0.001, "prediction tracks server y");
});

console.log("fuzz");

test("100 chaotic matches stay in bounds, never NaN, always terminate", () => {
  const rng = mulberry32(777);
  for (let g = 0; g < 100; g++) {
    const nSides = 2 + Math.floor(rng() * 3);
    const walls = [0, 1, 2, 3].sort(() => rng() - 0.5).slice(0, nSides);
    const sides = walls.map((w, i) => ({
      wall: w,
      players: Array.from({ length: 1 + (rng() < 0.4 ? 1 : 0) }, (_, k) => ({
        seatId: `s${i}_${k}`,
        name: `S${i}${k}`,
      })),
    }));
    const m = createMatch(sides);
    const seatIds = m.players.map((p) => p.seatId);
    let guard = 0;
    while (!m.results && guard++ <= MAX_MATCH_TICKS + 10) {
      const inputs = {};
      for (const id of seatIds) inputs[id] = Math.floor(rng() * 32);
      // occasionally rocket a ball at a random goal to force progress
      if (guard % 200 === 0) {
        const b = m.balls[0];
        b.x = ARENA / 2; b.y = ARENA / 2;
        b.vx = (rng() - 0.5) * 30; b.vy = (rng() - 0.5) * 30;
      }
      step(m, inputs);
      for (const p of m.players) {
        assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), "player NaN");
      }
      for (const b of m.balls) {
        assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y), "ball NaN");
        assert.ok(b.x >= -1 && b.x <= ARENA + 1 && b.y >= -1 && b.y <= ARENA + 1, "ball out of cage");
      }
    }
    assert.ok(m.results, "match must terminate");
  }
});

console.log(`\n${passed} tests passed`);
