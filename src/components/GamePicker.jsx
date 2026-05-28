import { useMemo, useState } from "react";
import { normalizeCode } from "../utils/room";

// Landing page when no room is in the URL. Picks a game; we mint a code
// and route to it.
export default function GamePicker({ onPick, onOpenHof }) {
  const games = [
    {
      id: "fifa",
      title: "FIFA",
      tagline: "TOURNAMENT",
      blurb: "Group stage + knockout. Pick teams, scrap for the top 4.",
    },
    {
      id: "lit",
      title: "LIT",
      tagline: "FOUR-OF-A-KIND",
      blurb: "Local Go-Fish variant. Ask for ranks you hold, hunt the deck for full sets.",
    },
    {
      id: "poker",
      title: "POKER",
      tagline: "CASH GAME",
      blurb: "Poker-night buy-in tracker. Count the chips, settle the net to Splitwise.",
    },
  ];

  const [customCode, setCustomCode] = useState("");
  const [customGame, setCustomGame] = useState("fifa");
  const normalized = useMemo(() => normalizeCode(customCode), [customCode]);
  const canOpen = normalized.length >= 2;

  const submit = (e) => {
    e.preventDefault();
    if (!canOpen) return;
    onPick(customGame, normalized);
  };

  return (
    <div className="app">
      <header className="masthead">
        <h1>
          <span className="slash">1</span>Hub
        </h1>
      </header>
      <main>
        <div className="game-picker">
          {games.map((g) => (
            <button key={g.id} className="game-tile" onClick={() => onPick(g.id)}>
              <div className="game-tile-title">
                {g.title}
                <span className="slash">/</span>
                <span className="game-tile-sub">{g.tagline}</span>
              </div>
              <div className="game-tile-blurb">{g.blurb}</div>
              <div className="game-tile-cta">NEW ROOM →</div>
            </button>
          ))}
          {onOpenHof && (
            <button className="game-tile hof-tile" onClick={onOpenHof}>
              <div className="game-tile-title">
                HALL<span className="slash">/</span><span className="game-tile-sub">OF FAME</span>
              </div>
              <div className="game-tile-blurb">All-time FIFA stats: championships, leaderboards, head-to-head.</div>
              <div className="game-tile-cta">BROWSE →</div>
            </button>
          )}
        </div>

        <form className="custom-room" onSubmit={submit}>
          <div className="custom-room-label">OR OPEN A CUSTOM ROOM</div>
          <div className="custom-room-row">
            <input
              className="custom-room-input"
              type="text"
              placeholder="el-crapico"
              value={customCode}
              onChange={(e) => setCustomCode(e.target.value)}
              maxLength={32}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <select
              className="custom-room-game"
              value={customGame}
              onChange={(e) => setCustomGame(e.target.value)}
            >
              {games.map((g) => (
                <option key={g.id} value={g.id}>{g.title}</option>
              ))}
            </select>
            <button type="submit" className="custom-room-btn" disabled={!canOpen}>
              OPEN →
            </button>
          </div>
          {customCode && normalized !== customCode && (
            <div className="custom-room-hint">
              opens as <code>{normalized || "—"}</code>
            </div>
          )}
        </form>
      </main>
    </div>
  );
}
