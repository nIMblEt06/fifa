// Pari-mutuel betting math for FIFA per-match markets. Pure, testable — no I/O.
//
// A market holds bets: [{ memberId, outcomeId, stake }]. Given the winning
// outcome, the pooled stakes on the LOSING outcomes are distributed to the
// winners in proportion to their own stake (a stake-weighted share of the
// losing pool). Returns aggregated nets per member: [{ memberId, net }] where
// net > 0 is a creditor (won money) and net < 0 a debtor (lost their stake);
// the two sides sum to ~0 (tiny rounding drift is folded server-side).
//
// Returns [] when the market can't pay out — no stake on the winning side, or
// no stake on any losing side (one-sided) — so callers send NO transaction.

export function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function computeMarketNets(bets, winningOutcomeId) {
  const valid = (bets || []).filter(
    (b) => b && b.memberId != null && b.outcomeId != null && Number(b.stake) > 0
  );
  if (valid.length === 0 || winningOutcomeId == null) return [];

  let winPool = 0;
  let losePool = 0;
  for (const b of valid) {
    if (String(b.outcomeId) === String(winningOutcomeId)) winPool += Number(b.stake);
    else losePool += Number(b.stake);
  }
  // Need stake on BOTH the winning side and at least one losing side, else void.
  if (winPool <= 0 || losePool <= 0) return [];

  // Aggregate per member so one person with several bets nets out to one row.
  const byMember = new Map();
  for (const b of valid) {
    const key = String(b.memberId);
    const won = String(b.outcomeId) === String(winningOutcomeId);
    const delta = won ? (losePool * Number(b.stake)) / winPool : -Number(b.stake);
    byMember.set(key, (byMember.get(key) || 0) + delta);
  }

  return [...byMember.entries()]
    .map(([memberId, net]) => ({ memberId, net: round2(net) }))
    .filter((p) => Math.abs(p.net) > 0.005);
}

// Winning outcome id for the built-in Match Result market, from the final
// score. Returns 'home' | 'away' | 'draw'.
export function resultOutcomeFromScore(match) {
  const h = Number(match?.homeScore) || 0;
  const a = Number(match?.awayScore) || 0;
  if (h > a) return "home";
  if (a > h) return "away";
  return "draw";
}

// Sum of all stakes in a market (for display).
export function marketPool(bets) {
  return round2(
    (bets || []).reduce((s, b) => s + (Number(b?.stake) > 0 ? Number(b.stake) : 0), 0)
  );
}

// Stake total per outcome id, e.g. { home: 300, away: 150 } (for display).
export function poolByOutcome(bets) {
  const out = {};
  for (const b of bets || []) {
    if (!(Number(b?.stake) > 0) || b.outcomeId == null) continue;
    const k = String(b.outcomeId);
    out[k] = round2((out[k] || 0) + Number(b.stake));
  }
  return out;
}
