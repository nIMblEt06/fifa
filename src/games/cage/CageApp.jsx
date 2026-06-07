import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import Reactions from "../../components/Reactions";
import { shareUrl, clientId } from "../../utils/room";
import { useRoom } from "../../utils/useRoom";
import {
  ARENA, GOAL_W, PLAYER_R, BALL_R, LOSE_AT, TICK_MS, DELAY_MS,
  KEY_UP, KEY_DOWN, KEY_LEFT, KEY_RIGHT, KEY_KICK,
  SIDE_COLORS, WALLS, predictPlayer,
} from "./engine";

const INTERP_MS = 80;      // render this far behind the newest snapshot
const WALL_LABEL = ["TOP", "RIGHT", "BOTTOM", "LEFT"];

// Couch key maps (max 2 local seats). Solo remote players get both maps.
const KEYMAPS = [
  { up: ["KeyW"], down: ["KeyS"], left: ["KeyA"], right: ["KeyD"], kick: ["KeyE", "KeyQ"], label: "WASD + E" },
  { up: ["ArrowUp"], down: ["ArrowDown"], left: ["ArrowLeft"], right: ["ArrowRight"], kick: ["Enter", "ShiftRight"], label: "Arrows + Enter" },
];
const SOLO_MAP = {
  up: ["KeyW", "ArrowUp"], down: ["KeyS", "ArrowDown"],
  left: ["KeyA", "ArrowLeft"], right: ["KeyD", "ArrowRight"],
  kick: ["Space", "Enter", "KeyE"], label: "WASD/Arrows + Space",
};

