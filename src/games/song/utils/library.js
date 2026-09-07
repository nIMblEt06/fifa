import { fold, songKey } from "./match";

/** How many recent tracks we are willing to remember at most. */
export const RECENT_MAX = 40;

/**
 * Picks a track, avoiding the ones seen most recently.
 *
 * The no-repeat window scales with the library rather than being a fixed 40:
 * with a small library a fixed window swallows every track, leaving nothing
 * fresh to pick and silently re-allowing an immediate repeat. Holding back at
 * most half the library keeps the pool non-empty for any size.
 */
export function pickTrack(tracks, recentIds) {
  const window = Math.min(RECENT_MAX, Math.floor(tracks.length / 2));
  const recent = new Set(recentIds.slice(0, window)); // stored newest-first
  const pool = tracks.filter((t) => !recent.has(t.id));
  const from = pool.length > 0 ? pool : tracks;
  return from[Math.floor(Math.random() * from.length)];
}

/** Ranks library tracks against a query: title prefix > title contains > artist. */
export function searchTracks(tracks, query, limit = 8) {
  const q = fold(query);
  if (!q) return [];
  const scored = [];

  for (const track of tracks) {
    const title = fold(track.name);
    const artist = fold(track.artists);
    let score = -1;
    if (title.startsWith(q)) score = 0;
    else if (title.includes(q)) score = 1;
    else if (artist.startsWith(q)) score = 2;
    else if (artist.includes(q)) score = 3;
    else if (`${artist} ${title}`.includes(q)) score = 4;
    if (score >= 0) scored.push({ track, score });
  }

  // The same song saved twice (a remaster and the original, say) would show up
  // as two identical-looking rows; keep only the best-ranked one.
  const seen = new Set();
  const out = [];
  for (const { track } of scored.sort(
    (a, b) => a.score - b.score || a.track.name.localeCompare(b.track.name)
  )) {
    const key = songKey(track);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(track);
    if (out.length >= limit) break;
  }
  return out;
}
