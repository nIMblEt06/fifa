// Pure simulation engine for CHICKEN RUN — a 2–6 lane key-mashing race.
//
// Like the other engines this module is pure and deterministic: the race
// advances in fixed 100ms ticks via simTick(state, tapsBySeat); no Date.now,
// no Math.random (RNG injected for track generation). It is loaded by BOTH
// the Durable Object (authoritative) and the client (constants + helpers).
//
// FAIRNESS MODEL (implemented by the DO, honoured here): clients count their
// own keystrokes locally in 100ms windows and report {seq, taps} batches.
// The server simulates race-time T at wall-time T + DELAY_MS, crediting taps
// to the window they HAPPENED in — so network latency below the delay buffer
// has zero effect on the result, only on how soon you see it.
//
// Mechanics:
//   • Speed follows a smoothed (EMA) tap rate — mash to run.
//   • OVERHEAT: sustained tapping above HEAT_THRESHOLD taps/s fills a heat
//     meter; redlining it trips the chicken (~0.8s faceplant, heat resets).
//   • SLIPSTREAM: trailing chickens draft (+ up to 15%); a clear leader runs
//     into headwind (−3%). Capped, so a better masher still wins.
//   • HAZARDS: per-lane, seeded at race start — mud strips (slow zone) and
//     worms (one-shot speed burst pickup). Never in the opening stretch or
//     the lunge zone.
//   • PHOTO-FINISH LUNGE: crossing LUNGE_ARM_AT arms a one-shot timed lunge.
//     A sweep bar cycles with race time; firing near the sweet spot gives a
//     diving burst, mistiming it stumbles you. Evaluated on the CLIENT's
//     race-time timestamp, so it's latency-fair like taps.

export const TICK_MS = 100;
export const TRACK_LEN = 1000;
export const DELAY_MS = 350;            // authoritative sim runs this far behind
export const MAX_RACE_TICKS = 1200;     // 2 min hard stop
export const MIN_LANES = 2;
export const MAX_LANES = 6;
export const MAX_TAPS_PER_TICK = 3;     // 30 taps/s hard clamp (anti-cheat)

export const SPEED_PER_TAP = 0.42;      // units per tick per (tap/s) of rate
export const RATE_EMA_ALPHA = 0.35;     // smoothing of taps/s

export const HEAT_THRESHOLD = 12;       // taps/s above this builds heat
export const HEAT_GAIN = 1.8;           // per excess tap/s per tick
export const HEAT_COOL = 0.9;           // per tick
export const HEAT_MAX = 100;
export const TRIP_TICKS = 8;            // 0.8s faceplant
export const TRIP_RESET_HEAT = 35;

export const DRAFT_MAX = 0.15;          // max slipstream bonus
export const DRAFT_PER_UNIT = 0.0006;   // bonus per unit of gap to leader
export const LEADER_DRAG = 0.97;        // headwind on a clear leader
export const LEADER_CLEAR_BY = 25;      // units ahead to count as clear leader

export const MUD_MULT = 0.55;
export const WORM_BOOST_TICKS = 12;
export const WORM_BOOST_MULT = 1.5;

export const LUNGE_ARM_AT = 0.9 * TRACK_LEN;
export const LUNGE_PERIOD_MS = 600;     // sweep bar cycle
export const LUNGE_PERFECT = 0.10;      // |phase-0.5| ≤ → perfect
export const LUNGE_GOOD = 0.20;         // |phase-0.5| ≤ → good
export const LUNGE_PERFECT_TICKS = 6;
export const LUNGE_PERFECT_MULT = 2.2;
export const LUNGE_GOOD_TICKS = 5;
export const LUNGE_GOOD_MULT = 1.6;
export const LUNGE_STUMBLE_TICKS = 5;
export const LUNGE_STUMBLE_MULT = 0.4;

// ── Track generation (seeded) ────────────────────────────────────────

