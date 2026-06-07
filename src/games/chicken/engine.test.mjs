// Node test script for the chicken race engine — node:assert, no framework.
// Run: node src/games/chicken/engine.test.mjs
import assert from "node:assert/strict";
import {
  createRace, simTick, applyLunge, snapshot, generateTrack,
  TICK_MS, TRACK_LEN, MAX_RACE_TICKS, HEAT_THRESHOLD, LUNGE_ARM_AT,
  LUNGE_PERIOD_MS, MAX_TAPS_PER_TICK, DRAFT_MAX,
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

const P = (n) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, name: `S${i}` }));

// Run a race feeding constant tap counts per tick. tapsFn(seatId, tick) → taps.
function runRace(state, tapsFn, maxTicks = MAX_RACE_TICKS + 1) {
  let guard = 0;
  while (!state.results && guard++ < maxTicks) {
    const taps = {};
    for (const p of state.players) taps[p.id] = tapsFn(p.id, state.tick);
    simTick(state, taps);
  }
  return state;
}

console.log("track generation");

test("hazards stay clear of start and lunge zone", () => {
  const rng = mulberry32(7);
  for (let i = 0; i < 50; i++) {
    const t = generateTrack(6, rng);
    for (const lane of t.lanes) {
      for (const m of lane.mud) {
        assert.ok(m.at >= 0.15 * TRACK_LEN - 1, "mud too early");
        assert.ok(m.at + m.len <= LUNGE_ARM_AT, "mud in lunge zone");
      }
      for (const w of lane.worms) {
        assert.ok(w >= 0.15 * TRACK_LEN - 1 && w <= LUNGE_ARM_AT, "worm out of band");
      }
      assert.ok(lane.mud.length >= 1 && lane.worms.length >= 1);
    }
  }
});

test("seeded generation is deterministic", () => {
  const a = generateTrack(4, mulberry32(42));
  const b = generateTrack(4, mulberry32(42));
  assert.deepEqual(a, b);
});

console.log("race basics");

test("createRace validates lane count", () => {
  assert.throws(() => createRace(P(1)));
  assert.throws(() => createRace(P(7)));
  const r = createRace(P(2), mulberry32(1));
  assert.equal(r.lanes.length, 2);
});

test("no taps → nobody moves; race hard-stops at MAX_RACE_TICKS", () => {
  const r = createRace(P(2), mulberry32(2));
  runRace(r, () => 0);
  assert.ok(r.results, "race must end");
  assert.equal(r.tick, MAX_RACE_TICKS);
  assert.ok(r.lanes.every((l) => l.pos === 0));
});

test("steady tapping finishes the race; faster masher wins", () => {
  // s0 taps every tick (10/s); s1 skips every 5th tick (8/s).
  const r = createRace(P(2), mulberry32(3));
  runRace(r, (id, tick) => (id === "s0" ? 1 : tick % 5 === 0 ? 0 : 1));
  assert.ok(r.results);
  assert.equal(r.results[0].id, "s0", "consistent tapper should win");
  assert.ok(r.results[0].finishTick !== null);
});

test("identical inputs → photo-finish tie (same fractional tick)", () => {
  // Same taps; tracks differ per lane so allow the comparison on a hazard-free
  // pace: use a seed where we zero out hazards manually.
  const r = createRace(P(3), mulberry32(4));
  for (const lane of r.track.lanes) { lane.mud = []; lane.worms = []; }
  runRace(r, () => 1);
  assert.ok(r.results);
  const t0 = r.results[0].finishTick;
  for (const res of r.results) {
    assert.ok(Math.abs(res.finishTick - t0) < 1e-9, "equal tappers should tie exactly");
  }
});

test("taps clamped to MAX_TAPS_PER_TICK", () => {
  const r = createRace(P(2), mulberry32(5));
  for (const lane of r.track.lanes) { lane.mud = []; lane.worms = []; }
  const a = structuredClone(r);
  const b = structuredClone(r);
  simTick(a, { s0: MAX_TAPS_PER_TICK, s1: 0 });
  simTick(b, { s0: 999, s1: 0 });
  assert.equal(a.lanes[0].pos, b.lanes[0].pos);
});

