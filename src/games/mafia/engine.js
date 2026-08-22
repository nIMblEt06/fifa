// Pure game engine for "MAFIA".
//
// Unlike lit/poker/undercover/hitler, this room is CLIENT-AUTHORITATIVE (like
// FIFA): the whole state blob is posted to /state and broadcast verbatim to
// every socket. There is no server-side redaction — every client technically
// receives the mafia roster, mafia chat, and vote tallies in the raw blob.
// The UI is responsible for only ever DISPLAYING what a given player should
// see; this is an accepted tradeoff for a casual friend-group game, not a
// security boundary.
//
// Because any connected client can compute-and-POST a transition (there is no
// central arbiter), every apply* function here is a pure (state, ...args) =>
// { state } | { error } reducer over the FULL blob, so any client's tap (or a
// client's own timer-expiry watcher) can drive the game forward.
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
//   even another tie — is final. No further loops.
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

// mulberry32 — deterministic PRNG from a 32-bit seed.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Because this room is client-authoritative and there's no host, more than
// one player can tap "Start" on the same pre-start lobby at nearly the same
// moment — each computing startGame() independently on their own client.
// If the shuffle used Math.random(), those two calls would produce DIFFERENT
// role assignments for the same player list; whichever POST reaches the
// Durable Object last wins the broadcast, silently swapping out a role a
// player already saw on their reveal card. Seeding the shuffle from the
// lobby's own contents (join order + config + gamesPlayed) makes every such
// racing call converge on the IDENTICAL result, so it no longer matters who
// "wins" — while gamesPlayed (bumped on every reset) still guarantees a
// "Play Again" with the same players and settings gets a fresh shuffle
// instead of reproducing the exact same roles.
function seedFromLobby(order, config, gamesPlayed) {
  return fnv1a(order.join(",") + "|" + JSON.stringify(config) + "|" + gamesPlayed);
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
    gamesPlayed: 0,
    round: 0,
    phaseEndsAt: null,
    night: emptyNight(),
    day: emptyDay(),
    mafiaChat: [], // { t, by, text } — present in the blob for everyone; UI hides it from non-mafia
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

  // Deterministic by default (see seedFromLobby above) — only tests pass an
  // explicit rng to force a particular shuffle.
  const effectiveRng = rng || mulberry32(seedFromLobby(state.order, state.config, state.gamesPlayed));

  const { mafiaCount, doctorEnabled, detectiveEnabled } = state.config;
  const villagers = n - mafiaCount - (doctorEnabled ? 1 : 0) - (detectiveEnabled ? 1 : 0);
  const bag = [
    ...Array(mafiaCount).fill(ROLE.MAFIA),
    ...(doctorEnabled ? [ROLE.DOCTOR] : []),
    ...(detectiveEnabled ? [ROLE.DETECTIVE] : []),
    ...Array(villagers).fill(ROLE.VILLAGER),
  ];
  const roleOrder = shuffle(bag, effectiveRng);

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

  if (!next.day.tieRevoted) {
    next.day.voteCandidates = topped;
    next.day.votes = {};
    next.day.tieRevoted = true;
    next.phaseEndsAt = Date.now() + next.config.revoteSeconds * 1000;
    next.log.push({ t: Date.now(), kind: "day_tie_revote", round: next.round, candidates: topped });
    return { state: next };
  }

  // Second tie (post-revote) → final, no elimination.
  next.log.push({ t: Date.now(), kind: "day_tie_no_elim", round: next.round });
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
  // Bump so a same-players/same-settings replay still reshuffles roles
  // (see seedFromLobby) instead of reproducing the exact prior assignment.
  next.gamesPlayed = (state.gamesPlayed || 0) + 1;
  return { state: next };
}
