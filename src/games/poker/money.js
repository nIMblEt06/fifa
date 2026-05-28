// Pure money math for the poker cash tracker. No React, no I/O — testable.
//
// Ratio shape: { chips, money } meaning `chips` chips are worth `money` units
// of currency. moneyPerChip = money / chips.

export function moneyPerChip(ratio) {
  if (!ratio || !(ratio.chips > 0)) return 0;
  return ratio.money / ratio.chips;
}

// Net money per player = (finalChips − totalBuyInChips) × moneyPerChip.
// `players` is [{ id, name, buyInChips, finalChips }].
// Returns [{ id, name, buyInChips, finalChips, netChips, net }].
export function computeNets(players, ratio) {
  const mpc = moneyPerChip(ratio);
  return players.map((p) => {
    const buyInChips = Number(p.buyInChips) || 0;
    const finalChips = Number(p.finalChips) || 0;
    const netChips = finalChips - buyInChips;
    return {
      id: p.id,
      name: p.name,
      buyInChips,
      finalChips,
      netChips,
      net: round2(netChips * mpc),
    };
  });
}

// Sum of all nets. Should be ~0 for a zero-sum game; small rounding drift OK.
export function imbalance(nets) {
  return round2(nets.reduce((s, n) => s + n.net, 0));
}

export function isBalanced(nets, tolerance = 1) {
  return Math.abs(imbalance(nets)) <= tolerance;
}

// Greedy minimal-transfer settlement. Largest debtor pays largest creditor.
// Input nets: [{ id, name, net }]. Negative net = debtor (owes money),
// positive net = creditor (is owed money).
// Returns [{ fromId, fromName, toId, toName, amount }] with amount > 0.
export function computeSettlement(nets) {
  const EPS = 0.005;
  const debtors = nets
    .filter((n) => n.net < -EPS)
    .map((n) => ({ id: n.id, name: n.name, amount: -n.net }))
    .sort((a, b) => b.amount - a.amount);
  const creditors = nets
    .filter((n) => n.net > EPS)
    .map((n) => ({ id: n.id, name: n.name, amount: n.net }))
    .sort((a, b) => b.amount - a.amount);

  const transfers = [];
  let di = 0;
  let ci = 0;
  while (di < debtors.length && ci < creditors.length) {
    const d = debtors[di];
    const c = creditors[ci];
    const pay = round2(Math.min(d.amount, c.amount));
    if (pay > EPS) {
      transfers.push({
        fromId: d.id,
        fromName: d.name,
        toId: c.id,
        toName: c.name,
        amount: pay,
      });
    }
    d.amount = round2(d.amount - pay);
    c.amount = round2(c.amount - pay);
    if (d.amount <= EPS) di++;
    if (c.amount <= EPS) ci++;
  }
  return transfers;
}

export function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