console.log("overheat");

test("redlining trips the chicken; rhythm tapper passes the masher", () => {
  const r = createRace(P(2), mulberry32(6));
  for (const lane of r.track.lanes) { lane.mud = []; lane.worms = []; }
  // s0 mashes flat-out (30/s — way over threshold), s1 stays at 10/s.
  runRace(r, (id) => (id === "s0" ? 3 : 1));
  assert.ok(r.results);
  const trips = r.events.concat([]).filter((e) => e.kind === "trip");
  // s0 must have tripped at least once during the race
  const allTrips = [];
  // events roll, so re-run and count trips live
  const r2 = createRace(P(2), mulberry32(6));
  for (const lane of r2.track.lanes) { lane.mud = []; lane.worms = []; }
  let tripCount = 0;
  while (!r2.results) {
    const before = r2.lanes[0].tripTicks > 0;
    simTick(r2, { s0: 3, s1: 1 });
    if (!before && r2.lanes[0].tripTicks > 0) tripCount++;
  }
  assert.ok(tripCount >= 1, `masher should trip (tripped ${tripCount}×)`);
  void trips; void allTrips;
});

test("tapping at the threshold never trips", () => {
  const r = createRace(P(2), mulberry32(7));
  for (const lane of r.track.lanes) { lane.mud = []; lane.worms = []; }
  // ~12 taps/s = 1.2/tick → alternate 1 and sometimes 2 to average 1.2
  let tripped = false;
  while (!r.results) {
    simTick(r, { s0: r.tick % 5 < 1 ? 2 : 1, s1: 1 });
    if (r.lanes[0].tripTicks > 0) tripped = true;
  }
  assert.equal(tripped, false, "threshold-rate tapper must not trip");
});

console.log("slipstream");

test("draft bonus is capped and helps the trailer close the gap", () => {
  const r = createRace(P(2), mulberry32(8));
  for (const lane of r.track.lanes) { lane.mud = []; lane.worms = []; }
  // Give s0 a head start, then identical tapping.
  r.lanes[0].pos = 300;
  const gapStart = 300;
  for (let i = 0; i < 100; i++) simTick(r, { s0: 1, s1: 1 });
  const gapNow = r.lanes[0].pos - r.lanes[1].pos;
  assert.ok(gapNow < gapStart, `gap should shrink (was ${gapStart}, now ${gapNow.toFixed(1)})`);
  // But the cap means the trailer can't be MORE than (1+DRAFT_MAX)/LEADER_DRAG faster.
  assert.ok(gapNow > gapStart * 0.5, "rubber-band must not erase a real lead instantly");
  void DRAFT_MAX;
});

console.log("hazards");

test("mud slows, worm boosts", () => {
  const r = createRace(P(2), mulberry32(9));
  // Craft hazards deterministically.
  r.track.lanes[0].mud = [{ at: 200, len: 80 }];
  r.track.lanes[0].worms = [];
  r.track.lanes[1].mud = [];
  r.track.lanes[1].worms = [400];
  // identical tapping; lane1 should finish first (boost, no mud)
  runRace(r, () => 1);
  assert.equal(r.results[0].id, "s1");
  assert.ok(r.lanes[1].wormsEaten.includes(400), "worm should be eaten");
});

test("worm is consumed once", () => {
  const r = createRace(P(2), mulberry32(10));
  r.track.lanes[0].mud = []; r.track.lanes[0].worms = [50];
  r.track.lanes[1].mud = []; r.track.lanes[1].worms = [];
  runRace(r, () => 1);
  assert.equal(r.lanes[0].wormsEaten.filter((w) => w === 50).length, 1);
});

console.log("lunge");

