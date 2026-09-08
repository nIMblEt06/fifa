// The hub owner's Liked Songs, offered to whoever is playing. These are not
// the player's own library — that is what the game itself runs on — they are
// somebody else's taste, shown a few at a time in the hope one of them lands.

/** Songs on the strip at once. */
export const REC_COUNT = 5;

export async function fetchRecs({ genre, n = REC_COUNT } = {}) {
  const params = new URLSearchParams({ n: String(n) });
  if (genre) params.set("genre", genre);

  const res = await fetch(`/api/song/recs?${params}`, { cache: "no-store" });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `Recommendations returned ${res.status}`);
  return Array.isArray(body?.tracks) ? body.tracks : [];
}

/** One genre of the track just guessed, to echo back on the strip. */
export function pickGenre(track) {
  const genres = track?.genres ?? [];
  if (genres.length === 0) return null;
  return genres[Math.floor(Math.random() * genres.length)].toLowerCase();
}

/**
 * Publishes a library to D1 as the recommendation pool. Owner-only, and driven
 * from the browser on purpose: the tab already holds the whole library, where
 * a Worker would need hundreds of Spotify requests to rebuild it.
 */
export async function publishLibrary(key, tracks, onProgress) {
  const CHUNK = 200;
  let written = 0;
  let total = 0;

  for (let i = 0; i < tracks.length; i += CHUNK) {
    const chunk = tracks.slice(i, i + CHUNK).map((t) => ({
      id: t.id,
      uri: t.uri,
      name: t.name,
      artists: t.artists,
      art: t.art,
      year: t.year,
      genres: t.genres ?? [],
    }));

    const res = await fetch("/api/song/recs/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Only the first chunk clears the table, so a run that dies halfway
      // leaves the previous list in place rather than a truncated one.
      body: JSON.stringify({ key, reset: i === 0, tracks: chunk }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error ?? `Publish returned ${res.status}`);

    written += body.written ?? 0;
    total = body.total ?? total;
    onProgress?.(Math.min(i + CHUNK, tracks.length), tracks.length);
  }

  return { written, total };
}
