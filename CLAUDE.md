# CLAUDE.md

Project context for AI-assisted development on the FPL Pulse Worker.

## Architecture

Cloudflare Worker split into layered ES modules:

```
worker.js (entry point)
  ├── routes/public.js  ──┐
  ├── routes/admin.js   ──┤
  │                       ├── services/entry.js   ──┐
  │                       ├── services/harvest.js ──┤
  │                       │                        ├── lib/kv.js
  │                       │                        ├── lib/fpl-api.js
  │                       │                        └── lib/utils.js
  │                       └────────────────────────────┘
```

- **Data flow:** FPL API → Worker → KV → Edge Cache → Client
- **Storage:** Cloudflare KV (`FPL_PULSE_KV` binding)
- **Schedule:** Hourly cron triggers harvest of all entries
- **Config:** `wrangler.toml` (v0.11, league 852082)
- **Logging:** Structured JSON logging for log aggregation
- **Tests:** Vitest (`npx vitest run`)

## File Structure

```
src/
├── worker.js              # Entry point: CORS, season resolution, route dispatch, cron
├── routes/
│   ├── public.js          # /health, /v1/*, /fpl/* proxy routes
│   └── admin.js           # /admin/* endpoints (auth, idempotency, CRUD)
├── services/
│   ├── entry.js           # processEntryOnce, processQueuedEntries, retryErroredEntries, updateHealthStateSummary
│   └── harvest.js         # Season detection, GW detection, harvest, warmCache
└── lib/
    ├── kv.js              # KV helpers, key builders, schema guards, cacheFirstKV
    ├── fpl-api.js         # Circuit breaker, fetchJson, fetchJsonWithRetry, fetchBootstrap
    └── utils.js           # CORS, json/text responses, cache headers, logger, idempotency
test/
├── helpers/mocks.js       # Shared KV mock + fetch mock factories
├── circuit-breaker.test.js
├── schema-guards.test.js
├── entry-processor.test.js
├── season.test.js
└── retry.test.js
```

## KV Key Schema

```
season:<year>:bootstrap           # Game metadata + player info
season:<year>:elements            # Player scores by GW
entry:<id>:<season>               # Full season blob (picks, history, transfers)
entry:<id>:<season>:state         # State machine: queued|building|complete|errored|dead
league:<id>:<season>:members      # Array of entry IDs (season-scoped — see below)
league:<id>:<season>:standings    # Archived FINAL classic standings (write-once when final). Full results[] + { season, harvested_at, member_count, final }
snapshot:current                  # Last processed GW info
heartbeat:<iso-timestamp>         # Cron liveness marker
health:state_summary              # Precomputed entry state counts (updated hourly by cron)
config:detected_season            # Auto-detected season from FPL API (1h cache)
cache:purge_queue                 # Pending edge-cache URLs to delete (queue drained by processPurgeQueue each cron cycle)
idempotency:<key>                 # Cached admin operation results (1h TTL)
```

## Seasons — read this before touching any key or read route

**FPL reassigns BOTH entry IDs and mini-league IDs every season**, in registration/creation
order. This is not a quirk to work around; it is the central constraint of the storage
model. Confirmed: the league "Dundanion Road" was ID `9385` in 2025/26 and `11556` in
2026/27, and `9385` in 2026/27 is a real, different league belonging to strangers.

Consequences that are easy to get wrong:

- **Every artefact key must carry a season.** An unscoped key silently addresses whichever
  league or entry now holds that ID.
- **Never scan for keys by ID alone.** A `*:members` scan that ignores the season will hand
  an old league ID to the live FPL API and write a stranger's data under your season. See
  the season predicate in `archiveAllLeagueStandings`.
- **Seasons are numeric everywhere** in storage and API (`2025`). The frontend renders
  `2025/26`; the Worker has no mapping layer.
- **The season goes in the URL PATH, never a query param.** `cacheKeyFor` strips the query
  string by default, so `?season=` would collide across seasons in the edge cache.

### Old-season keys are the ARCHIVE

Once a season closes, FPL destroys the source data — standings reset permanently, and IDs
are reassigned so nothing can be re-derived. Old-season keys are therefore the only copy.

`categorizeKey` (`routes/admin.js`) marks these `archival: true`, and
**`POST /admin/kv/cleanup` with `targets: ["old_season"]` refuses to delete them**,
reporting them under `protected`. Archival classes:

