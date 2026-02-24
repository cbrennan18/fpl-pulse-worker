import { json, log, cacheKeyFor, checkIdempotencyKey, storeIdempotencyResult } from '../lib/utils.js';
import { kvGetJSON, kvPutJSON, kEntryState, kEntrySeason, kLeagueMembers, isLeagueMembers, MAX_LEAGUE_SIZE } from '../lib/kv.js';
import { fetchJson, circuitBreaker, sleep } from '../lib/fpl-api.js';
import { processEntryOnce } from '../services/entry.js';
import { harvestIfNeeded, warmCache } from '../services/harvest.js';

// === Admin auth helper ===
// Accepts ?token=... or X-Refresh-Token header and compares to env.REFRESH_TOKEN
const isAuthorized = (request, env) => {
  const u = new URL(request.url);
  const token = u.searchParams.get("token") || request.headers.get("x-refresh-token");
  return Boolean(token && token === env.REFRESH_TOKEN);
};

// Handles all admin routes. Returns a Response or null (no match).
export async function handleAdminRoute(request, env, season) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (!path.startsWith("/admin/")) return null;

  // Allow GET for specific read-only admin endpoints
  const isGetAllowed = path === "/admin/entries/states" || path === "/admin/entries/dead";
  if (request.method !== "POST" && !(request.method === "GET" && isGetAllowed)) {
    return json({ error: "Method not allowed" }, 405);
  }
  if (!isAuthorized(request, env)) return json({ error: "Unauthorized" }, 401);

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

    const seasonNum = Number(env.SEASON || 2025);
    const BASE = `https://fantasy.premierleague.com/api/leagues-classic/${leagueId}/standings/`;

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
      if (page === 1 && hasNext) {
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

      if (!hasNext || results.length === 0) break;
      page += 1;
    }

    // De-dupe collected members just in case
    const uniqueMembers = Array.from(new Set(members));

    // Write league members to KV
    const leagueKey = kLeagueMembers(leagueIdStr);
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

    const seasonNum = Number(env.SEASON || 2025);
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

    // Also purge edge cache for this entry
    try {
      const reqUrl = new URL(request.url);
      const cacheUrl = `${reqUrl.protocol}//${reqUrl.host}/v1/entry/${entryId}`;
      const cacheKey = cacheKeyFor(new Request(cacheUrl));
      await caches.default.delete(cacheKey);
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
      const cacheUrl = `${reqUrl.protocol}//${reqUrl.host}/v1/league/${leagueId}/entries-pack`;
      const cacheKey = cacheKeyFor(new Request(cacheUrl));
      const deleted = await caches.default.delete(cacheKey);
      return json({ ok: true, deleted, league_id: leagueId, purged_url: cacheUrl });
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
      const cacheUrl = `${reqUrl.protocol}//${reqUrl.host}/v1/entry/${entryId}`;
      const cacheKey = cacheKeyFor(new Request(cacheUrl));
      const deleted = await caches.default.delete(cacheKey);
      return json({ ok: true, deleted, entry_id: entryId }, 200);
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  }

  // POST /admin/entry/:entryId/enqueue
  if (path.startsWith("/admin/entry/") && path.endsWith("/enqueue")) {
    const parts = path.split("/").filter(Boolean); // ["admin","entry",":id","enqueue"]
    const entryId = Number(parts[2]);
    if (!Number.isInteger(entryId)) return json({ error: "Invalid entry id" }, 400);

    const seasonNum = Number(env.SEASON || 2025);
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

  // POST /admin/warm
  if (path === "/admin/warm") {
    const res = await warmCache(env);
    return json(res, 200);
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
    const seasonNum = Number(env.SEASON || 2025);
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
          last_gw_processed: 0,
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
    const seasonNum = Number(env.SEASON || 2025);

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
      const members = await kvGetJSON(env.FPL_PULSE_KV, kLeagueMembers(leagueId));
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

  return json({ error: "Admin route not found" }, 404);
}
