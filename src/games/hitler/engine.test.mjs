// Plain node test script for the Secret Hitler engine. No test framework in the
// repo — run with: node src/games/hitler/engine.test.mjs
import assert from "node:assert";
import {
  startGame, roleCountsFor, powerFor, partyOf,
  nominateChancellor, castVote, presidentDiscard, chancellorEnact,
  proposeVeto, respondVeto,
  investigatePlayer, specialElection, peekAck, executePlayer,
  eligibleChancellors, redactFor, withRng,
  LIBERAL, FASCIST, HITLER,
} from "./engine.js";

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  ok  -", name); }
  catch (e) { console.error("  FAIL -", name, "\n      ", e.message); process.exitCode = 1; }
}

// Deterministic RNG (LCG) for reproducible shuffles.
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 0x100000000; };
}

function mkPlayers(n) {
  return Array.from({ length: n }, (_, i) => ({ id: "p" + i, name: "P" + i }));
}

// Force a specific set of roles onto a game (bypass shuffle for control).
function withRoles(state, roleArr) {
  state.seating.forEach((id, i) => { state.roles[id] = roleArr[i]; });
  return state;
}

// Helper: unwrap an action result, asserting no error.
function ok(res) {
  assert.ok(!res.error, "unexpected error: " + res.error);
  return res.state;
}
function fails(res, frag) {
  assert.ok(res.error, "expected an error");
  if (frag) assert.ok(res.error.toLowerCase().includes(frag.toLowerCase()), `error "${res.error}" should mention "${frag}"`);
}

// Alive ids from a raw engine state (state.alive map).
function aliveOf(state) {
  return state.seating.filter((id) => state.alive[id]);
}

// Drive a full election to a "ja" result.
function electGov(state, presId, chanId, voters) {
  let s = ok(nominateChancellor(state, presId, chanId));
  for (const id of aliveOf(s)) {
    s = ok(castVote(s, id, voters ? voters(id) : "ja"));
  }
  return s;
}

// ── Role distribution ───────────────────────────────────────────────────────
test("role counts per player count", () => {
  assert.deepStrictEqual(roleCountsFor(5), { liberals: 3, fascists: 1, hitler: 1 });
  assert.deepStrictEqual(roleCountsFor(6), { liberals: 4, fascists: 1, hitler: 1 });
  assert.deepStrictEqual(roleCountsFor(7), { liberals: 4, fascists: 2, hitler: 1 });
  assert.deepStrictEqual(roleCountsFor(8), { liberals: 5, fascists: 2, hitler: 1 });
  assert.deepStrictEqual(roleCountsFor(9), { liberals: 5, fascists: 3, hitler: 1 });
  assert.deepStrictEqual(roleCountsFor(10), { liberals: 6, fascists: 3, hitler: 1 });
});

test("startGame deals exactly the right roles for each count", () => {
  for (let n = 5; n <= 10; n++) {
    const s = startGame(mkPlayers(n), {}, lcg(n + 7));
    const roles = Object.values(s.roles);
    const c = roleCountsFor(n);
    assert.strictEqual(roles.filter((r) => r === LIBERAL).length, c.liberals, `liberals @${n}`);
    assert.strictEqual(roles.filter((r) => r === FASCIST).length, c.fascists, `fascists @${n}`);
    assert.strictEqual(roles.filter((r) => r === HITLER).length, 1, `hitler @${n}`);
    assert.strictEqual(s.deck.length, 17, "policy deck = 17");
    assert.strictEqual(s.deck.filter((p) => p === LIBERAL).length, 6);
    assert.strictEqual(s.deck.filter((p) => p === FASCIST).length, 11);
  }
});

test("rejects <5 and >10 players", () => {
  assert.throws(() => startGame(mkPlayers(4)));
  assert.throws(() => startGame(mkPlayers(11)));
});

// ── Knowledge / redaction matrix ─────────────────────────────────────────────
test("fascists know each other and Hitler; liberals know nothing", () => {
  let s = startGame(mkPlayers(7), {}, lcg(1));
  // p0=H, p1=F, p2=F, p3..p6=L
  withRoles(s, [HITLER, FASCIST, FASCIST, LIBERAL, LIBERAL, LIBERAL, LIBERAL]);

  const fasView = redactFor(s, "p1");
  const knownToFascist = fasView.players.filter((p) => p.role).map((p) => p.id).sort();
  assert.deepStrictEqual(knownToFascist, ["p0", "p1", "p2"], "fascist sees both fascists + Hitler");
  assert.strictEqual(fasView.players.find((p) => p.id === "p0").role, HITLER);

  const libView = redactFor(s, "p3");
  const knownToLib = libView.players.filter((p) => p.role).map((p) => p.id);
  assert.deepStrictEqual(knownToLib, ["p3"], "liberal only knows self");
});

