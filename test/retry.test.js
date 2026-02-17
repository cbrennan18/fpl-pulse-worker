import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { retryErroredEntries, updateHealthStateSummary, MAX_RETRY_ATTEMPTS, RETRY_COOLDOWN_MS } from '../src/services/entry.js';
import { circuitBreaker } from '../src/lib/fpl-api.js';
import { kEntryState, kEntrySeason, kDetectedSeason, kHealthStateSummary } from '../src/lib/kv.js';
import { createMockEnv, mockFetch } from './helpers/mocks.js';

const SEASON = 2025;

// Pre-populate env with detected season to avoid API calls
async function seedSeason(env) {
  await env.FPL_PULSE_KV.put(kDetectedSeason, JSON.stringify({
    season: SEASON,
    detected_at: new Date().toISOString(),
  }));
}

// Seed an entry state into KV
async function seedEntryState(env, entryId, state) {
  await env.FPL_PULSE_KV.put(
    kEntryState(entryId, SEASON),
    JSON.stringify(state)
  );
}

describe('retryErroredEntries', () => {
  let env;
  let cleanup;

  beforeEach(async () => {
    circuitBreaker.reset();
    env = createMockEnv();
    await seedSeason(env);
  });

  afterEach(() => {
    if (cleanup) cleanup();
    circuitBreaker.reset();
  });

  it('skips entries errored less than 1h ago (cooldown)', async () => {
    // Entry errored just now - should be skipped
    await seedEntryState(env, 100, {
      status: "errored",
      error: "some error",
      attempts: 1,
      updated_at: new Date().toISOString(),
    });

    const result = await retryErroredEntries(env);
    expect(result.retried).toBe(0);
    expect(result.succeeded).toBe(0);
  });

  it('re-queues entries errored more than 1h ago', async () => {
    const oldTime = new Date(Date.now() - RETRY_COOLDOWN_MS - 1000).toISOString();
    await seedEntryState(env, 100, {
      status: "errored",
      error: "some error",
      attempts: 1,
      updated_at: oldTime,
    });

    // Mock FPL API for the retry processing
    cleanup = mockFetch({
      'https://fantasy.premierleague.com/api/entry/100/': { id: 100 },
      'https://fantasy.premierleague.com/api/entry/100/history/': {
        current: [
          { event: 1, points: 50, total_points: 50, rank: 1000, overall_rank: 500000, value: 1000, bank: 0 },
        ],
      },
      'https://fantasy.premierleague.com/api/entry/100/transfers/': [],
      'https://fantasy.premierleague.com/api/entry/100/event/1/picks/': {
        active_chip: null,
        picks: [{ element: 1, position: 1, is_captain: true, is_vice_captain: false }],
      },
    });

    const result = await retryErroredEntries(env);
    expect(result.retried).toBe(1);
    expect(result.succeeded).toBe(1);

    // Verify the entry is now complete
    const state = JSON.parse(await env.FPL_PULSE_KV.get(kEntryState(100, SEASON)));
    expect(state.status).toBe("complete");
  });

  it('dead-letters entries at MAX_RETRY_ATTEMPTS', async () => {
    const oldTime = new Date(Date.now() - RETRY_COOLDOWN_MS - 1000).toISOString();
    await seedEntryState(env, 200, {
      status: "errored",
      error: "persistent failure",
      attempts: MAX_RETRY_ATTEMPTS, // exactly at max
      updated_at: oldTime,
    });

    const result = await retryErroredEntries(env);

    // Should NOT be retried, should be dead-lettered
    expect(result.retried).toBe(0);

    const state = JSON.parse(await env.FPL_PULSE_KV.get(kEntryState(200, SEASON)));
    expect(state.status).toBe("dead");
    expect(state.error).toBe("persistent failure");
  });

  it('dead-letters entries exceeding MAX_RETRY_ATTEMPTS', async () => {
    await seedEntryState(env, 300, {
      status: "errored",
      error: "always fails",
      attempts: MAX_RETRY_ATTEMPTS + 2,
      updated_at: new Date().toISOString(), // even recent ones get dead-lettered
    });

    await retryErroredEntries(env);

    const state = JSON.parse(await env.FPL_PULSE_KV.get(kEntryState(300, SEASON)));
    expect(state.status).toBe("dead");
  });

  it('processes max 5 entries per cycle', async () => {
    const oldTime = new Date(Date.now() - RETRY_COOLDOWN_MS - 1000).toISOString();

    // Seed 7 retryable entries
    for (let i = 1; i <= 7; i++) {
      await seedEntryState(env, 400 + i, {
        status: "errored",
        error: "transient failure",
        attempts: 1,
        updated_at: oldTime,
      });
    }

    // Mock all the FPL API calls that will be needed
    const routes = {};
    for (let i = 1; i <= 7; i++) {
      const id = 400 + i;
      routes[`https://fantasy.premierleague.com/api/entry/${id}/`] = { id };
      routes[`https://fantasy.premierleague.com/api/entry/${id}/history/`] = {
        current: [{ event: 1, points: 50, total_points: 50, rank: 1000, overall_rank: 500000, value: 1000, bank: 0 }],
      };
      routes[`https://fantasy.premierleague.com/api/entry/${id}/transfers/`] = [];
      routes[`https://fantasy.premierleague.com/api/entry/${id}/event/1/picks/`] = {
        active_chip: null,
        picks: [{ element: 1, position: 1, is_captain: true, is_vice_captain: false }],
      };
    }
    cleanup = mockFetch(routes);

    const result = await retryErroredEntries(env);
    expect(result.retried).toBe(5); // capped at 5
    expect(result.eligible).toBe(7); // 7 were eligible
  });

  it('handles mixed states correctly', async () => {
    const oldTime = new Date(Date.now() - RETRY_COOLDOWN_MS - 1000).toISOString();

    // Errored and retryable
    await seedEntryState(env, 501, {
      status: "errored",
      error: "transient",
      attempts: 1,
      updated_at: oldTime,
    });

    // Errored but too recent (cooldown)
    await seedEntryState(env, 502, {
      status: "errored",
      error: "transient",
      attempts: 1,
      updated_at: new Date().toISOString(),
    });

    // Errored but max attempts (dead-letter)
    await seedEntryState(env, 503, {
      status: "errored",
      error: "persistent",
      attempts: MAX_RETRY_ATTEMPTS,
      updated_at: oldTime,
    });

    // Complete (should be ignored)
    await seedEntryState(env, 504, {
      status: "complete",
      last_gw_processed: 2,
    });

    // Mock FPL API for retry of entry 501
    cleanup = mockFetch({
      'https://fantasy.premierleague.com/api/entry/501/': { id: 501 },
      'https://fantasy.premierleague.com/api/entry/501/history/': {
        current: [{ event: 1, points: 60, total_points: 60, rank: 1000, overall_rank: 400000, value: 1000, bank: 0 }],
      },
      'https://fantasy.premierleague.com/api/entry/501/transfers/': [],
      'https://fantasy.premierleague.com/api/entry/501/event/1/picks/': {
        active_chip: null,
        picks: [{ element: 1, position: 1, is_captain: true, is_vice_captain: false }],
      },
    });

    const result = await retryErroredEntries(env);
    expect(result.retried).toBe(1); // only 501
    expect(result.succeeded).toBe(1);

    // 503 should be dead
    const state503 = JSON.parse(await env.FPL_PULSE_KV.get(kEntryState(503, SEASON)));
    expect(state503.status).toBe("dead");

    // 502 should still be errored (cooldown)
    const state502 = JSON.parse(await env.FPL_PULSE_KV.get(kEntryState(502, SEASON)));
    expect(state502.status).toBe("errored");

    // 504 should still be complete
    const state504 = JSON.parse(await env.FPL_PULSE_KV.get(kEntryState(504, SEASON)));
    expect(state504.status).toBe("complete");
  });
});

