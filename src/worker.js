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

// Dynamic cache TTL based on gameweek state
// Returns shorter TTL during active GW, longer for finished GWs
const dynamicCacheHeaders = (bootstrap = null) => {
  if (!bootstrap?.events) return cacheHeaders(); // Default 7 days

  // Check if there's an active (ongoing) gameweek
  const activeGW = bootstrap.events.find(e => e?.is_current === true && e?.finished === false);

  if (activeGW) {
    // Active GW: use shorter cache (6 hours) for fresher data
    return cacheHeaders(6 * 3600, 3600); // 6h cache, 1h SWR
  }

  // No active GW: use standard long cache (7 days)
  return cacheHeaders(); // 7 days
};

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

// === Circuit breaker for FPL API ===
// Prevents hammering FPL API when it's down
const circuitBreaker = {
  failures: 0,
  openUntil: 0,
  maxFailures: 5,
  resetTimeout: 15 * 60 * 1000, // 15 minutes

  isOpen() {
    if (this.openUntil > 0 && Date.now() < this.openUntil) {
      return true;
    }
    if (this.openUntil > 0 && Date.now() >= this.openUntil) {
      // Circuit breaker timeout expired, reset
      this.reset();
    }
    return false;
  },

  recordFailure() {
    this.failures++;
    if (this.failures >= this.maxFailures) {
      this.openUntil = Date.now() + this.resetTimeout;
      console.error(`Circuit breaker OPEN - FPL API failures: ${this.failures}, waiting ${this.resetTimeout / 60000}min`);
    }
  },

  recordSuccess() {
    if (this.failures > 0) {
      this.failures = Math.max(0, this.failures - 1); // Gradual recovery
    }
  },

  reset() {
    this.failures = 0;
    this.openUntil = 0;
    console.log('Circuit breaker RESET - FPL API recovered');
  }
};

// === Backfill helpers (Phase 5: one-entry test) ===
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJsonWithRetry(url, tries = 3, baseDelay = 200) {
  // Check circuit breaker before making request
  if (circuitBreaker.isOpen()) {
    throw new Error(`Circuit breaker OPEN - FPL API temporarily unavailable`);
  }

  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { "Accept": "application/json" }, cf: { cacheEverything: false } });

      // Handle rate limiting and service unavailability
      if (res.status === 429 || res.status === 503) {
        const retryAfter = res.headers.get("Retry-After");
        const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : Math.min(baseDelay * Math.pow(2, i + 2), 10000);
        console.warn(`Rate limited or service unavailable (${res.status}) for ${url}, waiting ${waitMs}ms`);
        circuitBreaker.recordFailure();
        if (i < tries - 1) await sleep(waitMs);
        lastErr = new Error(`HTTP ${res.status} for ${url}`);
        continue;
      }

      if (!res.ok) {
        circuitBreaker.recordFailure();
        throw new Error(`HTTP ${res.status} for ${url}`);
      }

      // Success - record it for circuit breaker
      circuitBreaker.recordSuccess();
      return await res.json();
    } catch (err) {
      lastErr = err;
      circuitBreaker.recordFailure();
      if (i < tries - 1) await sleep(baseDelay * Math.pow(2, i)); // 200ms, 400ms, 800ms
    }
  }
  throw lastErr;
}

