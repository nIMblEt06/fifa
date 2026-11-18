// Plain node:assert tests for the poker money math + shared settlement.
// Run: node src/games/poker/money.test.mjs
import assert from "node:assert/strict";
import {
  moneyPerChip,
  computeNets,
  imbalance,
  isBalanced,
  round2,
} from "./money.js";
import { computeSettlement } from "../../utils/settlement.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log("  ok -", name);
}

test("moneyPerChip: ratio math, zero-safe", () => {
  assert.equal(moneyPerChip({ chips: 5000, money: 250 }), 0.05);
  assert.equal(moneyPerChip({ chips: 100, money: 100 }), 1);
  assert.equal(moneyPerChip({ chips: 0, money: 250 }), 0);
  assert.equal(moneyPerChip(null), 0);
});

test("computeNets: net = (final − buyIn) × moneyPerChip", () => {
  const nets = computeNets(
    [
      { id: "a", name: "A", buyInChips: 5000, finalChips: 10000 },
      { id: "b", name: "B", buyInChips: 5000, finalChips: 0 },
      { id: "c", name: "C", buyInChips: 10000, finalChips: 10000 },
    ],
    { chips: 5000, money: 250 }
  );
  assert.deepEqual(
    nets.map((n) => n.net),
    [250, -250, 0]
  );
  assert.equal(imbalance(nets), 0);
  assert.equal(isBalanced(nets), true);
});

test("round2 rounds half-up with float noise protection", () => {
  assert.equal(round2(0.005), 0.01);
  assert.equal(round2(2.675), 2.68);
  assert.equal(round2(1.005), 1.01);
});

test("computeSettlement: minimal transfers, both sides drained to zero", () => {
  const transfers = computeSettlement([
    { id: "a", name: "A", net: -300 },
    { id: "b", name: "B", net: -100 },
    { id: "c", name: "C", net: 250 },
    { id: "d", name: "D", net: 150 },
  ]);
  // Largest debtor (A) drains the largest creditor (C) fully, then spills to D.
  assert.deepEqual(transfers, [
    { fromId: "a", fromName: "A", toId: "c", toName: "C", amount: 250 },
    { fromId: "a", fromName: "A", toId: "d", toName: "D", amount: 50 },
    { fromId: "b", fromName: "B", toId: "d", toName: "D", amount: 100 },
  ]);
});

test("computeSettlement: largest debtor spans multiple creditors", () => {
  const transfers = computeSettlement([
    { id: "a", name: "A", net: -500 },
    { id: "b", name: "B", net: 200 },
    { id: "c", name: "C", net: 300 },
  ]);
  assert.deepEqual(transfers, [
    { fromId: "a", fromName: "A", toId: "c", toName: "C", amount: 300 },
    { fromId: "a", fromName: "A", toId: "b", toName: "B", amount: 200 },
  ]);
});

test("computeSettlement: cents settle, dust is dropped", () => {
  const transfers = computeSettlement([
    { id: "a", name: "A", net: -0.01 },
    { id: "b", name: "B", net: 0.01 },
    { id: "c", name: "C", net: -0.004 },
    { id: "d", name: "D", net: 0.004 },
  ]);
  assert.deepEqual(transfers, [
    { fromId: "a", fromName: "A", toId: "b", toName: "B", amount: 0.01 },
  ]);
});

test("computeSettlement: everyone even → no transfers", () => {
  assert.deepEqual(computeSettlement([{ id: "a", name: "A", net: 0 }]), []);
});

test("settlement is exact for a fuzz of random zero-sum rooms", () => {
  let rngState = 42;
  const rng = () => {
    rngState = (rngState * 1103515245 + 12345) % 2147483648;
    return rngState / 2147483648;
  };
  for (let iter = 0; iter < 500; iter++) {
    const players = [];
    let pool = Math.round(rng() * 10000) / 100;
    for (let i = 0; i < 6; i++) {
      const take = Math.round(rng() * pool * 100) / 100;
      players.push({ id: `p${i}`, name: `P${i}`, net: take });
      pool = Math.round((pool - take) * 100) / 100;
    }
    // Last player takes whatever remains, keeping the room zero-sum.
    players.push({ id: "p6", name: "P6", net: -players.reduce((s, p) => s + p.net, 0) });

    const transfers = computeSettlement(players);
    const paid = Math.round(transfers.reduce((s, t) => s + t.amount, 0) * 100) / 100;
    const owed = Math.round(
      players.filter((p) => p.net < 0).reduce((s, p) => s - p.net, 0) * 100
    ) / 100;
    assert.equal(paid, owed, "transfers must exactly cover all debt");
    for (const p of players) {
      const through = Math.round(
        transfers.reduce(
          (s, t) => s + (t.fromId === p.id ? -t.amount : t.toId === p.id ? t.amount : 0),
          0
        ) * 100
      ) / 100;
      assert.ok(
        Math.abs(through - p.net) < 0.011,
        `player ${p.id} settles to their net (through ${through}, net ${p.net})`
      );
    }
  }
});

console.log(`\n${passed} passed`);
