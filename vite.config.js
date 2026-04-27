import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [
    react(),
    tournamentRoomsPlugin(),
  ],
})

function tournamentRoomsPlugin() {
  // In-memory store keyed by room code: { state, subscribers, presence }
  const rooms = new Map();
  const PRESENCE_TTL = 8000;

  function getRoom(code) {
    if (!rooms.has(code)) {
      rooms.set(code, { state: null, subscribers: new Set(), presence: new Map() });
    }
    return rooms.get(code);
  }

  function broadcast(code, event, data) {
    const room = rooms.get(code);
    if (!room) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of room.subscribers) {
      try { res.write(payload); } catch (_e) { void _e; /* client gone */ }
    }
  }

  function presenceCount(code) {
    const room = rooms.get(code);
    if (!room) return 0;
    const now = Date.now();
    for (const [id, ts] of room.presence) {
      if (now - ts > PRESENCE_TTL) room.presence.delete(id);
    }
    return room.presence.size;
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        try { resolve(body ? JSON.parse(body) : {}); }
        catch (e) { reject(e); }
      });
      req.on('error', reject);
    });
  }

  function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }

  return {
    name: 'tournament-rooms',
    configureServer(server) {
      server.middlewares.use('/api', async (req, res, next) => {
        const match = req.url.match(/^\/room\/([A-Z0-9]{2,8})\/(state|reaction|presence|stream)\/?(\?.*)?$/i);
        if (!match) return next();

        const code = match[1].toUpperCase();
        const action = match[2];

        setCors(res);
        if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

        try {
          if (action === 'state') {
            const room = getRoom(code);
            if (req.method === 'GET') {
              res.setHeader('Content-Type', 'application/json');
              return res.end(JSON.stringify({ state: room.state, presence: presenceCount(code) }));
            }
            if (req.method === 'POST') {
              const body = await readJson(req);
              room.state = body;
              broadcast(code, 'state', body);
              res.setHeader('Content-Type', 'application/json');
              return res.end(JSON.stringify({ ok: true }));
            }
          }

          if (action === 'reaction' && req.method === 'POST') {
            const body = await readJson(req);
            broadcast(code, 'reaction', { emoji: body.emoji, by: body.by, t: Date.now() });
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ ok: true }));
          }

          if (action === 'presence' && req.method === 'POST') {
            const body = await readJson(req);
            const room = getRoom(code);
            room.presence.set(body.id, Date.now());
            const count = presenceCount(code);
            broadcast(code, 'presence', { count });
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ count }));
          }

          if (action === 'stream' && req.method === 'GET') {
            const room = getRoom(code);
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache, no-transform',
              'Connection': 'keep-alive',
              'X-Accel-Buffering': 'no',
            });
            res.write(`retry: 2000\n\n`);
            res.write(`event: hello\ndata: ${JSON.stringify({ code, presence: presenceCount(code) })}\n\n`);
            if (room.state) res.write(`event: state\ndata: ${JSON.stringify(room.state)}\n\n`);
            room.subscribers.add(res);

            const ka = setInterval(() => {
              try { res.write(`: keepalive\n\n`); } catch (_e) { void _e; }
            }, 15000);

            req.on('close', () => {
              clearInterval(ka);
              room.subscribers.delete(res);
            });
            return;
          }

          res.statusCode = 405;
          res.end('Method Not Allowed');
        } catch (err) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: String(err && err.message || err) }));
        }
      });
    },
  };
}
