import { kvGetJSON, kvPutJSON, kSeasonElements, kEntrySeason, kSeasonBootstrap, kSnapshotCurrent, kLeagueMembers, kLeagueStandings, kDetectedSeason, kPurgeQueue, kSeasonClosed, isValidGwElements, isSeasonClosed } from '../lib/kv.js';
import { fetchJsonWithRetry, fetchBootstrap } from '../lib/fpl-api.js';
import { log, fallbackSeason } from '../lib/utils.js';

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

  return Number(env.SEASON || fallbackSeason());
}

export function detectLatestFinishedGW(bootstrap) {
  const done = Array.isArray(bootstrap?.events)
    ? bootstrap.events.filter(e => e?.finished === true && e?.data_checked === true)
    : [];
  if (!done.length) return null;
  return Math.max(...done.map(e => Number(e.id)).filter(Number.isFinite));
}

// The season's LAST gameweek id. Deliberately the max event id, not events.length —
// those coincide in a normal 38-GW season but diverge the moment FPL's event list
// changes shape, and a season would then close a gameweek early or never at all.
export function detectFinalGW(bootstrap) {
  const ids = Array.isArray(bootstrap?.events)
    ? bootstrap.events.map(e => Number(e?.id)).filter(Number.isFinite)
    : [];
  if (!ids.length) return null;
  return Math.max(...ids);
}

// === Season close ===
//
// Stamped in exactly ONE place: the tail of harvestIfNeeded, after the harvest that
// processed the final gameweek has completed and advanced the snapshot. That ordering is
// the whole trick — the harvest which triggers the close is itself a write to the season,
// so the close cannot be a precondition of it. By the time this runs, the work is done;
// the next cron tick then short-circuits at `already_up_to_date` before reaching any
// write at all.
//
// Returns true only on the transition, so a reopened season is not silently re-closed:
// after a reopen the snapshot still names the final gameweek, so harvestIfNeeded exits at
// `already_up_to_date` long before reaching here. Re-closing is a deliberate admin act.
export async function closeSeasonIfComplete(env, season, bootstrap, latestFinishedGw) {
  const finalGw = detectFinalGW(bootstrap);
  if (!Number.isInteger(finalGw) || latestFinishedGw !== finalGw) return false;

  const key = kSeasonClosed(season);
  if (await kvGetJSON(env.FPL_PULSE_KV, key)) return false; // already closed

  await kvPutJSON(env.FPL_PULSE_KV, key, {
    closed_at: new Date().toISOString(),
    final_gw: finalGw,
  });
  log.info("season", "closed", { season: Number(season), final_gw: finalGw });
  return true;
}

// === Harvest helpers ===

export async function appendElementsForGW(env, season, gw) {
  if (await isSeasonClosed(env.FPL_PULSE_KV, season)) return { wrote: false, reason: "season_closed" };
  const key = kSeasonElements(season);
  const cur = (await kvGetJSON(env.FPL_PULSE_KV, key)) || { last_gw_processed: 0, gws: {} };
  if (!cur.gws || typeof cur.gws !== "object") cur.gws = {};
  // Skip only when the stored block is genuinely valid — a missing OR malformed
  // (legacy-schema) block is re-fetched and overwritten with the canonical shape.
  if (isValidGwElements(cur.gws[gw])) return { wrote: false, reason: "already_present" };

  const live = await fetchJsonWithRetry(`https://fantasy.premierleague.com/api/event/${gw}/live/`);
  cur.gws[gw] = live;
  cur.last_gw_processed = Math.max(Number(cur.last_gw_processed || 0), gw);
  await kvPutJSON(env.FPL_PULSE_KV, key, cur);
  return { wrote: true };
}

