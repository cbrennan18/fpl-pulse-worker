import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendElementsForGW, backfillSeasonElements } from '../src/services/harvest.js';
import { isValidGwElements, kSeasonElements, kSeasonClosed } from '../src/lib/kv.js';
import { circuitBreaker } from '../src/lib/fpl-api.js';
import { createMockEnv, mockFetch } from './helpers/mocks.js';

const SEASON = 2025;
const liveUrl = (gw) => `https://fantasy.premierleague.com/api/event/${gw}/live/`;

// Canonical event/{gw}/live shape (what GW10+ already store).
const liveBlock = (gw) => ({ elements: [{ id: 1, stats: { total_points: gw, minutes: 90 } }] });

// Map of live routes for GW 1..n.
function liveRoutes(n) {
  const routes = {};
  for (let gw = 1; gw <= n; gw++) routes[liveUrl(gw)] = liveBlock(gw);
  return routes;
}

describe('isValidGwElements', () => {
  it('accepts a non-empty canonical block', () => {
    expect(isValidGwElements({ elements: [{ id: 1, stats: {} }] })).toBe(true);
  });
  it('rejects the legacy element-keyed GW1 shape', () => {
    expect(isValidGwElements({ 302: { points: 6, minutes: 90 } })).toBe(false);
  });
  it('rejects missing / empty blocks', () => {
    expect(isValidGwElements(undefined)).toBeFalsy();
    expect(isValidGwElements({ elements: [] })).toBe(false);
  });
});

describe('appendElementsForGW', () => {
  let env, cleanup;
  beforeEach(() => { circuitBreaker.reset(); env = createMockEnv(); });
  afterEach(() => { cleanup?.(); circuitBreaker.reset(); });

  it('overwrites a malformed (legacy) block instead of skipping it', async () => {
    cleanup = mockFetch(liveRoutes(1));
    await env.FPL_PULSE_KV.put(kSeasonElements(SEASON), JSON.stringify({
      last_gw_processed: 1, gws: { 1: { 302: { points: 6, minutes: 90 } } },
    }));

    const res = await appendElementsForGW(env, SEASON, 1);
    expect(res.wrote).toBe(true);
    const stored = env.FPL_PULSE_KV._getJSON(kSeasonElements(SEASON));
    expect(isValidGwElements(stored.gws[1])).toBe(true);
  });

  it('skips a genuinely valid block', async () => {
    cleanup = mockFetch(liveRoutes(1));
    await env.FPL_PULSE_KV.put(kSeasonElements(SEASON), JSON.stringify({
      last_gw_processed: 1, gws: { 1: liveBlock(1) },
    }));
    const res = await appendElementsForGW(env, SEASON, 1);
    expect(res).toEqual({ wrote: false, reason: 'already_present' });
  });
});

describe('backfillSeasonElements', () => {
  let env, cleanup;
  beforeEach(() => { circuitBreaker.reset(); env = createMockEnv(); });
  afterEach(() => { cleanup?.(); circuitBreaker.reset(); });

  it('fills missing GWs and repairs the legacy GW1, leaving valid GWs untouched', async () => {
    cleanup = mockFetch(liveRoutes(11));
    // Mirrors the live bug: GW1 legacy-shaped, GW2-9 absent, GW10 valid, GW11 absent.
    const valid10 = liveBlock(10);
    await env.FPL_PULSE_KV.put(kSeasonElements(SEASON), JSON.stringify({
      last_gw_processed: 11,
      gws: { 1: { 302: { points: 6, minutes: 90 } }, 10: valid10 },
    }));

    const res = await backfillSeasonElements(env, SEASON, 11);
    expect(res.filled).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 11]);
    expect(res.repaired).toEqual([1]);
    expect(res.written).toBe(10);

    const stored = env.FPL_PULSE_KV._getJSON(kSeasonElements(SEASON));
    for (let gw = 1; gw <= 11; gw++) expect(isValidGwElements(stored.gws[gw])).toBe(true);
    expect(stored.gws[10]).toEqual(valid10); // untouched
    expect(stored.last_gw_processed).toBe(11);
  });

  it('is a no-op (no KV write) when every GW is already valid', async () => {
    cleanup = mockFetch(liveRoutes(3));
    await env.FPL_PULSE_KV.put(kSeasonElements(SEASON), JSON.stringify({
      last_gw_processed: 3, gws: { 1: liveBlock(1), 2: liveBlock(2), 3: liveBlock(3) },
    }));
    const res = await backfillSeasonElements(env, SEASON, 3);
    expect(res).toMatchObject({ written: 0, filled: [], repaired: [] });
  });

  it('caps fetches per call via limit, leaving the rest for the next cycle', async () => {
    cleanup = mockFetch(liveRoutes(9));
    const res = await backfillSeasonElements(env, SEASON, 9, { limit: 4 });
    expect(res.written).toBe(4);
    expect(res.filled).toEqual([1, 2, 3, 4]);
    const stored = env.FPL_PULSE_KV._getJSON(kSeasonElements(SEASON));
    expect(isValidGwElements(stored.gws[5])).toBeFalsy(); // not reached this cycle
  });

  it('builds the spine from scratch when no blob exists', async () => {
    cleanup = mockFetch(liveRoutes(3));
    const res = await backfillSeasonElements(env, SEASON, 3);
    expect(res.filled).toEqual([1, 2, 3]);
    expect(env.FPL_PULSE_KV._getJSON(kSeasonElements(SEASON)).last_gw_processed).toBe(3);
  });
});

describe('elements writes — season immutability', () => {
  let env;
  let cleanup;

  beforeEach(async () => {
    circuitBreaker.reset();
    env = createMockEnv();
    cleanup = mockFetch(liveRoutes(5));
    await env.FPL_PULSE_KV.put(kSeasonClosed(SEASON), JSON.stringify({ closed_at: 'x', final_gw: 38 }));
  });
  afterEach(() => {
    if (cleanup) cleanup();
    circuitBreaker.reset();
  });

  it('appendElementsForGW refuses and writes nothing', async () => {
    const res = await appendElementsForGW(env, SEASON, 1);
    expect(res).toEqual({ wrote: false, reason: 'season_closed' });
    expect(env.FPL_PULSE_KV._getJSON(kSeasonElements(SEASON))).toBeNull();
  });

  it('backfillSeasonElements refuses and leaves an existing spine untouched', async () => {
    const existing = { last_gw_processed: 2, gws: { 1: liveBlock(1), 2: liveBlock(2) } };
    await env.FPL_PULSE_KV.put(kSeasonElements(SEASON), JSON.stringify(existing));

    const res = await backfillSeasonElements(env, SEASON, 5);
    expect(res).toMatchObject({ written: 0, reason: 'season_closed' });
    expect(env.FPL_PULSE_KV._getJSON(kSeasonElements(SEASON))).toEqual(existing);
  });
});