| Key | Why |
|---|---|
| `league:<id>:<season>:members` | Roster; unrecoverable once the ID is reassigned |
| `league:<id>:<season>:standings` | Final table; wiped by FPL at rollover |
| `season:<old>:bootstrap` | `dynamicCacheHeaders` resolves archived TTLs from it |
| `season:<old>:elements` | Served by `/v1/<season>/elements`; read directly by Wrapped |
| `entry:<id>:<old>` | Served by `/v1/<season>/entry/:id` and entries-pack |

`entry:<id>:<season>:state` is deliberately **not** archival. It is build scaffolding: no
read route serves it, and `public.js` consults it only when the blob is missing, where
`errored`/`dead`/`complete` all 404 exactly as an absent key does. At one state per entry
per season it is the bulk of the old-season namespace, so `old_season` still has real work.

> **For Stage 4 (cleanup-target rename).** With the guard in place, `old_season` now means
> "delete old seasons' build scaffolding" — which is not what the name says. That is the
> same objection that motivated the guard itself: two unlike intents sharing one target
> name, where `confirm_count` cannot tell them apart because the operator just types back
> whatever number the dry run produced. Renaming is Stage 4's call, deliberately not done
> here.

### Archive writes are provenance-gated

The live standings API only ever serves the **current** season. Archiving a past season
therefore fetches whatever league now holds that id — a different league belonging to
strangers — and would write it under the archived season's key, where the Stage 3 read
route serves it at 200 as an authoritative final table. A mistyped year was enough.

Before writing, `archiveLeagueStandings` compares the `entry` ids in the fetched table
against `league:<id>:<season>:members`, which records who was in that league that season:

- `overlap_ratio >= 0.5` (majority of the recorded roster still present), **or**
  `overlap >= 3` absolute — archive it
- otherwise refuse with `status: "refused"`, naming the overlap figures

The ratio's denominator is the **recorded roster**, not the fetched table, so a league that
gained members is not penalised for joiners. The absolute floor carries the opposite case —
a league that grew so much only a small fraction of the old roster remains. Both rules
require overlap > 0, so neither weakens the guard against the actual threat; they differ
only in tolerated churn. A tiny league churned below both (1 of 3 remaining) is what
`allow_unverified: true` is for — it overrides provenance only, not the write-once guard.

`final` is derived from the archived season's **stored** `season:<year>:bootstrap`, never
the live one, by checking that every event is `finished` and `data_checked`. A live
bootstrap describes whatever season FPL is currently serving, and stamping its finality
here is how a mid-season table acquires a permanent `final: true`. No stored bootstrap
means no evidence, which yields `false` — safe, since a non-final archive stays overwritable
and is never served at 200. This also removed the run's only live bootstrap fetch, so the
subrequest budget now starts at 0.

**Three guards, three different jobs — do not collapse them as redundant:**

| Guard | Protects against |
|---|---|
| ③ scan predicate (`archiveAllLeagueStandings`) | Picking up an old season's league id from a season-blind `*:members` scan. Filters *which leagues are attempted* |
| Provenance overlap (`archiveLeagueStandings`) | The fetched *table* belonging to a different league or season. Filters *what gets written* |
| Write-once `final` | A later run replacing a captured final table with a post-rollover reset one. Filters *overwrites* |

The ③ predicate does not help when a league is named explicitly via `leagueId`, which
bypasses the scan. Provenance does not help decide whether a table is final. Write-once does
not help the first write.

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

