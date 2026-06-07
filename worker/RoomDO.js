import { DurableObject } from "cloudflare:workers";
import { startGame, applyAsk, applyDeclare, redactFor, healState, defaultTeams } from "../src/games/lit/engine.js";
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
    const m = url.pathname.match(/^\/api\/room\/[A-Za-z0-9-]{2,32}\/(state|reaction|presence|ws)\/?$/);
    const action = m ? m[1].toLowerCase() : null;

    if (request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
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
      // { type: "join", game: "lit", clientId, name }
      const game = msg.game || "lit";
      ws.serializeAttachment({ clientId: msg.clientId, name: msg.name, game });
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
  }

  async webSocketClose() {
    const count = this.ctx.getWebSockets().length;
    this.broadcast({ type: "presence", count });
  }

  async webSocketError() {
    const count = this.ctx.getWebSockets().length;
    this.broadcast({ type: "presence", count });
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
