// Node test script for the LIT engine — no framework, just node:assert.
// Run: node src/games/lit/engine.test.mjs  (also picked up by node --test)
import assert from "node:assert/strict";
import {
  RANKS, SUITS, freshDeck, rankOf, shuffle, defaultTeams, teamOf,
  startGame, healState, applyAsk, applyDeclare, redactFor,
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

const mkPlayers = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));

// Hand-build a structurally valid state for precise scenarios that a real
// deal can't reach deterministically (mirrors the startGame output shape).
function craft({ mode = "solo", ids, hands, deck = [], turn, sets = null, teams = null, teamSets = null, winner = null }) {
  const players = ids.map((id) => ({ id, name: id.toUpperCase() }));
  return {
    mode,
    players,
    teams: mode === "team" ? (teams || defaultTeams(players)) : null,
    hands,
    deck: [...deck],
    sets: sets || Object.fromEntries(ids.map((id) => [id, []])),
    teamSets: mode === "team" ? (teamSets || { A: [], B: [] }) : null,
    turn,
    log: [],
    winner,
  };
}

function claimedRanks(s) {
  return s.mode === "team"
    ? [...s.teamSets.A, ...s.teamSets.B]
    : Object.values(s.sets).flat();
}
function totalCards(s) {
  const inHands = Object.values(s.hands).reduce((n, h) => n + h.length, 0);
  return inHands + s.deck.length + 4 * claimedRanks(s).length;
}
// 52-card conservation + no duplicate cards + no claimed rank still in play.
function checkConservation(s, expected = 52) {
  assert.equal(totalCards(s), expected, "card count drifted");
  const cards = [...s.deck, ...Object.values(s.hands).flat()];
  assert.equal(new Set(cards).size, cards.length, "duplicate card in play");
  const claimed = new Set(claimedRanks(s));
  for (const c of cards) assert.ok(!claimed.has(rankOf(c)), `claimed rank ${rankOf(c)} still in play`);
}

// Find a seed whose opening deal contains no four-of-a-kind, so every hand
// is exactly HAND_SIZE. The first seed almost always works.
function dealClean(n, mode = "solo", maxSeed = 50) {
  for (let seed = 1; seed <= maxSeed; seed++) {
    const players = mkPlayers(n);
    const opts = mode === "team" ? { mode: "team", teams: defaultTeams(players) } : {};
    const s = startGame(players, opts, mulberry32(seed));
    if (!s.log.some((e) => e.kind === "set_collected")) return s;
  }
  assert.fail(`no clean deal found for n=${n} in ${maxSeed} seeds`);
}

// ── Deck & dealing ───────────────────────────────────────────────────
console.log("deck & dealing");

test("freshDeck: 52 unique cards, 4 per rank, one per suit", () => {
  const deck = freshDeck();
  assert.equal(deck.length, 52);
  assert.equal(new Set(deck).size, 52);
  for (const r of RANKS) assert.equal(deck.filter((c) => rankOf(c) === r).length, 4);
  for (const st of SUITS) assert.equal(deck.filter((c) => c.endsWith(st)).length, 13);
});

test("shuffle: injectable rng is deterministic and permutes the deck", () => {
  const deck = freshDeck();
  const a = shuffle(deck, mulberry32(1));
  const b = shuffle(deck, mulberry32(1));
  const c = shuffle(deck, mulberry32(2));
  assert.deepEqual(a, b, "same seed → same shuffle");
  assert.notDeepEqual(a, c, "different seed → different shuffle");
  assert.deepEqual([...a].sort(), [...deck].sort(), "shuffle output is a permutation");
  assert.deepEqual(deck, freshDeck(), "input array not mutated");
});

