import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { archiveLeagueStandings, archiveAllLeagueStandings } from '../src/services/harvest.js';
import { circuitBreaker } from '../src/lib/fpl-api.js';
import { kLeagueStandings, kLeagueMembers, isLeagueStandings } from '../src/lib/kv.js';
import { createMockEnv, mockFetch } from './helpers/mocks.js';

const BOOT = 'https://fantasy.premierleague.com/api/bootstrap-static/';
const standingsUrl = (id, page = 1) =>
  page === 1
    ? `https://fantasy.premierleague.com/api/leagues-classic/${id}/standings/`
    : `https://fantasy.premierleague.com/api/leagues-classic/${id}/standings/?page_standings=${page}`;

// A row carrying the full FPL shape (incl. fields beyond the spec's list) so we can
// assert nothing is trimmed on the way into KV.
const row = (entry, rank, total) => ({
  id: entry,
  entry,
  entry_name: `Team ${entry}`,
  player_name: `Player ${entry}`,
  rank,
  last_rank: rank,
  rank_sort: rank,
  total,
  event_total: 50,
  has_played: true,
  club_badge_src: `badge-${entry}.png`,
});

const standingsPage = (id, name, results, hasNext = false) => ({
  league: { id, name },
  standings: { has_next: hasNext, results },
});

// All-events-finished bootstrap → detectLatestFinishedGW === events.length → final.
const completeBootstrap = (n = 38) => ({
  events: Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    deadline_time: `2025-08-16T17:30:00Z`,
    finished: true,
    data_checked: true,
  })),
});

// Season still in progress: last event unfinished.
const midSeasonBootstrap = (n = 38) => ({
  events: Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    deadline_time: `2025-08-16T17:30:00Z`,
    finished: i < n - 1,
    data_checked: i < n - 1,
  })),
});

describe('archiveLeagueStandings', () => {
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

  it('writes the full untrimmed table and stamps final when isFinal', async () => {
    cleanup = mockFetch({
      [standingsUrl(852082)]: standingsPage(852082, 'My League', [
        row(11, 1, 2343), row(22, 2, 2296), row(33, 3, 2290),
      ]),
    });

    const res = await archiveLeagueStandings(env, 852082, 2025, { isFinal: true });
    expect(res.status).toBe('written');
    expect(res.member_count).toBe(3);
    expect(res.final).toBe(true);

    const stored = env.FPL_PULSE_KV._getJSON(kLeagueStandings(852082, 2025));
    expect(isLeagueStandings(stored)).toBe(true);
    expect(stored.season).toBe(2025);
    expect(stored.member_count).toBe(3);
    expect(stored.final).toBe(true);
    expect(stored.league).toEqual({ id: 852082, name: 'My League' });
    // Untrimmed: extra fields survive the write.
    expect(stored.results[0]).toMatchObject({
      entry: 11, entry_name: 'Team 11', player_name: 'Player 11',
      rank: 1, last_rank: 1, total: 2343,
      event_total: 50, has_played: true, club_badge_src: 'badge-11.png',
    });
  });

  it('aggregates rows across multiple pages', async () => {
    const pageOne = Array.from({ length: 50 }, (_, i) => row(i + 1, i + 1, 1000 - i));
    const pageTwo = [row(51, 51, 949), row(52, 52, 948)];
    cleanup = mockFetch({
      [standingsUrl(99)]: standingsPage(99, 'Big', pageOne, true),
      [standingsUrl(99, 2)]: standingsPage(99, 'Big', pageTwo, false),
    });

    const res = await archiveLeagueStandings(env, 99, 2025, { isFinal: true });
    expect(res.status).toBe('written');
    expect(res.member_count).toBe(52);
    expect(res.pages_fetched).toBe(2);

    const stored = env.FPL_PULSE_KV._getJSON(kLeagueStandings(99, 2025));
    expect(stored.results).toHaveLength(52);
    expect(stored.results[51].entry).toBe(52);
  });

  it('write-once guard: skips an already-final table without force', async () => {
    await env.FPL_PULSE_KV.put(kLeagueStandings(852082, 2025), JSON.stringify({
      season: 2025, harvested_at: 'earlier', member_count: 3, final: true, results: [row(1, 1, 100)],
    }));
    cleanup = mockFetch({}); // no standings route — proves we never fetch

    const res = await archiveLeagueStandings(env, 852082, 2025, { isFinal: true });
    expect(res.status).toBe('skipped');
    expect(res.reason).toBe('already_final');

    const stored = env.FPL_PULSE_KV._getJSON(kLeagueStandings(852082, 2025));
    expect(stored.harvested_at).toBe('earlier'); // untouched
  });

  it('force overrides the write-once guard', async () => {
    await env.FPL_PULSE_KV.put(kLeagueStandings(852082, 2025), JSON.stringify({
      season: 2025, harvested_at: 'earlier', member_count: 1, final: true, results: [row(1, 1, 100)],
    }));
    cleanup = mockFetch({
      [standingsUrl(852082)]: standingsPage(852082, 'My League', [row(11, 1, 2343), row(22, 2, 2296)]),
    });

    const res = await archiveLeagueStandings(env, 852082, 2025, { isFinal: true, force: true });
    expect(res.status).toBe('written');
    expect(res.overwrote).toBe(true);

    const stored = env.FPL_PULSE_KV._getJSON(kLeagueStandings(852082, 2025));
    expect(stored.member_count).toBe(2);
    expect(stored.harvested_at).not.toBe('earlier');
  });

  it('aborts without writing a partial table when the page budget is exhausted', async () => {
    cleanup = mockFetch({
      [standingsUrl(99)]: standingsPage(99, 'Big', [row(1, 1, 100)], true), // needs page 2
    });

    const res = await archiveLeagueStandings(env, 99, 2025, { isFinal: true, budget: 1 });
    expect(res.status).toBe('budget_exhausted');
    expect(res.pages_fetched).toBe(1);
    // Nothing written — never persist a partial table.
    expect(env.FPL_PULSE_KV._getJSON(kLeagueStandings(99, 2025))).toBeNull();
  });
});

