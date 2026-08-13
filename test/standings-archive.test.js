import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { archiveLeagueStandings, archiveAllLeagueStandings, standingsProvenance } from '../src/services/harvest.js';
import { circuitBreaker } from '../src/lib/fpl-api.js';
import { kLeagueStandings, kLeagueMembers, kSeasonBootstrap, kSeasonClosed, kDetectedSeason, isLeagueStandings } from '../src/lib/kv.js';
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

const idRange = (start, count) => Array.from({ length: count }, (_, i) => start + i);

// All events finished+data_checked → the archived season is complete → final.
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
    // Rosters recorded for THIS league in THIS season — the provenance ground truth.
    env = createMockEnv({
      [kLeagueMembers(852082, 2025)]: JSON.stringify([11, 22, 33]),
      [kLeagueMembers(99, 2025)]: JSON.stringify(idRange(1, 52)),
    });
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
      [kLeagueMembers(111, 2025)]: JSON.stringify([1, 2]),
      [kLeagueMembers(222, 2025)]: JSON.stringify([3, 4]),
      // Finality is read from the ARCHIVED season's stored bootstrap, never the live API.
      [kSeasonBootstrap(2025)]: JSON.stringify(completeBootstrap()),
    });
  });
  afterEach(() => {
    if (cleanup) cleanup();
    circuitBreaker.reset();
  });

  it('archives every tracked league discovered via KV scan, final when season complete', async () => {
    cleanup = mockFetch({
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

  it('does NOT mark final when the archived season is still in progress', async () => {
    await env.FPL_PULSE_KV.put(kSeasonBootstrap(2025), JSON.stringify(midSeasonBootstrap()));
    cleanup = mockFetch({
      [standingsUrl(111)]: standingsPage(111, 'L111', [row(1, 1, 100)]),
      [standingsUrl(222)]: standingsPage(222, 'L222', [row(3, 1, 200)]),
    });

    const res = await archiveAllLeagueStandings(env, 2025, {});
    expect(res.final).toBe(false);
    expect(env.FPL_PULSE_KV._getJSON(kLeagueStandings(111, 2025)).final).toBe(false);
  });

  it('one league failing does not sink the run', async () => {
    cleanup = mockFetch({
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
      [standingsUrl(111)]: standingsPage(111, 'L111', [row(1, 1, 100)]),
    });

    const res = await archiveAllLeagueStandings(env, 2025, { leagueId: 111 });
    expect(res.summary.total).toBe(1);
    expect(res.summary.written).toBe(1);
    expect(env.FPL_PULSE_KV._getJSON(kLeagueStandings(222, 2025))).toBeNull(); // untouched
  });

  // FPL reassigns mini-league IDs every season, so an ID present only in an OLD
  // season's roster names a different league today. Archiving it would fetch a
  // stranger's live table and store it as this season's result.
  it('ignores leagues whose members key belongs to a different season', async () => {
    await env.FPL_PULSE_KV.put(kLeagueMembers(333, 2024), JSON.stringify([9, 10]));
    cleanup = mockFetch({
      [standingsUrl(111)]: standingsPage(111, 'L111', [row(1, 1, 100)]),
      [standingsUrl(222)]: standingsPage(222, 'L222', [row(3, 1, 200)]),
      // No route for 333: if it were scanned, the fetch would 404 and show as failed.
    });

    const res = await archiveAllLeagueStandings(env, 2025, {});
    expect(res.summary.total).toBe(2);
    expect(res.summary.failed).toBe(0);
    expect(env.FPL_PULSE_KV._getJSON(kLeagueStandings(333, 2025))).toBeNull();
  });

  // A pre-migration key carries no season, so we cannot tell which season it
  // describes — it must not be archived on a guess.
  it('ignores a legacy unscoped members key', async () => {
    await env.FPL_PULSE_KV.put('league:444:members', JSON.stringify([11, 12]));
    cleanup = mockFetch({
      [standingsUrl(111)]: standingsPage(111, 'L111', [row(1, 1, 100)]),
      [standingsUrl(222)]: standingsPage(222, 'L222', [row(3, 1, 200)]),
    });

    const res = await archiveAllLeagueStandings(env, 2025, {});
    expect(res.summary.total).toBe(2);
    expect(res.summary.failed).toBe(0);
    expect(env.FPL_PULSE_KV._getJSON(kLeagueStandings(444, 2025))).toBeNull();
  });

  it('re-running after a final capture skips already-final leagues (idempotent resume)', async () => {
    cleanup = mockFetch({
      [standingsUrl(111)]: standingsPage(111, 'L111', [row(1, 1, 100)]),
      [standingsUrl(222)]: standingsPage(222, 'L222', [row(3, 1, 200)]),
    });

    await archiveAllLeagueStandings(env, 2025, {});
    const second = await archiveAllLeagueStandings(env, 2025, {});
    expect(second.summary.written).toBe(0);
    expect(second.summary.skipped).toBe(2);
  });
});

// === Archive provenance ===
//
// The live standings API only ever serves the CURRENT season. Archiving a past season
// therefore fetches whatever league now holds that id — a different league belonging to
// strangers — and, before this guard, wrote it under the archived season's key.
describe('archiveLeagueStandings — provenance guard', () => {
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

  it('archives when the fetched table matches the recorded roster', async () => {
    await env.FPL_PULSE_KV.put(kLeagueMembers(9385, 2025), JSON.stringify([11, 22, 33]));
    cleanup = mockFetch({
      [standingsUrl(9385)]: standingsPage(9385, 'Dundanion Road', [row(11, 1, 2343), row(22, 2, 2296), row(33, 3, 2290)]),
    });

    const res = await archiveLeagueStandings(env, 9385, 2025, { isFinal: true });
    expect(res.status).toBe('written');
    expect(res.provenance).toMatchObject({ verified: true, overlap: 3, overlap_ratio: 1 });
  });

  // The headline bug: league 9385 in 2026 is a real, different league.
  it('refuses a table that shares nothing with the recorded roster, and writes nothing', async () => {
    await env.FPL_PULSE_KV.put(kLeagueMembers(9385, 2025), JSON.stringify([11, 22, 33]));
    cleanup = mockFetch({
      [standingsUrl(9385)]: standingsPage(9385, "Someone Else's League", [
        row(900001, 1, 2100), row(900002, 2, 2050), row(900003, 3, 2000),
      ]),
    });

    const res = await archiveLeagueStandings(env, 9385, 2025, { isFinal: true });
    expect(res.status).toBe('refused');
    expect(res.reason).toBe('provenance_mismatch');
    expect(res.provenance).toMatchObject({ overlap: 0, overlap_ratio: 0, member_count: 3 });
    expect(env.FPL_PULSE_KV._getJSON(kLeagueStandings(9385, 2025))).toBeNull();
  });

  // THE CASE A SEASON-EQUALITY CHECK GETS WRONG. Mid-July: FPL has published the new
  // fixture list so detection reports 2026, but classic standings still serve 2025.
  // `season !== getEffectiveSeason(env)` would refuse here — exactly when the data is
  // still retrievable and about to be destroyed. Provenance sees the roster and proceeds.
  it('archives during the July window, when detection has flipped but standings have not', async () => {
    await env.FPL_PULSE_KV.put(kDetectedSeason, JSON.stringify({
      season: 2026, detected_at: new Date().toISOString(),
    }));
    await env.FPL_PULSE_KV.put(kLeagueMembers(9385, 2025), JSON.stringify([11, 22, 33]));
    cleanup = mockFetch({
      [standingsUrl(9385)]: standingsPage(9385, 'Dundanion Road', [row(11, 1, 2343), row(22, 2, 2296), row(33, 3, 2290)]),
    });

    const res = await archiveLeagueStandings(env, 9385, 2025, { isFinal: true });
    expect(res.status).toBe('written');
    expect(env.FPL_PULSE_KV._getJSON(kLeagueStandings(9385, 2025)).results).toHaveLength(3);
  });

  // The mistyped-league-id path: archiveAllLeagueStandings finds leagues VIA members keys,
  // but the single-league `leagueId` option bypasses that scan entirely.
  it('refuses when no roster was ever recorded for that league and season', async () => {
    cleanup = mockFetch({
      [standingsUrl(4242)]: standingsPage(4242, 'Unknown', [row(1, 1, 100), row(2, 2, 90)]),
    });

    const res = await archiveLeagueStandings(env, 4242, 2025, { isFinal: true });
    expect(res.status).toBe('refused');
    expect(res.reason).toBe('no_members_key');
    expect(env.FPL_PULSE_KV._getJSON(kLeagueStandings(4242, 2025))).toBeNull();
  });

  it('allow_unverified overrides the refusal', async () => {
    await env.FPL_PULSE_KV.put(kLeagueMembers(9385, 2025), JSON.stringify([11, 22, 33]));
    cleanup = mockFetch({
      [standingsUrl(9385)]: standingsPage(9385, 'Other', [row(900001, 1, 2100)]),
    });

    const res = await archiveLeagueStandings(env, 9385, 2025, { isFinal: true, allowUnverified: true });
    expect(res.status).toBe('written');
    expect(res.provenance.verified).toBe(false);
  });

  it('tolerates summer churn — a majority of the roster still present', async () => {
    await env.FPL_PULSE_KV.put(kLeagueMembers(9385, 2025), JSON.stringify(idRange(1, 10)));
    cleanup = mockFetch({
      // 6 of 10 remain, 4 left over the summer.
      [standingsUrl(9385)]: standingsPage(9385, 'L', idRange(1, 6).map((e, i) => row(e, i + 1, 100 - i))),
    });

    const res = await archiveLeagueStandings(env, 9385, 2025, { isFinal: true });
    expect(res.status).toBe('written');
    expect(res.provenance.overlap_ratio).toBe(0.6);
  });

  // The absolute floor carries the case the ratio gets wrong: a league that grew a lot
  // keeps only a small FRACTION of its old roster while obviously being the same league.
  it('accepts a heavily grown league via the absolute overlap floor', async () => {
    await env.FPL_PULSE_KV.put(kLeagueMembers(9385, 2025), JSON.stringify(idRange(1, 20)));
    cleanup = mockFetch({
      [standingsUrl(9385)]: standingsPage(9385, 'L', [
        ...idRange(1, 3).map((e, i) => row(e, i + 1, 100 - i)),
        ...idRange(500, 50).map((e, i) => row(e, i + 4, 50 - i)),
      ]),
    });

    const res = await archiveLeagueStandings(env, 9385, 2025, { isFinal: true });
    expect(res.status).toBe('written');
    expect(res.provenance.overlap).toBe(3);
    expect(res.provenance.overlap_ratio).toBe(0.15); // below the ratio rule; the floor carries it
  });
});

describe('standingsProvenance thresholds', () => {
  const rows = (ids) => ids.map((e, i) => ({ entry: e, rank: i + 1 }));

  it('is unverified with no roster to compare against', () => {
    expect(standingsProvenance(rows([1, 2]), null).reason).toBe('no_members_key');
    expect(standingsProvenance(rows([1, 2]), []).reason).toBe('no_members_key');
  });

  it('measures overlap against the recorded roster, not the fetched table', () => {
    // 20 fetched, 2 of the 2 recorded members present → ratio 1, not 0.1.
    const p = standingsProvenance(rows(idRange(1, 20)), [1, 2]);
    expect(p).toMatchObject({ verified: true, overlap: 2, overlap_ratio: 1 });
  });

  // Small leagues are where the ratio is noisiest, and where allow_unverified exists.
  it('refuses a tiny league that has churned below both rules', () => {
    const p = standingsProvenance(rows([1, 900001, 900002]), [1, 2, 3]);
    expect(p.overlap).toBe(1);
    expect(p.overlap_ratio).toBeCloseTo(0.33, 2);
    expect(p.verified).toBe(false);
  });

  it('two unrelated leagues never verify', () => {
    expect(standingsProvenance(rows(idRange(900000, 50)), idRange(1, 20)).verified).toBe(false);
  });
});

describe('isFinal derivation', () => {
  let env;
  let cleanup;

  beforeEach(() => {
    circuitBreaker.reset();
    env = createMockEnv({ [kLeagueMembers(111, 2025)]: JSON.stringify([1, 2]) });
  });
  afterEach(() => {
    if (cleanup) cleanup();
    circuitBreaker.reset();
  });

  // A live bootstrap describes whatever season FPL is currently serving. During a rollover
  // that is not the season being archived, and stamping its finality here is how a
  // mid-season table acquires a permanent final:true.
  it('reads finality from the archived season, ignoring the live API entirely', async () => {
    await env.FPL_PULSE_KV.put(kSeasonBootstrap(2025), JSON.stringify(midSeasonBootstrap()));
    cleanup = mockFetch({
      // A live bootstrap saying "complete" must not leak into the 2025 archive.
      [BOOT]: completeBootstrap(),
      [standingsUrl(111)]: standingsPage(111, 'L111', [row(1, 1, 100)]),
    });

    const res = await archiveAllLeagueStandings(env, 2025, {});
    expect(res.final).toBe(false);
    expect(env.FPL_PULSE_KV._getJSON(kLeagueStandings(111, 2025)).final).toBe(false);
  });

  it('stamps final when the archived season is complete', async () => {
    await env.FPL_PULSE_KV.put(kSeasonBootstrap(2025), JSON.stringify(completeBootstrap()));
    cleanup = mockFetch({
      [standingsUrl(111)]: standingsPage(111, 'L111', [row(1, 1, 100)]),
    });

    const res = await archiveAllLeagueStandings(env, 2025, {});
    expect(res.final).toBe(true);
  });

  // No stored bootstrap is no evidence. A non-final archive stays overwritable and is
  // never served as authoritative, so false is the safe answer.
  it('does not stamp final when the archived season has no stored bootstrap', async () => {
    cleanup = mockFetch({
      [standingsUrl(111)]: standingsPage(111, 'L111', [row(1, 1, 100)]),
    });

    const res = await archiveAllLeagueStandings(env, 2025, {});
    expect(res.final).toBe(false);
  });
});

// Flag ④: the archive is EXEMPT from season immutability. Close fires at final-gameweek-
// finished, and the archive's entire purpose is to capture standings after that, in the
// window before FPL's rollover — gating it would make it unrunnable exactly when needed.
// Its own write-once `final` guard and the provenance gate are the correct protections.
describe('archiveLeagueStandings after season close', () => {
  let env;
  let cleanup;

  beforeEach(async () => {
    circuitBreaker.reset();
    env = createMockEnv({
      [kLeagueMembers(111, 2025)]: JSON.stringify([1, 2]),
      [kSeasonBootstrap(2025)]: JSON.stringify(completeBootstrap()),
    });
    await env.FPL_PULSE_KV.put(kSeasonClosed(2025), JSON.stringify({ closed_at: 'x', final_gw: 38 }));
  });
  afterEach(() => {
    if (cleanup) cleanup();
    circuitBreaker.reset();
  });

  it('still writes the final table for a closed season', async () => {
    cleanup = mockFetch({
      [standingsUrl(111)]: standingsPage(111, 'L111', [row(1, 1, 100)]),
    });

    const res = await archiveAllLeagueStandings(env, 2025, {});
    expect(res.summary.written).toBe(1);

    const stored = env.FPL_PULSE_KV._getJSON(kLeagueStandings(111, 2025));
    expect(stored.final).toBe(true);
    expect(isLeagueStandings(stored)).toBe(true);
  });

  // Three guards, three jobs. Close stops the harvest rewriting the season; write-once
  // stops a later archive run replacing a captured final table with a post-rollover reset
  // one; provenance stops a different league's table being written at all.
  it('write-once still refuses to clobber a final table on a closed season', async () => {
    cleanup = mockFetch({
      [standingsUrl(111)]: standingsPage(111, 'L111', [row(1, 1, 100)]),
    });

    await archiveAllLeagueStandings(env, 2025, {});
    const second = await archiveAllLeagueStandings(env, 2025, {});
    expect(second.summary.written).toBe(0);
    expect(second.summary.skipped).toBe(1);
  });

  it('provenance still refuses a stranger\'s table on a closed season', async () => {
    cleanup = mockFetch({
      [standingsUrl(111)]: standingsPage(111, 'Other', [row(900001, 1, 2100), row(900002, 2, 2000)]),
    });

    const res = await archiveAllLeagueStandings(env, 2025, {});
    expect(res.summary.refused).toBe(1);
    expect(env.FPL_PULSE_KV._getJSON(kLeagueStandings(111, 2025))).toBeNull();
  });
});
