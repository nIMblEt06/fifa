import { MAX_GUESSES } from "../utils/tokens";
import { averageGuesses, winRate } from "../utils/stats";

// Shown once a round ends, under the reveal. Everything here is derived from
// the running totals in localStorage — there is no per-round history to page
// through, and the distribution is the only shape worth seeing.

function Tile({ label, value, hint }) {
  return (
    <div className="song-stat">
      <span className="song-stat-value">{value}</span>
      <span className="song-stat-label">{label}</span>
      {hint && <span className="song-stat-hint">{hint}</span>}
    </div>
  );
}

export default function StatsPanel({ stats, highlight, onReset }) {
  const peak = Math.max(1, ...stats.dist);
  const avg = averageGuesses(stats);

  return (
    <section className="song-stats">
      <div className="song-stats-head">
        <span className="song-chip-title">Your stats</span>
        {stats.rounds > 0 && (
          <button className="song-link" onClick={onReset}>
            Reset
          </button>
        )}
      </div>

      <div className="song-stat-row">
        <Tile label="Rounds" value={stats.rounds} />
        <Tile label="Solved" value={`${winRate(stats)}%`} hint={`${stats.solved} of ${stats.rounds}`} />
        <Tile label="Streak" value={stats.streak} />
        <Tile label="Best" value={stats.best} />
        <Tile
          label="Avg guess"
          value={avg === 0 ? "–" : avg.toFixed(1)}
          hint="when solved"
        />
      </div>

      <div className="song-dist">
        {Array.from({ length: MAX_GUESSES }, (_, i) => {
          const n = stats.dist[i];
          return (
            <div
              key={i}
              className={"song-dist-row " + (highlight === i + 1 ? "hit" : "")}
            >
              <span className="song-dist-num">{i + 1}</span>
              <div className="song-dist-track">
                <div
                  className="song-dist-bar"
                  style={{ width: `${Math.max(n === 0 ? 0 : 6, (n / peak) * 100)}%` }}
                />
              </div>
              <span className="song-dist-count">{n}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
