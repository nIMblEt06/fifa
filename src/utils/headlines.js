// Auto-generated trash-talk headlines + Wall of Shame metrics.
// Inputs: players[], allMatches (group + knockout, with .completed/.homeScore/.awayScore).

const VERBS = {
  routs: ["DESTROY", "HUMBLE", "DISMANTLE", "DISMISS", "PUMMEL", "EVISCERATE"],
  wins:  ["EDGE", "BEAT", "TOPPLE", "OUTGUN", "SEE OFF"],
  draws: ["DRAW WITH", "SHARE SPOILS WITH", "CANCEL OUT"],
};

function pick(arr, seed = Math.random()) {
  return arr[Math.floor(seed * arr.length) % arr.length];
}

function nameOf(players, idx) {
  return (players[idx]?.name || "?").toUpperCase();
}

function teamOf(players, idx) {
  return (players[idx]?.team || "").toUpperCase();
}

export function matchHeadline(match, players) {
  if (!match || !match.completed) return null;
  const h = match.homeScore;
  const a = match.awayScore;
  const diff = Math.abs(h - a);
  const home = nameOf(players, match.home);
  const away = nameOf(players, match.away);

  if (h === a) {
    return `${pick(VERBS.draws, h * 0.13 + a * 0.07)} — ${home} ${h}–${a} ${away}`;
  }
  const winner = h > a ? home : away;
  const loser  = h > a ? away : home;
  const wScore = Math.max(h, a);
  const lScore = Math.min(h, a);
  const verb = pick(diff >= 4 ? VERBS.routs : VERBS.wins, h * 0.31 + a * 0.17);

  if (diff >= 5) return `MASSACRE — ${winner} ${verb} ${loser} ${wScore}–${lScore}`;
  if (diff >= 4) return `${winner} ${verb} ${loser} ${wScore}–${lScore} · BRUTAL`;
  if (lScore === 0 && wScore >= 3) return `CLEAN SHEET — ${winner} SHUT OUT ${loser} ${wScore}–0`;
  return `${winner} ${verb} ${loser} ${wScore}–${lScore}`;
}

// Build the marquee list — pulls from completed matches plus situational quips.
export function buildHeadlines(players, allMatches, standings) {
  const items = [];
  if (!players.length) return items;

  // Recent results (last 6, newest last)
  const completed = allMatches.filter((m) => m && m.completed);
  for (const m of completed.slice(-6)) {
    const h = matchHeadline(m, players);
    if (h) items.push(h);
  }

  // Per-player narratives from standings
  if (standings && standings.length) {
    const top = standings[0];
    const bot = standings[standings.length - 1];
    if (top && top.played > 0) {
      items.push(`${top.name.toUpperCase()} TOPS THE TABLE · ${top.pts} PTS · GD ${top.gd >= 0 ? "+" : ""}${top.gd}`);
    }
    if (bot && bot.played > 0 && bot !== top) {
      items.push(`${bot.name.toUpperCase()} ROOTED TO THE BOTTOM · ${bot.lost} DEFEATS`);
    }

    // Worst conceder
    const worst = [...standings].sort((a, b) => b.ga - a.ga)[0];
    if (worst && worst.ga >= 5) {
      items.push(`${worst.name.toUpperCase()} HAS SHIPPED ${worst.ga} GOALS · DEFENCE OPTIONAL`);
    }

    // Goal machine
    const sniper = [...standings].sort((a, b) => b.gf - a.gf)[0];
    if (sniper && sniper.gf >= 6) {
      items.push(`${sniper.name.toUpperCase()} ON ${sniper.gf} GOALS · ${teamOf(players, sniper.playerIndex)} ARE FLYING`);
    }
  }

  // Empty-state filler
  if (!items.length) {
    items.push("AWAITING FIRST WHISTLE");
    items.push("SHARE THE ROOM CODE TO INVITE THE COUCH");
    items.push("LOSER WASHES THE DISHES");
  }

  return items;
}

// Wall of Shame — surfaces individual ignominy.
export function buildShame(players, allMatches) {
  if (!players.length) return [];
  const completed = allMatches.filter((m) => m && m.completed);
  if (!completed.length) return [];

  const shame = [];

  // Heaviest defeat
  let worst = null;
  for (const m of completed) {
    const diff = Math.abs(m.homeScore - m.awayScore);
    if (m.homeScore === m.awayScore) continue;
    if (!worst || diff > Math.abs(worst.homeScore - worst.awayScore)) worst = m;
  }
  if (worst) {
    const loserIdx = worst.homeScore > worst.awayScore ? worst.away : worst.home;
    const winnerIdx = worst.homeScore > worst.awayScore ? worst.home : worst.away;
    const ws = Math.max(worst.homeScore, worst.awayScore);
    const ls = Math.min(worst.homeScore, worst.awayScore);
    shame.push({
      label: "HEAVIEST DEFEAT",
      victim: nameOf(players, loserIdx),
      detail: `${ls}–${ws} vs ${nameOf(players, winnerIdx)}`,
    });
  }

  // Most goals conceded total
  const conceded = players.map((_, i) => ({ i, n: 0 }));
  for (const m of completed) {
    conceded[m.home].n += m.awayScore;
    conceded[m.away].n += m.homeScore;
  }
  conceded.sort((a, b) => b.n - a.n);
  if (conceded[0]?.n > 0) {
    shame.push({
      label: "LEAKY DEFENCE",
      victim: nameOf(players, conceded[0].i),
      detail: `${conceded[0].n} CONCEDED`,
    });
  }

  // Goal drought — most matches with 0 goals scored
  const droughts = players.map((_, i) => ({ i, n: 0, p: 0 }));
  for (const m of completed) {
    droughts[m.home].p++; droughts[m.away].p++;
    if (m.homeScore === 0) droughts[m.home].n++;
    if (m.awayScore === 0) droughts[m.away].n++;
  }
  droughts.sort((a, b) => b.n - a.n || b.p - a.p);
  if (droughts[0]?.n >= 2) {
    shame.push({
      label: "BLANKED",
      victim: nameOf(players, droughts[0].i),
      detail: `${droughts[0].n} SCORELESS GAMES`,
    });
  }

  // Longest losing streak (consecutive losses, looking at chronological order of completed)
  const lossStreaks = players.map(() => ({ cur: 0, max: 0 }));
  for (const m of completed) {
    const winnerIdx = m.homeScore > m.awayScore ? m.home : m.homeScore < m.awayScore ? m.away : null;
    const loserIdx  = m.homeScore > m.awayScore ? m.away : m.homeScore < m.awayScore ? m.home : null;
    if (winnerIdx == null) continue;
    lossStreaks[winnerIdx].cur = 0;
    lossStreaks[loserIdx].cur += 1;
    if (lossStreaks[loserIdx].cur > lossStreaks[loserIdx].max) {
      lossStreaks[loserIdx].max = lossStreaks[loserIdx].cur;
    }
  }
  const worstStreak = lossStreaks
    .map((s, i) => ({ i, max: s.max }))
    .sort((a, b) => b.max - a.max)[0];
  if (worstStreak && worstStreak.max >= 2) {
    shame.push({
      label: "ON A SKID",
      victim: nameOf(players, worstStreak.i),
      detail: `${worstStreak.max} LOSSES IN A ROW`,
    });
  }

  return shame;
}
