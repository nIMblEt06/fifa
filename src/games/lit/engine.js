// Pure game engine for "Lit" (a Go Fish variant), now with an optional
// team mode (Literature-flavor).
//
// Solo rules:
//   • Standard 52-card deck. A "set" = all 4 cards of one rank.
//   • Each player is dealt 7 cards. On your turn you ASK any other player
//     for a RANK you already hold. They give all cards of that rank if
//     they have any (you keep your turn). Otherwise you DRAW from the
//     deck; if the draw matches the rank you asked, your turn continues,
//     else it passes.
//   • A 4-of-a-kind in your hand auto-scores into your personal `sets`.
//   • Game ends when deck + all hands are empty. Most sets wins.
//
// Team rules (mode: "team"):
//   • 4 or 6 players split into two even teams A and B.
//   • Same deal (7 each), same ASK mechanic — BUT you may only ask
//     members of the opposing team.
//   • Sets are owned by TEAMS, not individuals (`teamSets[A|B]`).
//   • On your turn you may instead DECLARE a rank: claim that your team
//     collectively holds all 4 cards of that rank.
//       - If they do: rank scored for your team, all 4 cards removed
//         from team hands, you keep the turn.
//       - If not: rank scored for the OPPOSING team, those cards are
//         removed wherever they lay, turn passes.
//   • Game ends when all 13 ranks have been claimed (by either team) OR
//     no one can play.
//
// This module is pure: same input → same output. Loaded by both the
// Cloudflare Durable Object (authoritative) and the client.

export const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K"];
export const SUITS = ["S", "H", "D", "C"];
const HAND_SIZE = 7;
const SET_SIZE = 4;

export function freshDeck() {
  const deck = [];
  for (const r of RANKS) for (const s of SUITS) deck.push(`${r}${s}`);
  return deck;
}

export function rankOf(card) { return card[0]; }

// Fisher–Yates with an injectable RNG (so DO can seed deterministically).
export function shuffle(arr, rng = Math.random) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Build a default team split for `players` (alternating by join order).
// Returns [{id:"A", playerIds:[...]}, {id:"B", playerIds:[...]}].
export function defaultTeams(players) {
  const A = [], B = [];
  players.forEach((p, i) => (i % 2 === 0 ? A : B).push(p.id));
  return [
    { id: "A", playerIds: A },
    { id: "B", playerIds: B },
  ];
}

export function teamOf(state, playerId) {
  if (!state.teams) return null;
  for (const t of state.teams) if (t.playerIds.includes(playerId)) return t.id;
  return null;
}

function otherTeam(teamId) { return teamId === "A" ? "B" : "A"; }

// Create the starting game state.
//   players: [{id, name}]
//   opts.mode: "solo" | "team" (default "solo")
//   opts.teams: required when mode==="team"; same shape as defaultTeams output.
export function startGame(players, opts = {}, rng = Math.random) {
  const mode = opts.mode === "team" ? "team" : "solo";
  if (players.length < 2) throw new Error("Need at least 2 players");
  if (mode === "team") {
    if (players.length !== 4 && players.length !== 6) {
      throw new Error("Team mode needs 4 or 6 players");
    }
    if (!opts.teams || opts.teams.length !== 2) throw new Error("Missing teams");
    const sizes = opts.teams.map((t) => t.playerIds.length);
    if (sizes[0] !== sizes[1]) throw new Error("Teams must be equal size");
  }

  const deck = shuffle(freshDeck(), rng);
  const hands = {};
  const sets = {};
  for (const p of players) {
    hands[p.id] = deck.splice(0, HAND_SIZE);
    sets[p.id] = [];
  }

  const state = {
    mode,
    players: players.map((p) => ({ id: p.id, name: p.name })),
    teams: mode === "team" ? opts.teams.map((t) => ({ id: t.id, playerIds: [...t.playerIds] })) : null,
    hands,
    deck,
    sets,                                // still used in solo; ignored in team
    teamSets: mode === "team" ? { A: [], B: [] } : null,
    turn: players[0].id,
    log: [{ t: Date.now(), kind: "start", mode }],
    winner: null,
  };

  // Auto-score any 4-of-a-kind dealt in the opening hand.
  for (const p of players) collectInto(state, p.id);
  ensureTurnPlayable(state);
  maybeFinish(state);
  return state;
}

// Idempotently fix state if the current player can't act. Safe to call on
// any state; used by the DO to self-heal pre-fix games on the next action.
export function healState(state) {
  if (!state || state.winner) return state;
  ensureTurnPlayable(state);
  maybeFinish(state);
  return state;
}