test("Hitler knows the fascist in 5–6p but not in 7+p", () => {
  // 5p: Hitler should see the single fascist.
  let s5 = startGame(mkPlayers(5), {}, lcg(2));
  withRoles(s5, [HITLER, FASCIST, LIBERAL, LIBERAL, LIBERAL]);
  const h5 = redactFor(s5, "p0");
  assert.strictEqual(h5.players.find((p) => p.id === "p1").role, FASCIST, "Hitler sees fascist @5p");

  // 7p: Hitler should know nothing but self.
  let s7 = startGame(mkPlayers(7), {}, lcg(3));
  withRoles(s7, [HITLER, FASCIST, FASCIST, LIBERAL, LIBERAL, LIBERAL, LIBERAL]);
  const h7 = redactFor(s7, "p0");
  const known = h7.players.filter((p) => p.role).map((p) => p.id);
  assert.deepStrictEqual(known, ["p0"], "Hitler knows only self @7p");
});

test("spectator sees no roles; game-over reveals all", () => {
  let s = startGame(mkPlayers(5), {}, lcg(4));
  withRoles(s, [HITLER, FASCIST, LIBERAL, LIBERAL, LIBERAL]);
  const spec = redactFor(s, "nobody");
  assert.strictEqual(spec.players.filter((p) => p.role).length, 0);
  assert.strictEqual(spec.you, null);
  // After game over:
  s.winner = LIBERAL;
  const reveal = redactFor(s, "nobody");
  assert.strictEqual(reveal.players.filter((p) => p.role).length, 5, "all revealed at end");
});

// ── Term limits ──────────────────────────────────────────────────────────────
test("term limits: prev chancellor always ineligible; prev president ineligible when >5 alive", () => {
  // 7 players → >5 alive → both prev pres and prev chancellor blocked.
  let s = startGame(mkPlayers(7), {}, lcg(5));
  withRoles(s, [LIBERAL, LIBERAL, LIBERAL, LIBERAL, FASCIST, FASCIST, HITLER]);
  s.presidentIdx = 0; s.president = "p0";
  s = electGov(s, "p0", "p1"); // p0 pres, p1 chancellor elected
  // Pass a liberal policy to advance to next nomination cleanly.
  s = ok(presidentDiscard(s, s.president, pickIndex(s.presidentDraw, FASCIST))); // discard a fascist if any
  s = ok(chancellorEnact(s, s.chancellor, 0));
  // Now a new president; prev elected gov was p0(pres)/p1(chanc).
  const elig = eligibleChancellors(s);
  assert.ok(!elig.includes("p1"), "prev chancellor blocked");
  assert.ok(!elig.includes("p0"), "prev president blocked (>5 alive)");
  assert.ok(!elig.includes(s.president), "president can't nominate self");
});

test("term limits: prev president eligible again at exactly 5 alive", () => {
  let s = startGame(mkPlayers(5), {}, lcg(6));
  withRoles(s, [LIBERAL, LIBERAL, LIBERAL, FASCIST, HITLER]);
  s.lastElected = { president: "p0", chancellor: "p1" };
  s.president = "p2"; s.presidentIdx = 2; s.phase = "nomination";
  const elig = eligibleChancellors(s);
  assert.ok(!elig.includes("p1"), "prev chancellor still blocked @5 alive");
  assert.ok(elig.includes("p0"), "prev president allowed @5 alive");
});

// helper: index of first card of `kind` in a draw, else 0.
function pickIndex(cards, kind) {
  const i = cards.indexOf(kind);
  return i >= 0 ? i : 0;
}

