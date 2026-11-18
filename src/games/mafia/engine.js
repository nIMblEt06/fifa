// Pure game engine for "MAFIA".
//
// Like lit/poker/undercover/hitler, the room is SERVER-AUTHORITATIVE: the
// Durable Object owns the state, every apply* function here is a pure
// (state, ...args) => { state } | { error } reducer, and each socket receives
// only a per-viewer REDACTED view (redactFor) — roles, mafia chat, night
// actions and ballot targets never leave the server for viewers who
// shouldn't see them.
//
// ── ROLES ────────────────────────────────────────────────────────────────
//   • MAFIA — kill one town member per night by consensus (>50% of ALL alive
//     mafia agreeing on the same target; a split with no strict majority is
//     a tie and never continues — no kill that night, no revote).
//   • DOCTOR (optional, 0 or 1) — protects one player per night (self-save
//     allowed). If it matches the mafia's target, the kill is cancelled.
//   • DETECTIVE (optional, 0 or 1) — investigates one player per night,
//     privately learns whether they're mafia.
//   • VILLAGER — everyone else.
//
// ── FLOW ─────────────────────────────────────────────────────────────────
//   lobby → night → day → (night | over) → …
//
//   NIGHT ends the instant every alive actionable player (mafia collectively,
//   the doctor, the detective) has acted, or the timer expires — whichever
//   first. There is no host confirmation: elimination + role reveal + win
//   check apply automatically.
//
//   DAY: chat and voting are both open from the moment day starts — there's
//   no separate discuss-then-vote split. Every alive player votes for an
//   alive player or "skip" (no lynch) whenever they're ready; the day ends
//   the instant every alive player has voted, or the day timer expires —
//   same "whichever first" rule as night. A tie among the top vote-getters
//   (skip counts as a candidate) triggers exactly ONE revote restricted to
//   the tied options (its own short timer); whatever that revote produces —
//   even another tie — is final. No further loops. An expired day with no
//   votes cast at all resolves as no-lynch — never a dead revote window.
//
// ── WIN CHECK (after every resolved elimination) ────────────────────────
//   • No mafia alive → TOWN wins.
//   • Alive mafia ≥ alive non-mafia → MAFIA wins.

export const ROLE = {
  MAFIA: "mafia",
  DOCTOR: "doctor",
  DETECTIVE: "detective",
  VILLAGER: "villager",
};

export const PHASE = {
  LOBBY: "lobby",
  NIGHT: "night",
  DAY: "day",
  OVER: "over",
};

export const SKIP = "skip";

export const MIN_PLAYERS = 4;
export const MAX_PLAYERS = 20;

export const DEFAULT_CONFIG = {
  mafiaCount: 1,
  doctorEnabled: true,
  detectiveEnabled: true,
  nightSeconds: 300, // 5:00
  daySeconds: 600, // 10:00 — cap on the whole day (chat + vote); ends early once everyone's voted
  revoteSeconds: 60, // window for the single restricted tie-revote
};

export function shuffle(arr, rng = Math.random) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function defaultMafiaCount(n) {
  return Math.max(1, Math.round(n / 4));
}

// Validate a role configuration for `n` players. Returns null if OK, else a
// human error string.
export function validateConfig(n, config) {
  if (n < MIN_PLAYERS) return `Need at least ${MIN_PLAYERS} players`;
  if (n > MAX_PLAYERS) return `At most ${MAX_PLAYERS} players`;
  const { mafiaCount, doctorEnabled, detectiveEnabled } = config;
  if (!Number.isInteger(mafiaCount) || mafiaCount < 1) {
    return "Need at least 1 mafia";
  }
  const specials = (doctorEnabled ? 1 : 0) + (detectiveEnabled ? 1 : 0);
  if (mafiaCount + specials > n) return "Too many roles for this many players";
  if (mafiaCount * 2 >= n) return "Mafia must be fewer than half the players";
  return null;
}