// Move any completed 4-of-a-kind out of `playerId`'s hand. Routes to the
// per-player `sets` (solo) or the team's `teamSets` (team mode).
function collectInto(state, playerId) {
  const hand = state.hands[playerId];
  const byRank = new Map();
  for (const c of hand) {
    const r = rankOf(c);
    byRank.set(r, (byRank.get(r) || 0) + 1);
  }
  for (const [r, n] of byRank.entries()) {
    if (n >= SET_SIZE) {
      state.hands[playerId] = state.hands[playerId].filter((c) => rankOf(c) !== r);
      awardRank(state, r, state.mode === "team" ? teamOf(state, playerId) : playerId);
    }
  }
}

function awardRank(state, rank, ownerId) {
  if (state.mode === "team") {
    if (!state.teamSets[ownerId].includes(rank)) state.teamSets[ownerId].push(rank);
  } else {
    if (!state.sets[ownerId].includes(rank)) state.sets[ownerId].push(rank);
  }
}

function rankAlreadyClaimed(state, rank) {
  if (state.mode === "team") {
    return state.teamSets.A.includes(rank) || state.teamSets.B.includes(rank);
  }
  return Object.values(state.sets).some((arr) => arr.includes(rank));
}

// Apply an ASK action. Returns { state, error? }.
export function applyAsk(state, fromId, toId, rank) {
  if (state.winner) return { error: "Game already over" };
  if (state.turn !== fromId) return { error: "Not your turn" };
  if (fromId === toId) return { error: "Can't ask yourself" };
  const fromHand = state.hands[fromId];
  const toHand = state.hands[toId];
  if (!fromHand || !toHand) return { error: "Unknown player" };
  if (state.mode === "team") {
    if (teamOf(state, fromId) === teamOf(state, toId)) {
      return { error: "Can't ask a teammate" };
    }
  }
  if (!fromHand.some((c) => rankOf(c) === rank)) return { error: "You must hold the rank you ask for" };

  const matches = toHand.filter((c) => rankOf(c) === rank);
  const next = structuredClone(state);
  if (matches.length > 0) {
    next.hands[toId] = toHand.filter((c) => rankOf(c) !== rank);
    next.hands[fromId] = [...fromHand, ...matches];
    collectInto(next, fromId);
    next.log.push({ t: Date.now(), kind: "ask_hit", from: fromId, to: toId, rank, count: matches.length });
  } else {
    if (next.deck.length === 0) {
      next.log.push({ t: Date.now(), kind: "ask_miss_no_deck", from: fromId, to: toId, rank });
      next.turn = nextTurn(next);
    } else {
      const drawn = next.deck.shift();
      next.hands[fromId] = [...fromHand, drawn];
      collectInto(next, fromId);
      const lucky = rankOf(drawn) === rank;
      next.log.push({ t: Date.now(), kind: lucky ? "ask_miss_lucky" : "ask_miss", from: fromId, to: toId, rank, drawn });
      if (!lucky) next.turn = nextTurn(next);
    }
  }
  ensureTurnPlayable(next);
  maybeFinish(next);
  return { state: next };
}

// Apply a DECLARE action (team mode only).
export function applyDeclare(state, fromId, rank) {
  if (state.mode !== "team") return { error: "Declares only in team mode" };
  if (state.winner) return { error: "Game already over" };
  if (state.turn !== fromId) return { error: "Not your turn" };
  if (!RANKS.includes(rank)) return { error: "Invalid rank" };
  if (rankAlreadyClaimed(state, rank)) return { error: "Rank already claimed" };

  const myTeam = teamOf(state, fromId);
  if (!myTeam) return { error: "You're not on a team" };
  const opp = otherTeam(myTeam);
  const next = structuredClone(state);

  // Count this rank across the declaring team's hands.
  const myTeamIds = next.teams.find((t) => t.id === myTeam).playerIds;
  const oppTeamIds = next.teams.find((t) => t.id === opp).playerIds;
  let teamHas = 0;
  for (const pid of myTeamIds) teamHas += next.hands[pid].filter((c) => rankOf(c) === rank).length;

  const success = teamHas === SET_SIZE;

  // Either way, remove all 4 cards of `rank` from wherever they sit (hands +
  // deck) so the table state stays consistent.
  for (const pid of [...myTeamIds, ...oppTeamIds]) {
    next.hands[pid] = next.hands[pid].filter((c) => rankOf(c) !== rank);
  }
  next.deck = next.deck.filter((c) => rankOf(c) !== rank);

  if (success) {
    awardRank(next, rank, myTeam);
    next.log.push({ t: Date.now(), kind: "declare_hit", by: fromId, team: myTeam, rank });
    // Turn stays with `fromId`.
  } else {
    awardRank(next, rank, opp);
    next.log.push({ t: Date.now(), kind: "declare_miss", by: fromId, team: myTeam, rank, awardedTo: opp });
    next.turn = nextTurn(next);
  }

  ensureTurnPlayable(next);
  maybeFinish(next);
  return { state: next };
}

