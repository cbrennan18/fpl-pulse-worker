import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { detectSeasonFromAPI, getEffectiveSeason, detectLatestFinishedGW } from '../src/services/harvest.js';
import { circuitBreaker } from '../src/lib/fpl-api.js';
import { kDetectedSeason } from '../src/lib/kv.js';
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

  it('defaults to 2025 when no env.SEASON and detection fails', async () => {
    delete env.SEASON;

    cleanup = mockFetch({
      'https://fantasy.premierleague.com/api/bootstrap-static/':
        () => new Response('error', { status: 500 }),
    });

    const season = await getEffectiveSeason(env);
    expect(season).toBe(2025);
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
