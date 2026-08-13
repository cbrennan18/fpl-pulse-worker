import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { detectSeasonFromAPI, getEffectiveSeason, detectLatestFinishedGW, detectFinalGW, harvestIfNeeded } from '../src/services/harvest.js';
import { circuitBreaker } from '../src/lib/fpl-api.js';
import { kDetectedSeason, kSeasonClosed, kSeasonElements, kSeasonBootstrap, kSnapshotCurrent, isSeasonClosed } from '../src/lib/kv.js';
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

describe('detectFinalGW', () => {
  // events.length and the max event id coincide in a normal 38-GW season and diverge the
  // moment FPL reshapes the event list — which is why the close trigger uses the max id.
  it('returns the highest event id, not the event count', () => {
    expect(detectFinalGW({ events: [{ id: 1 }, { id: 2 }, { id: 38 }] })).toBe(38);
  });

  it('returns null for an empty or missing event list', () => {
    expect(detectFinalGW({ events: [] })).toBeNull();
    expect(detectFinalGW(null)).toBeNull();
  });

  it('ignores non-numeric ids', () => {
    expect(detectFinalGW({ events: [{ id: 1 }, { id: 'x' }, { id: 3 }] })).toBe(3);
  });
});

describe('season close via harvestIfNeeded', () => {
  const BOOT = 'https://fantasy.premierleague.com/api/bootstrap-static/';
  const liveUrl = (gw) => `https://fantasy.premierleague.com/api/event/${gw}/live/`;
  const live = (gw) => ({ elements: [{ id: 1, stats: { total_points: gw } }] });

  // n events; the first `finished` of them are complete.
  const boot = (n, finished) => ({
    events: Array.from({ length: n }, (_, i) => ({
      id: i + 1,
      deadline_time: '2025-08-16T17:30:00Z',
      finished: i < finished,
      data_checked: i < finished,
    })),
  });

  const routes = (n, finished) => {
    const r = { [BOOT]: boot(n, finished) };
    for (let gw = 1; gw <= n; gw++) r[liveUrl(gw)] = live(gw);
    return r;
  };

  let env;
  let cleanup;

  beforeEach(async () => {
    circuitBreaker.reset();
    env = createMockEnv();
    await env.FPL_PULSE_KV.put(kDetectedSeason, JSON.stringify({
      season: 2025, detected_at: new Date().toISOString(),
    }));
  });
  afterEach(() => {
    if (cleanup) cleanup();
    circuitBreaker.reset();
  });

  // THE ORDERING PROPERTY. The harvest that processes the final gameweek is itself a write
  // to the season being closed, so the close must not gate the work that triggers it. If
  // the marker were stamped first, backfillSeasonElements would have refused and the
  // elements spine would be empty — so asserting the spine WAS written proves the harvest
  // completed before the close landed.
  it('completes the final gameweek harvest, then stamps the marker', async () => {
    cleanup = mockFetch(routes(3, 3));

    const res = await harvestIfNeeded(env);
    expect(res.status).toBe('ok');
    expect(res.season_closed).toBe(true);

    const elements = env.FPL_PULSE_KV._getJSON(kSeasonElements(2025));
    expect(elements.gws['3']).toBeTruthy();
    expect(env.FPL_PULSE_KV._getJSON(kSeasonBootstrap(2025))).not.toBeNull();
    expect(env.FPL_PULSE_KV._getJSON(kSnapshotCurrent)).toEqual({ season: 2025, last_gw: 3 });

    const marker = env.FPL_PULSE_KV._getJSON(kSeasonClosed(2025));
    expect(marker.final_gw).toBe(3);
    expect(marker.closed_at).toBeTruthy();
  });

  it('does not close while gameweeks remain', async () => {
    cleanup = mockFetch(routes(3, 2));

    const res = await harvestIfNeeded(env);
    expect(res.status).toBe('ok');
    expect(res.season_closed).toBe(false);
    expect(await isSeasonClosed(env.FPL_PULSE_KV, 2025)).toBe(false);
  });

  it('the next cron tick after close no-ops before any write', async () => {
    cleanup = mockFetch(routes(3, 3));
    await harvestIfNeeded(env);

    const before = JSON.stringify(env.FPL_PULSE_KV._getJSON(kSeasonElements(2025)));
    const res = await harvestIfNeeded(env);

    expect(res).toMatchObject({ status: 'noop', reason: 'season_closed' });
    expect(JSON.stringify(env.FPL_PULSE_KV._getJSON(kSeasonElements(2025)))).toBe(before);
  });

  // A partial harvest never reaches updateSnapshot, so it cannot reach the close either —
  // a season can never close on incomplete data.
  it('closes idempotently and does not re-stamp a reopened season', async () => {
    cleanup = mockFetch(routes(3, 3));
    await harvestIfNeeded(env);
    const first = env.FPL_PULSE_KV._getJSON(kSeasonClosed(2025));

    // Reopen, then let the cron run again: the snapshot already names the final GW, so
    // harvest exits at already_up_to_date and the reopen sticks.
    await env.FPL_PULSE_KV.delete(kSeasonClosed(2025));
    const res = await harvestIfNeeded(env);

    expect(res).toMatchObject({ status: 'noop', reason: 'already_up_to_date' });
    expect(env.FPL_PULSE_KV._getJSON(kSeasonClosed(2025))).toBeNull();
    expect(first.final_gw).toBe(3);
  });
});
