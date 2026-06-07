// Cloudflare Worker entry. Routes /api/room/:code/* to a Durable Object instance
// keyed by the room code. Everything else falls through to the static asset binding
// (Vite-built React app + /teams.json + /favicon.svg).

export { RoomDO } from "./RoomDO.js";
import {
  authorizeUrl, exchangeCode, getCurrentUser, getGroupMembers,
  createSettlementExpense, signState, verifyState,
} from "./splitwise.js";

const ROUTE = /^\/api\/room\/([A-Za-z0-9-]{2,32})\/.+$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── Splitwise OAuth (per-room: lobby creator connects their account) ──
    if (url.pathname === "/api/splitwise/auth/start" && request.method === "GET") {
      return splitwiseAuthStart(url, env);
    }
    if (url.pathname === "/api/splitwise/callback" && request.method === "GET") {
      return splitwiseCallback(url, env);
    }

    // ── Legacy Splitwise proxy (house token via Worker secrets) ──────────
    if (url.pathname === "/api/splitwise/group" && request.method === "GET") {
      return cors(await splitwiseGroup(env));
    }
    if (url.pathname === "/api/splitwise/settle" && request.method === "POST") {
      return cors(await splitwiseSettle(request, env));
    }
    if (url.pathname.startsWith("/api/splitwise/") && request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }

    // ── Hall-of-Fame: roster + tournament history (D1) ──────────
    if (url.pathname === "/api/roster" && request.method === "GET") {
      return cors(await rosterList(env));
    }
    if (url.pathname === "/api/roster" && request.method === "POST") {
      return cors(await rosterCreate(request, env));
    }
    if (url.pathname === "/api/tournaments" && request.method === "POST") {
      return cors(await tournamentSave(request, env));
    }
    if (url.pathname === "/api/tournaments" && request.method === "GET") {
      return cors(await tournamentsList(url, env));
    }
    if (url.pathname === "/api/stats/leaderboards" && request.method === "GET") {
      return cors(await statsLeaderboards(env));
    }
    if (url.pathname === "/api/stats/h2h" && request.method === "GET") {
      return cors(await statsH2H(url, env));
    }
    const playerStatsM = url.pathname.match(/^\/api\/stats\/player\/(\d+)$/);
    if (playerStatsM && request.method === "GET") {
      return cors(await statsPlayer(Number(playerStatsM[1]), env));
    }
    if (url.pathname.startsWith("/api/") && request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }

    const m = url.pathname.match(ROUTE);
    if (m) {
      const code = m[1].toLowerCase();
      const id = env.ROOMS.idFromName(code);
      const stub = env.ROOMS.get(id);
      return stub.fetch(request);
    }
    // Static assets (with SPA fallback configured in wrangler.toml)
    return env.ASSETS.fetch(request);
  },
};

// ── Splitwise OAuth flow ───────────────────────────────────
// 1. /api/splitwise/auth/start?room=CODE → 302 to Splitwise's consent page
//    with an HMAC-signed `state` carrying the room code (CSRF-safe, stateless).
// 2. /api/splitwise/callback?code&state → exchange the code for a token
//    (Splitwise tokens never expire), hand it to the room's DO, bounce the
//    browser back into the room.

async function splitwiseAuthStart(url, env) {
  if (!env.SPLITWISE_CLIENT_ID || !env.SPLITWISE_CLIENT_SECRET) {
    return json({ error: "Splitwise OAuth not configured. Set SPLITWISE_CLIENT_ID and SPLITWISE_CLIENT_SECRET Worker secrets." }, 503);
  }
  const room = (url.searchParams.get("room") || "").toLowerCase();
  if (!/^[a-z0-9-]{2,32}$/.test(room)) return json({ error: "Invalid room code" }, 400);
  const redirectUri = `${url.origin}/api/splitwise/callback`;
  const state = await signState(env.SPLITWISE_CLIENT_SECRET, {
    room,
    n: crypto.randomUUID(),
    ts: Date.now(),
  });
  return Response.redirect(authorizeUrl(env.SPLITWISE_CLIENT_ID, redirectUri, state), 302);
}

