// Room codes live in the URL path (#/r/CODE) so the URL itself is shareable.
// The dev server keeps per-room in-memory state and broadcasts via SSE.

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0, 1 — readable

export function generateCode(len = 4) {
  let out = "";
  for (let i = 0; i < len; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

export function readCodeFromUrl() {
  const m = window.location.hash.match(/^#\/r\/([A-Z0-9]{2,8})/i);
  return m ? m[1].toUpperCase() : null;
}

export function writeCodeToUrl(code) {
  const next = `#/r/${code}`;
  if (window.location.hash !== next) {
    window.history.replaceState(null, "", next);
  }
}

export function shareUrl(code) {
  return `${window.location.origin}${window.location.pathname}#/r/${code}`;
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
