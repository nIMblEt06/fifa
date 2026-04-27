import { useEffect, useRef, useState, useCallback } from "react";
import { viewerId } from "./room";

// Subscribes to /api/room/:code/ws (WebSocket served by the room's Durable Object)
// and exposes: { state, presence, reactions, sendState, sendReaction, connected }.
//
// Presence is derived from active WS connections in the DO — no client heartbeat.
// Auto-reconnects on close with a 1.5s backoff.
export function useRoom(code) {
  const [state, setState] = useState(null);
  const [presence, setPresence] = useState(0);
  const [reactions, setReactions] = useState([]);
  const [connected, setConnected] = useState(false);
  const lastSentRef = useRef(null);
  const wsRef = useRef(null);

  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    let reconnectTimer = null;

    const connect = () => {
      if (cancelled) return;
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${window.location.host}/api/room/${code}/ws`);
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);

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
          } else if (msg.type === "state") {
            setState(msg.data);
          } else if (msg.type === "presence") {
            if (typeof msg.count === "number") setPresence(msg.count);
          } else if (msg.type === "reaction") {
            const id = `${msg.t}_${Math.random().toString(36).slice(2, 6)}`;
            const left = Math.round(8 + Math.random() * 84) + "%";
            setReactions((prev) => [...prev, { id, left, emoji: msg.emoji, by: msg.by, t: msg.t }]);
            setTimeout(() => {
              setReactions((prev) => prev.filter((r) => r.id !== id));
            }, 3000);
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
  }, [code]);

  const sendState = useCallback(
    (next) => {
      if (!code) return;
      const sig = JSON.stringify(next);
      if (sig === lastSentRef.current) return;
      lastSentRef.current = sig;
      // Optimistic local update — the WS will echo it back from the DO shortly.
      setState(next);
      fetch(`/api/room/${code}/state`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: sig,
      }).catch(() => { /* offline */ });
    },
    [code]
  );

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

  return { state, presence, reactions, connected, sendState, sendReaction };
}
