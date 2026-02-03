# CLAUDE.md

Project context for AI-assisted development on the FPL Pulse Worker.

## Architecture

Single Cloudflare Worker (`src/worker.js`, ~1,950 lines) with:
- **Data flow:** FPL API → Worker → KV → Edge Cache → Client
- **Storage:** Cloudflare KV (`FPL_PULSE_KV` binding)
- **Schedule:** Hourly cron triggers harvest of all entries
- **Config:** `wrangler.toml` (v0.11, league 852082)
- **Logging:** Structured JSON logging for log aggregation

## KV Key Schema

```
season:<year>:bootstrap           # Game metadata + player info
season:<year>:elements            # Player scores by GW
entry:<id>:<season>               # Full season blob (picks, history, transfers)
entry:<id>:<season>:state         # State machine: queued|building|complete|errored|dead
league:<id>:members               # Array of entry IDs
snapshot:current                  # Last processed GW info
heartbeat:<iso-timestamp>         # Cron liveness marker
health:state_summary              # Precomputed entry state counts (updated hourly by cron)
config:detected_season            # Auto-detected season from FPL API (1h cache)
idempotency:<key>                 # Cached admin operation results (1h TTL)
```

## Entry State Machine

```
queued → building → complete    (success)
queued → building → errored     (failure)
errored → queued                (auto-retry after 1h, max 3 attempts)
errored → dead                  (after 3 failed attempts)
dead → queued                   (manual revive via /admin/dead/revive or /admin/entries/:id/revive)
errored → queued                (manual retry via admin)
building → queued               (60-min timeout reset)
```

## Admin Endpoints

All require authentication via `?token=<REFRESH_TOKEN>` or `X-Refresh-Token` header.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/admin/entries/states` | GET | List all entry states with pagination (`?status=`, `?cursor=`, `?limit=`) |
| `/admin/entries/states/bulk` | POST | Bulk actions (`{"action": "requeue"|"purge", "entry_ids": [...]}`) |
| `/admin/entries/dead` | GET | List all dead entries with error details |
| `/admin/entries/:entryId/revive` | POST | Revive a single dead/errored entry |
| `/admin/league/:leagueId/ingest` | POST | Ingest league members and enqueue new entries |
| `/admin/entry/:entryId/force-rebuild` | POST | Force full rebuild of entry blob |
| `/admin/entry/:entryId/purge-cache` | POST | Purge edge cache for entry |
| `/admin/entry/:entryId/enqueue` | POST | Manually enqueue single entry |
| `/admin/harvest?delay=N` | POST | Trigger gameweek harvest |
| `/admin/warm` | POST | Pre-warm cache |
| `/admin/circuit-breaker/reset` | POST | Reset API failure counter |
| `/admin/dead/revive` | POST | Re-queue all dead entries |
| `/admin/backfill?single=true&entry=N` | POST | Single entry sync test |
| `/admin/backfill?limit=N&leagueId=L` | POST | Batch process queued entries |

**Idempotency:** POST endpoints support `X-Idempotency-Key` header. Duplicate requests within 1h return cached response with `X-Idempotency-Cached: true`.

## Key Patterns

**Structured logging:** All logs output as JSON with `timestamp`, `level`, `component`, `event`, and contextual data.

**Season auto-detection:** Season is auto-detected from FPL API bootstrap and cached in KV. Falls back to `env.SEASON` if unavailable.

**Conditional refresh:** Check `*_last_refreshed_at` timestamps before fetching. Transfers: 6h threshold. Summaries: 12h threshold.

**Smart backfill:** Read existing blob, find `last_gw_processed`, only fetch GWs after that. Also backfills any gaps in earlier GWs.

**Dynamic cache:** Read bootstrap to check if current GW is active (`is_current && !finished`). Active: 6h s-maxage. Finished: 7d s-maxage.

**Circuit breaker:** In-memory counter. Opens at 15 failures, blocks fetches for 15 min. Decrements on success. 404s excluded. Resets on worker restart.

**Auto-retry:** Hourly cron re-queues errored entries after 1h cooldown, max 3 attempts, 5 per cycle.

**Health state precomputation:** `/health/detailed` uses precomputed state counts (updated hourly by cron) to avoid timeout on large datasets.

**Idempotency:** Admin POST endpoints check `X-Idempotency-Key` header. Cached results are returned for duplicate requests within 1h.

## Known Limitations

1. Circuit breaker resets on worker restart (stateless, acceptable at current scale)
2. Dynamic cache requires bootstrap KV read per entry request (edge-cached)

## Future Enhancements

- KV blob compression (gzip) if blobs grow large
- Split into read/write/cron workers at scale
- Durable Objects for atomic state transitions
- Cloudflare Queues to replace KV-based backfill queue