// Fill AND repair the season:elements spine for GW 1..upToGw. Any GW whose
// stored block is missing or fails isValidGwElements (e.g. the legacy
// element-keyed GW1) is re-fetched from event/{gw}/live and overwritten with the
// canonical { elements: [...] } shape. One KV read + one KV write; up to one FPL
// fetch per repaired GW. `limit` caps fetches per call so a large historical gap
// can't blow the cron's 50-subrequest budget — the remainder fills next cycle.
export async function backfillSeasonElements(env, season, upToGw, { limit = 38 } = {}) {
  if (await isSeasonClosed(env.FPL_PULSE_KV, season)) {
    return { written: 0, filled: [], repaired: [], reason: "season_closed" };
  }
  const key = kSeasonElements(season);
  const cur = (await kvGetJSON(env.FPL_PULSE_KV, key)) || { last_gw_processed: 0, gws: {} };
  if (!cur.gws || typeof cur.gws !== "object") cur.gws = {};

  const filled = [];
  const repaired = [];
  let fetched = 0;
  for (let gw = 1; gw <= upToGw; gw++) {
    const existing = cur.gws[gw];
    if (isValidGwElements(existing)) continue;
    if (fetched >= limit) break;
    const live = await fetchJsonWithRetry(`https://fantasy.premierleague.com/api/event/${gw}/live/`);
    fetched++;
    if (!isValidGwElements(live)) continue; // FPL returned nothing usable; leave the gap for next cycle
    (existing ? repaired : filled).push(gw);
    cur.gws[gw] = live;
  }

  const written = filled.length + repaired.length;
  if (written > 0) {
    const gwNums = Object.keys(cur.gws).map(Number).filter(Number.isFinite);
    cur.last_gw_processed = Math.max(Number(cur.last_gw_processed || 0), ...gwNums);
    await kvPutJSON(env.FPL_PULSE_KV, key, cur);
    log.info("harvest", "elements_backfilled", { season, up_to_gw: upToGw, filled, repaired });
  }
  return { written, filled, repaired, last_gw_processed: cur.last_gw_processed };
}

// === Final league standings archive (season-rollover capture) ===
//
// When FPL rolls over to the next season, classic-league standings reset
// PERMANENTLY and the final ranks/points are unrecoverable from the API. This
// captures the FULL final table for each tracked league into a write-once KV key
// (league:<id>:<season>:standings) so the data survives the rollover.
//
// SUBREQUEST BUDGET: like the cron, every fetch() counts against Cloudflare's
// 50-per-invocation cap. archiveAllLeagueStandings bounds total standings-page
// fetches to STANDINGS_FETCH_BUDGET and reports any leagues it could not reach in
// `remaining`, so the endpoint can be re-invoked to finish the capture. The
// write-once guard makes re-invocation idempotent — already-final leagues are
// skipped — so re-running until `remaining` is empty completes the job safely.
const STANDINGS_FETCH_BUDGET = 45; // mirrors PURGE_BATCH_SIZE; 5 subrequest headroom

// === Provenance: does the fetched table actually belong to the season being archived? ===
//
// THIS IS NOT A SEASON-EQUALITY CHECK, AND MUST NOT BE REPLACED BY ONE.
//
// The obvious guard — refuse unless `season === getEffectiveSeason(env)` — is wrong, and
// wrong in the worst direction. getEffectiveSeason derives the season from
// events[0].deadline_time, so when FPL publishes the new fixture list in mid-July,
// detection flips to the NEW season while classic standings still serve the OLD one:
// mini-leagues do not reset until later. That gap is precisely the window this archive
// exists to exploit. An equality check builds a lock that engages only when you need the
// door open.
//
// The members key is the ground truth instead: it records who was in THIS league in THIS
// season. If the live API is still serving that season's table, the entry IDs overlap
// heavily. If the season has rolled — or a mistyped league id landed on someone else's
// league — FPL has reassigned both league and entry IDs, so overlap collapses to zero.
// Correct everywhere the equality check is correct, plus the July window.
//
// THRESHOLDS. Legitimate churn and a wrong league are not close together: a friends league
// that loses a few members over the summer still overlaps most of its roster, while two
// unrelated leagues share essentially nothing (entry IDs are 7-digit and reassigned every
// season, so coincidental overlap is ~0). Anything in 0.2–0.5 separates them, so:
//   - ratio >= 0.5   a simple majority of the recorded roster is still present
//   - OR overlap >= 3  absolute floor, because the ratio is noisy for tiny leagues and
//                      punishes a league that grew a lot (3 of 20 old members remaining
//                      alongside 50 new joiners is a ratio of 0.15 but obviously the same
//                      league). Three specific 7-digit IDs matching by chance is ~0.
// Both rules require overlap > 0, so neither weakens the guard against the actual threat —
// they differ only in how much churn they tolerate. A tiny league with heavy churn (1 of 3
// remaining) can still fail both; that is what `allow_unverified` is for.
export const MIN_PROVENANCE_RATIO = 0.5;
export const MIN_PROVENANCE_OVERLAP = 3;

