// Splitwise API helpers, shared by the Worker (OAuth dance) and the RoomDO
// (room-scoped group/settle calls). Tokens never reach the client.
//
// OAuth endpoints per the app dashboard (secure.splitwise.com/oauth/…).
// Access tokens never expire (no refresh tokens).

const API_BASE = "https://secure.splitwise.com/api/v3.0";
const OAUTH_BASE = "https://secure.splitwise.com/oauth";

export function authorizeUrl(clientId, redirectUri, state) {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    state,
  });
  return `${OAUTH_BASE}/authorize?${p}`;
}

// Exchange an authorization code for a (non-expiring) access token.
export async function exchangeCode(env, code, redirectUri) {
  const res = await fetch(`${OAUTH_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.SPLITWISE_CLIENT_ID,
      client_secret: env.SPLITWISE_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status})`);
  const data = await res.json();
  if (!data?.access_token) throw new Error("No access token in response");
  return data.access_token;
}

async function api(token, path) {
  const res = await fetch(`${API_BASE}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new Error("Splitwise token rejected — reconnect Splitwise");
  if (!res.ok) throw new Error(`Splitwise returned ${res.status}`);
  return res.json();
}

export async function getCurrentUser(token) {
  const data = await api(token, "get_current_user");
  const u = data?.user || {};
  return {
    id: u.id,
    name: [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || u.email || `User ${u.id}`,
  };
}

function memberName(m) {
  return [m.first_name, m.last_name].filter(Boolean).join(" ").trim() || m.email || `User ${m.id}`;
}

// The user's groups, members inline. Skips the pseudo-group id 0
// ("non-group expenses").
export async function getGroups(token) {
  const data = await api(token, "get_groups");
  return (data?.groups || [])
    .filter((g) => g.id !== 0)
    .map((g) => ({
      id: g.id,
      name: g.name,
      members: (g.members || []).map((m) => ({ id: m.id, name: memberName(m) })),
    }));
}

export async function getGroupMembers(token, groupId) {
  const data = await api(token, `get_group/${groupId}`);
  return (data?.group?.members || []).map((m) => ({ id: m.id, name: memberName(m) }));
}

// Create ONE expense covering the whole game: winners' paid_share equals
// their winnings, losers' owed_share equals their losses; both sums = pot.
// participants: [{ userId, net }] — net > 0 winner, net < 0 loser.
// Returns { ok:true, expenseId, cost } or { ok:false, error }.
export async function createSettlementExpense(token, groupId, { description, currency, date, participants }) {
  const active = (participants || []).filter((p) => p && p.userId && Math.abs(Number(p.net) || 0) > 0.005);
  if (active.length === 0) return { ok: false, error: "No non-zero participants to settle" };

  const winners = active.filter((p) => Number(p.net) > 0);
  const losers = active.filter((p) => Number(p.net) < 0);
  if (winners.length === 0 || losers.length === 0) {
    return { ok: false, error: "Need at least one winner and one loser to settle" };
  }

  const totalPaid = winners.reduce((s, p) => s + Number(p.net), 0);
  const totalOwed = losers.reduce((s, p) => s - Number(p.net), 0);
  // Cost should match both sums; tiny rounding drift gets folded into the largest winner.
  const cost = Math.max(totalPaid, totalOwed);
  const drift = Number((totalPaid - totalOwed).toFixed(2));

  const params = new URLSearchParams({
    cost: cost.toFixed(2),
    description: description || "Poker night settlement",
    group_id: String(groupId),
    currency_code: currency || "INR",
  });
  if (date) params.set("date", date);

  const largestWinnerIdx = winners.reduce(
    (best, p, i) => (Number(p.net) > Number(winners[best].net) ? i : best),
    0
  );

  active.forEach((p, i) => {
    let net = Number(p.net);
    if (net > 0 && winners.indexOf(p) === largestWinnerIdx) net -= drift;
    params.set(`users__${i}__user_id`, String(p.userId));
    params.set(`users__${i}__paid_share`, net > 0 ? net.toFixed(2) : "0.00");
    params.set(`users__${i}__owed_share`, net < 0 ? (-net).toFixed(2) : "0.00");
  });

  try {
    const res = await fetch(`${API_BASE}/create_expense`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    });
    // Splitwise can return 200 with an `errors` body — check both.
    const data = await res.json().catch(() => ({}));
    const errs = data?.errors && Object.keys(data.errors).length ? data.errors : null;
    if (!res.ok || errs) {
      return { ok: false, error: errs ? JSON.stringify(errs) : `HTTP ${res.status}` };
    }
    return { ok: true, expenseId: data?.expenses?.[0]?.id ?? null, cost };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Signed OAuth state (CSRF protection, stateless) ────────────────────
// state = base64url(payload) + "." + base64url(HMAC-SHA256(payload, secret))

const enc = new TextEncoder();

function b64url(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  const s = atob(str.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signState(secret, payload) {
  const body = enc.encode(JSON.stringify(payload));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, body);
  return `${b64url(body)}.${b64url(sig)}`;
}

export async function verifyState(secret, state) {
  const [body, sig] = String(state || "").split(".");
  if (!body || !sig) return null;
  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify("HMAC", key, b64urlDecode(sig), b64urlDecode(body));
  if (!ok) return null;
  try {
    return JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
  } catch {
    return null;
  }
}
