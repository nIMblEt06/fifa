import { useState } from "react";

export default function PlayerSetup({ onStart }) {
  const [name, setName] = useState("");
  const [players, setPlayers] = useState([]);
  const [matchesPerPlayer, setMatchesPerPlayer] = useState(4);

  const addPlayer = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (players.includes(trimmed)) return;
    setPlayers([...players, trimmed]);
    setName("");
  };

  const removePlayer = (index) => {
    setPlayers(players.filter((_, i) => i !== index));
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") addPlayer();
  };

  const N = players.length;
  const maxM = Math.max(2, N - 1);
  const safeM = Math.min(matchesPerPlayer, maxM);
  const options = Array.from({ length: 5 }, (_, i) => i + 2).filter((n) => n <= maxM);

  return (
    <div className="setup">
      <h2>Add Players</h2>
      <div className="input-row">
        <input
          type="text"
          placeholder="Player name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button onClick={addPlayer}>Add</button>
      </div>

      {players.length > 0 && (
        <ul className="player-list">
          {players.map((p, i) => (
            <li key={i}>
              <span>{p}</span>
              <button className="remove-btn" onClick={() => removePlayer(i)}>✕</button>
            </li>
          ))}
        </ul>
      )}

      <p className="player-count">{players.length} player(s) added</p>

      <div className="matches-config">
        <label>Matches per player</label>
        <div className="segmented" role="radiogroup" aria-label="Matches per player">
          {options.map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={n === safeM}
              className={"seg-btn " + (n === safeM ? "active" : "")}
              onClick={() => setMatchesPerPlayer(n)}
            >
              {n}
            </button>
          ))}
        </div>
        {N >= 4 && (
          <span className="match-total">
            {Math.floor((N * safeM) / 2)} TOTAL
          </span>
        )}
      </div>
      {N >= 2 && (
        <p className="tap-hint" style={{ marginTop: "-0.4rem", marginBottom: "1.25rem", textAlign: "left" }}>
          Each pair plays once — capped at {maxM} (one match vs every other player).
        </p>
      )}

      <button
        className="start-btn"
        disabled={N < 4}
        onClick={() => onStart(players, safeM)}
      >
        {N < 4
          ? `Need at least 4 players (${4 - N} more)`
          : "Start Tournament"}
      </button>
    </div>
  );
}
