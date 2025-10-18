// === CORS setup ===
// Ensures our API can be called from any client (browser, React app, etc.)
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS, HEAD, POST",
  "Access-Control-Allow-Headers": "*",
};

// === Response helpers ===
// Utility functions to standardise JSON and text responses
const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, ...extra },
  });
const text = (s, status = 200) =>
  new Response(s, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS } });

// === Cache helpers ===
// Normalize the request URL (strip querystrings) so cache keys are consistent
const cacheKeyFor = (request, { keepQuery = false } = {}) => {
  const u = new URL(request.url);
  if (!keepQuery) u.search = ""; // strip by default
  return new Request(u.toString(), { method: "GET" });
};
// Standard cache headers: 7 days freshness + 1 day stale-while-revalidate
const cacheHeaders = (ttl = 604800, swr = 86400) => ({
  "Cache-Control": `public, s-maxage=${ttl}, stale-while-revalidate=${swr}`,
});

// === KV JSON helpers ===
// Get and Put JSON in KV with consistent behaviour
async function kvGetJSON(kv, key) {
  const v = await kv.get(key, { type: "json" });
  return v ?? null;
}
async function kvPutJSON(kv, key, value) {
  return kv.put(key, JSON.stringify(value));
}

// === Key builders (Phase 1 data model) ===
// These functions generate consistent KV keys for each object we store
const kSeasonBootstrap = (season) => `season:${season}:bootstrap`;
const kSeasonElements  = (season) => `season:${season}:elements`;
const kSnapshotCurrent = `snapshot:current`;
const kLeagueMembers   = (leagueId) => `league:${leagueId}:members`;
const kEntrySeason     = (entryId, season) => `entry:${entryId}:${season}`;
const kEntryState      = (entryId, season) => `entry:${entryId}:${season}:state`;

// === Minimal schema guards ===
// These ensure the blobs we read back from KV are valid JSON objects
const isSeasonElements = (x) =>
  x && typeof x === "object" && typeof x.last_gw_processed === "number" && x.gws && typeof x.gws === "object";

const isEntrySeason = (x) =>
  x && typeof x === "object" &&
  typeof x.entry_id === "number" &&
  typeof x.season === "number" &&
  typeof x.last_gw_processed === "number" &&
  x.gw_summaries && typeof x.gw_summaries === "object" &&
  x.picks_by_gw && typeof x.picks_by_gw === "object" &&
  Array.isArray(x.transfers);

const isLeagueMembers = (x) => Array.isArray(x) && x.every((n) => Number.isInteger(n));

// === Edge-first read from KV ===
// First try the Cloudflare Edge cache → if MISS, fall back to KV → then repopulate edge
async function cacheFirstKV(request, env, kvKey, validator = null) {
  const cache = caches.default;
  const ck = cacheKeyFor(request);

  // 1) Edge cache check
  const edge = await cache.match(ck);
  if (edge) {
    const r = new Response(edge.body, edge);
    r.headers.set("X-Cache", "HIT");
    r.headers.set("X-App-Version", env.APP_VERSION || "dev");
    return r;
  }

  // 2) KV lookup
  const data = await kvGetJSON(env.FPL_PULSE_KV, kvKey);
  if (!data) return json({ error: "Not found", key: kvKey }, 404);

  // 3) Validate blob if schema guard provided
  if (validator && !validator(data)) {
    return json({ error: "Invalid blob", key: kvKey }, 422);
  }

  // 4) Build response + repopulate edge
  const resp = json(data, 200, {
    ...cacheHeaders(),
    "X-Cache": "MISS",
    "X-App-Version": env.APP_VERSION || "dev",
  });
  try { await cache.put(ck, resp.clone()); } catch {}
  return resp;
}

// === Admin auth helper (Phase 3) ===
// Accepts ?token=... or X-Refresh-Token header and compares to env.REFRESH_TOKEN
const isAuthorized = (request, env) => {
  const u = new URL(request.url);
  const token = u.searchParams.get("token") || request.headers.get("x-refresh-token");
  return Boolean(token && token === env.REFRESH_TOKEN);
};

