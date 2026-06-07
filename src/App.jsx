import { useState, useEffect, useCallback } from "react";
import GamePicker from "./components/GamePicker";
import HallOfFame from "./components/HallOfFame";
import FifaApp from "./games/fifa/FifaApp";
import LitApp from "./games/lit/LitApp";
import PokerApp from "./games/poker/PokerApp";
import BluffApp from "./games/bluff/BluffApp";
import HitlerApp from "./games/hitler/HitlerApp";
import UndercoverApp from "./games/undercover/UndercoverApp";
import ChickenApp from "./games/chicken/ChickenApp";
import { generateCode, readRoomFromUrl, writeRoomToUrl, clearRoomFromUrl, isHofRoute, navigateToHof } from "./utils/room";

// Top-level router. The URL hash decides what we render:
//   #/                 → game picker
//   #/r/CODE/fifa      → FIFA tournament
//   #/r/CODE/lit       → Lit game
//   #/r/CODE           → defaults to FIFA (back-compat with pre-hub rooms)
export default function App() {
  const [route, setRoute] = useState(() => readRoomFromUrl());
  const [onHof, setOnHof] = useState(() => isHofRoute());

  // Re-read on hash changes (e.g. browser back/forward).
  useEffect(() => {
    const onHash = () => {
      setRoute(readRoomFromUrl());
      setOnHof(isHofRoute());
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Reactive tab title.
  useEffect(() => {
    const title = onHof
      ? "HALL OF FAME"
      : !route
      ? "1Hub"
      : route.game === "lit"
        ? `LIT · ${route.code}`
        : route.game === "poker"
          ? `POKER · ${route.code}`
          : route.game === "bluff"
            ? `BLUFF · ${route.code}`
          : route.game === "hitler"
            ? `SECRET HITLER · ${route.code}`
          : route.game === "undercover"
            ? `UNDERCOVER · ${route.code}`
          : route.game === "chicken"
            ? `CHICKEN RUN · ${route.code}`
            : `FIFA · ${route.code}`;
    document.title = title;
  }, [route, onHof]);

  const handlePick = useCallback((game, codeOverride = null) => {
    const code = codeOverride || generateCode(4);
    writeRoomToUrl(code, game);
    setRoute({ code, game });
    setOnHof(false);
  }, []);

  const handleLeave = useCallback(() => {
    clearRoomFromUrl();
    setRoute(null);
    setOnHof(false);
  }, []);

  const handleOpenHof = useCallback(() => {
    navigateToHof();
    setOnHof(true);
    setRoute(null);
  }, []);

  if (onHof) return <HallOfFame onLeave={handleLeave} />;
  if (!route) return <GamePicker onPick={handlePick} onOpenHof={handleOpenHof} />;
  if (route.game === "lit") return <LitApp code={route.code} onLeave={handleLeave} />;
  if (route.game === "poker") return <PokerApp code={route.code} onLeave={handleLeave} />;
  if (route.game === "bluff") return <BluffApp code={route.code} onLeave={handleLeave} />;
  if (route.game === "hitler") return <HitlerApp code={route.code} onLeave={handleLeave} />;
  if (route.game === "undercover") return <UndercoverApp code={route.code} onLeave={handleLeave} />;
  if (route.game === "chicken") return <ChickenApp code={route.code} onLeave={handleLeave} />;
  return <FifaApp code={route.code} onLeave={handleLeave} />;
}