test("defaultTeams alternates by join order; teamOf resolves membership", () => {
  const t4 = defaultTeams(mkPlayers(4));
  assert.deepEqual(t4, [{ id: "A", playerIds: ["p0", "p2"] }, { id: "B", playerIds: ["p1", "p3"] }]);
  const t6 = defaultTeams(mkPlayers(6));
  assert.deepEqual(t6[0].playerIds, ["p0", "p2", "p4"]);
  assert.deepEqual(t6[1].playerIds, ["p1", "p3", "p5"]);
  const solo = startGame(mkPlayers(2), {}, mulberry32(1));
  assert.equal(teamOf(solo, "p0"), null);
  const players = mkPlayers(4);
  const team = startGame(players, { mode: "team", teams: defaultTeams(players) }, mulberry32(1));
  assert.equal(teamOf(team, "p0"), "A");
  assert.equal(teamOf(team, "p1"), "B");
});

test("startGame (solo) conserves all 52 cards for several player counts", () => {
  for (const n of [2, 3, 5, 7]) {
    const s = startGame(mkPlayers(n), {}, mulberry32(100 + n));
    checkConservation(s);
    assert.equal(s.turn, "p0", "first joiner opens");
    assert.equal(s.winner, null);
  }
});

test("startGame deals 7 cards each, remainder in the deck", () => {
  for (const n of [2, 5]) {
    const s = dealClean(n);
    for (const h of Object.values(s.hands)) assert.equal(h.length, 7, `n=${n}`);
    assert.equal(s.deck.length, 52 - 7 * n);
  }
});

test("startGame auto-scores a quad dealt in the opening hand", () => {
  // Opening quads are rare (~1/600 hands); scan seeds until one shows up.
  let found = null;
  for (let seed = 1; seed <= 8000 && !found; seed++) {
    const s = startGame(mkPlayers(7), {}, mulberry32(seed));
    const col = s.log.find((e) => e.kind === "set_collected");
    if (col) found = { s, col };
  }
  assert.ok(found, "no opening quad in 8000 deals — statistically implausible");
  const { s, col } = found;
  assert.ok(s.sets[col.by].includes(col.rank), "quad rank recorded for its holder");
  assert.equal(s.hands[col.by].length, 3, "7 dealt minus the 4 quad cards");
  assert.ok(!s.hands[col.by].some((c) => rankOf(c) === col.rank), "quad cards left the hand");
  checkConservation(s);
});

test("startGame (team) validates player counts and team shape", () => {
  assert.throws(() => startGame(mkPlayers(1), {}, mulberry32(1)), "solo needs 2+");
  assert.throws(() => startGame(mkPlayers(3), { mode: "team", teams: defaultTeams(mkPlayers(3)) }), "team needs 4 or 6");
  assert.throws(() => startGame(mkPlayers(5), { mode: "team", teams: defaultTeams(mkPlayers(5)) }), "team needs 4 or 6");
  assert.throws(() => startGame(mkPlayers(4), { mode: "team" }), "teams required");
  assert.throws(() => startGame(mkPlayers(4), { mode: "team", teams: [
    { id: "A", playerIds: ["p0", "p1", "p2"] }, { id: "B", playerIds: ["p3"] },
  ] }), "teams must be equal size");
  for (const n of [4, 6]) {
    const players = mkPlayers(n);
    const s = startGame(players, { mode: "team", teams: defaultTeams(players) }, mulberry32(n));
    assert.equal(s.mode, "team");
    assert.deepEqual(s.teams, defaultTeams(players));
    assert.deepEqual(s.teamSets, { A: [], B: [] });
    checkConservation(s);
  }
});

test("team deal: 7 cards each, remainder in the deck", () => {
  const s = dealClean(4, "team");
  for (const h of Object.values(s.hands)) assert.equal(h.length, 7);
  assert.equal(s.deck.length, 52 - 28);
});

// ── Ask rules ────────────────────────────────────────────────────────
console.log("ask rules");