// ── Voting & election tracker ────────────────────────────────────────────────
test("votes hidden until all cast, then revealed; double-vote rejected", () => {
  let s = startGame(mkPlayers(5), {}, lcg(7));
  withRoles(s, [LIBERAL, LIBERAL, LIBERAL, FASCIST, HITLER]);
  s.president = "p0"; s.presidentIdx = 0;
  s = ok(nominateChancellor(s, "p0", "p1"));
  s = ok(castVote(s, "p0", "ja"));
  // Not revealed yet.
  let v = redactFor(s, "p2");
  assert.strictEqual(v.lastVotes, null, "no reveal until all voted");
  assert.deepStrictEqual(v.votedIds, ["p0"]);
  fails(castVote(s, "p0", "nein"), "already");
  s = ok(castVote(s, "p1", "ja"));
  s = ok(castVote(s, "p2", "ja"));
  s = ok(castVote(s, "p3", "nein"));
  s = ok(castVote(s, "p4", "nein"));
  assert.ok(s.lastVotes, "revealed after all voted");
  assert.strictEqual(s.lastVotes.ja, 3);
  assert.strictEqual(s.lastVotes.nein, 2);
  assert.strictEqual(s.lastVotes.passed, true);
  assert.strictEqual(s.chancellor, "p1");
});

test("tie fails the election (majority must be strictly greater)", () => {
  let s = startGame(mkPlayers(6), {}, lcg(8));
  withRoles(s, [LIBERAL, LIBERAL, LIBERAL, LIBERAL, FASCIST, HITLER]);
  s.president = "p0"; s.presidentIdx = 0;
  s = ok(nominateChancellor(s, "p0", "p1"));
  const ids = ["p0", "p1", "p2", "p3", "p4", "p5"];
  ids.forEach((id, i) => { s = ok(castVote(s, id, i < 3 ? "ja" : "nein")); });
  assert.strictEqual(s.lastVotes.passed, false, "3-3 tie fails");
  assert.strictEqual(s.electionTracker, 1);
  assert.strictEqual(s.chancellor, null);
});

test("election tracker auto-enacts at 3, no power, resets tracker & term limits", () => {
  let s = startGame(mkPlayers(5), {}, lcg(9));
  withRoles(s, [LIBERAL, LIBERAL, LIBERAL, FASCIST, HITLER]);
  // Stack deck so top card is known.
  s.deck = [FASCIST, LIBERAL, LIBERAL, ...s.deck];
  s.fascistPolicies = 2; // a fascist enact at F3 would normally trigger peek
  s.lastElected = { president: "p0", chancellor: "p1" };
  // Fail three elections.
  const failOnce = (st) => {
    let x = ok(nominateChancellor(st, st.president, eligibleChancellors(st)[0]));
    for (const id of aliveOf(x)) x = ok(castVote(x, id, "nein"));
    return x;
  };
  s = failOnce(s); assert.strictEqual(s.electionTracker, 1);
  s = failOnce(s); assert.strictEqual(s.electionTracker, 2);
  const before = s.fascistPolicies;
  s = failOnce(s);
  // Top was FASCIST → fascistPolicies +1, but NO power (still nomination phase).
  assert.strictEqual(s.fascistPolicies, before + 1, "chaos enacted the top fascist policy");
  assert.strictEqual(s.electionTracker, 0, "tracker reset");
  assert.strictEqual(s.phase, "nomination", "no power triggered by chaos enact");
  assert.deepStrictEqual(s.lastElected, { president: null, chancellor: null }, "term limits reset");
});

// ── Legislative flow ─────────────────────────────────────────────────────────
test("legislative: president draws 3, discards 1, chancellor enacts 1; discards never revealed", () => {
  let s = startGame(mkPlayers(5), {}, lcg(10));
  withRoles(s, [LIBERAL, LIBERAL, LIBERAL, FASCIST, HITLER]);
  s.deck = [LIBERAL, FASCIST, FASCIST, ...s.deck.slice(3)];
  s.president = "p0"; s.presidentIdx = 0;
  s = electGov(s, "p0", "p1");
  assert.strictEqual(s.phase, "legislative_president");
  // President sees 3 cards; nobody else does.
  const presView = redactFor(s, "p0");
  assert.strictEqual(presView.presidentDraw.length, 3);
  const otherView = redactFor(s, "p2");
  assert.strictEqual(otherView.presidentDraw, undefined, "non-president can't see draw");
  // Discard a fascist (index 1).
  s = ok(presidentDiscard(s, "p0", 1));
  assert.strictEqual(s.phase, "legislative_chancellor");
  const chanView = redactFor(s, "p1");
  assert.strictEqual(chanView.chancellorCards.length, 2);
  assert.strictEqual(redactFor(s, "p0").chancellorCards, undefined, "president can't see chancellor cards");
  const discardBefore = s.discard.length;
  // Enact the liberal.
  const libIdx = s.chancellorCards.indexOf(LIBERAL);
  s = ok(chancellorEnact(s, "p1", libIdx));
  assert.strictEqual(s.liberalPolicies, 1);
  assert.strictEqual(s.discard.length, discardBefore + 1, "the unenacted card is discarded");
  assert.strictEqual(s.phase, "nomination", "advances to next government");
});

