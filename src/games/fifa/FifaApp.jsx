import { useState, useMemo, useCallback, useRef } from "react";
import PlayerSetup from "./components/PlayerSetup";
import TeamSelect from "./components/TeamSelect";
import GroupStage from "./components/GroupStage";
import StandingsTable from "./components/StandingsTable";
import KnockoutBracket from "./components/KnockoutBracket";
import Scorer from "./components/Scorer";
import WallOfShame from "./components/WallOfShame";
import Marquee from "../../components/Marquee";
import Reactions from "../../components/Reactions";
import { generateFixtures, computeStandings } from "./utils/fixtures";
import {
  splitIntoGroups,
  seedQualifiers,
  buildKnockout,
  advanceKnockout,
} from "./utils/groups";
import { buildHeadlines, buildShame } from "./utils/headlines";
import { useTeams } from "./utils/useTeams";
import { shareUrl } from "../../utils/room";
import { useRoom } from "../../utils/useRoom";

const PHASES = {
  SETUP: "setup",
  TEAM_SELECT: "team_select",
  GROUP: "group",
  KNOCKOUT: "knockout",
};

const GROUP_THRESHOLD = 6; // N >= this → multi-group format

function emptyState() {
  return {
    phase: PHASES.SETUP,
    playerNames: [],
    format: "single", // "single" | "groups"
    matchesPerPlayer: 4, // single only
    qualifiersPerGroup: 2, // groups only
    groupRounds: 1, // groups only — 1 = single round-robin, 2 = home & away
    players: [],
    groups: [], // groups: [{ id, playerIndexes, matches }]
    groupMatches: [], // single (unchanged)
    semiFinals: [], // single legacy knockout
    finalMatch: null, // single legacy knockout
    knockout: { rounds: [] }, // groups: generalized rounds
    champion: null,
  };
}