// Per lane: 1–2 mud strips + 1–2 worms, kept out of the first 15% and the
// lunge zone, and spaced so they don't overlap.
export function generateTrack(lanes, rng = Math.random) {
  const minAt = 0.15 * TRACK_LEN;
  const maxAt = LUNGE_ARM_AT - 60;
  const lanesOut = [];
  for (let i = 0; i < lanes; i++) {
    const mud = [];
    const worms = [];
    const slots = [];
    const nMud = 1 + (rng() < 0.5 ? 1 : 0);
    const nWorm = 1 + (rng() < 0.5 ? 1 : 0);
    const tries = 40;
    const fits = (at, len) =>
      slots.every((s) => at + len < s.at - 30 || at > s.at + s.len + 30);
    for (let m = 0; m < nMud; m++) {
      for (let t = 0; t < tries; t++) {
        const len = 50 + Math.floor(rng() * 30);
        const at = minAt + rng() * (maxAt - minAt - len);
        if (fits(at, len)) {
          mud.push({ at: Math.round(at), len });
          slots.push({ at, len });
          break;
        }
      }
    }
    for (let w = 0; w < nWorm; w++) {
      for (let t = 0; t < tries; t++) {
        const at = minAt + rng() * (maxAt - minAt);
        if (fits(at, 0)) {
          worms.push(Math.round(at));
          slots.push({ at, len: 0 });
          break;
        }
      }
    }
    lanesOut.push({ mud, worms: worms.sort((a, b) => a - b) });
  }
  return { len: TRACK_LEN, lanes: lanesOut };
}

// ── Race state ───────────────────────────────────────────────────────

// players: [{ id, name }] — id is the SEAT id (a client may own several
// seats in couch mode; the engine doesn't care).
export function createRace(players, rng = Math.random) {
  if (players.length < MIN_LANES) throw new Error(`Need at least ${MIN_LANES} chickens`);
  if (players.length > MAX_LANES) throw new Error(`Max ${MAX_LANES} chickens`);
  const track = generateTrack(players.length, rng);
  return {
    track,
    players: players.map((p, i) => ({ id: p.id, name: p.name, lane: i })),
    lanes: players.map(() => ({
      pos: 0,
      rate: 0,           // smoothed taps/s
      heat: 0,
      tripTicks: 0,
      boostTicks: 0,
      wormsEaten: [],    // worm positions consumed
      lungeArmedTick: null,
      lunge: null,       // { result: "perfect"|"good"|"stumble", ticksLeft, mult }
      lungeUsed: false,
      finishTick: null,  // fractional tick of crossing the line
    })),
    tick: 0,
    events: [],          // rolling public event log (trips, worms, lunges, finishes)
    results: null,       // [{ id, name, lane, finishTick|null, pos }] when over
  };
}

function pushEvent(state, e) {
  state.events.push({ tick: state.tick, ...e });
  if (state.events.length > 40) state.events.splice(0, state.events.length - 40);
}

// Queue a lunge attempt. atMs is the CLIENT's race-clock timestamp of the
// keypress; phase is derived from time since the lane armed, so the sweep the
// player saw is exactly what's judged.
export function applyLunge(state, seatId, atMs) {
  const p = state.players.find((x) => x.id === seatId);
  if (!p) return { error: "Unknown seat" };
  const lane = state.lanes[p.lane];
  if (lane.finishTick !== null) return { error: "Already finished" };
  if (lane.lungeArmedTick === null) return { error: "Lunge not armed yet" };
  if (lane.lungeUsed) return { error: "Lunge already used" };
  const armedMs = lane.lungeArmedTick * TICK_MS;
  if (atMs < armedMs) return { error: "Lunge before armed" };
  const phase = ((atMs - armedMs) % LUNGE_PERIOD_MS) / LUNGE_PERIOD_MS;
  const off = Math.abs(phase - 0.5);
  lane.lungeUsed = true;
  if (off <= LUNGE_PERFECT) {
    lane.lunge = { result: "perfect", ticksLeft: LUNGE_PERFECT_TICKS, mult: LUNGE_PERFECT_MULT };
  } else if (off <= LUNGE_GOOD) {
    lane.lunge = { result: "good", ticksLeft: LUNGE_GOOD_TICKS, mult: LUNGE_GOOD_MULT };
  } else {
    lane.lunge = { result: "stumble", ticksLeft: LUNGE_STUMBLE_TICKS, mult: LUNGE_STUMBLE_MULT };
  }
  pushEvent(state, { kind: "lunge", who: seatId, result: lane.lunge.result });
  return { state };
}

