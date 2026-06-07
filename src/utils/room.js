// Room codes live in the URL hash: #/r/CODE[/GAME]. GAME is one of
// "fifa" | "lit" (default "fifa" for back-compat with pre-hub rooms).
//
// Codes are case-insensitive ([A-Za-z0-9-]{2,32}) — display casing is
// whatever the user typed; the worker lowercases before keying the DO so
// EL-CRAPICO and el-crapico hit the same room.

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0, 1 — readable
const GAMES = ["fifa", "lit", "poker", "hitler"];
const DEFAULT_GAME = "fifa";
export const CODE_RE = /^[A-Za-z0-9-]{2,32}$/;

export function generateCode(len = 4) {
  let out = "";
  for (let i = 0; i < len; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

// Clean a user-typed code: strip disallowed chars, collapse runs of hyphens,
// trim hyphens from the ends. Casing is preserved. Returns "" if the result
// is too short.
export function normalizeCode(raw) {
  const cleaned = String(raw || "")
    .replace(/[^A-Za-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  if (cleaned.length < 2) return "";
  return cleaned;
}

export function readRoomFromUrl() {
  const m = window.location.hash.match(/^#\/r\/([A-Za-z0-9-]{2,32})(?:\/([a-z]+))?/);
  if (!m) return null;
  const code = m[1];
  const game = (m[2] || DEFAULT_GAME).toLowerCase();
  return { code, game: GAMES.includes(game) ? game : DEFAULT_GAME };
}

export function isHofRoute() {
  return /^#\/hof/.test(window.location.hash);
}

export function navigateToHof() {
  if (window.location.hash !== "#/hof") window.history.replaceState(null, "", "#/hof");
}

export function readCodeFromUrl() {
  const r = readRoomFromUrl();
  return r ? r.code : null;
}

export function writeRoomToUrl(code, game = DEFAULT_GAME) {
  const next = `#/r/${code}/${game}`;
  if (window.location.hash !== next) {
    window.history.replaceState(null, "", next);
  }
}

export function clearRoomFromUrl() {
  if (window.location.hash) {
    window.history.replaceState(null, "", window.location.pathname);
  }
}

export function shareUrl(code, game = DEFAULT_GAME) {
  return `${window.location.origin}${window.location.pathname}#/r/${code}/${game}`;
}

let _viewerId = null;
export function viewerId() {
  if (_viewerId) return _viewerId;
  try {
    const k = "fifa-viewer-id";
    let id = sessionStorage.getItem(k);
    if (!id) {
      id = `v_${Math.random().toString(36).slice(2, 10)}`;
      sessionStorage.setItem(k, id);
    }
    _viewerId = id;
  } catch {
    _viewerId = `v_${Math.random().toString(36).slice(2, 10)}`;
  }
  return _viewerId;
}

// Stable per-browser client id used by server-authoritative games (Lit) to
// resume the same seat across reconnects. Persistent (localStorage) unlike
// the per-tab viewerId.
let _clientId = null;
export function clientId() {
  if (_clientId) return _clientId;
  try {
    const k = "hub-client-id";
    let id = localStorage.getItem(k);
    if (!id) {
      id = `c_${Math.random().toString(36).slice(2, 12)}`;
      localStorage.setItem(k, id);
    }
    _clientId = id;
  } catch {
    _clientId = `c_${Math.random().toString(36).slice(2, 12)}`;
  }
  return _clientId;
}