export default function FifaApp({ code, onLeave }) {
  const { state: remoteState, presence, reactions, sendState, sendReaction, connected } = useRoom(code);
  const { teams, byName: teamsByName } = useTeams();

  const state = { ...emptyState(), ...(remoteState ?? {}) };

  const update = useCallback(
    (patch) => {
      const base = { ...emptyState(), ...(remoteState ?? {}) };
      const next = typeof patch === "function" ? patch(base) : { ...base, ...patch };
      sendState(next);
    },
    [remoteState, sendState]
  );

  const {
    phase,
    playerNames,
    format,
    matchesPerPlayer,
    qualifiersPerGroup,
    groupRounds,
    players,
    groups,
    groupMatches,
    semiFinals,
    finalMatch,
    knockout,
    champion,
  } = state;

  const isGroups = format === "groups";

  // ---- Single-format standings (unchanged) ----
  const standings = useMemo(
    () => (players.length > 0 ? computeStandings(players, groupMatches) : []),
    [players, groupMatches]
  );

  // ---- Group-format per-group standings ----
  const groupStandings = useMemo(() => {
    if (!isGroups) return [];
    return groups.map((g) => {
      const member = new Set(g.playerIndexes);
      return computeStandings(players, g.matches).filter((s) => member.has(s.playerIndex));
    });
  }, [isGroups, groups, players]);

  // All group matches across every group (for completion checks + shame/headlines).
  const allGroupMatches = useMemo(
    () => (isGroups ? groups.flatMap((g) => g.matches) : groupMatches),
    [isGroups, groups, groupMatches]
  );

  const allGroupDone = allGroupMatches.length > 0 && allGroupMatches.every((m) => m.completed);

  // Aggregate standings for the aside table (groups: combine all group standings).
  const asideStandings = useMemo(() => {
    if (!isGroups) return standings;
    return groupStandings.flat();
  }, [isGroups, standings, groupStandings]);

  const knockoutMatches = useMemo(() => {
    if (isGroups) return knockout.rounds.flatMap((r) => r.matches);
    const km = [...semiFinals];
    if (finalMatch) km.push(finalMatch);
    return km;
  }, [isGroups, knockout, semiFinals, finalMatch]);

  const allMatches = useMemo(
    () => [...allGroupMatches, ...knockoutMatches],
    [allGroupMatches, knockoutMatches]
  );

  const headlines = useMemo(
    () => buildHeadlines(players, allMatches, asideStandings),
    [players, allMatches, asideStandings]
  );
  const shame = useMemo(() => buildShame(players, allMatches), [players, allMatches]);

  const [openMatch, setOpenMatch] = useState(null);

  const handleStart = (names, mpp, opts = {}) => {
    // Format comes from PlayerSetup's explicit toggle. Fall back to auto so
    // older callers / stored states still work.
    const chosen = opts.format
      ? (opts.format === "groups" ? "groups" : "single")
      : (names.length >= GROUP_THRESHOLD ? "groups" : "single");
    update({
      phase: PHASES.TEAM_SELECT,
      playerNames: names,
      format: chosen,
      matchesPerPlayer: mpp,
      qualifiersPerGroup: opts.qualifiersPerGroup ?? 2,
      groupRounds: opts.groupRounds === 2 ? 2 : 1,
    });
  };

  const handleTeamsConfirmed = (teamSelections) => {
    const assigned = playerNames.map((name, i) => ({ name, team: teamSelections[i] }));

    if (isGroups) {
      const built = splitIntoGroups(assigned.map((_, i) => i), undefined, groupRounds);
      if (built.length === 0) {
        window.alert("Could not split players into groups. Try a different player count.");
        return;
      }
      update({ players: assigned, groups: built, phase: PHASES.GROUP });
      return;
    }

    const fixtures = generateFixtures(playerNames.length, matchesPerPlayer);
    if (fixtures.length === 0) {
      window.alert("Could not build a fixture list with this configuration. Try a different match count.");
      return;
    }
    const matches = fixtures.map((f, i) => ({
      id: `group-${i}`,
      home: f.home,
      away: f.away,
      homeScore: 0,
      awayScore: 0,
      completed: false,
    }));
    update({ players: assigned, groupMatches: matches, phase: PHASES.GROUP });
  };

  const handleScoreSubmit = (matchId, h, a) => {
    if (matchId.startsWith("ko-")) {
      // Generalized group-format knockout.
      update((prev) => {
        let rounds = prev.knockout.rounds.map((r) => ({
          ...r,
          matches: r.matches.map((m) =>
            m.id === matchId ? { ...m, homeScore: h, awayScore: a, completed: true } : m
          ),
        }));
        // Advance as far as possible (build subsequent rounds / crown champion).
        let champ = prev.champion;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const res = advanceKnockout(rounds);
          if (res.champion != null) {
            champ = res.champion;
            rounds = res.rounds;
            break;
          }
          if (res.rounds === rounds) break; // nothing changed
          rounds = res.rounds;
        }
        return { ...prev, knockout: { rounds }, champion: champ };
      });
      setOpenMatch(null);
      return;
    }

    if (matchId.startsWith("group")) {
      update((prev) => {
        if (prev.format === "groups") {
          return {
            ...prev,
            groups: prev.groups.map((g) => ({
              ...g,
              matches: g.matches.map((m) =>
                m.id === matchId ? { ...m, homeScore: h, awayScore: a, completed: true } : m
              ),
            })),
          };
        }
        return {
          ...prev,
          groupMatches: prev.groupMatches.map((m) =>
            m.id === matchId ? { ...m, homeScore: h, awayScore: a, completed: true } : m
          ),
        };
      });
    } else if (matchId.startsWith("semi")) {
      update((prev) => {
        const updatedSemis = prev.semiFinals.map((m) =>
          m.id === matchId ? { ...m, homeScore: h, awayScore: a, completed: true } : m
        );
        let newFinal = prev.finalMatch;
        if (updatedSemis.every((m) => m.completed)) {
          const w0 = updatedSemis[0].homeScore > updatedSemis[0].awayScore ? updatedSemis[0].home : updatedSemis[0].away;
          const w1 = updatedSemis[1].homeScore > updatedSemis[1].awayScore ? updatedSemis[1].home : updatedSemis[1].away;
          newFinal = { id: "final", home: w0, away: w1, homeScore: 0, awayScore: 0, completed: false };
        }
        return { ...prev, semiFinals: updatedSemis, finalMatch: newFinal };
      });
    } else if (matchId === "final") {
      update((prev) => {
        const updatedFinal = { ...prev.finalMatch, homeScore: h, awayScore: a, completed: true };
        const winner = updatedFinal.homeScore > updatedFinal.awayScore ? updatedFinal.home : updatedFinal.away;
        return { ...prev, finalMatch: updatedFinal, champion: winner };
      });
    }
    setOpenMatch(null);
  };

  const handleAdvanceToKnockout = () => {
    if (isGroups) {
      const seeds = seedQualifiers(groupStandings, qualifiersPerGroup);
      const groupOf = {};
      groups.forEach((g) => g.playerIndexes.forEach((pi) => { groupOf[pi] = g.id; }));
      let { rounds } = buildKnockout(seeds, groupOf);
      // Resolve any first-round byes immediately so round 2 is ready.
      let champ = null;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const res = advanceKnockout(rounds);
        if (res.champion != null) { champ = res.champion; rounds = res.rounds; break; }
        if (res.rounds === rounds) break;
        rounds = res.rounds;
      }
      update({ phase: PHASES.KNOCKOUT, knockout: { rounds }, champion: champ });
      return;
    }

    const top4 = standings.slice(0, 4);
    const semis = [
      { id: "semi-0", home: top4[0].playerIndex, away: top4[3].playerIndex, homeScore: 0, awayScore: 0, completed: false },
      { id: "semi-1", home: top4[1].playerIndex, away: top4[2].playerIndex, homeScore: 0, awayScore: 0, completed: false },
    ];
    update({ phase: PHASES.KNOCKOUT, semiFinals: semis, finalMatch: null, champion: null });
  };

  const handleReset = () => {
    if (!window.confirm("Wipe this tournament and start fresh?")) return;
    update(emptyState());
  };

  const pressTimer = useRef(null);
  const onMastPressStart = () => {
    pressTimer.current = setTimeout(handleReset, 1200);
  };
  const onMastPressEnd = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
  };

  const [copied, setCopied] = useState(false);
  const copyLink = () => {
    const url = shareUrl(code, "fifa");
    navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };

  // Multi-group view lays itself out full-width (two-column groups inside),
  // so it doesn't want main's 1fr+360px aside split.
  const useAside =
    (phase === PHASES.GROUP && !isGroups) || phase === PHASES.KNOCKOUT;

  return (
    <div className="app">
      <Marquee items={headlines} />

      <header className="masthead">
        <h1
          onMouseDown={onMastPressStart}
          onMouseUp={onMastPressEnd}
          onMouseLeave={onMastPressEnd}
          onTouchStart={onMastPressStart}
          onTouchEnd={onMastPressEnd}
          title="Long-press to reset"
        >
          FIFA<span className="slash">/</span>TOURNAMENT
        </h1>
        <div className="masthead-meta">
          {onLeave && (
            <button className="room" onClick={onLeave} title="Back to game picker">
              ← HUB
            </button>
          )}
          {presence > 0 && (
            <span className="presence">
              <span className="dot" />
              {presence} watching
            </span>
          )}
          <button
            className={"room " + (copied ? "copied" : "")}
            onClick={copyLink}
            title="Copy share link"
          >
            {copied ? "LINK COPIED" : `ROOM ${code}`}
          </button>
        </div>
      </header>

      {!connected && (
        <div className="conn-state">RECONNECTING…</div>
      )}

      <main className={useAside ? "with-aside" : ""}>
        {phase === PHASES.SETUP && <PlayerSetup onStart={handleStart} />}

        {phase === PHASES.TEAM_SELECT && (
          <TeamSelect
            playerNames={playerNames}
            teams={teams}
            onConfirm={handleTeamsConfirmed}
          />
        )}

        {phase === PHASES.GROUP && (
          isGroups ? (
            <div className="group-phase-stack">
              <GroupStage
                groups={groups}
                groupStandings={groupStandings}
                qualifiersPerGroup={qualifiersPerGroup}
                matches={null}
                players={players}
                teamsByName={teamsByName}
                onOpenMatch={setOpenMatch}
              />
              {allGroupDone && (
                <div className="advance-section">
                  <button className="start-btn" onClick={handleAdvanceToKnockout}>
                    Advance {qualifiersPerGroup * groups.length} to Knockout →
                  </button>
                </div>
              )}
              <WallOfShame entries={shame} />
            </div>
          ) : (
            <>
              <div>
                <GroupStage
                  groups={null}
                  groupStandings={null}
                  qualifiersPerGroup={qualifiersPerGroup}
                  matches={groupMatches}
                  players={players}
                  teamsByName={teamsByName}
                  onOpenMatch={setOpenMatch}
                />
                {allGroupDone && (
                  <div className="advance-section">
                    <button className="start-btn" onClick={handleAdvanceToKnockout}>
                      Advance Top 4 →
                    </button>
                  </div>
                )}
              </div>
              <aside>
                <StandingsTable standings={standings} teamsByName={teamsByName} />
                <WallOfShame entries={shame} />
              </aside>
            </>
          )
        )}

        {phase === PHASES.KNOCKOUT && (
          <>
            <div>
              <KnockoutBracket
                rounds={isGroups ? knockout.rounds : null}
                semiFinals={semiFinals}
                final={finalMatch}
                players={players}
                teamsByName={teamsByName}
                onOpenMatch={setOpenMatch}
                champion={champion}
              />
            </div>
            <aside>
              <WallOfShame entries={shame} />
            </aside>
          </>
        )}
      </main>

      {openMatch && (
        <Scorer
          match={openMatch}
          players={players}
          teamsByName={teamsByName}
          onSubmit={handleScoreSubmit}
          onClose={() => setOpenMatch(null)}
          noDraws={!openMatch.id.startsWith("group")}
        />
      )}

      {(phase === PHASES.GROUP || phase === PHASES.KNOCKOUT) && (
        <Reactions reactions={reactions} onSend={sendReaction} />
      )}
    </div>
  );
}
