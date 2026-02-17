import { json, cacheHeaders, cacheKeyFor } from './utils.js';

// === KV JSON helpers ===
// Get and Put JSON in KV with consistent behaviour
export async function kvGetJSON(kv, key) {
  const v = await kv.get(key, { type: "json" });
  return v ?? null;
}
export async function kvPutJSON(kv, key, value) {
  return kv.put(key, JSON.stringify(value));
}

// === Key builders ===
// These functions generate consistent KV keys for each object we store
export const kSeasonBootstrap = (season) => `season:${season}:bootstrap`;
export const kSeasonElements  = (season) => `season:${season}:elements`;
export const kSnapshotCurrent = `snapshot:current`;
export const kLeagueMembers   = (leagueId) => `league:${leagueId}:members`;
export const kEntrySeason     = (entryId, season) => `entry:${entryId}:${season}`;
export const kEntryState      = (entryId, season) => `entry:${entryId}:${season}:state`;
export const kHealthStateSummary = `health:state_summary`;
export const kDetectedSeason = `config:detected_season`;

// === Minimal schema guards ===
// These ensure the blobs we read back from KV are valid JSON objects
export const isSeasonElements = (x) =>
  x && typeof x === "object" && typeof x.last_gw_processed === "number" && x.gws && typeof x.gws === "object";

export const isEntrySeason = (x) =>
  x && typeof x === "object" &&
  typeof x.entry_id === "number" &&
  typeof x.season === "number" &&
  typeof x.last_gw_processed === "number" &&
  x.gw_summaries && typeof x.gw_summaries === "object" &&
  x.picks_by_gw && typeof x.picks_by_gw === "object" &&
  Array.isArray(x.transfers);

export const isLeagueMembers = (x) => Array.isArray(x) && x.every((n) => Number.isInteger(n));

// === Limits ===
export const MAX_LEAGUE_SIZE = 50; // friends-only mini leagues

// === Edge-first read from KV ===
// First try the Cloudflare Edge cache → if MISS, fall back to KV → then repopulate edge
export async function cacheFirstKV(request, env, kvKey, validator = null) {
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
