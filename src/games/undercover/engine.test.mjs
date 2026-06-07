// Plain node:assert test suite for the UNDERCOVER engine. No framework.
// Run: node src/games/undercover/engine.test.mjs
import assert from "node:assert/strict";
import {
  startGame,
  applyClue,
  applyVote,
  applyMrWhiteGuess,
  redactFor,
  defaultRoleCounts,
  validateRoleCounts,
  normalizeWord,
  clueContainsWord,
  ROLE,
  PHASE,
  BLANK_WORD,
} from "./engine.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log("  ok -", name);
}

// Deterministic RNG (mulberry32) so role assignment is reproducible.
function rngFrom(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mkPlayers(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
}
const PAIR = { a: "Samosa", b: "Kachori", cat: "indian-food" };

function roleCount(state, role) {
  return state.players.filter((p) => p.role === role).length;
}
function findRole(state, role) {
  return state.players.find((p) => p.role === role && p.alive);
}
function aliveIds(state) {
  return state.players.filter((p) => p.alive).map((p) => p.id);
}

// Drive a describe phase: every alive player (in seat order via currentDescriber)
// submits a clue. Returns the resulting state.
function doDescribePhase(state) {
  let s = state;
  let guard = 0;
  while (s.phase === PHASE.DESCRIBE && guard++ < 50) {
    const cur = s.players.find((p) => p.id === currentDescriberId(s));
    const clue = cur.word === BLANK_WORD ? "it is a thing" : `clue about ${cur.id}`;
    const res = applyClue(s, cur.id, clue);
    assert.ok(!res.error, `describe error: ${res.error}`);
    s = res.state;
  }
  return s;
}
function currentDescriberId(state) {
  const view = redactFor(state, null);
  return view.currentDescriber;
}

// Everyone alive votes for `targetId`. Returns the final state after tally.
function everyoneVotes(state, targetId) {
  let s = state;
  const voters = aliveIds(s).filter((id) => id !== targetId);
  // include the target voting for someone else (so they aren't excluded)
  const all = aliveIds(s);
  let r;
  for (const v of all) {
    const t = v === targetId ? voters[0] || all.find((x) => x !== v) : targetId;
    r = applyVote(s, v, t === v ? all.find((x) => x !== v) : t);
    assert.ok(!r.error, `vote error: ${r.error}`);
    s = r.state;
  }
  return s;
}

// ── defaultRoleCounts ──────────────────────────────────────────────────────
test("defaultRoleCounts by player count", () => {
  assert.deepEqual(defaultRoleCounts(4), { undercover: 1, mrWhite: 0 });
  assert.deepEqual(defaultRoleCounts(5), { undercover: 1, mrWhite: 1 });
  assert.deepEqual(defaultRoleCounts(6), { undercover: 1, mrWhite: 1 });
  assert.deepEqual(defaultRoleCounts(7), { undercover: 1, mrWhite: 1 });
  assert.deepEqual(defaultRoleCounts(8), { undercover: 2, mrWhite: 1 });
  assert.deepEqual(defaultRoleCounts(9), { undercover: 2, mrWhite: 1 });
  assert.deepEqual(defaultRoleCounts(10), { undercover: 3, mrWhite: 1 });
  assert.deepEqual(defaultRoleCounts(12), { undercover: 3, mrWhite: 1 });
});

// ── validateRoleCounts ─────────────────────────────────────────────────────
test("validateRoleCounts rules", () => {
  assert.equal(validateRoleCounts(6, 1, 1), null);
  assert.ok(validateRoleCounts(3, 1, 0)); // too few players
  assert.ok(validateRoleCounts(13, 1, 0)); // too many
  assert.ok(validateRoleCounts(6, 0, 1)); // undercover < 1
  assert.ok(validateRoleCounts(6, 1, -1)); // negative mr white
  // civilians must strictly outnumber impostors: 6p, 2 uc + 1 mw → 3 civ == 3 imp → invalid
  assert.ok(validateRoleCounts(6, 2, 1));
  // 7p, 2uc + 1mw → 4 civ > 3 imp → valid
  assert.equal(validateRoleCounts(7, 2, 1), null);
});

// ── role assignment distribution ──────────────────────────────────────────
test("role assignment honors counts and never starts Mr. White first", () => {
  for (let n = 4; n <= 12; n++) {
    for (let seed = 1; seed <= 40; seed++) {
      const def = defaultRoleCounts(n);
      const s = startGame(mkPlayers(n), { pair: PAIR }, rngFrom(seed));
      assert.equal(roleCount(s, ROLE.UNDERCOVER), def.undercover, `uc count n=${n}`);
      assert.equal(roleCount(s, ROLE.MR_WHITE), def.mrWhite, `mw count n=${n}`);
      assert.equal(
        roleCount(s, ROLE.CIVILIAN),
        n - def.undercover - def.mrWhite,
        `civ count n=${n}`
      );
      // first seat is never Mr. White
      assert.notEqual(s.players[0].role, ROLE.MR_WHITE, `seat0 mr white n=${n} seed=${seed}`);
    }
  }
});

test("words assigned correctly per role + coin flip used", () => {
  let sawAasCivilian = false;
  let sawBasCivilian = false;
  for (let seed = 1; seed <= 60; seed++) {
    const s = startGame(mkPlayers(6), { pair: PAIR }, rngFrom(seed));
    const civ = s.players.find((p) => p.role === ROLE.CIVILIAN);
    const uc = s.players.find((p) => p.role === ROLE.UNDERCOVER);
    const mw = s.players.find((p) => p.role === ROLE.MR_WHITE);
    assert.equal(civ.word, s.civilianWord);
    assert.equal(uc.word, s.undercoverWord);
    assert.equal(mw.word, BLANK_WORD);
    assert.notEqual(s.civilianWord, s.undercoverWord);
    if (s.civilianWord === PAIR.a) sawAasCivilian = true;
    if (s.civilianWord === PAIR.b) sawBasCivilian = true;
  }
  assert.ok(sawAasCivilian && sawBasCivilian, "coin flip should produce both orientations");
});

// ── clue validation ────────────────────────────────────────────────────────
test("clueContainsWord catches own word, tokens, plurals", () => {
  assert.ok(clueContainsWord("a tasty Samosa", "Samosa"));
  assert.ok(clueContainsWord("samosas are great", "Samosa")); // substring/plural
  assert.ok(clueContainsWord("BUTTER chicken yum", "Butter Chicken")); // token
  assert.ok(!clueContainsWord("fried snack", "Samosa"));
  assert.ok(!clueContainsWord("", "Samosa"));
});

test("applyClue validation: phase, turn, dead, empty, own word, double", () => {
  const s = startGame(mkPlayers(5), { pair: PAIR, undercover: 1, mrWhite: 1 }, rngFrom(7));
  const first = s.players.find((p) => p.id === currentDescriberId(s));
  // wrong turn
  const wrongTurn = s.players.find((p) => p.id !== first.id);
  assert.ok(applyClue(s, wrongTurn.id, "hi").error, "should reject out of turn");
  // empty
  assert.ok(applyClue(s, first.id, "   ").error);
  // multi-line
  assert.ok(applyClue(s, first.id, "line1\nline2").error);
  // own word (skip if Mr. White, but first is never Mr. White)
  assert.ok(applyClue(s, first.id, `I love ${first.word}`).error, "own word rejected");
  // valid
  const ok = applyClue(s, first.id, "a snack");
  assert.ok(!ok.error);
  // double submit
  assert.ok(applyClue(ok.state, first.id, "again").error, "double submit rejected");
  // voting actions rejected during describe
  assert.ok(applyVote(s, first.id, wrongTurn.id).error);
});

test("Mr. White may write a clue containing arbitrary text", () => {
  // find a seed where Mr White isn't first but still describes; just ensure no
  // own-word restriction blocks a blank-word player.
  const s = startGame(mkPlayers(5), { pair: PAIR, undercover: 1, mrWhite: 1 }, rngFrom(3));
  let st = s;
  let guard = 0;
  while (st.phase === PHASE.DESCRIBE && guard++ < 20) {
    const cur = st.players.find((p) => p.id === currentDescriberId(st));
    const txt = cur.word === BLANK_WORD ? "Samosa Kachori anything goes" : "a snack item";
    const r = applyClue(st, cur.id, txt);
    assert.ok(!r.error, `clue rejected: ${r.error}`);
    st = r.state;
  }
  assert.equal(st.phase, PHASE.VOTE);
});

// ── voting: tie / revote / second tie → no elimination ─────────────────────
test("vote validation: self-vote, dead target, phase", () => {
  let s = startGame(mkPlayers(5), { pair: PAIR, undercover: 1, mrWhite: 1 }, rngFrom(11));
  s = doDescribePhase(s);
  assert.equal(s.phase, PHASE.VOTE);
  const ids = aliveIds(s);
  assert.ok(applyVote(s, ids[0], ids[0]).error, "self vote rejected");
  assert.ok(applyVote(s, ids[0], "nobody").error, "unknown target rejected");
  // clue rejected during vote
  assert.ok(applyClue(s, ids[0], "hi").error);
});

test("tie → revote among tied → second tie → no elimination, next round", () => {
  // 4 players: split votes 2-2 between two candidates, twice.
  let s = startGame(mkPlayers(4), { pair: PAIR, undercover: 1, mrWhite: 0 }, rngFrom(5));
  s = doDescribePhase(s);
  const ids = aliveIds(s); // 4
  const [A, B, C, D] = ids;
  // votes: A->C, B->C, C->D, D->? to make a 2-2 tie between C and D need 2 each.
  // Let A->C, B->C (C=2); C->D, D->C? D can't... arrange: A->C,B->D,C->D,D->C => C=2,D=2 tie.
  let r;
  r = applyVote(s, A, C); s = r.state;
  r = applyVote(s, B, D); s = r.state;
  r = applyVote(s, C, D); s = r.state;
  r = applyVote(s, D, C); s = r.state;
  // Now should be a revote between C and D.
  assert.equal(s.phase, PHASE.VOTE, "still voting (revote)");
  assert.deepEqual([...s.voteCandidates].sort(), [C, D].sort());
  assert.equal(s.tieStreak, 1);
  // Revote must target a tied candidate only.
  assert.ok(applyVote(s, A, B).error, "revote must target tied candidate");
  // Force another 2-2 tie: A->C,B->D,C->D,D->C
  r = applyVote(s, A, C); s = r.state;
  r = applyVote(s, B, D); s = r.state;
  r = applyVote(s, C, D); s = r.state;
  r = applyVote(s, D, C); s = r.state;
  // Second tie → no elimination, advance to round 2 describe.
  assert.equal(s.round, 2, "advanced a round");
  assert.equal(s.phase, PHASE.DESCRIBE);
  assert.equal(aliveIds(s).length, 4, "no one eliminated");
});

// ── elimination reveals role ───────────────────────────────────────────────
test("elimination reveals the eliminated player's role publicly", () => {
  let s = startGame(mkPlayers(6), { pair: PAIR, undercover: 1, mrWhite: 1 }, rngFrom(9));
  s = doDescribePhase(s);
  const civ = findRole(s, ROLE.CIVILIAN);
  s = everyoneVotes(s, civ.id);
  // civ eliminated → not over yet (impostors still < civilians likely)
  const spectator = redactFor(s, null);
  const elimView = spectator.players.find((p) => p.id === civ.id);
  assert.equal(elimView.alive, false);
  assert.equal(elimView.role, ROLE.CIVILIAN, "eliminated role revealed to spectator");
  // a still-alive player's role stays hidden
  const aliveView = spectator.players.find((p) => p.alive);
  assert.equal(aliveView.role, null, "alive role hidden");
});

// ── Mr. White guess win ────────────────────────────────────────────────────
test("Mr. White eliminated → correct guess wins instantly", () => {
  let s = startGame(mkPlayers(6), { pair: PAIR, undercover: 1, mrWhite: 1 }, rngFrom(2));
  s = doDescribePhase(s);
  const mw = findRole(s, ROLE.MR_WHITE);
  s = everyoneVotes(s, mw.id);
  assert.equal(s.phase, PHASE.MR_WHITE_GUESS);
  assert.equal(s.pendingMrWhite, mw.id);
  // wrong player can't guess
  const other = s.players.find((p) => p.id !== mw.id);
  assert.ok(applyMrWhiteGuess(s, other.id, s.civilianWord).error);
  // correct guess (case/space-insensitive)
  const guess = s.civilianWord.toUpperCase() + "  ";
  const r = applyMrWhiteGuess(s, mw.id, guess);
  assert.ok(!r.error);
  assert.equal(r.state.winner, "mrwhite");
  assert.equal(r.state.phase, PHASE.OVER);
});

test("Mr. White wrong guess → game continues with win checks", () => {
  let s = startGame(mkPlayers(6), { pair: PAIR, undercover: 1, mrWhite: 1 }, rngFrom(2));
  s = doDescribePhase(s);
  const mw = findRole(s, ROLE.MR_WHITE);
  s = everyoneVotes(s, mw.id);
  const r = applyMrWhiteGuess(s, mw.id, "definitely wrong word");
  assert.ok(!r.error);
  // 6p, 1uc+1mw: after mw out → 1 imp vs 4 civ → continue to next round.
  assert.equal(r.state.winner, null);
  assert.equal(r.state.phase, PHASE.DESCRIBE);
  assert.equal(r.state.round, 2);
});

// ── civilians win path ─────────────────────────────────────────────────────
test("civilians win when all impostors eliminated", () => {
  // 4p, 1 undercover, 0 mr white. Vote out the undercover → civilians win.
  let s = startGame(mkPlayers(4), { pair: PAIR, undercover: 1, mrWhite: 0 }, rngFrom(8));
  s = doDescribePhase(s);
  const uc = findRole(s, ROLE.UNDERCOVER);
  s = everyoneVotes(s, uc.id);
  assert.equal(s.winner, "civilians");
  assert.equal(s.phase, PHASE.OVER);
});

// ── impostors win path ─────────────────────────────────────────────────────
test("impostors win when they reach parity with civilians", () => {
  // 4p, 1 undercover, 0 mr white. Vote out a civilian → 1 imp vs 2 civ.
  // Vote out another civilian → 1 imp vs 1 civ → parity → impostors win.
  let s = startGame(mkPlayers(4), { pair: PAIR, undercover: 1, mrWhite: 0 }, rngFrom(8));
  s = doDescribePhase(s);
  let civs = s.players.filter((p) => p.role === ROLE.CIVILIAN);
  s = everyoneVotes(s, civs[0].id);
  assert.equal(s.winner, null, "still going after first civ out");
  s = doDescribePhase(s);
  s = everyoneVotes(s, civs[1].id);
  assert.equal(s.winner, "impostors");
  assert.ok(s.survivors.length >= 1, "survivors announced");
  const uc = s.players.find((p) => p.role === ROLE.UNDERCOVER);
  assert.ok(s.survivors.includes(uc.id));
});

// ── redaction matrix ───────────────────────────────────────────────────────
test("redaction: own word visible, others hidden until reveal/over", () => {
  const s = startGame(mkPlayers(6), { pair: PAIR, undercover: 1, mrWhite: 1 }, rngFrom(4));
  const civ = s.players.find((p) => p.role === ROLE.CIVILIAN);
  const view = redactFor(s, civ.id);
  // you see your own word + isYou flag
  assert.equal(view.you.word, s.civilianWord);
  assert.equal(view.you.isMrWhite, false);
  // other players' words/roles null
  for (const p of view.players) {
    if (p.id === civ.id) {
      assert.equal(p.word, s.civilianWord);
    } else {
      assert.equal(p.word, null, "other word hidden");
      assert.equal(p.role, null, "other role hidden while alive");
    }
  }
  // global words hidden pre-over
  assert.equal(view.civilianWord, null);
  assert.equal(view.undercoverWord, null);

  // Mr White sees "???"
  const mw = s.players.find((p) => p.role === ROLE.MR_WHITE);
  const mwView = redactFor(s, mw.id);
  assert.equal(mwView.you.word, BLANK_WORD);
  assert.equal(mwView.you.isMrWhite, true);

  // spectator: no words, sees players list
  const spec = redactFor(s, null);
  assert.equal(spec.you, null);
  for (const p of spec.players) assert.equal(p.word, null);
});

test("redaction: at game over everyone sees all roles + both words", () => {
  let s = startGame(mkPlayers(4), { pair: PAIR, undercover: 1, mrWhite: 0 }, rngFrom(8));
  s = doDescribePhase(s);
  const uc = findRole(s, ROLE.UNDERCOVER);
  s = everyoneVotes(s, uc.id);
  assert.equal(s.winner, "civilians");
  const spec = redactFor(s, null);
  assert.equal(spec.civilianWord, s.civilianWord);
  assert.equal(spec.undercoverWord, s.undercoverWord);
  for (const p of spec.players) {
    assert.ok(p.role, "all roles revealed at game over");
    assert.ok(p.word, "all words revealed at game over");
  }
});

test("redaction: vote phase exposes who voted but not their targets", () => {
  let s = startGame(mkPlayers(5), { pair: PAIR, undercover: 1, mrWhite: 1 }, rngFrom(6));
  s = doDescribePhase(s);
  const ids = aliveIds(s);
  const r = applyVote(s, ids[0], ids[1]);
  s = r.state;
  const view = redactFor(s, null);
  assert.ok(view.votedIds.includes(ids[0]), "voter exposed");
  // target not exposed anywhere in the snapshot
  const serialized = JSON.stringify(view.votedIds);
  assert.equal(serialized.includes(ids[1]) && view.votedIds.includes(ids[1]), false);
  // vote_cast log entries must not carry a target
  const cast = view.log.filter((e) => e.kind === "vote_cast");
  for (const e of cast) assert.equal(e.target, undefined, "vote_cast must not leak target");
});

// ── normalizeWord ──────────────────────────────────────────────────────────
test("normalizeWord", () => {
  assert.equal(normalizeWord("  Hello, World! "), "hello world");
  assert.equal(normalizeWord("Café"), "cafe");
  assert.equal(normalizeWord("Filter   Coffee"), "filter coffee");
});

// ── full random game simulations ───────────────────────────────────────────
test("random full-game simulations always terminate with a valid winner", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const n = 4 + (seed % 9); // 4..12
    const rng = rngFrom(seed * 2654435761);
    let s = startGame(mkPlayers(n), { pair: PAIR }, rng);
    let guard = 0;
    while (!s.winner && guard++ < 500) {
      if (s.phase === PHASE.DESCRIBE) {
        const cur = s.players.find((p) => p.id === currentDescriberId(s));
        const txt = cur.word === BLANK_WORD ? "some vague hint" : `hint ${cur.id} ${seed}`;
        const r = applyClue(s, cur.id, txt);
        assert.ok(!r.error, `sim describe err seed=${seed}: ${r.error}`);
        s = r.state;
      } else if (s.phase === PHASE.VOTE) {
        const ids = aliveIds(s);
        const candidates = s.voteCandidates || ids;
        // each voter picks a random eligible target (not self)
        for (const v of ids) {
          if (s.winner) break;
          if (s.votes[v] !== undefined) continue;
          const choices = candidates.filter((c) => c !== v);
          const target = choices[Math.floor(rng() * choices.length)];
          const r = applyVote(s, v, target);
          assert.ok(!r.error, `sim vote err seed=${seed}: ${r.error}`);
          s = r.state;
        }
      } else if (s.phase === PHASE.MR_WHITE_GUESS) {
        // sometimes guess right, sometimes wrong
        const guess = rng() < 0.3 ? s.civilianWord : "wrong";
        const r = applyMrWhiteGuess(s, s.pendingMrWhite, guess);
        assert.ok(!r.error, `sim mw err seed=${seed}: ${r.error}`);
        s = r.state;
      } else {
        break;
      }
    }
    assert.ok(s.winner, `sim seed=${seed} did not finish (n=${n})`);
    assert.ok(["civilians", "impostors", "mrwhite"].includes(s.winner));
    assert.equal(s.phase, PHASE.OVER);
    // sanity: civilianWord !== undercoverWord, and final view reveals both
    const v = redactFor(s, null);
    assert.ok(v.civilianWord && v.undercoverWord);
  }
});

console.log(`\nAll ${passed} UNDERCOVER engine tests passed.`);