export function standingsProvenance(results, members) {
  const fetchedIds = (Array.isArray(results) ? results : [])
    .map(r => Number(r?.entry))
    .filter(Number.isFinite);

  // No roster recorded for this league+season means no ground truth to check against.
  // Refuse rather than assume: this is the mistyped-league-id path, since
  // archiveAllLeagueStandings discovers leagues VIA members keys but the single-league
  // `leagueId` option bypasses that scan entirely.
  if (!Array.isArray(members) || members.length === 0) {
    return {
      verified: false, reason: "no_members_key",
      member_count: 0, fetched_count: fetchedIds.length, overlap: 0, overlap_ratio: null,
    };
  }

  const memberSet = new Set(members.map(Number));
  const overlap = fetchedIds.filter(id => memberSet.has(id)).length;
  // Denominator is the RECORDED roster, not the fetched table: a league that gained
  // members should not be penalised for the joiners.
  const ratio = overlap / members.length;
  const verified = ratio >= MIN_PROVENANCE_RATIO || overlap >= MIN_PROVENANCE_OVERLAP;

  return {
    verified,
    reason: verified ? null : "provenance_mismatch",
    member_count: members.length,
    fetched_count: fetchedIds.length,
    overlap,
    overlap_ratio: Number(ratio.toFixed(2)),
  };
}

// Is the season being archived actually complete? Derived from THAT SEASON'S stored
// bootstrap, never the live one — provenance passing does not make a live `final` flag
// describe the right season, and a wrongly-stamped final:true is permanent under the
// write-once guard and serves at 200.
//
// Checks every event rather than comparing a count to a max id, so a reshaped event list
// cannot make a mid-season table look final. No stored bootstrap means no evidence, which
// yields false — a non-final archive is overwritable and never served as authoritative.
export async function isArchivedSeasonFinal(env, season) {
  const stored = await kvGetJSON(env.FPL_PULSE_KV, kSeasonBootstrap(season));
  const events = Array.isArray(stored?.events) ? stored.events : [];
  return events.length > 0 && events.every(e => e?.finished === true && e?.data_checked === true);
}