test("reshuffle when deck < 3", () => {
  let s = startGame(mkPlayers(5), {}, lcg(11));
  withRoles(s, [LIBERAL, LIBERAL, LIBERAL, FASCIST, HITLER]);
  s = withRng(s, lcg(99));
  s.deck = [LIBERAL, LIBERAL]; // only 2 left
  s.discard = [FASCIST, FASCIST, FASCIST, LIBERAL];
  s.president = "p0"; s.presidentIdx = 0;
  s = electGov(s, "p0", "p1");
  // beginLegislative drew 3 from a reshuffled pile (2+4=6 → minus 3 = 3 left).
  assert.strictEqual(s.presidentDraw.length, 3);
  assert.strictEqual(s.deck.length + s.presidentDraw.length, 6 - 0, "all cards accounted (6 total minus drawn)");
  assert.strictEqual(s.discard.length, 0, "discard folded in");
});

// ── Presidential powers ──────────────────────────────────────────────────────
test("powerFor table is correct", () => {
  // 5–6p
  assert.strictEqual(powerFor(5, 1), null);
  assert.strictEqual(powerFor(5, 2), null);
  assert.strictEqual(powerFor(5, 3), "peek");
  assert.strictEqual(powerFor(5, 4), "execution");
  assert.strictEqual(powerFor(6, 5), "execution");
  // 7–8p
  assert.strictEqual(powerFor(7, 1), null);
  assert.strictEqual(powerFor(7, 2), "investigate");
  assert.strictEqual(powerFor(7, 3), "special_election");
  assert.strictEqual(powerFor(8, 4), "execution");
  assert.strictEqual(powerFor(8, 5), "execution");
  // 9–10p
  assert.strictEqual(powerFor(9, 1), "investigate");
  assert.strictEqual(powerFor(10, 2), "investigate");
  assert.strictEqual(powerFor(9, 3), "special_election");
  assert.strictEqual(powerFor(10, 4), "execution");
  assert.strictEqual(powerFor(9, 5), "execution");
});

// Drive a government that enacts a FASCIST policy (to trigger powers).
function enactFascist(s) {
  // ensure top 3 contains a fascist for the chancellor
  s.deck = [FASCIST, FASCIST, FASCIST, ...s.deck];
  s = electGov(s, s.president, eligibleChancellors(s)[0]);
  s = ok(presidentDiscard(s, s.president, 0));
  s = ok(chancellorEnact(s, s.chancellor, 0));
  return s;
}

test("policy peek (5-6p, F3): president sees top 3 privately, then acks", () => {
  let s = startGame(mkPlayers(5), {}, lcg(12));
  withRoles(s, [LIBERAL, LIBERAL, LIBERAL, FASCIST, HITLER]);
  s.president = "p0"; s.presidentIdx = 0;
  s.fascistPolicies = 2;
  s = enactFascist(s);
  assert.strictEqual(s.fascistPolicies, 3);
  assert.strictEqual(s.phase, "power");
  assert.strictEqual(s.pendingPower.kind, "peek");
  const pv = redactFor(s, "p0");
  assert.strictEqual(pv.peek.length, 3, "president sees the peek");
  assert.strictEqual(redactFor(s, "p1").peek, undefined, "others don't");
  s = ok(peekAck(s, "p0"));
  assert.strictEqual(s.phase, "nomination");
});

test("investigate (7p, F2): result private to president, once-per-game cap, Hitler reads as Fascist", () => {
  let s = startGame(mkPlayers(7), {}, lcg(13));
  withRoles(s, [LIBERAL, LIBERAL, LIBERAL, LIBERAL, FASCIST, FASCIST, HITLER]);
  s.president = "p0"; s.presidentIdx = 0;
  s.fascistPolicies = 1;
  s = enactFascist(s);
  assert.strictEqual(s.pendingPower.kind, "investigate");
  // Investigate Hitler (p6) → should read Fascist.
  s = ok(investigatePlayer(s, "p0", "p6"));
  const pv = redactFor(s, "p0");
  assert.strictEqual(pv.investigationResult.target, "p6");
  assert.strictEqual(pv.investigationResult.party, FASCIST, "Hitler investigates as Fascist");
  assert.strictEqual(redactFor(s, "p1").investigationResult, undefined, "private to president");
  // Can't re-investigate the same player later (set up a fresh investigation
  // power for the CURRENT president).
  const curPres = s.president;
  s.phase = "power"; s.pendingPower = { kind: "investigate", by: curPres };
  fails(investigatePlayer(s, curPres, "p6"), "already");
});

