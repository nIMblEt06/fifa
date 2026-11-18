// Shared net-money → transfer math for poker and FIFA betting.
// Pure, no React, no I/O.

export function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
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
