import { kvGetJSON, kvPutJSON, kSeasonElements, kEntrySeason, kSeasonBootstrap, kSnapshotCurrent, kLeagueMembers, kDetectedSeason } from '../lib/kv.js';
import { fetchJsonWithRetry, fetchBootstrap } from '../lib/fpl-api.js';
import { log } from '../lib/utils.js';

// === Season auto-detection ===
// Detect current season from FPL API bootstrap-static
export async function detectSeasonFromAPI(env) {
  const cached = await kvGetJSON(env.FPL_PULSE_KV, kDetectedSeason);

  // Return cached if fresh (< 1 hour)
  if (cached && cached.detected_at) {
    const ageMs = Date.now() - Date.parse(cached.detected_at);
    if (ageMs < 3600 * 1000) {
      return cached.season;
    }
  }

  try {
    const bootstrap = await fetchBootstrap();

    // FPL API events contain deadline_time like "2024-08-16T17:30:00Z"
    // The season is the year the season STARTS (Aug-May spans two calendar years)
    const firstEvent = bootstrap?.events?.[0];
    if (firstEvent?.deadline_time) {
      const deadline = new Date(firstEvent.deadline_time);
      const year = deadline.getFullYear();
      // If deadline is Aug-Dec, season is that year
      // If deadline is Jan-Jul, season is previous year (shouldn't happen for event 1)
      const month = deadline.getMonth(); // 0-indexed
      const detectedSeason = month >= 7 ? year : year - 1; // Aug=7

      // Cache the result
      await kvPutJSON(env.FPL_PULSE_KV, kDetectedSeason, {
        season: detectedSeason,
        detected_at: new Date().toISOString(),
        source: "fpl_api",
        first_event_deadline: firstEvent.deadline_time,
      });

      log.info("season", "detected", { season: detectedSeason, source: "fpl_api" });
      return detectedSeason;
    }
  } catch (err) {
    log.warn("season", "detection_failed", { error: String(err?.message || err) });
  }

  // Fallback to null (caller should use env.SEASON)
  return null;
}

// Get effective season: try cache first, then auto-detect, then fall back to env
export async function getEffectiveSeason(env) {
  // Quick cache check first (avoids API call on every request)
  const cached = await kvGetJSON(env.FPL_PULSE_KV, kDetectedSeason);
  if (cached && cached.season && cached.detected_at) {
    const ageMs = Date.now() - Date.parse(cached.detected_at);
    if (ageMs < 3600 * 1000) {
      return cached.season;
    }
  }

  // Try detection (will also update cache)
  const detected = await detectSeasonFromAPI(env);
  if (detected) return detected;

  return Number(env.SEASON || 2025);
}

export function detectLatestFinishedGW(bootstrap) {
  const done = Array.isArray(bootstrap?.events)
    ? bootstrap.events.filter(e => e?.finished === true && e?.data_checked === true)
    : [];
  if (!done.length) return null;
  return Math.max(...done.map(e => Number(e.id)).filter(Number.isFinite));
}

// === Harvest helpers ===

export async function appendElementsForGW(env, season, gw) {
  const key = kSeasonElements(season);
  const cur = (await kvGetJSON(env.FPL_PULSE_KV, key)) || { last_gw_processed: 0, gws: {} };
  if (!cur.gws || typeof cur.gws !== "object") cur.gws = {};
  if (cur.gws[gw]) return { wrote: false, reason: "already_present" };

  const live = await fetchJsonWithRetry(`https://fantasy.premierleague.com/api/event/${gw}/live/`);
  cur.gws[gw] = live;
  cur.last_gw_processed = Math.max(Number(cur.last_gw_processed || 0), gw);
  await kvPutJSON(env.FPL_PULSE_KV, key, cur);
  return { wrote: true };
}

