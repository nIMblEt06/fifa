# FIFA / TOURNAMENT

A real-time, room-based tournament tracker for FIFA nights with friends. Brutalist sports-ticker UI. No accounts, no login — share a 4-letter room code and anyone with the link can score, react, and watch live.

Built with React + Vite, running on Cloudflare Workers + Durable Objects (one DO per room) for live sync via WebSockets.

---

## Features

- **No login** — every visit mints a 4-letter room code; share the URL and you're in
- **Group stage → knockouts** — round-robin fixtures (no rematches) with a top-4 cut to semi-finals + final
- **Two-tap scoring** — tap any match → fullscreen scorer with vertical number wheels → swipe up to confirm
- **One screen, no nav** — bracket dominates the canvas, standings + Wall of Shame in an aside
- **Live presence** — `👀 N watching` derived from active WebSocket connections (no heartbeat hack)
- **Floating reactions** — tap an emoji, it flies across every connected screen
- **Auto trash-talk marquee** — generated headlines stream across the top ("MASSACRE — HARSH DESTROYS PRABHAS 6–0")
- **Wall of Shame** — heaviest defeat, leakiest defence, scoreless games, longest losing streak
- **Searchable team picker** — 374 teams from 27 leagues (TheSportsDB) with badges, league-first navigation
- **Smart fixture ordering** — back-to-back matches minimised; players get rest when possible

## Stack

| Layer | Tool |
|---|---|
| Frontend | React 19 + Vite 8 |
| Local dev | `@cloudflare/vite-plugin` (runs Worker + DO inside Vite) |
| Backend | Single Cloudflare Worker |
| State + Realtime | Durable Objects (one per room code), SQLite-backed storage, hibernatable WebSockets |
| Static hosting | Cloudflare Workers `[assets]` binding |
| Team data | TheSportsDB v3 (free public key), pre-baked into `/public/teams.json` |

## Project layout

```
src/
  App.jsx                  Main app + room sync wiring
  components/
    PlayerSetup.jsx        Add players + matches/player segmented control
    TeamSelect.jsx         Pick a team per player (uses TeamCombobox)
    TeamCombobox.jsx       Custom league-first searchable picker with badges
    GroupStage.jsx         Group-stage match grid
    KnockoutBracket.jsx    Semis + final + champion banner
    MatchCard.jsx          One match (display only — opens Scorer on tap)
    Scorer.jsx             Fullscreen 2-wheel score entry overlay
    StandingsTable.jsx     P / W / D / L / GF / GA / GD / Pts
    WallOfShame.jsx        Auto-computed shame metrics
    Marquee.jsx            Top-of-screen trash-talk ticker
    Reactions.jsx          Bottom emoji bar + flying reactions
  utils/
    fixtures.js            Backtracking generator + back-to-back-minimising spreader
    headlines.js           Trash-talk + Wall of Shame generators
    room.js                Room code mint/parse + share URL
    useRoom.js             WebSocket sync hook (state, presence, reactions)
    useTeams.js            Loads /teams.json
worker/
  index.js                 Routes /api/room/:code/* to a DO instance
  RoomDO.js                Durable Object: state, presence, reactions, broadcasts
public/
  teams.json               Pre-baked team list (374 teams)
scripts/
  fetchTeams.mjs           Re-build teams.json from TheSportsDB
wrangler.toml              CF Worker + DO + assets config
```

## Local development

```bash
npm install
npm run dev
```

Opens at `http://localhost:5173/`. The Cloudflare Vite plugin runs the real Worker + Durable Object locally, with state persisted in `.wrangler/state/`. Open two tabs to the same room URL to see sync working.

## Deploy to Cloudflare

```bash
npx wrangler login   # one-time
npm run deploy
```

`npm run deploy` builds the React app + Worker bundle and pushes to Cloudflare. App goes live at `https://fifa-tournament.<your-subdomain>.workers.dev`.

## Refresh the team list

```bash
npm run fetch-teams
```

Pulls from TheSportsDB into `public/teams.json`. Edit the `LEAGUES` array in `scripts/fetchTeams.mjs` to add or remove leagues.

## Other scripts

```bash
npm run build      # production build → dist/client + dist/fifa_tournament
npm run preview    # preview built app (no Worker)
npm run lint       # eslint
```

## Design notes

- **Theme:** brutalist sports-ticker. Off-black canvas, hot-magenta as the only accent, Anton (display) + JetBrains Mono (numerics) + Space Grotesk (body). 1px hard borders, square corners, no soft shadows. Themed scrollbars throughout.
- **No-rematches constraint:** with N players, matches-per-player caps at N-1 (one game vs every other player). The setup screen explains the cap inline.
- **Fixture ordering:** after backtracking finds a valid pairing set, a greedy pass orders matches to maximise the minimum rest gap per player. Verified to keep max back-to-back at 1 for most configurations.
- **Last-write-wins:** no CRDTs. Two simultaneous edits clobber each other. Fine for couch use.

## Costs

Cloudflare free tier covers casual use:
- Worker: 100k requests / day
- Durable Objects: 1M requests / month, 5 GB SQLite storage
- WebSocket idle time is free (DO hibernation)

A typical 3-hour tournament with 5 viewers is well under free tier. Beyond that, $5/mo unlocks the paid plan.
