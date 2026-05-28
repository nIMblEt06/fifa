// Cloudflare Worker entry. Routes /api/room/:code/* to a Durable Object instance
// keyed by the room code. Everything else falls through to the static asset binding
// (Vite-built React app + /teams.json + /favicon.svg).

export { RoomDO } from "./RoomDO.js";

const ROUTE = /^\/api\/room\/([A-Z0-9]{2,8})\/.+$/i;
const SPLITWISE_BASE = "https://secure.splitwise.com/api/v3.0";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── Splitwise proxy (token stays server-side) ──────────────
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
      const code = m[1].toUpperCase();
      const id = env.ROOMS.idFromName(code);
      const stub = env.ROOMS.get(id);
      return stub.fetch(request);
    }
    // Static assets (with SPA fallback configured in wrangler.toml)
    return env.ASSETS.fetch(request);
  },
};

// Returns the group members as [{ id, name }], or a clear error if the
// Worker secrets are not configured.
async function splitwiseGroup(env) {
  if (!env.SPLITWISE_TOKEN || !env.SPLITWISE_GROUP_ID) {
    return json({ error: "Splitwise not configured. Set SPLITWISE_TOKEN and SPLITWISE_GROUP_ID Worker secrets." }, 503);
  }
  let res;
  try {
    res = await fetch(`${SPLITWISE_BASE}/get_group/${env.SPLITWISE_GROUP_ID}`, {
      headers: { Authorization: `Bearer ${env.SPLITWISE_TOKEN}` },
    });
  } catch (e) {
    return json({ error: `Splitwise request failed: ${e.message}` }, 502);
  }
  if (!res.ok) {
    return json({ error: `Splitwise returned ${res.status}` }, 502);
  }
  const data = await res.json();
  const members = (data?.group?.members || []).map((mbr) => ({
    id: mbr.id,
    name: [mbr.first_name, mbr.last_name].filter(Boolean).join(" ").trim() || mbr.email || `User ${mbr.id}`,
  }));
  return json(members);
}

// Body: { description, currency:"INR", date:"YYYY-MM-DD",
//         participants: [{ userId, net }] }
// where net > 0 = winner (they're owed), net < 0 = loser (they owe).
// Creates ONE Splitwise expense covering the whole game: winners' paid_share
// equals their winnings; losers' owed_share equals their losses; both sums = pot.
async function splitwiseSettle(request, env) {
  if (!env.SPLITWISE_TOKEN || !env.SPLITWISE_GROUP_ID) {
    return json({ error: "Splitwise not configured. Set SPLITWISE_TOKEN and SPLITWISE_GROUP_ID Worker secrets." }, 503);
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const description = body?.description || "Poker night settlement";
  const currency = body?.currency || "INR";
  const date = body?.date;
  const participants = Array.isArray(body?.participants) ? body.participants : [];

  const active = participants.filter((p) => p && p.userId && Math.abs(Number(p.net) || 0) > 0.005);
  if (active.length === 0) return json({ error: "No non-zero participants to settle" }, 400);

  const winners = active.filter((p) => Number(p.net) > 0);
  const losers = active.filter((p) => Number(p.net) < 0);
  if (winners.length === 0 || losers.length === 0) {
    return json({ error: "Need at least one winner and one loser to settle" }, 400);
  }

  const totalPaid = winners.reduce((s, p) => s + Number(p.net), 0);
  const totalOwed = losers.reduce((s, p) => s - Number(p.net), 0);
  // Cost should match both sums; tiny rounding drift gets folded into the largest winner.
  const cost = Math.max(totalPaid, totalOwed);
  const drift = Number((totalPaid - totalOwed).toFixed(2));

  const params = new URLSearchParams({
    cost: cost.toFixed(2),
    description,
    group_id: String(env.SPLITWISE_GROUP_ID),
    currency_code: currency,
  });
  if (date) params.set("date", date);

  // Fold any cents-level rounding drift into the largest winner's paid_share so
  // sum(paid_share) === sum(owed_share) === cost. (Splitwise rejects mismatches.)
  const largestWinnerIdx = winners.reduce(
    (best, p, i) => (Number(p.net) > Number(winners[best].net) ? i : best),
    0
  );

  active.forEach((p, i) => {
    let net = Number(p.net);
    if (net > 0 && winners.indexOf(p) === largestWinnerIdx) net -= drift;
    const paid = net > 0 ? net.toFixed(2) : "0.00";
    const owed = net < 0 ? (-net).toFixed(2) : "0.00";
    params.set(`users__${i}__user_id`, String(p.userId));
    params.set(`users__${i}__paid_share`, paid);
    params.set(`users__${i}__owed_share`, owed);
  });

  try {
    const res = await fetch(`${SPLITWISE_BASE}/create_expense`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.SPLITWISE_TOKEN}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    });
    const data = await res.json().catch(() => ({}));
    const errs = data?.errors && Object.keys(data.errors).length ? data.errors : null;
    if (!res.ok || errs) {
      return json({ ok: false, error: errs ? JSON.stringify(errs) : `HTTP ${res.status}` });
    }
    return json({ ok: true, expenseId: data?.expenses?.[0]?.id ?? null, cost });
  } catch (e) {
    return json({ ok: false, error: e.message });
  }
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
