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

    // League members (list of all entry IDs in a league)
    if (path.startsWith("/v1/league/") && path.endsWith("/members")) {
      const parts = path.split("/").filter(Boolean); // ["v1","league",":id","members"]
      const leagueId = parts[2];
      if (!leagueId) return json({ error: "Missing league id" }, 400);
      return cacheFirstKV(request, env, kLeagueMembers(leagueId), isLeagueMembers);
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

      // Hard cap to protect response size & KV fan-out (tune as needed)
      const CAP = 150;
      const slice = members.slice(0, CAP);

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

    // Admin endpoints (not yet implemented)
    if (path.startsWith("/admin/")) return text("Not implemented yet", 501);

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