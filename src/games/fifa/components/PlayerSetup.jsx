import { useState, useEffect, useCallback } from "react";
import { groupSizes } from "../utils/groups";
import RosterCombobox from "./RosterCombobox";

const GROUP_THRESHOLD = 6;

export default function PlayerSetup({ onStart }) {
  // players: [{ name, rosterId }] — rosterId is null until the server returns one
  // (for newly-created entries, we POST as soon as the user picks "+ Add 'foo'").
  const [players, setPlayers] = useState([]);
  const [matchesPerPlayer, setMatchesPerPlayer] = useState(4);
  const [qualifiersPerGroup, setQualifiersPerGroup] = useState(2);
  const [groupRounds, setGroupRounds] = useState(1);
  const [formatChoice, setFormatChoice] = useState("groups");

  const [roster, setRoster] = useState([]);
  const [rosterError, setRosterError] = useState(null);
  const [adding, setAdding] = useState(false);

  // Fetch the roster on mount. If the endpoint isn't reachable (e.g. someone is
  // running just `vite` without the worker) we still let the page work — names
  // get added as "new" and the tournament just won't be persisted.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/roster");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) setRoster(Array.isArray(data) ? data : []);
      } catch (e) {
        if (!cancelled) setRosterError(e.message);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const pickPlayer = useCallback(async (choice) => {
    // Don't double-add an existing roster entry.
    if (choice.id != null && players.some((p) => p.rosterId === choice.id)) return;
    if (choice.isNew) {
      // Auto-create on the server so we have a rosterId immediately.
      setAdding(true);
      try {
        const res = await fetch("/api/roster", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: choice.name }),
        });
        const data = await res.json();
        if (!res.ok || !data?.id) {
          setRosterError(data?.error || `Failed (${res.status})`);
          return;
        }
        setRoster((prev) => (prev.some((p) => p.id === data.id) ? prev : [...prev, { id: data.id, name: data.name }]));
        setPlayers((prev) => [...prev, { name: data.name, rosterId: data.id }]);
      } catch (e) {
        setRosterError(e.message);
      } finally {
        setAdding(false);
      }
    } else {
      setPlayers((prev) => [...prev, { name: choice.name, rosterId: choice.id }]);
    }
  }, [players]);

  const removePlayer = (index) => {
    setPlayers(players.filter((_, i) => i !== index));
  };

  const N = players.length;
  const groupsAvailable = N >= GROUP_THRESHOLD;
  const isGroups = groupsAvailable && formatChoice === "groups";
  const sizes = isGroups ? groupSizes(N) : [];
  const numGroups = sizes.length;
  const totalQualifiers = qualifiersPerGroup * numGroups;

  const maxM = Math.max(2, N - 1);
  const safeM = Math.min(matchesPerPlayer, maxM);
  const options = Array.from({ length: 5 }, (_, i) => i + 2).filter((n) => n <= maxM);

  const start = () => {
    const names = players.map((p) => p.name);
    const rosterIds = players.map((p) => p.rosterId ?? null);
    if (isGroups) {
      onStart(names, safeM, { format: "groups", qualifiersPerGroup, groupRounds, rosterIds });
    } else {
      onStart(names, safeM, { format: "league", rosterIds });
    }
  };

  return (
    <div className="setup">
      <h2>Add Players</h2>
      <RosterCombobox
        roster={roster}
        taken={players.map((p) => p.rosterId).filter((id) => id != null)}
        onPick={pickPlayer}
        busy={adding}
      />
      {rosterError && (
        <p className="tap-hint" style={{ color: "var(--shame)", marginTop: "0.4rem" }}>
          Roster: {rosterError} — names you add will still work but won&apos;t be saved to Hall of Fame.
        </p>
      )}

      {players.length > 0 && (
        <ul className="player-list">
          {players.map((p, i) => (
            <li key={i}>
              <span>
                {p.name}
                {p.rosterId == null && <span className="roster-unsaved" title="Not in roster"> ·</span>}
              </span>
              <button className="remove-btn" onClick={() => removePlayer(i)}>✕</button>
            </li>
          ))}
        </ul>
      )}

      <p className="player-count">{players.length} player(s) added</p>

      {groupsAvailable && (
        <div className="format-toggle">
          <label>Format</label>
          <div className="segmented" role="radiogroup" aria-label="Tournament format">
            <button
              type="button"
              role="radio"
              aria-checked={formatChoice === "groups"}
              className={"seg-btn " + (formatChoice === "groups" ? "active" : "")}
              onClick={() => setFormatChoice("groups")}
            >
              Groups
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={formatChoice === "league"}
              className={"seg-btn " + (formatChoice === "league" ? "active" : "")}
              onClick={() => setFormatChoice("league")}
            >
              League
            </button>
          </div>
        </div>
      )}

      {isGroups ? (
        <div className="group-config">
          <div className="group-mode-tag">GROUP MODE · {numGroups} GROUPS</div>
          <div className="group-preview">
            {sizes.map((s, i) => (
              <span key={i} className="group-chip">
                {String.fromCharCode(65 + i)}: {s}
              </span>
            ))}
          </div>
          <label>Qualifiers per group</label>
          <div className="qualifier-row">
            <div className="segmented" role="radiogroup" aria-label="Qualifiers per group">
              {[1, 2].map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={n === qualifiersPerGroup}
                  className={"seg-btn " + (n === qualifiersPerGroup ? "active" : "")}
                  onClick={() => setQualifiersPerGroup(n)}
                >
                  {n}
                </button>
              ))}
            </div>
            <span className="match-total">{totalQualifiers} QUALIFY</span>
          </div>
          <label>Matches per pair</label>
          <div className="qualifier-row">
            <div className="segmented" role="radiogroup" aria-label="Matches per pair">
              {[1, 2].map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={n === groupRounds}
                  className={"seg-btn " + (n === groupRounds ? "active" : "")}
                  onClick={() => setGroupRounds(n)}
                >
                  {n}
                </button>
              ))}
            </div>
            <span className="match-total">
              {groupRounds === 2 ? "HOME & AWAY" : "SINGLE LEG"}
            </span>
          </div>
          <p className="tap-hint" style={{ marginTop: "0.4rem", textAlign: "left" }}>
            Each group plays a {groupRounds === 2 ? "double" : "single"} round-robin
            ({groupRounds === 2 ? "every pair plays twice with home/away swapped" : "every pair plays once"}).
            Top {qualifiersPerGroup} advance to a seeded knockout bracket (top seeds get byes).
          </p>
        </div>
      ) : (
        <>
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
              League format — each pair plays once, capped at {maxM} (one match vs every other player).
              {groupsAvailable && " Switch to Groups above to split into round-robin groups + knockout."}
            </p>
          )}
        </>
      )}

      <button
        className="start-btn"
        disabled={N < 4}
        onClick={start}
      >
        {N < 4
          ? `Need at least 4 players (${4 - N} more)`
          : "Start Tournament"}
      </button>
    </div>
  );
}
