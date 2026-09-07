import { getAccessToken } from "./auth";

const API = "https://api.spotify.com/v1";

// A Track is { id, uri, name, artists, artistIds, album, art, year,
//              durationMs, popularity, genres }.

export class SpotifyError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, init = {}, attempt = 0) {
  const token = await getAccessToken();
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  // Requests run in parallel, so a 429 is expected under load. Spotify says
  // how long to wait; honour it rather than hammering or failing the load.
  if (res.status === 429 && attempt < 4) {
    const retryAfter = Number(res.headers.get("Retry-After") ?? 1);
    await wait((Number.isFinite(retryAfter) ? retryAfter : 1) * 1000 + 250);
    return api(path, init, attempt + 1);
  }

  if (res.status === 204) return undefined;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new SpotifyError(
      body?.error?.message || `Spotify returned ${res.status}`,
      res.status
    );
  }
  return body;
}

export function getProfile() {
  return api("/me");
}

function normalize(t) {
  // Local files and unplayable regional tracks have no usable URI for the SDK.
  if (!t.id || t.uri.startsWith("spotify:local")) return null;
  return {
    id: t.id,
    uri: t.uri,
    name: t.name,
    artists: t.artists.map((a) => a.name).join(", "),
    artistIds: t.artists.map((a) => a.id).filter(Boolean),
    album: t.album.name,
    art: t.album.images.at(-1)?.url ?? t.album.images[0]?.url ?? null,
    year: t.album.release_date?.slice(0, 4) ?? "",
    durationMs: t.duration_ms,
    popularity: t.popularity ?? 0,
    genres: [], // filled in by streamGenres once the artists are fetched
  };
}

function normalizePage(page) {
  const out = [];
  for (const item of page.items) {
    if (!item.track) continue;
    const t = normalize(item.track);
    if (t) out.push(t);
  }
  return out;
}

export function playTrack(deviceId, uri, positionMs = 0) {
  return api(`/me/player/play?device_id=${deviceId}`, {
    method: "PUT",
    body: JSON.stringify({ uris: [uri], position_ms: positionMs }),
  });
}

export function transferPlayback(deviceId) {
  return api("/me/player", {
    method: "PUT",
    body: JSON.stringify({ device_ids: [deviceId], play: false }),
  });
}

/** Runs `fn` over `items` with at most `limit` requests in flight. */
async function mapLimit(items, limit, fn) {
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        await fn(items[i]);
      }
    }
  );
  await Promise.all(workers);
}

/**
 * Streams the Liked Songs library.
 *
 * Page 0 is fetched first and handed back immediately — that is enough to start
 * playing — and it also reports `total`, which lets every remaining page be
 * requested in parallel instead of walking `next` one hop at a time.
 * Pages are reported with their index so the caller can keep the library in
 * Spotify's order (newest save first) regardless of arrival order.
 */
export async function streamLibrary(onPage, concurrency = 5) {
  const firstPage = await api("/me/tracks?limit=50&offset=0");
  const total = firstPage.total;
  onPage(0, normalizePage(firstPage), total);

  const rest = Array.from(
    { length: Math.max(0, Math.ceil(total / 50) - 1) },
    (_, i) => i + 1
  );

  await mapLimit(rest, concurrency, async (pageIndex) => {
    const page = await api(`/me/tracks?limit=50&offset=${pageIndex * 50}`);
    onPage(pageIndex, normalizePage(page), total);
  });
}

/**
 * Fetches artist genres in parallel batches of 50 and writes them onto the
 * matching tracks in place, reporting progress as batches land.
 */
export async function streamGenres(tracks, onProgress, concurrency = 4) {
  const unique = [...new Set(tracks.flatMap((t) => t.artistIds))];
  const batches = Array.from(
    { length: Math.ceil(unique.length / 50) },
    (_, i) => unique.slice(i * 50, i * 50 + 50)
  );

  const genreOf = new Map();
  let done = 0;

  await mapLimit(batches, concurrency, async (batch) => {
    try {
      const res = await api(`/artists?ids=${batch.join(",")}`);
      for (const artist of res.artists) {
        if (artist) genreOf.set(artist.id, artist.genres ?? []);
      }
    } catch {
      // A failed batch just means those tracks carry no genre; not fatal.
    }
    done += batch.length;
    onProgress(Math.min(done, unique.length), unique.length);
  });

  for (const track of tracks) {
    const set = new Set();
    for (const id of track.artistIds) {
      for (const g of genreOf.get(id) ?? []) set.add(g);
    }
    track.genres = [...set];
  }
}