function nextTurn(state) {
  const order = state.players.map((p) => p.id);
  const i = order.indexOf(state.turn);
  for (let k = 1; k <= order.length; k++) {
    const cand = order[(i + k) % order.length];
    if (state.hands[cand].length > 0 || state.deck.length > 0) return cand;
  }
  return state.turn;
}

function ensureTurnPlayable(state) {
  for (let safety = 0; safety < 256; safety++) {
    const cur = state.turn;
    if (state.hands[cur].length > 0) return;
    if (state.deck.length > 0) {
      const drawn = state.deck.shift();
      state.hands[cur] = [...state.hands[cur], drawn];
      collectInto(state, cur);
      state.log.push({ t: Date.now(), kind: "auto_draw", who: cur, drawn });
      continue;
    }
    const next = nextTurn(state);
    if (next === cur) return;
    state.turn = next;
  }
}

function maybeFinish(state) {
  if (state.mode === "team") {
    // Team mode ends when all 13 ranks have been claimed by some team OR
    // there's no possibility of progress (no hands, no deck).
    const claimed = state.teamSets.A.length + state.teamSets.B.length;
    const handsEmpty = Object.values(state.hands).every((h) => h.length === 0);
    if (claimed >= RANKS.length || (handsEmpty && state.deck.length === 0)) {
      const a = state.teamSets.A.length;
      const b = state.teamSets.B.length;
      if (a > b) state.winner = "A";
      else if (b > a) state.winner = "B";
      else state.winner = ["A", "B"];
    }
    return;
  }
  // Solo
  const handsEmpty = Object.values(state.hands).every((h) => h.length === 0);
  if (handsEmpty && state.deck.length === 0) {
    let best = -1;
    let winners = [];
    for (const p of state.players) {
      const n = state.sets[p.id].length;
      if (n > best) { best = n; winners = [p.id]; }
      else if (n === best) winners.push(p.id);
    }
    state.winner = winners.length === 1 ? winners[0] : winners;
  }
}

// Build a per-player redacted view of the state.
//   solo: { you, opponents, deckCount, turn, ... }
//   team: + { mode, teams, teamSets, yourTeam, teammates, opponents }
//         (`opponents` becomes the OPPOSING-team players only)
export function redactFor(state, viewerId) {
  if (!state) return null;
  const base = {
    deckCount: state.deck.length,
    turn: state.turn,
    winner: state.winner,
    log: state.log.slice(-20),
    players: state.players.map((p) => ({
      ...p,
      teamId: state.mode === "team" ? teamOf(state, p.id) : null,
    })),
    mode: state.mode,
  };

  const you = {
    id: viewerId,
    hand: state.hands[viewerId] || [],
    // For backwards compat in the UI: in team mode we expose teamSets too.
    sets: state.mode === "team"
      ? (state.teamSets?.[teamOf(state, viewerId)] || [])
      : (state.sets[viewerId] || []),
  };

  if (state.mode === "team") {
    const myTeam = teamOf(state, viewerId);
    const oppTeam = myTeam ? otherTeam(myTeam) : null;
    const summarize = (pid) => ({
      id: pid,
      name: state.players.find((p) => p.id === pid)?.name,
      handCount: (state.hands[pid] || []).length,
    });
    const myTeamIds = (state.teams.find((t) => t.id === myTeam)?.playerIds || []).filter((pid) => pid !== viewerId);
    const oppTeamIds = state.teams.find((t) => t.id === oppTeam)?.playerIds || [];
    return {
      ...base,
      teams: state.teams,
      teamSets: state.teamSets,
      yourTeam: myTeam,
      you,
      teammates: myTeamIds.map(summarize),
      opponents: oppTeamIds.map(summarize),
    };
  }

  // Solo
  const opponents = state.players
    .filter((p) => p.id !== viewerId)
    .map((p) => ({
      id: p.id,
      name: p.name,
      handCount: (state.hands[p.id] || []).length,
      sets: (state.sets[p.id] || []).length,
    }));
  return { ...base, you, opponents };
}
