// End-to-end room smoke test against the dev server (vite + real Worker + DO).
//
// Requires the dev server running first:
//   npm run dev        (in another terminal)
//   npm run smoke
//
// Drives a full 4-player MAFIA game over real WebSockets — join, config,
// start, night kills, day votes — until it ends, asserting at every snapshot
// that the per-viewer redaction never leaks (roles, mafia chat, night
// actions, ballot targets) and that the game terminates with a winner.
import assert from "node:assert/strict";

const BASE = process.env.SMOKE_BASE || "http://localhost:5173";
const CODE = "SMOKE" + Math.random().toString(36).slice(2, 6).toUpperCase();
const ROLE = { MAFIA: "mafia", DOCTOR: "doctor", DETECTIVE: "detective", VILLAGER: "villager" };

// One WebSocket client with a clientId + a check-based snapshot waiter.
function client(id) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace("http", "ws")}/api/room/${CODE}/ws`);
    const pending = [];
    const waiters = [];
    ws.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (process.env.SMOKE_TRACE) {
        const s = data.data || {};
        console.log(
          `${id} ← ${data.type} ${s.phase || ""} votes=${JSON.stringify(s.day?.votes || {})} votedIds=${(s.day?.votedIds || []).length} alive=${(s.players || []).filter((p) => p.alive).length}`
        );
      }
      const msg = data.type === "state" ? data.data : data.type === "error" ? { __error: data.message } : null;
      if (!msg) return;
      const idx = waiters.findIndex((w) => w.check(msg));
      if (idx >= 0) {
        const w = waiters.splice(idx, 1)[0];
        clearTimeout(w.timer);
        w.res(msg);
      } else {
        pending.push(msg);
      }
    };
    ws.onerror = () => reject(new Error("ws error"));
    ws.onopen = () => {
      resolve({
        id,
        send: (obj) => ws.send(JSON.stringify(obj)),
        next: (check = () => true, timeoutMs = 8000) =>
          new Promise((res, rej) => {
            const i = pending.findIndex(check);
            if (i >= 0) return res(pending.splice(i, 1)[0]);
            const timer = setTimeout(
              () => rej(new Error(`${id}: no matching snapshot in ${timeoutMs}ms; pending=[${pending.map((m) => m.phase || m.__error || "?").join(",")}] waiters=${waiters.length}`)),
              timeoutMs
            );
            waiters.push({ check, res, timer });
          }),
        close: () => ws.close(),
      });
    };
  });
}

// Redaction invariants, asserted on every snapshot of every viewer.
function assertRedacted(view, meId, label) {
  if (view.phase === "over") {
    assert.ok(view.players.every((p) => p.role !== null), `${label}: over reveals all roles`);
    return;
  }
  const iAmMafia = view.players.find((p) => p.id === meId)?.role === ROLE.MAFIA;
  for (const p of view.players) {
    if (p.id === meId) continue;
    if (!p.alive) {
      assert.ok(p.role !== null, `${label}: dead role public`);
    } else if (!(iAmMafia && p.role === ROLE.MAFIA)) {
      assert.equal(p.role, null, `${label}: alive player ${p.id}'s role must be hidden`);
    }
  }
  if (!iAmMafia) {
    assert.deepEqual(view.night.mafiaVotes, {}, `${label}: no mafia votes leak`);
    assert.deepEqual(view.mafiaChat, [], `${label}: no mafia chat leaks`);
    assert.ok(view.log.every((e) => e.kind !== "mafia_vote_cast"), `${label}: no mafia vote log leaks`);
  }
}

const players = await Promise.all([client("c0"), client("c1"), client("c2"), client("c3")]);
if (process.env.SMOKE_TRACE) {
  players.forEach((p) => {
    const orig = p.send.bind(p);
    p.send = (obj) => { console.log(`${p.id} →`, JSON.stringify(obj).slice(0, 120)); orig(obj); };
  });
}
const checkAll = (views, label) => {
  views.forEach((v, i) => assertRedacted(v, players[i].id, label));
  return views;
};

// Join all four seats.
for (const p of players) p.send({ type: "join", game: "mafia", clientId: p.id, name: `P${p.id}` });
await players[0].next((v) => v.phase === "lobby" && v.players?.length === 4);

// No specials: 4 players, 1 mafia, 3 villagers.
players[0].send({ type: "mf_config", patch: { doctorEnabled: false, detectiveEnabled: false, mafiaCount: 1 } });
await players[0].next((v) => v.config && v.config.doctorEnabled === false && v.config.mafiaCount === 1);

