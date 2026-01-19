# FPL Pulse Worker

This Cloudflare Worker handles backend data for the FPL Pulse project.  
It fetches and caches Fantasy Premier League data, storing everything in Cloudflare KV for fast, low-cost reads.

## Overview

- Fetches entry history, transfers, and picks from the official FPL API  
- Caches results at the edge for seven days (stale-while-revalidate for one day)  
- Restricts leagues to a maximum of 50 members  
- Provides a small set of admin routes for ingesting and backfilling data  

## API

### Public Routes

| Route | Method | Description |
|--------|---------|-------------|
| `/health` | GET | Basic health check (version, status) |
| `/health/detailed` | GET | Detailed system metrics (entries, circuit breaker, gameweek state) |
| `/v1/entry/:id` | GET | Returns a team's full season data |
| `/v1/league/:id/members` | GET | Returns entry IDs in a league |
| `/v1/league/:id/entries-pack` | GET | Returns all available entries for a small league |
| `/v1/season/bootstrap` | GET | Game metadata and player info |
| `/v1/season/elements` | GET | Player scores by gameweek |

### Admin Routes

| Route | Method | Description |
|--------|---------|-------------|
| `/admin/league/:id/ingest` | POST | Loads a league and queues members for backfill |
| `/admin/backfill?single=true&entry=<id>` | POST | Builds data for one entry |
| `/admin/backfill?limit=5` | POST | Batch builds up to five queued entries |
| `/admin/harvest` | POST | Manually trigger harvest (updates all entries) |
| `/admin/warm` | POST | Pre-warm edge cache for common requests |

All admin routes require a valid refresh token, passed as `?token=<token>` or in the `X-Refresh-Token` header.

## Development

Run locally:

```bash
npx wrangler dev
```

Test ingest and backfill:

```bash
TOKEN="your_token"
curl -X POST "http://localhost:8787/admin/league/852082/ingest?token=$TOKEN"
curl -X POST "http://localhost:8787/admin/backfill?single=true&entry=<entry_id>&token=$TOKEN"
```

## Notes
- League size is capped at 50 entries to keep it personal and lightweight
- Value and bank fields are stored as x10 (divide by 10 in the frontend)
- Data is cached for seven days at the edge