import { useEffect, useRef, useState, useCallback } from "react";
import { viewerId } from "./room";

// Subscribes to /api/room/:code/ws and exposes:
//   { state, presence, reactions, sendState, sendAction, sendReaction, connected }
//
// For "fifa" rooms (legacy default), `sendState` POSTs a full state blob
// (server is just a relay).
//
// For "lit" rooms, callers pass `{ game: "lit", clientId }`. On every open
// we send a `join` message so the DO can map this socket → clientId, and
// the server pushes a redacted per-player view back via `type:"state"`.
// Use `sendAction({type:"start"|"ask"|...})` for game moves.
export function useRoom(code, opts = {}) {
  const { game = "fifa", clientId: cid = null, name = null } = opts;
  const [state, setState] = useState(null);
  const [presence, setPresence] = useState(0);
  const [reactions, setReactions] = useState([]);
  const [connected, setConnected] = useState(false);
  // `ready` flips true after the first server message (hello or state) arrives.
  // Lets callers distinguish "no remote state because we're still loading" from
  // "no remote state because this is a fresh room".
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);
  const lastSentRef = useRef(null);
  const wsRef = useRef(null);
  const errorTimerRef = useRef(null);
  const pendingNameRef = useRef(name);
  useEffect(() => { pendingNameRef.current = name; }, [name]);

  // Surface a server-rejected action (e.g. "not your turn"). Auto-expires so
  // the banner doesn't linger; callers can also dismiss it.
  const dismissError = useCallback(() => {
    clearTimeout(errorTimerRef.current);
    setError(null);
  }, []);
  const raiseError = useCallback((message) => {
    setError({ message, id: Date.now() });
    clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => setError(null), 4000);
  }, []);
  useEffect(() => () => clearTimeout(errorTimerRef.current), []);

  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    let reconnectTimer = null;

    const connect = () => {
      if (cancelled) return;
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${window.location.host}/api/room/${code}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        // For server-authoritative games (lit, poker, bluff, …), re-identify
        // on reconnect IF the user has already joined (we have their name
        // cached). First-time joining is driven by sendAction({type:"join",
        // name}) so the user controls when they take a seat.
        if (cid && pendingNameRef.current) {
          try {
            ws.send(JSON.stringify({ type: "join", game, clientId: cid, name: pendingNameRef.current }));
          } catch { /* will retry on reconnect */ }
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (!cancelled) {
          reconnectTimer = setTimeout(connect, 1500);
        }
      };

      ws.onerror = () => { /* onclose will fire next */ };

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === "hello") {
            if (typeof msg.presence === "number") setPresence(msg.presence);
            setReady(true);
          } else if (msg.type === "state") {
            setState(msg.data);
            setReady(true);
          } else if (msg.type === "presence") {
            if (typeof msg.count === "number") setPresence(msg.count);
          } else if (msg.type === "reaction") {
            const id = `${msg.t}_${Math.random().toString(36).slice(2, 6)}`;
            const left = Math.round(8 + Math.random() * 84) + "%";
            setReactions((prev) => [...prev, { id, left, emoji: msg.emoji, by: msg.by, t: msg.t }]);
            setTimeout(() => {
              setReactions((prev) => prev.filter((r) => r.id !== id));
            }, 3000);
          } else if (msg.type === "error") {
            raiseError(msg.message || "Something went wrong.");
          }
        } catch { /* malformed */ }
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (wsRef.current) {
        try { wsRef.current.close(); } catch { /* already closed */ }
        wsRef.current = null;
      }
    };
  }, [code, game, cid]);

  const sendState = useCallback(
    (next) => {
      if (!code) return;
      const sig = JSON.stringify(next);
      if (sig === lastSentRef.current) return;
      lastSentRef.current = sig;
      setState(next);
      fetch(`/api/room/${code}/state`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: sig,
      }).catch(() => { /* offline */ });
    },
    [code]
  );

  const sendAction = useCallback((action) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // For `join`, callers can pass a name; remember it so reconnects re-join.
    if (action?.type === "join" && action.name) pendingNameRef.current = action.name;
    try {
      const payload = action.type === "join"
        ? { ...action, game, clientId: cid }
        : action;
      ws.send(JSON.stringify(payload));
    } catch { /* dropped */ }
  }, [game, cid]);

  const sendReaction = useCallback(
    (emoji) => {
      if (!code) return;
      fetch(`/api/room/${code}/reaction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emoji, by: viewerId() }),
      }).catch(() => { /* offline */ });
    },
    [code]
  );

  return { state, presence, reactions, connected, ready, error, dismissError, sendState, sendAction, sendReaction };
}