export function createInitialState() {
  return {
    gameType: "mafia",
    phase: PHASE.LOBBY,
    players: [], // { id, name, role, alive }
    order: [], // join order (ids)
    config: { ...DEFAULT_CONFIG },
    round: 0,
    phaseEndsAt: null,
    night: emptyNight(),
    day: emptyDay(),
    mafiaChat: [], // { t, by, text } — redacted to mafia viewers only
    dayChat: [], // { t, by, text } — public
    log: [],
    winner: null,
  };
}

function emptyNight() {
  return { mafiaVotes: {}, doctorSave: null, detectiveCheck: null };
}

function emptyDay() {
  return { votes: {}, voteCandidates: null, tieRevoted: false };
}

function clone(state) {
  return structuredClone(state);
}

function seatById(state, id) {
  return state.players.find((p) => p.id === id) || null;
}

export function alivePlayers(state) {
  return state.players.filter((p) => p.alive);
}

export function aliveMafia(state) {
  return alivePlayers(state).filter((p) => p.role === ROLE.MAFIA);
}

export function aliveNonMafia(state) {
  return alivePlayers(state).filter((p) => p.role !== ROLE.MAFIA);
}

// ── LOBBY ──────────────────────────────────────────────────────────────────
export function addPlayer(state, id, name) {
  if (state.phase !== PHASE.LOBBY) return { error: "Game already started" };
  const n = String(name || "").trim();
  if (!n) return { error: "Name required" };
  const next = clone(state);
  const existing = seatById(next, id);
  if (existing) {
    existing.name = n;
  } else {
    if (next.players.length >= MAX_PLAYERS) return { error: "Room is full" };
    next.players.push({ id, name: n, role: null, alive: true });
    next.order.push(id);
  }
  return { state: next };
}

export function removePlayer(state, id) {
  if (state.phase !== PHASE.LOBBY) return { error: "Game already started" };
  const next = clone(state);
  if (!seatById(next, id)) return { error: "Not in the lobby" };
  next.players = next.players.filter((p) => p.id !== id);
  next.order = next.order.filter((pid) => pid !== id);
  return { state: next };
}

export function setConfig(state, patch) {
  if (state.phase !== PHASE.LOBBY) return { error: "Can't change settings mid-game" };
  const next = clone(state);
  next.config = { ...next.config, ...patch };
  return { state: next };
}

export function startGame(state, rng = null) {
  if (state.phase !== PHASE.LOBBY) return { error: "Already started" };
  const n = state.players.length;
  const err = validateConfig(n, state.config);
  if (err) return { error: err };

  const { mafiaCount, doctorEnabled, detectiveEnabled } = state.config;
  const villagers = n - mafiaCount - (doctorEnabled ? 1 : 0) - (detectiveEnabled ? 1 : 0);
  const bag = [
    ...Array(mafiaCount).fill(ROLE.MAFIA),
    ...(doctorEnabled ? [ROLE.DOCTOR] : []),
    ...(detectiveEnabled ? [ROLE.DETECTIVE] : []),
    ...Array(villagers).fill(ROLE.VILLAGER),
  ];
  const roleOrder = shuffle(bag, rng || Math.random);

  const next = clone(state);
  next.players = next.order.map((id, i) => {
    const seat = seatById(next, id);
    return { ...seat, role: roleOrder[i], alive: true };
  });
  next.round = 1;
  next.phase = PHASE.NIGHT;
  next.phaseEndsAt = Date.now() + next.config.nightSeconds * 1000;
  next.night = emptyNight();
  next.day = emptyDay();
  next.mafiaChat = [];
  next.dayChat = [];
  next.log = [{ t: Date.now(), kind: "start", round: 1 }];
  next.winner = null;
  return { state: next };
}

