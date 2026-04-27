import { DurableObject } from "cloudflare:workers";

// One Durable Object instance per room code. Owns:
//   • persistent room state (storage)
//   • the set of currently-connected WebSockets (presence)
//   • broadcasting state changes + reactions to all connections
//
// Uses the hibernation API (acceptWebSocket / webSocketMessage / webSocketClose),
// so a sleeping room costs nothing.
export class RoomDO extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/api\/room\/[A-Z0-9]{2,8}\/(state|reaction|presence|ws)\/?$/i);
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
      // Heartbeat is no longer required (presence comes from WS connections),
      // but kept to avoid 404s from older client builds.
      return cors(json({ count: this.ctx.getWebSockets().length }));
    }

    if (action === "ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return cors(new Response("Expected websocket", { status: 426 }));
      }
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      // Hand the server-end to the runtime so it survives DO hibernation.
      this.ctx.acceptWebSocket(server);

      // Send hello + current state to the new connection.
      const presence = this.ctx.getWebSockets().length;
      try { server.send(JSON.stringify({ type: "hello", presence })); } catch (_e) { void _e; }
      const state = await this.ctx.storage.get("state");
      if (state) {
        try { server.send(JSON.stringify({ type: "state", data: state })); } catch (_e) { void _e; }
      }
      // Notify everyone else of the new presence count.
      this.broadcastExcept(server, { type: "presence", count: presence });

      return new Response(null, { status: 101, webSocket: client });
    }

    return cors(new Response("Not Found", { status: 404 }));
  }

  // Hibernation handlers ────────────────────────────────────────────────

  async webSocketMessage() {
    // We don't accept any client messages today — POSTs handle writes.
    // Keeping the method defined satisfies the hibernation contract.
  }

  async webSocketClose() {
    // The closed socket is removed from getWebSockets() before this fires.
    const count = this.ctx.getWebSockets().length;
    this.broadcast({ type: "presence", count });
  }

  async webSocketError() {
    const count = this.ctx.getWebSockets().length;
    this.broadcast({ type: "presence", count });
  }

  // Helpers ─────────────────────────────────────────────────────────────

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
