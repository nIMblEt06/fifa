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

const CUR_SYM = { INR: "₹", USD: "$", EUR: "€", GBP: "£" };

export default function MatchCard({ match, players, teamsByName, onOpen, isLive, isNext, betting, legLabel }) {
  const home = match.home != null ? players[match.home] : null;
  const away = match.away != null ? players[match.away] : null;
  const isBye = match.bye;
  // A match is playable only when both slots are filled and it's not a bye.
  const playable = !isBye && home && away;

  // Betting chip — shown when Splitwise is connected and both sides are known.
  const bettable = betting?.active && !isBye && home && away;
  const betSummary = bettable ? betting.summary?.[match.id] : null;
  const kickedOff = bettable && !!betting.kicked?.[match.id]?.kickedOffAt;
  const sym = CUR_SYM[betting?.currency] || "";
  let chipLabel = null;
  let chipCls = "";
  if (bettable) {
    if (match.completed) {
      if (betSummary?.pool) { chipLabel = "SETTLE BETS"; chipCls = "settle"; }
    } else if (kickedOff) {
      chipLabel = "BETS LOCKED"; chipCls = "locked";
    } else if (betSummary?.pool) {
      chipLabel = `POOL ${sym}${betSummary.pool.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
    } else {
      chipLabel = "+ BET";
    }
  }

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
      {legLabel && <span className="match-leg-tag">{legLabel}</span>}
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
      {chipLabel && (
        <button
          type="button"
          className={"match-bet-chip " + chipCls}
          onClick={(e) => { e.stopPropagation(); betting.onOpen(match); }}
        >
          {chipLabel}
        </button>
      )}
    </div>
  );
}
