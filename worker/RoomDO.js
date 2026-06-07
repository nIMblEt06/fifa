import { DurableObject } from "cloudflare:workers";
import { startGame, applyAsk, applyDeclare, redactFor, healState, defaultTeams } from "../src/games/lit/engine.js";
import {
  createTable, startHand, applyAction, addChips, setSittingOut,
  seatPlayer, cashOutPlayer, canStartHand, redactFor as redactPoker,
} from "../src/games/poker/engine.js";
import { getGroups, getGroupMembers, createSettlementExpense } from "./splitwise.js";
import {
  startGame as startBluff,
  applyPlay as applyBluffPlay,
  applyPass as applyBluffPass,
  applyBluff as applyBluffCall,
  redactFor as redactBluff,
  healState as healBluff,
} from "../src/games/bluff/engine.js";
import * as Hitler from "../src/games/hitler/engine.js";

// One Durable Object instance per room code. Owns:
//   • persistent room state (storage)
//   • the set of currently-connected WebSockets (presence)
//   • broadcasting state changes + reactions to all connections
//
// Two room flavors:
//   • "fifa" (default, legacy): client-authoritative. Whole state POSTed to
//     /state and broadcast verbatim. Everyone sees the same blob.
//   • "lit": server-authoritative. The authoritative game state lives in storage;
//     clients drive it via WS messages (`join`, `start`, `ask`, `reset`).
//     Each socket receives a redacted view (own hand visible only).
//
// Uses the hibernation API. WS attachments (serializeAttachment) carry the
// per-socket identity (clientId, playerName, game) across hibernation.
export class RoomDO extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/api\/room\/[A-Za-z0-9-]{2,32}\/(state|reaction|presence|ws|splitwise(?:\/[a-z]+)?)\/?$/);
    const action = m ? m[1].toLowerCase() : null;

    if (request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }

    if (action && action.startsWith("splitwise")) {
      return cors(await this.handleSplitwise(action, request));
    }

    if (action === "state") {
      if (request.method === "GET") {
        const state = (await this.ctx.storage.get("state")) ?? null;
        const presence = this.ctx.getWebSockets().length;
        return cors(json({ state, presence }));
      }
      if (request.method === "POST") {
        // Legacy FIFA write path: client owns the state blob.
        const body = await request.json();
        await this.ctx.storage.put("state", body);
        this.broadcast({ type: "state", data: body });
        return cors(json({ ok: true }));
      }
    }

    if (action === "reaction" && request.method === "POST") {
      const body = await request.json();
      this.broadcast({
        type: "reaction",
        emoji: body.emoji,
        by: body.by,
        t: Date.now(),
      });
      return cors(json({ ok: true }));
    }

    if (action === "presence" && request.method === "POST") {
      return cors(json({ count: this.ctx.getWebSockets().length }));
    }

    if (action === "ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return cors(new Response("Expected websocket", { status: 426 }));
      }
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.ctx.acceptWebSocket(server);

      const presence = this.ctx.getWebSockets().length;
      try { server.send(JSON.stringify({ type: "hello", presence })); } catch (_e) { void _e; }

      // Push initial state.
      //   • FIFA: send the whole state blob (legacy behavior).
      //   • Lit: ALWAYS send a usable snapshot — the lobby list pre-game, a
      //     spectator-view of the game once started — so refreshes and new
      //     joiners can see who's seated without first having to claim a seat.
      const state = await this.ctx.storage.get("state");
      const gameType = state?.gameType || "fifa";
      if (gameType === "lit") {
        const payload = buildLitSnapshot(state, /* viewerId */ null);
        try { server.send(JSON.stringify({ type: "state", data: payload })); } catch (_e) { void _e; }
      } else if (gameType === "poker" && state.v === 2) {
        // Server-authoritative poker: spectator snapshot until the socket joins.
        const payload = buildPokerSnapshot(state, /* viewerId */ null);
        try { server.send(JSON.stringify({ type: "state", data: payload })); } catch (_e) { void _e; }
      } else if (gameType === "bluff") {
        const payload = buildBluffSnapshot(state, /* viewerId */ null);
        try { server.send(JSON.stringify({ type: "state", data: payload })); } catch (_e) { void _e; }
      } else if (gameType === "hitler") {
        const payload = buildHitlerSnapshot(state, /* viewerId */ null);
        try { server.send(JSON.stringify({ type: "state", data: payload })); } catch (_e) { void _e; }
      } else if (state) {
        // Client-authoritative games (FIFA, Poker, …): relay the raw blob.
        try { server.send(JSON.stringify({ type: "state", data: state })); } catch (_e) { void _e; }
      }
      this.broadcastExcept(server, { type: "presence", count: presence });

      return new Response(null, { status: 101, webSocket: client });
    }

    return cors(new Response("Not Found", { status: 404 }));
  }

  // Hibernation handlers ────────────────────────────────────────────────

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)); }
    catch { return; }
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "join") {
      // { type: "join", game: "lit"|"poker", clientId, name, memberId? }
      const game = msg.game || "lit";
      ws.serializeAttachment({ clientId: msg.clientId, name: msg.name, game });
      if (game === "poker") {
        await this.handlePokerJoin(msg);
        return;
      }
      if (game === "lit") {
        await this.ensureLitState();
        const state = await this.ctx.storage.get("state");
        let dirty = false;
        // Seat the player if not yet started. Require a name to claim a seat
        // (a nameless ws is just a spectator/reconnect probe).
        if (!state.game && msg.name) {
          state.lobby = state.lobby || [];
          const existing = state.lobby.find((p) => p.id === msg.clientId);
          const isNew = !existing;
          if (existing) existing.name = msg.name;
          else state.lobby.push({ id: msg.clientId, name: msg.name });
          // If team mode is set, slot the new joiner into the smaller team
          // so the lobby stays balanced.
          if (isNew && state.mode === "team" && state.teams) {
            const [a, b] = state.teams;
            (a.playerIds.length <= b.playerIds.length ? a : b)
              .playerIds.push(msg.clientId);
          }
          dirty = true;
        }
        // Self-heal: in-flight games saved before the empty-hand-auto-draw
        // fix can be stuck. healState advances turns or auto-draws as needed.
        if (state.game && !state.game.winner) {
          const before = JSON.stringify(state.game);
          state.game = healState(state.game);
          if (JSON.stringify(state.game) !== before) dirty = true;
        }
        if (dirty) await this.ctx.storage.put("state", state);
        await this.broadcastLitState();
      } else if (game === "bluff") {
        await this.ensureBluffState();
        const state = await this.ctx.storage.get("state");
        let dirty = false;
        if (!state.game && msg.name) {
          state.lobby = state.lobby || [];
          const existing = state.lobby.find((p) => p.id === msg.clientId);
          if (existing) existing.name = msg.name;
          else state.lobby.push({ id: msg.clientId, name: msg.name });
          dirty = true;
        }
        // Self-heal in-flight games (advance a stuck turn if needed).
        if (state.game && !state.game.loser) {
          const before = JSON.stringify(state.game);
          state.game = healBluff(state.game);
          if (JSON.stringify(state.game) !== before) dirty = true;
        }
        if (dirty) await this.ctx.storage.put("state", state);
        await this.broadcastBluffState();
      } else if (game === "hitler") {
        await this.ensureHitlerState();
        const state = await this.ctx.storage.get("state");
        let dirty = false;
        // Seat the player if not yet started. Require a name to claim a seat.
        if (!state.game && msg.name) {
          state.lobby = state.lobby || [];
          const existing = state.lobby.find((p) => p.id === msg.clientId);
          if (existing) existing.name = msg.name;
          else if (state.lobby.length < 10) state.lobby.push({ id: msg.clientId, name: msg.name });
          dirty = true;
        }
        if (dirty) await this.ctx.storage.put("state", state);
        await this.broadcastHitlerState();
      }
      return;
    }

    if (typeof msg.type === "string" && msg.type.startsWith("poker")) {
      await this.handlePokerMessage(ws, msg);
      return;
    }

    // ── Secret Hitler actions ───────────────────────────────────────────
    if (msg.type?.startsWith("hitler:")) {
      await this.handleHitlerAction(ws, msg);
      return;
    }

    if (msg.type === "setMode") {
      // Switch lobby into solo or team mode. Resets team assignment using
      // the default alternating split.
      const state = await this.ctx.storage.get("state");
      if (!state || state.gameType !== "lit" || state.game) return;
      const mode = msg.mode === "team" ? "team" : "solo";
      state.mode = mode;
      state.teams = mode === "team" ? defaultTeams(state.lobby || []) : null;
      await this.ctx.storage.put("state", state);
      await this.broadcastLitState();
      return;
    }

    if (msg.type === "swapTeam") {
      // Flip the target player to the other team.
      const state = await this.ctx.storage.get("state");
      if (!state || state.gameType !== "lit" || state.game) return;
      if (state.mode !== "team" || !state.teams) return;
      const target = msg.targetClientId;
      let moved = false;
      for (const t of state.teams) {
        const idx = t.playerIds.indexOf(target);
        if (idx >= 0) {
          t.playerIds.splice(idx, 1);
          const other = state.teams.find((x) => x.id !== t.id);
          other.playerIds.push(target);
          moved = true;
          break;
        }
      }
      if (!moved) return;
      await this.ctx.storage.put("state", state);
      await this.broadcastLitState();
      return;
    }

    if (msg.type === "start") {
      const state = await this.ctx.storage.get("state");
      if (!state || state.gameType !== "lit") return;
      if (state.game) return;
      if (!state.lobby || state.lobby.length < 2) return;
      const mode = state.mode === "team" ? "team" : "solo";
      try {
        const opts = mode === "team" ? { mode, teams: state.teams } : { mode };
        state.game = startGame(state.lobby, opts);
      } catch (e) {
        try { ws.send(JSON.stringify({ type: "error", message: e.message })); } catch (_e) { void _e; }
        return;
      }
      await this.ctx.storage.put("state", state);
      await this.broadcastLitState();
      return;
    }

    if (msg.type === "ask") {
      const state = await this.ctx.storage.get("state");
      if (!state?.game) return;
      const att = ws.deserializeAttachment();
      if (!att?.clientId) return;
      const res = applyAsk(state.game, att.clientId, msg.toId, msg.rank);
      if (res.error) {
        try { ws.send(JSON.stringify({ type: "error", message: res.error })); } catch (_e) { void _e; }
        return;
      }
      state.game = res.state;
      await this.ctx.storage.put("state", state);
      await this.broadcastLitState();
      return;
    }

    if (msg.type === "declare") {
      const state = await this.ctx.storage.get("state");
      if (!state?.game) return;
      const att = ws.deserializeAttachment();
      if (!att?.clientId) return;
      const res = applyDeclare(state.game, att.clientId, msg.rank);
      if (res.error) {
        try { ws.send(JSON.stringify({ type: "error", message: res.error })); } catch (_e) { void _e; }
        return;
      }
      state.game = res.state;
      await this.ctx.storage.put("state", state);
      await this.broadcastLitState();
      return;
    }

    if (msg.type === "reset") {
      const state = await this.ctx.storage.get("state");
      if (!state || state.gameType !== "lit") return;
      const lobby = state.lobby || [];
      const mode = state.mode === "team" ? "team" : "solo";
      const teams = mode === "team" ? defaultTeams(lobby) : null;
      await this.ctx.storage.put("state", { gameType: "lit", lobby, mode, teams, game: null });
      await this.broadcastLitState();
      return;
    }

    // ── BLUFF actions ───────────────────────────────────────────────
    if (msg.type === "bluffStart") {
      const state = await this.ctx.storage.get("state");
      if (!state || state.gameType !== "bluff" || state.game) return;
      if (!state.lobby || state.lobby.length < 3) return;
      try {
        state.game = startBluff(state.lobby);
      } catch (e) {
        try { ws.send(JSON.stringify({ type: "error", message: e.message })); } catch (_e) { void _e; }
        return;
      }
      await this.ctx.storage.put("state", state);
      await this.broadcastBluffState();
      return;
    }

    if (msg.type === "bluffPlay" || msg.type === "bluffPass" || msg.type === "bluffCall") {
      const state = await this.ctx.storage.get("state");
      if (!state?.game || state.gameType !== "bluff") return;
      const att = ws.deserializeAttachment();
      if (!att?.clientId) return;
      let res;
      if (msg.type === "bluffPlay") res = applyBluffPlay(state.game, att.clientId, msg.cards, msg.claim);
      else if (msg.type === "bluffPass") res = applyBluffPass(state.game, att.clientId);
      else res = applyBluffCall(state.game, att.clientId);
      if (res.error) {
        try { ws.send(JSON.stringify({ type: "error", message: res.error })); } catch (_e) { void _e; }
        return;
      }
      state.game = res.state;
      await this.ctx.storage.put("state", state);
      await this.broadcastBluffState();
      return;
    }

    if (msg.type === "bluffReset") {
      const state = await this.ctx.storage.get("state");
      if (!state || state.gameType !== "bluff") return;
      const lobby = state.lobby || [];
      await this.ctx.storage.put("state", { gameType: "bluff", lobby, game: null });
      await this.broadcastBluffState();
      return;
    }
  }

  async webSocketClose() {
    const count = this.ctx.getWebSockets().length;
    this.broadcast({ type: "presence", count });
  }

  async webSocketError() {
    const count = this.ctx.getWebSockets().length;
    this.broadcast({ type: "presence", count });
  }

  // Poker (server-authoritative) ───────────────────────────────────────
  //
  // Room state shape (storage key "state"):
  //   { gameType: "poker", v: 2, phase: "lobby"|"playing"|"results",
  //     config: { ratio: {chips, money}, sb, bb, currency },
  //     lobby: [{ id, name, memberId }],
  //     table: <engine table> | null,
  //     splitwise: { connected, via, userName, groupId, groupName, members } }
  // The Splitwise OAuth token lives in a SEPARATE storage key ("swToken")
  // so it can never leak through a state broadcast.

  async ensurePokerState() {
    let state = await this.ctx.storage.get("state");
    if (!state || state.gameType !== "poker" || state.v !== 2) {
      state = {
        gameType: "poker",
        v: 2,
        phase: "lobby",
        config: { ratio: { chips: 5000, money: 250 }, sb: 25, bb: 50, currency: "INR" },
        lobby: [],
        table: null,
        splitwise: { connected: false },
      };
    }
    // Legacy fallback: a house token + group configured as Worker secrets
    // keeps old-style rooms working with zero re-auth.
    if (!state.splitwise?.connected && this.env.SPLITWISE_TOKEN && this.env.SPLITWISE_GROUP_ID) {
      state.splitwise = {
        connected: true,
        via: "env",
        userName: "house account",
        groupId: Number(this.env.SPLITWISE_GROUP_ID),
        groupName: null,
        members: null,
      };
    }
    await this.ctx.storage.put("state", state);
    return state;
  }

  async pokerToken() {
    return (await this.ctx.storage.get("swToken")) || this.env.SPLITWISE_TOKEN || null;
  }

  async handlePokerJoin(msg) {
    const state = await this.ensurePokerState();
    if (msg.name && msg.clientId) {
      const player = { id: msg.clientId, name: String(msg.name).slice(0, 32), memberId: msg.memberId ?? null };
      if (state.phase === "lobby") {
        const existing = state.lobby.find((p) => p.id === player.id);
        if (existing) {
          existing.name = player.name;
          if (msg.memberId !== undefined) existing.memberId = player.memberId;
        } else {
          state.lobby.push(player);
        }
      } else if (state.phase === "playing" && state.table) {
        // Late joiner buys in for one standard stack; dealt in next hand.
        const seated = state.table.seats.some((s) => s.id === player.id) ||
          state.table.cashedOut.some((s) => s.id === player.id);
        if (!seated) {
          const res = seatPlayer(state.table, player, state.config.ratio.chips);
          if (!res.error) state.table = res.table;
        }
      }
    }
    await this.ctx.storage.put("state", state);
    await this.broadcastPokerState();
  }

  async handlePokerMessage(ws, msg) {
    const fail = (message) => {
      try { ws.send(JSON.stringify({ type: "error", message })); } catch (_e) { void _e; }
    };
    let att = null;
    try { att = ws.deserializeAttachment(); } catch { /* none */ }
    const me = att?.clientId;
    if (!me) return fail("Join the room first");

    const state = await this.ctx.storage.get("state");
    if (!state || state.gameType !== "poker" || state.v !== 2) return;

    // A player may act for an ABSENT player (no live socket) — fold/check/sit-out
    // only — so one vanished phone can't freeze the table.
    const resolveActor = (forId) => {
      if (!forId || forId === me) return me;
      const connected = this.ctx.getWebSockets().some((sock) => {
        try { return sock.deserializeAttachment()?.clientId === forId; } catch { return false; }
      });
      return connected ? null : forId;
    };

    switch (msg.type) {
      case "pokerConfig": {
        if (state.phase !== "lobby") return fail("Game already started");
        const c = state.config;
        const ratio = msg.ratio || {};
        const chips = Math.max(1, Math.floor(Number(ratio.chips ?? c.ratio.chips) || 0));
        const money = Math.max(0, Number(ratio.money ?? c.ratio.money) || 0);
        const sb = Math.max(1, Math.floor(Number(msg.sb ?? c.sb) || 0));
        const bb = Math.max(sb, Math.floor(Number(msg.bb ?? c.bb) || 0));
        state.config = { ...c, ratio: { chips, money }, sb, bb };
        break;
      }
      case "pokerStart": {
        if (state.phase !== "lobby") return fail("Game already started");
        if ((state.lobby || []).length < 2) return fail("Need at least 2 players");
        try {
          state.table = createTable(state.lobby, {
            sb: state.config.sb,
            bb: state.config.bb,
            startingStack: state.config.ratio.chips,
          });
        } catch (e) {
          return fail(e.message);
        }
        const res = startHand(state.table);
        if (res.error) return fail(res.error);
        state.table = res.table;
        state.phase = "playing";
        break;
      }
      case "pokerAction": {
        if (state.phase !== "playing" || !state.table) return fail("No game in progress");
        const actor = resolveActor(msg.forId);
        if (!actor) return fail("That player is still connected");
        if (msg.forId && msg.forId !== me && msg.move !== "fold" && msg.move !== "check") {
          return fail("You can only fold or check for an absent player");
        }
        const res = applyAction(state.table, actor, { move: msg.move, amount: msg.amount });
        if (res.error) return fail(res.error);
        state.table = res.table;
        break;
      }
      case "pokerNextHand": {
        if (state.phase !== "playing" || !state.table) return fail("No game in progress");
        if (!canStartHand(state.table)) return fail("Can't deal yet");
        const res = startHand(state.table);
        if (res.error) return fail(res.error);
        state.table = res.table;
        break;
      }
      case "pokerRebuy": {
        if (state.phase !== "playing" || !state.table) return fail("No game in progress");
        const res = addChips(state.table, me, msg.chips);
        if (res.error) return fail(res.error);
        state.table = res.table;
        break;
      }
      case "pokerSitOut": {
        if (state.phase !== "playing" || !state.table) return fail("No game in progress");
        const actor = resolveActor(msg.forId);
        if (!actor) return fail("That player is still connected");
        const res = setSittingOut(state.table, actor, !!msg.out);
        if (res.error) return fail(res.error);
        state.table = res.table;
        break;
      }
      case "pokerCashOut": {
        if (state.phase !== "playing" || !state.table) return fail("No game in progress");
        const res = cashOutPlayer(state.table, me);
        if (res.error) return fail(res.error);
        state.table = res.table;
        break;
      }
      case "pokerLeave": {
        if (state.phase === "lobby") {
          state.lobby = (state.lobby || []).filter((p) => p.id !== me);
        }
        break;
      }
      case "pokerEndSession": {
        if (state.phase !== "playing" || !state.table) return fail("No game in progress");
        if (state.table.hand && !state.table.hand.results) return fail("Finish the current hand first");
        state.phase = "results";
        break;
      }
      case "pokerResume": {
        if (state.phase !== "results") return fail("Nothing to resume");
        state.phase = "playing";
        break;
      }
      case "pokerReset": {
        // Back to the lobby with the same crowd (seats + cashed-out, deduped).
        const seen = new Set();
        const lobby = [];
        for (const s of [...(state.table?.seats || []), ...(state.table?.cashedOut || []), ...(state.lobby || [])]) {
          if (seen.has(s.id)) continue;
          seen.add(s.id);
          lobby.push({ id: s.id, name: s.name, memberId: s.memberId ?? null });
        }
        state.phase = "lobby";
        state.lobby = lobby;
        state.table = null;
        break;
      }
      default:
        return fail("Unknown action");
    }

    await this.ctx.storage.put("state", state);
    await this.broadcastPokerState();
  }

  async broadcastPokerState() {
    const state = await this.ctx.storage.get("state");
    if (!state || state.gameType !== "poker" || state.v !== 2) return;
    for (const ws of this.ctx.getWebSockets()) {
      let viewerId = null;
      try { viewerId = ws.deserializeAttachment()?.clientId || null; } catch { /* none */ }
      const payload = buildPokerSnapshot(state, viewerId);
      try { ws.send(JSON.stringify({ type: "state", data: payload })); } catch (_e) { void _e; }
    }
  }

  // Room-scoped Splitwise endpoints. The lobby creator's OAuth token is
  // stored per-room (storage "swToken"); falls back to the legacy
  // SPLITWISE_TOKEN/SPLITWISE_GROUP_ID Worker secrets when present.
  async handleSplitwise(action, request) {
    const sub = action.split("/")[1] || "status";

    // Internal hand-off from the Worker's OAuth callback.
    if (sub === "connect" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      if (!body?.token) return json({ error: "token required" }, 400);
      const state = await this.ensurePokerState();
      await this.ctx.storage.put("swToken", body.token);
      state.splitwise = {
        connected: true,
        via: "oauth",
        userName: body.userName || null,
        groupId: null,
        groupName: null,
        members: null,
      };
      await this.ctx.storage.put("state", state);
      await this.broadcastPokerState();
      return json({ ok: true });
    }

    if (sub === "disconnect" && request.method === "POST") {
      const state = await this.ensurePokerState();
      await this.ctx.storage.delete("swToken");
      state.splitwise = { connected: false };
      await this.ctx.storage.put("state", state);
      // ensurePokerState may immediately re-apply the env fallback; that's fine.
      await this.broadcastPokerState();
      return json({ ok: true });
    }

    // Status is read-only — must never convert a room that's hosting
    // another game (crawlers / stray fetches included).
    if (sub === "status" && request.method === "GET") {
      const raw = await this.ctx.storage.get("state");
      if (raw?.gameType === "poker" && raw.v === 2) return json(raw.splitwise || { connected: false });
      if (this.env.SPLITWISE_TOKEN && this.env.SPLITWISE_GROUP_ID) {
        return json({ connected: true, via: "env", groupId: Number(this.env.SPLITWISE_GROUP_ID) });
      }
      return json({ connected: false });
    }

    const state = await this.ensurePokerState();
    const token = await this.pokerToken();

    if (!token) return json({ error: "Splitwise not connected. The lobby creator should hit Connect Splitwise." }, 503);

    if (sub === "groups" && request.method === "GET") {
      try {
        const groups = await getGroups(token);
        return json(groups.map((g) => ({ id: g.id, name: g.name, memberCount: g.members.length })));
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    if (sub === "group" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      const groupId = Number(body?.groupId);
      if (!groupId) return json({ error: "groupId required" }, 400);
      try {
        const groups = await getGroups(token);
        const group = groups.find((g) => g.id === groupId);
        const members = group?.members ?? (await getGroupMembers(token, groupId));
        state.splitwise = {
          ...state.splitwise,
          groupId,
          groupName: group?.name ?? null,
          members,
        };
        await this.ctx.storage.put("state", state);
        await this.broadcastPokerState();
        return json({ ok: true, members });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    if (sub === "members" && request.method === "GET") {
      const groupId = state.splitwise?.groupId;
      if (!groupId) return json({ error: "No group selected" }, 400);
      if (state.splitwise.members) return json(state.splitwise.members);
      try {
        const members = await getGroupMembers(token, groupId);
        state.splitwise.members = members;
        await this.ctx.storage.put("state", state);
        await this.broadcastPokerState();
        return json(members);
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    if (sub === "settle" && request.method === "POST") {
      const groupId = state.splitwise?.groupId;
      if (!groupId) return json({ error: "No Splitwise group selected" }, 400);
      let body;
      try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      const result = await createSettlementExpense(token, groupId, {
        description: body?.description,
        currency: body?.currency || state.config?.currency || "INR",
        date: body?.date,
        participants: Array.isArray(body?.participants) ? body.participants : [],
      });
      return json(result, result.ok ? 200 : 502);
    }

    return json({ error: "Not found" }, 404);
  }

  // Helpers ─────────────────────────────────────────────────────────────

  async ensureLitState() {
    let state = await this.ctx.storage.get("state");
    if (!state || state.gameType !== "lit") {
      state = { gameType: "lit", lobby: [], game: null };
      await this.ctx.storage.put("state", state);
    }
    return state;
  }

  // ── Secret Hitler helpers ─────────────────────────────────────────────

  async ensureHitlerState() {
    let state = await this.ctx.storage.get("state");
    if (!state || state.gameType !== "hitler") {
      state = { gameType: "hitler", lobby: [], game: null };
      await this.ctx.storage.put("state", state);
    }
    return state;
  }

  async broadcastHitlerState() {
    const state = await this.ctx.storage.get("state");
    if (!state || state.gameType !== "hitler") return;
    for (const ws of this.ctx.getWebSockets()) {
      let viewerId = null;
      try { viewerId = ws.deserializeAttachment()?.clientId || null; } catch { /* none */ }
      const payload = buildHitlerSnapshot(state, viewerId);
      try { ws.send(JSON.stringify({ type: "state", data: payload })); } catch (_e) { void _e; }
    }
  }

  // Dispatch a "hitler:*" game action. All mutations go through the pure engine
  // and rebroadcast per-viewer redacted snapshots.
  async handleHitlerAction(ws, msg) {
    const state = await this.ctx.storage.get("state");
    if (!state || state.gameType !== "hitler") return;
    const att = (() => { try { return ws.deserializeAttachment(); } catch { return null; } })();
    const me = att?.clientId || null;
    const sendErr = (message) => {
      try { ws.send(JSON.stringify({ type: "error", message })); } catch (_e) { void _e; }
    };

    const E = Hitler;
    const type = msg.type.slice("hitler:".length);

    // Lobby-level actions.
    if (type === "start") {
      if (state.game) return;
      const lobby = state.lobby || [];
      if (lobby.length < 5 || lobby.length > 10) {
        return sendErr("Secret Hitler needs 5–10 players");
      }
      try {
        state.game = E.startGame(lobby);
      } catch (e) {
        return sendErr(e.message);
      }
      await this.ctx.storage.put("state", state);
      await this.broadcastHitlerState();
      return;
    }
    if (type === "reset") {
      const lobby = state.lobby || [];
      await this.ctx.storage.put("state", { gameType: "hitler", lobby, game: null });
      await this.broadcastHitlerState();
      return;
    }

    // In-game actions require an active game and an identified seat.
    if (!state.game) return;
    if (!me) return sendErr("You're not seated in this game");

    let res;
    switch (type) {
      case "nominate":   res = E.nominateChancellor(state.game, me, msg.targetId); break;
      case "vote":       res = E.castVote(state.game, me, msg.vote); break;
      case "discard":    res = E.presidentDiscard(state.game, me, msg.index); break;
      case "enact":      res = E.chancellorEnact(state.game, me, msg.index); break;
      case "proposeVeto": res = E.proposeVeto(state.game, me); break;
      case "respondVeto": res = E.respondVeto(state.game, me, !!msg.consent); break;
      case "investigate": res = E.investigatePlayer(state.game, me, msg.targetId); break;
      case "specialElection": res = E.specialElection(state.game, me, msg.targetId); break;
      case "peekAck":    res = E.peekAck(state.game, me); break;
      case "execute":    res = E.executePlayer(state.game, me, msg.targetId); break;
      default: return;
    }
    if (res.error) return sendErr(res.error);
    state.game = res.state;
    await this.ctx.storage.put("state", state);
    await this.broadcastHitlerState();
  }

  async broadcastLitState() {
    const state = await this.ctx.storage.get("state");
    if (!state || state.gameType !== "lit") return;
    for (const ws of this.ctx.getWebSockets()) {
      let viewerId = null;
      try { viewerId = ws.deserializeAttachment()?.clientId || null; } catch { /* none */ }
      const payload = buildLitSnapshot(state, viewerId);
      try { ws.send(JSON.stringify({ type: "state", data: payload })); } catch (_e) { void _e; }
    }
  }

  async ensureBluffState() {
    let state = await this.ctx.storage.get("state");
    if (!state || state.gameType !== "bluff") {
      state = { gameType: "bluff", lobby: [], game: null };
      await this.ctx.storage.put("state", state);
    }
    return state;
  }

  async broadcastBluffState() {
    const state = await this.ctx.storage.get("state");
    if (!state || state.gameType !== "bluff") return;
    for (const ws of this.ctx.getWebSockets()) {
      let viewerId = null;
      try { viewerId = ws.deserializeAttachment()?.clientId || null; } catch { /* none */ }
      const payload = buildBluffSnapshot(state, viewerId);
      try { ws.send(JSON.stringify({ type: "state", data: payload })); } catch (_e) { void _e; }
    }
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(data); } catch (_e) { void _e; }
    }
  }

  broadcastExcept(except, msg) {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try { ws.send(data); } catch (_e) { void _e; }
    }
  }
}

// Build the snapshot we send to a poker client: public room info + the
// per-viewer redacted table (own hole cards only). The Splitwise token is
// stored outside `state` and can never appear here.
function buildPokerSnapshot(state, viewerId) {
  return {
    gameType: "poker",
    phase: state.phase,
    config: state.config,
    lobby: state.lobby || [],
    splitwise: state.splitwise || { connected: false },
    table: state.table ? redactPoker(state.table, viewerId) : null,
  };
}

// Build the snapshot we send to a Lit client. Same shape pre- and post-start
// so the client can rely on `players` being the authoritative seat list.
function buildLitSnapshot(state, viewerId) {
  const lobby = state?.lobby || [];
  const mode = state?.mode === "team" ? "team" : "solo";
  if (!state?.game) {
    return {
      phase: "lobby",
      mode,
      players: lobby,
      teams: mode === "team" ? state?.teams || null : null,
      opponents: lobby.filter((p) => p.id !== viewerId),
    };
  }
  const view = redactFor(state.game, viewerId);
  return { ...view, phase: "playing", players: view.players };
}

// Build the snapshot sent to a Bluff client. Same shape pre/post-start so the
// client can rely on `players` being the authoritative seat list.
function buildBluffSnapshot(state, viewerId) {
  const lobby = state?.lobby || [];
  if (!state?.game) {
    return {
      phase: "lobby",
      gameType: "bluff",
      players: lobby,
    };
  }
  const view = redactBluff(state.game, viewerId);
  return { ...view, phase: "playing" };
}

// Build the snapshot we send to a Secret Hitler client. Pre-start it's the
// lobby seat list; post-start it's a per-viewer redacted game view.
function buildHitlerSnapshot(state, viewerId) {
  const lobby = state?.lobby || [];
  if (!state?.game) {
    return {
      phase: "lobby",
      players: lobby,
    };
  }
  const view = Hitler.redactFor(state.game, viewerId);
  return { ...view, started: true };
}

function cors(response) {
  const r = new Response(response.body, response);
  r.headers.set("Access-Control-Allow-Origin", "*");
  r.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  r.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return r;
}

function json(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { "Content-Type": "application/json" },
  });
}