// Page through one league's classic standings and write the full final table.
// `budget` caps how many standings-page fetches this call may make; if the league
// needs more pages than `budget` allows it aborts WITHOUT writing (never a partial
// table) and returns status "budget_exhausted" with the pages it did spend, so the
// caller can account for the subrequests used.
export async function archiveLeagueStandings(env, leagueId, season, { force = false, isFinal = false, budget = STANDINGS_FETCH_BUDGET, allowUnverified = false } = {}) {
  const key = kLeagueStandings(leagueId, season);

  // Write-once guard: never clobber a table already marked final unless forced.
  // This is the landmine that stops a later (post-rollover) run replacing the
  // saved table with a reset one.
  const existing = await kvGetJSON(env.FPL_PULSE_KV, key);
  if (existing && existing.final === true && !force) {
    return { league_id: Number(leagueId), status: "skipped", reason: "already_final", pages_fetched: 0 };
  }

  const BASE = `https://fantasy.premierleague.com/api/leagues-classic/${leagueId}/standings/`;
  const results = [];
  let leagueMeta = null;
  let page = 1;
  let pagesFetched = 0;

  // Defensive pagination — page through every page_standings, even past 50 members
  // (unlike ingest's friends-only refusal). Capture-maximally: store rows untrimmed.
  while (true) {
    if (pagesFetched >= budget) {
      // Out of budget mid-league — abort without writing a partial table.
      return { league_id: Number(leagueId), status: "budget_exhausted", pages_fetched: pagesFetched };
    }
    const pageUrl = page === 1 ? BASE : `${BASE}?page_standings=${page}`;
    const data = await fetchJsonWithRetry(pageUrl);
    pagesFetched++;

    const rows = data?.standings?.results;
    const hasNext = Boolean(data?.standings?.has_next);
    if (!Array.isArray(rows)) {
      return { league_id: Number(leagueId), status: "error", reason: "unexpected_fpl_payload", page, pages_fetched: pagesFetched };
    }
    if (!leagueMeta && data?.league) leagueMeta = data.league;

    for (const row of rows) results.push(row); // store full rows, untrimmed

    if (!hasNext || rows.length === 0) break;
    page += 1;
  }

  // PROVENANCE GATE — the last thing before the write. The pages have been fetched, so the
  // subrequests are already spent either way; refusing here costs nothing extra and is the
  // only point at which the fetched table can be compared against the recorded roster.
  const members = await kvGetJSON(env.FPL_PULSE_KV, kLeagueMembers(leagueId, season));
  const provenance = standingsProvenance(results, members);
  if (!provenance.verified && !allowUnverified) {
    log.warn("standings", "provenance_refused", {
      league_id: Number(leagueId), season: Number(season), ...provenance,
    });
    return {
      league_id: Number(leagueId), status: "refused",
      reason: provenance.reason, provenance, pages_fetched: pagesFetched,
    };
  }

  const value = {
    season: Number(season),
    harvested_at: new Date().toISOString(),
    member_count: results.length,
    final: Boolean(isFinal),
    league: { id: Number(leagueId), name: leagueMeta?.name ?? null },
    results,
  };
  await kvPutJSON(env.FPL_PULSE_KV, key, value);

  log.info("standings", "archived", {
    league_id: Number(leagueId), season: Number(season),
    member_count: results.length, final: value.final,
    pages: pagesFetched, overwrote: Boolean(existing),
    overlap_ratio: provenance.overlap_ratio, unverified: !provenance.verified,
  });

  return {
    league_id: Number(leagueId), status: "written",
    member_count: results.length, final: value.final,
    pages_fetched: pagesFetched, overwrote: Boolean(existing),
    provenance,
  };
}

