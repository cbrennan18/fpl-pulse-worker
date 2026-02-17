// === CORS setup ===
// Ensures our API can be called from any client (browser, React app, etc.)
export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS, HEAD, POST",
  "Access-Control-Allow-Headers": "*",
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
// Returns shorter TTL during active GW, longer for finished GWs
export const dynamicCacheHeaders = (bootstrap = null) => {
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
