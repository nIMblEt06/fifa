# Poker → Splitwise settlement

The Poker game settles net cash results into a Splitwise group. The Splitwise
API token is read **only by the Cloudflare Worker** (`worker/index.js`) — it is
never sent to or stored in the client.

## Required Worker secrets

| Secret                | What it is                                                        |
| --------------------- | ----------------------------------------------------------------- |
| `SPLITWISE_TOKEN`     | Splitwise API OAuth/personal access token (Bearer token).         |
| `SPLITWISE_GROUP_ID`  | The numeric id of the Splitwise group to create expenses in.      |

Get a token from https://secure.splitwise.com/apps (register an app, then copy
its API key / personal access token). Find the group id in the group's URL on
the Splitwise web app.

## Setting the secrets

```sh
wrangler secret put SPLITWISE_TOKEN
# paste the token when prompted

wrangler secret put SPLITWISE_GROUP_ID
# paste the numeric group id when prompted
```

For local dev with `wrangler dev`, put them in `.dev.vars`:

```
SPLITWISE_TOKEN=xxxxxxxxxxxxxxxx
SPLITWISE_GROUP_ID=123456789
```

If either secret is unset the worker returns a 503 `{ error: "Splitwise not
configured…" }` and the UI surfaces it with these setup instructions.

## Worker routes

- `GET /api/splitwise/group` → proxies `GET /get_group/{id}`, returns
  `[{ id, name }]` of group members.
- `POST /api/splitwise/settle` → body
  `{ description, currency: "INR", transfers: [{ fromUserId, toUserId, amount }] }`.
  Creates one Splitwise expense per transfer (`POST /create_expense`); the
  creditor (`toUserId`) is recorded as having paid the full cost, the debtor
  (`fromUserId`) as owing it. Returns `{ results: [{ ...transfer, ok, error?, expenseId? }] }`.