test("applyAsk validation: turn, self, unknown target, unheld rank, teammate, game over", () => {
  const s = craft({ ids: ["p0", "p1", "p2"], hands: { p0: ["5S"], p1: ["9C"], p2: ["KH"] }, deck: [], turn: "p0" });
  assert.ok(applyAsk(s, "p1", "p2", "9").error, "not your turn");
  assert.ok(applyAsk(s, "p0", "p0", "5").error, "can't ask yourself");
  assert.ok(applyAsk(s, "p0", "ghost", "5").error, "unknown target id");
  assert.ok(applyAsk(s, "p0", "p1", "K").error, "must hold the asked rank");
  const team = craft({ mode: "team", ids: ["p0", "p1", "p2", "p3"],
    hands: { p0: ["5S"], p1: ["9C"], p2: ["5H"], p3: ["9H"] }, deck: [], turn: "p0" });
  assert.ok(applyAsk(team, "p0", "p2", "5").error, "can't ask a teammate in team mode");
  const over = craft({ ids: ["p0", "p1"], hands: { p0: [], p1: [] }, deck: [], turn: "p0",
    sets: { p0: ["A"], p1: [] }, winner: "p0" });
  assert.ok(applyAsk(over, "p0", "p1", "A").error, "game already over");
});

test("ask hit: all cards of the rank transfer; asker keeps the turn", () => {
  const s = craft({ ids: ["p0", "p1"], hands: { p0: ["AS"], p1: ["AD", "AC", "9C"] }, deck: ["2D"], turn: "p0" });
  const r = applyAsk(s, "p0", "p1", "A");
  assert.ok(!r.error, r.error);
  assert.deepEqual(r.state.hands.p0, ["AS", "AD", "AC"]);
  assert.deepEqual(r.state.hands.p1, ["9C"]);
  assert.equal(r.state.turn, "p0", "hit keeps the turn");
  assert.equal(r.state.log.find((e) => e.kind === "ask_hit").count, 2);
  // purity: applyAsk clones — the input state is untouched
  assert.deepEqual(s.hands.p0, ["AS"]);
  assert.deepEqual(s.hands.p1, ["AD", "AC", "9C"]);
});

test("ask hit completing a quad scores it and passes the empty hand on", () => {
  const s = craft({ ids: ["p0", "p1"], hands: { p0: ["AS", "AH", "AD"], p1: ["AC", "2C"] }, deck: [], turn: "p0" });
  const r = applyAsk(s, "p0", "p1", "A");
  assert.ok(!r.error, r.error);
  assert.deepEqual(r.state.hands.p0, []);
  assert.deepEqual(r.state.sets.p0, ["A"]);
  assert.equal(r.state.turn, "p1", "empty hand passes the turn");
  assert.equal(totalCards(r.state), totalCards(s));
});

test("team-mode quad routes to teamSets, not the personal `sets`", () => {
  const s = craft({ mode: "team", ids: ["p0", "p1", "p2", "p3"],
    hands: { p0: ["AS", "AH", "AD"], p1: ["AC"], p2: [], p3: [] }, deck: [], turn: "p0" });
  const r = applyAsk(s, "p0", "p1", "A");
  assert.ok(!r.error, r.error);
  assert.deepEqual(r.state.teamSets.A, ["A"], "quad credited to the team");
  assert.deepEqual(r.state.sets.p0, [], "personal sets unused in team mode");
  // table now empty → team game ends with A ahead 1-0
  assert.equal(r.state.winner, "A");
});

test("ask miss: draw from the deck, turn passes, drawn card stays private", () => {
  const s = craft({ ids: ["p0", "p1", "p2"], hands: { p0: ["5S"], p1: ["9C"], p2: ["KH"] }, deck: ["2C", "3D"], turn: "p0" });
  const r = applyAsk(s, "p0", "p1", "5");
  assert.ok(!r.error, r.error);
  assert.deepEqual(r.state.hands.p0, ["5S", "2C"], "miss draws the deck's top card");
  assert.deepEqual(r.state.deck, ["3D"]);
  assert.equal(r.state.turn, "p1", "miss passes the turn");
  assert.equal(r.state.log.find((e) => e.kind === "ask_miss").drawn, "2C");
  // the drawer still sees their card; other players and spectators don't
  assert.equal(redactFor(r.state, "p0").log.find((e) => e.kind === "ask_miss").drawn, "2C");
  assert.equal("drawn" in redactFor(r.state, "p2").log.find((e) => e.kind === "ask_miss"), false);
  assert.equal("drawn" in redactFor(r.state, null).log.find((e) => e.kind === "ask_miss"), false);
});

