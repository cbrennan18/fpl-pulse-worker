import { kvGetJSON, kvPutJSON, kEntryState, kEntrySeason, kHealthStateSummary } from '../lib/kv.js';
import { fetchJsonWithRetry } from '../lib/fpl-api.js';
import { log } from '../lib/utils.js';
import { getEffectiveSeason } from './harvest.js';

// === Build a single entry season blob ===
// (summary + history + transfers + picks 1..targetGW)
export async function processEntryOnce(entryId, season, kv) {
  const nowIso = new Date().toISOString();
  const stateKey = kEntryState(entryId, season);
  const seasonKey = kEntrySeason(entryId, season);

  // Read state and guard (+ stale-building reset)
  let state = await kvGetJSON(kv, stateKey);
  if (!state) {
    return { ok: false, reason: "not_queued", entryId };
  }

  // If stuck in "building" for > 60 minutes, reset to queued
  if (state.status === "building") {
    const started = state.worker_started_at ? Date.parse(state.worker_started_at) : 0;
    const ageMs = Date.now() - (isNaN(started) ? 0 : started);
    if (ageMs > 60 * 60 * 1000) {
      state = {
        status: "queued",
        last_gw_processed: state.last_gw_processed ?? 0,
        updated_at: new Date().toISOString(),
        version: (state.version ?? 0) + 1,
      };
      await kvPutJSON(kv, stateKey, state);
    }
  }

  if (state.status !== "queued" && state.status !== "building") {
    return { ok: false, reason: "not_queued", entryId };
  }

  // Mark building
  const newAttempts = (state.attempts || 0) + 1;
  await kvPutJSON(kv, stateKey, {
    status: "building",
    last_gw_processed: state.last_gw_processed ?? 0,
    worker_started_at: nowIso,
    attempts: newAttempts,
    updated_at: nowIso,
  });
  log.info("entry", "state_transition", {
    entry_id: entryId,
    from: state.status,
    to: "building",
    attempts: newAttempts,
  });

  try {
    // 0) ENTRY SUMMARY (names, leagues, etc.)
    const summary = await fetchJsonWithRetry(
      `https://fantasy.premierleague.com/api/entry/${entryId}/`
    );

    // 1) HISTORY
    const hist = await fetchJsonWithRetry(
      `https://fantasy.premierleague.com/api/entry/${entryId}/history/`
    );
    const current = Array.isArray(hist?.current) ? hist.current : [];
    if (current.length === 0) throw new Error("empty_history");

    // Build gw_summaries and find target GW
    const gw_summaries = {};
    let targetGW = 0;
    for (const row of current) {
      const gw = Number(row?.event);
      if (!Number.isInteger(gw)) continue;
      targetGW = Math.max(targetGW, gw);
      gw_summaries[gw] = {
        points: Number(row.points ?? 0),
        total: Number(row.total_points ?? row.total ?? 0),
        gw_rank: Number(row.rank ?? 0),
        overall_rank: Number(row.overall_rank ?? 0),
        value: Number(row.value ?? 0), // FPL returns x10; keep as-is for now
        bank: Number(row.bank ?? 0),   // x10; keep as-is
        chip: row?.chip || null,
        event_transfers: Number(row.event_transfers ?? 0),
        event_transfers_cost: Number(row.event_transfers_cost ?? 0),
      };
    }
    if (targetGW <= 0) throw new Error("no_target_gw");

    // 2) TRANSFERS
    const transfersRaw = await fetchJsonWithRetry(
      `https://fantasy.premierleague.com/api/entry/${entryId}/transfers/`
    );
    const transfers = Array.isArray(transfersRaw)
      ? transfersRaw.map(t => ({
          event: Number(t?.event ?? 0),
          element_in: Number(t?.element_in ?? 0),
          element_out: Number(t?.element_out ?? 0),
          cost: Number(t?.cost ?? 0),
          time: t?.time || null,
        }))
      : [];

    // 3) PICKS BY GW (1..targetGW)
    // Smart partial backfill: check if we have an existing blob and only fetch missing GWs
    const existingBlob = await kvGetJSON(kv, seasonKey);
    const picks_by_gw = (existingBlob && typeof existingBlob.picks_by_gw === "object")
      ? { ...existingBlob.picks_by_gw }
      : {};

    const startGW = existingBlob?.last_gw_processed
      ? Math.min(existingBlob.last_gw_processed + 1, targetGW)
      : 1;

    // Only fetch picks for GWs the entry participated in (present in history)
    for (let gw = startGW; gw <= targetGW; gw++) {
      if (picks_by_gw[gw]) continue; // Skip if we already have this GW
      if (!gw_summaries[gw]) continue; // Skip GWs the entry didn't play (mid-season join)

      const p = await fetchJsonWithRetry(
        `https://fantasy.premierleague.com/api/entry/${entryId}/event/${gw}/picks/`
      );
      const picksArr = Array.isArray(p?.picks) ? p.picks : [];
      picks_by_gw[gw] = {
        active_chip: p?.active_chip ?? null,
        points_on_bench: Number(p?.entry_history?.points_on_bench ?? 0),
        picks: picksArr.map(px => ({
          element: Number(px?.element ?? 0),
          position: Number(px?.position ?? 0),
          multiplier: Number(px?.multiplier ?? 0),
          is_captain: Boolean(px?.is_captain),
          is_vice: Boolean(px?.is_vice_captain || px?.is_vice),
        })),
      };
    }

    // If this is a partial update and we're missing early GWs, backfill them too
    if (existingBlob && startGW > 1) {
      for (let gw = 1; gw < startGW; gw++) {
        if (picks_by_gw[gw]) continue; // Skip if we already have this GW
        if (!gw_summaries[gw]) continue; // Skip GWs the entry didn't play

        const p = await fetchJsonWithRetry(
          `https://fantasy.premierleague.com/api/entry/${entryId}/event/${gw}/picks/`
        );
        const picksArr = Array.isArray(p?.picks) ? p.picks : [];
        picks_by_gw[gw] = {
          active_chip: p?.active_chip ?? null,
          points_on_bench: Number(p?.entry_history?.points_on_bench ?? 0),
          picks: picksArr.map(px => ({
            element: Number(px?.element ?? 0),
            position: Number(px?.position ?? 0),
            multiplier: Number(px?.multiplier ?? 0),
            is_captain: Boolean(px?.is_captain),
            is_vice: Boolean(px?.is_vice_captain || px?.is_vice),
          })),
        };
      }
    }

    // 4) Assemble final blob
    const blob = {
      entry_id: Number(entryId),
      season: Number(season),
      last_gw_processed: Number(targetGW),
      updated_at: nowIso,
      version: 1,
      gw_summaries,
      picks_by_gw,
      transfers,
      // New: store full entry summary + refresh timestamps
      summary,
      summary_last_refreshed_at: nowIso,
      transfers_last_refreshed_at: nowIso,
    };

    // 5) Write blob, then mark complete
    await kvPutJSON(kv, seasonKey, blob);
    await kvPutJSON(kv, stateKey, {
      status: "complete",
      last_gw_processed: targetGW,
      updated_at: new Date().toISOString(),
      attempts: newAttempts,
    });
    log.info("entry", "state_transition", {
      entry_id: entryId,
      from: "building",
      to: "complete",
      target_gw: targetGW,
    });

    return { ok: true, entryId, targetGW };
  } catch (err) {
    // Mark errored (non-fatal for the worker)
    const errorMsg = String(err?.message || err);
    await kvPutJSON(kv, stateKey, {
      status: "errored",
      error: errorMsg,
      updated_at: new Date().toISOString(),
      attempts: newAttempts,
    });
    log.warn("entry", "state_transition", {
      entry_id: entryId,
      from: "building",
      to: "errored",
      error: errorMsg,
      attempts: newAttempts,
    });
    return { ok: false, reason: "error", entryId, error: errorMsg };
  }
}

