# Poker → Splitwise

The Poker game settles net cash results into a Splitwise group. Tokens are
handled **only server-side** (Worker + Room Durable Object) — never sent to or
stored in the client.

## Per-room OAuth (the normal flow)

Anyone can use the app with their own Splitwise:

1. In the poker lobby, the person running the books hits **Connect Splitwise**.
2. `GET /api/splitwise/auth/start?room=CODE` redirects to Splitwise's consent
   page (`www.splitwise.com/oauth/authorize`) with an HMAC-signed `state`
   carrying the room code.
3. `GET /api/splitwise/callback` exchanges the code for an access token
   (Splitwise tokens never expire — no refresh logic), stores it in the room's
   Durable Object under a private storage key, and bounces back to the room.
4. The lobby then lists the connector's groups
   (`GET /api/room/CODE/splitwise/groups`); picking one
   (`POST /api/room/CODE/splitwise/group`) caches the member list, which seeds
   the seat → member mapping for settlement.
5. After the session, `POST /api/room/CODE/splitwise/settle` creates ONE
   expense in the selected group: winners' `paid_share` = winnings, losers'
   `owed_share` = losses, both sums = pot.

### Required Worker secrets (app-level, set once by the operator)

| Secret                    | What it is                                            |
| ------------------------- | ----------------------------------------------------- |
| `SPLITWISE_CLIENT_ID`     | Consumer Key of your registered Splitwise app.        |
| `SPLITWISE_CLIENT_SECRET` | Consumer Secret (also signs the OAuth `state` HMAC).  |

Register the app at https://secure.splitwise.com/apps with the **Callback
URL** set to `https://<your-domain>/api/splitwise/callback`.

```sh
wrangler secret put SPLITWISE_CLIENT_ID
wrangler secret put SPLITWISE_CLIENT_SECRET
```

For local dev (`wrangler dev`), put them in `.dev.vars` and register a second
Splitwise app whose callback points at `http://localhost:5173/api/splitwise/callback`.

## Legacy house-token fallback

If `SPLITWISE_TOKEN` and `SPLITWISE_GROUP_ID` Worker secrets are set, rooms
with no per-room connection automatically use them ("house account", group
pre-selected). This keeps the original single-group setup working with zero
re-auth.

## Routes

- `GET  /api/splitwise/auth/start?room=CODE` → 302 to Splitwise consent.
- `GET  /api/splitwise/callback` → token exchange → hand-off to the room DO.
- `GET  /api/room/CODE/splitwise` → public status `{connected, via, userName, groupId, groupName, members}`.
- `GET  /api/room/CODE/splitwise/groups` → connector's groups `[{id, name, memberCount}]`.
- `POST /api/room/CODE/splitwise/group` → `{groupId}`; caches members, broadcasts.
- `POST /api/room/CODE/splitwise/settle` → `{description, currency, date, participants: [{userId, net}]}`.
- `POST /api/room/CODE/splitwise/disconnect` → drop the room token.
- `GET /api/splitwise/group`, `POST /api/splitwise/settle` → legacy house-token
  endpoints, kept for old cached clients.

Quirk worth knowing: Splitwise's `create_expense` can return HTTP 200 with an
`errors` body — both are checked (see `worker/splitwise.js`).
