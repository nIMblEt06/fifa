// Plain node test script for the BLUFF engine. No test framework — uses
// node:assert and is run with: node src/games/bluff/engine.test.mjs
import assert from "node:assert";
import {
  startGame,
  applyPlay,
  applyPass,
  applyBluff,
  redactFor,
  freshDeck,
  rankOf,
  RANKS,
  MAX_PLAY,
} from "./engine.js";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok  " + name);
  } catch (e) {
    console.error("FAIL  " + name);
    console.error(e.stack || e);
    process.exitCode = 1;
  }
}

const P = (n) => Array.from({ length: n }, (_, i) => ({ id: "p" + i, name: "P" + i }));

// Deterministic RNG (LCG) so shuffles are reproducible.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Helper: rebuild a state with hand-picked hands so we can force outcomes.
// Returns a started game then overwrites hands/turn deterministically.
function rigged(players, hands, turn) {
  const g = startGame(players, {}, makeRng(1));
  g.hands = JSON.parse(JSON.stringify(hands));
  g.pile = [];
  g.claimRank = null;
  g.roundPlays = [];
  g.lastPlay = null;
  g.passes = 0;
  g.out = [];
  g.loser = null;
  g.winner = null;
  g.turn = turn;
  return g;
}

// ── Dealing ────────────────────────────────────────────────────────
test("deals all 52 cards as evenly as possible", () => {
  for (let n = 3; n <= 8; n++) {
    const g = startGame(P(n), {}, makeRng(n));
    const counts = g.players.map((p) => g.hands[p.id].length);
    const total = counts.reduce((a, b) => a + b, 0);
    assert.equal(total, 52, `n=${n} total cards`);
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, `n=${n} even-ish`);
    // No duplicate cards across all hands.
    const all = g.players.flatMap((p) => g.hands[p.id]);
    assert.equal(new Set(all).size, 52, `n=${n} unique`);
  }
});

test("rejects <3 and >8 players", () => {
  assert.throws(() => startGame(P(2)));
  assert.throws(() => startGame(P(9)));
});

test("fresh deck is 52 unique cards", () => {
  const d = freshDeck();
  assert.equal(d.length, 52);
  assert.equal(new Set(d).size, 52);
});

// ── Opening / basic play validation ────────────────────────────────
test("opening play sets the round rank and advances turn", () => {
  const g = rigged(P(3), { p0: ["KS", "KH", "2C"], p1: ["3D", "4D"], p2: ["5S", "6S"] }, "p0");
  const r = applyPlay(g, "p0", ["KS", "KH"], "K");
  assert.ok(!r.error, r.error);
  assert.equal(r.state.claimRank, "K");
  assert.equal(r.state.pileCount ?? r.state.pile.length, 2);
  assert.equal(r.state.turn, "p1");
  assert.equal(r.state.lastPlay.count, 2);
});

test("mid-round play is locked to the round rank regardless of caller claim", () => {
  let g = rigged(P(3), { p0: ["KS"], p1: ["3D", "4D"], p2: ["5S"] }, "p0");
  g = applyPlay(g, "p0", ["KS"], "K").state;
  // p1 tries to claim "3" but round rank is "K" — engine forces "K".
  const r = applyPlay(g, "p1", ["3D"], "3");
  assert.ok(!r.error, r.error);
  assert.equal(r.state.lastPlay.claim, "K");
});

test("can't play cards you don't hold / dupes / too many", () => {
  const g = rigged(P(3), { p0: ["KS", "KH", "KD", "KC", "2C"], p1: ["3D"], p2: ["5S"] }, "p0");
  assert.ok(applyPlay(g, "p0", ["AS"], "A").error, "not held");
  assert.ok(applyPlay(g, "p0", ["KS", "KS"], "K").error, "dupe");
  assert.ok(applyPlay(g, "p0", ["KS", "KH", "KD", "KC", "2C"], "K").error, "> MAX_PLAY");
  assert.ok(applyPlay(g, "p1", ["3D"], "3").error, "not your turn");
});

test("can't open a round with a pass", () => {
  const g = rigged(P(3), { p0: ["KS"], p1: ["3D"], p2: ["5S"] }, "p0");
  assert.ok(applyPass(g, "p0").error);
});

test("can't bluff when there's no play", () => {
  const g = rigged(P(3), { p0: ["KS"], p1: ["3D"], p2: ["5S"] }, "p0");
  assert.ok(applyBluff(g, "p0").error);
});

// ── Truthful challenge ─────────────────────────────────────────────
test("calling bluff on a TRUTHFUL play makes the challenger eat the pile", () => {
  let g = rigged(P(3), { p0: ["KS", "KH", "2C"], p1: ["3D", "4D"], p2: ["5S", "6S"] }, "p0");
  g = applyPlay(g, "p0", ["KS", "KH"], "K").state; // truthful: both Kings, keeps 2C
  const before = g.hands.p1.length;
  const r = applyBluff(g, "p1");
  assert.ok(!r.error, r.error);
  // p1 (challenger) was wrong → picks up the 2-card pile.
  assert.equal(r.state.hands.p1.length, before + 2);
  assert.equal(r.state.pile.length, 0);
  // Truth-teller p0 (still holding 2C) opens the next round.
  assert.equal(r.state.turn, "p0");
  assert.equal(r.state.claimRank, null);
  const ev = r.state.log[r.state.log.length - 1];
  assert.equal(ev.kind, "bluff");
  assert.equal(ev.wasLie, false);
});