// Archive final standings for every tracked league (or a single league for
// testing). Determines `final` once from bootstrap, enumerates leagues via the same
// KV scan warmCache uses, and bounds total fetches to STANDINGS_FETCH_BUDGET. One
// league's failed fetch is collected and the run continues — never aborts the batch.
export async function archiveAllLeagueStandings(env, season, { force = false, leagueId = null, allowUnverified = false } = {}) {
  // Finality comes from the ARCHIVED season's own stored bootstrap, not the live API. The
  // live bootstrap describes whatever season FPL is currently serving, which during a
  // rollover is not the one being archived — stamping its finality here is how a
  // mid-season table acquires a permanent final:true. Reading from KV also costs zero
  // subrequests, so the budget now starts at 0 rather than 1.
  const isFinal = await isArchivedSeasonFinal(env, season);
  let used = 0;

  // Resolve the league list: single-league test param, or KV scan (warmCache pattern).
  let leagueIds;
  if (leagueId != null) {
    leagueIds = [String(leagueId)];
  } else {
    leagueIds = [];
    let cursor;
    do {
      const page = await env.FPL_PULSE_KV.list({ prefix: "league:", cursor, limit: 100 });
      cursor = page.cursor;
      for (const k of page.keys) {
        // Only members keys belonging to THE SEASON BEING ARCHIVED. FPL reassigns
        // league IDs every season, so a season-blind scan would take an old season's
        // league ID, fetch whatever league holds that ID today, and write a
        // stranger's table into league:<id>:<season>:standings. Legacy unscoped
        // keys (league:<id>:members) carry no season and are skipped for the same
        // reason — we cannot tell which season they describe.
        const parts = k.name.split(":"); // ["league", "<id>", "<season>", "members"]
        if (parts.length === 4 && parts[3] === "members" && parts[2] === String(season)) {
          leagueIds.push(parts[1]);
        }
      }
    } while (cursor);
  }

  const archived = [];
  const remaining = [];
  let budgetExhausted = false;

  for (let i = 0; i < leagueIds.length; i++) {
    const id = leagueIds[i];
    // Budget check at the league boundary — don't start a league we can't fund.
    if (used >= STANDINGS_FETCH_BUDGET) {
      budgetExhausted = true;
      remaining.push(...leagueIds.slice(i).map(Number));
      break;
    }
    try {
      const res = await archiveLeagueStandings(env, id, season, {
        force, isFinal, allowUnverified, budget: STANDINGS_FETCH_BUDGET - used,
      });
      used += res.pages_fetched || 0;
      archived.push(res);
      if (res.status === "budget_exhausted") {
        budgetExhausted = true;
        remaining.push(...leagueIds.slice(i).map(Number)); // includes this (unwritten) league
        break;
      }
    } catch (err) {
      // One league's failure must not sink the run — collect and continue.
      archived.push({ league_id: Number(id), status: "error", reason: String(err?.message || err) });
    }
  }

  const written = archived.filter(r => r.status === "written").length;
  const skipped = archived.filter(r => r.status === "skipped").length;
  const failed = archived.filter(r => r.status === "error").length;
  const refused = archived.filter(r => r.status === "refused").length;

  log.info("standings", "archive_run", {
    season: Number(season), final: isFinal,
    written, skipped, failed, refused, remaining: remaining.length, budget_exhausted: budgetExhausted,
  });

  return {
    ok: failed === 0 && refused === 0 && !budgetExhausted,
    season: Number(season),
    final: isFinal,
    archived,
    remaining,
    budget_exhausted: budgetExhausted,
    summary: { total: leagueIds.length, written, skipped, failed, refused, remaining: remaining.length },
  };
}

export async function updateEntryForGW(env, season, entryId, gw) {
  if (await isSeasonClosed(env.FPL_PULSE_KV, season)) return { updated: false, reason: "season_closed" };
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
  if (await isSeasonClosed(env.FPL_PULSE_KV, season)) return { updated: false, reason: "season_closed" };
  await kvPutJSON(env.FPL_PULSE_KV, kSnapshotCurrent, { season: Number(season), last_gw: Number(gw) });
  return { updated: true };
}

export async function harvestIfNeeded(env, { delaySec = 0 } = {}) {
  const season = await getEffectiveSeason(env);
  const t0 = Date.now();

  // Closed seasons are immutable. Checked before the bootstrap fetch so a closed season
  // costs one KV read per cron tick and no subrequests at all. Returned quietly, without
  // a log line: this fires hourly forever once a season closes, and the marker itself is
  // the durable record of why nothing is happening. The interesting event is the close,
  // which is logged once.
  if (await isSeasonClosed(env.FPL_PULSE_KV, season)) {
    return { status: "noop", reason: "season_closed", season };
  }

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
  // Fill the new GW and self-heal any earlier gaps; capped so a large historical
  // gap can't exhaust the cron's subrequest budget (the rest fills next cycle).
  await backfillSeasonElements(env, season, prevId, { limit: 4 });

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
  let timedOut = false;
  for (const id of allEntryIds) {
    if ((Date.now() - t0) > 25_000) {
      log.warn("harvest", "timeout_approaching", {
        processed: processedCount,
        total: allEntryIds.length,
        elapsed_ms: Date.now() - t0,
      });
      timedOut = true;
      break;
    }

    pending.push(updateEntryForGW(env, season, id, prevId).then(() => { processedCount++; }));

    if (pending.length >= concurrency) {
      await Promise.all(pending.splice(0));
    }
  }

  if (pending.length) await Promise.all(pending);

  log.info("harvest", timedOut ? "partial" : "completed", {
    processed: processedCount,
    total: allEntryIds.length,
    elapsed_ms: Date.now() - t0,
    gw: prevId,
  });

  // Only advance the snapshot if all entries were processed.
  // A partial harvest leaves KV in a mixed state — do not cache or mark as done,
  // so the next cron cycle will retry the remaining entries.
  if (!timedOut) {
    await updateSnapshot(env, season, prevId);
    // Close AFTER the snapshot advances. A partial harvest never reaches here, so a
    // season cannot close on incomplete data.
    const seasonClosed = await closeSeasonIfComplete(env, season, bootstrap, prevId);
    return { status: "ok", last_gw: prevId, season_closed: seasonClosed };
  }

  return { status: "partial", processed: processedCount, total: allEntryIds.length, last_gw: prevId };
}

