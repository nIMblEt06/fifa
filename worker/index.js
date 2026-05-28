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
