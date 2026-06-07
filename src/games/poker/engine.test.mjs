// Node test script for the poker engine — no framework, just node:assert.
// Run: node src/games/poker/engine.test.mjs
import assert from "node:assert/strict";
import {
  evaluate, describeScore, handCategory,
  createTable, startHand, applyAction, addChips, setSittingOut,
  seatPlayer, cashOutPlayer, settlementRows, chipsBalanced, redactFor,
  canStartHand,
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

// ── Hand evaluator ───────────────────────────────────────────────────
console.log("evaluator");

const ev = (...cards) => evaluate(cards);

test("categories rank correctly", () => {
  const sf = ev("9S", "8S", "7S", "6S", "5S", "2H", "3D"); // straight flush
  const quads = ev("AS", "AH", "AD", "AC", "KS", "2H", "3D");
  const boat = ev("AS", "AH", "AD", "KC", "KS", "2H", "3D");
  const flush = ev("AS", "JS", "9S", "6S", "2S", "KH", "QD");
  const straight = ev("9S", "8H", "7S", "6D", "5C", "2H", "AD");
  const trips = ev("AS", "AH", "AD", "KC", "QS", "9H", "3D");
  const twoPair = ev("AS", "AH", "KD", "KC", "QS", "9H", "3D");
  const pair = ev("AS", "AH", "KD", "QC", "JS", "9H", "3D");
  const high = ev("AS", "KH", "QD", "JC", "9S", "5H", "3D");
  const order = [sf, quads, boat, flush, straight, trips, twoPair, pair, high];
  for (let i = 0; i < order.length - 1; i++) assert.ok(order[i] > order[i + 1], `cat ${i} > cat ${i + 1}`);
  assert.equal(describeScore(sf), "Straight Flush");
  assert.equal(describeScore(high), "High Card");
});

test("wheel straight (A-5) beaten by 6-high straight", () => {
  const wheel = ev("AS", "2H", "3D", "4C", "5S", "9H", "KD");
  const six = ev("2S", "3H", "4D", "5C", "6S", "9H", "KD");
  assert.equal(handCategory(wheel), 4);
  assert.ok(six > wheel);
});

test("kickers break ties; identical hands tie", () => {
  const aksKicker = ev("AS", "AH", "KD", "7C", "5S", "2H", "9D");
  const aqsKicker = ev("AD", "AC", "QD", "7H", "5C", "2S", "9H");
  assert.ok(aksKicker > aqsKicker);
  const a = ev("AS", "KH", "9D", "7C", "5S", "2H", "3D");
  const b = ev("AD", "KC", "9H", "7S", "5C", "2D", "3H");
  assert.equal(a, b);
});

test("board plays: both players tie with board straight", () => {
  const board = ["TS", "JH", "QD", "KC", "AS"];
  const p1 = ev(...board, "2H", "3D");
  const p2 = ev(...board, "9H", "4C"); // 9 makes K-high straight only — board A-high is better
  assert.equal(p1, p2);
});

test("full house picks best trip + pair from 7", () => {
  const s = ev("AS", "AH", "AD", "KC", "KS", "KH", "2D"); // aces full of kings
  assert.equal(describeScore(s), "Full House");
  const lower = ev("KS", "KH", "KD", "AC", "AS", "2H", "3D"); // kings full of aces
  assert.ok(s > lower);
});

// ── Table basics ─────────────────────────────────────────────────────
console.log("table & blinds");

const P = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
const CFG = { sb: 25, bb: 50, startingStack: 5000 };

// Reshape a seat's stack for a scenario, keeping buy-ins consistent so the
// chip-conservation invariant still holds.
const setStack = (t, i, chips) => {
  t.seats[i].stack = chips;
  t.seats[i].buyIns = [chips];
};

test("createTable validates", () => {
  assert.throws(() => createTable(P(1), CFG));
  assert.throws(() => createTable(P(2), { sb: 50, bb: 25, startingStack: 5000 }));
  assert.throws(() => createTable(P(2), { sb: 25, bb: 50, startingStack: 60 }));
  const t = createTable(P(3), CFG);
  assert.equal(t.seats.length, 3);
  assert.ok(chipsBalanced(t));
});

test("3-handed: blinds posted, UTG acts first preflop", () => {
  const t = createTable(P(3), CFG);
  const { table } = startHand(t, mulberry32(1));
  // button p0 → sb p1, bb p2, first to act = p0 (UTG = button 3-handed)
  assert.equal(table.hand.toAct, "p0");
  assert.equal(table.hand.committed["p1"], 25);
  assert.equal(table.hand.committed["p2"], 50);
  assert.equal(table.hand.pot, 75);
  assert.ok(chipsBalanced(table));
});

test("heads-up: button posts SB and acts first preflop", () => {
  const t = createTable(P(2), CFG);
  const { table } = startHand(t, mulberry32(2));
  // button p0 = SB, p1 = BB; preflop first actor = button
  assert.equal(table.hand.committed["p0"], 25);
  assert.equal(table.hand.committed["p1"], 50);
  assert.equal(table.hand.toAct, "p0");
});

test("everyone folds to BB → BB wins blinds without showdown", () => {
  const t = createTable(P(3), CFG);
  let { table } = startHand(t, mulberry32(3));
  ({ table } = applyAction(table, "p0", { move: "fold" }));
  ({ table } = applyAction(table, "p1", { move: "fold" }));
  assert.equal(table.hand.results.kind, "fold");
  assert.deepEqual(table.hand.results.pots[0].winners, ["p2"]);
  const bb = table.seats.find((s) => s.id === "p2");
  assert.equal(bb.stack, 5025); // won both blinds
  assert.ok(chipsBalanced(table));
});

test("BB gets the option when everyone limps", () => {
  const t = createTable(P(3), CFG);
  let { table } = startHand(t, mulberry32(4));
  ({ table } = applyAction(table, "p0", { move: "call" }));
  ({ table } = applyAction(table, "p1", { move: "call" }));
  assert.equal(table.hand.toAct, "p2"); // BB option
  let res = applyAction(table, "p2", { move: "check" });
  assert.equal(res.table.hand.street, "flop");
  assert.equal(res.table.hand.board.length, 3);
  // BB can also raise instead:
  res = applyAction(table, "p2", { move: "raise", amount: 150 });
  assert.equal(res.table.hand.currentBet, 150);
  assert.equal(res.table.hand.street, "preflop");
});

test("action order postflop starts left of button", () => {
  const t = createTable(P(3), CFG);
  let { table } = startHand(t, mulberry32(5));
  ({ table } = applyAction(table, "p0", { move: "call" }));
  ({ table } = applyAction(table, "p1", { move: "call" }));
  ({ table } = applyAction(table, "p2", { move: "check" }));
  assert.equal(table.hand.street, "flop");
  assert.equal(table.hand.toAct, "p1"); // SB first postflop
});

// ── Betting rules ────────────────────────────────────────────────────
console.log("betting rules");

test("min-raise enforced; raise-to semantics", () => {
  const t = createTable(P(3), CFG);
  let { table } = startHand(t, mulberry32(6));
  let r = applyAction(table, "p0", { move: "raise", amount: 80 }); // min raise-to = 100
  assert.ok(r.error, "raise below min must fail");
  r = applyAction(table, "p0", { move: "raise", amount: 100 });
  assert.equal(r.table.hand.currentBet, 100);
  // next min raise-to = 150 (raise size 50)
  let r2 = applyAction(r.table, "p1", { move: "raise", amount: 140 });
  assert.ok(r2.error);
  r2 = applyAction(r.table, "p1", { move: "raise", amount: 150 });
  assert.equal(r2.table.hand.currentBet, 150);
});

test("can't check facing a bet; can't call nothing", () => {
  const t = createTable(P(3), CFG);
  const { table } = startHand(t, mulberry32(7));
  assert.ok(applyAction(table, "p0", { move: "check" }).error);
  let { table: t2 } = applyAction(table, "p0", { move: "call" });
  ({ table: t2 } = applyAction(t2, "p1", { move: "call" }));
  assert.ok(applyAction(t2, "p2", { move: "call" }).error); // BB owes nothing
});

test("turn order enforced", () => {
  const t = createTable(P(3), CFG);
  const { table } = startHand(t, mulberry32(8));
  assert.ok(applyAction(table, "p1", { move: "fold" }).error);
  assert.ok(applyAction(table, "px", { move: "fold" }).error);
});

test("short all-in does not reopen betting", () => {
  const t = createTable(P(3), CFG);
  setStack(t, 2, 120); // p2 (will be BB) short
  let { table } = startHand(t, mulberry32(9));
  // p0 raises to 100. p1 folds. p2 (BB, 120 total) goes all-in for 120 — only
  // 20 more, NOT a full raise (full raise would be to 150).
  ({ table } = applyAction(table, "p0", { move: "raise", amount: 100 }));
  ({ table } = applyAction(table, "p1", { move: "fold" }));
  const r = applyAction(table, "p2", { move: "raise", amount: 120 });
  assert.equal(r.error, undefined);
  table = r.table;
  // p0 must respond but cannot re-raise.
  assert.equal(table.hand.toAct, "p0");
  assert.ok(applyAction(table, "p0", { move: "raise", amount: 200 }).error);
  const call = applyAction(table, "p0", { move: "call" });
  assert.equal(call.error, undefined);
  // p2 all-in, p0 the only actor → board runs out to showdown.
  assert.equal(call.table.hand.street, "complete");
  assert.ok(call.table.hand.results);
  assert.ok(chipsBalanced(call.table));
});

test("full raise after a call reopens betting", () => {
  const t = createTable(P(3), CFG);
  let { table } = startHand(t, mulberry32(10));
  ({ table } = applyAction(table, "p0", { move: "call" }));   // p0 limps
  ({ table } = applyAction(table, "p1", { move: "raise", amount: 200 })); // SB raises
  ({ table } = applyAction(table, "p2", { move: "fold" }));
  // p0 already acted but the full raise reopens — p0 may re-raise.
  const r = applyAction(table, "p0", { move: "raise", amount: 350 });
  assert.equal(r.error, undefined);
});

test("bet more than stack rejected; exact all-in allowed", () => {
  const t = createTable(P(2), CFG);
  const { table } = startHand(t, mulberry32(11));
  assert.ok(applyAction(table, "p0", { move: "raise", amount: 6000 }).error);
  const r = applyAction(table, "p0", { move: "raise", amount: 5000 });
  assert.equal(r.error, undefined);
  assert.ok(r.table.hand.allIn["p0"]);
});

// ── Showdowns & side pots ────────────────────────────────────────────
console.log("showdown & side pots");

test("three-way all-in builds side pots and conserves chips", () => {
  const t = createTable(P(3), CFG);
  setStack(t, 0, 1000);
  setStack(t, 1, 3000);
  setStack(t, 2, 5000);
  let { table } = startHand(t, mulberry32(12));
  ({ table } = applyAction(table, "p0", { move: "raise", amount: 1000 })); // all-in 1000
  ({ table } = applyAction(table, "p1", { move: "raise", amount: 3000 })); // all-in 3000
  ({ table } = applyAction(table, "p2", { move: "call" }));                 // covers
  const h = table.hand;
  assert.equal(h.street, "complete");
  assert.equal(h.results.kind, "showdown");
  // Main pot 3000 (1000×3), side pot 4000 (2000×2)
  assert.deepEqual(h.results.pots.map((p) => p.amount), [3000, 4000]);
  assert.deepEqual(h.results.pots[1].winners.every((w) => ["p1", "p2"].includes(w)), true);
  // All chips accounted for
  const total = table.seats.reduce((s, x) => s + x.stack, 0);
  assert.equal(total, 9000);
  assert.ok(chipsBalanced(table));
  // Hole cards revealed for all three
  assert.equal(Object.keys(h.results.revealed).length, 3);
});

test("uncalled excess returns to the bettor via single-eligible pot", () => {
  const t = createTable(P(2), CFG);
  setStack(t, 0, 1000);
  setStack(t, 1, 5000);
  let { table } = startHand(t, mulberry32(13));
  // p0 (button/SB) all-in 1000; p1 shoves 5000 over the top; p0 already all-in.
  ({ table } = applyAction(table, "p0", { move: "raise", amount: 1000 }));
  ({ table } = applyAction(table, "p1", { move: "raise", amount: 5000 }));
  const h = table.hand;
  assert.equal(h.street, "complete");
  // Main pot 2000 contested; p1's extra 4000 comes straight back.
  assert.deepEqual(h.results.pots.map((p) => p.amount), [2000, 4000]);
  assert.deepEqual(h.results.pots[1].winners, ["p1"]);
  assert.ok(chipsBalanced(table));
});

test("split pot divides evenly (board plays)", () => {
  // Force a deterministic chopped board by hand-crafting the hand state.
  const t = createTable(P(2), CFG);
  let { table } = startHand(t, mulberry32(14));
  // Royal-flush board — both hole hands irrelevant. Engine deals via
  // deck.pop(), so the last five entries come out TS,JS,QS (flop), KS, AS.
  table.hand.board = [];
  table.hand.deck = ["2C", "2D", "9H", "8H", "AS", "KS", "QS", "JS", "TS"];
  // run out: call/check to river
  ({ table } = applyAction(table, "p0", { move: "call" }));
  ({ table } = applyAction(table, "p1", { move: "check" }));
  for (let street = 0; street < 3; street++) {
    ({ table } = applyAction(table, table.hand.toAct, { move: "check" }));
    ({ table } = applyAction(table, table.hand.toAct, { move: "check" }));
  }
  const h = table.hand;
  assert.equal(h.results.kind, "showdown");
  assert.equal(h.results.pots[0].winners.length, 2);
  assert.equal(table.seats[0].stack, 5000);
  assert.equal(table.seats[1].stack, 5000);
  assert.ok(chipsBalanced(table));
});

// ── Session management ───────────────────────────────────────────────
console.log("session management");

test("rebuy queues during a hand, lands at next deal", () => {
  const t = createTable(P(2), CFG);
  let { table } = startHand(t, mulberry32(15));
  ({ table } = addChips(table, "p0", 5000));
  const seat = table.seats.find((s) => s.id === "p0");
  assert.equal(seat.pendingChips, 5000);
  assert.equal(seat.stack, 4975); // unchanged mid-hand (minus SB)
  ({ table } = applyAction(table, "p0", { move: "fold" }));
  ({ table } = startHand(table, mulberry32(16)));
  const seat2 = table.seats.find((s) => s.id === "p0");
  assert.equal(seat2.pendingChips, 0);
  assert.ok(seat2.stack > 5000);
  assert.ok(chipsBalanced(table));
});

test("busted player can't be dealt in until rebuy; sit-out respected", () => {
  const t = createTable(P(3), CFG);
  setStack(t, 0, 0);
  assert.ok(canStartHand(t));
  const { table } = startHand(t, mulberry32(17));
  assert.ok(!table.hand.dealtIn.includes("p0"));
  const t2 = setSittingOut(table, "p1", true).table;
  assert.ok(t2.seats.find((s) => s.id === "p1").sittingOut);
});

test("seat mid-session + cash out freezes settlement rows", () => {
  let t = createTable(P(2), CFG);
  ({ table: t } = seatPlayer(t, { id: "p9", name: "Late Joiner" }, 5000));
  assert.equal(t.seats.length, 3);
  ({ table: t } = cashOutPlayer(t, "p9"));
  assert.equal(t.seats.length, 2);
  assert.equal(t.cashedOut.length, 1);
  assert.equal(t.cashedOut[0].finalChips, 5000);
  const rows = settlementRows(t);
  assert.equal(rows.length, 3);
  assert.equal(rows.reduce((s, r) => s + r.buyInChips, 0), 15000);
  assert.ok(chipsBalanced(t));
});

test("cash out blocked mid-hand for live player", () => {
  const t = createTable(P(2), CFG);
  const { table } = startHand(t, mulberry32(18));
  assert.ok(cashOutPlayer(table, "p0").error);
});

// ── Redaction ────────────────────────────────────────────────────────
console.log("redaction");

test("viewers see only their own hole cards; no deck ever", () => {
  const t = createTable(P(3), CFG);
  const { table } = startHand(t, mulberry32(19));
  const v0 = redactFor(table, "p0");
  const v1 = redactFor(table, "p1");
  const spec = redactFor(table, "spectator");
  assert.deepEqual(v0.hand.yourHole, table.hand.holes["p0"]);
  assert.deepEqual(v1.hand.yourHole, table.hand.holes["p1"]);
  assert.equal(spec.hand.yourHole, null);
  const json = JSON.stringify([v0, v1, spec]);
  // No view contains another player's hole cards or the deck.
  for (const c of table.hand.deck.slice(0, 5)) assert.ok(!json.includes(`"${c}"`) || table.hand.board.includes(c), `deck card ${c} leaked`);
  assert.ok(!JSON.stringify(v0).includes(JSON.stringify(table.hand.holes["p1"])));
});

test("showdown reveals live hands to everyone", () => {
  const t = createTable(P(2), CFG);
  let { table } = startHand(t, mulberry32(20));
  ({ table } = applyAction(table, "p0", { move: "raise", amount: 5000 }));
  ({ table } = applyAction(table, "p1", { move: "call" }));
  const spec = redactFor(table, "spectator");
  assert.equal(Object.keys(spec.hand.results.revealed).length, 2);
});

// ── Fuzz: random games never lose chips, always terminate ────────────
console.log("fuzz");

test("500 random hands: chips conserved, hands terminate", () => {
  const rng = mulberry32(42);
  for (let g = 0; g < 25; g++) {
    const n = 2 + Math.floor(rng() * 7);
    let table = createTable(P(n), CFG);
    for (let handCount = 0; handCount < 20; handCount++) {
      if (!canStartHand(table)) break;
      const res = startHand(table, rng);
      if (res.error) break;
      table = res.table;
      let guard = 0;
      while (table.hand && !table.hand.results) {
        assert.ok(guard++ < 500, "hand did not terminate");
        const pid = table.hand.toAct;
        assert.ok(pid, "no one to act in live hand");
        const moves = ["fold", "check", "call", "raise"];
        const move = moves[Math.floor(rng() * moves.length)];
        const myCommitted = table.hand.committed[pid] || 0;
        const stack = table.seats.find((s) => s.id === pid).stack;
        const amount = Math.min(
          myCommitted + stack,
          table.hand.currentBet + table.bb * (1 + Math.floor(rng() * 6))
        );
        const r = applyAction(table, pid, { move, amount });
        if (!r.error) {
          table = r.table;
          assert.ok(chipsBalanced(table), "chips out of balance");
        } else {
          // Illegal random move — try a guaranteed-legal fallback.
          const owe = (table.hand.currentBet || 0) - myCommitted;
          const fb = owe > 0 ? "call" : "check";
          const r2 = applyAction(table, pid, { move: fb });
          assert.equal(r2.error, undefined, `fallback ${fb} failed: ${r2.error}`);
          table = r2.table;
          assert.ok(chipsBalanced(table), "chips out of balance");
        }
      }
      // Occasionally rebuy a random busted player.
      for (const s of table.seats) {
        if (s.stack === 0 && rng() < 0.5) {
          table = addChips(table, s.id, CFG.startingStack).table;
        }
      }
    }
    const rows = settlementRows(table);
    const bought = rows.reduce((s, r) => s + r.buyInChips, 0);
    const held = rows.reduce((s, r) => s + r.finalChips, 0);
    assert.equal(bought, held, "session settlement out of balance");
  }
});

console.log(`\n${passed} tests passed`);
