import { useState, useMemo, useCallback, useRef } from "react";
import PlayerSetup from "./components/PlayerSetup";
import TeamSelect from "./components/TeamSelect";
import GroupStage from "./components/GroupStage";
import StandingsTable from "./components/StandingsTable";
import KnockoutBracket from "./components/KnockoutBracket";
import Scorer from "./components/Scorer";
import Marquee from "./components/Marquee";
import WallOfShame from "./components/WallOfShame";
import Reactions from "./components/Reactions";
import { generateFixtures, computeStandings } from "./utils/fixtures";
import { buildHeadlines, buildShame } from "./utils/headlines";
import { generateCode, readCodeFromUrl, writeCodeToUrl, shareUrl } from "./utils/room";
import { useRoom } from "./utils/useRoom";
import { useTeams } from "./utils/useTeams";

const PHASES = {
  SETUP: "setup",
  TEAM_SELECT: "team_select",
  GROUP: "group",
  KNOCKOUT: "knockout",
};

function emptyState() {
  return {
    phase: PHASES.SETUP,
    playerNames: [],
    matchesPerPlayer: 4,
    players: [],
    groupMatches: [],
    semiFinals: [],
    finalMatch: null,
    champion: null,
  };
}

export default function App() {
  // Resolve room code: read from URL or mint a new one and write it back.
  const [code] = useState(() => {
    const existing = readCodeFromUrl();
    if (existing) return existing;
    const fresh = generateCode(4);
    writeCodeToUrl(fresh);
    return fresh;
  });

  const { state: remoteState, presence, reactions, sendState, sendReaction, connected } = useRoom(code);
  const { teams, byName: teamsByName } = useTeams();

  const state = remoteState ?? emptyState();

  const update = useCallback(
    (patch) => {
      const next = typeof patch === "function" ? patch(state) : { ...state, ...patch };
      sendState(next);
    },
    [state, sendState]
  );

  const { phase, playerNames, matchesPerPlayer, players, groupMatches, semiFinals, finalMatch, champion } = state;

  const standings = useMemo(
    () => (players.length > 0 ? computeStandings(players, groupMatches) : []),
    [players, groupMatches]
  );

  const allGroupDone = groupMatches.length > 0 && groupMatches.every((m) => m.completed);

  const allMatches = useMemo(() => {
    const km = [...semiFinals];
    if (finalMatch) km.push(finalMatch);
    return [...groupMatches, ...km];
  }, [groupMatches, semiFinals, finalMatch]);

  const headlines = useMemo(
    () => buildHeadlines(players, allMatches, standings),
    [players, allMatches, standings]
  );
  const shame = useMemo(() => buildShame(players, allMatches), [players, allMatches]);

  // ── Scorer overlay state ────────────────────────────────────
  const [openMatch, setOpenMatch] = useState(null);

  const handleStart = (names, mpp) => {
    update({ phase: PHASES.TEAM_SELECT, playerNames: names, matchesPerPlayer: mpp });
  };

  const handleTeamsConfirmed = (teamSelections) => {
    const assigned = playerNames.map((name, i) => ({ name, team: teamSelections[i] }));
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
    if (matchId.startsWith("group")) {
      update((prev) => ({
        ...prev,
        groupMatches: prev.groupMatches.map((m) =>
          m.id === matchId ? { ...m, homeScore: h, awayScore: a, completed: true } : m
        ),
      }));
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

  // ── Long-press masthead for reset ───────────────────────────
  const pressTimer = useRef(null);
  const onMastPressStart = () => {
    pressTimer.current = setTimeout(handleReset, 1200);
  };
  const onMastPressEnd = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
  };

  // ── Copy share link ────────────────────────────────────────
  const [copied, setCopied] = useState(false);
  const copyLink = () => {
    const url = shareUrl(code);
    navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };

  const useAside = phase === PHASES.GROUP || phase === PHASES.KNOCKOUT;

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
          {presence > 0 && (
            <span className="presence">
              <span className="dot" />
              {presence} {presence === 1 ? "watching" : "watching"}
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
          <>
            <div>
              <GroupStage
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
        )}

        {phase === PHASES.KNOCKOUT && (
          <>
            <div>
              <KnockoutBracket
                semiFinals={semiFinals}
                final={finalMatch}
                players={players}
                teamsByName={teamsByName}
                onOpenMatch={setOpenMatch}
                champion={champion}
              />
            </div>
            <aside>
              <StandingsTable standings={standings} teamsByName={teamsByName} />
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
