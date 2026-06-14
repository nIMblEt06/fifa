import MatchCard from "./MatchCard";
import { groupLegTies, tieAggregate } from "../utils/groups";

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

// One two-legged tie: both legs stacked, with the running aggregate below once
// both are played. Single-leg ties (the final, byes, legacy data) render as a
// plain MatchCard via TieGrid.
function TieCard({ tie, players, teamsByName, onOpenMatch, betting }) {
  const agg = tieAggregate(tie);
  const nameOf = (i) => (i != null ? players[i]?.name ?? "TBD" : "TBD");
  return (
    <div className="bracket-tie">
      {tie.legs.map((m, i) => (
        <MatchCard
          key={m.id}
          match={m}
          players={players}
          teamsByName={teamsByName}
          onOpen={onOpenMatch}
          betting={betting}
          legLabel={`Leg ${i + 1}`}
        />
      ))}
      {agg && (
        <div className="tie-agg">
          <span className="tie-agg-label">AGG</span>
          <span className={"tie-agg-side " + (agg.winner === agg.a ? "win" : "")}>
            {nameOf(agg.a)} {agg.aggA}
          </span>
          <span className="tie-agg-dash">–</span>
          <span className={"tie-agg-side " + (agg.winner === agg.b ? "win" : "")}>
            {agg.aggB} {nameOf(agg.b)}
          </span>
          {agg.winner != null && (
            <span className="tie-agg-go">{nameOf(agg.winner)} advance</span>
          )}
        </div>
      )}
    </div>
  );
}

// Render a round's matches as ties — two-legged ones grouped into a TieCard,
// single ones as a lone MatchCard.
function TieGrid({ matches, players, teamsByName, onOpenMatch, betting }) {
  const ties = groupLegTies(matches);
  return (
    <div className="matches-grid">
      {ties.map((tie) =>
        tie.twoLegged ? (
          <TieCard
            key={tie.id}
            tie={tie}
            players={players}
            teamsByName={teamsByName}
            onOpenMatch={onOpenMatch}
            betting={betting}
          />
        ) : (
          <MatchCard
            key={tie.legs[0].id}
            match={tie.legs[0]}
            players={players}
            teamsByName={teamsByName}
            onOpen={onOpenMatch}
            betting={betting}
          />
        )
      )}
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
  betting,
}) {
  // Generalized multi-round bracket (group format).
  if (rounds) {
    const teams = groupLegTies(rounds[0]?.matches || []).length * 2 || 0;
    return (
      <section className="knockout">
        <div className="label">
          <span>Knockouts</span>
          <span className="label-num">{teams}-TEAM BRACKET</span>
        </div>

        {rounds.map((round) => (
          <div key={round.name} className="bracket-round">
            <h3>{round.name}</h3>
            <TieGrid
              matches={round.matches}
              players={players}
              teamsByName={teamsByName}
              onOpenMatch={onOpenMatch}
              betting={betting}
            />
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
        <TieGrid
          matches={semiFinals}
          players={players}
          teamsByName={teamsByName}
          onOpenMatch={onOpenMatch}
          betting={betting}
        />
      </div>

      {final && (
        <div className="bracket-round">
          <h3>The Final</h3>
          <TieGrid
            matches={[final]}
            players={players}
            teamsByName={teamsByName}
            onOpenMatch={onOpenMatch}
            betting={betting}
          />
        </div>
      )}

      <ChampionBanner champion={champion} players={players} teamsByName={teamsByName} />
    </section>
  );
}