test("lucky draw: matching the asked rank keeps the turn and is public", () => {
  const s = craft({ ids: ["p0", "p1", "p2"], hands: { p0: ["5S"], p1: ["9C"], p2: ["KH"] }, deck: ["5C", "3D"], turn: "p0" });
  const r = applyAsk(s, "p0", "p1", "5");
  assert.ok(!r.error, r.error);
  assert.equal(r.state.turn, "p0", "lucky draw keeps the turn");
  assert.equal(r.state.log.find((e) => e.kind === "ask_miss_lucky").drawn, "5C");
  // lucky draws are public — even non-involved viewers see the card
  assert.equal(redactFor(r.state, "p2").log.find((e) => e.kind === "ask_miss_lucky").drawn, "5C");
});

test("miss with an empty deck passes the turn without drawing", () => {
  const s = craft({ ids: ["p0", "p1"], hands: { p0: ["5S"], p1: ["9C"] }, deck: [], turn: "p0" });
  const r = applyAsk(s, "p0", "p1", "5");
  assert.ok(!r.error, r.error);
  assert.deepEqual(r.state.hands.p0, ["5S"], "nothing drawn");
  assert.equal(r.state.turn, "p1");
  const e = r.state.log.find((ev) => ev.kind === "ask_miss_no_deck");
  assert.ok(e, "ask_miss_no_deck logged");
  assert.ok(!("drawn" in e), "no card identity in the log entry");
});

// ── Auto-safety & healing ─────────────────────────────────────────────
console.log("auto-safety & healing");

test("turn landing on an empty hand auto-draws exactly one card", () => {
  // p1 is empty-handed: p0's miss passes the turn there; the engine
  // auto-draws for p1 so the turn is always playable.
  const s = craft({ ids: ["p0", "p1"], hands: { p0: ["5S"], p1: [] }, deck: ["2C", "3D"], turn: "p0" });
  const r = applyAsk(s, "p0", "p1", "5");
  assert.ok(!r.error, r.error);
  assert.deepEqual(r.state.hands.p1, ["3D"], "auto-draw refilled the empty hand");
  assert.deepEqual(r.state.deck, []);
  assert.equal(r.state.turn, "p1");
  const auto = r.state.log.find((e) => e.kind === "auto_draw");
  assert.deepEqual([auto.who, auto.drawn], ["p1", "3D"]);
});

test("healState: empty hand + live deck → exactly one draw, loop exits at once", () => {
  // A drawn card always leaves the hand non-empty (a 1-card hand can't hold
  // a quad), so the auto-draw path can never iterate twice — the engine's
  // 256-iteration safety cap in ensureTurnPlayable is unreachable from any
  // dealable state. Pin the invariant from the normal flow.
  const s = craft({ ids: ["p0", "p1"], hands: { p0: [], p1: ["9C"] }, deck: ["3C", "4D", "5H", "6S"], turn: "p0" });
  const h = healState(s);
  assert.deepEqual(h.hands.p0, ["3C"], "exactly one card drawn");
  assert.deepEqual(h.deck, ["4D", "5H", "6S"]);
  assert.equal(h.log.filter((e) => e.kind === "auto_draw").length, 1);
  assert.equal(h.turn, "p0");
});

test("healState: empty hand + dry deck → turn advances to a player with cards", () => {
  const s = craft({ ids: ["p0", "p1", "p2"], hands: { p0: [], p1: [], p2: ["9C"] }, deck: [], turn: "p0" });
  const h = healState(s);
  assert.equal(h.turn, "p2");
  assert.equal(h.log.length, 0, "no draw needed");
});