async function splitwiseCallback(url, env) {
  if (!env.SPLITWISE_CLIENT_ID || !env.SPLITWISE_CLIENT_SECRET) {
    return json({ error: "Splitwise OAuth not configured" }, 503);
  }
  const payload = await verifyState(env.SPLITWISE_CLIENT_SECRET, url.searchParams.get("state"));
  if (!payload?.room || !/^[a-z0-9-]{2,32}$/.test(payload.room)) {
    return json({ error: "Invalid or tampered state" }, 400);
  }
  const back = (suffix = "") =>
    Response.redirect(`${url.origin}/#/r/${payload.room}/poker${suffix}`, 302);
  if (Date.now() - (payload.ts || 0) > 15 * 60 * 1000) return back("?sw=expired");

  const code = url.searchParams.get("code");
  if (!code) return back("?sw=denied"); // user clicked "deny" on Splitwise

  try {
    const token = await exchangeCode(env, code, `${url.origin}/api/splitwise/callback`);
    const user = await getCurrentUser(token);
    const id = env.ROOMS.idFromName(payload.room);
    const res = await env.ROOMS.get(id).fetch(`https://do/api/room/${payload.room}/splitwise/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, userName: user.name }),
    });
    if (!res.ok) return back("?sw=error");
    return back("?sw=connected");
  } catch (e) {
    void e;
    return back("?sw=error");
  }
}

// ── Legacy house-token endpoints (kept for old cached clients) ──────────

async function splitwiseGroup(env) {
  if (!env.SPLITWISE_TOKEN || !env.SPLITWISE_GROUP_ID) {
    return json({ error: "Splitwise not configured. Set SPLITWISE_TOKEN and SPLITWISE_GROUP_ID Worker secrets." }, 503);
  }
  try {
    return json(await getGroupMembers(env.SPLITWISE_TOKEN, env.SPLITWISE_GROUP_ID));
  } catch (e) {
    return json({ error: e.message }, 502);
  }
}

async function splitwiseSettle(request, env) {
  if (!env.SPLITWISE_TOKEN || !env.SPLITWISE_GROUP_ID) {
    return json({ error: "Splitwise not configured. Set SPLITWISE_TOKEN and SPLITWISE_GROUP_ID Worker secrets." }, 503);
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const result = await createSettlementExpense(env.SPLITWISE_TOKEN, env.SPLITWISE_GROUP_ID, {
    description: body?.description,
    currency: body?.currency,
    date: body?.date,
    participants: Array.isArray(body?.participants) ? body.participants : [],
  });
  return json(result, result.ok ? 200 : 400);
}

// ── Roster ─────────────────────────────────────────────────
// Normalized name = lowercase + collapsed whitespace; used as the dedup key
// so "  Shwetabh " and "shwetabh" map to the same roster entry.
function normalizeName(name) {
  return String(name || "").trim().replace(/\s+/g, " ").toLowerCase();
}

async function rosterList(env) {
  if (!env.DB) return json({ error: "D1 not configured" }, 503);
  const { results } = await env.DB
    .prepare("SELECT id, name FROM players ORDER BY name COLLATE NOCASE")
    .all();
  return json(results || []);
}

async function rosterCreate(request, env) {
  if (!env.DB) return json({ error: "D1 not configured" }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const raw = String(body?.name || "").trim().replace(/\s+/g, " ");
  if (!raw) return json({ error: "Name required" }, 400);
  if (raw.length > 64) return json({ error: "Name too long" }, 400);
  const normalized = normalizeName(raw);

  // Lookup-or-create — UNIQUE(normalized_name) makes the INSERT … ON CONFLICT path safe.
  const existing = await env.DB
    .prepare("SELECT id, name FROM players WHERE normalized_name = ?")
    .bind(normalized).first();
  if (existing) return json({ id: existing.id, name: existing.name, created: false });

  const now = Date.now();
  const ins = await env.DB
    .prepare("INSERT INTO players (name, normalized_name, created_at) VALUES (?, ?, ?)")
    .bind(raw, normalized, now).run();
  const id = ins?.meta?.last_row_id;
  if (!id) return json({ error: "Failed to create player" }, 500);
  return json({ id, name: raw, created: true });
}

// ── Tournament save ────────────────────────────────────────
// Body shape (see plan §5):
// {
//   roomCode, format, groupRounds, qualifiers, matchesPerPlayer,
//   startedAt, endedAt, championPlayerId, runnerUpPlayerId,
//   participants: [{ playerId, teamName, finalRank, groupId,
//                    wins, draws, losses, goalsFor, goalsAgainst, reachedStage }],
//   matches: [{ stage, groupId, homeId, awayId, homeTeam, awayTeam,
//               homeScore, awayScore, playedAt }]
// }
// Idempotent via UNIQUE(room_code, ended_at): the same submission lands as a no-op.
async function tournamentSave(request, env) {
  if (!env.DB) return json({ error: "D1 not configured" }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  const roomCode = String(body?.roomCode || "").trim();
  const format = String(body?.format || "").trim();
  const endedAt = Number(body?.endedAt);
  const participants = Array.isArray(body?.participants) ? body.participants : [];
  const matches = Array.isArray(body?.matches) ? body.matches : [];

  if (!roomCode || !format || !endedAt || participants.length === 0) {
    return json({ error: "roomCode, format, endedAt and participants are required" }, 400);
  }

  // Dedup: if this (roomCode, endedAt) already exists, return its id.
  const dup = await env.DB
    .prepare("SELECT id FROM tournaments WHERE room_code = ? AND ended_at = ?")
    .bind(roomCode, endedAt).first();
  if (dup) return json({ id: dup.id, deduped: true });

  const id = crypto.randomUUID();
  const startedAt = body?.startedAt ? Number(body.startedAt) : null;
  const numPlayers = participants.length;
  const groupRounds = body?.groupRounds != null ? Number(body.groupRounds) : null;
  const qualifiers = body?.qualifiers != null ? Number(body.qualifiers) : null;
  const matchesPerPlayer = body?.matchesPerPlayer != null ? Number(body.matchesPerPlayer) : null;
  const championId = body?.championPlayerId != null ? Number(body.championPlayerId) : null;
  const runnerUpId = body?.runnerUpPlayerId != null ? Number(body.runnerUpPlayerId) : null;

  const stmts = [];
  stmts.push(env.DB.prepare(
    `INSERT INTO tournaments (id, room_code, format, num_players, group_rounds, qualifiers,
                              matches_per_player, started_at, ended_at, champion_id, runner_up_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, roomCode, format, numPlayers, groupRounds, qualifiers,
         matchesPerPlayer, startedAt, endedAt, championId, runnerUpId));

  for (const p of participants) {
    if (p?.playerId == null) continue;
    stmts.push(env.DB.prepare(
      `INSERT INTO tournament_participants
         (tournament_id, player_id, team_name, final_rank, group_id,
          wins, draws, losses, goals_for, goals_against, reached_stage)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      Number(p.playerId),
      p.teamName ?? null,
      p.finalRank ?? null,
      p.groupId ?? null,
      Number(p.wins) || 0,
      Number(p.draws) || 0,
      Number(p.losses) || 0,
      Number(p.goalsFor) || 0,
      Number(p.goalsAgainst) || 0,
      p.reachedStage ?? null,
    ));
  }

  for (const mch of matches) {
    if (mch?.homeId == null || mch?.awayId == null) continue;
    stmts.push(env.DB.prepare(
      `INSERT INTO matches
         (id, tournament_id, stage, group_id, home_id, away_id,
          home_team, away_team, home_score, away_score, played_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID(),
      id,
      String(mch.stage || "group"),
      mch.groupId ?? null,
      Number(mch.homeId),
      Number(mch.awayId),
      mch.homeTeam ?? null,
      mch.awayTeam ?? null,
      Number(mch.homeScore) || 0,
      Number(mch.awayScore) || 0,
      mch.playedAt ?? null,
    ));
  }

  try {
    await env.DB.batch(stmts);
  } catch (e) {
    return json({ error: `Save failed: ${e.message}` }, 500);
  }
  return json({ id, deduped: false });
}

// ── Read endpoints ─────────────────────────────────────────

async function tournamentsList(url, env) {
  if (!env.DB) return json({ error: "D1 not configured" }, 503);
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 20));
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.room_code, t.format, t.num_players, t.group_rounds, t.qualifiers,
            t.started_at, t.ended_at,
            t.champion_id, cp.name AS champion_name,
            t.runner_up_id, rp.name AS runner_up_name
     FROM tournaments t
     LEFT JOIN players cp ON cp.id = t.champion_id
     LEFT JOIN players rp ON rp.id = t.runner_up_id
     ORDER BY t.ended_at DESC
     LIMIT ?`
  ).bind(limit).all();
  return json(results || []);
}

// One JSON blob with the five canonical leaderboards.
async function statsLeaderboards(env) {
  if (!env.DB) return json({ error: "D1 not configured" }, 503);
  const top = 10;

  const championships = (await env.DB.prepare(
    `SELECT p.id, p.name, COUNT(*) AS value
     FROM tournaments t JOIN players p ON p.id = t.champion_id
     GROUP BY p.id
     ORDER BY value DESC, p.name COLLATE NOCASE
     LIMIT ?`
  ).bind(top).all()).results || [];

  const goalsFor = (await env.DB.prepare(
    `SELECT p.id, p.name, SUM(tp.goals_for) AS value
     FROM tournament_participants tp JOIN players p ON p.id = tp.player_id
     GROUP BY p.id
     ORDER BY value DESC, p.name COLLATE NOCASE
     LIMIT ?`
  ).bind(top).all()).results || [];

  const wins = (await env.DB.prepare(
    `SELECT p.id, p.name, SUM(tp.wins) AS value
     FROM tournament_participants tp JOIN players p ON p.id = tp.player_id
     GROUP BY p.id
     ORDER BY value DESC, p.name COLLATE NOCASE
     LIMIT ?`
  ).bind(top).all()).results || [];

  // Win rate: require min 5 matches to keep small-sample noise out.
  const winRate = (await env.DB.prepare(
    `SELECT p.id, p.name,
            SUM(tp.wins) AS w,
            SUM(tp.wins + tp.draws + tp.losses) AS played,
            CASE WHEN SUM(tp.wins + tp.draws + tp.losses) > 0
                 THEN ROUND(1000.0 * SUM(tp.wins) / SUM(tp.wins + tp.draws + tp.losses)) / 10
                 ELSE 0 END AS value
     FROM tournament_participants tp JOIN players p ON p.id = tp.player_id
     GROUP BY p.id
     HAVING played >= 5
     ORDER BY value DESC, w DESC, p.name COLLATE NOCASE
     LIMIT ?`
  ).bind(top).all()).results || [];

  const matchesPlayed = (await env.DB.prepare(
    `SELECT p.id, p.name, SUM(tp.wins + tp.draws + tp.losses) AS value
     FROM tournament_participants tp JOIN players p ON p.id = tp.player_id
     GROUP BY p.id
     ORDER BY value DESC, p.name COLLATE NOCASE
     LIMIT ?`
  ).bind(top).all()).results || [];

  return json({ championships, goalsFor, wins, winRate, matchesPlayed });
}

async function statsPlayer(id, env) {
  if (!env.DB) return json({ error: "D1 not configured" }, 503);
  const player = await env.DB.prepare(
    `SELECT id, name FROM players WHERE id = ?`
  ).bind(id).first();
  if (!player) return json({ error: "Player not found" }, 404);

  const totals = await env.DB.prepare(
    `SELECT COUNT(*) AS tournaments,
            COALESCE(SUM(wins), 0) AS wins,
            COALESCE(SUM(draws), 0) AS draws,
            COALESCE(SUM(losses), 0) AS losses,
            COALESCE(SUM(goals_for), 0) AS goals_for,
            COALESCE(SUM(goals_against), 0) AS goals_against
     FROM tournament_participants WHERE player_id = ?`
  ).bind(id).first();

  const championships = (await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM tournaments WHERE champion_id = ?`
  ).bind(id).first()).n;

  const runnerUps = (await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM tournaments WHERE runner_up_id = ?`
  ).bind(id).first()).n;

  const recent = (await env.DB.prepare(
    `SELECT t.id, t.ended_at, t.format, t.num_players,
            tp.team_name, tp.final_rank, tp.reached_stage,
            tp.wins, tp.draws, tp.losses, tp.goals_for, tp.goals_against
     FROM tournament_participants tp JOIN tournaments t ON t.id = tp.tournament_id
     WHERE tp.player_id = ?
     ORDER BY t.ended_at DESC
     LIMIT 10`
  ).bind(id).all()).results || [];

  return json({ player, totals, championships, runnerUps, recent });
}

async function statsH2H(url, env) {
  if (!env.DB) return json({ error: "D1 not configured" }, 503);
  const a = Number(url.searchParams.get("a"));
  const b = Number(url.searchParams.get("b"));
  if (!a || !b || a === b) return json({ error: "Provide distinct ?a=ID&b=ID" }, 400);

  const both = await env.DB.prepare(
    `SELECT id, name FROM players WHERE id IN (?, ?)`
  ).bind(a, b).all();
  const players = both.results || [];
  if (players.length !== 2) return json({ error: "Player not found" }, 404);

  const { results } = await env.DB.prepare(
    `SELECT m.id, m.tournament_id, m.stage, m.group_id,
            m.home_id, m.away_id, m.home_team, m.away_team,
            m.home_score, m.away_score, m.played_at,
            t.room_code, t.ended_at
     FROM matches m JOIN tournaments t ON t.id = m.tournament_id
     WHERE (m.home_id = ? AND m.away_id = ?) OR (m.home_id = ? AND m.away_id = ?)
     ORDER BY COALESCE(m.played_at, t.ended_at) DESC`
  ).bind(a, b, b, a).all();

  // Aggregate W/D/L from a's perspective.
  let aw = 0, draw = 0, bw = 0, agoals = 0, bgoals = 0;
  for (const m of results || []) {
    const aHome = m.home_id === a;
    const aScore = aHome ? m.home_score : m.away_score;
    const bScore = aHome ? m.away_score : m.home_score;
    agoals += aScore; bgoals += bScore;
    if (aScore > bScore) aw++;
    else if (aScore < bScore) bw++;
    else draw++;
  }
  return json({
    players,
    summary: { aWins: aw, draws: draw, bWins: bw, aGoals: agoals, bGoals: bgoals, matches: (results || []).length },
    matches: results || [],
  });
}

function cors(response) {
  const r = new Response(response.body, response);
  r.headers.set("Access-Control-Allow-Origin", "*");
  r.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  r.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return r;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
