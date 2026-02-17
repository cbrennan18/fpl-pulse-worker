import { json, cacheHeaders, cacheKeyFor, dynamicCacheHeaders, CORS, log } from '../lib/utils.js';
import { kvGetJSON, kSeasonBootstrap, kSeasonElements, kSnapshotCurrent, kLeagueMembers, kEntrySeason, kEntryState, kHealthStateSummary, isSeasonElements, isEntrySeason, isLeagueMembers, cacheFirstKV, MAX_LEAGUE_SIZE } from '../lib/kv.js';
import { circuitBreaker, fetchJsonWithRetry } from '../lib/fpl-api.js';

// Handles all public routes. Returns a Response or null (no match).
export async function handlePublicRoute(request, env, season) {
  const url = new URL(request.url);
  const path = url.pathname;

  // Health check endpoint
  if (path === "/health") {
    return json({
      status: "ok",
      version: env.APP_VERSION || "dev",
      season,
      ts: Date.now(),
      kv: env.FPL_PULSE_KV ? "bound" : "missing",
    });
  }

  // Detailed health check endpoint
  if (path === "/health/detailed") {
    try {
      const snapshot = await kvGetJSON(env.FPL_PULSE_KV, kSnapshotCurrent);
      const bootstrap = await kvGetJSON(env.FPL_PULSE_KV, kSeasonBootstrap(season));

      // Read precomputed state summary (updated by cron)
      const stateSummary = await kvGetJSON(env.FPL_PULSE_KV, kHealthStateSummary);

      // Use precomputed summary if available and matches current season
      let entryCounts;
      if (stateSummary && stateSummary.season === season) {
        entryCounts = {
          errored: stateSummary.errored,
          queued: stateSummary.queued,
          building: stateSummary.building,
          complete: stateSummary.complete,
          dead: stateSummary.dead,
          total: stateSummary.total,
          source: "precomputed",
          summary_age_sec: Math.floor((Date.now() - Date.parse(stateSummary.updated_at)) / 1000),
        };
      } else {
        // Fallback: limited scan (original behavior for first deploy)
        let erroredCount = 0, queuedCount = 0, buildingCount = 0, completeCount = 0, deadCount = 0;
        let cursor;
        do {
          const page = await env.FPL_PULSE_KV.list({ prefix: `entry:`, cursor, limit: 100 });
          cursor = page.cursor;
          for (const k of page.keys) {
            if (k.name.endsWith(`:${season}:state`)) {
              const state = await kvGetJSON(env.FPL_PULSE_KV, k.name);
              if (state?.status === "errored") erroredCount++;
              else if (state?.status === "queued") queuedCount++;
              else if (state?.status === "building") buildingCount++;
              else if (state?.status === "complete") completeCount++;
              else if (state?.status === "dead") deadCount++;
            }
          }
          if (erroredCount + queuedCount + buildingCount + completeCount + deadCount > 200) break;
        } while (cursor);

        entryCounts = {
          errored: erroredCount,
          queued: queuedCount,
          building: buildingCount,
          complete: completeCount,
          dead: deadCount,
          total: erroredCount + queuedCount + buildingCount + completeCount + deadCount,
          source: "scan_limited",
          scan_limit: 200,
        };
      }

      // Detect active GW
      const activeGW = bootstrap?.events?.find(e => e?.is_current === true && e?.finished === false);

      return json({
        status: "ok",
        version: env.APP_VERSION || "dev",
        season,
        timestamp: new Date().toISOString(),
        kv: {
          bound: env.FPL_PULSE_KV ? true : false,
          namespace_id: env.FPL_PULSE_KV?.namespace || "unknown",
        },
        snapshot: {
          last_gw_processed: snapshot?.last_gw ?? 0,
          season: snapshot?.season ?? season,
        },
        gameweek: {
          active: activeGW ? activeGW.id : null,
          active_name: activeGW ? activeGW.name : null,
          is_finished: activeGW ? activeGW.finished : null,
        },
        entries: entryCounts,
        circuit_breaker: {
          is_open: circuitBreaker.isOpen(),
          failures: circuitBreaker.failures,
          open_until: circuitBreaker.openUntil > 0 ? new Date(circuitBreaker.openUntil).toISOString() : null,
        },
      });
    } catch (err) {
      return json({
        status: "degraded",
        error: String(err?.message || err),
        version: env.APP_VERSION || "dev",
      }, 503);
    }
  }

  // === Public READ endpoints (edge -> KV only) ===

  // Entry season blob (all GWs for a single FPL team) — returns 202 if queued/building
  if (path.startsWith("/v1/entry/")) {
    const parts = path.split("/").filter(Boolean); // ["v1","entry",":id"]
    const entryId = Number(parts[2]);
    if (!Number.isInteger(entryId)) return json({ error: "Invalid entry id" }, 400);

    // Edge cache first (path-only key; no query)
    const cache = caches.default;
    const ck = cacheKeyFor(request);
    const edge = await cache.match(ck);
    if (edge) {
      const r = new Response(edge.body, edge);
      r.headers.set("X-Cache", "HIT");
      r.headers.set("X-App-Version", env.APP_VERSION || "dev");
      return r;
    }

    // KV read for the main blob
    const kvKey = kEntrySeason(entryId, season);
    const data = await kvGetJSON(env.FPL_PULSE_KV, kvKey);
    if (data) {
      if (!isEntrySeason(data)) return json({ error: "Invalid blob", key: kvKey }, 422);

      // Use dynamic cache based on GW state
      const bootstrap = await kvGetJSON(env.FPL_PULSE_KV, kSeasonBootstrap(season));
      const headers = { ...dynamicCacheHeaders(bootstrap), "X-Cache": "MISS", "X-App-Version": env.APP_VERSION || "dev" };

      // Add stale data headers for observability
      if (data.updated_at) {
        const ageMs = Date.now() - Date.parse(data.updated_at);
        const ageDays = Math.floor(ageMs / (24 * 3600 * 1000));
        headers["X-Data-Age-Days"] = String(ageDays);
        if (ageMs > 7 * 24 * 3600 * 1000) { // Older than 7 days
          headers["X-Data-Stale"] = "true";
        }
      }

      const resp = json(data, 200, headers);
      try { await cache.put(ck, resp.clone()); } catch {}
      return resp;
    }

    // If blob missing, check build state
    const state = await kvGetJSON(env.FPL_PULSE_KV, kEntryState(entryId, season));
    if (state && (state.status === "queued" || state.status === "building")) {
      return json({ status: state.status, last_gw_processed: state.last_gw_processed ?? 0 }, 202);
    }

    return json({ error: "Not found", key: kvKey }, 404);
  }

  // Season elements blob (all players' scores by GW)
  if (path === "/v1/season/elements") {
    return cacheFirstKV(request, env, kSeasonElements(season), isSeasonElements);
  }

  // Latest bootstrap blob (global game metadata)
  if (path === "/v1/season/bootstrap") {
    return cacheFirstKV(request, env, kSeasonBootstrap(season));
  }

  // League members (list of all entry IDs in a league) — enforce friends-only policy
  if (path.startsWith("/v1/league/") && path.endsWith("/members")) {
    const parts = path.split("/").filter(Boolean); // ["v1","league",":id","members"]
    const leagueId = parts[2];
    if (!leagueId) return json({ error: "Missing league id" }, 400);

    // Edge cache first (we'll only cache valid small leagues)
    const cache = caches.default;
    const ck = cacheKeyFor(request);
    const edge = await cache.match(ck);
    if (edge) {
      const r = new Response(edge.body, edge);
      r.headers.set("X-Cache", "HIT");
      r.headers.set("X-App-Version", env.APP_VERSION || "dev");
      return r;
    }

    const members = await kvGetJSON(env.FPL_PULSE_KV, kLeagueMembers(leagueId));
    if (!isLeagueMembers(members)) return json({ error: "Not found or invalid members", leagueId }, 404);
    if (members.length > MAX_LEAGUE_SIZE) {
      return json({ error: "league_too_large", message: `League has ${members.length} members (> ${MAX_LEAGUE_SIZE})` }, 403);
    }

    const resp = json(members, 200, { ...cacheHeaders(), "X-Cache": "MISS", "X-App-Version": env.APP_VERSION || "dev" });
    try { await cache.put(ck, resp.clone()); } catch {}
    return resp;
  }


  // Pack route: single-page bulk fetch of entry blobs (no pagination)
  if (path.startsWith("/v1/league/") && path.endsWith("/entries-pack")) {
    const parts = path.split("/").filter(Boolean); // ["v1","league",":id","entries-pack"]
    const leagueId = parts[2];
    if (!leagueId) return json({ error: "Missing league id" }, 400);

    // Edge cache first (no query to consider; single page)
    const cache = caches.default;
    const ck = cacheKeyFor(request);
    const edge = await cache.match(ck);
    if (edge) {
      const r = new Response(edge.body, edge);
      r.headers.set("X-Cache", "HIT");
      r.headers.set("X-App-Version", env.APP_VERSION || "dev");
      return r;
    }

    // Read members
    const members = await kvGetJSON(env.FPL_PULSE_KV, kLeagueMembers(leagueId));
    if (!isLeagueMembers(members)) return json({ error: "Not found or invalid members", leagueId }, 404);

    // Friends-only policy: refuse large leagues outright
    if (members.length > MAX_LEAGUE_SIZE) {
      return json({ error: "league_too_large", message: `League has ${members.length} members (> ${MAX_LEAGUE_SIZE})` }, 403);
    }

    // No pagination by policy; serve all (<= 50)
    const slice = members; // already <= 50


    // Batch KV reads
    const keys = slice.map((id) => kEntrySeason(id, season));
    const reads = await Promise.all(keys.map((key) => kvGetJSON(env.FPL_PULSE_KV, key)));

    // Assemble payload
    const entries = {};
    slice.forEach((entryId, i) => {
      const blob = reads[i];
      if (blob && isEntrySeason(blob)) entries[entryId] = blob;
    });

    const payload = {
      members: slice,
      entries,
      meta: {
        count: slice.length,
        capped: members.length > slice.length,
        total_members: members.length,
      },
    };

    // Use dynamic cache based on GW state
    const bootstrap = await kvGetJSON(env.FPL_PULSE_KV, kSeasonBootstrap(season));
    const resp = json(payload, 200, { ...dynamicCacheHeaders(bootstrap), "X-Cache": "MISS", "X-App-Version": env.APP_VERSION || "dev" });
    try { await cache.put(ck, resp.clone()); } catch {}
    return resp;
  }

  // === Backward-compatible proxy routes (for frontend migration) ===

  // GET /fpl/bootstrap → proxy to FPL bootstrap (or redirect to /v1/season/bootstrap)
  if (path === "/fpl/bootstrap") {
    return cacheFirstKV(request, env, kSeasonBootstrap(season));
  }

  // GET /fpl/entry/:id/summary → proxy to FPL entry summary
  if (path.match(/^\/fpl\/entry\/\d+\/summary$/)) {
    const entryId = Number(path.split("/")[3]);
    if (!Number.isInteger(entryId)) return json({ error: "Invalid entry id" }, 400);

    try {
      const summary = await fetchJsonWithRetry(
        `https://fantasy.premierleague.com/api/entry/${entryId}/`
      );
      return json(summary, 200, { ...cacheHeaders(), ...CORS, "X-App-Version": env.APP_VERSION || "dev" });
    } catch (err) {
      return json({ error: "Failed to fetch entry summary", details: String(err.message) }, 502);
    }
  }

  // GET /fpl/entry/:id → proxy to entry history
  if (path.match(/^\/fpl\/entry\/\d+$/) && !path.includes("/event/") && !path.includes("/summary") && !path.includes("/transfers")) {
    const entryId = Number(path.split("/")[3]);
    if (!Number.isInteger(entryId)) return json({ error: "Invalid entry id" }, 400);

    try {
      const history = await fetchJsonWithRetry(
        `https://fantasy.premierleague.com/api/entry/${entryId}/history/`
      );
      return json(history, 200, { ...cacheHeaders(), ...CORS, "X-App-Version": env.APP_VERSION || "dev" });
    } catch (err) {
      return json({ error: "Failed to fetch entry history", details: String(err.message) }, 502);
    }
  }

  // GET /fpl/entry/:id/transfers → proxy to transfers
  if (path.match(/^\/fpl\/entry\/\d+\/transfers$/)) {
    const entryId = Number(path.split("/")[3]);
    if (!Number.isInteger(entryId)) return json({ error: "Invalid entry id" }, 400);

    try {
      const transfers = await fetchJsonWithRetry(
        `https://fantasy.premierleague.com/api/entry/${entryId}/transfers/`
      );
      return json(transfers, 200, { ...cacheHeaders(), ...CORS, "X-App-Version": env.APP_VERSION || "dev" });
    } catch (err) {
      return json({ error: "Failed to fetch transfers", details: String(err.message) }, 502);
    }
  }

  // GET /fpl/entry/:id/event/:gw/picks → proxy to picks
  if (path.match(/^\/fpl\/entry\/\d+\/event\/\d+\/picks$/)) {
    const parts = path.split("/").filter(Boolean);
    const entryId = Number(parts[2]);
    const gw = Number(parts[4]);

    if (!Number.isInteger(entryId) || !Number.isInteger(gw)) {
      return json({ error: "Invalid entry id or gameweek" }, 400);
    }

    try {
      const picks = await fetchJsonWithRetry(
        `https://fantasy.premierleague.com/api/entry/${entryId}/event/${gw}/picks/`
      );
      return json(picks, 200, { ...cacheHeaders(), ...CORS, "X-App-Version": env.APP_VERSION || "dev" });
    } catch (err) {
      return json({ error: "Failed to fetch picks", details: String(err.message) }, 502);
    }
  }

  // GET /fpl/live/:gw → proxy to live gameweek data
  if (path.match(/^\/fpl\/live\/\d+$/)) {
    const gw = Number(path.split("/")[3]);
    if (!Number.isInteger(gw)) return json({ error: "Invalid gameweek" }, 400);

    try {
      const live = await fetchJsonWithRetry(
        `https://fantasy.premierleague.com/api/event/${gw}/live/`
      );
      return json(live, 200, { ...cacheHeaders(), ...CORS, "X-App-Version": env.APP_VERSION || "dev" });
    } catch (err) {
      return json({ error: "Failed to fetch live data", details: String(err.message) }, 502);
    }
  }

  // GET /fpl/league/:id → proxy to FPL league standings
  if (path.match(/^\/fpl\/league\/\d+$/)) {
    const leagueId = path.split("/")[3];
    try {
      const standings = await fetchJsonWithRetry(
        `https://fantasy.premierleague.com/api/leagues-classic/${leagueId}/standings/?page_standings=1`
      );
      return json(standings, 200, { ...cacheHeaders(), ...CORS, "X-App-Version": env.APP_VERSION || "dev" });
    } catch (err) {
      return json({ error: "Failed to fetch league standings", details: String(err.message) }, 502);
    }
  }

  // GET /fpl/element-summary/:id → proxy to player history
  if (path.match(/^\/fpl\/element-summary\/\d+$/)) {
    const playerId = Number(path.split("/")[3]);
    if (!Number.isInteger(playerId)) return json({ error: "Invalid player id" }, 400);

    try {
      const playerHistory = await fetchJsonWithRetry(
        `https://fantasy.premierleague.com/api/element-summary/${playerId}/`
      );
      return json(playerHistory, 200, { ...cacheHeaders(), ...CORS, "X-App-Version": env.APP_VERSION || "dev" });
    } catch (err) {
      return json({ error: "Failed to fetch player history", details: String(err.message) }, 502);
    }
  }

  // No match
  return null;
}
