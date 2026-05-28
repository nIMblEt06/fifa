import { useEffect, useState } from "react";
import TeamCombobox from "./TeamCombobox";
import RosterCombobox from "./RosterCombobox";

// Controlled. Selections + the participant list are mirrored to the shared
// room state, so any participant on the link can pick a team for any slot
// and any picks are visible to everyone live. Per-row pencil/× let you
// substitute a drop-out before the draw.
export default function TeamSelect({
  playerNames,
  rosterIds = [],
  selections = [],
  teams,
  onPick,
  onReplace,
  onRemove,
  onConfirm,
}) {
  // Roster is fetched on mount; if /api/roster fails we still let team
  // selection work, only the swap-player affordance is disabled.
  const [roster, setRoster] = useState([]);
  const [rosterReady, setRosterReady] = useState(false);
  const [editing, setEditing] = useState(null); // row index currently swapping
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/roster");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) {
          setRoster(Array.isArray(data) ? data : []);
          setRosterReady(true);
        }
      } catch {
        if (!cancelled) setRosterReady(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const padded = playerNames.map((_, i) => selections[i] || "");
  const allSelected = padded.every(Boolean);

  const handlePickRoster = async (i, choice) => {
    if (choice.isNew) {
      setBusy(true);
      try {
        const res = await fetch("/api/roster", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: choice.name }),
        });
        const data = await res.json();
        if (!res.ok || !data?.id) return;
        setRoster((prev) => (prev.some((p) => p.id === data.id) ? prev : [...prev, { id: data.id, name: data.name }]));
        onReplace(i, { name: data.name, rosterId: data.id });
      } finally {
        setBusy(false);
        setEditing(null);
      }
    } else {
      // Avoid double-adding an existing roster entry into a different slot.
      if (rosterIds.some((id, idx) => id === choice.id && idx !== i)) {
        setEditing(null);
        return;
      }
      onReplace(i, { name: choice.name, rosterId: choice.id });
      setEditing(null);
    }
  };

  return (
    <div className="team-select">
      <h2>Choose Your Teams</h2>
      <p className="team-select-hint">
        Anyone on the link can pick. Multiple players can choose the same team —
        we&apos;ll try to keep duplicates out of the same group.
      </p>
      <div className="team-select-list">
        {playerNames.map((name, i) => {
          const isEditing = editing === i;
          return (
            <div key={i} className="team-select-row">
              {isEditing && rosterReady ? (
                <div className="team-select-swap">
                  <RosterCombobox
                    roster={roster}
                    taken={rosterIds.filter((id, idx) => id != null && idx !== i)}
                    onPick={(choice) => handlePickRoster(i, choice)}
                    busy={busy}
                    placeholder={`Replace ${name}…`}
                  />
                  <button
                    type="button"
                    className="row-icon-btn"
                    onClick={() => setEditing(null)}
                    title="Cancel"
                  >×</button>
                </div>
              ) : (
                <>
                  <span className="player-label">{name}</span>
                  <TeamCombobox
                    teams={teams}
                    value={padded[i]}
                    onChange={(team) => onPick(i, team)}
                    /* duplicates allowed — no `taken` set */
                  />
                  <div className="row-actions">
                    {rosterReady && onReplace && (
                      <button
                        type="button"
                        className="row-icon-btn"
                        title="Replace this player"
                        onClick={() => setEditing(i)}
                      >✎</button>
                    )}
                    {onRemove && playerNames.length > 2 && (
                      <button
                        type="button"
                        className="row-icon-btn"
                        title="Remove this player"
                        onClick={() => { if (window.confirm(`Remove ${name} from the lobby?`)) onRemove(i); }}
                      >×</button>
                    )}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
      <button
        className="start-btn"
        disabled={!allSelected}
        onClick={() => allSelected && onConfirm(padded)}
      >
        {allSelected ? "Confirm Teams & Start" : "All players must pick a team"}
      </button>
    </div>
  );
}
