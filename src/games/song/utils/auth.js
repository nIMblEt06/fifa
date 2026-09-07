// Client half of auth. The token exchange, refresh token and client secret all
// live in the Worker (worker/spotify.js); this only fetches short-lived access
// tokens from /api/spotify/token and caches the current one in memory.

import { clearLibraryCache } from "./cache";

let cached = null;
let inflight = null;

export class NotSignedIn extends Error {
  constructor() {
    super("Not signed in");
  }
}

export function beginLogin() {
  window.location.href = "/api/spotify/login";
}

export async function logout() {
  cached = null;
  await clearLibraryCache().catch(() => {});
  try {
    localStorage.removeItem("song.recent");
  } catch { /* blocked storage — nothing to clear */ }
  await fetch("/api/spotify/logout", { method: "POST" }).catch(() => {});
}

/** Returns a valid access token, refreshing via the Worker when stale. */
export async function getAccessToken() {
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;

  // Collapse concurrent requests — the SDK and API calls both ask at once.
  inflight ??= (async () => {
    const res = await fetch("/api/spotify/token", { cache: "no-store" });
    if (res.status === 401) {
      cached = null;
      throw new NotSignedIn();
    }
    const json = await res.json();
    if (!res.ok) throw new Error(json?.error ?? "Could not get an access token");
    cached = { token: json.access_token, expiresAt: json.expires_at };
    return cached.token;
  })().finally(() => {
    inflight = null;
  });

  return inflight;
}

/** Cheap check used on mount, so the landing screen knows which half to show. */
export async function hasSession() {
  try {
    await getAccessToken();
    return true;
  } catch {
    return false;
  }
}