// ── NIGHT ────────────────────────────────────────────────────────────────
export function postMafiaChat(state, playerId, text) {
  if (state.phase !== PHASE.NIGHT) return { error: "Not night" };
  const seat = seatById(state, playerId);
  if (!seat || seat.role !== ROLE.MAFIA || !seat.alive) return { error: "Not an alive mafia" };
  const t = String(text || "").trim();
  if (!t) return { error: "Empty message" };
  const next = clone(state);
  next.mafiaChat.push({ t: Date.now(), by: playerId, text: t.slice(0, 240) });
  return { state: next };
}

// Compute the mafia's consensus target from current votes, if any.
//   returns { targetId } if a strict majority of ALL alive mafia agree on the
//   same non-skip target, else { targetId: null }.
function mafiaConsensus(state) {
  const mafia = aliveMafia(state);
  const need = Math.floor(mafia.length / 2) + 1;
  const counts = new Map();
  for (const m of mafia) {
    const v = state.night.mafiaVotes[m.id];
    if (v && v !== SKIP) counts.set(v, (counts.get(v) || 0) + 1);
  }
  for (const [target, count] of counts) {
    if (count >= need) return { targetId: target };
  }
  return { targetId: null };
}

export function castMafiaVote(state, voterId, targetId) {
  if (state.phase !== PHASE.NIGHT) return { error: "Not night" };
  const seat = seatById(state, voterId);
  if (!seat || seat.role !== ROLE.MAFIA || !seat.alive) return { error: "Not an alive mafia" };
  if (targetId !== SKIP) {
    const target = seatById(state, targetId);
    if (!target || !target.alive || target.role === ROLE.MAFIA) {
      return { error: "Invalid target" };
    }
  }
  const next = clone(state);
  next.night.mafiaVotes[voterId] = targetId;
  next.log.push({ t: Date.now(), kind: "mafia_vote_cast", round: next.round, by: voterId });
  return { state: next };
}

export function castDoctorSave(state, playerId, targetId) {
  if (state.phase !== PHASE.NIGHT) return { error: "Not night" };
  const seat = seatById(state, playerId);
  if (!seat || seat.role !== ROLE.DOCTOR || !seat.alive) return { error: "Not the alive doctor" };
  const target = seatById(state, targetId);
  if (!target || !target.alive) return { error: "Invalid target" };
  const next = clone(state);
  next.night.doctorSave = targetId;
  next.log.push({ t: Date.now(), kind: "doctor_acted", round: next.round });
  return { state: next };
}

export function castDetectiveCheck(state, playerId, targetId) {
  if (state.phase !== PHASE.NIGHT) return { error: "Not night" };
  const seat = seatById(state, playerId);
  if (!seat || seat.role !== ROLE.DETECTIVE || !seat.alive) return { error: "Not the alive detective" };
  if (targetId === playerId) return { error: "Can't investigate yourself" };
  const target = seatById(state, targetId);
  if (!target || !target.alive) return { error: "Invalid target" };
  const next = clone(state);
  next.night.detectiveCheck = {
    by: playerId,
    target: targetId,
    isMafia: target.role === ROLE.MAFIA,
  };
  next.log.push({ t: Date.now(), kind: "detective_acted", round: next.round });
  return { state: next };
}

// True once every alive actionable role has acted (mafia has reached
// consensus OR every alive mafia has voted; doctor has picked if alive;
// detective has picked if alive). Callers use this (or a timer expiry) to
// decide when to call resolveNight.
export function nightActionsComplete(state) {
  if (state.phase !== PHASE.NIGHT) return false;
  const mafia = aliveMafia(state);
  const { targetId } = mafiaConsensus(state);
  const allMafiaVoted = mafia.every((m) => state.night.mafiaVotes[m.id] !== undefined);
  const mafiaDone = targetId !== null || allMafiaVoted;

  const doctor = alivePlayers(state).find((p) => p.role === ROLE.DOCTOR);
  const doctorDone = !doctor || state.night.doctorSave !== null;

  const detective = alivePlayers(state).find((p) => p.role === ROLE.DETECTIVE);
  const detectiveDone = !detective || state.night.detectiveCheck !== null;

  return mafiaDone && doctorDone && detectiveDone;
}