players[0].send({ type: "mf_start" });
let views = await Promise.all(players.map((p) => p.next((v) => v.phase === "night")));
checkAll(views, "night-1");

// Everyone sees their own role; exactly one seat is mafia.
const ownRoles = views.map((v, i) => v.players.find((p) => p.id === players[i].id)?.role);
assert.ok(ownRoles.every((r) => r != null), "everyone sees their own role");
assert.equal(ownRoles.filter((r) => r === ROLE.MAFIA).length, 1, "exactly one mafia seat");
const mafia = players[ownRoles.findIndex((r) => r === ROLE.MAFIA)];
const town = players.filter((p) => p !== mafia);

// Mafia chat: mafia sees it, town never does. The chat broadcast reaches
// everyone — town gets a fresh night-phase snapshot with an empty chat.
mafia.send({ type: "mf_mafiaChat", text: "take him" });
const chatView = await mafia.next((v) => v.mafiaChat?.length === 1);
assert.equal(chatView.mafiaChat[0].text, "take him");
const townChatViews = await Promise.all(town.map((p) => p.next((v) => v.phase === "night" && v.mafiaChat)));
for (const v of townChatViews) assert.deepEqual(v.mafiaChat, [], "town never sees mafia chat");

// ── Drive rounds: mafia kills, town lynches a fixed non-mafia target ──
let round = 0;
let over = null;
while (!over && round < 20) {
  round += 1;
  const aliveIds = views[0].players.filter((p) => p.alive).map((p) => p.id);
  const target = aliveIds.find((id) => id !== mafia.id) ?? aliveIds[0];

  // Only the mafia client's night vote lands; everyone else is rejected.
  // (If the mafia's vote already resolved the night, later sends get "Not
  // night" — equally fine: the point is no town vote ever lands.)
  mafia.send({ type: "mf_mafiaVote", targetId: target });
  const rejects = await Promise.all(
    town.filter((p) => p.id !== target).map(async (p) => {
      p.send({ type: "mf_mafiaVote", targetId: target });
      return p.next((v) => v.__error === "Not an alive mafia" || v.__error === "Not night");
    })
  );
  assert.equal(rejects.length, town.filter((p) => p.id !== target).length, "non-mafia votes rejected");

  // Single mafia + no specials → night resolves instantly to day.
  const dayViews = await Promise.all(players.map((p) => p.next((v) => v.phase === "day", 10000)));
  checkAll(dayViews, `day-r${round}`);

  // Lynch someone still alive this morning (not the mafia, if possible).
  const dayAlive = dayViews[0].players.filter((p) => p.alive);
  const lynch = dayAlive.find((p) => p.id !== mafia.id)?.id ?? dayAlive[0].id;

  // Every alive player votes for the same target. Each client resolves once:
  // its own-ballot snapshot, or — for the deciding vote — the resolution
  // broadcast itself (night/over). Dead clients just await the resolution.
  views = await Promise.all(
    players.map(async (p) => {
      const seat = dayViews[0].players.find((x) => x.id === p.id);
      if (!seat?.alive) {
        return p.next((v) => v.phase === "night" || v.phase === "over", 10000);
      }
      p.send({ type: "mf_dayVote", targetId: lynch });
      const own = await p.next(
        (v) => v.day?.votes?.[p.id] === lynch || v.phase === "night" || v.phase === "over",
        10000
      );
      if (own.phase === "night" || own.phase === "over") return own;
      return p.next((v) => v.phase === "night" || v.phase === "over", 10000);
    })
  );
  checkAll(views, `post-vote-r${round}`);
  views.forEach((v, i) => {
    if (v.phase === "over") return;
    assert.deepEqual(
      Object.keys(v.day.votes).filter((k) => k !== players[i].id),
      [],
      `viewer ${players[i].id} must not see other ballots`
    );
  });
  if (views[0].phase === "over") over = views;
}

assert.ok(over, `game must end within ${round} rounds`);
assert.ok(["town", "mafia"].includes(over[0].winner), `valid winner, got ${over[0].winner}`);
assert.ok(over[0].players.every((p) => p.role !== null), "game over reveals the full roster");
for (const p of players) p.close();
console.log(`  ok - full mafia game over ws: winner=${over[0].winner} in ${round} rounds`);
console.log(`\n1 passed (room ${CODE})`);
process.exit(0);
