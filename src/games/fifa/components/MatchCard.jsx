export default function MatchCard({ match, players, teamsByName, onOpen, isLive, isNext }) {
  const home = players[match.home];
  const away = players[match.away];
  const homeBadge = teamsByName?.get(home.team)?.badge;
  const awayBadge = teamsByName?.get(away.team)?.badge;
  const homeWin = match.completed && match.homeScore > match.awayScore;
  const awayWin = match.completed && match.awayScore > match.homeScore;

  const cls = [
    "match-card",
    match.completed ? "completed" : "",
    isLive ? "live" : "",
    isNext ? "next-up" : "",
  ].filter(Boolean).join(" ");

  return (
    <div
      className={cls}
      onClick={() => onOpen(match)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onOpen(match)}
    >
      <div className="match-team home">
        {homeBadge && <img src={homeBadge} alt="" className="badge sm" />}
        <div className="match-team-text">
          <span className="player-name">{home.name}</span>
          <span className="team-name">{home.team}</span>
        </div>
      </div>
      {match.completed ? (
        <div className="score-block">
          <span className={homeWin ? "winner" : ""}>{match.homeScore}</span>
          <span className="dash">—</span>
          <span className={awayWin ? "winner" : ""}>{match.awayScore}</span>
        </div>
      ) : (
        <div className="score-block pending">Tap to score</div>
      )}
      <div className="match-team away">
        <div className="match-team-text">
          <span className="player-name">{away.name}</span>
          <span className="team-name">{away.team}</span>
        </div>
        {awayBadge && <img src={awayBadge} alt="" className="badge sm" />}
      </div>
    </div>
  );
}
