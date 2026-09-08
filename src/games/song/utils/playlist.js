// One Spotify playlist per browser, and the ♡ that fills it.
//
// A "like" here is not a state the platform keeps — it is an action. Clicking
// ♡ puts the song in the player's own Spotify playlist there and then,
// creating that playlist on the first click. There is no staging list to
// curate and no second confirm step: the only thing worth remembering is what
// is already in the playlist, because Spotify would happily store a duplicate.
//
// State lives in one module-level store rather than in each component, so the
// marquee's hearts, the reveal card's heart and the status bar all agree —
// including about an error raised by a click in one of the others.

import { useSyncExternalStore } from "react";
import { addTracksToPlaylist, createPlaylist } from "./spotify";

const KEY = "song.playlist";

const PLAYLIST_NAME = "Know Your Song";
const PLAYLIST_DESC = "Songs I liked while playing Know Your Song on 1-hub.xyz.";

/** { id, url, name, trackIds: string[] } — or null before the first ♡. */
function readStored() {
  let raw;
  try {
    raw = JSON.parse(localStorage.getItem(KEY) ?? "null");
  } catch {
    return null; // blocked storage; the in-memory store still works this visit
  }
  if (!raw?.id) return null;
  return {
    id: String(raw.id),
    url: raw.url ? String(raw.url) : null,
    name: String(raw.name ?? PLAYLIST_NAME),
    trackIds: Array.isArray(raw.trackIds) ? raw.trackIds.map(String) : [],
  };
}

let state = { playlist: readStored(), adding: new Set(), error: null };
const listeners = new Set();

function emit(next) {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function store(playlist) {
  try {
    if (playlist) localStorage.setItem(KEY, JSON.stringify(playlist));
    else localStorage.removeItem(KEY);
  } catch { /* blocked storage — remembered for this visit only */ }
  emit({ ...state, playlist });
  return playlist;
}

// Another tab of the game adding songs to the same playlist.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) emit({ ...state, playlist: readStored() });
  });
}

export function usePlaylistState() {
  return useSyncExternalStore(subscribe, () => state);
}

// Collapses concurrent first clicks: two hearts hit in the same second must
// not race into two playlists.
let creating = null;

function ensurePlaylist() {
  const existing = state.playlist;
  if (existing) return Promise.resolve(existing);

  creating ??= createPlaylist(PLAYLIST_NAME, PLAYLIST_DESC)
    .then((made) => store({ ...made, trackIds: state.playlist?.trackIds ?? [] }))
    .finally(() => {
      creating = null;
    });
  return creating;
}

function setAdding(id, on) {
  const adding = new Set(state.adding);
  if (on) adding.add(id);
  else adding.delete(id);
  emit({ ...state, adding });
}

/** Adds one song to the playlist, making the playlist if this is the first. */
export async function addToPlaylist(track) {
  if (state.adding.has(track.id)) return;
  if (state.playlist?.trackIds.includes(track.id)) return;

  setAdding(track.id, true);
  emit({ ...state, error: null });

  try {
    const playlist = await ensurePlaylist();
    await addTracksToPlaylist(playlist.id, [track.uri]);
    // Re-read rather than reusing `playlist`: another click may have landed
    // while this request was in flight.
    const current = state.playlist ?? playlist;
    store({
      ...current,
      trackIds: [...new Set([...current.trackIds, track.id])],
    });
  } catch (e) {
    // describe() can itself detach the playlist (a 404 means it is gone), and
    // that writes new state. Take the message first, so the emit below spreads
    // the state as it is *after* that write rather than resurrecting the
    // playlist it just cleared.
    const message = describe(e);
    emit({ ...state, error: message });
  } finally {
    setAdding(track.id, false);
  }
}

function describe(e) {
  // A playlist deleted in Spotify can never be added to again; detach so the
  // next ♡ starts a fresh one instead of failing forever.
  if (e?.status === 404) {
    store(null);
    return "That playlist is gone from Spotify — the next ♡ will start a new one.";
  }
  // The playlist scopes arrived after this game shipped, so a session opened
  // before then holds a token that cannot write playlists.
  if (e?.status === 401 || e?.status === 403) {
    return "Spotify would not allow that. Disconnect and reconnect to grant playlist access, then try again.";
  }
  return e instanceof Error ? e.message : String(e);
}

/** Detaches the current playlist; the next ♡ starts a new one. */
export function forgetPlaylist() {
  store(null);
}

export function dismissPlaylistError() {
  emit({ ...state, error: null });
}