// ── Lying challenge ────────────────────────────────────────────────
test("calling bluff on a LIE makes the liar eat the pile and challenger opens", () => {
  let g = rigged(P(3), { p0: ["2S", "3H"], p1: ["3D", "4D"], p2: ["5S", "6S"] }, "p0");
  g = applyPlay(g, "p0", ["2S", "3H"], "K").state; // lie: claimed Kings
  const before = g.hands.p0.length; // 0 after playing
  const r = applyBluff(g, "p1");
  assert.ok(!r.error, r.error);
  assert.equal(r.state.hands.p0.length, before + 2, "liar eats pile");
  assert.equal(r.state.pile.length, 0);
  // Successful challenger p1 opens next round.
  assert.equal(r.state.turn, "p1");
  const ev = r.state.log[r.state.log.length - 1];
  assert.equal(ev.wasLie, true);
  assert.deepEqual(ev.revealed.sort(), ["2S", "3H"].sort());
});

// ── Pass-around burn ───────────────────────────────────────────────
test("everyone passing after a play burns the pile; last player opens fresh", () => {
  let g = rigged(P(3), { p0: ["KS"], p1: ["3D", "4D"], p2: ["5S", "6S"] }, "p0");
  g = applyPlay(g, "p0", ["KS"], "K").state; // p0 plays, turn → p1
  assert.equal(g.turn, "p1");
  g = applyPass(g, "p1").state;              // turn → p2
  assert.equal(g.turn, "p2");
  g = applyPass(g, "p2").state;              // back around → burn
  assert.equal(g.pile.length, 0, "pile burned");
  assert.equal(g.claimRank, null, "fresh round");
  // Last player to have played (p0) opens — but p0 is now empty, so next actor.
  // p0 has 0 cards → opener falls through to next actor with cards.
  assert.ok(g.turn === "p1" || g.turn === "p2");
  const burnEv = g.log.find((e) => e.kind === "burn");
  assert.ok(burnEv, "burn logged");
});

test("burn opener stays with last player when they still hold cards", () => {
  let g = rigged(P(3), { p0: ["KS", "2C"], p1: ["3D"], p2: ["5S"] }, "p0");
  g = applyPlay(g, "p0", ["KS"], "K").state; // p0 keeps 2C
  g = applyPass(g, "p1").state;
  g = applyPass(g, "p2").state;              // burn
  assert.equal(g.turn, "p0");
});

// ── Going out + final-play challenge revival ───────────────────────
test("going out is provisional until the final play survives challenge", () => {
  // p0 empties hand truthfully; p1 wrongly challenges → p0 stays out.
  let g = rigged(P(3), { p0: ["KS"], p1: ["3D", "4D"], p2: ["5S", "6S"] }, "p0");
  g = applyPlay(g, "p0", ["KS"], "K").state; // p0 now empty, provisionally out
  assert.equal(g.hands.p0.length, 0);
  assert.ok(!g.out.includes("p0"), "not finalized yet");
  const r = applyBluff(g, "p1"); // truthful → p1 eats pile, p0 confirmed out
  assert.ok(!r.error, r.error);
  assert.ok(r.state.out.includes("p0"), "p0 finalized out");
  assert.equal(r.state.out[0], "p0");
});

test("a LYING final play is revived: liar picks the pile back up", () => {
  let g = rigged(P(3), { p0: ["2S"], p1: ["3D", "4D"], p2: ["5S", "6S"] }, "p0");
  g = applyPlay(g, "p0", ["2S"], "K").state; // lie, p0 'out' provisionally
  const r = applyBluff(g, "p1"); // lie caught → p0 eats pile, back in
  assert.ok(!r.error, r.error);
  assert.ok(!r.state.out.includes("p0"), "p0 revived");
  assert.ok(r.state.hands.p0.length > 0, "p0 holds the pile now");
});

test("going out finalizes on burn/round-reset too", () => {
  // p0 plays last card truthfully, everyone passes → burn finalizes p0 out.
  let g = rigged(P(3), { p0: ["KS"], p1: ["3D"], p2: ["5S"] }, "p0");
  g = applyPlay(g, "p0", ["KS"], "K").state;
  g = applyPass(g, "p1").state;
  g = applyPass(g, "p2").state; // burn; p0 had emptied → finalized out
  assert.ok(g.out.includes("p0"));
});

