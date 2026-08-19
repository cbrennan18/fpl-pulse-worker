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
// Season-scoped: FPL reassigns mini-league IDs every season in creation order, so
// the same ID names a different league year to year. An unscoped members key would
// let a later season's ingest silently overwrite a stored roster.
// Shape is load-bearing: league-discovery scans match on the `:members` suffix and
// take the league ID from split(":")[1] — keep both if this key ever changes again.
export const kLeagueMembers   = (leagueId, season) => `league:${leagueId}:${season}:members`;
export const kEntrySeason     = (entryId, season) => `entry:${entryId}:${season}`;
export const kEntryState      = (entryId, season) => `entry:${entryId}:${season}:state`;
export const kLeagueStandings = (leagueId, season) => `league:${leagueId}:${season}:standings`;
// Season immutability marker. PRESENCE means closed; value is { closed_at, final_gw }.
export const kSeasonClosed    = (season) => `season:${season}:closed`;
export const kHealthStateSummary = `health:state_summary`;
export const kDetectedSeason = `config:detected_season`;
export const kPurgeQueue = `cache:purge_queue`;

// === Minimal schema guards ===
// These ensure the blobs we read back from KV are valid JSON objects
export const isSeasonElements = (x) =>
  x && typeof x === "object" && typeof x.last_gw_processed === "number" && x.gws && typeof x.gws === "object";

// A single GW's elements block is valid only when it carries a non-empty
// elements[] array (the canonical event/{gw}/live shape). Guards against legacy
// or partial blocks stored under an older schema (e.g. keyed by element id),
// which read as a zero-point gameweek to clients instead of an error.
export const isValidGwElements = (block) =>
  block && typeof block === "object" && Array.isArray(block.elements) && block.elements.length > 0;

export const isEntrySeason = (x) =>
  x && typeof x === "object" &&
  typeof x.entry_id === "number" &&
  typeof x.season === "number" &&
  typeof x.last_gw_processed === "number" &&
  x.gw_summaries && typeof x.gw_summaries === "object" &&
  x.picks_by_gw && typeof x.picks_by_gw === "object" &&
  Array.isArray(x.transfers);

export const isLeagueMembers = (x) => Array.isArray(x) && x.every((n) => Number.isInteger(n));

// Archived final league standings (league:<id>:<season>:standings). Validates the
// write-once blob shape so a later run can read back `final` and refuse to clobber it.
export const isLeagueStandings = (x) =>
  x && typeof x === "object" &&
  typeof x.season === "number" &&
  Array.isArray(x.results) &&
  typeof x.member_count === "number" &&
  typeof x.final === "boolean" &&
  typeof x.harvested_at === "string";

// === Season immutability ===
//
// ABSENT MEANS OPEN. ALWAYS. This is the load-bearing default of the whole mechanism:
// every write path in the Worker consults it, and the entire existing test suite runs
// without ever seeding a marker. If absence were ambiguous — or if closure were inferred
// live from bootstrap instead of read from this key — every one of those paths would
// change behaviour on a bootstrap flip mid-flight, and each would need its own
// fetchBootstrap call against the 50-subrequest budget.
//
// One KV read to check, and KV operations do not count against that budget.
export async function isSeasonClosed(kv, season) {
  return (await kvGetJSON(kv, kSeasonClosed(season))) !== null;
}

// === Season discovery ===
//
// Builds the season list for GET /v1/seasons from a single namespace scan. Two facts per
// season, kept separate because the two consumers ask DIFFERENT questions:
//
//   closed    — the season is over. Wrapped is retrospective and only offers these.
//   has_data  — at least one entry:<id>:<season> blob exists. The live league product
//               offers these.
//
// has_data is deliberately "at least one entry BLOB", not "any key for this season":
//   - a bootstrap alone is not browsable (entries-pack 422s: members may exist, blobs do not)
//   - queued/building states alone are not browsable either (entries-pack 202s) — it WILL
//     be browsable, but is not yet, and the selector must not offer a season that renders
//     empty
// One blob is exactly the threshold at which entries-pack starts returning 200, so this
// mirrors the contract the consumer actually depends on rather than guessing a proxy.
//
// A season becomes VISIBLE if any season-scoped key mentions it. The caller additionally
// forces the detected current season into the list even when it owns zero keys — that is
// the real state of a new season between FPL's rollover and its first harvest, and it must
// be representable (current, no data) rather than an absence that empties the list.
export async function collectSeasonIndex(kv, currentSeason) {
  const seasons = new Map();
  const touch = (year) => {
    if (!seasons.has(year)) seasons.set(year, { closed: false, has_data: false });
    return seasons.get(year);
  };

  let cursor;
  do {
    const page = await kv.list({ cursor, limit: 1000 });
    cursor = page.cursor;
    for (const { name } of page.keys) {
      let m;
      if ((m = name.match(/^season:(\d{4}):closed$/))) { touch(Number(m[1])).closed = true; continue; }
      if ((m = name.match(/^entry:\d+:(\d{4})$/)))     { touch(Number(m[1])).has_data = true; continue; }
      // Present but not browsable on their own — they only make the season visible.
      if ((m = name.match(/^season:(\d{4}):(bootstrap|elements)$/))) { touch(Number(m[1])); continue; }
      if ((m = name.match(/^entry:\d+:(\d{4}):state$/)))            { touch(Number(m[1])); continue; }
      if ((m = name.match(/^league:\d+:(\d{4}):(members|standings)$/))) { touch(Number(m[1])); continue; }
    }
  } while (cursor);

  if (Number.isInteger(currentSeason)) touch(currentSeason);
  return seasons;
}

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
