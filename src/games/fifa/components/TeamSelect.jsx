import { useState } from "react";
import TeamCombobox from "./TeamCombobox";

export default function TeamSelect({ playerNames, teams, onConfirm }) {
  const [selections, setSelections] = useState(() => playerNames.map(() => ""));

  const handleChange = (index, team) => {
    setSelections((prev) => {
      const next = [...prev];
      next[index] = team;
      return next;
    });
  };

  const taken = new Set(selections.filter(Boolean));
  const allSelected = selections.every(Boolean);

  return (
    <div className="team-select">
      <h2>Choose Your Teams</h2>
      <div className="team-select-list">
        {playerNames.map((name, i) => (
          <div key={i} className="team-select-row">
            <span className="player-label">{name}</span>
            <TeamCombobox
              teams={teams}
              value={selections[i]}
              onChange={(team) => handleChange(i, team)}
              taken={taken}
            />
          </div>
        ))}
      </div>
      <button
        className="start-btn"
        disabled={!allSelected}
        onClick={() => allSelected && onConfirm(selections)}
      >
        {allSelected ? "Confirm Teams & Start" : "All players must pick a team"}
      </button>
    </div>
  );
}