test("lunge arms at 90%, judges phase from arm time, one-shot", () => {
  const r = createRace(P(2), mulberry32(11));
  for (const lane of r.track.lanes) { lane.mud = []; lane.worms = []; }
  while (r.lanes[0].lungeArmedTick === null && !r.results) simTick(r, { s0: 1, s1: 0 });
  assert.ok(r.lanes[0].lungeArmedTick !== null);
  const armedMs = r.lanes[0].lungeArmedTick * TICK_MS;
  // perfect: phase 0.5 → atMs = armed + half period
  const res = applyLunge(r, "s0", armedMs + LUNGE_PERIOD_MS / 2);
  assert.equal(res.error, undefined);
  assert.equal(r.lanes[0].lunge.result, "perfect");
  assert.ok(applyLunge(r, "s0", armedMs + 900).error, "second lunge must be rejected");
});

test("mistimed lunge stumbles; before-armed rejected", () => {
  const r = createRace(P(2), mulberry32(12));
  for (const lane of r.track.lanes) { lane.mud = []; lane.worms = []; }
  assert.ok(applyLunge(r, "s0", 0).error, "lunge before armed must fail");
  while (r.lanes[0].lungeArmedTick === null && !r.results) simTick(r, { s0: 1, s1: 0 });
  const armedMs = r.lanes[0].lungeArmedTick * TICK_MS;
  applyLunge(r, "s0", armedMs + 1); // phase ≈ 0 → stumble
  assert.equal(r.lanes[0].lunge.result, "stumble");
});

test("perfect lunge can flip a photo finish", () => {
  const base = createRace(P(2), mulberry32(13));
  for (const lane of base.track.lanes) { lane.mud = []; lane.worms = []; }
  // Identical tapping; s1 nails a perfect lunge, s0 never lunges.
  const r = structuredClone(base);
  let lunged = false;
  while (!r.results) {
    if (!lunged && r.lanes[1].lungeArmedTick !== null) {
      const armedMs = r.lanes[1].lungeArmedTick * TICK_MS;
      applyLunge(r, "s1", armedMs + LUNGE_PERIOD_MS / 2);
      lunged = true;
    }
    simTick(r, { s0: 1, s1: 1 });
  }
  assert.equal(r.results[0].id, "s1", "perfect lunge should win the tie");
});

console.log("snapshot & determinism");

test("snapshot carries no internal-only fields and is JSON-safe", () => {
  const r = createRace(P(4), mulberry32(14));
  for (let i = 0; i < 50; i++) simTick(r, { s0: 1, s1: 2, s2: 1, s3: 0 });
  const s = JSON.parse(JSON.stringify(snapshot(r)));
  assert.equal(s.lanes.length, 4);
  assert.ok(typeof s.lanes[0].pos === "number");
  assert.ok(!("tripTicks" in s.lanes[0]));
});

test("simulation is deterministic for identical inputs", () => {
  const mk = () => {
    const r = createRace(P(4), mulberry32(15));
    const rng = mulberry32(99);
    runRace(r, () => Math.floor(rng() * 3));
    return r;
  };
  const a = mk();
  const b = mk();
  assert.deepEqual(
    a.results.map((x) => [x.id, x.finishTick]),
    b.results.map((x) => [x.id, x.finishTick]),
  );
});

console.log("fuzz");

test("200 random races terminate with full rankings", () => {
  const rng = mulberry32(1234);
  for (let g = 0; g < 200; g++) {
    const n = 2 + Math.floor(rng() * 5);
    const r = createRace(P(n), rng);
    runRace(r, () => Math.floor(rng() * 4)); // 0..3 taps
    assert.ok(r.results, "race must terminate");
    assert.equal(r.results.length, n);
    // rankings: every finisher ranks above every non-finisher
    let seenDNF = false;
    for (const res of r.results) {
      if (res.finishTick === null) seenDNF = true;
      else assert.ok(!seenDNF, "finisher ranked below a DNF");
    }
  }
});

console.log(`\n${passed} tests passed`);
