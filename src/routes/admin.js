import { json, log, cacheKeyFor, checkIdempotencyKey, storeIdempotencyResult, fallbackSeason, parseSeasonToken, MIN_SEASON, maxSeason } from '../lib/utils.js';
import { kvGetJSON, kvPutJSON, kEntryState, kEntrySeason, kLeagueMembers, kDetectedSeason, kSeasonClosed, isLeagueMembers, MAX_LEAGUE_SIZE } from '../lib/kv.js';
import { fetchJson, fetchBootstrap, circuitBreaker, sleep } from '../lib/fpl-api.js';
import { processEntryOnce } from '../services/entry.js';
import { harvestIfNeeded, warmCache, processPurgeQueue, backfillSeasonElements, detectLatestFinishedGW, archiveAllLeagueStandings } from '../services/harvest.js';

// Both edge-cache addressing forms of a /v1 artefact. Cache keys are path-only, so the
// legacy unprefixed URL and the season-prefixed URL are separate entries and a purge
// that names only one leaves the other serving stale data. `suffix` is the artefact
// path after /v1, e.g. "/entry/123" or "/league/9/entries-pack".
const v1CacheUrls = (origin, season, suffix) => [
  `${origin}/v1${suffix}`,
  `${origin}/v1/${season}${suffix}`,
];

// Admin endpoints that WRITE season-scoped data, and are therefore refused once the
// season is closed. Listed centrally rather than checked in eight handlers so the set is
// auditable in one place — the risk with per-handler checks is the one that gets missed.
//
// Deliberately ABSENT: /admin/standings/archive (the archive's whole purpose is to run
// after close, in the window before FPL's rollover — its write-once `final` guard is the
// right protection there, not this one), the read-only GETs, the cache-only purge routes,
// /admin/kv/* (operates across seasons and has its own guards), and the close/reopen pair
// below, which must obviously remain reachable on a closed season.
//
// /admin/entries/states/bulk covers BOTH its actions: `purge` deletes the entry blob,
// which for a closed season destroys the archive outright — a stronger reason to refuse
// than the write actions, not a weaker one.
function isSeasonWritePath(path) {
  if (path === "/admin/entries/states/bulk") return true;
  if (path === "/admin/dead/revive") return true;
  if (path === "/admin/backfill") return true;
  if (path === "/admin/season/elements/backfill") return true;
  if (/^\/admin\/entries\/\d+\/revive$/.test(path)) return true;
  if (/^\/admin\/entry\/\d+\/(force-rebuild|enqueue)$/.test(path)) return true;
  if (/^\/admin\/league\/\d+\/ingest$/.test(path)) return true;
  return false;
}

// === KV audit helpers ===

// Categorize a raw KV key name into a known type.
//
// `archival: true` marks a key that IS the archive rather than debris: data FPL has
// destroyed at its source and that a season-scoped read route serves. Bulk cleanup
// targets must refuse these — see the old_season guard in /admin/kv/cleanup.
function categorizeKey(keyName, currentSeason) {
  if (keyName.startsWith("heartbeat:")) return { type: "heartbeat" };
  if (keyName.startsWith("idempotency:")) return { type: "idempotency" };
  if (keyName === "config:detected_season") return { type: "config" };
  if (keyName === "health:state_summary") return { type: "health" };
  if (keyName === "snapshot:current") return { type: "snapshot" };
  if (keyName === "cache:purge_queue") return { type: "cache_queue" };

  const seasonBoot = keyName.match(/^season:(\d+):bootstrap$/);
  if (seasonBoot) {
    const s = Number(seasonBoot[1]);
    // An old season's bootstrap is load-bearing for reads of that season: it is what
    // dynamicCacheHeaders resolves a TTL from. Deleting it degrades archived reads.
    return { type: "season_bootstrap", season: s, is_current: s === currentSeason, archival: s !== currentSeason };
  }
  const seasonElem = keyName.match(/^season:(\d+):elements$/);
  if (seasonElem) {
    const s = Number(seasonElem[1]);
    // Served by /v1/<season>/elements and read directly by the Wrapped beats. FPL's
    // event/<gw>/live endpoints do not survive the rollover, so this is unrebuildable.
    return { type: "season_elements", season: s, is_current: s === currentSeason, archival: s !== currentSeason };
  }

  // entry:<id>:<season>:state must be checked before entry:<id>:<season>
  //
  // NOT archival, deliberately. State is build scaffolding: no read route serves it,
  // and public.js consults it only when the blob is missing — where `errored`, `dead`
  // and `complete` all 404 exactly as an absent key does. Deleting an old season's
  // state is behaviourally invisible, and at one state per entry per season it is the
  // bulk of the old-season namespace, so `old_season` keeps a real job to do.
  const entryState = keyName.match(/^entry:(\d+):(\d+):state$/);
  if (entryState) {
    const s = Number(entryState[2]);
    return { type: "entry_state", entry_id: Number(entryState[1]), season: s, is_current: s === currentSeason };
  }
  // The blob itself IS the archive — served by /v1/<season>/entry/:id and the
  // entries-pack, and unrebuildable once FPL reassigns the entry ID.
  const entryBlob = keyName.match(/^entry:(\d+):(\d+)$/);
  if (entryBlob) {
    const s = Number(entryBlob[2]);
    return { type: "entry_blob", entry_id: Number(entryBlob[1]), season: s, is_current: s === currentSeason, archival: s !== currentSeason };
  }

  // league:<id>:<season>:members — the roster. Archive: FPL reassigns league IDs
  // each season, so an old season's roster cannot be re-derived from the live API.
  const leagueMembers = keyName.match(/^league:(\d+):(\d+):members$/);
  if (leagueMembers) {
    const s = Number(leagueMembers[2]);
    return {
      type: "league_members", league_id: Number(leagueMembers[1]),
      season: s, is_current: s === currentSeason, archival: true,
    };
  }

  // Pre-migration unscoped form. Kept as its own type (not "unknown") so an audit
  // shows at a glance how many legacy keys are still awaiting deletion.
  const legacyLeagueMembers = keyName.match(/^league:(\d+):members$/);
  if (legacyLeagueMembers) {
    return { type: "league_members_legacy", league_id: Number(legacyLeagueMembers[1]), archival: true };
  }

  // league:<id>:<season>:standings — final table, unrecoverable after FPL's rollover.
  const leagueStandings = keyName.match(/^league:(\d+):(\d+):standings$/);
  if (leagueStandings) {
    const s = Number(leagueStandings[2]);
    return {
      type: "league_standings", league_id: Number(leagueStandings[1]),
      season: s, is_current: s === currentSeason, archival: true,
    };
  }

  // The immutability marker itself. Archival: deleting it silently reopens the season.
  // Note it carries no `is_current`, so cleanup's season targets never select it.
  const seasonClosedMarker = keyName.match(/^season:(\d+):closed$/);
  if (seasonClosedMarker) {
    return { type: "season_closed_marker", season: Number(seasonClosedMarker[1]), archival: true };
  }

  return { type: "unknown" };
}

// Which seasons are recorded closed, read straight off the key listing the caller already
// has. No extra KV reads: the markers are ordinary keys in the namespace.
function closedSeasonsFrom(allKeys) {
  const closed = new Set();
  for (const name of allKeys) {
    const m = name.match(/^season:(\d+):closed$/);
    if (m) closed.add(Number(m[1]));
  }
  return closed;
}

