import MatchCard from "./MatchCard";

export default function GroupStage({ matches, players, teamsByName, onOpenMatch }) {
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
          />
        ))}
      </div>
    </section>
  );
}