test("healState leaves finished games untouched", () => {
  const done = craft({ ids: ["p0", "p1"], hands: { p0: [], p1: [] }, deck: [], turn: "p0",
    sets: { p0: ["A"], p1: [] } });
  const h = healState(done);
  assert.equal(h.winner, "p0");
  assert.equal(healState(h), h, "passes finished states through by reference");
});

// ── Declares (team mode) ──────────────────────────────────────────────
console.log("declares");

test("applyDeclare validation: mode, turn, rank, claimed, teamless, game over", () => {
  const solo = craft({ ids: ["p0", "p1"], hands: { p0: ["5S"], p1: [] }, deck: [], turn: "p0" });
  assert.ok(applyDeclare(solo, "p0", "5").error, "declares only in team mode");
  const s = craft({ mode: "team", ids: ["p0", "p1", "p2", "p3"],
    hands: { p0: ["5S"], p1: ["9C"], p2: ["5H"], p3: ["9H"] }, deck: [], turn: "p0" });
  assert.ok(applyDeclare(s, "p1", "9").error, "not your turn");
  assert.ok(applyDeclare(s, "p0", "10").error, "invalid rank (engine uses T)");
  const claimed = craft({ mode: "team", ids: ["p0", "p1", "p2", "p3"],
    hands: { p0: ["5S"], p1: [], p2: [], p3: [] }, deck: [], turn: "p0",
    teamSets: { A: ["5"], B: [] } });
  assert.ok(applyDeclare(claimed, "p0", "5").error, "rank already claimed");
  const teamless = craft({ mode: "team", ids: ["p0", "p1", "p2", "p3"],
    hands: { p0: [], p1: [], p2: [], p3: ["KC"] }, deck: [], turn: "p3",
    teams: [{ id: "A", playerIds: ["p0", "p2"] }, { id: "B", playerIds: ["p1"] }] });
  assert.ok(applyDeclare(teamless, "p3", "K").error, "declarer not on a team");
  const over = craft({ mode: "team", ids: ["p0", "p1", "p2", "p3"],
    hands: { p0: [], p1: [], p2: [], p3: [] }, deck: [], turn: "p0",
    teamSets: { A: ["A"], B: [] }, winner: "A" });
  assert.ok(applyDeclare(over, "p0", "K").error, "game already over");
});

test("declare success: team holds all 4 → scored, cards removed, turn kept", () => {
  // Team A collectively holds all four fives (split across p0 and p2).
  const s = craft({ mode: "team", ids: ["p0", "p1", "p2", "p3"],
    hands: { p0: ["5S", "5H", "9S"], p1: ["9H"], p2: ["5D", "5C"], p3: ["9C"] },
    deck: ["2C"], turn: "p0" });
  const r = applyDeclare(s, "p0", "5");
  assert.ok(!r.error, r.error);
  assert.deepEqual(r.state.teamSets.A, ["5"]);
  assert.deepEqual(r.state.teamSets.B, []);
  assert.deepEqual(r.state.hands.p0, ["9S"], "declared cards removed from p0");
  assert.deepEqual(r.state.hands.p2, [], "…and from p2");
  assert.equal(r.state.turn, "p0", "successful declare keeps the turn");
  assert.deepEqual(r.state.deck, ["2C"], "unrelated deck cards untouched");
  const hit = r.state.log.find((e) => e.kind === "declare_hit");
  assert.deepEqual([hit.by, hit.team, hit.rank], ["p0", "A", "5"]);
  assert.equal(totalCards(r.state), totalCards(s));
});