// === Cache invalidation after harvest ===
//
// CONSTRAINT: On Cloudflare Workers Standard plan, ALL cache API operations
// (cache.delete / cache.match / cache.put) AND fetch() calls count as subrequests.
// Hard limit: 50 per Worker invocation.
//
// ARCHITECTURE:
//   warmCache()         — zero cache ops. Discovers all URLs to invalidate, writes a
//                         prioritised purge queue to KV. Returns immediately.
//   processPurgeQueue() — runs at the START of every cron cycle. Processes up to
//                         PURGE_BATCH_SIZE URLs per invocation (1 cache.delete each).
//
// PRIORITY ORDER in queue (processed first → freshest soonest):
//   1. Global season endpoints  — used by every page
//   2. Per-league aggregates    — entries-pack, standings, members (league page)
//   3. Individual entry blobs   — home + pulse pages
//
// SCALE (each /v1 artefact is queued twice — legacy + season-prefixed URL):
//   Current (4 leagues, ~36 entries): 5 globals + 4x5 league + 36x2 entry = 97 items,
//     clearing in 3 cron cycles (≤ 3h after harvest). Was 51 items / 2 cycles before
//     season-prefixed routes existed.
//   Up to ~8 leagues + ~100 entries: 245 items, 6 cycles.
//   Nothing overflows — each invocation still spends at most PURGE_BATCH_SIZE — but the
//   drain window roughly doubles. Once the frontend addresses every artefact with an
//   explicit season, the legacy unprefixed URLs become dead weight and can be dropped,
//   returning the queue to its previous size.
//   Future path for large-scale deployments: move worker to a custom Cloudflare domain,
//   then use the Zone Cache Purge API — one fetch() call purges 30 URLs, eliminating
//   the per-item subrequest cost entirely.

const PURGE_BATCH_SIZE = 45; // leaves 5 subrequest headroom against the 50-per-invocation limit

