// === Season constants and parsing ===

// Last-resort season. DERIVED, not a literal — a hardcoded year is wrong from the moment
// someone forgets to bump it, which is the exact failure this replaced four copies of.
//
// Same August boundary detectSeasonFromAPI applies to a gameweek deadline: a season is
// named for the calendar year it STARTS in, and starts in August. Aug-Dec → this year;
// Jan-Jul → last year.
//
// Known window: in July, FPL's API has usually already flipped to the coming season while
// this still reports the one just finished. That is the conservative direction — the older
// season's keys definitely exist, so reads resolve instead of 404ing across the board.
// A stale literal, by contrast, is wrong by a full year permanently. Wrong for a few weeks
// in the safe direction beats wrong forever in the unsafe one.
export const fallbackSeason = () => {
  const now = new Date();
  const year = now.getUTCFullYear();
  return now.getUTCMonth() >= 7 ? year : year - 1; // getUTCMonth is 0-indexed; Aug = 7
};

// FPL's API era. Nothing older is addressable.
export const MIN_SEASON = 2016;
// +1 so a newly-rolled-over season is valid the moment detection reports it.
export const maxSeason = () => new Date().getUTCFullYear() + 1;

// Parse a season token taken from a URL PATH. Returns the number, or null if invalid.
// Deliberately stricter than Number(): a bare Number() parse also accepts " 2025",
// "2025.0", "2e3" and "0x7E9", all of which would then build a KV key that silently
// addresses nothing. Four digits, or nothing.
export const parseSeasonToken = (token) => {
  if (!/^\d{4}$/.test(token)) return null;
  const s = Number(token);
  if (s < MIN_SEASON || s > maxSeason()) return null;
  return s;
};

// === CORS setup ===
// Ensures our API can be called from any client (browser, React app, etc.)
export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS, HEAD, POST",
  "Access-Control-Allow-Headers": "Content-Type, X-Idempotency-Key",
};

// === Response helpers ===
// Utility functions to standardise JSON and text responses
export const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, ...extra },
  });
export const text = (s, status = 200) =>
  new Response(s, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS } });

// === Cache helpers ===
// Normalize the request URL (strip querystrings) so cache keys are consistent
export const cacheKeyFor = (request, { keepQuery = false } = {}) => {
  const u = new URL(request.url);
  if (!keepQuery) u.search = ""; // strip by default
  return new Request(u.toString(), { method: "GET" });
};
// Standard cache headers: 7 days freshness + 1 day stale-while-revalidate
export const cacheHeaders = (ttl = 604800, swr = 86400) => ({
  "Cache-Control": `public, s-maxage=${ttl}, stale-while-revalidate=${swr}`,
});

// Dynamic cache TTL based on gameweek state
// Active GW: 7 days (data won't change until harvest runs; warmCache will explicitly purge)
// Between GWs: time until next GW deadline (aligns with FPL calendar)
// End of season: 30 days
export const dynamicCacheHeaders = (bootstrap = null) => {
  if (!bootstrap?.events) return cacheHeaders(7 * 24 * 3600, 3600); // safe fallback

  // Active GW (matches being played): long cache — data is stable until harvest runs
  const activeGW = bootstrap.events.find(e => e?.is_current === true && e?.finished === false);
  if (activeGW) {
    return cacheHeaders(7 * 24 * 3600, 24 * 3600); // 7 days
  }

  // Between GWs: TTL = time until next GW's deadline
  const now = Date.now();
  const nextGW = bootstrap.events
    .filter(e => e?.deadline_time && Date.parse(e.deadline_time) > now && !e.finished)
    .sort((a, b) => Date.parse(a.deadline_time) - Date.parse(b.deadline_time))[0];

  if (nextGW?.deadline_time) {
    const secUntilDeadline = Math.floor((Date.parse(nextGW.deadline_time) - now) / 1000);
    const ttl = Math.max(3600, secUntilDeadline);         // min 1h
    const swr = Math.min(3600, Math.floor(ttl * 0.1));    // 10% SWR, max 1h
    return cacheHeaders(ttl, swr);
  }

  // End of season / no future GWs
  return cacheHeaders(30 * 24 * 3600, 24 * 3600); // 30 days
};

// === Structured JSON Logger ===
// Outputs JSON logs for log aggregation (Cloudflare Logpush, Workers Analytics)
function structuredLog(level, component, event, data = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    component,
    event,
    ...data,
  };
  const output = JSON.stringify(entry);
  if (level === "error") console.error(output);
  else if (level === "warn") console.warn(output);
  else console.log(output);
}

export const log = {
  debug: (component, event, data) => structuredLog("debug", component, event, data),
  info: (component, event, data) => structuredLog("info", component, event, data),
  warn: (component, event, data) => structuredLog("warn", component, event, data),
  error: (component, event, data) => structuredLog("error", component, event, data),
};

// === Idempotency helpers ===
export const kIdempotency = (key) => `idempotency:${key}`;
export const IDEMPOTENCY_TTL = 3600; // 1 hour

export async function checkIdempotencyKey(env, key) {
  if (!key) return null;
  const val = await env.FPL_PULSE_KV.get(kIdempotency(key), { type: "json" });
  return val ?? null;
}

export async function storeIdempotencyResult(env, key, result, status) {
  if (!key) return;
  await env.FPL_PULSE_KV.put(
    kIdempotency(key),
    JSON.stringify({
      result,
      status,
      completed_at: new Date().toISOString(),
    }),
    { expirationTtl: IDEMPOTENCY_TTL }
  );
}
