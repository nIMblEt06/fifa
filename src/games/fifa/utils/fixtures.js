function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Generate group-stage fixtures where each player plays exactly `matchesPerPlayer` matches
 * and no two players play each other more than once.
 *
 * Uses backtracking to guarantee a valid schedule if one exists. Returns []
 * if the request is impossible (e.g. matchesPerPlayer > playerCount - 1).
 */
export function generateFixtures(playerCount, matchesPerPlayer = 4) {
  if (playerCount < 2) return [];
  if (matchesPerPlayer > playerCount - 1) return [];
  const totalMatches = Math.floor((playerCount * matchesPerPlayer) / 2);
  if (!Number.isInteger((playerCount * matchesPerPlayer) / 2)) return [];

  const matchCounts = new Array(playerCount).fill(0);
  const usedPairs = new Set();
  const fixtures = [];

  const allPairings = [];
  for (let i = 0; i < playerCount; i++) {
    for (let j = i + 1; j < playerCount; j++) {
      allPairings.push([i, j]);
    }
  }

  function backtrack() {
    if (fixtures.length === totalMatches) return true;

    const candidates = shuffle(
      allPairings.filter(([a, b]) => {
        const key = `${a}-${b}`;
        return (
          !usedPairs.has(key) &&
          matchCounts[a] < matchesPerPlayer &&
          matchCounts[b] < matchesPerPlayer
        );
      })
    );

    for (const [a, b] of candidates) {
      const key = `${a}-${b}`;
      const home = Math.random() < 0.5 ? a : b;
      const away = home === a ? b : a;
      fixtures.push({ home, away });
      usedPairs.add(key);
      matchCounts[a]++;
      matchCounts[b]++;

      if (backtrack()) return true;

      fixtures.pop();
      usedPairs.delete(key);
      matchCounts[a]--;
      matchCounts[b]--;
    }

    return false;
  }

  backtrack();
  return spreadFixtures(fixtures, playerCount);
}

/**
 * Re-order a set of fixtures so consecutive matches share as few players as possible.
 * Greedy: at each slot, pick the remaining match whose less-rested player has the most
 * rest. Tiebreak by playing more-active players sooner so they don't get stranded at
 * the end. Players with the same number of remaining matches go in random order.
 */
function spreadFixtures(fixtures, playerCount) {
  if (fixtures.length <= 1) return fixtures;

  const remaining = shuffle(fixtures); // base randomness within tiers
  const ordered = [];
  const lastPlayed = new Array(playerCount).fill(-Infinity);
  const remainingCount = new Array(playerCount).fill(0);
  for (const f of remaining) {
    remainingCount[f.home]++;
    remainingCount[f.away]++;
  }

  while (remaining.length) {
    const slot = ordered.length;
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const m = remaining[i];
      const restA = slot - lastPlayed[m.home];
      const restB = slot - lastPlayed[m.away];
      const minRest = Math.min(restA, restB);
      const busy = remainingCount[m.home] + remainingCount[m.away];
      // minRest dominates, busyness is a soft tiebreak.
      const score = minRest * 10000 + busy;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    const picked = remaining.splice(bestIdx, 1)[0];
    lastPlayed[picked.home] = slot;
    lastPlayed[picked.away] = slot;
    remainingCount[picked.home]--;
    remainingCount[picked.away]--;
    ordered.push(picked);
  }

  return ordered;
}

/**
 * Randomly assign teams from the pool to players.
 */
export function assignTeams(players, teamPool) {
  const shuffled = shuffle(teamPool);
  return players.map((name, i) => ({
    name,
    team: shuffled[i % shuffled.length],
  }));
}

/**
 * Compute standings from completed group-stage matches.
 */
export function computeStandings(players, matches) {
  const stats = players.map((p, i) => ({
    playerIndex: i,
    name: p.name,
    team: p.team,
    played: 0, won: 0, drawn: 0, lost: 0,
    gf: 0, ga: 0, gd: 0, pts: 0,
  }));

  for (const m of matches) {
    if (!m.completed) continue;
    const home = stats[m.home];
    const away = stats[m.away];

    home.played++;
    away.played++;
    home.gf += m.homeScore;
    home.ga += m.awayScore;
    away.gf += m.awayScore;
    away.ga += m.homeScore;

    if (m.homeScore > m.awayScore) {
      home.won++; home.pts += 3; away.lost++;
    } else if (m.homeScore < m.awayScore) {
      away.won++; away.pts += 3; home.lost++;
    } else {
      home.drawn++; away.drawn++;
      home.pts += 1; away.pts += 1;
    }
  }

  for (const s of stats) s.gd = s.gf - s.ga;
  stats.sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf);
  return stats;
}