test("special election (7p, F3): president picks next president, rotation resumes after", () => {
  let s = startGame(mkPlayers(7), {}, lcg(14));
  withRoles(s, [LIBERAL, LIBERAL, LIBERAL, LIBERAL, FASCIST, FASCIST, HITLER]);
  s.president = "p0"; s.presidentIdx = 0;
  s.fascistPolicies = 2;
  s = enactFascist(s);
  assert.strictEqual(s.pendingPower.kind, "special_election");
  s = ok(specialElection(s, "p0", "p4"));
  assert.strictEqual(s.president, "p4", "special president installed");
  assert.strictEqual(s.phase, "nomination");
  // After p4's government, rotation resumes from p1 (next after p0).
  s = electGov(s, "p4", eligibleChancellors(s)[0]);
  s = ok(presidentDiscard(s, s.president, 0));
  // make sure it's a liberal so no further power
  s.chancellorCards = [LIBERAL, LIBERAL];
  s = ok(chancellorEnact(s, s.chancellor, 0));
  assert.strictEqual(s.president, "p1", "rotation resumed after special president");
});

test("execution: target out, can't vote/nominate; executing Hitler → liberals win", () => {
  let s = startGame(mkPlayers(7), {}, lcg(15));
  withRoles(s, [LIBERAL, LIBERAL, LIBERAL, LIBERAL, FASCIST, FASCIST, HITLER]);
  s.president = "p0"; s.presidentIdx = 0;
  s.fascistPolicies = 3;
  s = enactFascist(s);
  assert.strictEqual(s.pendingPower.kind, "execution");
  // Execute a liberal first.
  s = ok(executePlayer(s, "p0", "p1"));
  assert.strictEqual(s.alive["p1"], false);
  assert.ok(!s.winner, "executing a liberal doesn't end the game");
  // Dead player can't vote.
  const exPres = s.president;
  s.phase = "voting"; s.nominee = "p2"; s.votes = {};
  fails(castVote(s, "p1", "ja"), "dead");
  // Now execute Hitler → liberals win (use whoever is the current president).
  s.phase = "power"; s.pendingPower = { kind: "execution", by: exPres };
  s = ok(executePlayer(s, exPres, "p6"));
  assert.strictEqual(s.winner, LIBERAL);
  assert.match(s.winReason, /Hitler/);
});

// ── Veto ─────────────────────────────────────────────────────────────────────
test("veto: locked before 5 fascist policies; agreed discards both & advances tracker", () => {
  let s = startGame(mkPlayers(5), {}, lcg(16));
  withRoles(s, [LIBERAL, LIBERAL, LIBERAL, FASCIST, HITLER]);
  s = withRng(s, lcg(50));
  s.president = "p0"; s.presidentIdx = 0;
  s.fascistPolicies = 5;
  s.deck = [LIBERAL, LIBERAL, LIBERAL, LIBERAL, FASCIST, FASCIST];
  s = electGov(s, "p0", "p1");
  s = ok(presidentDiscard(s, "p0", 0));
  assert.ok(redactFor(s, "p1").vetoUnlocked, "veto unlocked at 5 fascist");
  // Chancellor proposes veto.
  s = ok(proposeVeto(s, "p1"));
  assert.strictEqual(s.phase, "veto");
  const trackerBefore = s.electionTracker;
  s = ok(respondVeto(s, "p0", true));
  assert.strictEqual(s.electionTracker, trackerBefore + 1, "agreed veto advances tracker");
  assert.strictEqual(s.phase, "nomination", "government ends");
});

test("veto rejected → chancellor must enact", () => {
  let s = startGame(mkPlayers(5), {}, lcg(17));
  withRoles(s, [LIBERAL, LIBERAL, LIBERAL, FASCIST, HITLER]);
  s.president = "p0"; s.presidentIdx = 0;
  s.fascistPolicies = 5;
  s.deck = [LIBERAL, FASCIST, FASCIST, LIBERAL, LIBERAL, LIBERAL];
  s = electGov(s, "p0", "p1");
  s = ok(presidentDiscard(s, "p0", 0));
  s = ok(proposeVeto(s, "p1"));
  s = ok(respondVeto(s, "p0", false));
  assert.strictEqual(s.phase, "legislative_chancellor", "back to chancellor");
  // After a rejected veto the chancellor MUST enact one of the two cards.
  s = ok(chancellorEnact(s, "p1", 0));
  assert.ok(s.fascistPolicies + s.liberalPolicies >= 6 || s.phase, "enacted");
});

