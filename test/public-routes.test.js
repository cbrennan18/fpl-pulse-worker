import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handlePublicRoute } from '../src/routes/public.js';
import { warmCache } from '../src/services/harvest.js';
import {
  kEntrySeason, kEntryState, kLeagueMembers, kSeasonBootstrap, kSeasonElements,
  kDetectedSeason, kPurgeQueue, kLeagueStandings, kSeasonClosed,
} from '../src/lib/kv.js';
import { MIN_SEASON, maxSeason } from '../src/lib/utils.js';
import { createMockEnv, mockCaches } from './helpers/mocks.js';

// The season the Worker "detected" — what unprefixed routes must resolve to.
const DETECTED = 2026;
const ARCHIVED = 2025;
const LEAGUE = 9385;

const entryBlob = (entryId, season) => ({
  entry_id: entryId,
  season,
  last_gw_processed: 38,
  gw_summaries: { 1: { points: 50 } },
  picks_by_gw: { 1: { picks: [] } },
  transfers: [],
});

const get = (env, path) =>
  handlePublicRoute(new Request(`https://worker.dev${path}`), env, DETECTED);

const head = (env, path) =>
  handlePublicRoute(new Request(`https://worker.dev${path}`, { method: 'HEAD' }), env, DETECTED);

describe('season token validation', () => {
  let env, caches;

  beforeEach(() => { env = createMockEnv(); caches = mockCaches(); });
  afterEach(() => caches.cleanup());

  it('rejects a year below the supported range with 400', async () => {
    const res = await get(env, `/v1/${MIN_SEASON - 1}/entry/5`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_season');
  });

  it('rejects a year above the supported range with 400', async () => {
    const res = await get(env, `/v1/${maxSeason() + 1}/entry/5`);
    expect(res.status).toBe(400);
  });

  it('rejects a non-4-digit numeric segment with 400, not a 404', async () => {
    expect((await get(env, '/v1/20255/entry/5')).status).toBe(400);
    expect((await get(env, '/v1/202/entry/5')).status).toBe(400);
  });

  // /v1/season/elements and /v1/2025/elements are the same shape — three segments, the
  // season token in the same slot. The literal must keep winning.
  it('does not mistake the literal /v1/season/* routes for a season token', async () => {
    await env.FPL_PULSE_KV.put(kSeasonElements(DETECTED), JSON.stringify({ last_gw_processed: 3, gws: { 1: {} } }));

    const res = await get(env, '/v1/season/elements');
    expect(res.status).toBe(200);
    expect((await res.json()).last_gw_processed).toBe(3);
  });
});

describe('season-prefixed read routes', () => {
  let env, caches;

  beforeEach(() => {
    env = createMockEnv({
      [kEntrySeason(11, ARCHIVED)]: JSON.stringify(entryBlob(11, ARCHIVED)),
      [kEntrySeason(11, DETECTED)]: JSON.stringify(entryBlob(11, DETECTED)),
      [kSeasonElements(ARCHIVED)]: JSON.stringify({ last_gw_processed: 38, gws: { 1: {} } }),
      [kSeasonElements(DETECTED)]: JSON.stringify({ last_gw_processed: 2, gws: { 1: {} } }),
      [kSeasonBootstrap(ARCHIVED)]: JSON.stringify({ events: [{ id: 1, finished: true }] }),
      [kSeasonBootstrap(DETECTED)]: JSON.stringify({ events: [{ id: 2, finished: false }] }),
      [kLeagueMembers(LEAGUE, ARCHIVED)]: JSON.stringify([11]),
      [kLeagueMembers(LEAGUE, DETECTED)]: JSON.stringify([11]),
    });
    caches = mockCaches();
  });
  afterEach(() => caches.cleanup());

  it('serves the requested season, not the detected one, for an entry', async () => {
    const res = await get(env, `/v1/${ARCHIVED}/entry/11`);
    expect(res.status).toBe(200);
    expect((await res.json()).season).toBe(ARCHIVED);
  });

  it('keeps resolving unprefixed entry reads to the detected season', async () => {
    const res = await get(env, '/v1/entry/11');
    expect(res.status).toBe(200);
    expect((await res.json()).season).toBe(DETECTED);
  });

  it('serves the requested season for elements and bootstrap', async () => {
    expect((await (await get(env, `/v1/${ARCHIVED}/elements`)).json()).last_gw_processed).toBe(38);
    expect((await (await get(env, `/v1/${DETECTED}/elements`)).json()).last_gw_processed).toBe(2);
    expect((await (await get(env, `/v1/${ARCHIVED}/bootstrap`)).json()).events[0].id).toBe(1);
    expect((await (await get(env, `/v1/${DETECTED}/bootstrap`)).json()).events[0].id).toBe(2);
  });

  it('serves the requested season for league members', async () => {
    expect((await get(env, `/v1/${ARCHIVED}/league/${LEAGUE}/members`)).status).toBe(200);
    // A season with no roster for this league 404s rather than falling back.
    expect((await get(env, `/v1/2024/league/${LEAGUE}/members`)).status).toBe(404);
  });

  it('serves the requested season for entries-pack', async () => {
    const res = await get(env, `/v1/${ARCHIVED}/league/${LEAGUE}/entries-pack`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries['11'].season).toBe(ARCHIVED);
  });

  it('gives the prefixed and unprefixed forms separate edge cache entries', async () => {
    await get(env, '/v1/entry/11');
    await get(env, `/v1/${ARCHIVED}/entry/11`);

    expect(caches.store.has('https://worker.dev/v1/entry/11')).toBe(true);
    expect(caches.store.has(`https://worker.dev/v1/${ARCHIVED}/entry/11`)).toBe(true);
  });
});

describe('entries-pack: zero blobs against a non-empty roster', () => {
  let env, caches;

  beforeEach(() => {
    env = createMockEnv({
      [kLeagueMembers(LEAGUE, DETECTED)]: JSON.stringify([11, 22, 33]),
    });
    caches = mockCaches();
  });
  afterEach(() => caches.cleanup());

  it('returns 422 when nothing is built and nothing is pending', async () => {
    const res = await get(env, `/v1/league/${LEAGUE}/entries-pack`);
    expect(res.status).toBe(422);

    const body = await res.json();
    expect(body.error).toBe('no_entries_for_season');
    expect(body.member_count).toBe(3);
    expect(body.season).toBe(DETECTED);
  });

  it('returns 202 when builds are pending — a freshly ingested live league', async () => {
    for (const id of [11, 22, 33]) {
      await env.FPL_PULSE_KV.put(kEntryState(id, DETECTED), JSON.stringify({ status: 'queued', last_gw_processed: 0 }));
    }

    const res = await get(env, `/v1/league/${LEAGUE}/entries-pack`);
    expect(res.status).toBe(202);

    const body = await res.json();
    expect(body.status).toBe('queued');
    expect(body.pending).toBe(3);
    expect(body.total).toBe(3);
  });

  it('reports building when any member is mid-build', async () => {
    await env.FPL_PULSE_KV.put(kEntryState(11, DETECTED), JSON.stringify({ status: 'queued', last_gw_processed: 0 }));
    await env.FPL_PULSE_KV.put(kEntryState(22, DETECTED), JSON.stringify({ status: 'building', last_gw_processed: 4 }));

    const body = await (await get(env, `/v1/league/${LEAGUE}/entries-pack`)).json();
    expect(body.status).toBe('building');
    expect(body.last_gw_processed).toBe(4);
  });

  // errored/dead are terminal, not pending: nothing is coming, so this is a fault.
  it('returns 422 when the only states are errored or dead', async () => {
    await env.FPL_PULSE_KV.put(kEntryState(11, DETECTED), JSON.stringify({ status: 'errored' }));
    await env.FPL_PULSE_KV.put(kEntryState(22, DETECTED), JSON.stringify({ status: 'dead' }));

    expect((await get(env, `/v1/league/${LEAGUE}/entries-pack`)).status).toBe(422);
  });

  it('still returns 200 when only SOME blobs are missing', async () => {
    await env.FPL_PULSE_KV.put(kEntrySeason(11, DETECTED), JSON.stringify(entryBlob(11, DETECTED)));

    const res = await get(env, `/v1/league/${LEAGUE}/entries-pack`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Object.keys(body.entries)).toEqual(['11']);
    expect(body.members).toEqual([11, 22, 33]);
  });

  // cacheKeyFor forces method GET, so HEAD and GET share one edge entry: a cached
  // error would pin the fault for both probes until the TTL expired.
  it('never caches a non-200', async () => {
    await get(env, `/v1/league/${LEAGUE}/entries-pack`); // 422
    expect(caches.store.size).toBe(0);

    await env.FPL_PULSE_KV.put(kEntryState(11, DETECTED), JSON.stringify({ status: 'queued' }));
    await get(env, `/v1/league/${LEAGUE}/entries-pack`); // 202
    expect(caches.store.size).toBe(0);
  });

  it('leaves the deployed frontend HEAD probe working: ok for 202, not ok for 422', async () => {
    const mismatch = await head(env, `/v1/league/${LEAGUE}/entries-pack`);
    expect(mismatch.ok).toBe(false); // league correctly hidden

    for (const id of [11, 22, 33]) {
      await env.FPL_PULSE_KV.put(kEntryState(id, DETECTED), JSON.stringify({ status: 'queued' }));
    }
    const building = await head(env, `/v1/league/${LEAGUE}/entries-pack`);
    expect(building.ok).toBe(true); // available, as today
  });
});

// Paired deliberately with the route tests above: every artefact reachable at two URLs
// must have BOTH purged. Edge keys are path-only, so purging one form leaves the other
// serving stale data behind an X-Cache: HIT for the full dynamicCacheHeaders TTL — up to
// 7 days during an active GW, which is only safe because purge is the real invalidation.
describe('warmCache purge queue covers both addressing forms', () => {
  let env;

  beforeEach(() => {
    env = createMockEnv({
      // Fresh detection cache so getEffectiveSeason resolves without an API call.
      [kDetectedSeason]: JSON.stringify({ season: DETECTED, detected_at: new Date().toISOString() }),
      [kLeagueMembers(LEAGUE, DETECTED)]: JSON.stringify([11, 22]),
    });
  });

  it('queues the prefixed and unprefixed URL for every season-scoped route', async () => {
    await warmCache(env);
    const { urls } = env.FPL_PULSE_KV._getJSON(kPurgeQueue);
    const base = 'https://fpl-pulse.ciaranbrennan18.workers.dev';

    for (const u of [
      `${base}/v1/season/elements`, `${base}/v1/${DETECTED}/elements`,
      `${base}/v1/season/bootstrap`, `${base}/v1/${DETECTED}/bootstrap`,
      `${base}/v1/league/${LEAGUE}/members`, `${base}/v1/${DETECTED}/league/${LEAGUE}/members`,
      `${base}/v1/league/${LEAGUE}/entries-pack`, `${base}/v1/${DETECTED}/league/${LEAGUE}/entries-pack`,
      `${base}/v1/entry/11`, `${base}/v1/${DETECTED}/entry/11`,
      `${base}/v1/entry/22`, `${base}/v1/${DETECTED}/entry/22`,
      `${base}/fpl/bootstrap`, `${base}/fpl/league/${LEAGUE}`,
    ]) {
      expect(urls).toContain(u);
    }
  });

  // Closed seasons never change, so purging them is pure budget waste against the
  // 45-per-cron-cycle cache-operation batch.
  it('queues prefixed URLs for the current season only', async () => {
    await env.FPL_PULSE_KV.put(kLeagueMembers(LEAGUE, ARCHIVED), JSON.stringify([11, 22]));

    await warmCache(env);
    const { urls } = env.FPL_PULSE_KV._getJSON(kPurgeQueue);

    expect(urls.some(u => u.includes(`/v1/${ARCHIVED}/`))).toBe(false);
  });

  // One league can carry both a legacy and a scoped members key mid-migration.
  it('does not double-queue a league that surfaces under two members keys', async () => {
    await env.FPL_PULSE_KV.put(`league:${LEAGUE}:members`, JSON.stringify([11, 22]));

    await warmCache(env);
    const { urls } = env.FPL_PULSE_KV._getJSON(kPurgeQueue);

    const packUrl = `https://fpl-pulse.ciaranbrennan18.workers.dev/v1/league/${LEAGUE}/entries-pack`;
    expect(urls.filter(u => u === packUrl)).toHaveLength(1);
  });
});

describe('archived standings route', () => {
  let env, caches;

  const archive = (season, final, results = [{ entry: 11, rank: 1, total: 2343 }]) => ({
    season,
    harvested_at: '2026-05-25T18:00:00.000Z',
    member_count: results.length,
    final,
    league: { id: LEAGUE, name: 'Dundanion Road' },
    results,
  });

  beforeEach(() => {
    env = createMockEnv({
      [kLeagueStandings(LEAGUE, ARCHIVED)]: JSON.stringify(archive(ARCHIVED, true)),
    });
    caches = mockCaches();
  });
  afterEach(() => caches.cleanup());

  it('serves a final archive for the requested season, untrimmed', async () => {
    const res = await get(env, `/v1/${ARCHIVED}/league/${LEAGUE}/standings`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.final).toBe(true);
    expect(body.season).toBe(ARCHIVED);
    expect(body.results[0]).toMatchObject({ entry: 11, rank: 1, total: 2343 });
    expect(body.league.name).toBe('Dundanion Road');
  });

  it('404s a season with no archive', async () => {
    expect((await get(env, `/v1/2024/league/${LEAGUE}/standings`)).status).toBe(404);
  });

  // The window between the final gameweek and FPL's rollover: archiveLeagueStandings has
  // captured a table and keeps overwriting it, but the season is not settled.
  it('returns 202 provisional rather than serving an in-progress table as a result', async () => {
    await env.FPL_PULSE_KV.put(kLeagueStandings(LEAGUE, DETECTED), JSON.stringify(archive(DETECTED, false)));

    const res = await get(env, `/v1/${DETECTED}/league/${LEAGUE}/standings`);
    expect(res.status).toBe(202);

    const body = await res.json();
    expect(body.status).toBe('provisional');
    expect(body.season).toBe(DETECTED);
    expect(body.harvested_at).toBe('2026-05-25T18:00:00.000Z');
    // The ranks themselves are withheld — nothing to mistake for a result.
    expect(body.results).toBeUndefined();
  });

  it('distinguishes never-archived from still-settling by status alone', async () => {
    await env.FPL_PULSE_KV.put(kLeagueStandings(LEAGUE, DETECTED), JSON.stringify(archive(DETECTED, false)));

    // A HEAD probe gets the full three-way answer with no body.
    expect((await head(env, `/v1/2024/league/${LEAGUE}/standings`)).status).toBe(404);
    expect((await head(env, `/v1/${DETECTED}/league/${LEAGUE}/standings`)).status).toBe(202);
    expect((await head(env, `/v1/${ARCHIVED}/league/${LEAGUE}/standings`)).status).toBe(200);
  });

  it('never caches a provisional or missing archive', async () => {
    await env.FPL_PULSE_KV.put(kLeagueStandings(LEAGUE, DETECTED), JSON.stringify(archive(DETECTED, false)));

    await get(env, `/v1/${DETECTED}/league/${LEAGUE}/standings`); // 202
    await get(env, `/v1/2024/league/${LEAGUE}/standings`);        // 404
    expect(caches.store.size).toBe(0);

    await get(env, `/v1/${ARCHIVED}/league/${LEAGUE}/standings`); // 200
    expect(caches.store.size).toBe(1);
  });

  it('422s a stored blob that fails the schema guard', async () => {
    await env.FPL_PULSE_KV.put(kLeagueStandings(LEAGUE, 2024), JSON.stringify({ season: 2024, results: 'nope' }));
    expect((await get(env, `/v1/2024/league/${LEAGUE}/standings`)).status).toBe(422);
  });

  it('applies the same season validation as the other prefixed routes', async () => {
    const res = await get(env, `/v1/1999/league/${LEAGUE}/standings`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_season');
  });

  // The archive stores untrimmed tables past 50 members by design; the friends-only read
  // policy must not make the AE64 benchmark league's archive unreadable.
  it('serves a league larger than MAX_LEAGUE_SIZE', async () => {
    const big = Array.from({ length: 64 }, (_, i) => ({ entry: i + 1, rank: i + 1, total: 2000 - i }));
    await env.FPL_PULSE_KV.put(kLeagueStandings(1373455, ARCHIVED), JSON.stringify(archive(ARCHIVED, true, big)));

    const res = await get(env, `/v1/${ARCHIVED}/league/1373455/standings`);
    expect(res.status).toBe(200);
    expect((await res.json()).results).toHaveLength(64);
  });
});

// GET /v1/seasons — the discovery endpoint both frontend selectors read.
// `closed` and `has_data` are separate on purpose: Wrapped is retrospective and filters on
// closed; the live league product filters on has_data. One combined "available" flag would
// serve a wrong list to one of them.
describe('GET /v1/seasons', () => {
  let env, caches;

  beforeEach(() => { env = createMockEnv(); caches = mockCaches(); });
  afterEach(() => caches.cleanup());

  const seasons = async (e = env) => (await get(e, '/v1/seasons')).json();

  // THE STATE THIS WEEK: 2026 is detected and owns literally no keys. It must appear as
  // current-with-no-data rather than vanishing and leaving the selector empty.
  it('lists the current season even when it owns no keys at all', async () => {
    const body = await seasons();
    expect(body.current).toBe(DETECTED);
    expect(body.seasons).toEqual([
      { season: DETECTED, is_current: true, closed: false, has_data: false },
    ]);
  });

  it('reports a closed season that has data, with its final gameweek', async () => {
    await env.FPL_PULSE_KV.put(kEntrySeason(11, ARCHIVED), JSON.stringify(entryBlob(11, ARCHIVED)));
    await env.FPL_PULSE_KV.put(kSeasonClosed(ARCHIVED), JSON.stringify({ closed_at: 'x', final_gw: 38 }));

    const body = await seasons();
    const y2025 = body.seasons.find(s => s.season === ARCHIVED);
    expect(y2025).toEqual({
      season: ARCHIVED, is_current: false, closed: true, has_data: true, final_gw: 38,
    });
  });

  it('reports an open season that has data', async () => {
    await env.FPL_PULSE_KV.put(kEntrySeason(11, DETECTED), JSON.stringify(entryBlob(11, DETECTED)));

    const body = await seasons();
    expect(body.seasons[0]).toEqual({
      season: DETECTED, is_current: true, closed: false, has_data: true,
    });
  });

  // A bootstrap makes a season visible but not browsable — entries-pack would 422.
  it('does not count a bootstrap alone as data', async () => {
    await env.FPL_PULSE_KV.put(kSeasonBootstrap(ARCHIVED), JSON.stringify({ events: [] }));

    const y2025 = (await seasons()).seasons.find(s => s.season === ARCHIVED);
    expect(y2025).toMatchObject({ has_data: false });
  });

  // Mid-ingest: rosters and queued states exist, blobs do not. entries-pack would 202.
  // Visible, but the live selector must not offer it — it would render empty.
  it('does not count a season mid-ingest as data', async () => {
    await env.FPL_PULSE_KV.put(kLeagueMembers(LEAGUE, ARCHIVED), JSON.stringify([11, 22]));
    await env.FPL_PULSE_KV.put(kEntryState(11, ARCHIVED), JSON.stringify({ status: 'queued' }));

    const y2025 = (await seasons()).seasons.find(s => s.season === ARCHIVED);
    expect(y2025).toMatchObject({ has_data: false, closed: false });
  });

  it('omits final_gw rather than sending null when the marker has none', async () => {
    await env.FPL_PULSE_KV.put(kSeasonClosed(ARCHIVED), JSON.stringify({ closed_at: 'x' }));

    const y2025 = (await seasons()).seasons.find(s => s.season === ARCHIVED);
    expect(y2025.closed).toBe(true);
    expect('final_gw' in y2025).toBe(false);
  });

  // Newest first: both selectors take their default from index 0.
  it('orders newest season first', async () => {
    for (const y of [2023, 2024, 2025]) {
      await env.FPL_PULSE_KV.put(kEntrySeason(11, y), JSON.stringify(entryBlob(11, y)));
    }
    expect((await seasons()).seasons.map(s => s.season)).toEqual([2026, 2025, 2024, 2023]);
  });

  it('is edge cached', async () => {
    await get(env, '/v1/seasons');
    expect(caches.store.has('https://worker.dev/v1/seasons')).toBe(true);
    expect((await get(env, '/v1/seasons')).headers.get('X-Cache')).toBe('HIT');
  });

  // One character from the singular /v1/season/* globals, and ahead of the season-prefix
  // matcher. Neither may capture the other.
  it('does not collide with the singular /v1/season/* routes', async () => {
    await env.FPL_PULSE_KV.put(kSeasonElements(DETECTED), JSON.stringify({ last_gw_processed: 1, gws: { 1: {} } }));

    expect((await get(env, '/v1/season/elements')).status).toBe(200);
    expect((await (await get(env, '/v1/seasons')).json()).current).toBe(DETECTED);
  });
});