export function resolveNight(state) {
  if (state.phase !== PHASE.NIGHT) return { error: "Not night" };
  const next = clone(state);
  const { targetId } = mafiaConsensus(next);

  if (!targetId) {
    next.log.push({ t: Date.now(), kind: "night_no_kill", round: next.round });
    return { state: advanceToDay(next) };
  }

  const saved = next.night.doctorSave === targetId;
  if (saved) {
    next.log.push({ t: Date.now(), kind: "night_saved", round: next.round, who: targetId });
    return { state: advanceToDay(next) };
  }

  const seat = seatById(next, targetId);
  seat.alive = false;
  next.log.push({ t: Date.now(), kind: "night_killed", round: next.round, who: targetId, role: seat.role });
  return { state: checkWinOr(next, advanceToDay) };
}

function advanceToDay(state) {
  state.phase = PHASE.DAY;
  state.phaseEndsAt = Date.now() + state.config.daySeconds * 1000;
  state.day = emptyDay();
  return state;
}

// ── DAY ──────────────────────────────────────────────────────────────────
// Chat and voting are both open the whole time day is active — there's no
// separate "discussion" sub-phase to wait out before voting is allowed.
export function postDayChat(state, playerId, text) {
  if (state.phase !== PHASE.DAY) return { error: "Not day" };
  const seat = seatById(state, playerId);
  if (!seat || !seat.alive) return { error: "Only alive players can talk" };
  const t = String(text || "").trim();
  if (!t) return { error: "Empty message" };
  const next = clone(state);
  next.dayChat.push({ t: Date.now(), by: playerId, text: t.slice(0, 240) });
  return { state: next };
}

export function castDayVote(state, voterId, targetId) {
  if (state.phase !== PHASE.DAY) return { error: "Not day" };
  const seat = seatById(state, voterId);
  if (!seat || !seat.alive) return { error: "Only alive players can vote" };
  const eligible = state.day.voteCandidates || [...alivePlayers(state).map((p) => p.id), SKIP];
  if (!eligible.includes(targetId)) return { error: "Invalid vote target" };
  const next = clone(state);
  next.day.votes[voterId] = targetId;
  next.log.push({ t: Date.now(), kind: "day_vote_cast", round: next.round, by: voterId });
  return { state: next };
}

export function dayVoteComplete(state) {
  if (state.phase !== PHASE.DAY) return false;
  const alive = alivePlayers(state).map((p) => p.id);
  return alive.every((id) => state.day.votes[id] !== undefined);
}

export function resolveDayVote(state) {
  if (state.phase !== PHASE.DAY) return { error: "Not day" };
  const next = clone(state);
  const counts = new Map();
  for (const target of Object.values(next.day.votes)) {
    counts.set(target, (counts.get(target) || 0) + 1);
  }
  let max = 0;
  for (const v of counts.values()) if (v > max) max = v;
  const topped = [...counts.entries()].filter(([, v]) => v === max).map(([k]) => k);

  next.log.push({
    t: Date.now(),
    kind: "day_vote_result",
    round: next.round,
    counts: Object.fromEntries(counts),
  });

  if (topped.length === 1) {
    return { state: applyDayOutcome(next, topped[0]) };
  }

  // Zero votes (expired day, no one acted) or a second tie → no elimination.
  // Never open a revote with no candidates — that window can't resolve.
  const noElim = topped.length === 0 || next.day.tieRevoted;
  if (!noElim) {
    next.day.voteCandidates = topped;
    next.day.votes = {};
    next.day.tieRevoted = true;
    next.phaseEndsAt = Date.now() + next.config.revoteSeconds * 1000;
    next.log.push({ t: Date.now(), kind: "day_tie_revote", round: next.round, candidates: topped });
    return { state: next };
  }

  next.log.push({
    t: Date.now(),
    kind: topped.length === 0 ? "day_no_lynch" : "day_tie_no_elim",
    round: next.round,
  });
  return { state: advanceToNight(next) };
}