// Build and store a prioritised purge queue in KV — no cache ops, zero subrequests.
export async function warmCache(env) {
  const base = "https://fpl-pulse.ciaranbrennan18.workers.dev";
  // Every /v1 artefact is reachable at two URLs — the legacy unprefixed path and the
  // season-prefixed one — and edge cache keys are path-only, so they are SEPARATE
  // entries. Purging one leaves the other serving stale data behind an X-Cache: HIT for
  // up to the full dynamicCacheHeaders TTL (7 days during an active GW, which is only
  // safe *because* explicit purge is the real invalidation mechanism).
  //
  // Prefixed URLs are queued for the CURRENT season only. A closed season's data does
  // not change, so purging it is pure budget waste.
  const season = await getEffectiveSeason(env);

  // Discover all leagues from KV. Deliberately season-BLIND (see CLAUDE.md): this
  // scan matches every *:members key regardless of season, so after a rollover it
  // warms previous-season league and entry IDs against current-season URLs. That is
  // wasteful and log-noisy, not incorrect — purging a URL that holds nothing is a
  // no-op. Left as-is on purpose; the season-scoped fix belongs with the wider
  // warmCache rework. Keys are captured whole so the members read needs no season.
  let cursor;
  const leagues = [];
  do {
    const page = await env.FPL_PULSE_KV.list({ prefix: "league:", cursor, limit: 100 });
    cursor = page.cursor;
    for (const k of page.keys) {
      if (k.name.endsWith(":members")) leagues.push({ id: k.name.split(":")[1], membersKey: k.name });
    }
  } while (cursor);

  // Collect unique entry IDs across all leagues
  const entryIds = new Set();
  for (const { membersKey } of leagues) {
    const members = await kvGetJSON(env.FPL_PULSE_KV, membersKey);
    if (Array.isArray(members)) members.forEach(id => entryIds.add(id));
  }

  // One league can surface under both a legacy and a season-scoped members key
  // during the migration window — dedupe so its URLs are queued once.
  const leagueIds = [...new Set(leagues.map(l => l.id))];

  // Build prioritised list of URLs to purge from edge cache. Both addressing forms of
  // each /v1 artefact are queued (see the note above); /fpl/* has only one form.
  const urls = [
    // Priority 1: global — every page depends on these
    // /v1/seasons: a harvest can flip `closed`, and the first harvest of a new season
    // flips `has_data`. Its own 1h TTL is the backstop for the has_data flip that happens
    // between harvests (a first entry build on a plain cron tick).
    `${base}/v1/seasons`,
    `${base}/v1/season/elements`,
    `${base}/v1/season/bootstrap`,
    `${base}/v1/${season}/elements`,
    `${base}/v1/${season}/bootstrap`,
    `${base}/fpl/bootstrap`,
    // Priority 2: per-league aggregates — league page
    ...leagueIds.flatMap(id => [
      `${base}/fpl/league/${id}`,
      `${base}/v1/league/${id}/members`,
      `${base}/v1/league/${id}/entries-pack`,
      `${base}/v1/${season}/league/${id}/members`,
      `${base}/v1/${season}/league/${id}/entries-pack`,
    ]),
    // Priority 3: individual entry blobs — home + pulse pages
    ...[...entryIds].flatMap(id => [
      `${base}/v1/entry/${id}`,
      `${base}/v1/${season}/entry/${id}`,
    ]),
  ];

  await kvPutJSON(env.FPL_PULSE_KV, kPurgeQueue, {
    urls,
    processed: 0,
    created_at: new Date().toISOString(),
  });

  log.info("warm_cache", "queue_built", {
    total: urls.length,
    leagues: leagueIds.length,
    entries: entryIds.size,
    season,
    cycles_to_drain: Math.ceil(urls.length / PURGE_BATCH_SIZE),
  });

  return { status: "queued", total: urls.length, leagues: leagueIds.length, entries: entryIds.size, season };
}

// Process the next batch of cache purges from the KV queue.
// Each call uses up to PURGE_BATCH_SIZE subrequests (one cache.delete per URL).
// Designed to run at the START of every cron cycle until the queue is empty.
export async function processPurgeQueue(env) {
  const queue = await kvGetJSON(env.FPL_PULSE_KV, kPurgeQueue);
  if (!queue || !Array.isArray(queue.urls) || queue.processed >= queue.urls.length) {
    if (queue) await env.FPL_PULSE_KV.delete(kPurgeQueue);
    return { status: "noop" };
  }

  const cache = caches.default;
  const batch = queue.urls.slice(queue.processed, queue.processed + PURGE_BATCH_SIZE);

  for (const url of batch) {
    await cache.delete(new Request(url));
  }

  const newProcessed = queue.processed + batch.length;
  const done = newProcessed >= queue.urls.length;

  if (done) {
    await env.FPL_PULSE_KV.delete(kPurgeQueue);
  } else {
    await kvPutJSON(env.FPL_PULSE_KV, kPurgeQueue, { ...queue, processed: newProcessed });
  }

  log.info("warm_cache", done ? "purge_queue_done" : "purge_queue_partial", {
    processed_this_cycle: batch.length,
    total_processed: newProcessed,
    total: queue.urls.length,
  });

  return {
    status: done ? "ok" : "partial",
    processed_this_cycle: batch.length,
    total_processed: newProcessed,
    total: queue.urls.length,
  };
}
