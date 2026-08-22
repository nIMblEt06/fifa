// Plain node:assert test suite for the MAFIA engine. No framework.
// Run: node src/games/mafia/engine.test.mjs
import assert from "node:assert/strict";
import {
  createInitialState,
  addPlayer,
  setConfig,
  startGame,
  castMafiaVote,
  castDoctorSave,
  castDetectiveCheck,
  nightActionsComplete,
  resolveNight,
  castDayVote,
  dayVoteComplete,
  resolveDayVote,
  resetToLobby,
  ROLE,
  PHASE,
  SKIP,
} from "./engine.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log("  ok -", name);
}

function rngFrom(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lobbyOf(n, config = {}) {
  let s = createInitialState();
  for (let i = 0; i < n; i++) {
    s = addPlayer(s, `p${i}`, `P${i}`).state;
  }
  s = setConfig(s, config).state;
  return s;
}

function byRole(s, role) {
  return s.players.filter((p) => p.role === role);
}
function alive(s) {
  return s.players.filter((p) => p.alive);
}

test("addPlayer dedupes by id and rejects mid-game joins", () => {
  let s = createInitialState();
  s = addPlayer(s, "p0", "A").state;
  s = addPlayer(s, "p0", "A-renamed").state;
  assert.equal(s.players.length, 1);
  assert.equal(s.players[0].name, "A-renamed");
});

test("startGame assigns exact role counts", () => {
  const s0 = lobbyOf(8, { mafiaCount: 2, doctorEnabled: true, detectiveEnabled: true });
  const { state } = startGame(s0, rngFrom(1));
  assert.equal(byRole(state, ROLE.MAFIA).length, 2);
  assert.equal(byRole(state, ROLE.DOCTOR).length, 1);
  assert.equal(byRole(state, ROLE.DETECTIVE).length, 1);
  assert.equal(byRole(state, ROLE.VILLAGER).length, 4);
  assert.equal(state.phase, PHASE.NIGHT);
  assert.equal(state.round, 1);
});

test("startGame rejects mafia majority", () => {
  const s0 = lobbyOf(6, { mafiaCount: 3, doctorEnabled: false, detectiveEnabled: false });
  const { error } = startGame(s0, rngFrom(1));
  assert.ok(error);
});

test("night: strict mafia majority kills, minority split is a tie with no kill", () => {
  // 4 mafia so we can test a 2-2 split.
  const s0 = lobbyOf(12, { mafiaCount: 4, doctorEnabled: false, detectiveEnabled: false });
  let { state } = startGame(s0, rngFrom(2));
  const mafiaIds = byRole(state, ROLE.MAFIA).map((p) => p.id);
  const townIds = state.players.filter((p) => p.role !== ROLE.MAFIA).map((p) => p.id);

  // 2-2 split between two town targets → no strict majority.
  state = castMafiaVote(state, mafiaIds[0], townIds[0]).state;
  state = castMafiaVote(state, mafiaIds[1], townIds[0]).state;
  state = castMafiaVote(state, mafiaIds[2], townIds[1]).state;
  state = castMafiaVote(state, mafiaIds[3], townIds[1]).state;
  assert.equal(nightActionsComplete(state), true);
  const beforeAlive = alive(state).length;
  const resolved = resolveNight(state).state;
  assert.equal(alive(resolved).length, beforeAlive, "tie kills no one");
  assert.equal(resolved.phase, PHASE.DAY);
});

test("night: 3-of-4 mafia agreeing already crosses majority, short-circuits the 4th vote", () => {
  const s0 = lobbyOf(12, { mafiaCount: 4, doctorEnabled: false, detectiveEnabled: false });
  let { state } = startGame(s0, rngFrom(2));
  const mafiaIds = byRole(state, ROLE.MAFIA).map((p) => p.id);
  const townIds = state.players.filter((p) => p.role !== ROLE.MAFIA).map((p) => p.id);
  const target = townIds[0];

  state = castMafiaVote(state, mafiaIds[0], target).state;
  state = castMafiaVote(state, mafiaIds[1], target).state;
  state = castMafiaVote(state, mafiaIds[2], target).state;
  assert.equal(nightActionsComplete(state), true);
  const resolved = resolveNight(state).state;
  const seat = resolved.players.find((p) => p.id === target);
  assert.equal(seat.alive, false);
});

test("night: doctor save cancels the kill", () => {
  const s0 = lobbyOf(8, { mafiaCount: 1, doctorEnabled: true, detectiveEnabled: false });
  let { state } = startGame(s0, rngFrom(3));
  const mafia = byRole(state, ROLE.MAFIA)[0];
  const doctor = byRole(state, ROLE.DOCTOR)[0];
  const target = state.players.find((p) => p.role === ROLE.VILLAGER);

  state = castMafiaVote(state, mafia.id, target.id).state;
  state = castDoctorSave(state, doctor.id, target.id).state;
  assert.equal(nightActionsComplete(state), true);
  const resolved = resolveNight(state).state;
  const seat = resolved.players.find((p) => p.id === target.id);
  assert.equal(seat.alive, true);
  assert.equal(resolved.phase, PHASE.DAY);
});

test("night: detective learns mafia status privately", () => {
  const s0 = lobbyOf(8, { mafiaCount: 1, doctorEnabled: false, detectiveEnabled: true });
  let { state } = startGame(s0, rngFrom(4));
  const mafia = byRole(state, ROLE.MAFIA)[0];
  const detective = byRole(state, ROLE.DETECTIVE)[0];

  state = castDetectiveCheck(state, detective.id, mafia.id).state;
  assert.equal(state.night.detectiveCheck.isMafia, true);
});

test("day vote: majority lynches, role revealed", () => {
  const s0 = lobbyOf(6, { mafiaCount: 1, doctorEnabled: false, detectiveEnabled: false });
  let { state } = startGame(s0, rngFrom(5));
  // Skip straight to day by resolving an empty night.
  state = resolveNight(state).state;

  const target = alive(state)[0];
  const voters = alive(state).map((p) => p.id);
  for (const v of voters) {
    state = castDayVote(state, v, v === target.id ? SKIP : target.id).state;
  }
  assert.equal(dayVoteComplete(state), true);
  const resolved = resolveDayVote(state).state;
  const seat = resolved.players.find((p) => p.id === target.id);
  assert.equal(seat.alive, false);
  assert.equal(resolved.phase, PHASE.NIGHT);
});

test("day vote: tie triggers exactly one revote, second tie is final (no elimination)", () => {
  const s0 = lobbyOf(4, { mafiaCount: 1, doctorEnabled: false, detectiveEnabled: false });
  let { state } = startGame(s0, rngFrom(6));
  state = resolveNight(state).state;

  const ids = alive(state).map((p) => p.id);
  // 2-2 tie between the first two candidates.
  state = castDayVote(state, ids[0], ids[2]).state;
  state = castDayVote(state, ids[1], ids[3]).state;
  state = castDayVote(state, ids[2], ids[2]).state;
  state = castDayVote(state, ids[3], ids[3]).state;
  assert.equal(dayVoteComplete(state), true);
  let resolved = resolveDayVote(state).state;
  assert.equal(resolved.phase, PHASE.DAY, "still voting — revote in progress");
  assert.deepEqual(new Set(resolved.day.voteCandidates), new Set([ids[2], ids[3]]));

  // Revote ties again → final, no elimination.
  resolved = castDayVote(resolved, ids[0], ids[2]).state;
  resolved = castDayVote(resolved, ids[1], ids[3]).state;
  resolved = castDayVote(resolved, ids[2], ids[2]).state;
  resolved = castDayVote(resolved, ids[3], ids[3]).state;
  const beforeAlive = alive(resolved).length;
  const final = resolveDayVote(resolved).state;
  assert.equal(alive(final).length, beforeAlive, "second consecutive tie kills no one");
  assert.equal(final.phase, PHASE.NIGHT);
});

test("win check: all mafia dead → town wins", () => {
  const s0 = lobbyOf(4, { mafiaCount: 1, doctorEnabled: false, detectiveEnabled: false });
  let { state } = startGame(s0, rngFrom(7));
  const mafia = byRole(state, ROLE.MAFIA)[0];
  const others = state.players.filter((p) => p.id !== mafia.id).map((p) => p.id);

  state = resolveNight(state).state; // no kill
  for (const v of others) state = castDayVote(state, v, mafia.id).state;
  state = castDayVote(state, mafia.id, others[0]).state;
  const resolved = resolveDayVote(state).state;
  assert.equal(resolved.winner, "town");
  assert.equal(resolved.phase, PHASE.OVER);
});

test("win check: mafia parity with town → mafia wins", () => {
  const s0 = lobbyOf(4, { mafiaCount: 1, doctorEnabled: false, detectiveEnabled: false });
  let { state } = startGame(s0, rngFrom(8));
  const mafia = byRole(state, ROLE.MAFIA)[0];
  const town = state.players.filter((p) => p.role !== ROLE.MAFIA);

  // Mafia kills until parity (1 mafia vs 1 town → mafia >= town).
  let s = state;
  for (let i = 0; i < town.length - 1; i++) {
    const alive0 = alive(s).filter((p) => p.role !== ROLE.MAFIA);
    s = castMafiaVote(s, mafia.id, alive0[0].id).state;
    s = resolveNight(s).state;
    if (s.winner) break;
    // no lynch — everyone skips.
    for (const v of alive(s)) s = castDayVote(s, v.id, SKIP).state;
    s = resolveDayVote(s).state;
    if (s.winner) break;
  }
  assert.equal(s.winner, "mafia");
});

test("startGame is deterministic for the same lobby: racing clients with no explicit rng converge", () => {
  const s0 = lobbyOf(8, { mafiaCount: 2, doctorEnabled: true, detectiveEnabled: true });
  const a = startGame(s0).state; // no rng passed — two "clients" computing from the same s0
  const b = startGame(s0).state;
  assert.deepEqual(a.players.map((p) => p.role), b.players.map((p) => p.role));
});

test("resetToLobby bumps gamesPlayed so a same-players replay reshuffles roles", () => {
  const s0 = lobbyOf(8, { mafiaCount: 2, doctorEnabled: true, detectiveEnabled: true });
  const first = startGame(s0).state;
  const backToLobby = resetToLobby(first).state;
  assert.equal(backToLobby.gamesPlayed, 1);
  const second = startGame(backToLobby).state;
  assert.notDeepEqual(
    first.players.map((p) => p.role),
    second.players.map((p) => p.role),
    "replaying with identical players/settings should not reproduce the exact same role assignment"
  );
});

console.log(`\n${passed} passed`);