// === FPL fetch helper (Phase 4) ===
async function fetchJson(url, init = {}) {
  const res = await fetch(url, {
    method: "GET",
    headers: { "Accept": "application/json", ...(init.headers || {}) },
    cf: { cacheEverything: false }, // no edge cache on admin fetches
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`FPL fetch failed ${res.status} ${res.statusText} :: ${url} :: ${txt.slice(0,200)}`);
  }
  return res.json();
}

// === Limits === (already added earlier; keep here if missing)
const MAX_LEAGUE_SIZE = 50; // friends-only mini leagues


// === Worker export ===
// This is the entrypoint for HTTP requests + scheduled cron events
export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname;
    const season = Number(env.SEASON || 2025);

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
        const resp = json(data, 200, { ...cacheHeaders(), "X-Cache": "MISS", "X-App-Version": env.APP_VERSION || "dev" });
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

    // Season elements blob (all players’ scores by GW)
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

      const resp = json(payload, 200, { ...cacheHeaders(), "X-Cache": "MISS", "X-App-Version": env.APP_VERSION || "dev" });
      try { await cache.put(ck, resp.clone()); } catch {}
      return resp;
    }

    // === Admin endpoints (Phase 3 scaffold; all require REFRESH_TOKEN) ===
    if (path.startsWith("/admin/")) {
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      if (!isAuthorized(request, env)) return json({ error: "Unauthorized" }, 401);

      // POST /admin/league/:leagueId/ingest  (Phase 4)
      if (path.startsWith("/admin/league/") && path.endsWith("/ingest")) {
        const parts = path.split("/").filter(Boolean); // ["admin","league",":id","ingest"]
        const leagueIdStr = parts[2];
        const leagueId = Number(leagueIdStr);
        if (!leagueIdStr) return json({ error: "Missing league id" }, 400);
        if (!Number.isInteger(leagueId) || leagueId <= 0) return json({ error: "Invalid league id" }, 400);

        const season = Number(env.SEASON || 2025);
        const BASE = `https://fantasy.premierleague.com/api/leagues-classic/${leagueId}/standings/`;

        // Pull standings pages until we collect <= MAX_LEAGUE_SIZE entries or there are no more pages
        // FPL classic standings page size is typically 50; enforce hard policy at 50 total.
        const members = [];
        let page = 1;
        while (true) {
          const url = page === 1 ? BASE : `${BASE}?page_standings=${page}`;
          const data = await fetchJson(url);

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
          const seasonKey = kEntrySeason(entryId, season);
          const stateKey  = kEntryState(entryId, season);

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

        return json({
          ok: true,
          leagueId,
          members_count: uniqueMembers.length,
          queued_count: queuedCount
        }, 200);
      }

      // POST /admin/entry/:entryId/enqueue
      if (path.startsWith("/admin/entry/") && path.endsWith("/enqueue")) {
        const parts = path.split("/").filter(Boolean); // ["admin","entry",":id","enqueue"]
        const entryId = Number(parts[2]);
        if (!Number.isInteger(entryId)) return json({ error: "Invalid entry id" }, 400);
        // TODO Phase 5: set entry:<id>:<SEASON>:state = {status:"queued", ...}
        return json({ ok: true, action: "enqueue", entryId }, 501);
      }

      // POST /admin/harvest
      if (path === "/admin/harvest") {
        // TODO Phase 6: detect finished GW, append elements + update entries, write snapshot:current
        return json({ ok: true, action: "harvest" }, 501);
      }

      // POST /admin/warm
      if (path === "/admin/warm") {
        // TODO Phase 7: pre-populate edge cache for hot resources
        return json({ ok: true, action: "warm" }, 501);
      }

      return json({ error: "Admin route not found" }, 404);
    }


    // Fallback
    return text("Not found", 404);
  },

  // === Cron handler ===
  // For now: write a heartbeat key to KV every scheduled run
  async scheduled(event, env, ctx) {
    try {
      await env.FPL_PULSE_KV.put(`heartbeat:${new Date(event.scheduledTime).toISOString()}`, "1", { expirationTtl: 3600 });
    } catch {}
  },
};