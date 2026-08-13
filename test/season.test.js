import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { detectSeasonFromAPI, getEffectiveSeason, detectLatestFinishedGW } from '../src/services/harvest.js';
import { circuitBreaker } from '../src/lib/fpl-api.js';
import { kDetectedSeason } from '../src/lib/kv.js';
import { fallbackSeason, parseSeasonToken, MIN_SEASON, maxSeason } from '../src/lib/utils.js';
import { createMockEnv, mockFetch, createBootstrap } from './helpers/mocks.js';

describe('detectSeasonFromAPI', () => {
  let env;
  let cleanup;

  beforeEach(() => {
    circuitBreaker.reset();
    env = createMockEnv();
  });

  afterEach(() => {
    if (cleanup) cleanup();
    circuitBreaker.reset();
  });

  it('detects season from August deadline → current year', async () => {
    cleanup = mockFetch({
      'https://fantasy.premierleague.com/api/bootstrap-static/': {
        events: [{
          id: 1,
          deadline_time: '2025-08-16T17:30:00Z',
          finished: true,
          data_checked: true,
        }],
      },
    });

    const season = await detectSeasonFromAPI(env);
    expect(season).toBe(2025);
  });

  it('detects season from September deadline → current year', async () => {
    cleanup = mockFetch({
      'https://fantasy.premierleague.com/api/bootstrap-static/': {
        events: [{
          id: 1,
          deadline_time: '2024-09-01T17:30:00Z',
          finished: true,
          data_checked: true,
        }],
      },
    });

    const season = await detectSeasonFromAPI(env);
    expect(season).toBe(2024);
  });

  it('returns cached season if <1h old', async () => {
    // Pre-populate cache with a recent detection
    await env.FPL_PULSE_KV.put(kDetectedSeason, JSON.stringify({
      season: 2024,
      detected_at: new Date().toISOString(),
      source: "fpl_api",
    }));

    // Mock fetch should NOT be called
    let fetchCalled = false;
    cleanup = mockFetch({
      'https://fantasy.premierleague.com/api/bootstrap-static/': () => {
        fetchCalled = true;
        return new Response(JSON.stringify(createBootstrap()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    const season = await detectSeasonFromAPI(env);
    expect(season).toBe(2024);
    expect(fetchCalled).toBe(false);
  });

  it('re-detects when cache is stale (>1h)', async () => {
    // Pre-populate with stale cache
    const staleTime = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    await env.FPL_PULSE_KV.put(kDetectedSeason, JSON.stringify({
      season: 2024,
      detected_at: staleTime,
      source: "fpl_api",
    }));

    cleanup = mockFetch({
      'https://fantasy.premierleague.com/api/bootstrap-static/': {
        events: [{
          id: 1,
          deadline_time: '2025-08-16T17:30:00Z',
          finished: true,
          data_checked: true,
        }],
      },
    });

    const season = await detectSeasonFromAPI(env);
    expect(season).toBe(2025);
  });

  it('returns null when API call fails', async () => {
    cleanup = mockFetch({
      'https://fantasy.premierleague.com/api/bootstrap-static/':
        () => new Response('error', { status: 500 }),
    });

    const season = await detectSeasonFromAPI(env);
    expect(season).toBeNull();
  });
});

describe('getEffectiveSeason', () => {
  let env;
  let cleanup;

  beforeEach(() => {
    circuitBreaker.reset();
    env = createMockEnv();
  });

  afterEach(() => {
    if (cleanup) cleanup();
    circuitBreaker.reset();
  });

  it('returns cached season when fresh', async () => {
    await env.FPL_PULSE_KV.put(kDetectedSeason, JSON.stringify({
      season: 2025,
      detected_at: new Date().toISOString(),
    }));

    const season = await getEffectiveSeason(env);
    expect(season).toBe(2025);
  });

  it('falls back to env.SEASON when detection fails', async () => {
    env.SEASON = "2024";

    cleanup = mockFetch({
      'https://fantasy.premierleague.com/api/bootstrap-static/':
        () => new Response('error', { status: 500 }),
    });

    const season = await getEffectiveSeason(env);
    expect(season).toBe(2024);
  });

  // Asserts against the deriving function, not a literal year. A hardcoded expectation
  // here would have to be edited every August — the failure this fallback exists to avoid.
  it('falls back to the derived season when no env.SEASON and detection fails', async () => {
    delete env.SEASON;

    cleanup = mockFetch({
      'https://fantasy.premierleague.com/api/bootstrap-static/':
        () => new Response('error', { status: 500 }),
    });

    const season = await getEffectiveSeason(env);
    expect(season).toBe(fallbackSeason());
  });
});

describe('fallbackSeason', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('names a season for the calendar year it starts in', () => {
    vi.setSystemTime(new Date('2026-08-01T00:00:00Z'));
    expect(fallbackSeason()).toBe(2026);

    vi.setSystemTime(new Date('2026-12-31T23:59:59Z'));
    expect(fallbackSeason()).toBe(2026);

    // Still 2026/27 in the spring of the following calendar year.
    vi.setSystemTime(new Date('2027-05-20T00:00:00Z'));
    expect(fallbackSeason()).toBe(2026);
  });

  // The known-wrong window, pinned deliberately: FPL's API has usually flipped to the
  // coming season by mid-July while this still reports the one just finished. That is the
  // safe direction — the older season's keys exist, so reads resolve.
  it('reports the season just finished during the July changeover window', () => {
    vi.setSystemTime(new Date('2027-07-15T00:00:00Z'));
    expect(fallbackSeason()).toBe(2026);
  });

  it('never returns a year the season-token validator would reject', () => {
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
    expect(parseSeasonToken(String(fallbackSeason()))).toBe(fallbackSeason());
  });
});

describe('parseSeasonToken', () => {
  it('accepts a 4-digit year inside the supported range', () => {
    expect(parseSeasonToken('2025')).toBe(2025);
    expect(parseSeasonToken(String(MIN_SEASON))).toBe(MIN_SEASON);
    expect(parseSeasonToken(String(maxSeason()))).toBe(maxSeason());
  });

  it('rejects years outside the supported range', () => {
    expect(parseSeasonToken(String(MIN_SEASON - 1))).toBeNull();
    expect(parseSeasonToken(String(maxSeason() + 1))).toBeNull();
  });

  // Each of these is accepted by a bare Number() and would build a KV key that
  // silently addresses nothing.
  it('rejects tokens a bare Number() parse would wrongly accept', () => {
    expect(parseSeasonToken(' 2025')).toBeNull();
    expect(parseSeasonToken('2025.0')).toBeNull();
    expect(parseSeasonToken('2e3')).toBeNull();
    expect(parseSeasonToken('0x7E9')).toBeNull();
    expect(parseSeasonToken('')).toBeNull();
  });

  it('rejects the literal "season" path segment', () => {
    expect(parseSeasonToken('season')).toBeNull();
  });

  it('rejects tokens that are not exactly four digits', () => {
    expect(parseSeasonToken('202')).toBeNull();
    expect(parseSeasonToken('20255')).toBeNull();
  });
});

describe('detectLatestFinishedGW', () => {
  it('returns highest finished+data_checked GW', () => {
    const bootstrap = createBootstrap({
      events: [
        { id: 1, finished: true, data_checked: true, is_current: false },
        { id: 2, finished: true, data_checked: true, is_current: false },
        { id: 3, finished: true, data_checked: false, is_current: true },
        { id: 4, finished: false, data_checked: false, is_current: false },
      ],
    });

    expect(detectLatestFinishedGW(bootstrap)).toBe(2);
  });

  it('returns null when no GWs are finished', () => {
    const bootstrap = createBootstrap({
      events: [
        { id: 1, finished: false, data_checked: false, is_current: true },
      ],
    });

    expect(detectLatestFinishedGW(bootstrap)).toBeNull();
  });

  it('returns null when events is empty', () => {
    expect(detectLatestFinishedGW({ events: [] })).toBeNull();
  });

  it('returns null when bootstrap is null', () => {
    expect(detectLatestFinishedGW(null)).toBeNull();
  });

  it('handles single finished GW', () => {
    const bootstrap = createBootstrap({
      events: [
        { id: 1, finished: true, data_checked: true, is_current: false },
      ],
    });

    expect(detectLatestFinishedGW(bootstrap)).toBe(1);
  });

  it('ignores finished GWs where data_checked is false', () => {
    const bootstrap = createBootstrap({
      events: [
        { id: 1, finished: true, data_checked: false, is_current: false },
        { id: 2, finished: true, data_checked: false, is_current: true },
      ],
    });

    expect(detectLatestFinishedGW(bootstrap)).toBeNull();
  });
});