describe('archiveAllLeagueStandings', () => {
  let env;
  let cleanup;

  beforeEach(() => {
    circuitBreaker.reset();
    env = createMockEnv({
      [kLeagueMembers(111)]: JSON.stringify([1, 2]),
      [kLeagueMembers(222)]: JSON.stringify([3, 4]),
    });
  });
  afterEach(() => {
    if (cleanup) cleanup();
    circuitBreaker.reset();
  });

  it('archives every tracked league discovered via KV scan, final when season complete', async () => {
    cleanup = mockFetch({
      [BOOT]: completeBootstrap(),
      [standingsUrl(111)]: standingsPage(111, 'L111', [row(1, 1, 100)]),
      [standingsUrl(222)]: standingsPage(222, 'L222', [row(3, 1, 200)]),
    });

    const res = await archiveAllLeagueStandings(env, 2025, {});
    expect(res.ok).toBe(true);
    expect(res.final).toBe(true);
    expect(res.summary).toMatchObject({ total: 2, written: 2, skipped: 0, failed: 0, remaining: 0 });
    expect(env.FPL_PULSE_KV._getJSON(kLeagueStandings(111, 2025)).final).toBe(true);
    expect(env.FPL_PULSE_KV._getJSON(kLeagueStandings(222, 2025)).final).toBe(true);
  });

  it('does NOT mark final when the season is still in progress', async () => {
    cleanup = mockFetch({
      [BOOT]: midSeasonBootstrap(),
      [standingsUrl(111)]: standingsPage(111, 'L111', [row(1, 1, 100)]),
      [standingsUrl(222)]: standingsPage(222, 'L222', [row(3, 1, 200)]),
    });

    const res = await archiveAllLeagueStandings(env, 2025, {});
    expect(res.final).toBe(false);
    expect(env.FPL_PULSE_KV._getJSON(kLeagueStandings(111, 2025)).final).toBe(false);
  });

  it('one league failing does not sink the run', async () => {
    cleanup = mockFetch({
      [BOOT]: completeBootstrap(),
      [standingsUrl(111)]: standingsPage(111, 'L111', [row(1, 1, 100)]),
      [standingsUrl(222)]: new Error('boom'),
    });

    const res = await archiveAllLeagueStandings(env, 2025, {});
    expect(res.summary.written).toBe(1);
    expect(res.summary.failed).toBe(1);
    expect(res.ok).toBe(false);
    // The healthy league still got archived.
    expect(env.FPL_PULSE_KV._getJSON(kLeagueStandings(111, 2025))).not.toBeNull();
  });

  it('targets a single league when leagueId is supplied', async () => {
    cleanup = mockFetch({
      [BOOT]: completeBootstrap(),
      [standingsUrl(111)]: standingsPage(111, 'L111', [row(1, 1, 100)]),
    });

    const res = await archiveAllLeagueStandings(env, 2025, { leagueId: 111 });
    expect(res.summary.total).toBe(1);
    expect(res.summary.written).toBe(1);
    expect(env.FPL_PULSE_KV._getJSON(kLeagueStandings(222, 2025))).toBeNull(); // untouched
  });

  it('re-running after a final capture skips already-final leagues (idempotent resume)', async () => {
    cleanup = mockFetch({
      [BOOT]: completeBootstrap(),
      [standingsUrl(111)]: standingsPage(111, 'L111', [row(1, 1, 100)]),
      [standingsUrl(222)]: standingsPage(222, 'L222', [row(3, 1, 200)]),
    });

    await archiveAllLeagueStandings(env, 2025, {});
    const second = await archiveAllLeagueStandings(env, 2025, {});
    expect(second.summary.written).toBe(0);
    expect(second.summary.skipped).toBe(2);
  });
});
