import { useEffect, useMemo, useRef, useState } from "react";
import { searchTracks } from "../utils/library";

// Autocomplete over the player's own library — the answer is always something
// they've saved, so the options list is the whole answer space.
export default function GuessInput({ library, disabled, onGuess, onSkip, skipLabel }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);

  const options = useMemo(() => searchTracks(library, query), [library, query]);

  useEffect(() => {
    const onClick = (e) => {
      if (!boxRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  function choose(track) {
    onGuess(track);
    setQuery("");
    setOpen(false);
  }

  function onKeyDown(e) {
    if (!open || options.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % options.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + options.length) % options.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(options[active]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div className="song-guess-input">
      <div className="song-combo" ref={boxRef}>
        {open && options.length > 0 && (
          <div className="song-options" role="listbox">
            {options.map((t, i) => (
              <button
                key={t.id}
                className={"song-option " + (i === active ? "active" : "")}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(t)}
              >
                <span className="song-option-title">{t.name}</span>
                <span className="song-option-artist">{t.artists}</span>
              </button>
            ))}
          </div>
        )}
        <input
          type="text"
          value={query}
          disabled={disabled}
          placeholder="Search your liked songs…"
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          aria-label="Guess the song"
          autoComplete="off"
        />
      </div>

      <div className="song-btn-row">
        <button className="song-btn" disabled={disabled} onClick={onSkip}>
          {skipLabel}
        </button>
        <button
          className="song-btn primary"
          disabled={disabled || options.length === 0}
          onClick={() => options[active] && choose(options[active])}
        >
          Submit
        </button>
      </div>
    </div>
  );
}