describe('updateHealthStateSummary', () => {
  let env;

  beforeEach(async () => {
    circuitBreaker.reset();
    env = createMockEnv();
    await seedSeason(env);
  });

  afterEach(() => {
    circuitBreaker.reset();
  });

  it('counts entry states correctly', async () => {
    await seedEntryState(env, 1, { status: "queued" });
    await seedEntryState(env, 2, { status: "queued" });
    await seedEntryState(env, 3, { status: "building" });
    await seedEntryState(env, 4, { status: "complete" });
    await seedEntryState(env, 5, { status: "complete" });
    await seedEntryState(env, 6, { status: "complete" });
    await seedEntryState(env, 7, { status: "errored" });
    await seedEntryState(env, 8, { status: "dead" });

    const summary = await updateHealthStateSummary(env);

    expect(summary.queued).toBe(2);
    expect(summary.building).toBe(1);
    expect(summary.complete).toBe(3);
    expect(summary.errored).toBe(1);
    expect(summary.dead).toBe(1);
    expect(summary.total).toBe(8);
    expect(summary.season).toBe(SEASON);
    expect(summary.updated_at).toBeDefined();
  });

  it('returns zero counts when no entries exist', async () => {
    const summary = await updateHealthStateSummary(env);

    expect(summary.queued).toBe(0);
    expect(summary.building).toBe(0);
    expect(summary.complete).toBe(0);
    expect(summary.errored).toBe(0);
    expect(summary.dead).toBe(0);
    expect(summary.total).toBe(0);
  });

  it('writes summary to KV', async () => {
    await seedEntryState(env, 1, { status: "complete" });

    await updateHealthStateSummary(env);

    const stored = JSON.parse(await env.FPL_PULSE_KV.get(kHealthStateSummary));
    expect(stored).not.toBeNull();
    expect(stored.complete).toBe(1);
    expect(stored.total).toBe(1);
  });
});