// Advance the race one tick. tapsBySeat: { seatId: tapsThisWindow }.
// Mutates and returns `state` (callers clone if they need immutability —
// the DO owns its copy).
export function simTick(state, tapsBySeat = {}) {
  if (state.results) return state;
  state.tick += 1;

  // Leader position BEFORE this tick (slipstream reference).
  const leaderPos = Math.max(...state.lanes.map((l) => l.pos));
  const sortedPos = state.lanes.map((l) => l.pos).sort((a, b) => b - a);
  const clearLeader = sortedPos.length > 1 && sortedPos[0] - sortedPos[1] >= LEADER_CLEAR_BY;

  for (const p of state.players) {
    const lane = state.lanes[p.lane];
    if (lane.finishTick !== null) continue;

    const taps = Math.max(0, Math.min(MAX_TAPS_PER_TICK, Math.floor(Number(tapsBySeat[p.id]) || 0)));
    const instRate = taps * (1000 / TICK_MS); // taps/s this window

    // Tripped: ignore taps, cool down, sit there in the dirt.
    if (lane.tripTicks > 0) {
      lane.tripTicks -= 1;
      lane.rate = 0;
      lane.heat = Math.max(0, lane.heat - HEAT_COOL);
      continue;
    }

    lane.rate = lane.rate + RATE_EMA_ALPHA * (instRate - lane.rate);

    // Heat
    const excess = Math.max(0, lane.rate - HEAT_THRESHOLD);
    lane.heat = Math.max(0, Math.min(HEAT_MAX, lane.heat + excess * HEAT_GAIN - HEAT_COOL));
    if (lane.heat >= HEAT_MAX) {
      lane.tripTicks = TRIP_TICKS;
      lane.heat = TRIP_RESET_HEAT;
      lane.rate = 0;
      pushEvent(state, { kind: "trip", who: p.id });
      continue;
    }

    // Multipliers
    let mult = 1;
    const gap = leaderPos - lane.pos;
    if (gap > 0) mult *= 1 + Math.min(DRAFT_MAX, gap * DRAFT_PER_UNIT);
    else if (clearLeader && lane.pos === leaderPos) mult *= LEADER_DRAG;

    const inMud = state.track.lanes[p.lane].mud.some((m) => lane.pos >= m.at && lane.pos < m.at + m.len);
    if (inMud) mult *= MUD_MULT;

    if (lane.boostTicks > 0) {
      lane.boostTicks -= 1;
      mult *= WORM_BOOST_MULT;
    }
    if (lane.lunge && lane.lunge.ticksLeft > 0) {
      lane.lunge.ticksLeft -= 1;
      mult *= lane.lunge.mult;
    }

    const speed = lane.rate * SPEED_PER_TAP * mult;
    const from = lane.pos;
    lane.pos = Math.min(TRACK_LEN, lane.pos + speed);

    // Worm pickups crossed this tick
    for (const w of state.track.lanes[p.lane].worms) {
      if (w > from && w <= lane.pos && !lane.wormsEaten.includes(w)) {
        lane.wormsEaten.push(w);
        lane.boostTicks += WORM_BOOST_TICKS;
        pushEvent(state, { kind: "worm", who: p.id });
      }
    }

    // Arm the lunge
    if (lane.lungeArmedTick === null && lane.pos >= LUNGE_ARM_AT && lane.pos < TRACK_LEN) {
      lane.lungeArmedTick = state.tick;
      pushEvent(state, { kind: "lunge_armed", who: p.id });
    }

    // Finish — interpolate the crossing point within this tick so photo
    // finishes rank by fractional tick, not whole ticks.
    if (lane.pos >= TRACK_LEN && lane.finishTick === null) {
      lane.finishTick = state.tick - 1 + (speed > 0 ? (TRACK_LEN - from) / speed : 1);
      pushEvent(state, { kind: "finish", who: p.id, finishTick: lane.finishTick });
    }
  }

  // Race over?
  const allDone = state.lanes.every((l) => l.finishTick !== null);
  if (allDone || state.tick >= MAX_RACE_TICKS) {
    state.results = state.players
      .map((p) => ({
        id: p.id,
        name: p.name,
        lane: p.lane,
        finishTick: state.lanes[p.lane].finishTick,
        pos: state.lanes[p.lane].pos,
      }))
      .sort((a, b) => {
        if (a.finishTick !== null && b.finishTick !== null) return a.finishTick - b.finishTick;
        if (a.finishTick !== null) return -1;
        if (b.finishTick !== null) return 1;
        return b.pos - a.pos;
      });
    pushEvent(state, { kind: "race_over" });
  }
  return state;
}

// Public snapshot — nothing is secret in a race, but keep it lean: drop the
// internal per-lane bookkeeping clients don't render.
export function snapshot(state) {
  return {
    tick: state.tick,
    track: state.track,
    players: state.players,
    lanes: state.lanes.map((l) => ({
      pos: l.pos,
      heat: l.heat,
      rate: l.rate,
      tripped: l.tripTicks > 0,
      boosted: l.boostTicks > 0,
      wormsEaten: l.wormsEaten,
      lungeArmedTick: l.lungeArmedTick,
      lungeUsed: l.lungeUsed,
      lungeResult: l.lunge?.result ?? null,
      finishTick: l.finishTick,
    })),
    events: state.events.slice(-8),
    results: state.results,
  };
}
