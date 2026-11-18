// Pure money math for the poker cash tracker. No React, no I/O — testable.
//
// Ratio shape: { chips, money } meaning `chips` chips are worth `money` units
// of currency. moneyPerChip = money / chips.

import { round2 } from "../../utils/settlement.js";

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

export { round2 };
