function Slot({ player, teamsByName, side }) {
  const badge = player ? teamsByName?.get(player.team)?.badge : null;
  const text = player ? (
    <div className="match-team-text">
      <span className="player-name">{player.name}</span>
      <span className="team-name">{player.team}</span>
    </div>
  ) : (
    <div className="match-team-text">
      <span className="player-name tbd">TBD</span>
      <span className="team-name">awaiting result</span>
    </div>
  );
  return side === "home" ? (
    <div className="match-team home">
      {badge && <img src={badge} alt="" className="badge sm" />}
      {text}
    </div>
  ) : (
    <div className="match-team away">
      {text}
      {badge && <img src={badge} alt="" className="badge sm" />}
    </div>
  );
}

export default function MatchCard({ match, players, teamsByName, onOpen, isLive, isNext }) {
  const home = match.home != null ? players[match.home] : null;
  const away = match.away != null ? players[match.away] : null;
  const isBye = match.bye;
  // A match is playable only when both slots are filled and it's not a bye.
  const playable = !isBye && home && away;

  const homeWin = match.completed && (isBye ? home : match.homeScore > match.awayScore);
  const awayWin = match.completed && (isBye ? away : match.awayScore > match.homeScore);

  const cls = [
    "match-card",
    match.completed ? "completed" : "",
    isLive ? "live" : "",
    isNext ? "next-up" : "",
    isBye ? "bye" : "",
    !playable && !match.completed ? "locked" : "",
  ].filter(Boolean).join(" ");

  const open = () => playable && onOpen(match);

  return (
    <div
      className={cls}
      onClick={open}
      role="button"
      tabIndex={playable ? 0 : -1}
      onKeyDown={(e) => playable && (e.key === "Enter" || e.key === " ") && onOpen(match)}
    >
      <Slot player={home} teamsByName={teamsByName} side="home" />
      {isBye ? (
        <div className="score-block bye-tag">BYE</div>
      ) : match.completed ? (
        <div className="score-block">
          <span className={homeWin ? "winner" : ""}>{match.homeScore}</span>
          <span className="dash">—</span>
          <span className={awayWin ? "winner" : ""}>{match.awayScore}</span>
        </div>
      ) : playable ? (
        <div className="score-block pending">Tap to score</div>
      ) : (
        <div className="score-block pending">—</div>
      )}
      <Slot player={away} teamsByName={teamsByName} side="away" />
    </div>
  );
}