test("declare failure: set goes to the OPPOSING team; cards pulled from hands AND the deck", () => {
  // A holds 2 fives, B holds 1, and the last five (5C) sits in the deck.
  const s = craft({ mode: "team", ids: ["p0", "p1", "p2", "p3"],
    hands: { p0: ["5S", "5H", "9S"], p1: ["5D", "9H"], p2: ["KC"], p3: ["9C"] },
    deck: ["5C", "2D", "7S"], turn: "p0" });
  const before = totalCards(s);
  const r = applyDeclare(s, "p0", "5");
  assert.ok(!r.error, r.error);
  assert.deepEqual(r.state.teamSets.B, ["5"], "failure awards the opposing team");
  assert.deepEqual(r.state.teamSets.A, []);
  assert.deepEqual(r.state.deck, ["2D", "7S"], "the deck's 5C was filtered out");
  assert.deepEqual(r.state.hands.p0, ["9S"]);
  assert.deepEqual(r.state.hands.p1, ["9H"]);
  const inPlay = [...r.state.deck, ...Object.values(r.state.hands).flat()];
  assert.ok(!inPlay.some((c) => rankOf(c) === "5"), "no five left anywhere in play");
  assert.equal(r.state.turn, "p1", "failed declare passes the turn");
  // 4 cards left play, 1 rank (= 4 cards) recorded: conservation intact
  assert.equal(totalCards(r.state), before);
  const miss = r.state.log.find((e) => e.kind === "declare_miss");
  assert.deepEqual([miss.by, miss.awardedTo, miss.rank], ["p0", "B", "5"]);
});

// ── Finishing ─────────────────────────────────────────────────────────
console.log("finishing");

test("solo finish: most sets wins; ties produce an array of winners", () => {
  const mkEnd = (sets) => craft({ ids: ["p0", "p1", "p2"],
    hands: { p0: [], p1: [], p2: [] }, deck: [], turn: "p0", sets });
  const winner = healState(mkEnd({
    p0: ["A", "K", "Q", "J", "T", "9", "8"], p1: ["7", "6", "5", "4", "3", "2"], p2: [],
  }));
  assert.equal(winner.winner, "p0");
  const tie = healState(mkEnd({
    p0: ["A", "K", "Q", "J", "T", "9"], p1: ["8", "7", "6", "5", "4", "3"], p2: [],
  }));
  assert.deepEqual(tie.winner, ["p0", "p1"], "documented tie shape: array of winners");
  const threeWay = healState(mkEnd({
    p0: ["A", "K", "Q", "J"], p1: ["T", "9", "8", "7"], p2: ["6", "5", "4", "3"],
  }));
  assert.deepEqual(threeWay.winner, ["p0", "p1", "p2"]);
});

test("solo: a live card anywhere means the game is NOT finished", () => {
  const deckLive = craft({ ids: ["p0", "p1"], hands: { p0: [], p1: [] }, deck: ["2C"], turn: "p0",
    sets: { p0: ["A"], p1: [] } });
  const h = healState(deckLive);
  assert.equal(h.winner, null);
  assert.deepEqual(h.hands.p0, ["2C"], "stray card auto-drawn; game continues");
  const handLive = craft({ ids: ["p0", "p1"], hands: { p0: ["2C"], p1: [] }, deck: [], turn: "p0",
    sets: { p0: ["A"], p1: [] } });
  assert.equal(healState(handLive).winner, null);
});

test("team finish: 13 ranks claimed ends it even with cards still in hand", () => {
  const s = craft({ mode: "team", ids: ["p0", "p1", "p2", "p3"],
    hands: { p0: ["2C"], p1: [], p2: [], p3: [] }, deck: ["3D"], turn: "p0",
    teamSets: { A: ["A", "K", "Q", "J", "T", "9", "8"], B: ["7", "6", "5", "4", "3", "2"] } });
  assert.equal(healState(s).winner, "A", "A claimed 7 of 13 — over despite live cards");
});