export async function updateEntryForGW(env, season, entryId, gw) {
  const seasonKey = kEntrySeason(entryId, season);
  const blob = await kvGetJSON(env.FPL_PULSE_KV, seasonKey);
  if (!blob || typeof blob !== "object") return { updated: false, reason: "no_blob" };

  let changed = false;

  // --- GW summary for this event ---
  if (!blob.gw_summaries || typeof blob.gw_summaries !== "object") blob.gw_summaries = {};
  if (!blob.gw_summaries[gw]) {
    const hist = await fetchJsonWithRetry(
      `https://fantasy.premierleague.com/api/entry/${entryId}/history/`
    );
    const row = Array.isArray(hist?.current)
      ? hist.current.find(r => Number(r?.event) === gw)
      : null;
    if (row) {
      blob.gw_summaries[gw] = {
        points: Number(row.points ?? 0),
        total: Number(row.total_points ?? row.total ?? 0),
        gw_rank: Number(row.rank ?? 0),
        overall_rank: Number(row.overall_rank ?? 0),
        value: Number(row.value ?? 0),
        bank: Number(row.bank ?? 0),
        chip: row?.chip || null,
        event_transfers: Number(row.event_transfers ?? 0),
        event_transfers_cost: Number(row.event_transfers_cost ?? 0),
      };
      changed = true;
    }
  }

  // --- Picks for this event ---
  if (!blob.picks_by_gw || typeof blob.picks_by_gw !== "object") blob.picks_by_gw = {};
  if (!blob.picks_by_gw[gw]) {
    const picks = await fetchJsonWithRetry(
      `https://fantasy.premierleague.com/api/entry/${entryId}/event/${gw}/picks/`
    );
    const arr = Array.isArray(picks?.picks) ? picks.picks : [];
    blob.picks_by_gw[gw] = {
      active_chip: picks?.active_chip ?? null,
      points_on_bench: Number(picks?.entry_history?.points_on_bench ?? 0),
      picks: arr.map(px => ({
        element: Number(px?.element ?? 0),
        position: Number(px?.position ?? 0),
        multiplier: Number(px?.multiplier ?? 0),
        is_captain: Boolean(px?.is_captain),
        is_vice: Boolean(px?.is_vice_captain || px?.is_vice),
      })),
    };
    changed = true;
  }

  // --- Refresh transfers so they stay up to date ---
  // Only refresh if stale (>6 hours) to reduce API calls
  const transfersLastRefreshed = blob.transfers_last_refreshed_at
    ? Date.parse(blob.transfers_last_refreshed_at)
    : 0;
  const transfersStale = !blob.transfers_last_refreshed_at ||
    isNaN(transfersLastRefreshed) ||
    (Date.now() - transfersLastRefreshed) > 6 * 3600 * 1000;

  if (transfersStale) {
    try {
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

      blob.transfers = transfers;
      blob.transfers_last_refreshed_at = new Date().toISOString();
      changed = true;
    } catch (err) {
      log.warn("harvest", "transfer_refresh_failed", {
        entry_id: entryId,
        error: String(err?.message || err),
      });
    }
  }

  // --- Refresh summary (names, leagues, etc.) ---
  // Only refresh if stale (>12 hours) - summary data rarely changes
  const summaryLastRefreshed = blob.summary_last_refreshed_at
    ? Date.parse(blob.summary_last_refreshed_at)
    : 0;
  const summaryStale = !blob.summary_last_refreshed_at ||
    isNaN(summaryLastRefreshed) ||
    (Date.now() - summaryLastRefreshed) > 12 * 3600 * 1000;

  if (summaryStale) {
    try {
      const summary = await fetchJsonWithRetry(
        `https://fantasy.premierleague.com/api/entry/${entryId}/`
      );
      blob.summary = summary;
      blob.summary_last_refreshed_at = new Date().toISOString();
      changed = true; // small blob; fine to treat as changed
    } catch (err) {
      log.warn("harvest", "summary_refresh_failed", {
        entry_id: entryId,
        error: String(err?.message || err),
      });
    }
  }

  if (changed) {
    blob.last_gw_processed = Math.max(Number(blob.last_gw_processed || 0), gw);
    blob.updated_at = new Date().toISOString();
    await kvPutJSON(env.FPL_PULSE_KV, seasonKey, blob);
  }

  return { updated: changed };
}

export async function updateSnapshot(env, season, gw) {
  await kvPutJSON(env.FPL_PULSE_KV, kSnapshotCurrent, { season: Number(season), last_gw: Number(gw) });
}

