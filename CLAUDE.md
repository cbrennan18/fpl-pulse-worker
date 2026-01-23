# CLAUDE.md

Project context for AI-assisted development on the FPL Pulse Worker.

## Architecture

Single Cloudflare Worker (`src/worker.js`, ~1,327 lines) with:
- **Data flow:** FPL API → Worker → KV → Edge Cache → Client
- **Storage:** Cloudflare KV (`FPL_PULSE_KV` binding)
- **Schedule:** Hourly cron triggers harvest of all entries
- **Config:** `wrangler.toml` (v0.10, season 2025, league 852082)

## KV Key Schema

```
season:<year>:bootstrap           # Game metadata + player info
entry:<id>:<season>               # Full season blob (picks, history, transfers)
entry:<id>:<season>:state         # State machine: queued|building|complete|errored|dead
league:<id>:members               # Array of entry IDs
snapshot:current                  # Last processed GW info
heartbeat:<iso-timestamp>         # Cron liveness marker
```

## Entry State Machine

```
queued → building → complete    (success)
queued → building → errored     (failure)
errored → queued                (auto-retry after 1h, max 3 attempts)
errored → dead                  (after 3 failed attempts)
dead → queued                   (manual revive via /admin/dead/revive)
errored → queued                (manual retry via admin)
building → queued               (60-min timeout reset)
```

## Code Layout (src/worker.js)

| Lines | Section |
|-------|---------|
| 1-50 | Utilities: CORS, response helpers, cache helpers, `dynamicCacheHeaders()` |
| 50-140 | KV helpers, key builders, `MAX_LEAGUE_SIZE = 50` |
| 142-180 | Circuit breaker (15 failures, 15-min reset) |
| 182-230 | `fetchJsonWithRetry()` with 429/503 handling |
| 230-410 | `processEntryOnce()` — smart partial backfill |
| 410-540 | `updateEntryForGW()` — conditional transfer/summary refresh |
| 540-620 | Harvest loop with batch concurrency (5 parallel) |
| 620-750 | `/health/detailed` endpoint |
| 750-900 | Entry + entries-pack endpoints with dynamic cache + stale headers |
| 900-1327 | Admin routes, league ingest, backfill, warm, cron handler |

## Key Patterns

**Conditional refresh:** Check `*_last_refreshed_at` timestamps before fetching. Transfers: 6h threshold. Summaries: 12h threshold.

**Smart backfill:** Read existing blob, find `last_gw_processed`, only fetch GWs after that. Also backfills any gaps in earlier GWs.

**Dynamic cache:** Read bootstrap to check if current GW is active (`is_current && !finished`). Active: 6h s-maxage. Finished: 7d s-maxage.

**Circuit breaker:** In-memory counter. Opens at 15 failures, blocks fetches for 15 min. Decrements on success. 404s excluded. Resets on worker restart.

**Auto-retry:** Hourly cron re-queues errored entries after 1h cooldown, max 3 attempts, 5 per cycle.

## Known Limitations

1. Circuit breaker resets on worker restart (stateless, acceptable at current scale)
2. `/health/detailed` scans first 200 entry states only
3. Dynamic cache requires bootstrap KV read per entry request (edge-cached)
4. Season hardcoded in `wrangler.toml` — no automatic rollover
5. No deduplication of concurrent admin requests

## Future Enhancements

- Structured JSON logging for log aggregation
- Admin endpoint to view/manage entry states in bulk
- Admin endpoint to view dead entry error details
- KV blob compression (gzip) if blobs grow large
- Split into read/write/cron workers at scale
- Durable Objects for atomic state transitions
- Cloudflare Queues to replace KV-based backfill queue
