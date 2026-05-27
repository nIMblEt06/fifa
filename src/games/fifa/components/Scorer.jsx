import { useState, useRef, useEffect, useCallback } from "react";

const RANGE = 15; // 0..14 — enough for any FIFA scoreline

function Wheel({ value, onChange }) {
  const ref = useRef(null);
  const lockRef = useRef(false);

  // Scroll programmatically when value changes externally (initial mount)
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = value * 80;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onScroll = useCallback(() => {
    if (lockRef.current) return;
    const el = ref.current;
    if (!el) return;
    const idx = Math.round(el.scrollTop / 80);
    if (idx !== value) onChange(Math.max(0, Math.min(RANGE - 1, idx)));
  }, [value, onChange]);

  return (
    <div className="wheel" ref={ref} onScroll={onScroll}>
      <div className="wheel-inner">
        {Array.from({ length: RANGE }).map((_, i) => (
          <div key={i} className={"wheel-cell " + (i === value ? "active" : "")}>
            {i}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Scorer({ match, players, teamsByName, onSubmit, onClose, noDraws }) {
  const home = players[match.home];
  const away = players[match.away];
  const homeBadge = teamsByName?.get(home.team)?.badge;
  const awayBadge = teamsByName?.get(away.team)?.badge;
  const [h, setH] = useState(match.completed ? match.homeScore : 0);
  const [a, setA] = useState(match.completed ? match.awayScore : 0);

  const drawBlocked = noDraws && h === a;

  // Esc closes
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Enter" && !drawBlocked) onSubmit(match.id, h, a);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [h, a, drawBlocked, match.id, onSubmit, onClose]);

  // Swipe-up gesture on confirm button
  const startY = useRef(null);
  const onTouchStart = (e) => { startY.current = e.touches[0].clientY; };
  const onTouchEnd = (e) => {
    if (startY.current == null) return;
    const dy = startY.current - e.changedTouches[0].clientY;
    startY.current = null;
    if (dy > 30 && !drawBlocked) onSubmit(match.id, h, a);
  };

  return (
    <div className="scorer-overlay" role="dialog" aria-modal="true">
      <button className="scorer-close" onClick={onClose} aria-label="Close">✕</button>
      <div className="scorer-header">
        {match.id.startsWith("group") ? "Group Match" : match.id === "final" ? "The Final" : "Semi-Final"}
        {drawBlocked && " · Knockout — no draws"}
      </div>

      <div className="scorer-stage">
        <div className="scorer-side">
          {homeBadge && <img src={homeBadge} alt="" className="badge lg" />}
          <div className="who">{home.name}</div>
          <div className="what">{home.team}</div>
          <Wheel value={h} onChange={setH} />
        </div>
        <div className="scorer-vs">—</div>
        <div className="scorer-side">
          {awayBadge && <img src={awayBadge} alt="" className="badge lg" />}
          <div className="who">{away.name}</div>
          <div className="what">{away.team}</div>
          <Wheel value={a} onChange={setA} />
        </div>
      </div>

      <button
        className={"scorer-confirm " + (drawBlocked ? "disabled" : "")}
        onClick={() => !drawBlocked && onSubmit(match.id, h, a)}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        disabled={drawBlocked}
      >
        {drawBlocked ? "Need a winner" : `Confirm ${h} — ${a}`}
      </button>
      <div className="scorer-hint">Scroll wheels · swipe up to confirm</div>
    </div>
  );
}