export async function harvestIfNeeded(env, { delaySec = 0 } = {}) {
  const season = await getEffectiveSeason(env);
  const t0 = Date.now();

  const bootstrap = await fetchBootstrap();
  const prevId = detectLatestFinishedGW(bootstrap);
  if (!Number.isInteger(prevId)) return { status: "noop", reason: "no_finished_gw" };

  const snap = (await kvGetJSON(env.FPL_PULSE_KV, kSnapshotCurrent)) || { season, last_gw: 0 };
  if (Number(snap.last_gw || 0) >= prevId) {
    return { status: "noop", reason: "already_up_to_date", last_gw: snap.last_gw };
  }

  if (delaySec && delaySec > 0) {
    return { status: "delayed", recommend_reinvoke_after_sec: delaySec, candidate_gw: prevId };
  }

  await kvPutJSON(env.FPL_PULSE_KV, kSeasonBootstrap(season), bootstrap);
  await appendElementsForGW(env, season, prevId);

  // Harvest optimization: batch KV list reads and process in parallel
  let cursor;
  const concurrency = 5;
  const pending = [];
  let processedCount = 0;
  const allEntryIds = [];

  // First, collect all entry IDs that need updating
  do {
    const page = await env.FPL_PULSE_KV.list({ prefix: "entry:", cursor, limit: 100 });
    cursor = page.cursor;

    for (const k of page.keys) {
      if (!k.name.endsWith(`:${season}`)) continue; // only complete blobs
      const id = Number(k.name.split(":")[1]);
      if (!Number.isInteger(id)) continue;
      allEntryIds.push(id);
    }
  } while (cursor);

  // Now process entries in batches with time budget
  for (const id of allEntryIds) {
    if ((Date.now() - t0) > 25_000) {
      log.warn("harvest", "timeout_approaching", {
        processed: processedCount,
        total: allEntryIds.length,
        elapsed_ms: Date.now() - t0,
      });
      break;
    }

    pending.push(updateEntryForGW(env, season, id, prevId).then(() => { processedCount++; }));

    if (pending.length >= concurrency) {
      await Promise.all(pending.splice(0));
    }
  }

  if (pending.length) await Promise.all(pending);

  log.info("harvest", "completed", {
    processed: processedCount,
    total: allEntryIds.length,
    elapsed_ms: Date.now() - t0,
    gw: prevId,
  });

  await updateSnapshot(env, season, prevId);
  return { status: "ok", last_gw: prevId };
}

// === Cache warm helper ===
export async function warmCache(env) {
  const base = "https://fpl-pulse.ciaranbrennan18.workers.dev";
  const season = await getEffectiveSeason(env);
  const cache = caches.default;
  const warmed = [];

  // Warm global endpoints
  const globals = [
    `${base}/v1/season/elements`,
    `${base}/v1/season/bootstrap`
  ];

  for (const url of globals) {
    const req = new Request(url);
    await cache.delete(req);
    const resp = await fetch(req);
    if (resp.ok) await cache.put(req, resp.clone());
    warmed.push(url);
  }

  // Warm top league entries (optional)
  const LEAGUE_ID = env.WARM_LEAGUE_ID || null; // optional env var
  if (LEAGUE_ID) {
    const members = await kvGetJSON(env.FPL_PULSE_KV, kLeagueMembers(LEAGUE_ID));
    if (Array.isArray(members)) {
      const slice = members.slice(0, 10);
      for (const id of slice) {
        const u = `${base}/v1/entry/${id}`;
        const req = new Request(u);
        await cache.delete(req);
        const resp = await fetch(req);
        if (resp.ok) await cache.put(req, resp.clone());
        warmed.push(u);
      }
      const packUrl = `${base}/v1/league/${LEAGUE_ID}/entries-pack`;
      const packReq = new Request(packUrl);
      await cache.delete(packReq);
      const r = await fetch(packReq);
      if (r.ok) await cache.put(packReq, r.clone());
      warmed.push(packUrl);
    }
  }

  return { status: "ok", warmed };
}
