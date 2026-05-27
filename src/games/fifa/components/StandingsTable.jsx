export default function StandingsTable({ standings, teamsByName, qualifyCount = 4 }) {
  return (
    <section className="standings">
      <div className="standings-head">
        <span>Table</span>
        <span className="qualify-note">TOP {qualifyCount} ADVANCE</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Player</th>
            <th>P</th>
            <th>W</th>
            <th>D</th>
            <th>L</th>
            <th>GF</th>
            <th>GA</th>
            <th>GD</th>
            <th>Pts</th>
          </tr>
        </thead>
        <tbody>
          {standings.map((s, i) => {
            const badge = teamsByName?.get(s.team)?.badge;
            return (
              <tr key={s.playerIndex} className={i < qualifyCount ? "qualified" : ""}>
                <td>{i + 1}</td>
                <td>
                  <span className="standings-player">
                    {badge && <img src={badge} alt="" className="badge xs" />}
                    {s.name}
                  </span>
                </td>
                <td>{s.played}</td>
                <td>{s.won}</td>
                <td>{s.drawn}</td>
                <td>{s.lost}</td>
                <td>{s.gf}</td>
                <td>{s.ga}</td>
                <td>{s.gd >= 0 ? `+${s.gd}` : s.gd}</td>
                <td className="pts">{s.pts}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
