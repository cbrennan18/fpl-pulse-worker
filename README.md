# FPL Pulse Worker

Cloudflare Worker that fetches and caches Fantasy Premier League data in KV for the FPL Pulse frontend.

## API

### Public

| Route | Method | Description |
|-------|--------|-------------|
| `/health` | GET | Basic health check |
| `/health/detailed` | GET | Entry counts, circuit breaker, gameweek state |
| `/v1/entry/:id` | GET | Team's full season data |
| `/v1/league/:id/members` | GET | Entry IDs in a league |
| `/v1/league/:id/entries-pack` | GET | All entries for a league |
| `/v1/season/bootstrap` | GET | Game metadata and player info |
| `/v1/season/elements` | GET | Player scores by gameweek |

### Admin

All require a refresh token via `?token=<token>` or `X-Refresh-Token` header.

| Route | Method | Description |
|-------|--------|-------------|
| `/admin/league/:id/ingest` | POST | Load league and queue members for backfill |
| `/admin/backfill?single=true&entry=<id>` | POST | Build data for one entry |
| `/admin/backfill?limit=5` | POST | Batch build up to 5 queued entries |
| `/admin/harvest` | POST | Update all entries for current gameweek |
| `/admin/warm` | POST | Pre-warm edge cache |

### Response Headers

Entry endpoints include: `X-Cache`, `X-App-Version`, `X-Data-Age-Days`, `X-Data-Stale`.

## Development

```bash
npx wrangler dev
```

## Deployment

```bash
npx wrangler deploy
```

## Key Behaviours

- **Dynamic caching:** 6h TTL during active gameweeks, 7d after GW finishes
- **Conditional refreshes:** transfers refresh if >6h stale, summaries if >12h stale
- **Smart backfill:** only fetches missing gameweeks for near-complete entries
- **Circuit breaker:** opens after 5 consecutive FPL API failures, resets after 15 minutes
- **Hourly cron:** harvests all entries and writes a heartbeat to KV
- **League cap:** 50 members max

## Notes

- Value/bank fields stored as x10 (divide by 10 in frontend)
- Circuit breaker is in-memory; resets on worker restart
- Health check scans first 200 entry states to avoid timeout