// List every key in the namespace (cursor-paginated, single call for <1000 keys)
async function listAllKeys(kv) {
  const keys = [];
  let cursor;
  do {
    const page = await kv.list({ cursor, limit: 1000 });
    cursor = page.cursor;
    for (const k of page.keys) keys.push(k.name);
  } while (cursor);
  return keys;
}

// === Admin auth helper ===
// Accepts X-Refresh-Token header and compares to env.REFRESH_TOKEN
const isAuthorized = (request, env) => {
  const token = request.headers.get("x-refresh-token");
  return Boolean(token && token === env.REFRESH_TOKEN);
};

// Handles all admin routes. Returns a Response or null (no match).
export async function handleAdminRoute(request, env, season) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (!path.startsWith("/admin/")) return null;

  // Allow GET for specific read-only admin endpoints
  const isGetAllowed = path === "/admin/entries/states" || path === "/admin/entries/dead" || path === "/admin/kv/audit";
  if (request.method !== "POST" && !(request.method === "GET" && isGetAllowed)) {
    return json({ error: "Method not allowed" }, 405);
  }
  if (!isAuthorized(request, env)) return json({ error: "Unauthorized" }, 401);

  // Season immutability gate. Fails fast and VISIBLY — unlike the cron paths, which no-op
  // quietly, an operator issuing a write deserves to be told why it did nothing and how to
  // proceed. 409 Conflict: the request is well-formed but conflicts with the season's
  // recorded state.
  if (isSeasonWritePath(path)) {
    const marker = await kvGetJSON(env.FPL_PULSE_KV, kSeasonClosed(season));
    if (marker) {
      return json({
        error: "season_closed",
        message: `Season ${season} is closed and immutable. If this is a deliberate repair, reopen it with POST /admin/season/${season}/reopen, make the change, then re-close with POST /admin/season/${season}/close.`,
        season,
        closed_at: marker.closed_at ?? null,
        final_gw: marker.final_gw ?? null,
      }, 409);
    }
  }

  // Check for idempotency key (for POST requests only)
  const idempotencyKey = request.method === "POST" ? request.headers.get("X-Idempotency-Key") : null;
  if (idempotencyKey) {
    const cached = await checkIdempotencyKey(env, idempotencyKey);
    if (cached) {
      log.info("admin", "idempotency_cache_hit", {
        key: idempotencyKey,
        path,
        original_completed_at: cached.completed_at
      });
      return json(
        { ...cached.result, _idempotency: { cached: true, original_completed_at: cached.completed_at } },
        cached.status,
        { "X-Idempotency-Cached": "true" }
      );
    }
  }

  // POST /admin/season/:year/close | /admin/season/:year/reopen
  //
  // The manual counterparts to the automatic close in harvestIfNeeded. Both exist because
  // a reopen without a matching close would leave the season permanently mutable, which is
  // a worse state than the one being repaired.
  //
  // `close` also covers the season that never completes on its own (see CLAUDE.md): FPL
  // curtailed 2019/20, and a curtailed or reshaped event list means the automatic trigger
  // never fires. Staying open is the safe default; this is the deliberate way out of it.
  //
  // Both require `confirm_season` echoed in the body. Reopen logs at WARN — it overrides a
  // data-integrity guard and should surface in any log search for anomalies.
  const seasonLifecycle = path.match(/^\/admin\/season\/(\d+)\/(close|reopen)$/);
  if (seasonLifecycle && request.method === "POST") {
    const targetSeason = parseSeasonToken(seasonLifecycle[1]);
    if (targetSeason === null) {
      return json({
        error: "invalid_season",
        message: `Season must be a 4-digit year between ${MIN_SEASON} and ${maxSeason()} (e.g. 2025).`,
      }, 400);
    }
    const action = seasonLifecycle[2];

    let body = {};
    try {
      const raw = await request.text();
      if (raw) body = JSON.parse(raw);
    } catch {
      return json({ error: "invalid_json_body" }, 400);
    }
    if (Number(body.confirm_season) !== targetSeason) {
      return json({
        error: "confirm_season_required",
        message: `Body must include "confirm_season": ${targetSeason} to ${action} that season.`,
      }, 409);
    }

    const key = kSeasonClosed(targetSeason);
    const existing = await kvGetJSON(env.FPL_PULSE_KV, key);

    if (action === "close") {
      if (existing) {
        return json({ ok: true, status: "already_closed", season: targetSeason, ...existing }, 200);
      }
      const marker = {
        closed_at: new Date().toISOString(),
        final_gw: Number.isInteger(Number(body.final_gw)) ? Number(body.final_gw) : null,
        closed_by: "admin",
      };
      await kvPutJSON(env.FPL_PULSE_KV, key, marker);
      log.info("season", "closed", { season: targetSeason, source: "admin", final_gw: marker.final_gw });
      const closeResult = { ok: true, status: "closed", season: targetSeason, ...marker };
      if (idempotencyKey) await storeIdempotencyResult(env, idempotencyKey, closeResult, 200);
      return json(closeResult, 200);
    }

    if (!existing) {
      return json({ ok: true, status: "already_open", season: targetSeason }, 200);
    }
    await env.FPL_PULSE_KV.delete(key);
    log.warn("season", "reopened", {
      season: targetSeason,
      was_closed_at: existing.closed_at ?? null,
      note: "season immutability overridden — writes to this season are now permitted",
    });
    const reopenResult = {
      ok: true,
      status: "reopened",
      season: targetSeason,
      was_closed_at: existing.closed_at ?? null,
      warning: "Writes to this season are now permitted. Re-close it once the repair is complete.",
    };
    if (idempotencyKey) await storeIdempotencyResult(env, idempotencyKey, reopenResult, 200);
    return json(reopenResult, 200);
  }

  // GET /admin/entries/states — List all entry states with pagination and filtering
  if (path === "/admin/entries/states" && request.method === "GET") {
    log.info("admin", "endpoint_invoked", { path, method: "GET" });

    const u = new URL(request.url);
    const statusFilter = u.searchParams.get("status"); // queued|building|complete|errored|dead
    const cursorParam = u.searchParams.get("cursor"); // base64-encoded cursor
    const limitParam = Math.min(100, Math.max(1, Number(u.searchParams.get("limit") || 50)));

    const validStatuses = ["queued", "building", "complete", "errored", "dead"];
    if (statusFilter && !validStatuses.includes(statusFilter)) {
      return json({ error: "Invalid status filter", valid: validStatuses }, 400);
    }

    // Decode cursor
    let kvCursor = cursorParam ? atob(cursorParam) : undefined;

    const entries = [];
    let scannedKeys = 0;
    const maxScan = 500; // Safety limit per request

    do {
      const page = await env.FPL_PULSE_KV.list({
        prefix: "entry:",
        cursor: kvCursor,
        limit: 100
      });
      kvCursor = page.cursor;

      for (const k of page.keys) {
        if (!k.name.endsWith(`:${season}:state`)) continue;
        scannedKeys++;

        const entryId = Number(k.name.split(":")[1]);
        if (!Number.isInteger(entryId)) continue;

        const state = await kvGetJSON(env.FPL_PULSE_KV, k.name);
        if (!state) continue;

        // Apply status filter
        if (statusFilter && state.status !== statusFilter) continue;

        entries.push({
          entry_id: entryId,
          status: state.status,
          attempts: state.attempts || 0,
          error: state.error || null,
          last_gw_processed: state.last_gw_processed || 0,
          updated_at: state.updated_at || null,
        });

        if (entries.length >= limitParam) break;
      }

      if (entries.length >= limitParam || scannedKeys >= maxScan) break;
    } while (kvCursor);

    // Build next cursor
    const nextCursor = kvCursor ? btoa(kvCursor) : null;

    return json({
      entries,
      pagination: {
        count: entries.length,
        limit: limitParam,
        next_cursor: nextCursor,
        has_more: !!nextCursor,
      },
      filter: {
        status: statusFilter || "all",
        season,
      },
    });
  }

  // GET /admin/entries/dead — List all dead entries with error details
  if (path === "/admin/entries/dead" && request.method === "GET") {
    log.info("admin", "endpoint_invoked", { path, method: "GET" });

    const deadEntries = [];
    let cursor;

    do {
      const page = await env.FPL_PULSE_KV.list({ prefix: "entry:", cursor, limit: 100 });
      cursor = page.cursor;

      for (const k of page.keys) {
        if (!k.name.endsWith(`:${season}:state`)) continue;

        const entryId = Number(k.name.split(":")[1]);
        if (!Number.isInteger(entryId)) continue;

        const state = await kvGetJSON(env.FPL_PULSE_KV, k.name);
        if (state?.status !== "dead") continue;

        deadEntries.push({
          entry_id: entryId,
          error: state.error || "Unknown error",
          attempts: state.attempts || 0,
          updated_at: state.updated_at || null,
          last_gw_processed: state.last_gw_processed || 0,
        });
      }

      // Cap at 500 to prevent timeout
      if (deadEntries.length >= 500) break;
    } while (cursor);

    return json({
      count: deadEntries.length,
      entries: deadEntries,
      season,
    });
  }

  // GET /admin/kv/audit — Full KV namespace audit with categorization and issue detection
  if (path === "/admin/kv/audit" && request.method === "GET") {
    log.info("admin", "endpoint_invoked", { path, method: "GET" });

    // Detect current season
    const detected = await kvGetJSON(env.FPL_PULSE_KV, kDetectedSeason);
    const currentSeason = detected?.season ?? Number(env.SEASON || fallbackSeason());

    // Load league members for orphan detection
    const leagueId = new URL(request.url).searchParams.get("league_id") || env.WARM_LEAGUE_ID;
    const members = leagueId ? await kvGetJSON(env.FPL_PULSE_KV, kLeagueMembers(leagueId, currentSeason)) : null;
    const memberSet = Array.isArray(members) ? new Set(members) : null;

    // List and categorize all keys
    const allKeys = await listAllKeys(env.FPL_PULSE_KV);
    const categories = {};
    const oldSeasonKeys = [];
    const archivalKeys = [];
    const orphanedEntries = new Map(); // entry_id -> [key names]
    const unknownKeys = [];

    for (const keyName of allKeys) {
      const cat = categorizeKey(keyName, currentSeason);

      // Aggregate counts
      if (!categories[cat.type]) categories[cat.type] = { count: 0, current_season: 0, old_season: 0, old_seasons: [] };
      categories[cat.type].count++;

      if ("is_current" in cat) {
        if (cat.is_current) {
          categories[cat.type].current_season++;
        } else {
          categories[cat.type].old_season++;
          if (cat.season && !categories[cat.type].old_seasons.includes(cat.season)) {
            categories[cat.type].old_seasons.push(cat.season);
          }
          // Split the list by what cleanup will actually do: archival keys are
          // refused by the old_season target, so listing them as deletion
          // candidates would misrepresent the next operation.
          if (cat.archival) archivalKeys.push(keyName);
          else oldSeasonKeys.push(keyName);
        }
      }

      // Orphan detection: current-season entries not in the league
      if (memberSet && cat.is_current && cat.entry_id && !memberSet.has(cat.entry_id)) {
        const existing = orphanedEntries.get(cat.entry_id) || [];
        existing.push(keyName);
        orphanedEntries.set(cat.entry_id, existing);
      }

      if (cat.type === "unknown") unknownKeys.push(keyName);
    }

    // Clean up categories that don't need season fields
    for (const [, data] of Object.entries(categories)) {
      if (data.current_season === 0 && data.old_season === 0) {
        delete data.current_season;
        delete data.old_season;
        delete data.old_seasons;
      }
      if (data.old_seasons?.length === 0) delete data.old_seasons;
    }

    // Closed state per season. `/admin/kv/cleanup`'s closed_season target keys off this,
    // so an operator can see before running it which seasons are eligible — and spot a
    // season that never closed (a curtailed or reshaped one) rather than wondering why
    // its keys are never offered.
    const closedSeasons = closedSeasonsFrom(allKeys);
    const seasonsSeen = new Set();
    for (const keyName of allKeys) {
      const s = categorizeKey(keyName, currentSeason).season;
      if (Number.isInteger(s)) seasonsSeen.add(s);
    }
    const seasons = {};
    for (const s of [...seasonsSeen].sort()) {
      const isClosed = closedSeasons.has(s);
      const marker = isClosed ? await kvGetJSON(env.FPL_PULSE_KV, kSeasonClosed(s)) : null;
      seasons[s] = {
        closed: isClosed,
        is_current: s === currentSeason,
        closed_at: marker?.closed_at ?? null,
        final_gw: marker?.final_gw ?? null,
      };
    }

    return json({
      total_keys: allKeys.length,
      current_season: currentSeason,
      league_id: leagueId ? Number(leagueId) : null,
      seasons,
      categories,
      issues: {
        old_season_keys: oldSeasonKeys,
        // Old-season keys that /admin/kv/cleanup will REFUSE to delete — the archive.
        archival_keys: archivalKeys,
        orphaned_entries: [...orphanedEntries.entries()].map(([id, keys]) => ({ entry_id: id, keys })),
        unknown_keys: unknownKeys,
      },
      cron_coverage: {
        automatically_maintained: [
          "heartbeat:* (written hourly, 1h TTL — auto-expires)",
          "health:state_summary (overwritten hourly by updateHealthStateSummary)",
          "season:<current>:bootstrap (updated when new GW finishes)",
          "season:<current>:elements (updated when new GW finishes)",
          "entry:*:<current> blobs (updated when new GW finishes)",
          "entry:*:<current>:state (retried hourly for errored entries)",
          "snapshot:current (updated when new GW finishes)",
        ],
        requires_manual_management: [
          "league:*:<season>:members (only updated via /admin/league/:id/ingest)",
          "league:*:<season>:standings (only written by /admin/standings/archive)",
          "config:detected_season (updated on request, 1h freshness check)",
          "Old season keys — never cleaned up automatically; archival ones are undeletable by /admin/kv/cleanup",
          "Orphaned entries (removed from league) — never cleaned up automatically",
        ],
      },
    });
  }

  // POST /admin/kv/cleanup — Targeted KV cleanup with dry-run and confirm_count safeguards
  if (path === "/admin/kv/cleanup" && request.method === "POST") {
    log.info("admin", "endpoint_invoked", { path, method: "POST" });

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    const dryRun = body.dry_run !== false; // default true
    const targets = body.targets;
    const confirmCount = body.confirm_count;

    // `old_season` was a guess from recency — "not the season we currently detect".
    // `closed_season` is a recorded fact: the season carries a season:<year>:closed marker.
    // The alias is accepted rather than broken because the semantic change is strictly
    // NARROWING — a closed season is always also an old one, so no existing script can be
    // made to delete something it would not have deleted before. A hard break would only
    // produce a confusing 400 for no safety gain.
    const TARGET_ALIASES = { old_season: "closed_season" };
    const validTargets = ["closed_season", "orphaned_entries"];
    if (!Array.isArray(targets) || targets.length === 0) {
      return json({ error: "targets must be a non-empty array", valid: validTargets }, 400);
    }
    const deprecations = [];
    const resolvedTargets = [];
    for (const t of targets) {
      const resolved = TARGET_ALIASES[t] ?? t;
      if (!validTargets.includes(resolved)) {
        return json({ error: `Invalid target: ${t}`, valid: validTargets }, 400);
      }
      if (TARGET_ALIASES[t]) {
        deprecations.push(`target "${t}" is deprecated; use "${resolved}". It now deletes only keys of a season with a recorded close marker, which is stricter than before.`);
        log.warn("admin", "deprecated_cleanup_target", { target: t, resolved });
      }
      resolvedTargets.push(resolved);
    }

    // Detect current season
    const detected = await kvGetJSON(env.FPL_PULSE_KV, kDetectedSeason);
    const currentSeason = detected?.season ?? Number(env.SEASON || fallbackSeason());

    // Load league members for orphan detection
    const leagueId = body.league_id || env.WARM_LEAGUE_ID;
    let memberSet = null;
    if (resolvedTargets.includes("orphaned_entries")) {
      const members = leagueId ? await kvGetJSON(env.FPL_PULSE_KV, kLeagueMembers(leagueId, currentSeason)) : null;
      if (!Array.isArray(members)) {
        return json({ error: "Cannot detect orphans: league members not found", league_id: leagueId }, 400);
      }
      memberSet = new Set(members);
    }

    // List and categorize all keys, collect deletion candidates
    const allKeys = await listAllKeys(env.FPL_PULSE_KV);
    const closedSeasons = closedSeasonsFrom(allKeys);
    const toDelete = [];
    const protectedKeys = [];
    const skippedNotClosed = [];
    const wantsClosedSeason = resolvedTargets.includes("closed_season");
    const wantsOrphans = resolvedTargets.includes("orphaned_entries");

    for (const keyName of allKeys) {
      const cat = categorizeKey(keyName, currentSeason);

      // Closed season: season-scoped keys that are neither current nor archival, belonging
      // to a season with a recorded close marker.
      if (wantsClosedSeason && "is_current" in cat && !cat.is_current) {
        // ARCHIVE GUARD. Old-season rosters, final standings, bootstrap, elements and
        // entry blobs are data FPL has already destroyed at source and that season-scoped
        // read routes serve — the archive, not debris. confirm_count cannot tell the two
        // apart: the operator types back whatever number the dry run produced. So the
        // refusal is structural, not a prompt. What remains deletable is build
        // scaffolding, overwhelmingly entry:<id>:<season>:state.
        if (cat.archival) {
          protectedKeys.push({ key: keyName, type: cat.type, season: cat.season, reason: "archival_protected" });
          continue;
        }
        // Not merely old — KNOWN closed. A season that never completed (FPL curtailed
        // 2019/20; a reshaped event list does the same) stays open and is therefore never
        // a deletion candidate. Closing it is a deliberate act:
        // POST /admin/season/<year>/close.
        if (!closedSeasons.has(cat.season)) {
          skippedNotClosed.push({ key: keyName, type: cat.type, season: cat.season, reason: "season_not_closed" });
          continue;
        }
        toDelete.push({ key: keyName, type: cat.type, reason: "closed_season", season: cat.season });
        continue;
      }

      // Orphaned entries: current-season entry keys for IDs not in the league
      if (wantsOrphans && memberSet && cat.entry_id && cat.is_current && !memberSet.has(cat.entry_id)) {
        toDelete.push({ key: keyName, type: cat.type, reason: "orphaned_entry", entry_id: cat.entry_id });
      }
    }

    // Cap at 100 deletions per request
    const capped = toDelete.length > 100;
    const batch = toDelete.slice(0, 100);

    // Dry run — return preview
    if (dryRun) {
      return json({
        ok: true,
        dry_run: true,
        would_delete: batch,
        would_delete_count: batch.length,
        capped,
        total_candidates: toDelete.length,
        protected: protectedKeys,
        protected_count: protectedKeys.length,
        skipped_not_closed: skippedNotClosed,
        skipped_not_closed_count: skippedNotClosed.length,
        ...(deprecations.length ? { deprecations } : {}),
        summary: {
          by_reason: batch.reduce((acc, d) => { acc[d.reason] = (acc[d.reason] || 0) + 1; return acc; }, {}),
        },
      });
    }

    // Actual deletion — require confirm_count
    if (typeof confirmCount !== "number" || confirmCount !== batch.length) {
      return json({
        error: "confirm_count must match would_delete_count from dry run",
        expected: batch.length,
        received: confirmCount ?? null,
      }, 409);
    }

    // Delete with inline backup: read value before deleting
    const deleted = [];
    const failed = [];
    for (const item of batch) {
      try {
        const value = await kvGetJSON(env.FPL_PULSE_KV, item.key);
        await env.FPL_PULSE_KV.delete(item.key);
        log.info("admin", "kv_cleanup_delete", { key: item.key, reason: item.reason });
        deleted.push({ ...item, backup: value });
      } catch (err) {
        failed.push({ key: item.key, error: String(err?.message || err) });
      }
    }

    const cleanupResult = {
      ok: failed.length === 0,
      dry_run: false,
      deleted,
      failed,
      protected: protectedKeys,
      protected_count: protectedKeys.length,
      skipped_not_closed: skippedNotClosed,
      skipped_not_closed_count: skippedNotClosed.length,
      ...(deprecations.length ? { deprecations } : {}),
      summary: {
        total_deleted: deleted.length,
        total_failed: failed.length,
        by_reason: deleted.reduce((acc, d) => { acc[d.reason] = (acc[d.reason] || 0) + 1; return acc; }, {}),
      },
    };
    if (idempotencyKey) {
      await storeIdempotencyResult(env, idempotencyKey, cleanupResult, 200);
    }
    return json(cleanupResult);
  }

  // POST /admin/kv/migrate-members — one-off migration of legacy unscoped league
  // roster keys (league:<id>:members) to the season-scoped form
  // (league:<id>:<season>:members).
  //
  // COPY, NEVER MOVE. The legacy key is left in place so the currently-deployed
  // worker keeps serving from it while the new one rolls out. Deleting legacy keys is
  // a separate deliberate act, after the new worker is verified live.
  //
  // `season` is REQUIRED and never defaulted. A legacy key holds whatever season was
  // current when it was written, which is not necessarily the season the worker
  // detects today — FPL rolls over in August, so a migration run after rollover would
  // otherwise stamp last season's roster with this season's number, producing exactly
  // the cross-season corruption this whole change exists to prevent.
  //
  // No confirm_count: the operation only ever creates new keys. It never overwrites an
  // existing target and never deletes anything, so there is nothing to protect against.
  //
  // PROVENANCE GATE. The season passed in is stamped onto every legacy key found, but a
  // legacy key carries no season of its own — it reflects whenever that league was last
  // ingested. A league not re-ingested since an earlier season would be mislabelled, and
  // a mislabelled roster then looks authoritative. So each key is checked against the
  // entry namespace for the season being stamped:
  //   blobs_present  — members with an entry:<id>:<season> blob. Near-total for a league
  //                    genuinely of that season; zero for one carried over from earlier.
  //   states_present — members with an entry:<id>:<season>:state. This is what separates
  //                    "no blobs because WRONG SEASON" from "no blobs because NOT BUILT
  //                    YET": a league ingested this week legitimately has zero blobs but
  //                    a full set of queued states. Without it, a naive ratio gate would
  //                    refuse precisely the most current leagues.
  // Zero on BOTH, against a non-empty roster, means nothing in this season has ever
  // referenced these entries — that key is blocked. `allow_unverified: true` overrides.
  if (path === "/admin/kv/migrate-members" && request.method === "POST") {
    log.info("admin", "endpoint_invoked", { path, method: "POST" });

    let body = {};
    try {
      const raw = await request.text();
      if (raw) body = JSON.parse(raw);
    } catch {
      return json({ error: "invalid_json_body" }, 400);
    }

    const seasonNum = Number(body.season);
    if (!Number.isInteger(seasonNum)) {
      return json({ error: "season_required", message: "Body must include an integer `season` (e.g. 2025)." }, 400);
    }
    const dryRun = body.dry_run !== false; // default true
    const allowUnverified = body.allow_unverified === true;

    // Enumerate legacy keys only — exactly league:<id>:members, never the scoped form.
    const legacyKeys = [];
    let cursor;
    do {
      const page = await env.FPL_PULSE_KV.list({ prefix: "league:", cursor, limit: 1000 });
      cursor = page.cursor;
      for (const k of page.keys) {
        if (/^league:\d+:members$/.test(k.name)) legacyKeys.push(k.name);
      }
    } while (cursor);

    const results = [];
    for (const from of legacyKeys) {
      const leagueId = from.split(":")[1];
      const to = kLeagueMembers(leagueId, seasonNum);

      const value = await kvGetJSON(env.FPL_PULSE_KV, from);
      if (!isLeagueMembers(value)) {
        results.push({ from, to, status: "invalid_source", member_count: null });
        continue;
      }

      // Idempotent: an existing target is never overwritten, so re-running is safe.
      const existing = await kvGetJSON(env.FPL_PULSE_KV, to);
      if (existing !== null) {
        results.push({ from, to, status: "skipped", reason: "target_exists", member_count: value.length });
        continue;
      }

      // Provenance: does this roster have any footprint in the season being stamped?
      // KV reads don't count against the subrequest budget, but they are not free in
      // wall time, so they run in parallel and states are only read when the blob
      // evidence is already zero (the sole case where the answer can change anything).
      const blobs = await Promise.all(value.map(id => env.FPL_PULSE_KV.get(kEntrySeason(id, seasonNum))));
      const blobsPresent = blobs.filter(b => b !== null).length;
      let statesPresent = 0;
      if (blobsPresent === 0 && value.length > 0) {
        const states = await Promise.all(value.map(id => env.FPL_PULSE_KV.get(kEntryState(id, seasonNum))));
        statesPresent = states.filter(s => s !== null).length;
      }
      const provenance = {
        member_count: value.length,
        blobs_present: blobsPresent,
        states_present: statesPresent,
        blob_ratio: value.length > 0 ? Number((blobsPresent / value.length).toFixed(2)) : null,
      };

      // An empty roster cannot be mislabelled into anything meaningful — let it pass.
      const unverified = value.length > 0 && blobsPresent === 0 && statesPresent === 0;
      if (unverified && !allowUnverified) {
        results.push({ from, to, status: "blocked", reason: "no_season_evidence", provenance });
        continue;
      }

      if (!dryRun) {
        await kvPutJSON(env.FPL_PULSE_KV, to, value);
        log.info("admin", "members_key_migrated", { from, to, member_count: value.length, provenance, forced: unverified });
      }
      results.push({
        from, to,
        status: dryRun ? "would_copy" : "copied",
        member_count: value.length,
        provenance,
        ...(unverified ? { warning: "migrated without season evidence (allow_unverified)" } : {}),
      });
    }

    const migrateResult = {
      ok: results.every(r => r.status !== "invalid_source" && r.status !== "blocked"),
      dry_run: dryRun,
      season: seasonNum,
      legacy_keys_found: legacyKeys.length,
      results,
      summary: {
        copied: results.filter(r => r.status === "copied").length,
        would_copy: results.filter(r => r.status === "would_copy").length,
        skipped: results.filter(r => r.status === "skipped").length,
        blocked: results.filter(r => r.status === "blocked").length,
        invalid: results.filter(r => r.status === "invalid_source").length,
      },
      note: "Legacy keys are NOT deleted. Delete them only after the season-scoped worker is verified live.",
    };
    if (idempotencyKey) {
      await storeIdempotencyResult(env, idempotencyKey, migrateResult, 200);
    }
    return json(migrateResult, 200);
  }

  // POST /admin/entries/states/bulk — Bulk actions on entries
  if (path === "/admin/entries/states/bulk" && request.method === "POST") {
    log.info("admin", "endpoint_invoked", { path, method: "POST" });

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    const { action, entry_ids } = body;
    const validActions = ["requeue", "purge"];

    if (!action || !validActions.includes(action)) {
      return json({ error: "Invalid action", valid: validActions }, 400);
    }
    if (!Array.isArray(entry_ids) || entry_ids.length === 0) {
      return json({ error: "entry_ids must be a non-empty array" }, 400);
    }
    if (entry_ids.length > 100) {
      return json({ error: "Maximum 100 entries per bulk operation" }, 400);
    }

    const results = { succeeded: [], failed: [] };

    for (const entryId of entry_ids) {
      const id = Number(entryId);
      if (!Number.isInteger(id)) {
        results.failed.push({ entry_id: entryId, reason: "invalid_id" });
        continue;
      }

      const stateKey = kEntryState(id, season);

      try {
        if (action === "requeue") {
          const existingState = await kvGetJSON(env.FPL_PULSE_KV, stateKey);
          await kvPutJSON(env.FPL_PULSE_KV, stateKey, {
            status: "queued",
            last_gw_processed: existingState?.last_gw_processed || 0,
            attempts: 0,
            updated_at: new Date().toISOString(),
          });
          log.info("admin", "bulk_requeue", { entry_id: id });
          results.succeeded.push(id);
        } else if (action === "purge") {
          // Delete both state and season blob
          const seasonKey = kEntrySeason(id, season);
          await Promise.all([
            env.FPL_PULSE_KV.delete(stateKey),
            env.FPL_PULSE_KV.delete(seasonKey),
          ]);
          log.info("admin", "bulk_purge", { entry_id: id });
          results.succeeded.push(id);
        }
      } catch (err) {
        results.failed.push({ entry_id: id, reason: String(err?.message || err) });
      }
    }

    const bulkResult = {
      ok: results.failed.length === 0,
      action,
      results,
      summary: {
        total: entry_ids.length,
        succeeded: results.succeeded.length,
        failed: results.failed.length,
      },
    };
    if (idempotencyKey) {
      await storeIdempotencyResult(env, idempotencyKey, bulkResult, 200);
    }
    return json(bulkResult);
  }

  // POST /admin/entries/:entryId/revive — Revive a single dead/errored entry
  if (path.match(/^\/admin\/entries\/\d+\/revive$/) && request.method === "POST") {
    const parts = path.split("/").filter(Boolean);
    const entryId = Number(parts[2]);

    log.info("admin", "endpoint_invoked", { path, method: "POST", entry_id: entryId });

    if (!Number.isInteger(entryId)) {
      return json({ error: "Invalid entry id" }, 400);
    }

    const stateKey = kEntryState(entryId, season);
    const state = await kvGetJSON(env.FPL_PULSE_KV, stateKey);

    if (!state) {
      return json({ error: "Entry state not found", entry_id: entryId }, 404);
    }

    if (state.status !== "dead" && state.status !== "errored") {
      return json({
        error: "Entry is not dead or errored",
        current_status: state.status,
        entry_id: entryId
      }, 400);
    }

    const previousState = { ...state };

    await kvPutJSON(env.FPL_PULSE_KV, stateKey, {
      status: "queued",
      last_gw_processed: state.last_gw_processed || 0,
      attempts: 0,
      updated_at: new Date().toISOString(),
      revived_at: new Date().toISOString(),
      previous_error: state.error,
    });

    log.info("admin", "entry_revived", {
      entry_id: entryId,
      previous_status: previousState.status,
      previous_attempts: previousState.attempts,
    });

    const reviveResult = {
      ok: true,
      entry_id: entryId,
      previous_status: previousState.status,
      previous_error: previousState.error,
      new_status: "queued",
    };
    if (idempotencyKey) {
      await storeIdempotencyResult(env, idempotencyKey, reviveResult, 200);
    }
    return json(reviveResult);
  }

  // POST /admin/league/:leagueId/ingest  (Phase 4)
  if (path.startsWith("/admin/league/") && path.endsWith("/ingest")) {
    const parts = path.split("/").filter(Boolean); // ["admin","league",":id","ingest"]
    const leagueIdStr = parts[2];
    const leagueId = Number(leagueIdStr);
    if (!leagueIdStr) return json({ error: "Missing league id" }, 400);
    if (!Number.isInteger(leagueId) || leagueId <= 0) return json({ error: "Invalid league id" }, 400);

    const seasonNum = season;
    const BASE = `https://fantasy.premierleague.com/api/leagues-classic/${leagueId}/standings/`;

    // One-off benchmark bypass (admin-gated route): ?allow_large=1 skips the friends-only
    // page-1 refusal so a specific >50-member league can be ingested. The global
    // MAX_LEAGUE_SIZE policy and the read routes (members / entries-pack) are untouched.
    const allowLarge = url.searchParams.get("allow_large") === "1";
    // Safety ceiling for the bypass so we can't accidentally page through a giant public
    // league. Comfortably above the AE64 benchmark's 64 members.
    const MAX_LARGE_INGEST = 100;

    // Pull standings pages until we collect <= MAX_LEAGUE_SIZE entries or there are no more pages
    // FPL classic standings page size is typically 50; enforce hard policy at 50 total.
    const members = [];
    let page = 1;
    while (true) {
      const pageUrl = page === 1 ? BASE : `${BASE}?page_standings=${page}`;
      const data = await fetchJson(pageUrl);

      const results = data?.standings?.results;
      const hasNext = Boolean(data?.standings?.has_next);
      if (!Array.isArray(results)) {
        return json({ error: "unexpected_fpl_payload", page, sample: (data && Object.keys(data)) || null }, 502);
      }

      // Friends-only policy: if page 1 has a next page, league > MAX_LEAGUE_SIZE -> refuse
      // (unless the admin explicitly opted into a large one-off ingest).
      if (page === 1 && hasNext && !allowLarge) {
        return json({
          error: "league_too_large",
          message: `League exceeds ${MAX_LEAGUE_SIZE} members (friends-only policy).`,
          leagueId
        }, 403);
      }

      for (const row of results) {
        const entryId = Number(row?.entry);
        if (Number.isInteger(entryId)) members.push(entryId);
      }

      // Bypass safety ceiling: stop paging once we've collected enough.
      if (allowLarge && members.length >= MAX_LARGE_INGEST) break;

      if (!hasNext || results.length === 0) break;
      page += 1;
    }

    // De-dupe collected members just in case
    const uniqueMembers = Array.from(new Set(members));

    // Write league members to KV under the season currently being tracked. Ingest
    // never addresses a past season: it reads the LIVE standings API, so the roster
    // it collects can only describe the season the worker has detected.
    const leagueKey = kLeagueMembers(leagueIdStr, seasonNum);
    await kvPutJSON(env.FPL_PULSE_KV, leagueKey, uniqueMembers);

    // Enqueue new entries for backfill: create state if neither blob nor state exists
    let queuedCount = 0;
    const nowIso = new Date().toISOString();

    // Batch existence checks in parallel (bounded fan-out)
    await Promise.all(uniqueMembers.map(async (entryId) => {
      const seasonKey = kEntrySeason(entryId, seasonNum);
      const stateKey  = kEntryState(entryId, seasonNum);

      const [existingSeason, existingState] = await Promise.all([
        env.FPL_PULSE_KV.get(seasonKey),
        env.FPL_PULSE_KV.get(stateKey, { type: "json" })
      ]);

      // If we already have a season blob, skip.
      if (existingSeason) return;

      // If state exists and is queued/building/complete, skip re-enqueue.
      if (existingState && typeof existingState === "object" && existingState.status) return;

      // Otherwise enqueue
      await kvPutJSON(env.FPL_PULSE_KV, stateKey, {
        status: "queued",
        last_gw_processed: 0,
        updated_at: nowIso,
        version: 1
      });
      queuedCount += 1;
    }));

    const ingestResult = {
      ok: true,
      leagueId,
      members_count: uniqueMembers.length,
      queued_count: queuedCount
    };
    if (idempotencyKey) {
      await storeIdempotencyResult(env, idempotencyKey, ingestResult, 200);
    }
    return json(ingestResult, 200);
  }

  // POST /admin/entry/:entryId/force-rebuild
  // Force a full rebuild of a single entry blob, even if already complete
  if (path.startsWith("/admin/entry/") && path.endsWith("/force-rebuild")) {
    const parts = path.split("/").filter(Boolean); // ["admin","entry",":id","force-rebuild"]
    const entryId = Number(parts[2]);
    if (!Number.isInteger(entryId)) return json({ error: "Invalid entry id" }, 400);

    const seasonNum = season;
    const stateKey = kEntryState(entryId, seasonNum);

    // Read any existing state (if present)
    const existingState = await kvGetJSON(env.FPL_PULSE_KV, stateKey);

    // Always set to queued, resetting last_gw_processed to 0 so we rebuild from scratch
    await kvPutJSON(env.FPL_PULSE_KV, stateKey, {
      status: "queued",
      last_gw_processed: 0,
      updated_at: new Date().toISOString(),
      version: (existingState?.version ?? 0) + 1,
    });

    // Small delay to ensure KV write propagates (eventual consistency)
    await sleep(500);

    // Optionally keep or overwrite the old blob; processEntryOnce will overwrite anyway
    const result = await processEntryOnce(entryId, seasonNum, env.FPL_PULSE_KV);

    // Also purge edge cache for this entry — both addressing forms.
    try {
      const reqUrl = new URL(request.url);
      for (const cacheUrl of v1CacheUrls(`${reqUrl.protocol}//${reqUrl.host}`, seasonNum, `/entry/${entryId}`)) {
        await caches.default.delete(cacheKeyFor(new Request(cacheUrl)));
      }
    } catch (e) {
      log.warn("cache", "purge_failed", {
        entry_id: entryId,
        error: e?.message || String(e),
      });
    }

    const rebuildResult = { ok: !!result.ok, mode: "force-rebuild", result };
    const rebuildStatus = result.ok ? 200 : 207;
    if (idempotencyKey) {
      await storeIdempotencyResult(env, idempotencyKey, rebuildResult, rebuildStatus);
    }
    return json(rebuildResult, rebuildStatus);
  }

  // POST /admin/league/:leagueId/purge-cache
  // Purge edge cache for a league's entries-pack endpoint
  if (path.startsWith("/admin/league/") && path.endsWith("/purge-cache")) {
    const parts = path.split("/").filter(Boolean); // ["admin","league",":id","purge-cache"]
    const leagueId = parts[2];
    if (!leagueId) return json({ error: "Missing league id" }, 400);

    try {
      const reqUrl = new URL(request.url);
      const cacheUrls = v1CacheUrls(`${reqUrl.protocol}//${reqUrl.host}`, season, `/league/${leagueId}/entries-pack`);
      const results = [];
      for (const cacheUrl of cacheUrls) {
        results.push(await caches.default.delete(cacheKeyFor(new Request(cacheUrl))));
      }
      return json({ ok: true, deleted: results.some(Boolean), league_id: leagueId, purged_urls: cacheUrls });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // POST /admin/entry/:entryId/purge-cache
  // Purge edge cache for a specific entry
  if (path.startsWith("/admin/entry/") && path.endsWith("/purge-cache")) {
    const parts = path.split("/").filter(Boolean); // ["admin","entry",":id","purge-cache"]
    const entryId = Number(parts[2]);
    if (!Number.isInteger(entryId)) return json({ error: "Invalid entry id" }, 400);

    try {
      const reqUrl = new URL(request.url);
      const cacheUrls = v1CacheUrls(`${reqUrl.protocol}//${reqUrl.host}`, season, `/entry/${entryId}`);
      const results = [];
      for (const cacheUrl of cacheUrls) {
        results.push(await caches.default.delete(cacheKeyFor(new Request(cacheUrl))));
      }
      return json({ ok: true, deleted: results.some(Boolean), entry_id: entryId, purged_urls: cacheUrls }, 200);
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // POST /admin/entry/:entryId/enqueue
  if (path.startsWith("/admin/entry/") && path.endsWith("/enqueue")) {
    const parts = path.split("/").filter(Boolean); // ["admin","entry",":id","enqueue"]
    const entryId = Number(parts[2]);
    if (!Number.isInteger(entryId)) return json({ error: "Invalid entry id" }, 400);

    const seasonNum = season;
    const stateKey = kEntryState(entryId, seasonNum);
    const seasonKey = kEntrySeason(entryId, seasonNum);

    const [existingBlob, existingState] = await Promise.all([
      env.FPL_PULSE_KV.get(seasonKey),
      kvGetJSON(env.FPL_PULSE_KV, stateKey),
    ]);

    // If blob already exists, no need to enqueue
    if (existingBlob) return json({ ok: true, status: "already_complete", entryId }, 200);

    // If state exists and is queued/building, don't double-enqueue
    if (existingState && (existingState.status === "queued" || existingState.status === "building")) {
      return json({ ok: true, status: existingState.status, entryId }, 200);
    }

    // Otherwise set queued
    await kvPutJSON(env.FPL_PULSE_KV, stateKey, {
      status: "queued",
      last_gw_processed: existingState?.last_gw_processed ?? 0,
      updated_at: new Date().toISOString(),
      version: (existingState?.version ?? 0) + 1,
    });

    const enqueueResult = { ok: true, status: "queued", entryId };
    if (idempotencyKey) {
      await storeIdempotencyResult(env, idempotencyKey, enqueueResult, 200);
    }
    return json(enqueueResult, 200);
  }

  // POST /admin/harvest?delay=1800
  if (path === "/admin/harvest") {
    const delay = Number(new URL(request.url).searchParams.get("delay") || 0);
    const res = await harvestIfNeeded(env, { delaySec: delay });
    return json(res, res.status === "ok" || res.status === "noop" ? 200 : 202);
  }

  // POST /admin/season/elements/backfill — repair/fill the season:elements spine.
  // One-off recovery for missing or legacy-schema early-GW blocks (the harvest
  // snapshot gate stops the cron re-running once last_gw is caught up, so the
  // existing gap must be repaired here). Re-fetches event/{gw}/live for every
  // GW 1..latest-finished that is missing or invalid, then purges the edge cache.
  if (path === "/admin/season/elements/backfill") {
    const bootstrap = await fetchBootstrap();
    const upTo = detectLatestFinishedGW(bootstrap);
    if (!Number.isInteger(upTo)) return json({ error: "no_finished_gw" }, 422);

    const result = await backfillSeasonElements(env, season, upTo);

    // Purge the global season:elements edge cache so clients read the repair
    // (mirrors processPurgeQueue's cache.delete(new Request(url)) pattern).
    try {
      const origin = "https://fpl-pulse.ciaranbrennan18.workers.dev";
      // Unprefixed lives at /v1/season/elements; the prefixed form is /v1/<year>/elements.
      for (const u of [`${origin}/v1/season/elements`, `${origin}/v1/${season}/elements`]) {
        await caches.default.delete(new Request(u));
      }
    } catch (_e) { /* best-effort purge; TTL/cron purge is the safety net */ }

    const backfillResult = { ok: true, up_to_gw: upTo, ...result };
    if (idempotencyKey) {
      await storeIdempotencyResult(env, idempotencyKey, backfillResult, 200);
    }
    return json(backfillResult, 200);
  }

  // POST /admin/warm — builds purge queue then immediately processes the first batch.
  // If queue has >45 items (PURGE_BATCH_SIZE), remaining items are cleared by subsequent CRON cycles.
  if (path === "/admin/warm") {
    const queueResult = await warmCache(env);
    const purgeResult = await processPurgeQueue(env);
    return json({ queue: queueResult, purge: purgeResult }, 200);
  }

  // POST /admin/circuit-breaker/reset
  if (path === "/admin/circuit-breaker/reset") {
    const prev = { failures: circuitBreaker.failures, openUntil: circuitBreaker.openUntil };
    circuitBreaker.reset();
    return json({ ok: true, previous: prev }, 200);
  }

  // POST /admin/dead/revive — re-queue all dead entries (resets attempts to 0)
  // If entries fail again, they follow the normal flow: errored → 3 retries → dead
  if (path === "/admin/dead/revive") {
    const seasonNum = season;
    const revived = [];
    let cursor;

    do {
      const page = await env.FPL_PULSE_KV.list({ prefix: "entry:", cursor, limit: 100 });
      cursor = page.cursor;
      for (const k of page.keys) {
        if (!k.name.endsWith(`:${seasonNum}:state`)) continue;
        const state = await kvGetJSON(env.FPL_PULSE_KV, k.name);
        if (state?.status !== "dead") continue;

        const entryId = Number(k.name.split(":")[1]);
        await kvPutJSON(env.FPL_PULSE_KV, k.name, {
          status: "queued",
          last_gw_processed: state.last_gw_processed ?? 0,
          attempts: 0,
          updated_at: new Date().toISOString(),
        });
        revived.push(entryId);
      }
      if (revived.length >= 200) break;
    } while (cursor);

    const deadReviveResult = { ok: true, revived_count: revived.length, entry_ids: revived };
    if (idempotencyKey) {
      await storeIdempotencyResult(env, idempotencyKey, deadReviveResult, 200);
    }
    return json(deadReviveResult, 200);
  }

  // POST /admin/backfill?single=true&entry=<id>
  // Minimal one-entry backfill for testing
  // POST /admin/backfill
  // Modes:
  //   - single:  /admin/backfill?single=true&entry=<id>
  //   - batch:   /admin/backfill?limit=5[&leagueId=<id>]
  if (path === "/admin/backfill") {
    const u = new URL(request.url);
    const seasonNum = season;

    // --- single mode (preserve existing) ---
    const single = u.searchParams.get("single") === "true";
    const entryParam = u.searchParams.get("entry");
    if (single) {
      const entryId = Number(entryParam);
      if (!Number.isInteger(entryId)) {
        return json({ error: "missing_or_invalid_entry", hint: "provide ?entry=<number>" }, 400);
      }
      // Ensure state exists
      const stateKey = kEntryState(entryId, seasonNum);
      const existingState = await kvGetJSON(env.FPL_PULSE_KV, stateKey);
      if (!existingState) {
        await kvPutJSON(env.FPL_PULSE_KV, stateKey, {
          status: "queued",
          last_gw_processed: 0,
          updated_at: new Date().toISOString(),
          version: 1,
        });
      }
      const result = await processEntryOnce(entryId, seasonNum, env.FPL_PULSE_KV);
      const singleResult = { ok: !!result.ok, mode: "single", result };
      const singleStatus = result.ok ? 200 : 207;
      if (idempotencyKey) {
        await storeIdempotencyResult(env, idempotencyKey, singleResult, singleStatus);
      }
      return json(singleResult, singleStatus);
    }

    // --- batch mode ---
    const limit = Math.max(1, Math.min(10, Number(u.searchParams.get("limit") || 5))); // cap 1..10
    const leagueId = u.searchParams.get("leagueId"); // optional: restrict to one league

    // Collect candidate entryIds to consider
    let candidates = [];
    if (leagueId) {
      // From one league (≤ 50)
      const members = await kvGetJSON(env.FPL_PULSE_KV, kLeagueMembers(leagueId, seasonNum));
      if (!isLeagueMembers(members)) {
        return json({ error: "invalid_or_missing_league", leagueId }, 404);
      }
      candidates = members;
    } else {
      // Global small scan (dev scale): list keys and extract entry ids with :<season>:state
      // NOTE: fine for our small dataset (hundreds). Revisit if scaling up.
      let cursor = undefined;
      do {
        const page = await env.FPL_PULSE_KV.list({ prefix: "entry:", cursor });
        cursor = page.cursor;
        for (const k of page.keys) {
          // Expect keys like entry:<id>:<season>:state
          if (k.name.endsWith(`:${seasonNum}:state`)) {
            const parts = k.name.split(":"); // ["entry","<id>","<season>","state"]
            const id = Number(parts[1]);
            if (Number.isInteger(id)) candidates.push(id);
          }
        }
        // Stop early if we already have plenty of candidates to check states
        if (candidates.length >= 200) break;
      } while (cursor);
      // De-dupe
      candidates = Array.from(new Set(candidates));
    }

    // Read states and pick queued up to limit
    const queued = [];
    for (const id of candidates) {
      if (queued.length >= limit) break;
      const st = await kvGetJSON(env.FPL_PULSE_KV, kEntryState(id, seasonNum));
      if (st && st.status === "queued") queued.push(id);
    }

    // Process sequentially (safe)
    const results = [];
    for (const id of queued) {
      const r = await processEntryOnce(id, seasonNum, env.FPL_PULSE_KV);
      results.push(r);
    }

    const batchSummary = {
      ok: true,
      mode: "batch",
      leagueId: leagueId || null,
      requested: limit,
      processed: results.length,
      succeeded: results.filter(r => r.ok).length,
      errored: results.filter(r => !r.ok).length,
      ids: queued,
    };
    if (idempotencyKey) {
      await storeIdempotencyResult(env, idempotencyKey, batchSummary, 200);
    }
    return json(batchSummary, 200);
  }

  // POST /admin/standings/archive — capture FULL final classic standings for every
  // tracked league into a write-once KV key (league:<id>:<season>:standings) before
  // FPL's season rollover wipes them. `final:true` is stamped only when bootstrap
  // confirms every event is finished; a final table is never overwritten unless
  // `force` is set. Bounded by the subrequest budget — if `remaining` is non-empty,
  // re-invoke until empty (already-final leagues are skipped, so re-runs are safe).
  // Body: { season: <int, required>, force?: bool, leagueId?: <int, single-league test> }
  if (path === "/admin/standings/archive") {
    let body = {};
    try {
      const raw = await request.text();
      if (raw) body = JSON.parse(raw);
    } catch {
      return json({ error: "invalid_json_body" }, 400);
    }

    const seasonNum = Number(body.season);
    if (!Number.isInteger(seasonNum)) {
      return json({ error: "season_required", message: "Body must include an integer `season` (e.g. 2025)." }, 400);
    }
    const force = Boolean(body.force);
    // Overrides the provenance check only — NOT the write-once guard, which is `force`.
    // For a tiny league with heavy summer churn the overlap ratio is genuinely noisy.
    const allowUnverified = body.allow_unverified === true;
    let leagueId = null;
    if (body.leagueId != null) {
      leagueId = Number(body.leagueId);
      if (!Number.isInteger(leagueId) || leagueId <= 0) return json({ error: "invalid_league_id" }, 400);
    }

    const result = await archiveAllLeagueStandings(env, seasonNum, { force, leagueId, allowUnverified });
    if (idempotencyKey) {
      await storeIdempotencyResult(env, idempotencyKey, result, 200);
    }
    return json(result, 200);
  }

  return json({ error: "Admin route not found" }, 404);
}
