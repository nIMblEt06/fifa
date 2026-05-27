import { useState, useEffect, useCallback } from "react";
import GamePicker from "./components/GamePicker";
import FifaApp from "./games/fifa/FifaApp";
import LitApp from "./games/lit/LitApp";
import { generateCode, readRoomFromUrl, writeRoomToUrl, clearRoomFromUrl } from "./utils/room";

// Top-level router. The URL hash decides what we render:
//   #/                 → game picker
//   #/r/CODE/fifa      → FIFA tournament
//   #/r/CODE/lit       → Lit game
//   #/r/CODE           → defaults to FIFA (back-compat with pre-hub rooms)
export default function App() {
  const [route, setRoute] = useState(() => readRoomFromUrl());

  // Re-read on hash changes (e.g. browser back/forward).
  useEffect(() => {
    const onHash = () => setRoute(readRoomFromUrl());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Reactive tab title.
  useEffect(() => {
    const title = !route
      ? "LOCAL / GAMING HUB"
      : route.game === "lit"
        ? `LIT · ${route.code}`
        : `FIFA · ${route.code}`;
    document.title = title;
  }, [route]);

  const handlePick = useCallback((game) => {
    const code = generateCode(4);
    writeRoomToUrl(code, game);
    setRoute({ code, game });
  }, []);

  const handleLeave = useCallback(() => {
    clearRoomFromUrl();
    setRoute(null);
  }, []);

  if (!route) return <GamePicker onPick={handlePick} />;
  if (route.game === "lit") return <LitApp code={route.code} onLeave={handleLeave} />;
  return <FifaApp code={route.code} onLeave={handleLeave} />;
}
