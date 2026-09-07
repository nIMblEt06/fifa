import { useState } from "react";
import { isActive } from "../utils/filters";

function ChipRow({ title, group, facets, selected, onToggle }) {
  if (facets.length === 0) return null;
  return (
    <div className="song-chip-group">
      <span className="song-chip-title">{title}</span>
      <div className="song-chips">
        {facets.map((f) => (
          <button
            key={f.id}
            className={"song-chip " + (selected.includes(f.id) ? "on" : "")}
            aria-pressed={selected.includes(f.id)}
            onClick={() => onToggle(group, f.id)}
            title={`${f.count} song${f.count === 1 ? "" : "s"}`}
          >
            {f.label}
            <span className="song-chip-count">{f.count}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function FilterBar({
  facets,
  filters,
  poolSize,
  total,
  progress,
  onToggle,
  onClear,
}) {
  const [open, setOpen] = useState(false);
  const active = isActive(filters);
  const count =
    filters.decades.length + filters.genres.length + filters.popularity.length;

  return (
    <section className="song-filters">
      <div className="song-filters-head">
        <button
          className="song-link"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          {open ? "Hide filters" : "Filters"}
          {count > 0 && <span className="song-chip-count">{count}</span>}
        </button>
        <span className="song-filters-count">
          {active ? `${poolSize} of ${total} songs` : `${total} songs`}
          {!progress.complete && progress.total > 0 && (
            <span className="song-loading-note">
              {" "}
              · loading {progress.loaded.toLocaleString()} /{" "}
              {progress.total.toLocaleString()}
            </span>
          )}
        </span>
      </div>

      {open && (
        <div className="song-filters-body">
          <ChipRow
            title="Decade"
            group="decades"
            facets={facets.decades}
            selected={filters.decades}
            onToggle={onToggle}
          />
          <ChipRow
            title={progress.genresComplete ? "Genre" : "Genre · still tagging"}
            group="genres"
            facets={facets.genres}
            selected={filters.genres}
            onToggle={onToggle}
          />
          <ChipRow
            title="Popularity"
            group="popularity"
            facets={facets.popularity}
            selected={filters.popularity}
            onToggle={onToggle}
          />

          <div className="song-filters-foot">
            <span className="song-filters-count">
              {poolSize === 0
                ? "No songs match — widen the filters"
                : "Changing a filter draws a new song"}
            </span>
            {active && (
              <button className="song-link" onClick={onClear}>
                Clear all
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
