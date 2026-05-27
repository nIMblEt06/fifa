// Room codes live in the URL hash: #/r/CODE[/GAME]. GAME is one of
// "fifa" | "lit" (default "fifa" for back-compat with pre-hub rooms).

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0, 1 — readable
const GAMES = ["fifa", "lit"];
const DEFAULT_GAME = "fifa";

export function generateCode(len = 4) {
  let out = "";
  for (let i = 0; i < len; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

export function readRoomFromUrl() {
  const m = window.location.hash.match(/^#\/r\/([A-Z0-9]{2,8})(?:\/([a-z]+))?/i);
  if (!m) return null;
  const code = m[1].toUpperCase();
  const game = (m[2] || DEFAULT_GAME).toLowerCase();
  return { code, game: GAMES.includes(game) ? game : DEFAULT_GAME };
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