test("team finish: empty table settles the score; tie shape is [A, B]", () => {
  const mkTeamEnd = (a, b) => healState(craft({ mode: "team", ids: ["p0", "p1", "p2", "p3"],
    hands: { p0: [], p1: [], p2: [], p3: [] }, deck: [], turn: "p0", teamSets: { A: a, B: b } }));
  assert.equal(mkTeamEnd(["A", "K"], ["Q"]).winner, "A");
  assert.equal(mkTeamEnd(["A"], ["K", "Q", "J"]).winner, "B");
  // NOTE: 13 claimed ranks is odd, so a genuine team tie is unreachable in
  // real play; this just pins the engine's documented tie shape.
  assert.deepEqual(mkTeamEnd(["A", "K", "Q"], ["J", "T", "9"]).winner, ["A", "B"]);
  const live = craft({ mode: "team", ids: ["p0", "p1", "p2", "p3"],
    hands: { p0: ["2C"], p1: [], p2: [], p3: [] }, deck: [], turn: "p0",
    teamSets: { A: ["A"], B: ["K"] } });
  assert.equal(healState(live).winner, null, "cards in play → not finished");
});

// ── Redaction ─────────────────────────────────────────────────────────
console.log("redaction");

test("solo view: own hand visible, opponents reduced to counts", () => {
  const s = craft({ ids: ["p0", "p1"], hands: { p0: ["AS", "2H"], p1: ["KC"] }, deck: ["3D"],
    turn: "p1", sets: { p0: ["7"], p1: [] } });
  const v = redactFor(s, "p0");
  assert.deepEqual(v.you.hand, ["AS", "2H"]);
  assert.deepEqual(v.you.sets, ["7"]);
  assert.equal(v.deckCount, 1);
  assert.equal(v.turn, "p1");
  assert.equal(v.mode, "solo");
  const opp = v.opponents.find((o) => o.id === "p1");
  assert.equal(opp.handCount, 1);
  assert.equal(opp.sets, 0);
  assert.ok(!JSON.stringify(v).includes("KC"), "opponent's card leaked");
  const stranger = redactFor(s, "nobody");
  assert.deepEqual(stranger.you.hand, [], "spectator sees no hand");
  assert.ok(!JSON.stringify(stranger).includes("KC"));
});

test("team view: teammates/opponents summarized, team sets exposed", () => {
  const s = craft({ mode: "team", ids: ["p0", "p1", "p2", "p3"],
    hands: { p0: ["AS"], p1: ["KC"], p2: ["QD"], p3: ["JH"] }, deck: [], turn: "p0",
    teamSets: { A: ["A"], B: [] } });
  const v = redactFor(s, "p0");
  assert.equal(v.yourTeam, "A");
  assert.deepEqual(v.you.hand, ["AS"]);
  assert.deepEqual(v.you.sets, ["A"], "team sets exposed for UI compat");
  assert.deepEqual(v.teammates.map((t) => t.id), ["p2"]);
  assert.deepEqual(v.opponents.map((o) => o.id), ["p1", "p3"]);
  assert.equal(v.teammates[0].handCount, 1);
  assert.equal(v.players.find((p) => p.id === "p1").teamId, "B");
  const json = JSON.stringify(v);
  assert.ok(!json.includes("KC") && !json.includes("QD") && !json.includes("JH"), "other hands leaked");
});

test("log redaction: auto_draw cards stripped for everyone but the drawer", () => {
  const s = craft({ ids: ["p0", "p1"], hands: { p0: [], p1: [] }, deck: ["2C"], turn: "p0" });
  const h = healState(s);
  assert.equal(redactFor(h, "p0").log.find((e) => e.kind === "auto_draw").drawn, "2C");
  assert.equal("drawn" in redactFor(h, "p1").log.find((e) => e.kind === "auto_draw"), false);
});

// ── Fuzz: random games ────────────────────────────────────────────────
console.log("fuzz");

