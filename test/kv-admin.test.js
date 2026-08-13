import { describe, it, expect, beforeEach } from 'vitest';
import { handleAdminRoute } from '../src/routes/admin.js';
import {
  kLeagueMembers, kLeagueStandings, kSeasonBootstrap, kSeasonElements, kEntrySeason, kEntryState,
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

describe('POST /admin/kv/cleanup — archive guard on the old_season target', () => {
  let env;

  beforeEach(() => {
    env = createMockEnv({
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

  it('dry run offers only non-archival old-season keys, and names the refusals', async () => {
    const body = await (await adminPost(env, '/admin/kv/cleanup', {
      targets: ['old_season'],
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
      targets: ['old_season'],
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
      targets: ['old_season'],
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