function applyDayOutcome(state, targetId) {
  if (targetId === SKIP) {
    state.log.push({ t: Date.now(), kind: "day_no_lynch", round: state.round });
    return advanceToNight(state);
  }
  const seat = seatById(state, targetId);
  seat.alive = false;
  state.log.push({ t: Date.now(), kind: "day_lynched", round: state.round, who: targetId, role: seat.role });
  return checkWinOr(state, advanceToNight);
}

function advanceToNight(state) {
  state.round += 1;
  state.phase = PHASE.NIGHT;
  state.phaseEndsAt = Date.now() + state.config.nightSeconds * 1000;
  state.night = emptyNight();
  state.log.push({ t: Date.now(), kind: "round", round: state.round });
  return state;
}

// ── WIN CHECK ────────────────────────────────────────────────────────────
function checkWinOr(state, advanceFn) {
  const mafia = aliveMafia(state).length;
  const town = aliveNonMafia(state).length;
  if (mafia === 0) return finish(state, "town");
  if (mafia >= town) return finish(state, "mafia");
  return advanceFn(state);
}

function finish(state, winner) {
  state.winner = winner;
  state.phase = PHASE.OVER;
  state.phaseEndsAt = null;
  state.log.push({ t: Date.now(), kind: "game_over", winner });
  return state;
}

export function resetToLobby(state) {
  const next = createInitialState();
  next.players = state.players.map((p) => ({ id: p.id, name: p.name, role: null, alive: true }));
  next.order = state.order.slice();
  next.config = { ...state.config };
  return { state: next };
}

// ── REDACTION ────────────────────────────────────────────────────────────
// Per-viewer view of the game state. Own role, dead players' roles, and (for
// mafia) fellow mafia are visible; everything secret stays server-side.
// Ballots expose only WHO voted (votedIds) plus the viewer's own vote —
// targets surface in the public day_vote_result log entry once resolved.
export function redactFor(state, viewerId) {
  if (!state) return null;
  const viewer = state.players.find((p) => p.id === viewerId) || null;
  const isMafia = viewer?.role === ROLE.MAFIA;
  const over = state.phase === PHASE.OVER;

  const roleVisible = (p) =>
    over || !p.alive || p.id === viewerId || (isMafia && p.role === ROLE.MAFIA);

  const votes = {};
  if (viewer?.alive && state.day.votes[viewerId] !== undefined) {
    votes[viewerId] = state.day.votes[viewerId];
  }

  return {
    gameType: state.gameType,
    phase: state.phase,
    round: state.round,
    phaseEndsAt: state.phaseEndsAt,
    config: state.config,
    order: state.order,
    players: state.players.map((p) => ({ ...p, role: roleVisible(p) ? p.role : null })),
    night: {
      mafiaVotes: isMafia ? { ...state.night.mafiaVotes } : {},
      doctorSave: viewer?.role === ROLE.DOCTOR ? state.night.doctorSave : null,
      detectiveCheck: viewer?.role === ROLE.DETECTIVE ? state.night.detectiveCheck : null,
    },
    day: {
      votes,
      votedIds: Object.keys(state.day.votes),
      voteCandidates: state.day.voteCandidates,
      tieRevoted: state.day.tieRevoted,
    },
    mafiaChat: isMafia ? state.mafiaChat.slice(-60) : [],
    dayChat: state.dayChat.slice(-60),
    log: isMafia
      ? state.log.slice(-80)
      : state.log.filter((e) => e.kind !== "mafia_vote_cast").slice(-80),
    winner: state.winner,
  };
}
