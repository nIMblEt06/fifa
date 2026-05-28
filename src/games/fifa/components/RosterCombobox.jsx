import { useState, useRef, useEffect, useMemo } from "react";

// Searchable roster picker styled like TeamCombobox. Shows roster members
// filtered by query, hides ones already in the lineup, and offers an explicit
// "+ Add 'foo'" affordance for an unknown name (auto-creates server-side).
export default function RosterCombobox({ roster, taken, onPick, busy = false, placeholder = "Search roster or type a new name…" }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const wrapRef = useRef(null);
  const listRef = useRef(null);

  const takenIds = useMemo(() => new Set(taken || []), [taken]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pool = roster.filter((p) => !takenIds.has(p.id));
    if (!q) return pool.slice(0, 100);
    return pool.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 100);
  }, [roster, takenIds, query]);

  const exactExisting = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return roster.find((p) => p.name.toLowerCase() === q) || null;
  }, [roster, query]);

  // Show "Add new" row when the typed name has no exact match in the full
  // roster (including taken — re-adding the same person doesn't help).
  const canAddNew = query.trim().length > 0 && !exactExisting;

  useEffect(() => {
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    if (open) document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.children[activeIdx];
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
  }, [activeIdx, open, filtered.length]);

  const rowCount = filtered.length + (canAddNew ? 1 : 0);

  const choose = async (idx) => {
    if (idx < filtered.length) {
      const p = filtered[idx];
      onPick({ id: p.id, name: p.name, isNew: false });
    } else if (canAddNew) {
      onPick({ id: null, name: query.trim(), isNew: true });
    }
    setQuery("");
    setActiveIdx(0);
    setOpen(false);
  };

  const onKey = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      setActiveIdx((i) => Math.min(rowCount - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (rowCount > 0) choose(activeIdx);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="combobox roster-combobox" ref={wrapRef}>
      <div className="combo-trigger" onClick={() => setOpen(true)}>
        <input
          className="combo-search inline"
          placeholder={placeholder}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setActiveIdx(0); if (!open) setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKey}
          disabled={busy}
        />
        <span className="combo-caret">▾</span>
      </div>

      {open && (
        <div className="combo-panel">
          <div className="combo-list" ref={listRef}>
            {filtered.length === 0 && !canAddNew && (
              <div className="combo-empty">No matching roster members</div>
            )}
            {filtered.map((p, i) => (
              <button
                type="button"
                key={p.id}
                className={"combo-row " + (i === activeIdx ? "active" : "")}
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => choose(i)}
              >
                <span className="combo-name">{p.name}</span>
              </button>
            ))}
            {canAddNew && (
              <button
                type="button"
                key="add-new"
                className={"combo-row roster-add " + (activeIdx === filtered.length ? "active" : "")}
                onMouseEnter={() => setActiveIdx(filtered.length)}
                onClick={() => choose(filtered.length)}
              >
                <span className="combo-name">+ Add &quot;{query.trim()}&quot;</span>
                <span className="combo-meta">new roster entry</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
