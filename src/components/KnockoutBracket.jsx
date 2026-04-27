import MatchCard from "./MatchCard";

export default function KnockoutBracket({
  semiFinals,
  final,
  players,
  teamsByName,
  onOpenMatch,
  champion,
}) {
  return (
    <section className="knockout">
      <div className="label">
        <span>Knockouts</span>
        <span className="label-num">FINAL FOUR</span>
      </div>

      <div className="bracket-round">
        <h3>Semi-Finals</h3>
        <div className="matches-grid">
          {semiFinals.map((match) => (
            <MatchCard
              key={match.id}
              match={match}
              players={players}
              teamsByName={teamsByName}
              onOpen={onOpenMatch}
            />
          ))}
        </div>
      </div>

      {final && (
        <div className="bracket-round">
          <h3>The Final</h3>
          <div className="matches-grid">
            <MatchCard
              match={final}
              players={players}
              teamsByName={teamsByName}
              onOpen={onOpenMatch}
            />
          </div>
        </div>
      )}

      {champion != null && (
        <div className="champion-banner">
          <h2>Champion</h2>
          {teamsByName?.get(players[champion].team)?.badge && (
            <img
              src={teamsByName.get(players[champion].team).badge}
              alt=""
              className="badge xl"
            />
          )}
          <div className="champion-name">{players[champion].name}</div>
          <div className="champion-team">{players[champion].team}</div>
        </div>
      )}
    </section>
  );
}