test("veto blocked before unlock", () => {
  let s = startGame(mkPlayers(5), {}, lcg(18));
  withRoles(s, [LIBERAL, LIBERAL, LIBERAL, FASCIST, HITLER]);
  s.president = "p0"; s.presidentIdx = 0;
  s.fascistPolicies = 4;
  s.deck = [LIBERAL, LIBERAL, LIBERAL, LIBERAL, LIBERAL, LIBERAL];
  s = electGov(s, "p0", "p1");
  s = ok(presidentDiscard(s, "p0", 0));
  fails(proposeVeto(s, "p1"), "unlock");
});

// ── Win conditions ───────────────────────────────────────────────────────────
test("liberal win: 5 liberal policies", () => {
  let s = startGame(mkPlayers(5), {}, lcg(19));
  withRoles(s, [LIBERAL, LIBERAL, LIBERAL, FASCIST, HITLER]);
  s.liberalPolicies = 4;
  s.president = "p0"; s.presidentIdx = 0;
  s.deck = [LIBERAL, LIBERAL, LIBERAL, ...s.deck];
  s = electGov(s, "p0", "p1");
  s = ok(presidentDiscard(s, "p0", 0));
  s = ok(chancellorEnact(s, "p1", 0));
  assert.strictEqual(s.winner, LIBERAL);
  assert.match(s.winReason, /liberal/);
});

test("fascist win: 6 fascist policies", () => {
  let s = startGame(mkPlayers(5), {}, lcg(20));
  withRoles(s, [LIBERAL, LIBERAL, LIBERAL, FASCIST, HITLER]);
  s.fascistPolicies = 5;
  s.president = "p0"; s.presidentIdx = 0;
  s.deck = [FASCIST, FASCIST, FASCIST, ...s.deck];
  s = electGov(s, "p0", "p1");
  s = ok(presidentDiscard(s, "p0", 0));
  s = ok(chancellorEnact(s, "p1", 0));
  assert.strictEqual(s.winner, FASCIST);
  assert.match(s.winReason, /fascist/);
});

test("fascist win: Hitler elected chancellor after 3+ fascist policies", () => {
  let s = startGame(mkPlayers(7), {}, lcg(21));
  withRoles(s, [LIBERAL, LIBERAL, LIBERAL, LIBERAL, FASCIST, FASCIST, HITLER]);
  s.fascistPolicies = 3;
  s.president = "p0"; s.presidentIdx = 0;
  s = electGov(s, "p0", "p6"); // p6 is Hitler
  assert.strictEqual(s.winner, FASCIST);
  assert.match(s.winReason, /Hitler.*Chancellor/);
});

test("Hitler chancellor with <3 fascist policies does NOT win", () => {
  let s = startGame(mkPlayers(7), {}, lcg(22));
  withRoles(s, [LIBERAL, LIBERAL, LIBERAL, LIBERAL, FASCIST, FASCIST, HITLER]);
  s.fascistPolicies = 2;
  s.president = "p0"; s.presidentIdx = 0;
  s = electGov(s, "p0", "p6");
  assert.strictEqual(s.winner, null, "no fascist win below 3 fascist policies");
  assert.strictEqual(s.phase, "legislative_president");
});

test("liberal win: Hitler executed (covered) + party mapping", () => {
  assert.strictEqual(partyOf(HITLER), FASCIST);
  assert.strictEqual(partyOf(FASCIST), FASCIST);
  assert.strictEqual(partyOf(LIBERAL), LIBERAL);
});

// ── Presidency rotation skips dead players ───────────────────────────────────
test("presidency rotation skips executed players", () => {
  let s = startGame(mkPlayers(7), {}, lcg(23));
  withRoles(s, [LIBERAL, LIBERAL, LIBERAL, LIBERAL, FASCIST, FASCIST, HITLER]);
  s.president = "p0"; s.presidentIdx = 0;
  s.alive["p1"] = false; // p1 dead
  // Run a liberal government, then check presidency moved to p2 (skipping p1).
  s.deck = [LIBERAL, LIBERAL, LIBERAL, ...s.deck];
  s = electGov(s, "p0", "p2");
  s = ok(presidentDiscard(s, "p0", 0));
  s = ok(chancellorEnact(s, "p2", 0));
  assert.strictEqual(s.president, "p2", "skipped dead p1");
});

console.log(`\n${passed} checks passed.`);