export default function CageApp({ code, onLeave }) {
  const me = clientId();

  const offsetRef = useRef({ offset: 0, bestRtt: Infinity });
  const onMessage = useCallback((msg) => {
    if (msg.type === "cagePong") {
      const rtt = Date.now() - msg.t;
      if (rtt < offsetRef.current.bestRtt) {
        offsetRef.current = { offset: msg.serverNow + rtt / 2 - Date.now(), bestRtt: rtt };
      }
    }
  }, []);

  const { state: view, presence, reactions, connected, error, dismissError, sendAction, sendReaction } =
    useRoom(code, { game: "cage", clientId: me, onMessage });

  useEffect(() => {
    if (!connected) return;
    let n = 0;
    const ping = () => sendAction({ type: "cagePing", t: Date.now() });
    ping();
    const id = setInterval(() => { ping(); if (++n >= 4) clearInterval(id); }, 800);
    return () => clearInterval(id);
  }, [connected, sendAction]);

  const serverNow = useCallback(() => Date.now() + offsetRef.current.offset, []);

  const phase = view?.phase || "lobby";
  const seats = useMemo(() => view?.seats || [], [view]);
  const startAt = view?.startAt || null;
  const mySeats = useMemo(() => seats.filter((s) => s.owner === me), [seats, me]);
  const joined = mySeats.length > 0;

  // ── Snapshot buffer (for interpolation) ────────────────────────────
  const snapsRef = useRef([]);
  const matchKeyRef = useRef(null);
  useEffect(() => {
    if (startAt !== matchKeyRef.current) {
      matchKeyRef.current = startAt;
      snapsRef.current = [];
      ghostsRef.current = {};
      trailsRef.current = [[], []];
      fxRef.current = { shakeUntil: 0, flashWall: null, flashUntil: 0 };
      ballsRenderRef.current = [];
      playersRenderRef.current = {};
    }
    if (view?.match) {
      const buf = snapsRef.current;
      if (!buf.length || buf[buf.length - 1].tick !== view.match.tick) {
        buf.push(view.match);
        if (buf.length > 12) buf.splice(0, buf.length - 12);
      }
    }
  }, [view, startAt]);

  // ── Input state → server ────────────────────────────────────────────
  const keysRef = useRef({});       // seatId -> bitmask
  const matchMs = useCallback(() => (startAt ? serverNow() - startAt : -1), [startAt, serverNow]);

  const sendInput = useCallback(
    (seatId) => {
      const ms = matchMs();
      if (ms < -2000) return;
      sendAction({ type: "cageInput", seat: seatId, atMs: Math.max(0, ms), keys: keysRef.current[seatId] || 0 });
    },
    [matchMs, sendAction]
  );

  useEffect(() => {
    if (phase !== "playing" || mySeats.length === 0) return;
    const couch = mySeats.length > 1;
    const mapFor = (i) => (couch ? KEYMAPS[i] : SOLO_MAP);

    const apply = (code, down) => {
      mySeats.forEach((s, i) => {
        const m = mapFor(i);
        if (!m) return;
        let bit = 0;
        if (m.up.includes(code)) bit = KEY_UP;
        else if (m.down.includes(code)) bit = KEY_DOWN;
        else if (m.left.includes(code)) bit = KEY_LEFT;
        else if (m.right.includes(code)) bit = KEY_RIGHT;
        else if (m.kick.includes(code)) bit = KEY_KICK;
        if (!bit) return;
        const prev = keysRef.current[s.id] || 0;
        const next = down ? prev | bit : prev & ~bit;
        if (next !== prev) {
          keysRef.current[s.id] = next;
          sendInput(s.id);
        }
      });
    };

    const down = (e) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      apply(e.code, true);
      if (/^(Arrow|Space|Enter)/.test(e.code)) e.preventDefault();
    };
    const up = (e) => apply(e.code, false);
    const blur = () => {
      // Drop all keys when the tab loses focus, or you run forever.
      for (const s of mySeats) {
        if (keysRef.current[s.id]) {
          keysRef.current[s.id] = 0;
          sendInput(s.id);
        }
      }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    // Heartbeat: re-sends current keys so a lost packet can't stick a key
    // server-side, AND keeps the DO advancing+broadcasting at a steady rate
    // (the sim only ticks on incoming messages + the 1s safety alarm), which
    // is what feeds smooth ball/remote-player interpolation.
    const hb = setInterval(() => { for (const s of mySeats) sendInput(s.id); }, 50);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
      clearInterval(hb);
    };
  }, [phase, mySeats, sendInput]);

  // ── Canvas render loop ──────────────────────────────────────────────
  const canvasRef = useRef(null);
  const ghostsRef = useRef({});     // seatId -> predicted {x,y,vx,vy}
  const trailsRef = useRef([[], []]);
  const fxRef = useRef({ shakeUntil: 0, flashWall: null, flashUntil: 0 });
  const lastEventTickRef = useRef(-1);
  // Smoothed render positions for interpolated entities (balls + remote
  // players). Dead-reckoned along velocity when the snapshot buffer runs dry,
  // then low-pass filtered so new snapshots ease in instead of snapping.
  const ballsRenderRef = useRef([]);
  const playersRenderRef = useRef({});
  const lastFrameRef = useRef(0);

  useEffect(() => {
    if (phase !== "playing" && phase !== "results") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    let raf;
    let lastPredict = performance.now();

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const buf = snapsRef.current;
      if (!buf.length) return;

      // Pick the two snapshots bracketing the render time.
      const renderMs = serverNow() - startAt - DELAY_MS - INTERP_MS;
      const renderTick = renderMs / TICK_MS;
      let a = buf[0], b = buf[buf.length - 1];
      for (let i = buf.length - 1; i >= 0; i--) {
        if (buf[i].tick <= renderTick) { a = buf[i]; b = buf[Math.min(i + 1, buf.length - 1)]; break; }
      }
      const span = Math.max(1, b.tick - a.tick);
      const t = Math.max(0, Math.min(1, (renderTick - a.tick) / span));
      const latest = buf[buf.length - 1];

      // FX triggers from fresh events
      for (const e of latest.events || []) {
        if (e.tick <= lastEventTickRef.current) continue;
        if (e.kind === "goal" || e.kind === "eliminated") {
          fxRef.current = { shakeUntil: performance.now() + 220, flashWall: e.wall, flashUntil: performance.now() + 350 };
        }
        lastEventTickRef.current = e.tick;
      }

      // Advance local prediction for my seats at fixed timestep.
      const now = performance.now();
      while (now - lastPredict >= TICK_MS) {
        lastPredict += TICK_MS;
        for (const s of mySeats) {
          const auth = latest.players.find((p) => p.seatId === s.id);
          if (!auth) continue;
          let g = ghostsRef.current[s.id];
          if (!g) g = ghostsRef.current[s.id] = { x: auth.x, y: auth.y, vx: auth.vx, vy: auth.vy };
          if (latest.freeze > 0 || latest.results) {
            ghostsRef.current[s.id] = { x: auth.x, y: auth.y, vx: auth.vx, vy: auth.vy };
          } else {
            const stepped = predictPlayer(g, keysRef.current[s.id] || 0);
            // Reconcile: blend toward authority; snap when wildly apart.
            const dx = auth.x - stepped.x, dy = auth.y - stepped.y;
            if (Math.hypot(dx, dy) > 60) {
              ghostsRef.current[s.id] = { x: auth.x, y: auth.y, vx: auth.vx, vy: auth.vy };
            } else {
              stepped.x += dx * 0.08;
              stepped.y += dy * 0.08;
              ghostsRef.current[s.id] = stepped;
            }
          }
        }
      }

      // Real-frame delta for frame-rate-independent smoothing.
      const dt = lastFrameRef.current ? Math.min(50, now - lastFrameRef.current) : 16;
      lastFrameRef.current = now;

      renderFrame(ctx, canvas, {
        a, b, t, latest, renderTick, seats, me,
        ghosts: ghostsRef.current, trails: trailsRef.current, fx: fxRef.current,
        ballsRender: ballsRenderRef.current, playersRender: playersRenderRef.current, dt,
      });
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [phase, startAt, seats, me, mySeats, serverNow]);

  // ── Lobby helpers ──────────────────────────────────────────────────
  const [name, setName] = useState("");
  const [couchName, setCouchName] = useState("");
  const [copied, setCopied] = useState(false);
  const copyLink = () => {
    navigator.clipboard?.writeText(shareUrl(code, "cage")).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };

  const wallsInUse = useMemo(() => {
    const m = new Map();
    for (const s of seats) {
      if (!m.has(s.wall)) m.set(s.wall, []);
      m.get(s.wall).push(s);
    }
    return m;
  }, [seats]);
  const sidesReady = wallsInUse.size >= 2;

  const results = view?.match?.results || null;
  const lastEvent = view?.match?.events?.length ? view.match.events[view.match.events.length - 1] : null;
  const nameOfWall = (w) => (wallsInUse.get(w) || []).map((s) => s.name).join(" & ") || WALL_LABEL[w];

  return (
    <div className="app">
      <header className="masthead">
        <h1>
          CAGE<span className="slash">/</span>FOOTBALL
        </h1>
        <div className="masthead-meta">
          {onLeave && (
            <button className="room" onClick={onLeave} title="Back to game picker">← HUB</button>
          )}
          {phase !== "lobby" && (
            <button className="room" onClick={() => window.confirm("Back to the lobby?") && sendAction({ type: "cageReset" })}>
              RESET
            </button>
          )}
          {presence > 0 && (
            <span className="presence"><span className="dot" />{presence} watching</span>
          )}
          <button className={"room " + (copied ? "copied" : "")} onClick={copyLink} title="Copy share link">
            {copied ? "LINK COPIED" : code}
          </button>
        </div>
      </header>

      {!connected && <div className="conn-state">RECONNECTING…</div>}
      {error && (
        <div className="error-toast" role="alert" onClick={dismissError}>
          <span className="error-toast-msg">{error.message}</span>
          <button className="error-toast-x" aria-label="Dismiss">×</button>
        </div>
      )}

      <main>
        {phase === "lobby" && (
          <div className="setup cage-lobby">
            <h2>The Cage</h2>
            {!joined && (
              <div className="input-row">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && name.trim() && sendAction({ type: "join", name: name.trim() })}
                  placeholder="Your name"
                  maxLength={24}
                />
                <button disabled={!name.trim()} onClick={() => sendAction({ type: "join", name: name.trim() })}>
                  Join
                </button>
              </div>
            )}

            <div className="cage-walls">
              {[0, 1, 2, 3].map((w) => {
                const team = wallsInUse.get(w) || [];
                const mineHere = team.some((s) => s.owner === me);
                return (
                  <button
                    key={w}
                    className={"cage-wall-slot" + (mineHere ? " is-mine" : "") + (team.length ? " occupied" : "")}
                    style={{ "--side": SIDE_COLORS[w] }}
                    disabled={!joined || (team.length >= 2 && !mineHere)}
                    onClick={() => joined && sendAction({ type: "cagePickWall", wall: w, seat: mySeats[0]?.id })}
                    title="Tap to defend this goal"
                  >
                    <span className="cage-wall-name">{WALL_LABEL[w]}</span>
                    {team.length === 0 && <span className="muted">empty</span>}
                    {team.map((s) => (
                      <span key={s.id} className="cage-wall-player">
                        {s.name}
                        {s.owner === me && <span className="muted"> (you)</span>}
                        {s.owner === me && (
                          <button
                            className="remove-btn"
                            onClick={(e) => { e.stopPropagation(); sendAction({ type: "cageRemoveSeat", seat: s.id }); }}
                            aria-label={`Remove ${s.name}`}
                          >
                            ×
                          </button>
                        )}
                      </span>
                    ))}
                    {team.length === 1 && <span className="muted small">+1 slot open (2v2)</span>}
                  </button>
                );
              })}
            </div>

            {joined && mySeats.length < 2 && (
              <div className="input-row ck-couch">
                <input
                  value={couchName}
                  onChange={(e) => setCouchName(e.target.value)}
                  placeholder="+ couch player (same keyboard)"
                  maxLength={24}
                />
                <button
                  disabled={!couchName.trim()}
                  onClick={() => { sendAction({ type: "cageAddCouch", name: couchName.trim() }); setCouchName(""); }}
                >
                  Add
                </button>
              </div>
            )}

            <div className="ck-rules muted">
              Two balls. Defend your goal, score in everyone else&apos;s. Concede {LOSE_AT} and you&apos;re out —
              your goal seals shut. Last side standing wins. Teams of two share a goal.
              <br />
              Keys: {mySeats.length > 1 ? `${KEYMAPS[0].label} · ${KEYMAPS[1].label}` : SOLO_MAP.label} — kick fires
              the ball where you&apos;re moving (pass or shoot).
            </div>

            <button className="start-btn" disabled={!joined || !sidesReady} onClick={() => sendAction({ type: "cageStart" })}>
              Kick Off →
            </button>
            {!sidesReady && <div className="muted" style={{ marginTop: "0.5rem" }}>Need teams on at least 2 sides.</div>}
          </div>
        )}

        {(phase === "playing" || phase === "results") && (
          <div className="cage-game">
            <canvas ref={canvasRef} className="cage-canvas" width={ARENA} height={ARENA} />

            {lastEvent && phase === "playing" && (
              <div className="activity-log">
                <div className="activity-log-title">CAGESIDE</div>
                <ul className="activity-log-list">
                  <li className="log-row">
                    {lastEvent.kind === "goal" && <><strong style={{ color: SIDE_COLORS[lastEvent.wall] }}>{nameOfWall(lastEvent.wall)}</strong> concede! ({lastEvent.conceded}/{LOSE_AT})</>}
                    {lastEvent.kind === "eliminated" && <><strong style={{ color: SIDE_COLORS[lastEvent.wall] }}>{nameOfWall(lastEvent.wall)}</strong> are OUT — goal sealed</>}
                    {lastEvent.kind === "match_over" && <>Full time.</>}
                  </li>
                </ul>
              </div>
            )}

            {phase === "results" && results && (
              <div className="winner-wrap">
                <div className="champion-banner set-winner">
                  <h2>Last Side Standing</h2>
                  <div className="champion-name" style={{ color: SIDE_COLORS[results[0].wall] }}>
                    {nameOfWall(results[0].wall)}
                  </div>
                  <div className="champion-team">conceded only {results[0].conceded}</div>
                </div>
                <div className="winner-board">
                  <div className="winner-board-title">FINAL TABLE</div>
                  {results.map((r, i) => (
                    <div key={r.wall} className={"winner-row" + (i === 0 ? " winner-row-top" : "") + ((wallsInUse.get(r.wall) || []).some((s) => s.owner === me) ? " winner-row-me" : "")}>
                      <span className="winner-rank">{i + 1}</span>
                      <span className="winner-name" style={{ color: SIDE_COLORS[r.wall] }}>{nameOfWall(r.wall)}</span>
                      <span className="winner-sets">{r.eliminated ? "eliminated" : "survived"} · {r.conceded} conceded</span>
                    </div>
                  ))}
                </div>
                <div className="winner-cta">
                  <button className="start-btn" onClick={() => sendAction({ type: "cageRematch" })}>REMATCH →</button>
                  <button className="poker-btn" style={{ marginLeft: "0.6rem" }} onClick={() => sendAction({ type: "cageReset" })}>
                    Back to lobby
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      <Reactions reactions={reactions} onSend={sendReaction} />
    </div>
  );
}

// ── Canvas renderer ───────────────────────────────────────────────────
const GOAL_LO = (ARENA - GOAL_W) / 2;

function lerp(a, b, t) { return a + (b - a) * t; }

const EXTRAP_CAP_TICKS = 6;   // dead-reckon at most ~200ms past the newest snapshot
const SNAP_DIST = 150;        // teleport (goal reset) → snap, don't slide

// Target for an interpolated entity: lerp between bracketing snapshots when we
// have a future one, else dead-reckon along velocity. `cur` is the newest
// authoritative sample (carries vx/vy).
function entityTarget(prevSample, nextSample, t, cur, renderTick, newestTick) {
  if (renderTick <= newestTick && prevSample && nextSample && nextSample !== prevSample) {
    return { x: lerp(prevSample.x, nextSample.x, t), y: lerp(prevSample.y, nextSample.y, t) };
  }
  const ahead = Math.min(EXTRAP_CAP_TICKS, Math.max(0, renderTick - newestTick));
  return { x: cur.x + cur.vx * ahead, y: cur.y + cur.vy * ahead };
}

// Low-pass a render position toward its target; snap on big jumps (resets).
function smoothToward(store, key, tx, ty, k) {
  let r = store[key];
  if (!r) { r = store[key] = { x: tx, y: ty }; return r; }
  if (Math.hypot(tx - r.x, ty - r.y) > SNAP_DIST) { r.x = tx; r.y = ty; }
  else { r.x += (tx - r.x) * k; r.y += (ty - r.y) * k; }
  return r;
}

function renderFrame(ctx, canvas, { a, b, t, latest, renderTick, seats, me, ghosts, trails, fx, ballsRender, playersRender, dt }) {
  const css = getComputedStyle(document.documentElement);
  const INK = css.getPropertyValue("--ink").trim() || "#0a0a0a";
  const PAPER = css.getPropertyValue("--paper").trim() || "#f4f1ea";
  const DIM = css.getPropertyValue("--dim").trim() || "#2a2a2a";

  const now = performance.now();
  ctx.save();
  ctx.clearRect(0, 0, ARENA, ARENA);
  ctx.fillStyle = INK;
  ctx.fillRect(0, 0, ARENA, ARENA);

  // Screen shake
  if (now < fx.shakeUntil) {
    const mag = 5 * ((fx.shakeUntil - now) / 220);
    ctx.translate((Math.random() - 0.5) * mag * 2, (Math.random() - 0.5) * mag * 2);
  }

  // Center mark
  ctx.strokeStyle = DIM;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(ARENA / 2, ARENA / 2, 60, 0, Math.PI * 2);
  ctx.stroke();

  // Walls + goal mouths
  const sidesByWall = new Map(latest.sides.map((s) => [s.wall, s]));
  for (let w = 0; w < 4; w++) {
    const side = sidesByWall.get(w);
    const open = side && !side.eliminated;
    const color = SIDE_COLORS[w];
    ctx.lineWidth = 6;

    const seg = (x1, y1, x2, y2, stroke) => {
      ctx.strokeStyle = stroke;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    };
    const flash = fx.flashWall === w && now < fx.flashUntil;
    const mouthColor = flash ? PAPER : open ? color : DIM;

    if (w === 0) {
      seg(0, 3, GOAL_LO, 3, PAPER);
      seg(GOAL_LO, 3, GOAL_LO + GOAL_W, 3, mouthColor);
      seg(GOAL_LO + GOAL_W, 3, ARENA, 3, PAPER);
    } else if (w === 2) {
      seg(0, ARENA - 3, GOAL_LO, ARENA - 3, PAPER);
      seg(GOAL_LO, ARENA - 3, GOAL_LO + GOAL_W, ARENA - 3, mouthColor);
      seg(GOAL_LO + GOAL_W, ARENA - 3, ARENA, ARENA - 3, PAPER);
    } else if (w === 3) {
      seg(3, 0, 3, GOAL_LO, PAPER);
      seg(3, GOAL_LO, 3, GOAL_LO + GOAL_W, mouthColor);
      seg(3, GOAL_LO + GOAL_W, 3, ARENA, PAPER);
    } else {
      seg(ARENA - 3, 0, ARENA - 3, GOAL_LO, PAPER);
      seg(ARENA - 3, GOAL_LO, ARENA - 3, GOAL_LO + GOAL_W, mouthColor);
      seg(ARENA - 3, GOAL_LO + GOAL_W, ARENA - 3, ARENA, PAPER);
    }

    // Conceded pips next to each live goal
    if (side) {
      ctx.fillStyle = open ? color : DIM;
      for (let i = 0; i < LOSE_AT; i++) {
        const filled = i < LOSE_AT - side.conceded;
        const off = (i - (LOSE_AT - 1) / 2) * 16;
        let px = ARENA / 2 + off, py = 20;
        if (w === 1) { px = ARENA - 20; py = ARENA / 2 + off; }
        if (w === 2) { px = ARENA / 2 + off; py = ARENA - 20; }
        if (w === 3) { px = 20; py = ARENA / 2 + off; }
        ctx.globalAlpha = filled ? 1 : 0.18;
        ctx.beginPath();
        ctx.arc(px, py, 4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }

  // Balls — interpolate, dead-reckon past the buffer, then low-pass smooth so
  // the motion is as fluid as a predicted player. Frame-rate-independent k.
  const newestTick = latest.tick;
  const ballK = 1 - Math.exp(-dt / 45);
  const playerK = 1 - Math.exp(-dt / 40);
  latest.balls.forEach((nb, i) => {
    const target = entityTarget(a.balls[i], b.balls[i], t, nb, renderTick, newestTick);
    const r = smoothToward(ballsRender, i, target.x, target.y, ballK);
    const x = r.x, y = r.y;
    const trail = trails[i];
    trail.push({ x, y });
    if (trail.length > 10) trail.shift();
    trail.forEach((pt, k) => {
      ctx.globalAlpha = (k / trail.length) * 0.25;
      ctx.fillStyle = PAPER;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, BALL_R * (0.5 + 0.5 * (k / trail.length)), 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
    ctx.fillStyle = PAPER;
    ctx.beginPath();
    ctx.arc(x, y, BALL_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.stroke();
  });

  // Players: interpolate remote, predict own.
  const ownerOf = new Map(seats.map((s) => [s.id, s.owner]));
  for (const pl of latest.players) {
    const side = sidesByWall.get(pl.wall);
    if (side?.eliminated) continue;
    const mine = ownerOf.get(pl.seatId) === me;
    let x, y;
    if (mine && ghosts[pl.seatId]) {
      // Own player: client-side predicted (zero-latency).
      x = ghosts[pl.seatId].x;
      y = ghosts[pl.seatId].y;
    } else {
      // Remote player: same interpolate + dead-reckon + low-pass as the ball.
      const pa = a.players.find((p) => p.seatId === pl.seatId);
      const pb = b.players.find((p) => p.seatId === pl.seatId);
      const target = entityTarget(pa, pb, t, pl, renderTick, newestTick);
      const r = smoothToward(playersRender, pl.seatId, target.x, target.y, playerK);
      x = r.x; y = r.y;
    }
    const color = SIDE_COLORS[pl.wall];
    // Kick flash ring
    if (latest.tick - pl.kickedTick < 6) {
      ctx.strokeStyle = PAPER;
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.arc(x, y, PLAYER_R + 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, PLAYER_R, 0, Math.PI * 2);
    ctx.fill();
    if (mine) {
      ctx.strokeStyle = PAPER;
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    ctx.fillStyle = PAPER;
    ctx.font = "700 11px 'Space Grotesk', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(pl.name, x, y - PLAYER_R - 6);
  }

  // Freeze countdown overlay
  if (latest.freeze > 0 && !latest.results) {
    ctx.fillStyle = "rgba(10,10,10,0.45)";
    ctx.fillRect(0, 0, ARENA, ARENA);
    ctx.fillStyle = PAPER;
    ctx.font = "900 90px 'Anton', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(Math.ceil(latest.freeze / 30)), ARENA / 2, ARENA / 2);
    ctx.textBaseline = "alphabetic";
  }

  ctx.restore();
}
