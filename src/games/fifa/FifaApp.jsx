import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import PlayerSetup from "./components/PlayerSetup";
import TeamSelect from "./components/TeamSelect";
import GroupStage from "./components/GroupStage";
import StandingsTable from "./components/StandingsTable";
import KnockoutBracket from "./components/KnockoutBracket";
import Scorer from "./components/Scorer";
import WallOfShame from "./components/WallOfShame";
import BettingBar from "./components/BettingBar";
import BetMatchModal from "./components/BetMatchModal";
import { computeMarketNets, resultOutcomeFromScore, round2 } from "./bets";
import Marquee from "../../components/Marquee";
import Reactions from "../../components/Reactions";
import { generateFixtures, computeStandings } from "./utils/fixtures";
import {
  splitIntoGroups,
  seedQualifiers,
  buildKnockout,
  advanceKnockout,
  groupLegTies,
  tieComplete,
  tieWinner,
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

const todayIso = () => {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
};

// Pull a one-shot ?sw=… marker out of the URL hash (the OAuth callback bounces
// back to #/r/CODE/fifa?sw=connected) and scrub it.
function takeSwFlag() {
  const m = window.location.hash.match(/[?&]sw=([a-z]+)/);
  if (!m) return null;
  const cleaned = window.location.hash.replace(/[?&]sw=[a-z]+/, "");
  window.history.replaceState(null, "", window.location.pathname + cleaned);
  return m[1];
}

function emptyState() {
  return {
    phase: PHASES.SETUP,
    playerNames: [],
    teamSelections: [],   // parallel to playerNames; live-shared in TEAM_SELECT
    format: "single", // "single" | "groups"
    matchesPerPlayer: 4, // single only
    qualifiersPerGroup: 2, // groups only
    groupRounds: 1, // groups only — 1 = single round-robin, 2 = home & away
    numGroups: null, // groups only — null = auto (floor(N/3))
    players: [],
    groups: [], // groups: [{ id, playerIndexes, matches }]
    groupMatches: [], // single (unchanged)
    semiFinals: [], // single legacy knockout
    finalMatch: null, // single legacy knockout
    knockout: { rounds: [] }, // groups: generalized rounds
    champion: null,
    runnerUp: null, // index into players (set when the title match completes)
    // Hall-of-Fame persistence
    rosterIds: [],            // parallel to playerNames
    startedAt: null,          // stamped when TeamSelect → Group
    endedAt: null,            // stamped when champion is crowned
    savedTournamentId: null,  // d1 row id after auto-save
    saveError: null,
    // Per-match Splitwise betting (client-authoritative, syncs with the blob).
    // The Splitwise CONNECTION itself (token/group/members) is server-side and
    // read via /splitwise/status — only currency, kickoff locks, markets + bets
    // live here.
    betting: {
      currency: "INR",
      matches: {},   // { [matchId]: { kickedOffAt } }
      markets: {},   // { [marketId]: { id, matchId, kind, title, outcomes, bets, resolvedOutcomeId, settlement } }
    },
  };
}

export default function FifaApp({ code, onLeave }) {
  // Splitwise connection lives server-side; we mirror it locally from the
  // /status fetch and the room's live `splitwise` broadcast.
  const [swStatus, setSwStatus] = useState({ connected: false });
  const handleRoomMessage = useCallback((msg) => {
    if (msg?.type === "splitwise") setSwStatus(msg.data || { connected: false });
  }, []);
  const { state: remoteState, presence, reactions, sendState, sendReaction, connected, ready } =
    useRoom(code, { onMessage: handleRoomMessage });
  const { teams, byName: teamsByName } = useTeams();

  const [swFlag, setSwFlag] = useState(() => takeSwFlag());
  useEffect(() => {
    if (!swFlag) return;
    const id = setTimeout(() => setSwFlag(null), 5000);
    return () => clearTimeout(id);
  }, [swFlag]);

  // Seed the connection status on mount and after an OAuth bounce.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/room/${code.toLowerCase()}/splitwise/status`);
        const data = await res.json();
        if (!cancelled && res.ok) setSwStatus(data || { connected: false });
      } catch { /* offline — bar will show disconnected */ }
    })();
    return () => { cancelled = true; };
  }, [code, swFlag]);

  // A group can be set without members loaded (e.g. a pre-configured house
  // account) — pull them so the bettor picker isn't empty.
  useEffect(() => {
    if (!swStatus.connected || !swStatus.groupId || swStatus.members) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/room/${code.toLowerCase()}/splitwise/members`);
        const data = await res.json();
        if (!cancelled && res.ok && Array.isArray(data)) setSwStatus((s) => ({ ...s, members: data }));
      } catch { /* offline */ }
    })();
    return () => { cancelled = true; };
  }, [code, swStatus.connected, swStatus.groupId, swStatus.members]);

  const [openBetsId, setOpenBetsId] = useState(null);

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
    numGroups,
    players,
    groups,
    groupMatches,
    semiFinals,
    finalMatch,
    knockout,
    champion,
    runnerUp,
    rosterIds,
    startedAt,
    endedAt,
    savedTournamentId,
    saveError,
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

  // ── Match betting ─────────────────────────────────────────
  const betting = state.betting || { currency: "INR", matches: {}, markets: {} };
  const bettingActive = !!swStatus.connected && !!swStatus.groupId;

  const matchById = useMemo(() => {
    const map = {};
    for (const m of allMatches) map[m.id] = m;
    return map;
  }, [allMatches]);

  const matchLabel = useCallback(
    (m) => {
      const h = m && m.home != null ? players[m.home]?.name ?? "TBD" : "TBD";
      const a = m && m.away != null ? players[m.away]?.name ?? "TBD" : "TBD";
      return `${h} vs ${a}`;
    },
    [players]
  );

  const marketsByMatch = useMemo(() => {
    const out = {};
    for (const mk of Object.values(betting.markets || {})) {
      (out[mk.matchId] ||= []).push(mk);
    }
    // Match Result first, custom markets after (creation order otherwise).
    for (const list of Object.values(out)) {
      list.sort((x, y) => (x.kind === "result" ? -1 : y.kind === "result" ? 1 : 0));
    }
    return out;
  }, [betting.markets]);

  const betSummary = useMemo(() => {
    const out = {};
    for (const [mid, mks] of Object.entries(marketsByMatch)) {
      let pool = 0;
      for (const mk of mks) for (const b of mk.bets) if (Number(b.stake) > 0) pool += Number(b.stake);
      out[mid] = { pool: Math.round(pool * 100) / 100, count: mks.length };
    }
    return out;
  }, [marketsByMatch]);

  // Per-match settlement status, the single source of truth for the match chip
  // and the settle dropdown. A completed Match Result market whose auto-winner
  // has no payable split (e.g. a draw with no draw backers) is "void" — there is
  // genuinely nothing to settle — distinct from "needs" (money still owed).
  //   needs  → completed, a real payout is still outstanding
  //   done   → at least one market settled, nothing outstanding
  //   void   → completed, every market resolved to nothing-to-settle
  //   open   → still bettable; locked → kicked off, not yet played
  const betStatusByMatch = useMemo(() => {
    const out = {};
    for (const [mid, mks] of Object.entries(marketsByMatch)) {
      const withBets = mks.filter((mk) => mk.bets.some((b) => Number(b.stake) > 0));
      if (withBets.length === 0) continue;
      const m = matchById[mid];
      if (!m) continue;
      let pool = 0;
      let needs = 0;
      let settled = 0;
      let voided = 0;
      for (const mk of withBets) {
        for (const b of mk.bets) if (Number(b.stake) > 0) pool += Number(b.stake);
        const s = mk.settlement;
        if (s?.sent) { settled++; continue; }
        if (s?.void) { voided++; continue; }
        if (!m.completed) continue; // open / locked — not settleable yet
        // Completed and unresolved. A result market's winner is known from the
        // score, so we can tell now whether it's payable; a custom market always
        // needs a human to pick the winner.
        if (mk.kind === "result" && computeMarketNets(mk.bets, resultOutcomeFromScore(m)).length === 0) {
          voided++;
          continue;
        }
        needs++;
      }
      const kickedOff = !!betting.matches?.[mid]?.kickedOffAt;
      const status =
        needs > 0 ? "needs"
        : !m.completed ? (kickedOff ? "locked" : "open")
        : settled > 0 ? "done"
        : "void";
      out[mid] = { pool: round2(pool), needs, settled, voided, status };
    }
    return out;
  }, [marketsByMatch, matchById, betting.matches]);

  // Rows for the always-visible settle dropdown — every match with stake on it,
  // across all stages, needs-to-settle first. Lets people settle (or just
  // review) bets from earlier rounds no longer on screen.
  const betLedger = useMemo(() => {
    const rank = { needs: 0, open: 1, locked: 1, void: 2, done: 3 };
    return Object.entries(betStatusByMatch)
      .map(([mid, st]) => {
        const m = matchById[mid];
        const legSuffix = m.leg != null ? ` · Leg ${m.leg + 1}` : "";
        return { matchId: mid, label: matchLabel(m) + legSuffix, pool: st.pool, status: st.status };
      })
      .sort((a, b) => (rank[a.status] - rank[b.status]) || a.label.localeCompare(b.label));
  }, [betStatusByMatch, matchById, matchLabel]);

  const updateBetting = useCallback(
    (fn) => {
      update((prev) => {
        const b = prev.betting || { currency: "INR", matches: {}, markets: {} };
        return { ...prev, betting: fn(b) };
      });
    },
    [update]
  );

  const patchMarket = (b, id, patch) => ({
    ...b,
    markets: { ...b.markets, [id]: { ...b.markets[id], ...patch } },
  });

  const ensureResultMarket = useCallback(
    (match) => {
      updateBetting((b) => {
        const id = `${match.id}::result`;
        if (b.markets[id]) return b;
        const homeName = players[match.home]?.name ?? "Home";
        const awayName = players[match.away]?.name ?? "Away";
        // Group games can draw, and so can a single leg of a two-legged tie
        // (the tie is decided on aggregate, not the leg). Only one-off knockout
        // matches — the final — forbid draws.
        const allowDraw = String(match.id).startsWith("group") || match.tie != null;
        const outcomes = [
          { id: "home", label: homeName },
          ...(allowDraw ? [{ id: "draw", label: "Draw" }] : []),
          { id: "away", label: awayName },
        ];
        return {
          ...b,
          markets: {
            ...b.markets,
            [id]: { id, matchId: match.id, kind: "result", title: "Match Result", outcomes, bets: [], resolvedOutcomeId: null, settlement: null },
          },
        };
      });
    },
    [players, updateBetting]
  );

  const openBets = useCallback(
    (match) => {
      ensureResultMarket(match);
      setOpenBetsId(match.id);
    },
    [ensureResultMarket]
  );

  // Open the bet modal for a match by id (used by the settle dropdown, which
  // can reach matches from any stage — including ones no longer on screen).
  const openBetsById = useCallback(
    (matchId) => {
      const m = matchById[matchId];
      if (m) openBets(m);
    },
    [matchById, openBets]
  );

  const placeBet = useCallback(
    (marketId, bet) => {
      updateBetting((b) => {
        const mk = b.markets[marketId];
        if (!mk) return b;
        if (b.matches[mk.matchId]?.kickedOffAt) return b; // betting closed
        const others = mk.bets.filter((x) => String(x.memberId) !== String(bet.memberId));
        const entry = { id: `b_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, ...bet };
        return patchMarket(b, marketId, { bets: [...others, entry] });
      });
    },
    [updateBetting]
  );

  // Remove a placed bet — only allowed while the match is still open (betting
  // not locked by kickoff). Editing is delete + re-place via the same form.
  const removeBet = useCallback(
    (marketId, betId) => {
      updateBetting((b) => {
        const mk = b.markets[marketId];
        if (!mk) return b;
        if (b.matches[mk.matchId]?.kickedOffAt) return b; // betting closed
        return patchMarket(b, marketId, { bets: mk.bets.filter((x) => x.id !== betId) });
      });
    },
    [updateBetting]
  );

  const addCustomMarket = useCallback(
    (matchId, title, outcomeLabels) => {
      updateBetting((b) => {
        if (b.matches[matchId]?.kickedOffAt) return b;
        const id = `${matchId}::c${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
        const outcomes = outcomeLabels.map((label, i) => ({ id: `o${i}`, label }));
        return {
          ...b,
          markets: {
            ...b.markets,
            [id]: { id, matchId, kind: "custom", title, outcomes, bets: [], resolvedOutcomeId: null, settlement: null },
          },
        };
      });
    },
    [updateBetting]
  );

  const kickOff = useCallback(
    (matchId) => {
      updateBetting((b) => ({ ...b, matches: { ...b.matches, [matchId]: { kickedOffAt: Date.now() } } }));
    },
    [updateBetting]
  );

  const setBetCurrency = useCallback(
    (cur) => updateBetting((b) => ({ ...b, currency: cur })),
    [updateBetting]
  );

  const settleMarket = useCallback(
    async (market, winningOutcomeId) => {
      const nets = computeMarketNets(market.bets, winningOutcomeId);
      const m = matchById[market.matchId];
      const label = m ? matchLabel(m) : "FIFA match";
      // No payable split (one-sided / draw with no draw bets) → send nothing.
      if (nets.length === 0) {
        updateBetting((b) => patchMarket(b, market.id, { resolvedOutcomeId: winningOutcomeId, settlement: { sent: false, void: true, at: Date.now() } }));
        return;
      }
      const description = market.kind === "result" ? label : `${label} · ${market.title}`;
      try {
        const res = await fetch(`/api/room/${code.toLowerCase()}/splitwise/settle`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            description,
            currency: betting.currency || "INR",
            date: todayIso(),
            participants: nets.map((n) => ({ userId: n.memberId, net: n.net })),
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) {
          updateBetting((b) => patchMarket(b, market.id, { resolvedOutcomeId: winningOutcomeId, settlement: { sent: false, error: data.error || `Failed (${res.status})`, at: Date.now() } }));
        } else {
          updateBetting((b) => patchMarket(b, market.id, { resolvedOutcomeId: winningOutcomeId, settlement: { sent: true, expenseId: data.expenseId ?? null, at: Date.now() } }));
        }
      } catch (e) {
        updateBetting((b) => patchMarket(b, market.id, { resolvedOutcomeId: winningOutcomeId, settlement: { sent: false, error: e.message, at: Date.now() } }));
      }
    },
    [matchById, matchLabel, betting.currency, code, updateBetting]
  );

  const bettingProps = bettingActive
    ? { active: true, summary: betSummary, status: betStatusByMatch, kicked: betting.matches || {}, currency: betting.currency || "INR", onOpen: openBets }
    : null;

  // ── Hall-of-Fame auto-save ────────────────────────────────
  // Fires once when the tournament ends. Server dedups via (room_code, ended_at)
  // so it's safe if multiple clients race.
  const savingRef = useRef(false);
  const canPersist =
    champion != null &&
    endedAt != null &&
    savedTournamentId == null &&
    !saveError &&
    Array.isArray(rosterIds) &&
    rosterIds.length === playerNames.length &&
    rosterIds.every((id) => id != null);

  useEffect(() => {
    if (!canPersist || savingRef.current) return;
    savingRef.current = true;

    // Per-player W/D/L/GF/GA from completed, non-bye matches.
    const stats = players.map(() => ({ wins: 0, draws: 0, losses: 0, gf: 0, ga: 0 }));
    for (const m of allMatches) {
      if (!m.completed || m.bye) continue;
      if (m.home == null || m.away == null) continue;
      stats[m.home].gf += m.homeScore; stats[m.home].ga += m.awayScore;
      stats[m.away].gf += m.awayScore; stats[m.away].ga += m.homeScore;
      if (m.homeScore > m.awayScore) { stats[m.home].wins++; stats[m.away].losses++; }
      else if (m.homeScore < m.awayScore) { stats[m.away].wins++; stats[m.home].losses++; }
      else { stats[m.home].draws++; stats[m.away].draws++; }
    }

    const groupOf = {};
    if (isGroups) {
      for (const g of groups) for (const pi of g.playerIndexes) groupOf[pi] = g.id;
    }

    const participants = players.map((p, idx) => ({
      playerId: rosterIds[idx],
      teamName: p.team || null,
      finalRank: idx === champion ? 1 : idx === runnerUp ? 2 : null,
      groupId: groupOf[idx] || null,
      wins: stats[idx].wins,
      draws: stats[idx].draws,
      losses: stats[idx].losses,
      goalsFor: stats[idx].gf,
      goalsAgainst: stats[idx].ga,
      reachedStage:
        idx === champion ? "champion" :
        idx === runnerUp ? "final" :
        "group",
    }));

    const groupIdForMatch = (m) => {
      if (!isGroups) return null;
      const g = groups.find((g) => g.matches.some((mm) => mm.id === m.id));
      return g?.id ?? null;
    };
    const stageForMatch = (m) => {
      if (m.id.startsWith("ko-")) return "knockout";
      if (m.id === "final") return "final";
      if (m.id.startsWith("semi")) return "sf";
      return "group";
    };

    const matchPayloads = allMatches
      .filter((m) => m.completed && !m.bye && m.home != null && m.away != null)
      .map((m) => ({
        stage: stageForMatch(m),
        groupId: groupIdForMatch(m),
        homeId: rosterIds[m.home],
        awayId: rosterIds[m.away],
        homeTeam: players[m.home]?.team || null,
        awayTeam: players[m.away]?.team || null,
        homeScore: m.homeScore,
        awayScore: m.awayScore,
        playedAt: m.playedAt || null,
      }));

    const payload = {
      roomCode: code,
      format: isGroups ? "groups" : "league",
      groupRounds: isGroups ? groupRounds : null,
      qualifiers: isGroups ? qualifiersPerGroup : null,
      matchesPerPlayer: isGroups ? null : matchesPerPlayer,
      startedAt,
      endedAt,
      championPlayerId: rosterIds[champion] ?? null,
      runnerUpPlayerId: runnerUp != null ? rosterIds[runnerUp] ?? null : null,
      participants,
      matches: matchPayloads,
    };

    (async () => {
      try {
        const res = await fetch("/api/tournaments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok || !data?.id) {
          update({ saveError: data?.error || `Save failed (${res.status})` });
        } else {
          update({ savedTournamentId: data.id });
        }
      } catch (e) {
        update({ saveError: e.message });
      } finally {
        savingRef.current = false;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canPersist]);

  const handleStart = (names, mpp, opts = {}) => {
    // Format comes from PlayerSetup's explicit toggle. Fall back to auto so
    // older callers / stored states still work.
    const chosen = opts.format
      ? (opts.format === "groups" ? "groups" : "single")
      : (names.length >= GROUP_THRESHOLD ? "groups" : "single");
    update({
      phase: PHASES.TEAM_SELECT,
      playerNames: names,
      teamSelections: names.map(() => ""),
      format: chosen,
      matchesPerPlayer: mpp,
      qualifiersPerGroup: opts.qualifiersPerGroup ?? 2,
      groupRounds: opts.groupRounds === 2 ? 2 : 1,
      numGroups: opts.numGroups ?? null,
      rosterIds: Array.isArray(opts.rosterIds) ? opts.rosterIds : [],
    });
  };

  // ── TEAM_SELECT live editing ──────────────────────────────
  // Picks are shared via room state so anyone with the link can pick for
  // anyone — useful for big lobbies where one person is screensharing or
  // people open the link on their own devices.
  const handleTeamPick = (index, team) => {
    update((prev) => {
      const next = [...(prev.teamSelections || [])];
      while (next.length < prev.playerNames.length) next.push("");
      next[index] = team;
      return { ...prev, teamSelections: next };
    });
  };

  // Replace the participant in slot `index` (drop-out → substitute). Reset
  // that slot's team pick since it's now a different player.
  const handleReplacePlayer = (index, { name, rosterId }) => {
    update((prev) => {
      const names = [...prev.playerNames]; names[index] = name;
      const ids = [...(prev.rosterIds || [])];
      while (ids.length < names.length) ids.push(null);
      ids[index] = rosterId ?? null;
      const sels = [...(prev.teamSelections || [])];
      while (sels.length < names.length) sels.push("");
      sels[index] = "";
      return { ...prev, playerNames: names, rosterIds: ids, teamSelections: sels };
    });
  };

  const handleRemovePlayer = (index) => {
    update((prev) => {
      if ((prev.playerNames || []).length <= 2) return prev; // need ≥2
      return {
        ...prev,
        playerNames: prev.playerNames.filter((_, i) => i !== index),
        rosterIds: (prev.rosterIds || []).filter((_, i) => i !== index),
        teamSelections: (prev.teamSelections || []).filter((_, i) => i !== index),
      };
    });
  };

  const handleTeamsConfirmed = (teamSelections) => {
    const assigned = playerNames.map((name, i) => ({ name, team: teamSelections[i] }));
    const now = Date.now();

    if (isGroups) {
      const teamByIndex = Object.fromEntries(assigned.map((p, i) => [i, p.team]));
      const built = splitIntoGroups(assigned.map((_, i) => i), undefined, groupRounds, teamByIndex, numGroups);
      if (built.length === 0) {
        window.alert("Could not split players into groups. Try a different player count.");
        return;
      }
      update({ players: assigned, groups: built, phase: PHASES.GROUP, startedAt: now });
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
    update({ players: assigned, groupMatches: matches, phase: PHASES.GROUP, startedAt: now });
  };

  const handleScoreSubmit = (matchId, h, a) => {
    const ts = Date.now();
    if (matchId.startsWith("ko-")) {
      // Generalized group-format knockout.
      update((prev) => {
        let rounds = prev.knockout.rounds.map((r) => ({
          ...r,
          matches: r.matches.map((m) =>
            m.id === matchId ? { ...m, homeScore: h, awayScore: a, completed: true, playedAt: ts } : m
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
        const patch = { ...prev, knockout: { rounds }, champion: champ };
        // If we just crowned a champion, also capture endedAt + runnerUp from
        // the final round's title match.
        if (champ != null && prev.champion == null) {
          patch.endedAt = ts;
          const lastRound = rounds[rounds.length - 1];
          const finalM = lastRound?.matches?.[0];
          if (finalM && finalM.completed) {
            patch.runnerUp = finalM.homeScore > finalM.awayScore ? finalM.away : finalM.home;
          }
        }
        return patch;
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
                m.id === matchId ? { ...m, homeScore: h, awayScore: a, completed: true, playedAt: ts } : m
              ),
            })),
          };
        }
        return {
          ...prev,
          groupMatches: prev.groupMatches.map((m) =>
            m.id === matchId ? { ...m, homeScore: h, awayScore: a, completed: true, playedAt: ts } : m
          ),
        };
      });
    } else if (matchId.startsWith("semi")) {
      update((prev) => {
        const updatedSemis = prev.semiFinals.map((m) =>
          m.id === matchId ? { ...m, homeScore: h, awayScore: a, completed: true, playedAt: ts } : m
        );
        let newFinal = prev.finalMatch;
        // Each semi is a two-legged tie (legacy single-match data groups as a
        // singleton tie, so old in-progress brackets keep working). Build the
        // final from the two tie winners once both ties are complete.
        const ties = groupLegTies(updatedSemis);
        if (ties.every(tieComplete)) {
          const w0 = tieWinner(ties[0]);
          const w1 = tieWinner(ties[1]);
          newFinal = { id: "final", home: w0, away: w1, homeScore: 0, awayScore: 0, completed: false };
        }
        return { ...prev, semiFinals: updatedSemis, finalMatch: newFinal };
      });
    } else if (matchId === "final") {
      update((prev) => {
        const updatedFinal = { ...prev.finalMatch, homeScore: h, awayScore: a, completed: true, playedAt: ts };
        const winner = updatedFinal.homeScore > updatedFinal.awayScore ? updatedFinal.home : updatedFinal.away;
        const loser = updatedFinal.homeScore > updatedFinal.awayScore ? updatedFinal.away : updatedFinal.home;
        return { ...prev, finalMatch: updatedFinal, champion: winner, runnerUp: loser, endedAt: ts };
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
    // Each semi is played over two legs (home & away), so the higher seed gets
    // the second leg at home. The final stays a single match.
    const semiLegs = (n, hi, lo) => [
      { id: `semi-${n}-l0`, home: lo, away: hi, homeScore: 0, awayScore: 0, completed: false, tie: `semi-${n}`, leg: 0 },
      { id: `semi-${n}-l1`, home: hi, away: lo, homeScore: 0, awayScore: 0, completed: false, tie: `semi-${n}`, leg: 1 },
    ];
    const semis = [
      ...semiLegs(0, top4[0].playerIndex, top4[3].playerIndex),
      ...semiLegs(1, top4[1].playerIndex, top4[2].playerIndex),
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

  // Two-legged scoring context for the Scorer. A leg whose sibling is already
  // played is the decider — pass that sibling so the Scorer can block a level
  // aggregate. A leg that's part of a tie never blocks plain draws.
  const openTieSibling =
    openMatch?.tie != null
      ? allMatches.find((x) => x.tie === openMatch.tie && x.id !== openMatch.id)
      : null;
  const scorerFirstLeg = openTieSibling?.completed ? openTieSibling : null;
  const scorerNoDraws = openMatch
    ? !openMatch.id.startsWith("group") && openMatch.tie == null
    : false;

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
          {champion != null && (() => {
            const allMapped =
              Array.isArray(rosterIds) &&
              rosterIds.length === playerNames.length &&
              rosterIds.every((id) => id != null);
            if (!allMapped) return <span className="hof-status warn" title="One or more players were not in the roster">⚠ NOT IN ROSTER</span>;
            if (saveError) return <span className="hof-status fail" title={saveError}>⚠ HOF NOT SAVED</span>;
            if (savedTournamentId) return <span className="hof-status ok">✓ SAVED TO HOF</span>;
            return <span className="hof-status">SAVING TO HOF…</span>;
          })()}
          <button
            className={"room " + (copied ? "copied" : "")}
            onClick={copyLink}
            title="Copy share link"
          >
            {copied ? "LINK COPIED" : code}
          </button>
        </div>
      </header>

      {!connected && (
        <div className="conn-state">RECONNECTING…</div>
      )}

      {swFlag && (
        <div className={"poker-sw-flag " + (swFlag === "connected" ? "ok" : "bad")}>
          {swFlag === "connected" && "✓ Splitwise connected"}
          {swFlag === "denied" && "Splitwise access was denied"}
          {swFlag === "expired" && "Splitwise login expired — try again"}
          {swFlag === "error" && "Splitwise connection failed — try again"}
        </div>
      )}

      {ready && (phase === PHASES.GROUP || phase === PHASES.KNOCKOUT) && (
        <BettingBar
          code={code}
          sw={swStatus}
          currency={betting.currency || "INR"}
          onSetCurrency={setBetCurrency}
          ledger={betLedger}
          onOpenMatch={openBetsById}
        />
      )}

      <main className={useAside && ready ? "with-aside" : ""}>
        {!ready && (
          <div className="room-loading">
            <div className="room-loading-spinner" aria-hidden />
            <div className="room-loading-label">LOADING ROOM {code}…</div>
          </div>
        )}

        {ready && phase === PHASES.SETUP && <PlayerSetup onStart={handleStart} />}

        {ready && phase === PHASES.TEAM_SELECT && (
          <TeamSelect
            playerNames={playerNames}
            rosterIds={rosterIds}
            selections={state.teamSelections}
            teams={teams}
            onPick={handleTeamPick}
            onReplace={handleReplacePlayer}
            onRemove={handleRemovePlayer}
            onConfirm={handleTeamsConfirmed}
          />
        )}

        {ready && phase === PHASES.GROUP && (
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
                betting={bettingProps}
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
                  betting={bettingProps}
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

        {ready && phase === PHASES.KNOCKOUT && (
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
                betting={bettingProps}
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
          noDraws={scorerNoDraws}
          firstLeg={scorerFirstLeg}
          legNo={openMatch.leg != null ? openMatch.leg + 1 : null}
        />
      )}

      {openBetsId && bettingActive && matchById[openBetsId] && (
        <BetMatchModal
          match={matchById[openBetsId]}
          matchLabel={matchLabel(matchById[openBetsId])}
          markets={marketsByMatch[openBetsId] || []}
          kickedOffAt={betting.matches?.[openBetsId]?.kickedOffAt || null}
          members={swStatus.members || []}
          currency={betting.currency || "INR"}
          onPlaceBet={placeBet}
          onRemoveBet={removeBet}
          onAddMarket={addCustomMarket}
          onKickOff={kickOff}
          onSettle={settleMarket}
          onClose={() => setOpenBetsId(null)}
        />
      )}

      {(phase === PHASES.GROUP || phase === PHASES.KNOCKOUT) && (
        <Reactions reactions={reactions} onSend={sendReaction} />
      )}
    </div>
  );
}
