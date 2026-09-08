// Serves the hub owner's Liked Songs as recommendations inside Know Your Song,
// and accepts the owner's periodic publish of that library into D1.
//
// Nothing here touches a player's Spotify account. Players read this list and
// build a playlist in *their* own Spotify with *their* own token, client-side;
// the Worker only decides which five songs to show.

const MAX_SYNC_ROWS = 250;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/** Comparison that does not leak the key's length or matching prefix. */
function secretEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const COLUMNS = "track_id, uri, name, artists, art, year";

function toTrack(row) {
  return {
    id: row.track_id,
    uri: row.uri,
    name: row.name,
    artists: row.artists,
    art: row.art,
    year: row.year,
  };
}

/**
 * GET /api/song/recs?genre=&n=
 *
 * Returns `n` of the owner's songs. When a genre is given — the genre of the
 * track the player just guessed — one slot is reserved for a song that shares
 * it, so the strip is mostly a lucky dip with a single deliberate echo of what
 * they were just listening to. A genre with nothing behind it silently becomes
 * another random pick rather than an error or a short list.
 */
export async function songRecs(url, env) {
  if (!env.DB) return json({ error: "D1 not configured" }, 503);

  const n = Math.min(10, Math.max(1, Number(url.searchParams.get("n")) || 5));
  // Spotify genres are words, spaces and the odd hyphen or ampersand. Stripping
  // everything else keeps a caller from smuggling LIKE wildcards in and making
  // the match broader than one genre.
  const genre = (url.searchParams.get("genre") || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 &'-]/g, "")
    .slice(0, 60);

  const picked = [];
  // Holds the genre pick, if there was one, so the random fill below cannot
  // hand back the same song twice.
  const taken = [];

  try {
    if (genre) {
      const { results } = await env.DB.prepare(
        `SELECT ${COLUMNS} FROM song_recs
          WHERE genres LIKE ?
          ORDER BY RANDOM() LIMIT 1`
      ).bind(`%,${genre},%`).all();
      for (const row of results || []) {
        picked.push(toTrack(row));
        taken.push(row.track_id);
      }
    }

    const want = n - picked.length;
    if (want > 0) {
      const { results } = await env.DB.prepare(
        `SELECT ${COLUMNS} FROM song_recs
          ${taken.length ? `WHERE track_id NOT IN (${taken.map(() => "?").join(",")})` : ""}
          ORDER BY RANDOM() LIMIT ?`
      ).bind(...taken, want).all();
      for (const row of results || []) picked.push(toTrack(row));
    }
  } catch (e) {
    return json({ error: e.message }, 500);
  }

  return json({ tracks: picked });
}

/**
 * POST /api/song/recs/sync — body { key, reset?, tracks: [...] }
 *
 * Owner-only, in chunks: the first chunk sets `reset` to clear what is there,
 * and the rest append. Upserts rather than inserts so a retried chunk after a
 * dropped connection is harmless.
 */
export async function songRecsSync(request, env) {
  if (!env.DB) return json({ error: "D1 not configured" }, 503);
  if (!env.SONG_ADMIN_KEY) {
    return json({ error: "Publishing is not configured. Set the SONG_ADMIN_KEY Worker secret." }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  if (!secretEquals(String(body?.key ?? ""), env.SONG_ADMIN_KEY)) {
    return json({ error: "Not authorized" }, 403);
  }

  const tracks = Array.isArray(body?.tracks) ? body.tracks : [];
  if (tracks.length > MAX_SYNC_ROWS) {
    return json({ error: `Send at most ${MAX_SYNC_ROWS} tracks per request` }, 413);
  }

  const now = Date.now();
  const stmts = [];
  if (body?.reset) stmts.push(env.DB.prepare("DELETE FROM song_recs"));

  let skipped = 0;
  for (const t of tracks) {
    if (!t?.id || !t?.uri || !t?.name) {
      skipped++;
      continue;
    }
    const genres = Array.isArray(t.genres) ? t.genres : [];
    // Fenced on both ends so `LIKE '%,pop,%'` can match the first and last
    // genre as readily as a middle one.
    const fenced =
      "," + genres.map((g) => String(g).toLowerCase().replace(/,/g, " ")).join(",") + ",";
    stmts.push(
      env.DB.prepare(
        `INSERT INTO song_recs (track_id, uri, name, artists, art, year, genres, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(track_id) DO UPDATE SET
           uri = excluded.uri, name = excluded.name, artists = excluded.artists,
           art = excluded.art, year = excluded.year, genres = excluded.genres,
           updated_at = excluded.updated_at`
      ).bind(
        String(t.id),
        String(t.uri),
        String(t.name),
        String(t.artists ?? ""),
        t.art ? String(t.art) : null,
        t.year ? String(t.year) : null,
        fenced,
        now
      )
    );
  }

  try {
    if (stmts.length) await env.DB.batch(stmts);
  } catch (e) {
    return json({ error: `Publish failed: ${e.message}` }, 500);
  }

  const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM song_recs").first();
  return json({ written: tracks.length - skipped, skipped, total: total?.n ?? 0 });
}
