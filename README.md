# FPL Pulse Worker

A Cloudflare Worker that powers the [FPL Pulse](https://github.com/cbrennan18/fpl-mini-league) frontend by fetching, processing, and caching data from the official Fantasy Premier League API.

It runs on Cloudflare's edge network, stores data in KV (a key-value store), and keeps everything up to date with an hourly cron job.

## How It Works

1. An admin ingests a mini-league, which queues each team for processing
2. The worker fetches each team's picks, history, and transfers from the FPL API
3. Everything is stored in Cloudflare KV as JSON blobs, one per team per season
4. An hourly cron job detects new finished gameweeks and updates all teams automatically
5. The frontend reads from the `/v1/*` endpoints, which serve data from KV with edge caching

## Project Structure

```
src/
├── worker.js              Entry point: route dispatch and cron handler
├── routes/
│   ├── public.js          /health, /v1/*, /fpl/* proxy endpoints
│   └── admin.js           /admin/* endpoints (auth required)
├── services/
│   ├── entry.js           Builds team data, retries failures, health tracking
│   └── harvest.js         Season detection, gameweek harvesting, cache warming
└── lib/
    ├── kv.js              KV read/write helpers, key builders, schema validation
    ├── fpl-api.js          FPL API client with circuit breaker and retry logic
    └── utils.js            CORS, response helpers, logging, idempotency
```

## API

### Public Endpoints

| Route | Description |
|-------|-------------|
| `GET /health` | Basic health check |
| `GET /health/detailed` | Entry state counts, circuit breaker status, gameweek info |
| `GET /v1/entry/:id` | A team's full season data (picks, history, transfers) |
| `GET /v1/league/:id/members` | List of team IDs in a league |
| `GET /v1/league/:id/entries-pack` | All team data for a league in one request |
| `GET /v1/season/bootstrap` | Game metadata and player info |
| `GET /v1/season/elements` | Player scores by gameweek |

### Admin Endpoints

All require authentication via `?token=<token>` or `X-Refresh-Token` header.

| Route | Description |
|-------|-------------|
| `POST /admin/league/:id/ingest` | Load a league and queue its members |
| `POST /admin/backfill` | Process queued teams (supports `?single=true&entry=<id>` or `?limit=N`) |
| `POST /admin/harvest` | Trigger gameweek harvest for all teams |
| `POST /admin/warm` | Pre-warm the edge cache |
| `POST /admin/circuit-breaker/reset` | Reset the FPL API failure counter |
| `GET /admin/entries/states` | View all team processing states |
| `POST /admin/entries/states/bulk` | Bulk requeue or purge teams |
| `GET /admin/entries/dead` | List permanently failed teams |
| `POST /admin/dead/revive` | Re-queue all dead teams |

### Response Headers

Responses include `X-Cache` (HIT/MISS), `X-App-Version`, and cache control headers.

## Key Features

- **Edge caching** with dynamic TTL: 6 hours during active gameweeks, 7 days after a gameweek finishes
- **Smart backfill** that only fetches missing gameweeks, skipping data already stored
- **Circuit breaker** that stops calling the FPL API after 15 consecutive failures, resetting after 15 minutes
- **Auto-retry** for failed teams: hourly cron re-queues errored teams (max 3 attempts before dead-lettering)
- **Conditional refresh** of transfers (every 6h) and team summaries (every 12h) to reduce API calls
- **Idempotent admin operations** via `X-Idempotency-Key` header (cached for 1 hour)
- **League size cap** of 50 members (designed for friends-only mini-leagues)

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- A [Cloudflare account](https://dash.cloudflare.com/) with Workers enabled
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (installed as a dev dependency)

### Local Development

```bash
npm install
npx wrangler dev
```

Create a `.dev.vars` file with your secrets:

```
REFRESH_TOKEN=your-admin-token-here
```

### Running Tests

```bash
npm test
```

This runs 70 tests covering the circuit breaker, schema validation, team processing state machine, season detection, and retry/dead-letter logic.

### Deploying

```bash
npx wrangler deploy
```

Set your admin token as a secret (only needed once):

```bash
npx wrangler secret put REFRESH_TOKEN
```

## Tech Stack

- **Runtime:** [Cloudflare Workers](https://workers.cloudflare.com/)
- **Storage:** [Cloudflare KV](https://developers.cloudflare.com/kv/)
- **Testing:** [Vitest](https://vitest.dev/)
- **Language:** JavaScript (ES modules)
- **Data source:** [FPL API](https://fantasy.premierleague.com/api/bootstrap-static/)

## License

ISC