// Build a single entry season blob (summary + history + transfers + picks 1..targetGW)
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
    // 0) ENTRY SUMMARY (names, leagues, etc.)
    const summary = await fetchJsonWithRetry(
      `https://fantasy.premierleague.com/api/entry/${entryId}/`
    );

    // 1) HISTORY
    const hist = await fetchJsonWithRetry(
      `https://fantasy.premierleague.com/api/entry/${entryId}/history/`
    );
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
    const transfersRaw = await fetchJsonWithRetry(
      `https://fantasy.premierleague.com/api/entry/${entryId}/transfers/`
    );
    const transfers = Array.isArray(transfersRaw)
      ? transfersRaw.map(t => ({
          event: Number(t?.event ?? 0),
          element_in: Number(t?.element_in ?? 0),
          element_out: Number(t?.element_out ?? 0),
          cost: Number(t?.cost ?? 0),
          time: t?.time || null,
        }))
      : [];

    // 3) PICKS BY GW (1..targetGW)
    // Smart partial backfill: check if we have an existing blob and only fetch missing GWs
    const existingBlob = await kvGetJSON(kv, seasonKey);
    const picks_by_gw = (existingBlob && typeof existingBlob.picks_by_gw === "object")
      ? { ...existingBlob.picks_by_gw }
      : {};

    const startGW = existingBlob?.last_gw_processed
      ? Math.min(existingBlob.last_gw_processed + 1, targetGW)
      : 1;

    // Only fetch GWs we don't already have
    for (let gw = startGW; gw <= targetGW; gw++) {
      if (picks_by_gw[gw]) continue; // Skip if we already have this GW

      const p = await fetchJsonWithRetry(
        `https://fantasy.premierleague.com/api/entry/${entryId}/event/${gw}/picks/`
      );
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

    // If this is a partial update and we're missing early GWs, backfill them too
    if (existingBlob && startGW > 1) {
      for (let gw = 1; gw < startGW; gw++) {
        if (picks_by_gw[gw]) continue; // Skip if we already have this GW

        const p = await fetchJsonWithRetry(
          `https://fantasy.premierleague.com/api/entry/${entryId}/event/${gw}/picks/`
        );
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
      // New: store full entry summary + refresh timestamps
      summary,
      summary_last_refreshed_at: nowIso,
      transfers_last_refreshed_at: nowIso,
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

// === Phase 6: harvest helpers ===
async function fetchBootstrap() {
  return fetchJsonWithRetry("https://fantasy.premierleague.com/api/bootstrap-static/");
}

function detectLatestFinishedGW(bootstrap) {
  const done = Array.isArray(bootstrap?.events)
    ? bootstrap.events.filter(e => e?.finished === true && e?.data_checked === true)
    : [];
  if (!done.length) return null;
  return Math.max(...done.map(e => Number(e.id)).filter(Number.isFinite));
}

async function appendElementsForGW(env, season, gw) {
  const key = kSeasonElements(season);
  const cur = (await kvGetJSON(env.FPL_PULSE_KV, key)) || { last_gw_processed: 0, gws: {} };
  if (!cur.gws || typeof cur.gws !== "object") cur.gws = {};
  if (cur.gws[gw]) return { wrote: false, reason: "already_present" };

  const live = await fetchJsonWithRetry(`https://fantasy.premierleague.com/api/event/${gw}/live/`);
  cur.gws[gw] = live;
  cur.last_gw_processed = Math.max(Number(cur.last_gw_processed || 0), gw);
  await kvPutJSON(env.FPL_PULSE_KV, key, cur);
  return { wrote: true };
}

async function updateEntryForGW(env, season, entryId, gw) {
  const seasonKey = kEntrySeason(entryId, season);
  const blob = await kvGetJSON(env.FPL_PULSE_KV, seasonKey);
  if (!blob || typeof blob !== "object") return { updated: false, reason: "no_blob" };

  let changed = false;

  // --- GW summary for this event ---
  if (!blob.gw_summaries || typeof blob.gw_summaries !== "object") blob.gw_summaries = {};
  if (!blob.gw_summaries[gw]) {
    const hist = await fetchJsonWithRetry(
      `https://fantasy.premierleague.com/api/entry/${entryId}/history/`
    );
    const row = Array.isArray(hist?.current)
      ? hist.current.find(r => Number(r?.event) === gw)
      : null;
    if (row) {
      blob.gw_summaries[gw] = {
        points: Number(row.points ?? 0),
        total: Number(row.total_points ?? row.total ?? 0),
        gw_rank: Number(row.rank ?? 0),
        overall_rank: Number(row.overall_rank ?? 0),
        value: Number(row.value ?? 0),
        bank: Number(row.bank ?? 0),
        chip: row?.chip || null,
      };
      changed = true;
    }
  }

  // --- Picks for this event ---
  if (!blob.picks_by_gw || typeof blob.picks_by_gw !== "object") blob.picks_by_gw = {};
  if (!blob.picks_by_gw[gw]) {
    const picks = await fetchJsonWithRetry(
      `https://fantasy.premierleague.com/api/entry/${entryId}/event/${gw}/picks/`
    );
    const arr = Array.isArray(picks?.picks) ? picks.picks : [];
    blob.picks_by_gw[gw] = {
      active_chip: picks?.active_chip ?? null,
      picks: arr.map(px => ({
        element: Number(px?.element ?? 0),
        position: Number(px?.position ?? 0),
        is_captain: Boolean(px?.is_captain),
        is_vice: Boolean(px?.is_vice_captain || px?.is_vice),
      })),
    };
    changed = true;
  }

  // --- Refresh transfers so they stay up to date ---
  // Only refresh if stale (>6 hours) to reduce API calls
  const transfersLastRefreshed = blob.transfers_last_refreshed_at
    ? Date.parse(blob.transfers_last_refreshed_at)
    : 0;
  const transfersStale = !blob.transfers_last_refreshed_at ||
    (Date.now() - transfersLastRefreshed) > 6 * 3600 * 1000;

  if (transfersStale) {
    try {
      const transfersRaw = await fetchJsonWithRetry(
        `https://fantasy.premierleague.com/api/entry/${entryId}/transfers/`
      );
      const transfers = Array.isArray(transfersRaw)
        ? transfersRaw.map(t => ({
            event: Number(t?.event ?? 0),
            element_in: Number(t?.element_in ?? 0),
            element_out: Number(t?.element_out ?? 0),
            cost: Number(t?.cost ?? 0),
            time: t?.time || null,
          }))
        : [];

      const prevLen = Array.isArray(blob.transfers) ? blob.transfers.length : 0;
      blob.transfers = transfers;
      blob.transfers_last_refreshed_at = new Date().toISOString();
      if (transfers.length !== prevLen) {
        changed = true;
      }
    } catch (err) {
      console.warn(
        `Failed to refresh transfers for entry ${entryId}:`,
        String(err?.message || err)
      );
    }
  }

  // --- Refresh summary (names, leagues, etc.) ---
  // Only refresh if stale (>12 hours) - summary data rarely changes
  const summaryLastRefreshed = blob.summary_last_refreshed_at
    ? Date.parse(blob.summary_last_refreshed_at)
    : 0;
  const summaryStale = !blob.summary_last_refreshed_at ||
    (Date.now() - summaryLastRefreshed) > 12 * 3600 * 1000;

  if (summaryStale) {
    try {
      const summary = await fetchJsonWithRetry(
        `https://fantasy.premierleague.com/api/entry/${entryId}/`
      );
      blob.summary = summary;
      blob.summary_last_refreshed_at = new Date().toISOString();
      changed = true; // small blob; fine to treat as changed
    } catch (err) {
      console.warn(
        `Failed to refresh summary for entry ${entryId}:`,
        String(err?.message || err)
      );
    }
  }

  if (changed) {
    blob.last_gw_processed = Math.max(Number(blob.last_gw_processed || 0), gw);
    blob.updated_at = new Date().toISOString();
    await kvPutJSON(env.FPL_PULSE_KV, seasonKey, blob);
  }

  return { updated: changed };
}

async function updateSnapshot(env, season, gw) {
  await kvPutJSON(env.FPL_PULSE_KV, kSnapshotCurrent, { season: Number(season), last_gw: Number(gw) });
}

async function harvestIfNeeded(env, { delaySec = 0 } = {}) {
  const season = Number(env.SEASON || 2025);
  const t0 = Date.now();

  const bootstrap = await fetchBootstrap();
  const prevId = detectLatestFinishedGW(bootstrap);
  if (!Number.isInteger(prevId)) return { status: "noop", reason: "no_finished_gw" };

  const snap = (await kvGetJSON(env.FPL_PULSE_KV, kSnapshotCurrent)) || { season, last_gw: 0 };
  if (Number(snap.last_gw || 0) >= prevId) {
    return { status: "noop", reason: "already_up_to_date", last_gw: snap.last_gw };
  }

  if (delaySec && delaySec > 0) {
    return { status: "delayed", recommend_reinvoke_after_sec: delaySec, candidate_gw: prevId };
  }

  await kvPutJSON(env.FPL_PULSE_KV, kSeasonBootstrap(season), bootstrap);
  await appendElementsForGW(env, season, prevId);

  // Harvest optimization: batch KV list reads and process in parallel
  let cursor;
  const concurrency = 5;
  const pending = [];
  let processedCount = 0;
  const allEntryIds = [];

  // First, collect all entry IDs that need updating
  do {
    const page = await env.FPL_PULSE_KV.list({ prefix: "entry:", cursor, limit: 100 });
    cursor = page.cursor;

    for (const k of page.keys) {
      if (!k.name.endsWith(`:${season}`)) continue; // only complete blobs
      const id = Number(k.name.split(":")[1]);
      if (!Number.isInteger(id)) continue;
      allEntryIds.push(id);
    }
  } while (cursor);

  // Now process entries in batches with time budget
  for (const id of allEntryIds) {
    if ((Date.now() - t0) > 25_000) {
      console.warn(`Harvest timeout approaching, processed ${processedCount}/${allEntryIds.length} entries`);
      break;
    }

    pending.push(updateEntryForGW(env, season, id, prevId).then(() => { processedCount++; }));

    if (pending.length >= concurrency) {
      await Promise.all(pending.splice(0));
    }
  }

  if (pending.length) await Promise.all(pending);

  console.log(`Harvest completed: ${processedCount}/${allEntryIds.length} entries updated in ${Date.now() - t0}ms`);

  await updateSnapshot(env, season, prevId);
  return { status: "ok", last_gw: prevId };
}

// === Phase 7: cache warm helper ===
async function warmCache(env) {
  const base = "https://fpl-pulse.ciaranbrennan18.workers.dev";
  const season = Number(env.SEASON || 2025);
  const cache = caches.default;
  const warmed = [];

  // Warm global endpoints
  const globals = [
    `${base}/v1/season/elements`,
    `${base}/v1/season/bootstrap`
  ];

  for (const url of globals) {
    const req = new Request(url);
    const resp = await fetch(req);
    if (resp.ok) await cache.put(req, resp.clone());
    warmed.push(url);
  }

  // Warm top league entries (optional)
  const LEAGUE_ID = env.WARM_LEAGUE_ID || null; // optional env var
  if (LEAGUE_ID) {
    const members = await kvGetJSON(env.FPL_PULSE_KV, kLeagueMembers(LEAGUE_ID));
    if (Array.isArray(members)) {
      const slice = members.slice(0, 10);
      for (const id of slice) {
        const u = `${base}/v1/entry/${id}`;
        const req = new Request(u);
        const resp = await fetch(req);
        if (resp.ok) await cache.put(req, resp.clone());
        warmed.push(u);
      }
      const pack = `${base}/v1/league/${LEAGUE_ID}/entries-pack`;
      const r = await fetch(pack);
      if (r.ok) await cache.put(new Request(pack), r.clone());
      warmed.push(pack);
    }
  }

  return { status: "ok", warmed };
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

    // Detailed health check endpoint
    if (path === "/health/detailed") {
      try {
        const snapshot = await kvGetJSON(env.FPL_PULSE_KV, kSnapshotCurrent);
        const bootstrap = await kvGetJSON(env.FPL_PULSE_KV, kSeasonBootstrap(season));

        // Count errored entries
        let erroredCount = 0;
        let queuedCount = 0;
        let buildingCount = 0;
        let completeCount = 0;

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
            }
          }

          // Limit scan to prevent timeout
          if (erroredCount + queuedCount + buildingCount + completeCount > 200) break;
        } while (cursor);

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
          entries: {
            errored: erroredCount,
            queued: queuedCount,
            building: buildingCount,
            complete: completeCount,
            total: erroredCount + queuedCount + buildingCount + completeCount,
          },
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

      // POST /admin/entry/:entryId/force-rebuild
      // Force a full rebuild of a single entry blob, even if already complete
      if (path.startsWith("/admin/entry/") && path.endsWith("/force-rebuild")) {
        const parts = path.split("/").filter(Boolean); // ["admin","entry",":id","force-rebuild"]
        const entryId = Number(parts[2]);
        if (!Number.isInteger(entryId)) return json({ error: "Invalid entry id" }, 400);

        const seasonNum = Number(env.SEASON || 2025);
        const stateKey = kEntryState(entryId, seasonNum);
        const seasonKey = kEntrySeason(entryId, seasonNum);

        // Read any existing state (if present)
        const existingState = await kvGetJSON(env.FPL_PULSE_KV, stateKey);

        // Always set to queued, resetting last_gw_processed to 0 so we rebuild from scratch
        await kvPutJSON(env.FPL_PULSE_KV, stateKey, {
          status: "queued",
          last_gw_processed: 0,
          updated_at: new Date().toISOString(),
          version: (existingState?.version ?? 0) + 1,
        });

        // Optionally keep or overwrite the old blob; processEntryOnce will overwrite anyway
        const result = await processEntryOnce(entryId, seasonNum, env.FPL_PULSE_KV);
        return json({ ok: !!result.ok, mode: "force-rebuild", result }, result.ok ? 200 : 207);
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
  // Run harvest; also write a heartbeat key
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        await env.FPL_PULSE_KV.put(`heartbeat:${new Date(event.scheduledTime).toISOString()}`, "1", { expirationTtl: 3600 });
      } catch {}
      try {
        await harvestIfNeeded(env);
      } catch {}
    })());
  },
};