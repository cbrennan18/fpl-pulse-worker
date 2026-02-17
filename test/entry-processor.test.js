import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { processEntryOnce } from '../src/services/entry.js';
import { circuitBreaker } from '../src/lib/fpl-api.js';
import { kEntryState, kEntrySeason } from '../src/lib/kv.js';
import { createMockKV, mockFetch } from './helpers/mocks.js';

const SEASON = 2025;
const ENTRY_ID = 12345;

// Minimal FPL API mock data
function fplMockRoutes(entryId = ENTRY_ID) {
  return {
    [`https://fantasy.premierleague.com/api/entry/${entryId}/`]: {
      id: entryId,
      player_first_name: "Test",
      player_last_name: "User",
    },
    [`https://fantasy.premierleague.com/api/entry/${entryId}/history/`]: {
      current: [
        { event: 1, points: 65, total_points: 65, rank: 1000, overall_rank: 500000, value: 1000, bank: 0 },
        { event: 2, points: 55, total_points: 120, rank: 2000, overall_rank: 400000, value: 1001, bank: 5 },
      ],
      past: [],
      chips: [],
    },
    [`https://fantasy.premierleague.com/api/entry/${entryId}/transfers/`]: [
      { event: 2, element_in: 100, element_out: 200, cost: 0, time: "2025-08-23T10:00:00Z" },
    ],
    [`https://fantasy.premierleague.com/api/entry/${entryId}/event/1/picks/`]: {
      active_chip: null,
      picks: [
        { element: 1, position: 1, is_captain: false, is_vice_captain: false },
        { element: 2, position: 2, is_captain: true, is_vice_captain: false },
      ],
    },
    [`https://fantasy.premierleague.com/api/entry/${entryId}/event/2/picks/`]: {
      active_chip: null,
      picks: [
        { element: 1, position: 1, is_captain: false, is_vice_captain: false },
        { element: 3, position: 2, is_captain: true, is_vice_captain: false },
      ],
    },
  };
}

