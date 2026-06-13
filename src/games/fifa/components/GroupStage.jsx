import MatchCard from "./MatchCard";
import StandingsTable from "./StandingsTable";

function SingleGroup({ matches, players, teamsByName, onOpenMatch, betting }) {
  const completed = matches.filter((m) => m.completed).length;
  const total = matches.length;
  const nextIdx = matches.findIndex((m) => !m.completed);

  return (
    <section className="group-stage">
      <div className="label">
        <span>Group Stage</span>
        <span className="label-num">
          {String(completed).padStart(2, "0")} / {String(total).padStart(2, "0")}
        </span>
      </div>
      <div className="matches-grid">
        {matches.map((match, i) => (
          <MatchCard
            key={match.id}
            match={match}
            players={players}
            teamsByName={teamsByName}
            onOpen={onOpenMatch}
            isNext={i === nextIdx}
            betting={betting}
          />
        ))}
      </div>
    </section>
  );
}

export default function GroupStage({
  groups,
  groupStandings,
  qualifiersPerGroup = 2,
  matches,
  players,
  teamsByName,
  onOpenMatch,
  betting,
}) {
  // Single-group legacy path.
  if (!groups) {
    return (
      <SingleGroup
        matches={matches}
        players={players}
        teamsByName={teamsByName}
        onOpenMatch={onOpenMatch}
        betting={betting}
      />
    );
  }

  const totalDone = groups.reduce(
    (n, g) => n + g.matches.filter((m) => m.completed).length,
    0
  );
  const totalMatches = groups.reduce((n, g) => n + g.matches.length, 0);

  return (
    <section className="group-stage">
      <div className="label">
        <span>Group Stage · {groups.length} Groups</span>
        <span className="label-num">
          {String(totalDone).padStart(2, "0")} / {String(totalMatches).padStart(2, "0")}
        </span>
      </div>

      <div className="groups-row">
        {groups.map((g, gi) => {
          const nextIdx = g.matches.findIndex((m) => !m.completed);
          return (
            <div key={g.id} className="group-block">
              <h3 className="group-title">Group {g.id}</h3>
              <div className="matches-grid">
                {g.matches.map((match, i) => (
                  <MatchCard
                    key={match.id}
                    match={match}
                    players={players}
                    teamsByName={teamsByName}
                    onOpen={onOpenMatch}
                    isNext={i === nextIdx}
                    betting={betting}
                  />
                ))}
              </div>
              {groupStandings && (
                <StandingsTable
                  standings={groupStandings[gi]}
                  teamsByName={teamsByName}
                  qualifyCount={qualifiersPerGroup}
                />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