All require authentication via `X-Refresh-Token` header.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/admin/entries/states` | GET | List all entry states with pagination (`?status=`, `?cursor=`, `?limit=`) |
| `/admin/entries/states/bulk` | POST | Bulk actions (`{"action": "requeue"|"purge", "entry_ids": [...]}`) |
| `/admin/entries/dead` | GET | List all dead entries with error details |
| `/admin/entries/:entryId/revive` | POST | Revive a single dead/errored entry |
| `/admin/league/:leagueId/ingest` | POST | Ingest league members and enqueue new entries |
| `/admin/standings/archive` | POST | Archive FINAL classic standings for all tracked leagues to write-once KV. Body `{ season, force?, leagueId?, allow_unverified? }`. **Provenance-gated** (see Seasons); `final` derived from the archived season's stored bootstrap; never overwrites a final table unless `force`. Subrequest-budget bounded — re-invoke until `remaining` is empty |
| `/admin/entry/:entryId/force-rebuild` | POST | Force full rebuild of entry blob |
| `/admin/entry/:entryId/purge-cache` | POST | Purge edge cache for entry |
| `/admin/entry/:entryId/enqueue` | POST | Manually enqueue single entry |
| `/admin/harvest?delay=N` | POST | Trigger gameweek harvest |
| `/admin/warm` | POST | Pre-warm cache |
| `/admin/circuit-breaker/reset` | POST | Reset API failure counter |
| `/admin/dead/revive` | POST | Re-queue all dead entries |
| `/admin/backfill?single=true&entry=N` | POST | Single entry sync test |
| `/admin/backfill?limit=N&leagueId=L` | POST | Batch process queued entries |
| `/admin/kv/audit` | GET | Full KV namespace audit with categorization and issue detection. `issues.old_season_keys` are deletable; `issues.archival_keys` are refused by cleanup |
| `/admin/kv/cleanup` | POST | Targeted KV cleanup (`{"dry_run": true, "targets": ["old_season"\|"orphaned_entries"], "confirm_count": N}`). **Refuses archival keys** — see Seasons above |
| `/admin/kv/migrate-members` | POST | One-off copy of legacy `league:<id>:members` → `league:<id>:<season>:members`. `season` required (never defaulted), `dry_run` default true, **copies without deleting**. Blocks any key with no entry-blob or entry-state footprint in the season being stamped; `allow_unverified: true` overrides |

**Idempotency:** POST endpoints support `X-Idempotency-Key` header. Duplicate requests within 1h return cached response with `X-Idempotency-Cached: true`.

## Key Patterns

**Structured logging:** All logs output as JSON with `timestamp`, `level`, `component`, `event`, and contextual data.

**Season auto-detection:** three tiers — KV detection cache (1h) → live FPL API → `fallbackSeason()` in `lib/utils.js`.

`fallbackSeason()` is **derived from the current date**, not a literal: Aug–Dec → this year, Jan–Jul → last year, the same August boundary `detectSeasonFromAPI` applies to a gameweek deadline. A hardcoded year is wrong from the moment someone forgets to bump it; the derivation is wrong only in the July changeover window, when FPL's API has usually flipped to the coming season while this still reports the one just finished. That is the conservative direction — the older season's keys definitely exist, so reads resolve instead of 404ing across the board. Both behaviours are pinned by tests.

**`env.SEASON` is an intentional escape hatch — do not delete the read as dead code.** It is deliberately unset in `wrangler.toml` (a literal there would be a second copy going stale every August) but is still honoured if present, and `wrangler.toml` carries a commented-out line documenting it. Reach for it when detection is actively **wrong** rather than merely unavailable — e.g. FPL's preseason bootstrap reports an odd first-event deadline and the Worker starts addressing the wrong season's keys. Setting the var in the Cloudflare dashboard pins the season in seconds; the alternative is a code deploy mid-incident. Unset it once detection recovers.

**Season-scoped read routes:** every `/v1` artefact is reachable two ways — `/v1/<artefact>` (the detected season) and `/v1/<year>/<artefact>` (explicit, including closed seasons):

```
/v1/<year>/entry/:id               /v1/<year>/bootstrap
/v1/<year>/league/:id/members      /v1/<year>/elements
/v1/<year>/league/:id/entries-pack
/v1/<year>/league/:id/standings    # archived final table — see below
```

Dispatch ordering in `public.js` is **load-bearing**. `/v1/season/bootstrap` and `/v1/season/elements` put the literal word `season` in the same positional slot the year occupies, so `/v1/season/elements` and `/v1/2025/elements` are structurally identical — three segments, same shape. They only fail to collide because `season` is not digits. The prefix matcher therefore requires an all-digit segment, and the token is validated by `parseSeasonToken`'s `/^\d{4}$/` — never a bare `Number()`, which also accepts `" 2025"`, `"2025.0"` and `"2e3"` and would then build a KV key that silently addresses nothing. Range: 2016 → current year + 1. A purely numeric segment can only be a season attempt, so a malformed one is a 400, not a 404.

The three global routes go through `cacheFirstKV`, which applies a flat 7-day `cacheHeaders()` rather than `dynamicCacheHeaders`. For a closed season that is conservative in the harmless direction (7d instead of the 30d the end-of-season branch would give). Noted so it isn't mistaken for a bug.

**Standings route serves FINAL tables only.** `isLeagueStandings` requires `final` to be a *boolean*, not to be `true` — a provisional capture validates exactly like a completed one, and `archiveLeagueStandings` writes a fresh provisional table on every run between the last gameweek and FPL's rollover. So the route carries its own `final === true` check on top of the guard:

| State | Response |
|---|---|
| Archive exists, `final: true` | **200** with the full untrimmed table; cached |
| Archive exists, `final: false` | **202** `{status: "provisional"}`, ranks withheld; **not** cached |
| No archive | **404** |
| Blob fails the schema guard | **422** |

202 rather than 404 or 422: 404 would claim nothing exists, leaving the frontend's season dropdown unable to tell "never archived" from "still settling"; 422 is this codebase's "stored blob is wrong". 202 already means "being built, come back later" on `/v1/entry/:id` and the entries-pack, which is precisely what a provisional archive is. A HEAD probe gets the whole three-way answer from the status alone.

No `MAX_LEAGUE_SIZE` gate here — the archive is capture-maximal by design and stores tables past 50 members (AE64 has 64). Applying the friends-only read policy would make that league's archive unreadable.

**entries-pack empty-league guard:** a non-empty roster resolving **zero** blobs is never a 200 — the frontend accepts `{members: [...], entries: {}}` and renders a blank league, turning a data fault into a silently empty page. *Some* blobs missing is legitimate (a new joiner not yet built) and stays a 200 with those members omitted from `entries`. Zero blobs → **202** when any member's state is `queued`/`building` (a freshly ingested live league), else **422** (season/league mismatch, or a wiped season). Neither is written to the edge cache: `cacheKeyFor` forces `method: "GET"`, so HEAD and GET share one entry and a cached error would pin the fault for both probes.

**Conditional refresh:** Check `*_last_refreshed_at` timestamps before fetching. Transfers: 6h threshold. Summaries: 12h threshold.

**Smart backfill:** Read existing blob, find `last_gw_processed`, only fetch GWs after that. Also backfills any gaps in earlier GWs.

**Dynamic cache:** TTL depends on GW phase. Active GW (`is_current && !finished`): 7d. Between GWs (no active GW): time until next GW's `deadline_time` from KV bootstrap. End of season: 30d. TTLs act as safety nets; the purge queue system ensures fresh data after each harvest.

**Cache invalidation after harvest (queue-based):** After a successful harvest (`status: "ok"`), the cron calls `warmCache`, which does **zero** cache operations — it only builds a prioritised URL list and writes it to `cache:purge_queue` in KV. Then `processPurgeQueue` (which also runs at the **start** of every cron cycle) drains the queue in batches of 45 `cache.delete()` calls, staying well under Cloudflare's 50-subrequest limit. Priority order: globals → per-league → individual entries. A large queue completes across successive cron cycles.

**Both addressing forms are purged.** Edge cache keys are path-only, so `/v1/entry/5` and `/v1/2026/entry/5` are separate entries; purging one leaves the other serving stale data behind an `X-Cache: HIT` for the full TTL — up to 7 days during an active GW, which is only safe *because* explicit purge is the real invalidation mechanism. `warmCache` queues both forms, and the three admin purge routes (`entry/:id/purge-cache`, `league/:id/purge-cache`, `entry/:id/force-rebuild`) delete both. Prefixed URLs are queued for the **current season only** — closed seasons never change, so purging them is pure budget waste.

Cost: for the current scale (4 leagues, ~36 entries) the queue goes from 51 to 97 items, draining in 3 cron cycles instead of 2. Nothing overflows — each invocation still spends at most `PURGE_BATCH_SIZE` — but the stale window after a harvest roughly doubles. At 8 leagues / ~100 entries it is 127 → 245 items, 3 → 6 cycles.

### Retiring the legacy unprefixed URLs — concrete exit

The doubled queue is transitional, not permanent. Without a written trigger it becomes permanent by default, so:

**Trigger — all three must hold:**
1. The frontend deployed at `cbrennan.ie/fpl-pulse` requests every `/v1` artefact with an explicit season (`src/utils/api.js` contains no `/v1/entry/`, `/v1/league/`, `/v1/season/` string without a season segment).
2. `league:<id>:members` legacy keys have been deleted — the members migration is fully complete, so nothing can still be reading the old shape.
3. **Zero unprefixed `/v1` hits observed for 30 consecutive days**, covering at least two full harvest cycles and any cached SPA bundle still live in a user's browser. 30 days is chosen for the stale-bundle case: a user who has not reloaded still runs the old JS, and their requests are the real risk.

**How to verify (3).** There is no per-path request telemetry today — Workers' default analytics does not break down by path without Logpush or Analytics Engine. Do not guess from deploy dates. Add one line to each unprefixed branch in `public.js`:

```js
log.warn("public", "legacy_unprefixed_request", { path, ua: request.headers.get("user-agent") });
```

deploy, and watch `wrangler tail` / the Workers logs. The count must reach zero and stay there for the full 30 days before anything is deleted. This log line is itself part of the retirement work — it does not exist yet, deliberately, because it would be noise until the migration is underway.

**What gets deleted, in this order** (each step is independently safe and reversible):
1. `warmCache` — the legacy half of each URL pair (`harvest.js`). Queue returns to ~51 items. Purely an optimisation; no route changes.
2. `v1CacheUrls` in `admin.js` — drop the unprefixed entry from the returned pair, and the `/v1/season/elements` purge in the elements backfill.
3. `public.js` — the unprefixed branches themselves, making the season prefix mandatory. This is the only breaking step: `/v1/entry/:id`, `/v1/league/:id/members`, `/v1/league/:id/entries-pack`, `/v1/season/elements` and `/v1/season/bootstrap` all begin returning 404. The `v1Path` normalisation collapses to a plain match once there is nothing to rewrite *to*.
4. The `legacy_unprefixed_request` log line added for verification.

Step 3 is what reclaims the complexity; steps 1–2 reclaim the budget. They can be done in separate deploys, and doing 1–2 alone is a legitimate stopping point if the frontend migration stalls.

**warmCache discovers leagues dynamically:** Scans KV for all `league:*:members` keys — no config needed when adding new leagues. Deduplicates entry IDs, and league IDs (one league can surface under both a legacy and a season-scoped key mid-migration). `/fpl/league/:id` standings are edge-cached (explicit `cache.put()`) so they are purgeable by `processPurgeQueue`.

**KNOWN ISSUE — warmCache's scan is season-blind.** It matches every `*:members` key regardless of season, so after a rollover it warms previous-season league and entry IDs against current-season URLs. Wasteful and log-noisy, **not incorrect**: purging a URL that holds nothing is a no-op, and unlike `archiveAllLeagueStandings` it makes no live FPL API call with the stale ID. Deliberately left alone; the fix belongs with a wider warmCache rework. Do not confuse this with the season predicate in `archiveAllLeagueStandings`, which is load-bearing — see Seasons above.

**Subrequest budget:** Cloudflare Standard plan: 50 subrequests per invocation. `cache.delete()`, `cache.match()`, `cache.put()`, and `fetch()` all count. KV operations do **not**. `PURGE_BATCH_SIZE = 45` leaves 5 headroom.

**Circuit breaker:** In-memory counter. Opens at 15 failures, blocks fetches for 15 min. Decrements on success. 404s excluded. Resets on worker restart.

**Auto-process queued:** Hourly cron builds freshly ingested entries (max 5 per cycle) via `processQueuedEntries`.

**Auto-retry:** Hourly cron re-queues errored entries after 1h cooldown, max 3 attempts, 5 per cycle.

**Health state precomputation:** `/health/detailed` uses precomputed state counts (updated hourly by cron) to avoid timeout on large datasets.

**Idempotency:** Admin POST endpoints check `X-Idempotency-Key` header. Cached results are returned for duplicate requests within 1h.

## Commands

```bash
npx vitest run          # Run test suite (172 tests)
npx wrangler dev        # Local development server
npx wrangler deploy     # Deploy to Cloudflare
```

## Rejected approaches

Recorded so they are not re-proposed. Each was argued for and turned down for a concrete reason.

**Season-equality check for archive writes** (`season !== getEffectiveSeason(env)` → refuse).
Rejected twice. `getEffectiveSeason` derives the season from `events[0].deadline_time`, so
when FPL publishes the new fixture list in mid-July detection flips to the new season while
classic standings still serve the old one — the exact window the archive exists to exploit,
refused precisely when the data is still retrievable. **Instead:** provenance overlap against
the members key, which is correct everywhere equality is, plus that window.

**`?season=` as a query parameter.** `cacheKeyFor` strips the query string by default and no
caller passes `keepQuery`, so every season would collide on one edge cache entry and serve
whichever season was fetched first. **Instead:** the season lives in the URL path
(`/v1/<year>/…`), giving each season its own cache key.

**Ratio-only gate for the members migration.** A pure blob-ratio threshold refuses a league
ingested this week — it legitimately has zero built blobs — which is precisely the most
current data. **Instead:** check `entry:<id>:<season>:state` as well, so "no blobs because
wrong season" (no states either) is separable from "no blobs because not built yet".

## Known Limitations

1. Circuit breaker resets on worker restart (stateless, acceptable at current scale)
2. Dynamic cache requires bootstrap KV read per entry request (edge-cached)

## Future Enhancements

- KV blob compression (gzip) if blobs grow large
- Split into read/write/cron workers at scale
- Durable Objects for atomic state transitions
- Cloudflare Queues to replace KV-based backfill queue
