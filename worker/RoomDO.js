import { DurableObject } from "cloudflare:workers";
import { startGame, applyAsk, applyDeclare, redactFor, healState, defaultTeams } from "../src/games/lit/engine.js";
import {
  startGame as ucStartGame,
  applyClue as ucApplyClue,
  applyVote as ucApplyVote,
  applyMrWhiteGuess as ucApplyMrWhiteGuess,
  redactFor as ucRedactFor,
  defaultRoleCounts as ucDefaultRoleCounts,
  validateRoleCounts as ucValidateRoleCounts,
} from "../src/games/undercover/engine.js";
import { WORD_PAIRS as UC_WORD_PAIRS } from "../src/games/undercover/wordpairs.js";

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
      } else if (gameType === "undercover") {
        const payload = buildUndercoverSnapshot(state, /* viewerId */ null);
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
      if (game === "undercover") {
        await this.ensureUndercoverState();
        const state = await this.ctx.storage.get("state");
        // Seat the player if not yet started; require a name to claim a seat.
        if (!state.game && msg.name) {
          state.lobby = state.lobby || [];
          const existing = state.lobby.find((p) => p.id === msg.clientId);
          if (existing) existing.name = msg.name;
          else if (state.lobby.length < 12) state.lobby.push({ id: msg.clientId, name: msg.name });
          await this.ctx.storage.put("state", state);
        }
        await this.broadcastUndercoverState();
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
      }
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

    // ── UNDERCOVER message handlers ──────────────────────────────────────
    if (msg.type === "uc_setRoles") {
      // Host tweaks role counts in the lobby. { undercover, mrWhite }
      const state = await this.ctx.storage.get("state");
      if (!state || state.gameType !== "undercover" || state.game) return;
      const n = (state.lobby || []).length;
      const uc = Number(msg.undercover);
      const mw = Number(msg.mrWhite);
      const err = ucValidateRoleCounts(n, uc, mw);
      if (err) {
        try { ws.send(JSON.stringify({ type: "error", message: err })); } catch (_e) { void _e; }
        return;
      }
      state.roles = { undercover: uc, mrWhite: mw };
      await this.ctx.storage.put("state", state);
      await this.broadcastUndercoverState();
      return;
    }

    if (msg.type === "uc_start") {
      const state = await this.ctx.storage.get("state");
      if (!state || state.gameType !== "undercover" || state.game) return;
      const lobby = state.lobby || [];
      if (lobby.length < 4) {
        try { ws.send(JSON.stringify({ type: "error", message: "Need at least 4 players" })); } catch (_e) { void _e; }
        return;
      }
      // Pick a random unused pair; reset the used set if exhausted.
      let used = Array.isArray(state.usedPairs) ? state.usedPairs : [];
      if (used.length >= UC_WORD_PAIRS.length) used = [];
      const usedSet = new Set(used);
      const available = [];
      for (let i = 0; i < UC_WORD_PAIRS.length; i++) if (!usedSet.has(i)) available.push(i);
      const pairIndex = available[Math.floor(Math.random() * available.length)];
      const pair = UC_WORD_PAIRS[pairIndex];
      const roles = state.roles || ucDefaultRoleCounts(lobby.length);
      try {
        state.game = ucStartGame(lobby, {
          pair,
          pairIndex,
          undercover: roles.undercover,
          mrWhite: roles.mrWhite,
        });
      } catch (e) {
        try { ws.send(JSON.stringify({ type: "error", message: e.message })); } catch (_e) { void _e; }
        return;
      }
      state.usedPairs = [...used, pairIndex];
      await this.ctx.storage.put("state", state);
      await this.broadcastUndercoverState();
      return;
    }

    if (msg.type === "uc_clue") {
      const state = await this.ctx.storage.get("state");
      if (!state?.game || state.gameType !== "undercover") return;
      const att = ws.deserializeAttachment();
      if (!att?.clientId) return;
      const res = ucApplyClue(state.game, att.clientId, msg.clue);
      if (res.error) {
        try { ws.send(JSON.stringify({ type: "error", message: res.error })); } catch (_e) { void _e; }
        return;
      }
      state.game = res.state;
      await this.ctx.storage.put("state", state);
      await this.broadcastUndercoverState();
      return;
    }

    if (msg.type === "uc_vote") {
      const state = await this.ctx.storage.get("state");
      if (!state?.game || state.gameType !== "undercover") return;
      const att = ws.deserializeAttachment();
      if (!att?.clientId) return;
      const res = ucApplyVote(state.game, att.clientId, msg.targetId);
      if (res.error) {
        try { ws.send(JSON.stringify({ type: "error", message: res.error })); } catch (_e) { void _e; }
        return;
      }
      state.game = res.state;
      await this.ctx.storage.put("state", state);
      await this.broadcastUndercoverState();
      return;
    }

    if (msg.type === "uc_guess") {
      const state = await this.ctx.storage.get("state");
      if (!state?.game || state.gameType !== "undercover") return;
      const att = ws.deserializeAttachment();
      if (!att?.clientId) return;
      const res = ucApplyMrWhiteGuess(state.game, att.clientId, msg.guess);
      if (res.error) {
        try { ws.send(JSON.stringify({ type: "error", message: res.error })); } catch (_e) { void _e; }
        return;
      }
      state.game = res.state;
      await this.ctx.storage.put("state", state);
      await this.broadcastUndercoverState();
      return;
    }

    if (msg.type === "uc_reset") {
      // Keep lobby, role tweaks, and used-pair history so re-plays don't repeat words.
      const state = await this.ctx.storage.get("state");
      if (!state || state.gameType !== "undercover") return;
      const lobby = state.lobby || [];
      const roles = state.roles || null;
      const usedPairs = Array.isArray(state.usedPairs) ? state.usedPairs : [];
      await this.ctx.storage.put("state", {
        gameType: "undercover",
        lobby,
        roles,
        usedPairs,
        game: null,
      });
      await this.broadcastUndercoverState();
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

  // ── UNDERCOVER helpers ────────────────────────────────────────────────
  async ensureUndercoverState() {
    let state = await this.ctx.storage.get("state");
    if (!state || state.gameType !== "undercover") {
      state = { gameType: "undercover", lobby: [], roles: null, usedPairs: [], game: null };
      await this.ctx.storage.put("state", state);
    }
    return state;
  }

  async broadcastUndercoverState() {
    const state = await this.ctx.storage.get("state");
    if (!state || state.gameType !== "undercover") return;
    for (const ws of this.ctx.getWebSockets()) {
      let viewerId = null;
      try { viewerId = ws.deserializeAttachment()?.clientId || null; } catch { /* none */ }
      const payload = buildUndercoverSnapshot(state, viewerId);
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

// Build the snapshot we send to an Undercover client. Same flat shape pre- and
// post-start: a "lobby" stage exposes the seat list + role-count config; once
// the game starts we relay the engine's per-viewer redacted view (whose own
// `phase` field — describe/vote/mrwhite_guess/over — drives the in-game UI).
function buildUndercoverSnapshot(state, viewerId) {
  const lobby = state?.lobby || [];
  const n = lobby.length;
  const roles = state?.roles || (n >= 4 ? ucDefaultRoleCounts(n) : { undercover: 1, mrWhite: 0 });
  if (!state?.game) {
    return {
      stage: "lobby",
      players: lobby,
      roles,
      defaultRoles: n >= 4 ? ucDefaultRoleCounts(n) : null,
      playerCount: n,
    };
  }
  const view = ucRedactFor(state.game, viewerId);
  return { ...view, stage: "playing" };
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
