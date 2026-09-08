// Lifetime stats for Know Your Song. Small enough for localStorage (a couple
// of hundred bytes), and deliberately kept separate from the library cache in
// IndexedDB: stats should survive a resync, a disconnect, an empty library.

import { MAX_GUESSES } from "./tokens";

const KEY = "song.stats";

export const EMPTY_STATS = {
  rounds: 0,
  solved: 0,
  streak: 0,
  best: 0,
  // dist[i] = rounds solved on guess i + 1.
  dist: Array.from({ length: MAX_GUESSES }, () => 0),
  // Total guesses spent on solved rounds, so the average needs no history.
  guessesOnSolved: 0,
  lastPlayed: 0,
};

function sane(raw) {
  if (!raw || typeof raw !== "object") return { ...EMPTY_STATS };
  const dist = Array.from(
    { length: MAX_GUESSES },
    (_, i) => Number(raw.dist?.[i]) || 0
  );
  return {
    rounds: Number(raw.rounds) || 0,
    solved: Number(raw.solved) || 0,
    streak: Number(raw.streak) || 0,
    best: Number(raw.best) || 0,
    dist,
    guessesOnSolved: Number(raw.guessesOnSolved) || 0,
    lastPlayed: Number(raw.lastPlayed) || 0,
  };
}

export function readStats() {
  try {
    return sane(JSON.parse(localStorage.getItem(KEY) ?? "null"));
  } catch {
    return { ...EMPTY_STATS };
  }
}

function write(stats) {
  try {
    localStorage.setItem(KEY, JSON.stringify(stats));
  } catch { /* blocked storage — stats are a nicety, not the game */ }
  return stats;
}

/**
 * Folds one finished round into the stored stats and returns the new totals.
 * `guessesUsed` is how many rows were filled: on a win that is the guess that
 * landed it, on a loss it is MAX_GUESSES.
 */
export function recordRound(solved, guessesUsed) {
  const s = readStats();
  const streak = solved ? s.streak + 1 : 0;
  return write({
    rounds: s.rounds + 1,
    solved: s.solved + (solved ? 1 : 0),
    streak,
    best: Math.max(s.best, streak),
    dist: s.dist.map((n, i) => n + (solved && i === guessesUsed - 1 ? 1 : 0)),
    guessesOnSolved: s.guessesOnSolved + (solved ? guessesUsed : 0),
    lastPlayed: Date.now(),
  });
}

export function resetStats() {
  try {
    localStorage.removeItem(KEY);
  } catch { /* nothing to clear */ }
  return { ...EMPTY_STATS };
}

export function winRate(stats) {
  return stats.rounds === 0 ? 0 : Math.round((stats.solved / stats.rounds) * 100);
}

export function averageGuesses(stats) {
  return stats.solved === 0 ? 0 : stats.guessesOnSolved / stats.solved;
}
