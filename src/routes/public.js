import { json, cacheHeaders, cacheKeyFor, dynamicCacheHeaders, parseSeasonToken, MIN_SEASON, maxSeason, CORS, log } from '../lib/utils.js';
import { kvGetJSON, kSeasonBootstrap, kSeasonElements, kSnapshotCurrent, kLeagueMembers, kLeagueStandings, kEntrySeason, kEntryState, kHealthStateSummary, isSeasonElements, isEntrySeason, isLeagueMembers, isLeagueStandings, cacheFirstKV, MAX_LEAGUE_SIZE } from '../lib/kv.js';
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
  //
  // SEASON ADDRESSING. Every /v1 artefact is reachable two ways:
  //   /v1/<artefact>          → the season the Worker detected (legacy form)
  //   /v1/<year>/<artefact>   → an explicit season, including closed ones
  // The season lives in the PATH, never a query param: cacheKeyFor strips the query
  // string by default, so ?season= would collide across seasons in the edge cache.
  //
  // ORDERING IS LOAD-BEARING — do not reorder or loosen the regex. The literal routes
  // /v1/season/bootstrap and /v1/season/elements put the word "season" in the SAME
  // positional slot that /v1/<year>/... uses for the year, so /v1/season/elements and
  // /v1/2025/elements are structurally identical: three segments, same shape. They only
  // fail to collide because "season" is not digits. The prefix is therefore matched with
  // an all-digits segment, and the token itself is validated by parseSeasonToken's
  // /^\d{4}$/ — never a bare Number(), which would also accept " 2025" and "2e3" and
  // then build a KV key that silently addresses nothing.
  //
  // A purely numeric second segment can only ever be a season attempt (the other /v1
  // routes are /entry, /league, /season), so a malformed one is a 400, not a 404.
  let requestedSeason = season;
  let v1Path = path;
  const seasonPrefix = path.match(/^\/v1\/(\d+)(\/.+)$/);
  if (seasonPrefix) {
    const parsed = parseSeasonToken(seasonPrefix[1]);
    if (parsed === null) {
      return json({
        error: "invalid_season",
        message: `Season must be a 4-digit year between ${MIN_SEASON} and ${maxSeason()} (e.g. 2025).`,
      }, 400);
    }
    requestedSeason = parsed;
    // Rewrite to the legacy path so one handler serves both forms. The globals live at
    // /v1/season/<x> unprefixed but /v1/<year>/<x> prefixed, hence the remap.
    const rest = seasonPrefix[2]; // "/entry/123" | "/bootstrap" | "/league/9/members"
    v1Path = (rest === "/bootstrap" || rest === "/elements") ? `/v1/season${rest}` : `/v1${rest}`;
  }

  // Entry season blob (all GWs for a single FPL team) — returns 202 if queued/building
  if (v1Path.startsWith("/v1/entry/")) {
    const parts = v1Path.split("/").filter(Boolean); // ["v1","entry",":id"]
    const entryId = Number(parts[2]);
    if (!Number.isInteger(entryId)) return json({ error: "Invalid entry id" }, 400);

    // Edge cache first (path-only key; no query). Keyed on the ORIGINAL request URL, so
    // the prefixed and unprefixed forms hold separate entries — as they must, since they
    // can resolve to different seasons.
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
    const kvKey = kEntrySeason(entryId, requestedSeason);
    const data = await kvGetJSON(env.FPL_PULSE_KV, kvKey);
    if (data) {
      if (!isEntrySeason(data)) return json({ error: "Invalid blob", key: kvKey }, 422);

      // Dynamic cache from the bootstrap of the season BEING REQUESTED, not the detected
      // one — a closed season's bootstrap has every event finished, which is what lands
      // the 30-day TTL branch that archived reads should get.
      const bootstrap = await kvGetJSON(env.FPL_PULSE_KV, kSeasonBootstrap(requestedSeason));
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
    const state = await kvGetJSON(env.FPL_PULSE_KV, kEntryState(entryId, requestedSeason));
    if (state && (state.status === "queued" || state.status === "building")) {
      return json({ status: state.status, last_gw_processed: state.last_gw_processed ?? 0 }, 202);
    }

    return json({ error: "Not found", key: kvKey }, 404);
  }

  // Season elements blob (all players' scores by GW)
  if (v1Path === "/v1/season/elements") {
    return cacheFirstKV(request, env, kSeasonElements(requestedSeason), isSeasonElements);
  }

  // Latest bootstrap blob (global game metadata)
  if (v1Path === "/v1/season/bootstrap") {
    return cacheFirstKV(request, env, kSeasonBootstrap(requestedSeason));
  }

  // League members (list of all entry IDs in a league) — enforce friends-only policy
  if (v1Path.startsWith("/v1/league/") && v1Path.endsWith("/members")) {
    const parts = v1Path.split("/").filter(Boolean); // ["v1","league",":id","members"]
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

    const members = await kvGetJSON(env.FPL_PULSE_KV, kLeagueMembers(leagueId, requestedSeason));
    if (!isLeagueMembers(members)) return json({ error: "Not found or invalid members", leagueId }, 404);
    if (members.length > MAX_LEAGUE_SIZE) {
      return json({ error: "league_too_large", message: `League has ${members.length} members (> ${MAX_LEAGUE_SIZE})` }, 403);
    }

    const resp = json(members, 200, { ...cacheHeaders(), "X-Cache": "MISS", "X-App-Version": env.APP_VERSION || "dev" });
    try { await cache.put(ck, resp.clone()); } catch {}
    return resp;
  }


  // Archived final league standings (league:<id>:<season>:standings).
  //
  // SERVES FINAL TABLES ONLY. `isLeagueStandings` requires `final` to be a boolean, not to
  // be true, so a provisional archive validates perfectly — and archiveLeagueStandings
  // writes one on every run between the last gameweek and FPL's rollover, overwriting it
  // each time until the season completes. Serving that at 200 alongside genuinely final
  // tables is "provisional standings that look authoritative": someone reads a rank that
  // is still moving and treats it as the season's result. Same corruption class as an
  // old league ID resolving to a stranger's league.
  //
  // Provisional is 202, not 404 or 422. 404 would claim nothing exists, which is false and
  // leaves the frontend's season dropdown unable to tell "never archived" from "still
  // settling". 422 is this codebase's "the stored blob is wrong". 202 already means
  // "being built, come back later" on /v1/entry/:id and the entries-pack, and that is
  // exactly what a provisional archive is — the same idiom, already handled by clients.
  //
  // Deliberately no MAX_LEAGUE_SIZE gate: the archive is capture-maximal by design and
  // stores untrimmed tables past 50 members (the AE64 benchmark league has 64). Applying
  // the friends-only read policy here would make that league's archive unreadable.
  //
  // Written out rather than routed through cacheFirstKV: that helper is a two-way
  // valid/invalid split and cannot express a third outcome that must not be cached.
  // Structure below mirrors it exactly so this stays one mechanism, not two.
  if (v1Path.startsWith("/v1/league/") && v1Path.endsWith("/standings")) {
    const parts = v1Path.split("/").filter(Boolean); // ["v1","league",":id","standings"]
    const leagueId = parts[2];
    if (!leagueId) return json({ error: "Missing league id" }, 400);

    const cache = caches.default;
    const ck = cacheKeyFor(request);
    const edge = await cache.match(ck);
    if (edge) {
      const r = new Response(edge.body, edge);
      r.headers.set("X-Cache", "HIT");
      r.headers.set("X-App-Version", env.APP_VERSION || "dev");
      return r;
    }

    const kvKey = kLeagueStandings(leagueId, requestedSeason);
    const data = await kvGetJSON(env.FPL_PULSE_KV, kvKey);
    if (!data) return json({ error: "Not found", key: kvKey }, 404);
    if (!isLeagueStandings(data)) return json({ error: "Invalid blob", key: kvKey }, 422);

    // Not cached — the next archive run may stamp this final, and the edge entry is
    // shared with HEAD.
    if (data.final !== true) {
      return json({
        status: "provisional",
        message: "Standings for this season are captured but not yet final.",
        leagueId: Number(leagueId),
        season: requestedSeason,
        harvested_at: data.harvested_at,
        member_count: data.member_count,
      }, 202);
    }

    const resp = json(data, 200, { ...cacheHeaders(), "X-Cache": "MISS", "X-App-Version": env.APP_VERSION || "dev" });
    try { await cache.put(ck, resp.clone()); } catch {}
    return resp;
  }

  // Pack route: single-page bulk fetch of entry blobs (no pagination)
  if (v1Path.startsWith("/v1/league/") && v1Path.endsWith("/entries-pack")) {
    const parts = v1Path.split("/").filter(Boolean); // ["v1","league",":id","entries-pack"]
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
    const members = await kvGetJSON(env.FPL_PULSE_KV, kLeagueMembers(leagueId, requestedSeason));
    if (!isLeagueMembers(members)) return json({ error: "Not found or invalid members", leagueId }, 404);

    // Friends-only policy: refuse large leagues outright
    if (members.length > MAX_LEAGUE_SIZE) {
      return json({ error: "league_too_large", message: `League has ${members.length} members (> ${MAX_LEAGUE_SIZE})` }, 403);
    }

    // No pagination by policy; serve all (<= 50)
    const slice = members; // already <= 50


    // Batch KV reads
    const keys = slice.map((id) => kEntrySeason(id, requestedSeason));
    const reads = await Promise.all(keys.map((key) => kvGetJSON(env.FPL_PULSE_KV, key)));

    // Assemble payload
    const entries = {};
    slice.forEach((entryId, i) => {
      const blob = reads[i];
      if (blob && isEntrySeason(blob)) entries[entryId] = blob;
    });

    // A non-empty roster that resolves ZERO blobs is not a legitimate 200. The frontend's
    // validation accepts { members: [...], entries: {} } and renders an empty league, so
    // returning 200 here turns a data fault into a silently blank page. SOME blobs
    // missing is legitimate (a new joiner not yet built) and stays a 200 with those
    // members simply absent from `entries` — only the total-miss case is a fault.
    //
    // The two causes need different answers, and entry state is what separates them:
    //   builds pending  → 202, mirroring what /v1/entry/:id returns for one entry
    //   nothing pending → 422, a season/league mismatch or a wiped season
    //
    // NEITHER is cached. cacheKeyFor forces method GET, so HEAD and GET share one edge
    // entry — caching a transient 202 or a 422 would pin it for both probes.
    if (slice.length > 0 && Object.keys(entries).length === 0) {
      const states = await Promise.all(
        slice.map((id) => kvGetJSON(env.FPL_PULSE_KV, kEntryState(id, requestedSeason)))
      );
      const pending = states.filter((s) => s && (s.status === "queued" || s.status === "building"));
      if (pending.length > 0) {
        return json({
          status: pending.some((s) => s.status === "building") ? "building" : "queued",
          last_gw_processed: Math.max(0, ...pending.map((s) => s.last_gw_processed ?? 0)),
          pending: pending.length,
          total: slice.length,
        }, 202);
      }
      log.warn("public", "entries_pack_empty", { league_id: leagueId, season: requestedSeason, member_count: slice.length });
      return json({
        error: "no_entries_for_season",
        message: `League ${leagueId} has ${slice.length} members for season ${requestedSeason} but no entry data, and none is being built.`,
        leagueId,
        season: requestedSeason,
        member_count: slice.length,
      }, 422);
    }

    const payload = {
      members: slice,
      entries,
      meta: {
        count: slice.length,
        capped: members.length > slice.length,
        total_members: members.length,
      },
    };

    // Dynamic cache from the REQUESTED season's bootstrap, not the detected one.
    const bootstrap = await kvGetJSON(env.FPL_PULSE_KV, kSeasonBootstrap(requestedSeason));
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

  // GET /fpl/league/:id → proxy to FPL league standings (edge-cached so warmCache can purge it)
  if (path.match(/^\/fpl\/league\/\d+$/)) {
    const leagueId = path.split("/")[3];
    const cache = caches.default;
    const ck = cacheKeyFor(request);
    const edge = await cache.match(ck);
    if (edge) {
      const r = new Response(edge.body, edge);
      r.headers.set("X-Cache", "HIT");
      r.headers.set("X-App-Version", env.APP_VERSION || "dev");
      return r;
    }
    try {
      const standings = await fetchJsonWithRetry(
        `https://fantasy.premierleague.com/api/leagues-classic/${leagueId}/standings/?page_standings=1`
      );
      const resp = json(standings, 200, { ...cacheHeaders(), ...CORS, "X-Cache": "MISS", "X-App-Version": env.APP_VERSION || "dev" });
      try { await cache.put(ck, resp.clone()); } catch {}
      return resp;
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
