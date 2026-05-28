import MatchCard from "./MatchCard";

function ChampionBanner({ champion, players, teamsByName }) {
  if (champion == null) return null;
  const badge = teamsByName?.get(players[champion].team)?.badge;
  return (
    <div className="champion-banner">
      <h2>Champion</h2>
      {badge && <img src={badge} alt="" className="badge xl" />}
      <div className="champion-name">{players[champion].name}</div>
      <div className="champion-team">{players[champion].team}</div>
    </div>
  );
}

export default function KnockoutBracket({
  rounds,
  semiFinals,
  final,
  players,
  teamsByName,
  onOpenMatch,
  champion,
}) {
  // Generalized multi-round bracket (group format).
  if (rounds) {
    return (
      <section className="knockout">
        <div className="label">
          <span>Knockouts</span>
          <span className="label-num">{rounds[0]?.matches.length * 2 || 0}-TEAM BRACKET</span>
        </div>

        {rounds.map((round) => (
          <div key={round.name} className="bracket-round">
            <h3>{round.name}</h3>
            <div className="matches-grid">
              {round.matches.map((match) => (
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
        ))}

        <ChampionBanner champion={champion} players={players} teamsByName={teamsByName} />
      </section>
    );
  }

  // Legacy single-group semis + final.
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

      <ChampionBanner champion={champion} players={players} teamsByName={teamsByName} />
    </section>
  );
}