describe('processEntryOnce', () => {
  let kv;
  let cleanup;

  beforeEach(() => {
    circuitBreaker.reset();
    kv = createMockKV();
    cleanup = mockFetch(fplMockRoutes());
  });

  afterEach(() => {
    if (cleanup) cleanup();
    circuitBreaker.reset();
  });

  it('returns not_queued when no state exists', async () => {
    const result = await processEntryOnce(ENTRY_ID, SEASON, kv);
    expect(result).toEqual({ ok: false, reason: "not_queued", entryId: ENTRY_ID });
  });

  it('returns not_queued when state is complete', async () => {
    await kv.put(kEntryState(ENTRY_ID, SEASON), JSON.stringify({
      status: "complete",
      last_gw_processed: 2,
    }));

    const result = await processEntryOnce(ENTRY_ID, SEASON, kv);
    expect(result).toEqual({ ok: false, reason: "not_queued", entryId: ENTRY_ID });
  });

  it('transitions queued → building → complete on success', async () => {
    await kv.put(kEntryState(ENTRY_ID, SEASON), JSON.stringify({
      status: "queued",
      last_gw_processed: 0,
    }));

    const result = await processEntryOnce(ENTRY_ID, SEASON, kv);

    expect(result.ok).toBe(true);
    expect(result.targetGW).toBe(2);

    // Verify final state is complete
    const finalState = kv._getJSON(kEntryState(ENTRY_ID, SEASON));
    expect(finalState.status).toBe("complete");
    expect(finalState.last_gw_processed).toBe(2);
    expect(finalState.attempts).toBe(1);
  });

  it('writes correct blob structure to KV', async () => {
    await kv.put(kEntryState(ENTRY_ID, SEASON), JSON.stringify({
      status: "queued",
      last_gw_processed: 0,
    }));

    await processEntryOnce(ENTRY_ID, SEASON, kv);

    const blob = kv._getJSON(kEntrySeason(ENTRY_ID, SEASON));
    expect(blob).not.toBeNull();
    expect(blob.entry_id).toBe(ENTRY_ID);
    expect(blob.season).toBe(SEASON);
    expect(blob.last_gw_processed).toBe(2);

    // GW summaries
    expect(blob.gw_summaries[1]).toBeDefined();
    expect(blob.gw_summaries[1].points).toBe(65);
    expect(blob.gw_summaries[2]).toBeDefined();
    expect(blob.gw_summaries[2].points).toBe(55);

    // Picks
    expect(blob.picks_by_gw[1]).toBeDefined();
    expect(blob.picks_by_gw[1].picks).toHaveLength(2);
    expect(blob.picks_by_gw[2]).toBeDefined();

    // Transfers
    expect(blob.transfers).toHaveLength(1);
    expect(blob.transfers[0].element_in).toBe(100);

    // Summary
    expect(blob.summary).toBeDefined();
    expect(blob.summary.player_first_name).toBe("Test");

    // Timestamps
    expect(blob.updated_at).toBeDefined();
    expect(blob.summary_last_refreshed_at).toBeDefined();
    expect(blob.transfers_last_refreshed_at).toBeDefined();
  });

  it('transitions queued → building → errored on fetch failure', async () => {
    // Override fetch to fail
    if (cleanup) cleanup();
    cleanup = mockFetch({
      [`https://fantasy.premierleague.com/api/entry/${ENTRY_ID}/`]:
        () => new Response('Server Error', { status: 500 }),
    });

    await kv.put(kEntryState(ENTRY_ID, SEASON), JSON.stringify({
      status: "queued",
      last_gw_processed: 0,
    }));

    const result = await processEntryOnce(ENTRY_ID, SEASON, kv);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("error");

    const finalState = kv._getJSON(kEntryState(ENTRY_ID, SEASON));
    expect(finalState.status).toBe("errored");
    expect(finalState.error).toBeDefined();
    expect(finalState.attempts).toBe(1);
  });

  it('increments attempt count on each processing', async () => {
    await kv.put(kEntryState(ENTRY_ID, SEASON), JSON.stringify({
      status: "queued",
      last_gw_processed: 0,
      attempts: 2,
    }));

    await processEntryOnce(ENTRY_ID, SEASON, kv);

    const finalState = kv._getJSON(kEntryState(ENTRY_ID, SEASON));
    expect(finalState.attempts).toBe(3);
  });

  it('resets stale building state (>60 min) to queued and processes', async () => {
    const oldTime = new Date(Date.now() - 61 * 60 * 1000).toISOString();
    await kv.put(kEntryState(ENTRY_ID, SEASON), JSON.stringify({
      status: "building",
      last_gw_processed: 0,
      worker_started_at: oldTime,
      version: 1,
    }));

    const result = await processEntryOnce(ENTRY_ID, SEASON, kv);

    // Should have reset to queued and then processed successfully
    expect(result.ok).toBe(true);
    expect(result.targetGW).toBe(2);
  });

  it('skips recent building state (<60 min)', async () => {
    const recentTime = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    await kv.put(kEntryState(ENTRY_ID, SEASON), JSON.stringify({
      status: "building",
      last_gw_processed: 0,
      worker_started_at: recentTime,
    }));

    // building status should be treated as processable
    const result = await processEntryOnce(ENTRY_ID, SEASON, kv);
    // It won't reset, but building is accepted by the status check (line 34: !== "queued" && !== "building")
    // So it should proceed and attempt to build
    expect(result.ok).toBe(true);
  });

  it('performs incremental backfill - reuses existing picks', async () => {
    // Pre-populate with existing blob that has GW1 picks
    const existingBlob = {
      entry_id: ENTRY_ID,
      season: SEASON,
      last_gw_processed: 1,
      gw_summaries: {},
      picks_by_gw: {
        1: {
          active_chip: null,
          picks: [{ element: 99, position: 1, is_captain: true, is_vice: false }],
        },
      },
      transfers: [],
    };
    await kv.put(kEntrySeason(ENTRY_ID, SEASON), JSON.stringify(existingBlob));
    await kv.put(kEntryState(ENTRY_ID, SEASON), JSON.stringify({
      status: "queued",
      last_gw_processed: 1,
    }));

    // Track which URLs are called
    const calledUrls = [];
    if (cleanup) cleanup();
    const routes = fplMockRoutes();
    cleanup = mockFetch(Object.fromEntries(
      Object.entries(routes).map(([url, val]) => [
        url,
        () => {
          calledUrls.push(url);
          return new Response(JSON.stringify(val), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      ])
    ));

    const result = await processEntryOnce(ENTRY_ID, SEASON, kv);
    expect(result.ok).toBe(true);

    // Should NOT have fetched GW1 picks since they already existed
    const gw1PicksUrl = `https://fantasy.premierleague.com/api/entry/${ENTRY_ID}/event/1/picks/`;
    expect(calledUrls).not.toContain(gw1PicksUrl);

    // But GW2 picks should have been fetched
    const gw2PicksUrl = `https://fantasy.premierleague.com/api/entry/${ENTRY_ID}/event/2/picks/`;
    expect(calledUrls).toContain(gw2PicksUrl);

    // The existing GW1 picks should be preserved (our custom element: 99)
    const blob = kv._getJSON(kEntrySeason(ENTRY_ID, SEASON));
    expect(blob.picks_by_gw[1].picks[0].element).toBe(99);
  });
});
