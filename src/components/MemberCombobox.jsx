import { useState, useRef, useEffect, useMemo } from "react";

export default function MemberCombobox({ members, value, onChange, placeholder = "Search members…" }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const wrapRef = useRef(null);
  const listRef = useRef(null);

  const selected = useMemo(
    () => (value ? members.find((m) => String(m.id) === String(value)) : null),
    [members, value]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return members;
    return members.filter((m) => m.name.toLowerCase().includes(q));
  }, [members, query]);

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

  const pick = (m) => {
    onChange(String(m.id));
    setOpen(false);
    setQuery("");
  };

  const onKey = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const m = filtered[activeIdx];
      if (m) pick(m);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="combobox" ref={wrapRef}>
      <button
        type="button"
        className={"combo-trigger " + (selected ? "has-value" : "")}
        onClick={() => { setOpen(!open); setQuery(""); setActiveIdx(0); }}
      >
        {selected ? (
          <span className="combo-name">{selected.name}</span>
        ) : (
          <span className="combo-placeholder">— Pick member —</span>
        )}
        <span className="combo-caret">▾</span>
      </button>

      {open && (
        <div className="combo-panel">
          <input
            autoFocus
            className="combo-search"
            placeholder={placeholder}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActiveIdx(0); }}
            onKeyDown={onKey}
          />
          <div className="combo-list" ref={listRef}>
            {filtered.length === 0 && <div className="combo-empty">No matches</div>}
            {filtered.map((m, i) => (
              <button
                type="button"
                key={m.id}
                className={"combo-row " + (i === activeIdx ? "active" : "")}
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => pick(m)}
              >
                <span className="combo-name">{m.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