// ── Game end ───────────────────────────────────────────────────────
test("game ends with a loser when ≤1 player holds cards", () => {
  // p0 and p1 each have 1 card; p2 has 2. p0 then p1 go out truthfully.
  let g = rigged(P(3), { p0: ["KS"], p1: ["KH"], p2: ["2C", "3C"] }, "p0");
  g = applyPlay(g, "p0", ["KS"], "K").state;   // p0 out (provisional), turn p1
  g = applyPlay(g, "p1", ["KH"], "K").state;   // p1 out (provisional), turn p2 — only p2 can act
  // With only p2 holding cards, the game should be over.
  assert.ok(g.loser === "p2", "p2 is the crapico");
  assert.ok(g.out.includes("p0") && g.out.includes("p1"));
  assert.equal(g.winner, "p0");
});

// ── Redaction ──────────────────────────────────────────────────────
test("redaction hides others' hands and pile cards, exposes claims", () => {
  let g = rigged(P(3), { p0: ["2S", "3H"], p1: ["3D", "4D"], p2: ["5S", "6S"] }, "p0");
  g = applyPlay(g, "p0", ["2S"], "K").state; // lie claimed
  const v1 = redactFor(g, "p1");
  assert.deepEqual(v1.you.hand.sort(), ["3D", "4D"].sort());
  // p0's hand is not exposed; only a count.
  assert.ok(!("hand" in v1.players.find((p) => p.id === "p0")));
  assert.equal(v1.players.find((p) => p.id === "p0").handCount, 1);
  // Pile is a count only, no cards.
  assert.equal(typeof v1.pileCount, "number");
  assert.ok(!("pile" in v1));
  // Claim history is visible (count + rank), no actual cards.
  assert.equal(v1.claimRank, "K");
  assert.equal(v1.lastPlay.claim, "K");
  assert.ok(!("cards" in v1.lastPlay));
});

test("bluff reveal event exposes the revealed cards to all viewers", () => {
  let g = rigged(P(3), { p0: ["2S", "3H"], p1: ["3D", "4D"], p2: ["5S", "6S"] }, "p0");
  g = applyPlay(g, "p0", ["2S", "3H"], "K").state;
  g = applyBluff(g, "p1").state;
  const v2 = redactFor(g, "p2"); // a non-participant still sees the reveal
  const ev = v2.log.find((e) => e.kind === "bluff");
  assert.ok(ev, "reveal present");
  assert.deepEqual(ev.revealed.sort(), ["2S", "3H"].sort());
});

// ── Full simulated random game to completion ───────────────────────
test("random bot game runs to a clean finish", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const rng = makeRng(seed * 7 + 3);
    const n = 3 + Math.floor(rng() * 6); // 3..8
    let g = startGame(P(n), {}, rng);
    let steps = 0;
    while (!g.loser && steps < 5000) {
      steps++;
      const me = g.turn;
      assert.ok(me, "turn must be set while playing");
      const hand = g.hands[me];
      assert.ok(hand.length > 0 && !g.out.includes(me), "actor holds cards");

      const canBluff = g.lastPlay && g.lastPlay.by !== me;
      const roundOpen = g.claimRank !== null;
      const roll = rng();

      let res;
      if (canBluff && roll < 0.18) {
        res = applyBluff(g, me);
      } else if (roundOpen && roll < 0.38) {
        res = applyPass(g, me);
      } else {
        // Play 1..min(MAX_PLAY, hand) cards. Sometimes truthful (cards of the
        // claimed/own rank), sometimes a bluff (random cards).
        const claim = roundOpen ? g.claimRank : RANKS[Math.floor(rng() * RANKS.length)];
        const truthful = hand.filter((c) => rankOf(c) === claim);
        let chosen;
        if (truthful.length && rng() < 0.6) {
          const k = 1 + Math.floor(rng() * Math.min(MAX_PLAY, truthful.length));
          chosen = truthful.slice(0, k);
        } else {
          const k = 1 + Math.floor(rng() * Math.min(MAX_PLAY, hand.length));
          chosen = hand.slice(0, k);
        }
        res = applyPlay(g, me, chosen, claim);
      }
      // An invalid action shouldn't crash; fall back to a guaranteed-legal move.
      if (res.error) {
        if (roundOpen && g.lastPlay) {
          res = applyPass(g, me);
        } else {
          res = applyPlay(g, me, [hand[0]], roundOpen ? g.claimRank : rankOf(hand[0]));
        }
      }
      assert.ok(!res.error, `seed ${seed}: stuck — ${res.error}`);
      g = res.state;
    }
    assert.ok(g.loser !== undefined, `seed ${seed}: game finished (steps=${steps})`);
    // At most one player still holds cards (the crapico). Burns can in rare
    // cases empty everyone, in which case the last to go out is the loser.
    const holders = g.players.filter((p) => g.hands[p.id].length > 0).map((p) => p.id);
    assert.ok(holders.length <= 1, `seed ${seed}: ≤1 holder`);
    if (holders.length === 1) {
      assert.equal(holders[0], g.loser, `seed ${seed}: holder is loser`);
    }
    // Card conservation: 52 cards across hands + pile + burned at all times.
    const total =
      g.players.reduce((a, p) => a + g.hands[p.id].length, 0) +
      g.pile.length +
      g.burned.length;
    assert.equal(total, 52, `seed ${seed}: cards conserved`);
  }
});

console.log(`\n${passed} tests passed.`);
