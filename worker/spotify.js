// Spotify OAuth for the Know Your Song game ("song").
//
// Ported from the standalone Next.js app's route handlers. The shape is
// unchanged: the client secret and refresh token never reach the browser —
// they live in httpOnly cookies and Worker secrets, and the browser only ever
// asks /api/spotify/token for a short-lived access token.

const AUTH_URL = "https://accounts.spotify.com/authorize";
const TOKEN_URL = "https://accounts.spotify.com/api/token";

const SCOPES = [
  "user-library-read",
  "streaming",
  "user-read-email",
  "user-read-private",
  "user-read-playback-state",
  "user-modify-playback-state",
].join(" ");

const COOKIE = {
  access: "kys_at",
  refresh: "kys_rt",
  expires: "kys_exp",
  state: "kys_state",
};

const MONTH = 60 * 60 * 24 * 30;

// The callback lands on the Worker, so the redirect URI is just this origin.
// SPOTIFY_REDIRECT_URI overrides it for the case where the registered URI has
// to differ from the request origin (a tunnel, a custom preview domain).
function redirectUri(url, env) {
  return env.SPOTIFY_REDIRECT_URI || `${url.origin}/api/spotify/callback`;
}

function creds(env) {
  const clientId = env.SPOTIFY_CLIENT_ID || "";
  const clientSecret = env.SPOTIFY_CLIENT_SECRET || "";
  if (!clientId || !clientSecret) {
    throw new Error(
      "Spotify is not configured. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET Worker secrets."
    );
  }
  return { clientId, clientSecret };
}

function basicAuth({ clientId, clientSecret }) {
  return `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
}

async function requestToken(env, body) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuth(creds(env)),
    },
    body: new URLSearchParams(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      json?.error_description || json?.error || `Spotify returned ${res.status}`
    );
  }
  return json;
}

// ── Cookies ────────────────────────────────────────────────

function readCookies(request) {
  const out = {};
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(headers, name, value, { maxAge, secure }) {
  const bits = [
    `${name}=${encodeURIComponent(value)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAge}`,
  ];
  if (secure) bits.push("Secure");
  headers.append("Set-Cookie", bits.join("; "));
}

function clearCookie(headers, name, secure) {
  setCookie(headers, name, "", { maxAge: 0, secure });
}

/** Writes the access / expiry / (rotated) refresh cookies from a token grant. */
function writeSession(headers, token, secure) {
  const expiresAt = Date.now() + token.expires_in * 1000;
  setCookie(headers, COOKIE.access, token.access_token, {
    maxAge: token.expires_in,
    secure,
  });
  setCookie(headers, COOKIE.expires, String(expiresAt), { maxAge: MONTH, secure });
  // Spotify may hand back a rotated refresh token; keep the newest one.
  if (token.refresh_token) {
    setCookie(headers, COOKIE.refresh, token.refresh_token, { maxAge: MONTH, secure });
  }
  return expiresAt;
}

const isSecure = (url) => url.protocol === "https:";

function json(obj, status = 200, headers = new Headers()) {
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(obj), { status, headers });
}

// ── Routes ─────────────────────────────────────────────────

// GET /api/spotify/login → 302 to Spotify's consent page.
export function spotifyLogin(url, env) {
  let id;
  try {
    id = creds(env).clientId;
  } catch (e) {
    return json({ error: e.message }, 503);
  }
  const state = crypto.randomUUID();
  const params = new URLSearchParams({
    client_id: id,
    response_type: "code",
    redirect_uri: redirectUri(url, env),
    scope: SCOPES,
    state,
    show_dialog: "false",
  });
  const headers = new Headers({ Location: `${AUTH_URL}?${params}` });
  setCookie(headers, COOKIE.state, state, { maxAge: 600, secure: isSecure(url) });
  return new Response(null, { status: 302, headers });
}

// GET /api/spotify/callback → exchange the code, set cookies, bounce into the game.
export async function spotifyCallback(request, url, env) {
  const secure = isSecure(url);
  const back = (suffix = "") =>
    new Response(null, {
      status: 302,
      headers: { Location: `${url.origin}/#/song${suffix}` },
    });
  const fail = (message) => back(`?error=${encodeURIComponent(message)}`);

  const denied = url.searchParams.get("error");
  if (denied) return fail(`Spotify said: ${denied}`);

  const code = url.searchParams.get("code");
  if (!code) return fail("No authorization code came back from Spotify.");

  // CSRF check: the state must match the one we set before redirecting out.
  const expected = readCookies(request)[COOKIE.state];
  if (!expected || url.searchParams.get("state") !== expected) {
    return fail("Login state did not match. Start again.");
  }

  try {
    const token = await requestToken(env, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(url, env),
    });
    const headers = new Headers({ Location: `${url.origin}/#/song` });
    writeSession(headers, token, secure);
    clearCookie(headers, COOKIE.state, secure);
    return new Response(null, { status: 302, headers });
  } catch (e) {
    return fail(e.message);
  }
}

/**
 * GET /api/spotify/token — hands the browser a currently-valid access token,
 * refreshing it here when needed.
 */
export async function spotifyToken(request, url, env) {
  const jar = readCookies(request);
  const access = jar[COOKIE.access];
  const refresh = jar[COOKIE.refresh];
  const expiresAt = Number(jar[COOKIE.expires] || 0);
  const secure = isSecure(url);

  if (access && Date.now() < expiresAt - 60_000) {
    return json({ access_token: access, expires_at: expiresAt });
  }
  if (!refresh) return json({ error: "Not signed in" }, 401);

  try {
    const token = await requestToken(env, {
      grant_type: "refresh_token",
      refresh_token: refresh,
    });
    const headers = new Headers();
    const newExpiry = writeSession(headers, token, secure);
    return json({ access_token: token.access_token, expires_at: newExpiry }, 200, headers);
  } catch (e) {
    // A dead refresh token is unrecoverable — drop the session so the client
    // falls back to the sign-in screen instead of retrying forever.
    const headers = new Headers();
    for (const name of [COOKIE.access, COOKIE.refresh, COOKIE.expires]) {
      clearCookie(headers, name, secure);
    }
    return json({ error: e.message }, 401, headers);
  }
}

// POST /api/spotify/logout → drop every cookie.
export function spotifyLogout(url) {
  const headers = new Headers();
  for (const name of Object.values(COOKIE)) clearCookie(headers, name, isSecure(url));
  return json({ ok: true }, 200, headers);
}
