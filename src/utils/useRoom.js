import { useEffect, useRef, useState, useCallback } from "react";
import { viewerId } from "./room";

// Subscribes to /api/room/:code/stream and exposes:
//   { state, presence, reactions, sendState, sendReaction, connected }
export function useRoom(code) {
  const [state, setState] = useState(null);
  const [presence, setPresence] = useState(0);
  const [reactions, setReactions] = useState([]); // array of {id, emoji, by, t, left}
  const [connected, setConnected] = useState(false);
  const lastSentRef = useRef(null);

  // Subscribe to SSE
  useEffect(() => {
    if (!code) return;
    let es;
    let cancelled = false;

    // Initial fetch (covers cases where SSE state event isn't sent because room is empty)
    fetch(`/api/room/${code}/state`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data.state) setState(data.state);
        if (typeof data.presence === "number") setPresence(data.presence);
      })
      .catch(() => { /* offline */ });

    es = new EventSource(`/api/room/${code}/stream`);
    es.addEventListener("hello", (e) => {
      setConnected(true);
      try {
        const d = JSON.parse(e.data);
        if (typeof d.presence === "number") setPresence(d.presence);
      } catch { /* malformed */ }
    });
    es.addEventListener("state", (e) => {
      try {
        const next = JSON.parse(e.data);
        setState(next);
      } catch { /* malformed */ }
    });
    es.addEventListener("presence", (e) => {
      try {
        const d = JSON.parse(e.data);
        if (typeof d.count === "number") setPresence(d.count);
      } catch { /* malformed */ }
    });
    es.addEventListener("reaction", (e) => {
      try {
        const d = JSON.parse(e.data);
        // Random horizontal position is computed at mint-time so it's stable across re-renders.
        const id = `${d.t}_${Math.random().toString(36).slice(2, 6)}`;
        const left = Math.round(8 + Math.random() * 84) + "%";
        setReactions((prev) => [...prev, { id, left, ...d }]);
        setTimeout(() => {
          setReactions((prev) => prev.filter((r) => r.id !== id));
        }, 3000);
      } catch { /* malformed */ }
    });
    es.onerror = () => setConnected(false);

    // Heartbeat
    const id = viewerId();
    const heartbeat = () => {
      fetch(`/api/room/${code}/presence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      }).catch(() => { /* offline */ });
    };
    heartbeat();
    const hbInterval = setInterval(heartbeat, 4000);

    return () => {
      cancelled = true;
      clearInterval(hbInterval);
      try { es.close(); } catch { /* already closed */ }
    };
  }, [code]);

  const sendState = useCallback(
    (next) => {
      if (!code) return;
      const sig = JSON.stringify(next);
      if (sig === lastSentRef.current) return;
      lastSentRef.current = sig;
      // Optimistic local update — server will echo via SSE shortly.
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
