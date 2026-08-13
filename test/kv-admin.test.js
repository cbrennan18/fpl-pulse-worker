import { describe, it, expect, beforeEach } from 'vitest';
import { handleAdminRoute } from '../src/routes/admin.js';
import {
  kLeagueMembers, kLeagueStandings, kSeasonBootstrap, kSeasonElements, kEntrySeason, kEntryState,
  kSeasonClosed,
} from '../src/lib/kv.js';
import { createMockEnv } from './helpers/mocks.js';

// createMockEnv sets SEASON = "2025" and seeds no config:detected_season, so the
// audit/cleanup endpoints resolve currentSeason = 2025.
const CURRENT = 2025;
const OLD = 2024;

const adminGet = (env, path) =>
  handleAdminRoute(
    new Request(`https://worker.dev${path}`, {
      method: 'GET',
      headers: { 'x-refresh-token': 'test-token' },
    }),
    env,
    CURRENT
  );

const adminPost = (env, path, body) =>
  handleAdminRoute(
    new Request(`https://worker.dev${path}`, {
      method: 'POST',
      headers: { 'x-refresh-token': 'test-token' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    CURRENT
  );

describe('GET /admin/kv/audit — key categorisation', () => {
  it('categorises season-scoped members and standings keys instead of leaving them unknown', async () => {
    const env = createMockEnv({
      [kLeagueMembers(9385, CURRENT)]: JSON.stringify([1, 2]),
      [kLeagueMembers(9385, OLD)]: JSON.stringify([3, 4]),
      [kLeagueStandings(9385, OLD)]: JSON.stringify({ season: OLD, results: [] }),
      'league:852082:members': JSON.stringify([5]), // pre-migration legacy form
    });

    const body = await (await adminGet(env, '/admin/kv/audit')).json();

    expect(body.issues.unknown_keys).toEqual([]);
    expect(body.categories.league_members.count).toBe(2);
    expect(body.categories.league_members.current_season).toBe(1);
    expect(body.categories.league_members.old_season).toBe(1);
    expect(body.categories.league_standings.count).toBe(1);
    expect(body.categories.league_members_legacy.count).toBe(1);
  });

  it('lists old-season archive keys as protected, not as deletion candidates', async () => {
    const env = createMockEnv({
      // Build scaffolding — no read route serves it, so it stays deletable.
      [kEntryState(77, OLD)]: JSON.stringify({ status: 'complete' }),
      // Everything a season-scoped read route serves is archive.
      [kEntrySeason(77, OLD)]: JSON.stringify({ entry_id: 77 }),
      [kSeasonBootstrap(OLD)]: JSON.stringify({ events: [] }),
      [kSeasonElements(OLD)]: JSON.stringify({ last_gw_processed: 38, gws: {} }),
      [kLeagueMembers(9385, OLD)]: JSON.stringify([1]),
      [kLeagueStandings(9385, OLD)]: JSON.stringify({ season: OLD, results: [] }),
    });

    const body = await (await adminGet(env, '/admin/kv/audit')).json();

    expect(body.issues.old_season_keys).toEqual([kEntryState(77, OLD)]);
    expect(body.issues.archival_keys.sort()).toEqual([
      kEntrySeason(77, OLD),
      kLeagueMembers(9385, OLD),
      kLeagueStandings(9385, OLD),
      kSeasonBootstrap(OLD),
      kSeasonElements(OLD),
    ].sort());
  });
});

describe('POST /admin/kv/cleanup — closed_season target', () => {
  let env;

  beforeEach(() => {
    env = createMockEnv({
      // Season OLD is RECORDED closed. Without this marker none of its keys are
      // candidates at all — the target keys off recorded state, not recency.
      [kSeasonClosed(OLD)]: JSON.stringify({ closed_at: '2025-05-25T18:00:00.000Z', final_gw: 38 }),
      // Deletable: build scaffolding. No read route serves entry state, and when the
      // blob is absent public.js 404s for `complete` exactly as for a missing key.
      [kEntryState(77, OLD)]: JSON.stringify({ status: 'complete' }),
      [kEntryState(88, OLD)]: JSON.stringify({ status: 'errored' }),
      // The archive: everything a season-scoped read route serves, and unrecoverable
      // from the live FPL API once the season rolls over.
      [kEntrySeason(77, OLD)]: JSON.stringify({ entry_id: 77 }),
      [kSeasonElements(OLD)]: JSON.stringify({ last_gw_processed: 38, gws: {} }),
      [kSeasonBootstrap(OLD)]: JSON.stringify({ events: [] }),
      [kLeagueMembers(9385, OLD)]: JSON.stringify([1, 2]),
      [kLeagueStandings(9385, OLD)]: JSON.stringify({ season: OLD, results: [] }),
      // Current season must never be touched by this target.
      [kEntrySeason(77, CURRENT)]: JSON.stringify({ entry_id: 77 }),
      [kLeagueMembers(9385, CURRENT)]: JSON.stringify([1, 2]),
    });
  });

  it('dry run offers only non-archival keys of a closed season, and names the refusals', async () => {
    const body = await (await adminPost(env, '/admin/kv/cleanup', {
      targets: ['closed_season'],
    })).json();

    // Entry state is the bulk of the old-season namespace, so the target keeps a job.
    expect(body.would_delete_count).toBe(2);
    expect(body.would_delete.map(d => d.key).sort()).toEqual([
      kEntryState(77, OLD),
      kEntryState(88, OLD),
    ].sort());

    expect(body.protected_count).toBe(5);
    expect(body.protected.map(p => p.key).sort()).toEqual([
      kEntrySeason(77, OLD),
      kLeagueMembers(9385, OLD),
      kLeagueStandings(9385, OLD),
      kSeasonBootstrap(OLD),
      kSeasonElements(OLD),
    ].sort());
    expect(body.protected.every(p => p.reason === 'archival_protected')).toBe(true);
  });

  it('a real run deletes the scaffolding and leaves every archive key in KV', async () => {
    const res = await adminPost(env, '/admin/kv/cleanup', {
      targets: ['closed_season'],
      dry_run: false,
      confirm_count: 2,
    });
    expect(res.status).toBe(200);

    // Scaffolding gone.
    expect(env.FPL_PULSE_KV._getJSON(kEntryState(77, OLD))).toBeNull();
    expect(env.FPL_PULSE_KV._getJSON(kEntryState(88, OLD))).toBeNull();
    // Archive intact.
    expect(env.FPL_PULSE_KV._getJSON(kEntrySeason(77, OLD))).not.toBeNull();
    expect(env.FPL_PULSE_KV._getJSON(kSeasonElements(OLD))).not.toBeNull();
    expect(env.FPL_PULSE_KV._getJSON(kSeasonBootstrap(OLD))).not.toBeNull();
    expect(env.FPL_PULSE_KV._getJSON(kLeagueMembers(9385, OLD))).toEqual([1, 2]);
    expect(env.FPL_PULSE_KV._getJSON(kLeagueStandings(9385, OLD))).not.toBeNull();
    // Current season untouched.
    expect(env.FPL_PULSE_KV._getJSON(kEntrySeason(77, CURRENT))).not.toBeNull();
    expect(env.FPL_PULSE_KV._getJSON(kLeagueMembers(9385, CURRENT))).toEqual([1, 2]);
  });

  it('confirm_count counts only the deletable keys, not the protected ones', async () => {
    // 7 would be the pre-guard candidate count; supplying it must be rejected.
    const res = await adminPost(env, '/admin/kv/cleanup', {
      targets: ['closed_season'],
      dry_run: false,
      confirm_count: 7,
    });
    expect(res.status).toBe(409);
    expect(env.FPL_PULSE_KV._getJSON(kEntryState(77, OLD))).not.toBeNull();
  });
});

describe('POST /admin/kv/migrate-members', () => {
  let env;

  beforeEach(() => {
    env = createMockEnv({
      'league:9385:members': JSON.stringify([11, 22]),
      'league:852082:members': JSON.stringify([33]),
      // Already-scoped keys must be left out of the migration entirely.
      [kLeagueMembers(1373455, CURRENT)]: JSON.stringify([44]),
      // Provenance for season OLD: 9385 is fully built, 852082 was ingested but its
      // builds haven't run yet. Both are genuinely OLD-season leagues.
      [kEntrySeason(11, OLD)]: JSON.stringify({ entry_id: 11 }),
      [kEntrySeason(22, OLD)]: JSON.stringify({ entry_id: 22 }),
      [kEntryState(33, OLD)]: JSON.stringify({ status: 'queued' }),
    });
  });

  it('rejects a request without an explicit season', async () => {
    const res = await adminPost(env, '/admin/kv/migrate-members', { dry_run: false });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('season_required');
  });

  it('defaults to a dry run that writes nothing', async () => {
    const body = await (await adminPost(env, '/admin/kv/migrate-members', { season: OLD })).json();

    expect(body.dry_run).toBe(true);
    expect(body.legacy_keys_found).toBe(2);
    expect(body.summary.would_copy).toBe(2);
    expect(body.summary.copied).toBe(0);
    expect(env.FPL_PULSE_KV._getJSON(kLeagueMembers(9385, OLD))).toBeNull();
  });

  it('copies to the season-scoped key and leaves the legacy key in place', async () => {
    const body = await (await adminPost(env, '/admin/kv/migrate-members', {
      season: OLD,
      dry_run: false,
    })).json();

    expect(body.summary.copied).toBe(2);
    expect(env.FPL_PULSE_KV._getJSON(kLeagueMembers(9385, OLD))).toEqual([11, 22]);
    expect(env.FPL_PULSE_KV._getJSON(kLeagueMembers(852082, OLD))).toEqual([33]);
    // COPY, not move — the deployed worker still reads the legacy key.
    expect(env.FPL_PULSE_KV._getJSON('league:9385:members')).toEqual([11, 22]);
    // A key that was already scoped is not re-migrated under the target season.
    expect(env.FPL_PULSE_KV._getJSON(kLeagueMembers(1373455, OLD))).toBeNull();
  });

  it('is idempotent: a second run skips existing targets without overwriting them', async () => {
    await adminPost(env, '/admin/kv/migrate-members', { season: OLD, dry_run: false });
    // Simulate the target having moved on (e.g. a later ingest) — it must survive.
    await env.FPL_PULSE_KV.put(kLeagueMembers(9385, OLD), JSON.stringify([99]));

    const body = await (await adminPost(env, '/admin/kv/migrate-members', {
      season: OLD,
      dry_run: false,
    })).json();

    expect(body.summary.copied).toBe(0);
    expect(body.summary.skipped).toBe(2);
    expect(body.results.every(r => r.reason === 'target_exists')).toBe(true);
    expect(env.FPL_PULSE_KV._getJSON(kLeagueMembers(9385, OLD))).toEqual([99]);
  });

  it('refuses to copy a legacy key whose value is not a members array', async () => {
    await env.FPL_PULSE_KV.put('league:555:members', JSON.stringify({ not: 'an array' }));

    const body = await (await adminPost(env, '/admin/kv/migrate-members', {
      season: OLD,
      dry_run: false,
    })).json();

    expect(body.ok).toBe(false);
    expect(body.summary.invalid).toBe(1);
    expect(env.FPL_PULSE_KV._getJSON(kLeagueMembers(555, OLD))).toBeNull();
    // The valid keys still migrate — one bad key does not sink the run.
    expect(body.summary.copied).toBe(2);
  });

  // A legacy key carries no season of its own. Stamping the wrong one produces a roster
  // that then looks authoritative, which is the exact corruption class this project
  // exists to prevent — so the write is blocked rather than warned about.
  describe('provenance gate', () => {
    it('reports the blob ratio per key in the dry run', async () => {
      const body = await (await adminPost(env, '/admin/kv/migrate-members', { season: OLD })).json();

      const built = body.results.find(r => r.from === 'league:9385:members');
      expect(built.provenance).toMatchObject({ member_count: 2, blobs_present: 2, blob_ratio: 1 });

      const pending = body.results.find(r => r.from === 'league:852082:members');
      expect(pending.provenance).toMatchObject({ member_count: 1, blobs_present: 0, states_present: 1, blob_ratio: 0 });
    });

    it('blocks a key with no footprint at all in the season being stamped', async () => {
      // Same rosters, but stamped with a season they have no evidence for.
      const body = await (await adminPost(env, '/admin/kv/migrate-members', {
        season: 2019,
        dry_run: false,
      })).json();

      expect(body.ok).toBe(false);
      expect(body.summary.blocked).toBe(2);
      expect(body.summary.copied).toBe(0);
      expect(body.results.every(r => r.reason === 'no_season_evidence')).toBe(true);
      expect(env.FPL_PULSE_KV._getJSON(kLeagueMembers(9385, 2019))).toBeNull();
    });

    // The case a naive ratio gate would get wrong: a league ingested this week has zero
    // blobs but a full set of queued states, and must still migrate.
    it('does not block a freshly ingested league that has states but no blobs yet', async () => {
      const body = await (await adminPost(env, '/admin/kv/migrate-members', {
        season: OLD,
        dry_run: false,
      })).json();

      expect(body.summary.blocked).toBe(0);
      expect(env.FPL_PULSE_KV._getJSON(kLeagueMembers(852082, OLD))).toEqual([33]);
    });

    it('allow_unverified overrides the block and flags what it wrote', async () => {
      const body = await (await adminPost(env, '/admin/kv/migrate-members', {
        season: 2019,
        dry_run: false,
        allow_unverified: true,
      })).json();

      expect(body.summary.copied).toBe(2);
      expect(body.results.every(r => r.warning)).toBe(true);
      expect(env.FPL_PULSE_KV._getJSON(kLeagueMembers(9385, 2019))).toEqual([11, 22]);
    });

    it('lets an empty roster through — there is nothing to mislabel', async () => {
      const emptyEnv = createMockEnv({ 'league:777:members': JSON.stringify([]) });

      const body = await (await adminPost(emptyEnv, '/admin/kv/migrate-members', {
        season: OLD,
        dry_run: false,
      })).json();

      expect(body.summary.copied).toBe(1);
      expect(body.results[0].provenance.blob_ratio).toBeNull();
    });
  });
});

describe('admin season immutability gate', () => {
  let env;

  const closed = () => env.FPL_PULSE_KV.put(
    kSeasonClosed(CURRENT), JSON.stringify({ closed_at: '2026-05-25T18:00:00.000Z', final_gw: 38 })
  );

  beforeEach(() => { env = createMockEnv(); });

  // Every endpoint that writes season-scoped data. Listed explicitly so a new writer added
  // without a gate shows up here as a gap rather than silently corrupting an archive.
  const writePaths = [
    ['/admin/entries/states/bulk', { action: 'requeue', entry_ids: [1] }],
    ['/admin/entries/states/bulk', { action: 'purge', entry_ids: [1] }],
    ['/admin/dead/revive', {}],
    ['/admin/backfill', {}],
    ['/admin/season/elements/backfill', {}],
    ['/admin/entries/1/revive', {}],
    ['/admin/entry/1/force-rebuild', {}],
    ['/admin/entry/1/enqueue', {}],
    ['/admin/league/9385/ingest', {}],
  ];

  it.each(writePaths)('refuses %s with 409 when the season is closed', async (path, body) => {
    await closed();
    const res = await adminPost(env, path, body);
    expect(res.status).toBe(409);

    const json = await res.json();
    expect(json.error).toBe('season_closed');
    expect(json.closed_at).toBe('2026-05-25T18:00:00.000Z');
    expect(json.message).toContain('/admin/season/2025/reopen');
  });

  it('leaves the standings archive endpoint reachable — it exists to run after close', async () => {
    await closed();
    // Not a 409. It proceeds to the archive logic, which fails only on the absent fetch mock.
    const res = await adminPost(env, '/admin/standings/archive', { season: CURRENT });
    expect(res.status).not.toBe(409);
  });

  it('does not gate read-only or cross-season endpoints', async () => {
    await closed();
    expect((await adminGet(env, '/admin/kv/audit')).status).toBe(200);
    expect((await adminPost(env, '/admin/kv/cleanup', { targets: ['closed_season'] })).status).toBe(200);
  });

  it('permits every write path while the season is open', async () => {
    const res = await adminPost(env, '/admin/entry/1/enqueue', {});
    expect(res.status).toBe(200);
  });
});

describe('POST /admin/season/:year/{close,reopen}', () => {
  let env;

  beforeEach(() => { env = createMockEnv(); });

  it('requires confirm_season to match', async () => {
    const res = await adminPost(env, `/admin/season/${OLD}/close`, { confirm_season: 1999 });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('confirm_season_required');
    expect(env.FPL_PULSE_KV._getJSON(kSeasonClosed(OLD))).toBeNull();
  });

  it('rejects a malformed season in the path', async () => {
    const res = await adminPost(env, '/admin/season/12345/close', { confirm_season: 12345 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_season');
  });

  // The way out of "the season never completes" — a curtailed or reshaped event list means
  // the automatic trigger never fires.
  it('closes a season that never closed on its own', async () => {
    const res = await adminPost(env, `/admin/season/${OLD}/close`, { confirm_season: OLD, final_gw: 29 });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('closed');

    const marker = env.FPL_PULSE_KV._getJSON(kSeasonClosed(OLD));
    expect(marker).toMatchObject({ final_gw: 29, closed_by: 'admin' });
  });

  it('is idempotent — closing twice does not restamp closed_at', async () => {
    await adminPost(env, `/admin/season/${OLD}/close`, { confirm_season: OLD });
    const first = env.FPL_PULSE_KV._getJSON(kSeasonClosed(OLD));

    const res = await adminPost(env, `/admin/season/${OLD}/close`, { confirm_season: OLD });
    expect((await res.json()).status).toBe('already_closed');
    expect(env.FPL_PULSE_KV._getJSON(kSeasonClosed(OLD)).closed_at).toBe(first.closed_at);
  });

  it('reopen removes the marker and restores writability', async () => {
    await env.FPL_PULSE_KV.put(kSeasonClosed(CURRENT), JSON.stringify({ closed_at: 'x', final_gw: 38 }));
    expect((await adminPost(env, '/admin/entry/1/enqueue', {})).status).toBe(409);

    const res = await adminPost(env, `/admin/season/${CURRENT}/reopen`, { confirm_season: CURRENT });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('reopened');
    expect(env.FPL_PULSE_KV._getJSON(kSeasonClosed(CURRENT))).toBeNull();

    // The repair the reopen exists to enable is now possible.
    expect((await adminPost(env, '/admin/entry/1/enqueue', {})).status).toBe(200);
  });

  it('reopening an open season is a no-op, not an error', async () => {
    const res = await adminPost(env, `/admin/season/${OLD}/reopen`, { confirm_season: OLD });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('already_open');
  });
});

describe('cleanup target: closed_season vs the old_season alias', () => {
  let env;

  // Two closed-season scaffolding keys and two from a season that never closed.
  const seed = (closeIt) => {
    const kv = {
      [kEntryState(1, OLD)]: JSON.stringify({ status: 'complete' }),
      [kEntryState(2, OLD)]: JSON.stringify({ status: 'errored' }),
      [kEntryState(3, 2019)]: JSON.stringify({ status: 'complete' }),
    };
    if (closeIt) kv[kSeasonClosed(OLD)] = JSON.stringify({ closed_at: 'x', final_gw: 38 });
    return createMockEnv(kv);
  };

  it('offers nothing for a season that has no close marker', async () => {
    env = seed(false);
    const body = await (await adminPost(env, '/admin/kv/cleanup', { targets: ['closed_season'] })).json();

    expect(body.would_delete_count).toBe(0);
    expect(body.skipped_not_closed_count).toBe(3);
    expect(body.skipped_not_closed.every(s => s.reason === 'season_not_closed')).toBe(true);
  });

  // FPL curtailed 2019/20. A season that never completes stays open, so its keys are never
  // deletion candidates until someone deliberately closes it.
  it('leaves a never-closed season alone while cleaning a closed one', async () => {
    env = seed(true);
    const body = await (await adminPost(env, '/admin/kv/cleanup', { targets: ['closed_season'] })).json();

    expect(body.would_delete.map(d => d.key).sort()).toEqual([kEntryState(1, OLD), kEntryState(2, OLD)].sort());
    expect(body.skipped_not_closed.map(s => s.key)).toEqual([kEntryState(3, 2019)]);
  });

  it('the manual close route makes a curtailed season cleanable', async () => {
    env = seed(true);
    await adminPost(env, '/admin/season/2019/close', { confirm_season: 2019, final_gw: 29 });

    const body = await (await adminPost(env, '/admin/kv/cleanup', { targets: ['closed_season'] })).json();
    expect(body.would_delete_count).toBe(3);
    expect(body.skipped_not_closed_count).toBe(0);
  });

  // Accepted, not broken: the change is strictly narrowing, so no existing script can be
  // made to delete something it would not have deleted before.
  it('accepts the deprecated old_season alias and says so', async () => {
    env = seed(true);
    const body = await (await adminPost(env, '/admin/kv/cleanup', { targets: ['old_season'] })).json();

    expect(body.would_delete_count).toBe(2);
    expect(body.deprecations[0]).toContain('old_season');
    expect(body.deprecations[0]).toContain('closed_season');
  });

  it('rejects an unknown target and lists the current valid ones', async () => {
    env = seed(true);
    const res = await adminPost(env, '/admin/kv/cleanup', { targets: ['nonsense'] });
    expect(res.status).toBe(400);
    expect((await res.json()).valid).toEqual(['closed_season', 'orphaned_entries']);
  });

  it('never offers the close marker itself for deletion', async () => {
    env = seed(true);
    const body = await (await adminPost(env, '/admin/kv/cleanup', { targets: ['closed_season'] })).json();
    expect(body.would_delete.some(d => d.key === kSeasonClosed(OLD))).toBe(false);
  });
});

describe('GET /admin/kv/audit — closed state', () => {
  it('reports closed state per season alongside the categorisation', async () => {
    const env = createMockEnv({
      [kEntryState(1, OLD)]: JSON.stringify({ status: 'complete' }),
      [kEntryState(2, CURRENT)]: JSON.stringify({ status: 'complete' }),
      [kEntryState(3, 2019)]: JSON.stringify({ status: 'complete' }),
      [kSeasonClosed(OLD)]: JSON.stringify({ closed_at: '2025-05-25T18:00:00.000Z', final_gw: 38 }),
    });

    const body = await (await adminGet(env, '/admin/kv/audit')).json();

    expect(body.seasons[OLD]).toMatchObject({ closed: true, is_current: false, final_gw: 38 });
    expect(body.seasons[CURRENT]).toMatchObject({ closed: false, is_current: true });
    // The curtailed season shows as open, which is why cleanup will not touch it.
    expect(body.seasons[2019]).toMatchObject({ closed: false });
    expect(body.issues.unknown_keys).toEqual([]);
  });
});
