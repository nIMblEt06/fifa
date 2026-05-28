// Pure helpers for multi-group group stages and seeded single-elimination
// knockout brackets (with byes). No React, no I/O — easy to test in isolation.
//
// Conventions:
//  - A "player index" is the index into FifaApp's global players[] array.
//  - Match objects share the app shape: {id, home, away, homeScore, awayScore, completed}.
//    home/away are player indexes, or null for an unfilled / bye slot.

export const GROUP_LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function defaultShuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Smallest power of two >= n (n >= 1). */
export function nextPow2(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/**
 * Compute group sizes for N players. numGroups = floor(N/3); sizes are as even
 * as possible, each 3 or 4, differing by at most 1, summing to N.
 * Examples: 6→[3,3], 7→[4,3], 8→[4,4], 9→[3,3,3], 10→[4,3,3], 11→[4,4,3],
 *           12→[3,3,3,3], 13→[4,3,3,3], 16→[4,3,3,3,3].
 * Returns [] if N < 6 (single-group territory).
 */
export function groupSizes(n) {
  if (n < 6) return [];
  const numGroups = Math.floor(n / 3);
  const base = Math.floor(n / numGroups);
  const extra = n - base * numGroups; // this many groups get one more
  const sizes = [];
  for (let i = 0; i < numGroups; i++) {
    sizes.push(base + (i < extra ? 1 : 0)); // larger groups first
  }
  return sizes;
}

/**
 * Split player indexes into groups (sizes from groupSizes). Players are dealt
 * round-robin from a shuffled order, so groups are random and balanced.
 *
 * If `teamByIndex` is provided (map: playerIndex → team name), we try up to
 * 50 random shuffles and keep the assignment that minimises the number of
 * intra-group same-team pairs (best-effort: 0 if possible, else as few as
 * we can find). Multiple players can share a team — when there aren't enough
 * groups to separate them all, some duplicates remain.
 *
 * Returns [{ id:"A", playerIndexes:[...], matches:[] }].
 */
export function splitIntoGroups(playerIndexes, shuffle = defaultShuffle, rounds = 1, teamByIndex = null) {
  const n = playerIndexes.length;
  const sizes = groupSizes(n);
  if (sizes.length === 0) return [];

  const deal = (order) => {
    const gs = sizes.map((_, i) => ({ id: GROUP_LABELS[i], playerIndexes: [], matches: [] }));
    let cursor = 0;
    while (cursor < order.length) {
      for (let g = 0; g < gs.length && cursor < order.length; g++) {
        if (gs[g].playerIndexes.length < sizes[g]) {
          gs[g].playerIndexes.push(order[cursor++]);
        }
      }
    }
    return gs;
  };

  // Count same-team pairs that landed in the same group. Lower is better.
  const clashScore = (gs) => {
    if (!teamByIndex) return 0;
    let score = 0;
    for (const g of gs) {
      const idxs = g.playerIndexes;
      for (let i = 0; i < idxs.length; i++) {
        for (let j = i + 1; j < idxs.length; j++) {
          const ta = teamByIndex[idxs[i]];
          const tb = teamByIndex[idxs[j]];
          if (ta && tb && ta === tb) score++;
        }
      }
    }
    return score;
  };

  // Theoretical minimum: for each team T with k players, at least
  // max(0, k - numGroups) duplicates are unavoidable in the same group
  // (sum of C(c, 2) over team-group buckets; cheap lower bound via pigeonhole).
  const lowerBound = (() => {
    if (!teamByIndex) return 0;
    const counts = new Map();
    for (const i of playerIndexes) {
      const t = teamByIndex[i];
      if (!t) continue;
      counts.set(t, (counts.get(t) || 0) + 1);
    }
    const G = sizes.length;
    let lb = 0;
    for (const k of counts.values()) {
      const base = Math.floor(k / G);
      const extra = k - base * G;
      // `extra` groups hold (base+1) players of this team, the rest hold `base`.
      lb += extra * (base * (base + 1)) / 2 + (G - extra) * (base * (base - 1)) / 2;
    }
    return lb;
  })();

  let groups;
  let best = null;
  let bestScore = Infinity;
  const attempts = teamByIndex ? 50 : 1;
  for (let a = 0; a < attempts; a++) {
    const candidate = deal(shuffle(playerIndexes));
    const score = clashScore(candidate);
    if (score < bestScore) { best = candidate; bestScore = score; }
    if (bestScore <= lowerBound) break; // can't do better
  }
  groups = best;

  // Round-robin fixtures within each group. `rounds === 2` plays a return
  // leg with home/away swapped, so every pair plays twice.
  const legs = rounds === 2 ? 2 : 1;
  for (const group of groups) {
    const idxs = group.playerIndexes;
    let m = 0;
    for (let i = 0; i < idxs.length; i++) {
      for (let j = i + 1; j < idxs.length; j++) {
        // First leg: randomise home/away.
        const firstHome = Math.random() < 0.5 ? idxs[i] : idxs[j];
        const firstAway = firstHome === idxs[i] ? idxs[j] : idxs[i];
        group.matches.push({
          id: `group-${group.id}-${m++}`,
          home: firstHome,
          away: firstAway,
          homeScore: 0,
          awayScore: 0,
          completed: false,
        });
        if (legs === 2) {
          // Return leg: swap home and away so every player gets one of each.
          group.matches.push({
            id: `group-${group.id}-${m++}`,
            home: firstAway,
            away: firstHome,
            homeScore: 0,
            awayScore: 0,
            completed: false,
          });
        }
      }
    }
  }

  return groups;
}

/**
 * Seed qualifiers globally across groups.
 * `groupStandings` is an array (one per group, in group order) of that group's
 * standings (already sorted best-first by computeStandings).
 * Takes the top `qualifiersPerGroup` from each group, then orders them by
 * finishing position (all winners, then all runners-up, …), breaking ties by
 * pts, then gd, then gf. Returns an array of player indexes, best seed first.
 */
export function seedQualifiers(groupStandings, qualifiersPerGroup) {
  const pool = [];
  groupStandings.forEach((standings) => {
    for (let pos = 0; pos < qualifiersPerGroup && pos < standings.length; pos++) {
      pool.push({ position: pos, ...standings[pos] });
    }
  });
  pool.sort(
    (a, b) =>
      a.position - b.position ||
      b.pts - a.pts ||
      b.gd - a.gd ||
      b.gf - a.gf
  );
  return pool.map((p) => p.playerIndex);
}

/**
 * Standard seed-pairing order for a bracket of size `size` (power of two).
 * Returns an array of length `size` of seed numbers (1-based) such that
 * consecutive pairs are the first-round matchups: 1vN, then the slot that meets
 * the 1-side winner, etc. e.g. size 4 → [1,4,3,2] (pairs 1v4, 3v2).
 */
export function seedOrder(size) {
  let order = [1];
  while (order.length < size) {
    const n = order.length * 2;
    const next = [];
    for (const s of order) {
      next.push(s);
      next.push(n + 1 - s);
    }
    order = next;
  }
  return order;
}

const ROUND_NAMES = {
  2: "Final",
  4: "Semi-Finals",
  8: "Quarter-Finals",
  16: "Round of 16",
  32: "Round of 32",
};

export function roundName(slots) {
  return ROUND_NAMES[slots] || `Round of ${slots}`;
}

/**
 * Build the first knockout round from seeded qualifier player indexes.
 * `qualifierSeeds[0]` is the best seed. Bracket size = nextPow2(Q). The top
 * (size - Q) seeds receive byes (their first-round opponent slot is null).
 *
 * Returns { rounds: [{ name, matches:[...] }] } with only the first round
 * populated; subsequent rounds are appended as earlier rounds complete.
 *
 * Where a first-round match would be a same-group rematch and a swap with
 * another first-round match keeps both seed-balanced enough, slots are swapped
 * to avoid the rematch. `groupOf` maps player index → group id (optional).
 */
export function buildKnockout(qualifierSeeds, groupOf = null) {
  const Q = qualifierSeeds.length;
  if (Q < 2) return { rounds: [] };
  const size = nextPow2(Q);
  const order = seedOrder(size); // seed numbers (1-based) in bracket-slot order

  // Map slot → player index (or null for a missing seed = bye opponent).
  // Seed s (1-based) maps to qualifierSeeds[s-1] if it exists, else null.
  const slotPlayers = order.map((seed) => qualifierSeeds[seed - 1] ?? null);

  // First-round matches are consecutive slot pairs.
  let pairs = [];
  for (let i = 0; i < slotPlayers.length; i += 2) {
    pairs.push([slotPlayers[i], slotPlayers[i + 1]]);
  }

  // Best-effort: avoid same-group first-round matchups by swapping the away
  // player between two real (non-bye) pairs when it removes a clash without
  // creating a new one.
  if (groupOf) {
    const clash = (h, a) => h != null && a != null && groupOf[h] === groupOf[a];
    for (let i = 0; i < pairs.length; i++) {
      if (!clash(pairs[i][0], pairs[i][1])) continue;
      for (let j = i + 1; j < pairs.length; j++) {
        const [hi, ai] = pairs[i];
        const [hj, aj] = pairs[j];
        if (ai == null || aj == null) continue;
        // Try swapping the away players.
        if (!clash(hi, aj) && !clash(hj, ai)) {
          pairs[i] = [hi, aj];
          pairs[j] = [hj, ai];
          break;
        }
      }
    }
  }

  const matches = pairs.map((p, i) => makeKnockoutMatch(size, 0, i, p[0], p[1]));
  return { rounds: [{ name: roundName(size), matches }] };
}

/** Construct one knockout match. Auto-completes byes (one slot null). */
export function makeKnockoutMatch(bracketSize, roundIdx, matchIdx, home, away) {
  const isBye = (home == null) !== (away == null); // exactly one filled
  return {
    id: `ko-${bracketSize}-r${roundIdx}-m${matchIdx}`,
    home,
    away,
    homeScore: 0,
    awayScore: 0,
    completed: isBye, // byes resolve automatically; both-null stays incomplete
    bye: isBye,
  };
}

/** Winner player index of a completed match (null if not resolvable). */
export function matchWinner(m) {
  if (!m || !m.completed) return null;
  if (m.bye) return m.home != null ? m.home : m.away;
  if (m.homeScore > m.awayScore) return m.home;
  if (m.awayScore > m.homeScore) return m.away;
  return null; // draw — shouldn't happen in knockout
}

/**
 * Given completed `rounds`, if the last round is fully complete and has more
 * than one match, build the next round from the winners and return a NEW rounds
 * array. Otherwise returns the same rounds array (possibly with a champion-less
 * single Final left to be played). Returns { rounds, champion }.
 */
export function advanceKnockout(rounds) {
  if (!rounds.length) return { rounds, champion: null };
  const last = rounds[rounds.length - 1];
  const allDone = last.matches.every((m) => m.completed);
  if (!allDone) return { rounds, champion: null };

  // If the last round is the Final (single match), crown the champion.
  if (last.matches.length === 1) {
    return { rounds, champion: matchWinner(last.matches[0]) };
  }

  // Already built the next round? (idempotent guard)
  // Build winners list and the next round.
  const winners = last.matches.map(matchWinner);
  const nextSlots = last.matches.length; // halves the slot count
  const size = nextSlots; // number of teams in next round = number of prev matches
  const nextMatches = [];
  for (let i = 0; i < winners.length; i += 2) {
    nextMatches.push(
      makeKnockoutMatch(
        bracketSizeOf(rounds),
        rounds.length,
        i / 2,
        winners[i],
        winners[i + 1]
      )
    );
  }
  const nextRound = { name: roundName(size), matches: nextMatches };
  const newRounds = [...rounds, nextRound];

  // If the freshly built round is the Final and it auto-resolved (can't here,
  // no byes downstream), fall through; champion handled on next completion.
  return { rounds: newRounds, champion: null };
}

function bracketSizeOf(rounds) {
  // First round match count * 2 = bracket size.
  return rounds[0].matches.length * 2;
}
