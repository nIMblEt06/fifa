// Cloudflare Worker entry. Routes /api/room/:code/* to a Durable Object instance
// keyed by the room code. Everything else falls through to the static asset binding
// (Vite-built React app + /teams.json + /favicon.svg).

export { RoomDO } from "./RoomDO.js";

const ROUTE = /^\/api\/room\/([A-Z0-9]{2,8})\/.+$/i;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(ROUTE);
    if (m) {
      const code = m[1].toUpperCase();
      const id = env.ROOMS.idFromName(code);
      const stub = env.ROOMS.get(id);
      return stub.fetch(request);
    }
    // Static assets (with SPA fallback configured in wrangler.toml)
    return env.ASSETS.fetch(request);
  },
};
