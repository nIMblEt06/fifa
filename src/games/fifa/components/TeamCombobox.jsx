import { useState, useRef, useEffect, useMemo } from "react";

const LEAGUE_PRIORITY = [
  "English Premier League",
  "Spanish La Liga",
  "Italian Serie A",
  "German Bundesliga",
  "French Ligue 1",
  "Portuguese Primeira Liga",
  "Dutch Eredivisie",
  "American Major League Soccer",
  "Brazilian Serie A",
];

export default function TeamCombobox({ teams, value, onChange, taken, placeholder = "Search teams or leagues…" }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [activeLeague, setActiveLeague] = useState(null); // null = league index view
  const wrapRef = useRef(null);
  const listRef = useRef(null);

  const reset = (q = "", lg = activeLeague) => {
    setQuery(q);
    setActiveIdx(0);
    setActiveLeague(lg);
  };

  const selected = useMemo(
    () => (value ? teams.find((t) => t.name === value) : null),
    [teams, value]
  );

  // Group teams by league, ordered by priority then alphabetically.
  const leagues = useMemo(() => {
    const groups = new Map();
    for (const t of teams) {
      const k = t.league || "Other";
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(t);
    }
    const list = [...groups.entries()].map(([name, items]) => ({
      name,
      count: items.length,
      teams: items.slice().sort((a, b) => a.name.localeCompare(b.name)),
    }));
    list.sort((a, b) => {
      const pa = LEAGUE_PRIORITY.indexOf(a.name);
      const pb = LEAGUE_PRIORITY.indexOf(b.name);
      if (pa !== -1 || pb !== -1) {
        if (pa === -1) return 1;
        if (pb === -1) return -1;
        return pa - pb;
      }
      return a.name.localeCompare(b.name);
    });
    return list;
  }, [teams]);

  // Decide the current view based on query + activeLeague.
  // - query non-empty       → flat search across all teams (or within activeLeague if set)
  // - query empty + no lg   → league index
  // - query empty + lg      → teams in that league
  const view = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q) {
      const pool = activeLeague
        ? (leagues.find((l) => l.name === activeLeague)?.teams || [])
        : teams;
      const matches = pool
        .filter((t) =>
          t.name.toLowerCase().includes(q) ||
          (t.short || "").toLowerCase().includes(q) ||
          (t.country || "").toLowerCase().includes(q)
        )
        .slice(0, 80);
      return { mode: "teams", items: matches, capped: matches.length === 80 };
    }
    if (activeLeague) {
      const lg = leagues.find((l) => l.name === activeLeague);
      return { mode: "teams", items: lg ? lg.teams : [], capped: false };
    }
    return { mode: "leagues", items: leagues, capped: false };
  }, [query, activeLeague, leagues, teams]);

  // Close on outside click
  useEffect(() => {
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    if (open) document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Scroll active row into view
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.children[activeIdx];
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
  }, [activeIdx, open, view.mode, view.items.length]);

  const selectTeam = (team) => {
    onChange(team.name);
    setOpen(false);
    reset("", null);
  };

  const enterLeague = (lg) => {
    setActiveLeague(lg.name);
    setQuery("");
    setActiveIdx(0);
  };

  const exitLeague = () => {
    setActiveLeague(null);
    setQuery("");
    setActiveIdx(0);
  };

  const onKey = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      setActiveIdx(Math.min(view.items.length - 1, activeIdx + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx(Math.max(0, activeIdx - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = view.items[activeIdx];
      if (!pick) return;
      if (view.mode === "leagues") enterLeague(pick);
      else if (!(taken && taken.has(pick.name) && pick.name !== value)) selectTeam(pick);
    } else if (e.key === "Escape") {
      if (query) reset("");
      else if (activeLeague) exitLeague();
      else setOpen(false);
    }
  };

  return (
    <div className="combobox" ref={wrapRef}>
      <button
        type="button"
        className={"combo-trigger " + (selected ? "has-value" : "")}
        onClick={() => { setOpen(!open); reset("", null); }}
      >
        {selected ? (
          <>
            {selected.badge && <img src={selected.badge} alt="" className="badge" />}
            <span className="combo-name">{selected.name}</span>
            <span className="combo-meta">{selected.league}</span>
          </>
        ) : (
          <span className="combo-placeholder">— Pick a team —</span>
        )}
        <span className="combo-caret">▾</span>
      </button>

      {open && (
        <div className="combo-panel">
          <input
            autoFocus
            className="combo-search"
            placeholder={activeLeague ? `Search in ${activeLeague}…` : placeholder}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActiveIdx(0); }}
            onKeyDown={onKey}
          />

          {(activeLeague || query) && (
            <div className="combo-crumbs">
              {activeLeague ? (
                <button type="button" className="combo-crumb" onClick={exitLeague}>← All leagues</button>
              ) : (
                <span className="combo-crumb-label">Searching across all leagues</span>
              )}
              {activeLeague && <span className="combo-crumb-current">{activeLeague}</span>}
            </div>
          )}

          <div className="combo-list" ref={listRef}>
            {view.items.length === 0 && (
              <div className="combo-empty">No matches</div>
            )}
            {view.mode === "leagues" && view.items.map((lg, i) => (
              <button
                type="button"
                key={lg.name}
                className={"combo-row league-row " + (i === activeIdx ? "active" : "")}
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => enterLeague(lg)}
              >
                <span className="combo-name">{lg.name}</span>
                <span className="combo-meta">{lg.count} teams</span>
                <span className="combo-caret">›</span>
              </button>
            ))}
            {view.mode === "teams" && view.items.map((t, i) => {
              const isTaken = taken && taken.has(t.name) && t.name !== value;
              return (
                <button
                  type="button"
                  key={t.id}
                  className={"combo-row " + (i === activeIdx ? "active " : "") + (isTaken ? "taken" : "")}
                  onMouseEnter={() => setActiveIdx(i)}
                  onClick={() => !isTaken && selectTeam(t)}
                  disabled={isTaken}
                >
                  {t.badge && <img src={t.badge} alt="" className="badge" />}
                  <span className="combo-name">{t.name}</span>
                  <span className="combo-meta">{query ? t.league : (t.country || "")}</span>
                  {isTaken && <span className="combo-taken">TAKEN</span>}
                </button>
              );
            })}
          </div>
          {view.capped && (
            <div className="combo-foot">Showing first 80 — keep typing to narrow</div>
          )}
        </div>
      )}
    </div>
  );
}
