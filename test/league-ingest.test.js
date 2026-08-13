import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleAdminRoute } from '../src/routes/admin.js';
import { circuitBreaker } from '../src/lib/fpl-api.js';
import { kLeagueMembers, kEntryState } from '../src/lib/kv.js';
import { createMockEnv, mockFetch } from './helpers/mocks.js';

const SEASON = 2025;
const LEAGUE_ID = 1373455; // AE64 benchmark league

const standingsUrl = (id, page = 1) =>
  page === 1
    ? `https://fantasy.premierleague.com/api/leagues-classic/${id}/standings/`
    : `https://fantasy.premierleague.com/api/leagues-classic/${id}/standings/?page_standings=${page}`;

// Minimal standings page: results carry an `entry` id (rank-ordered), plus has_next.
const page = (entries, hasNext = false) => ({
  league: { id: LEAGUE_ID, name: 'Analytics Elite 64' },
  standings: {
    has_next: hasNext,
    results: entries.map((entry, i) => ({ entry, rank: i + 1 })),
  },
});

// Build a page of N sequential entry ids starting at `start`.
const idRange = (start, count) => Array.from({ length: count }, (_, i) => start + i);

// Fire the admin ingest route with auth. `query` e.g. "?allow_large=1".
const ingest = (env, query = '') =>
  handleAdminRoute(
    new Request(`https://worker.dev/admin/league/${LEAGUE_ID}/ingest${query}`, {
      method: 'POST',
      headers: { 'x-refresh-token': 'test-token' },
    }),
    env,
    SEASON
  );

describe('POST /admin/league/:id/ingest — allow_large bypass', () => {
  let env;
  let cleanup;

  beforeEach(() => {
    circuitBreaker.reset();
    env = createMockEnv();
  });

  afterEach(() => {
    if (cleanup) cleanup();
    cleanup = undefined;
  });

  it('refuses a 64-member league (403 league_too_large) WITHOUT allow_large', async () => {
    // Page 1 returns 50 with has_next:true — the friends-only gate should trip immediately.
    cleanup = mockFetch({
      [standingsUrl(LEAGUE_ID, 1)]: page(idRange(1, 50), true),
      [standingsUrl(LEAGUE_ID, 2)]: page(idRange(51, 14), false),
    });

    const res = await ingest(env);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('league_too_large');

    // No KV footprint on refusal.
    expect(env.FPL_PULSE_KV._getJSON(kLeagueMembers(String(LEAGUE_ID), SEASON))).toBeNull();
  });

  it('ingests all 64 members in standings order WITH allow_large=1', async () => {
    cleanup = mockFetch({
      [standingsUrl(LEAGUE_ID, 1)]: page(idRange(1, 50), true),
      [standingsUrl(LEAGUE_ID, 2)]: page(idRange(51, 14), false),
    });

    const res = await ingest(env, '?allow_large=1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.members_count).toBe(64);
    expect(body.queued_count).toBe(64);

    // Members written to KV under the SEASON-SCOPED key, in rank order (1..64),
    // and each new entry enqueued.
    const members = env.FPL_PULSE_KV._getJSON(kLeagueMembers(String(LEAGUE_ID), SEASON));
    expect(members).toEqual(idRange(1, 64));
    // Nothing left at the legacy unscoped key.
    expect(env.FPL_PULSE_KV._getJSON(`league:${LEAGUE_ID}:members`)).toBeNull();
    const state = env.FPL_PULSE_KV._getJSON(kEntryState(1, SEASON));
    expect(state.status).toBe('queued');
  });

  it('caps runaway paging at MAX_LARGE_INGEST (100) when has_next never ends', async () => {
    // Every page claims has_next:true forever — the ceiling must break the loop.
    const forever = (urlStr) => {
      const m = urlStr.match(/page_standings=(\d+)/);
      const p = m ? Number(m[1]) : 1;
      const start = (p - 1) * 50 + 1;
      return new Response(JSON.stringify(page(idRange(start, 50), true)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    cleanup = mockFetch({
      [standingsUrl(LEAGUE_ID, 1)]: forever,
      [standingsUrl(LEAGUE_ID, 2)]: forever,
      [standingsUrl(LEAGUE_ID, 3)]: forever,
    });

    const res = await ingest(env, '?allow_large=1');
    expect(res.status).toBe(200);
    const body = await res.json();
    // Two pages of 50 = 100, hits the ceiling and stops before a third page.
    expect(body.members_count).toBe(100);
  });
});