// Simple bot: ask a random held rank at a random legal target; in team mode
// occasionally declare a random unclaimed rank.
function botMove(s, rng) {
  const turn = s.turn;
  const hand = s.hands[turn];
  assert.ok(hand.length > 0, "bot asked with an empty hand");
  if (s.mode === "team" && rng() < 0.15) {
    const unclaimed = RANKS.filter((r) => !s.teamSets.A.includes(r) && !s.teamSets.B.includes(r));
    if (unclaimed.length > 0) {
      const rank = unclaimed[Math.floor(rng() * unclaimed.length)];
      const res = applyDeclare(s, turn, rank);
      assert.ok(!res.error, `fuzz declare failed: ${res.error}`);
      return res.state;
    }
  }
  const ranks = [...new Set(hand.map(rankOf))];
  const rank = ranks[Math.floor(rng() * ranks.length)];
  const targets = s.players.map((p) => p.id).filter((id) =>
    s.mode === "team" ? teamOf(s, id) !== teamOf(s, turn) : id !== turn);
  const to = targets[Math.floor(rng() * targets.length)];
  const res = applyAsk(s, turn, to, rank);
  assert.ok(!res.error, `fuzz ask failed: ${res.error}`);
  return res.state;
}

test("fuzz: 200 solo games — terminate, conserve 52, valid winner", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const n = 2 + (seed % 6); // 2..7 players
    const rng = mulberry32(seed * 2654435761);
    let s = startGame(mkPlayers(n), {}, rng);
    checkConservation(s);
    let actions = 0;
    while (!s.winner && actions < 30000) {
      s = botMove(s, rng);
      actions++;
      checkConservation(s);
      assert.ok(s.winner || s.hands[s.turn].length > 0, `seed=${seed}: turn player can't act`);
    }
    assert.ok(s.winner, `solo seed=${seed} failed to terminate in ${actions} actions`);
    const ids = s.players.map((p) => p.id);
    const winners = Array.isArray(s.winner) ? s.winner : [s.winner];
    for (const w of winners) assert.ok(ids.includes(w), `seed=${seed}: winner not a player`);
    if (Array.isArray(s.winner)) assert.ok(s.winner.length > 1, `seed=${seed}: single-entry tie array`);
    // table drained: 13 ranks claimed, most sets wins (winners tie at best)
    assert.equal(s.deck.length, 0, `seed=${seed}`);
    for (const h of Object.values(s.hands)) assert.equal(h.length, 0, `seed=${seed}`);
    assert.equal(ids.reduce((sum, id) => sum + s.sets[id].length, 0), 13, `seed=${seed}`);
    const best = Math.max(...ids.map((id) => s.sets[id].length));
    for (const id of ids) {
      if (winners.includes(id)) assert.equal(s.sets[id].length, best, `seed=${id}: winner lacks most sets`);
      else assert.ok(s.sets[id].length < best, `seed=${seed}: loser tied best but isn't a winner`);
    }
  }
});

test("fuzz: 100 team games — terminate, conserve 52, all 13 ranks claimed", () => {
  for (let seed = 1; seed <= 100; seed++) {
    const n = seed % 2 === 0 ? 4 : 6;
    const players = mkPlayers(n);
    const rng = mulberry32(seed * 40503 + 11);
    let s = startGame(players, { mode: "team", teams: defaultTeams(players) }, rng);
    checkConservation(s);
    let actions = 0;
    while (!s.winner && actions < 30000) {
      s = botMove(s, rng);
      actions++;
      checkConservation(s);
      assert.ok(s.winner || s.hands[s.turn].length > 0, `seed=${seed}: turn player can't act`);
    }
    assert.ok(s.winner, `team seed=${seed} failed to terminate in ${actions} actions`);
    const a = s.teamSets.A.length;
    const b = s.teamSets.B.length;
    assert.equal(a + b, 13, `seed=${seed}: not all ranks claimed`);
    if (a > b) assert.equal(s.winner, "A", `seed=${seed}`);
    else if (b > a) assert.equal(s.winner, "B", `seed=${seed}`);
    else assert.deepEqual(s.winner, ["A", "B"], `seed=${seed}`);
  }
});

console.log(`\n${passed} tests passed`);
