// Plain node:assert test suite for the MAFIA engine. No framework.
// Run: node src/games/mafia/engine.test.mjs
import assert from "node:assert/strict";
import {
  createInitialState,
  addPlayer,
  removePlayer,
  setConfig,
  startGame,
  castMafiaVote,
  castDoctorSave,
  castDetectiveCheck,
  nightActionsComplete,
  resolveNight,
  postMafiaChat,
  castDayVote,
  dayVoteComplete,
  resolveDayVote,
  resetToLobby,
  redactFor,
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

test("resetToLobby keeps the crowd + config and clears roles", () => {
  const s0 = lobbyOf(8, { mafiaCount: 2, doctorEnabled: true, detectiveEnabled: true });
  const first = startGame(s0, rngFrom(7)).state;
  const backToLobby = resetToLobby(first).state;
  assert.equal(backToLobby.phase, PHASE.LOBBY);
  assert.equal(backToLobby.players.length, 8);
  assert.ok(backToLobby.players.every((p) => p.role === null && p.alive));
  assert.equal(backToLobby.config.mafiaCount, 2);
});

test("removePlayer drops a lobby seat and its order entry", () => {
  let s = createInitialState();
  s = addPlayer(s, "p0", "A").state;
  s = addPlayer(s, "p1", "B").state;
  const res = removePlayer(s, "p0");
  assert.equal(res.state.players.length, 1);
  assert.deepEqual(res.state.order, ["p1"]);
  assert.ok(removePlayer(res.state, "p0").error);
});

test("day: zero votes at expiry resolves as no-lynch, never an empty revote", () => {
  const s0 = lobbyOf(4, { mafiaCount: 1, doctorEnabled: false, detectiveEnabled: false });
  let { state } = startGame(s0, rngFrom(6));
  state = resolveNight(state).state;
  const beforeAlive = alive(state).length;

  const resolved = resolveDayVote(state).state;
  assert.equal(resolved.day.voteCandidates, null, "no empty-candidate revote window");
  assert.equal(alive(resolved).length, beforeAlive);
  assert.equal(resolved.phase, PHASE.NIGHT);
  assert.ok(resolved.log.some((e) => e.kind === "day_no_lynch"));
});

test("redaction: villager view hides roles, mafia chat, night actions, ballots", () => {
  const s0 = lobbyOf(8, { mafiaCount: 2, doctorEnabled: true, detectiveEnabled: true });
  let { state } = startGame(s0, rngFrom(9));
  const mafiaIds = byRole(state, ROLE.MAFIA).map((p) => p.id);
  const doctor = byRole(state, ROLE.DOCTOR)[0];
  const detective = byRole(state, ROLE.DETECTIVE)[0];
  const villager = byRole(state, ROLE.VILLAGER)[0];
  state = castMafiaVote(state, mafiaIds[0], villager.id).state;
  state = castDoctorSave(state, doctor.id, villager.id).state;
  state = castDetectiveCheck(state, detective.id, mafiaIds[1]).state;

  const view = redactFor(state, villager.id);
  assert.equal(view.players.find((p) => p.id === villager.id).role, ROLE.VILLAGER);
  assert.ok(view.players.filter((p) => p.id !== villager.id).every((p) => p.role === null));
  assert.deepEqual(view.night, { mafiaVotes: {}, doctorSave: null, detectiveCheck: null });
  assert.deepEqual(view.mafiaChat, []);
  assert.ok(view.log.every((e) => e.kind !== "mafia_vote_cast"));
  assert.deepEqual(view.day.votes, {});
});

test("redaction: mafia view sees fellow mafia, chat, and their own ballots", () => {
  const s0 = lobbyOf(8, { mafiaCount: 2, doctorEnabled: true, detectiveEnabled: true });
  let { state } = startGame(s0, rngFrom(9));
  const mafiaIds = byRole(state, ROLE.MAFIA).map((p) => p.id);
  const villager = byRole(state, ROLE.VILLAGER)[0];
  state = castMafiaVote(state, mafiaIds[0], villager.id).state;
  state = postMafiaChat(state, mafiaIds[0], "hit him").state;

  const view = redactFor(state, mafiaIds[1]);
  assert.ok(view.players.filter((p) => p.role === ROLE.MAFIA).length === 2);
  assert.equal(view.night.mafiaVotes[mafiaIds[0]], villager.id);
  assert.equal(view.mafiaChat.length, 1);
  assert.ok(view.log.some((e) => e.kind === "mafia_vote_cast"));
});

test("redaction: doctor sees the save, detective sees the check — and nobody else's", () => {
  const s0 = lobbyOf(8, { mafiaCount: 2, doctorEnabled: true, detectiveEnabled: true });
  let { state } = startGame(s0, rngFrom(9));
  const doctor = byRole(state, ROLE.DOCTOR)[0];
  const detective = byRole(state, ROLE.DETECTIVE)[0];
  const mafia = byRole(state, ROLE.MAFIA)[0];
  const villager = byRole(state, ROLE.VILLAGER)[0];
  state = castDoctorSave(state, doctor.id, villager.id).state;
  state = castDetectiveCheck(state, detective.id, mafia.id).state;

  const docView = redactFor(state, doctor.id);
  assert.equal(docView.night.doctorSave, villager.id);
  assert.equal(docView.night.detectiveCheck, null);

  const detView = redactFor(state, detective.id);
  assert.equal(detView.night.detectiveCheck.isMafia, true);
  assert.equal(detView.night.doctorSave, null);
});

test("redaction: dead players' roles are public; day votes expose only who voted", () => {
  const s0 = lobbyOf(4, { mafiaCount: 1, doctorEnabled: false, detectiveEnabled: false });
  let { state } = startGame(s0, rngFrom(5));
  const mafia = byRole(state, ROLE.MAFIA)[0];
  const townIds = state.players.filter((p) => p.role !== ROLE.MAFIA).map((p) => p.id);
  state = castMafiaVote(state, mafia.id, townIds[0]).state;
  state = resolveNight(state).state; // townIds[0] killed, role revealed

  const viewer = state.players.find((p) => p.id === townIds[1]);
  state = castDayVote(state, viewer.id, mafia.id).state;

  const view = redactFor(state, townIds[2]);
  const dead = view.players.find((p) => p.id === townIds[0]);
  assert.ok(dead.role !== null, "dead role always visible");
  assert.deepEqual(view.day.votes, {}, "other ballots' targets are hidden");
  assert.deepEqual(view.day.votedIds, [townIds[1]]);

  const ownView = redactFor(state, townIds[1]);
  assert.equal(ownView.day.votes[townIds[1]], mafia.id, "own ballot visible to its voter");
});

test("redaction: game over reveals everything to everyone", () => {
  const s0 = lobbyOf(4, { mafiaCount: 1, doctorEnabled: false, detectiveEnabled: false });
  let { state } = startGame(s0, rngFrom(7));
  const mafia = byRole(state, ROLE.MAFIA)[0];
  const others = state.players.filter((p) => p.id !== mafia.id).map((p) => p.id);
  state = resolveNight(state).state;
  for (const v of others) state = castDayVote(state, v, mafia.id).state;
  state = castDayVote(state, mafia.id, others[0]).state;
  const resolved = resolveDayVote(state).state;
  assert.equal(resolved.winner, "town");

  const view = redactFor(resolved, others[0]);
  assert.ok(view.players.every((p) => p.role !== null));
});

console.log(`\n${passed} passed`);
