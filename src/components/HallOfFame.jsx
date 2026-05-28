import { useEffect, useState, useMemo } from "react";

// Hub-level Hall of Fame: cross-room career stats for FIFA tournaments.
// Three panes (Leaderboards / Players / Tournaments) backed by /api/stats/*
// and /api/tournaments. Read-only.

const fmtDate = (ms) => {
  if (!ms) return "—";
  try { return new Date(Number(ms)).toLocaleDateString(); } catch { return "—"; }
};

function Leaderboards({ data }) {
  if (!data) return <div className="hof-loading">Loading leaderboards…</div>;
  const blocks = [
    { key: "championships", title: "🏆 Championships",  unit: "" },
    { key: "wins",          title: "✅ Wins",            unit: "" },
    { key: "goalsFor",      title: "⚽ Goals scored",    unit: "" },
    { key: "winRate",       title: "📈 Win % (min 5 matches)", unit: "%" },
    { key: "matchesPlayed", title: "🎮 Matches played",  unit: "" },
  ];
  return (
    <div className="hof-grid">
      {blocks.map((b) => (
        <div key={b.key} className="hof-card">
          <div className="hof-card-title">{b.title}</div>
          {(data[b.key] || []).length === 0 ? (
            <div className="hof-empty">No data yet</div>
          ) : (
            <ol className="hof-rank-list">
              {data[b.key].map((row, i) => (
                <li key={row.id}>
                  <span className="hof-rank">{i + 1}.</span>
                  <span className="hof-name">{row.name}</span>
                  <span className="hof-value">{row.value}{b.unit}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      ))}
    </div>
  );
}

function PlayerDetail({ playerId, onBack }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const res = await fetch(`/api/stats/player/${playerId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = await res.json();
        if (!cancel) setData(d);
      } catch (e) {
        if (!cancel) setError(e.message);
      }
    })();
    return () => { cancel = true; };
  }, [playerId]);

  if (error) return <div className="hof-empty">Couldn&apos;t load: {error}</div>;
  if (!data) return <div className="hof-loading">Loading player…</div>;
  const t = data.totals || {};
  return (
    <div className="hof-player">
      <button className="poker-btn" onClick={onBack}>← Back to roster</button>
      <h3 className="hof-player-name">{data.player.name}</h3>
      <div className="hof-player-totals">
        <div><span className="hof-total-label">Trophies</span><span className="hof-total-val">{data.championships}</span></div>
        <div><span className="hof-total-label">Runners-up</span><span className="hof-total-val">{data.runnerUps}</span></div>
        <div><span className="hof-total-label">Tournaments</span><span className="hof-total-val">{t.tournaments || 0}</span></div>
        <div><span className="hof-total-label">W / D / L</span><span className="hof-total-val">{t.wins || 0} / {t.draws || 0} / {t.losses || 0}</span></div>
        <div><span className="hof-total-label">Goals (for/against)</span><span className="hof-total-val">{t.goals_for || 0} / {t.goals_against || 0}</span></div>
      </div>

      <div className="hof-card-title" style={{ marginTop: "1rem" }}>Recent tournaments</div>
      {data.recent.length === 0 ? (
        <div className="hof-empty">No tournaments yet</div>
      ) : (
        <table className="hof-table">
          <thead><tr><th>Date</th><th>Format</th><th>Team</th><th>Stage</th><th>W-D-L</th><th>GF</th><th>GA</th></tr></thead>
          <tbody>
            {data.recent.map((r) => {
              const stage =
                r.final_rank === 1 ? "🏆 Champion" :
                r.final_rank === 2 ? "🥈 Runner-up" :
                r.reached_stage ? r.reached_stage.charAt(0).toUpperCase() + r.reached_stage.slice(1) :
                "—";
              const format = (r.format || "").toUpperCase();
              return (
                <tr key={r.id}>
                  <td>{fmtDate(r.ended_at)}</td>
                  <td>{format}{r.num_players ? ` · ${r.num_players}P` : ""}</td>
                  <td>{r.team_name || "—"}</td>
                  <td>{stage}</td>
                  <td>{r.wins}-{r.draws}-{r.losses}</td>
                  <td>{r.goals_for}</td>
                  <td>{r.goals_against}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Players({ roster }) {
  const [selectedId, setSelectedId] = useState(null);
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return roster;
    return roster.filter((p) => p.name.toLowerCase().includes(q));
  }, [roster, query]);
  if (selectedId) {
    return <PlayerDetail playerId={selectedId} onBack={() => setSelectedId(null)} />;
  }
  return (
    <div>
      <input
        className="hof-search"
        placeholder="Search players…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <ul className="hof-player-grid">
        {filtered.map((p) => (
          <li key={p.id}>
            <button className="hof-player-tile" onClick={() => setSelectedId(p.id)}>{p.name}</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Tournaments({ list }) {
  if (!list) return <div className="hof-loading">Loading…</div>;
  if (list.length === 0) return <div className="hof-empty">No tournaments yet — go play one.</div>;
  return (
    <table className="hof-table">
      <thead><tr><th>Date</th><th>Room</th><th>Format</th><th>Players</th><th>🏆 Champion</th><th>🥈 Runner-up</th></tr></thead>
      <tbody>
        {list.map((t) => (
          <tr key={t.id}>
            <td>{fmtDate(t.ended_at)}</td>
            <td>{t.room_code}</td>
            <td>{(t.format || "").toUpperCase()}{t.group_rounds === 2 ? " · 2-LEG" : ""}{t.qualifiers ? ` · TOP ${t.qualifiers}` : ""}</td>
            <td>{t.num_players}</td>
            <td>{t.champion_name || "—"}</td>
            <td>{t.runner_up_name || "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function HallOfFame({ onLeave }) {
  const [tab, setTab] = useState("leaderboards"); // leaderboards | players | tournaments
  const [leaderboards, setLeaderboards] = useState(null);
  const [roster, setRoster] = useState([]);
  const [tournaments, setTournaments] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const [lbRes, rosRes, tRes] = await Promise.all([
          fetch("/api/stats/leaderboards"),
          fetch("/api/roster"),
          fetch("/api/tournaments?limit=30"),
        ]);
        if (!lbRes.ok || !rosRes.ok || !tRes.ok) throw new Error("Failed to load");
        const [lb, ros, tns] = await Promise.all([lbRes.json(), rosRes.json(), tRes.json()]);
        if (cancel) return;
        setLeaderboards(lb);
        setRoster(Array.isArray(ros) ? ros : []);
        setTournaments(Array.isArray(tns) ? tns : []);
      } catch (e) {
        if (!cancel) setError(e.message);
      }
    })();
    return () => { cancel = true; };
  }, []);

  return (
    <div className="app">
      <header className="masthead">
        <h1>HALL<span className="slash">/</span>OF FAME</h1>
        <div className="masthead-meta">
          {onLeave && (
            <button className="room" onClick={onLeave} title="Back to hub">← HUB</button>
          )}
        </div>
      </header>
      <main>
        <div className="hof-tabs">
          {[
            ["leaderboards", "Leaderboards"],
            ["players", "Players"],
            ["tournaments", "Tournaments"],
          ].map(([key, label]) => (
            <button
              key={key}
              className={"seg-btn " + (tab === key ? "active" : "")}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>

        {error && <div className="poker-warn">Couldn&apos;t load: {error}</div>}

        {tab === "leaderboards" && <Leaderboards data={leaderboards} />}
        {tab === "players" && <Players roster={roster} />}
        {tab === "tournaments" && <Tournaments list={tournaments} />}
      </main>
    </div>
  );
}
