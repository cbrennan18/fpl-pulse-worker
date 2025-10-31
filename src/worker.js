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

// === Backfill helpers (Phase 5: one-entry test) ===
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJsonWithRetry(url, tries = 3, baseDelay = 200) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { "Accept": "application/json" }, cf: { cacheEverything: false } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (i < tries - 1) await sleep(baseDelay * Math.pow(2, i)); // 200ms, 400ms, 800ms
    }
  }
  throw lastErr;
}

// Build a single entry season blob (history + transfers + picks 1..targetGW)
async function processEntryOnce(entryId, season, kv) {
  const nowIso = new Date().toISOString();
  const stateKey = kEntryState(entryId, season);
  const seasonKey = kEntrySeason(entryId, season);

  // Read state and guard (+ stale-building reset)
  let state = await kvGetJSON(kv, stateKey);
  if (!state) {
    return { ok: false, reason: "not_queued", entryId };
  }

  // If stuck in "building" for > 60 minutes, reset to queued
  if (state.status === "building") {
    const started = state.worker_started_at ? Date.parse(state.worker_started_at) : 0;
    const ageMs = Date.now() - (isNaN(started) ? 0 : started);
    if (ageMs > 60 * 60 * 1000) {
      state = {
        status: "queued",
        last_gw_processed: state.last_gw_processed ?? 0,
        updated_at: new Date().toISOString(),
        version: (state.version ?? 0) + 1,
      };
      await kvPutJSON(kv, stateKey, state);
    }
  }

  if (state.status !== "queued" && state.status !== "building") {
    return { ok: false, reason: "not_queued", entryId };
  }

  // Mark building
  await kvPutJSON(kv, stateKey, {
    status: "building",
    last_gw_processed: state.last_gw_processed ?? 0,
    worker_started_at: nowIso,
    attempts: (state.attempts || 0) + 1,
    updated_at: nowIso,
  });

  try {
    // 1) HISTORY
    const hist = await fetchJsonWithRetry(`https://fantasy.premierleague.com/api/entry/${entryId}/history/`);
    const current = Array.isArray(hist?.current) ? hist.current : [];
    if (current.length === 0) throw new Error("empty_history");

    // Build gw_summaries and find target GW
    const gw_summaries = {};
    let targetGW = 0;
    for (const row of current) {
      const gw = Number(row?.event);
      if (!Number.isInteger(gw)) continue;
      targetGW = Math.max(targetGW, gw);
      gw_summaries[gw] = {
        points: Number(row.points ?? 0),
        total: Number(row.total_points ?? row.total ?? 0),
        gw_rank: Number(row.rank ?? 0),
        overall_rank: Number(row.overall_rank ?? 0),
        value: Number(row.value ?? 0), // FPL returns x10; keep as-is for now
        bank: Number(row.bank ?? 0),   // x10; keep as-is
        chip: row?.chip || null,
      };
    }
    if (targetGW <= 0) throw new Error("no_target_gw");

    // 2) TRANSFERS
    const transfersRaw = await fetchJsonWithRetry(`https://fantasy.premierleague.com/api/entry/${entryId}/transfers/`);
    const transfers = Array.isArray(transfersRaw) ? transfersRaw.map(t => ({
      event: Number(t?.event ?? 0),
      element_in: Number(t?.element_in ?? 0),
      element_out: Number(t?.element_out ?? 0),
      cost: Number(t?.cost ?? 0),
      time: t?.time || null,
    })) : [];

    // 3) PICKS BY GW (1..targetGW)
    const picks_by_gw = {};
    for (let gw = 1; gw <= targetGW; gw++) {
      const p = await fetchJsonWithRetry(`https://fantasy.premierleague.com/api/entry/${entryId}/event/${gw}/picks/`);
      const picksArr = Array.isArray(p?.picks) ? p.picks : [];
      picks_by_gw[gw] = {
        active_chip: p?.active_chip ?? null,
        picks: picksArr.map(px => ({
          element: Number(px?.element ?? 0),
          position: Number(px?.position ?? 0),
          is_captain: Boolean(px?.is_captain),
          is_vice: Boolean(px?.is_vice_captain || px?.is_vice),
        })),
      };
    }

    // 4) Assemble final blob
    const blob = {
      entry_id: Number(entryId),
      season: Number(season),
      last_gw_processed: Number(targetGW),
      updated_at: nowIso,
      version: 1,
      gw_summaries,
      picks_by_gw,
      transfers,
    };

    // 5) Write blob, then mark complete
    await kvPutJSON(kv, seasonKey, blob);
    await kvPutJSON(kv, stateKey, {
      status: "complete",
      last_gw_processed: targetGW,
      updated_at: new Date().toISOString(),
      attempts: (state.attempts || 0) + 1,
    });

    return { ok: true, entryId, targetGW };
  } catch (err) {
    // Mark errored (non-fatal for the worker)
    await kvPutJSON(kv, stateKey, {
      status: "errored",
      error: String(err?.message || err),
      updated_at: new Date().toISOString(),
      attempts: (state?.attempts || 0) + 1,
    });
    return { ok: false, reason: "error", entryId, error: String(err?.message || err) };
  }
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

        const seasonNum = Number(env.SEASON || 2025);
        const stateKey = kEntryState(entryId, seasonNum);
        const seasonKey = kEntrySeason(entryId, seasonNum);

        const [existingBlob, existingState] = await Promise.all([
          env.FPL_PULSE_KV.get(seasonKey),
          kvGetJSON(env.FPL_PULSE_KV, stateKey),
        ]);

        // If blob already exists, no need to enqueue
        if (existingBlob) return json({ ok: true, status: "already_complete", entryId }, 200);

        // If state exists and is queued/building, don’t double-enqueue
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

        return json({ ok: true, status: "queued", entryId }, 200);
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

      // POST /admin/backfill?single=true&entry=<id>
      // Minimal one-entry backfill for testing
      // POST /admin/backfill
      // Modes:
      //   - single:  /admin/backfill?single=true&entry=<id>
      //   - batch:   /admin/backfill?limit=5[&leagueId=<id>]
      if (path === "/admin/backfill") {
        const u = new URL(request.url);
        const season = Number(env.SEASON || 2025);

        // --- single mode (preserve existing) ---
        const single = u.searchParams.get("single") === "true";
        const entryParam = u.searchParams.get("entry");
        if (single) {
          const entryId = Number(entryParam);
          if (!Number.isInteger(entryId)) {
            return json({ error: "missing_or_invalid_entry", hint: "provide ?entry=<number>" }, 400);
          }
          // Ensure state exists
          const stateKey = kEntryState(entryId, season);
          const existingState = await kvGetJSON(env.FPL_PULSE_KV, stateKey);
          if (!existingState) {
            await kvPutJSON(env.FPL_PULSE_KV, stateKey, {
              status: "queued",
              last_gw_processed: 0,
              updated_at: new Date().toISOString(),
              version: 1,
            });
          }
          const result = await processEntryOnce(entryId, season, env.FPL_PULSE_KV);
          return json({ ok: !!result.ok, mode: "single", result }, result.ok ? 200 : 207);
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
              if (k.name.endsWith(`:${season}:state`)) {
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
          const st = await kvGetJSON(env.FPL_PULSE_KV, kEntryState(id, season));
          if (st && st.status === "queued") queued.push(id);
        }

        // Process sequentially (safe)
        const results = [];
        for (const id of queued) {
          const r = await processEntryOnce(id, season, env.FPL_PULSE_KV);
          results.push(r);
        }

        const summary = {
          ok: true,
          mode: "batch",
          leagueId: leagueId || null,
          requested: limit,
          processed: results.length,
          succeeded: results.filter(r => r.ok).length,
          errored: results.filter(r => !r.ok).length,
          ids: queued,
        };
        return json(summary, 200);
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