// === Auto-retry errored entries ===
export const MAX_RETRY_ATTEMPTS = 3;
export const RETRY_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

export async function retryErroredEntries(env) {
  const season = await getEffectiveSeason(env);
  const candidates = [];
  let cursor;

  // Scan for entry state keys
  do {
    const page = await env.FPL_PULSE_KV.list({ prefix: "entry:", cursor, limit: 100 });
    cursor = page.cursor;
    for (const k of page.keys) {
      if (k.name.endsWith(`:${season}:state`)) {
        const id = Number(k.name.split(":")[1]);
        if (Number.isInteger(id)) candidates.push(id);
      }
    }
    if (candidates.length >= 200) break;
  } while (cursor);

  // Find errored entries: either retryable or ready for dead letter
  const retryable = [];
  let deadLettered = 0;

  for (const id of candidates) {
    const state = await kvGetJSON(env.FPL_PULSE_KV, kEntryState(id, season));
    if (!state || state.status !== "errored") continue;

    // Entries that have exhausted retries → mark dead
    if ((state.attempts || 0) >= MAX_RETRY_ATTEMPTS) {
      await kvPutJSON(env.FPL_PULSE_KV, kEntryState(id, season), {
        status: "dead",
        error: state.error || "max retries exhausted",
        attempts: state.attempts,
        updated_at: new Date().toISOString(),
      });
      log.warn("entry", "state_transition", {
        entry_id: id,
        from: "errored",
        to: "dead",
        attempts: state.attempts,
        error: state.error || "max retries exhausted",
      });
      deadLettered++;
      continue;
    }

    const erroredAt = state.updated_at ? Date.parse(state.updated_at) : 0;
    if ((Date.now() - erroredAt) < RETRY_COOLDOWN_MS) continue;

    retryable.push({ id, attempts: state.attempts || 0 });
  }

  // Re-queue and process (max 5 per cron cycle to stay within time budget)
  const batch = retryable.slice(0, 5);
  let succeeded = 0;

  for (const { id, attempts } of batch) {
    await kvPutJSON(env.FPL_PULSE_KV, kEntryState(id, season), {
      status: "queued",
      last_gw_processed: 0,
      attempts,
      updated_at: new Date().toISOString(),
    });

    const result = await processEntryOnce(id, season, env.FPL_PULSE_KV);
    if (result.ok) succeeded++;
  }

  if (batch.length || deadLettered) {
    log.info("retry", "batch_complete", {
      succeeded,
      attempted: batch.length,
      dead_lettered: deadLettered,
      eligible_remaining: retryable.length - batch.length,
    });
  }
  return { retried: batch.length, succeeded, eligible: retryable.length };
}

// === Update precomputed health state summary ===
export async function updateHealthStateSummary(env) {
  const season = await getEffectiveSeason(env);
  const counts = { queued: 0, building: 0, complete: 0, errored: 0, dead: 0 };
  let cursor;

  do {
    const page = await env.FPL_PULSE_KV.list({ prefix: "entry:", cursor, limit: 100 });
    cursor = page.cursor;

    for (const k of page.keys) {
      if (!k.name.endsWith(`:${season}:state`)) continue;
      const state = await kvGetJSON(env.FPL_PULSE_KV, k.name);
      if (state?.status && Object.prototype.hasOwnProperty.call(counts, state.status)) {
        counts[state.status]++;
      }
    }
  } while (cursor);

  const summary = {
    ...counts,
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    updated_at: new Date().toISOString(),
    season,
  };

  await kvPutJSON(env.FPL_PULSE_KV, kHealthStateSummary, summary);
  log.info("health", "summary_updated", summary);

  return summary;
}
