// === FPL Pulse Worker - Entry Point ===
// Thin dispatcher: routes requests to handlers and runs scheduled cron jobs.
// All business logic lives in services/ and lib/.

import { CORS, text, log } from './lib/utils.js';
import { kvGetJSON, kDetectedSeason } from './lib/kv.js';
import { handlePublicRoute } from './routes/public.js';
import { handleAdminRoute } from './routes/admin.js';
import { harvestIfNeeded } from './services/harvest.js';
import { retryErroredEntries, updateHealthStateSummary } from './services/entry.js';

export default {
  async fetch(request, env, ctx) {
    // CORS preflight
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    // Quick season resolution with cache-first (no API call on every request)
    let season;
    const cachedSeason = await kvGetJSON(env.FPL_PULSE_KV, kDetectedSeason);
    if (cachedSeason && cachedSeason.season && cachedSeason.detected_at) {
      const ageMs = Date.now() - Date.parse(cachedSeason.detected_at);
      if (ageMs < 3600 * 1000) {
        season = cachedSeason.season;
      }
    }
    if (!season) {
      season = Number(env.SEASON || 2025); // Fallback, cron will update cache
    }

    // Try public routes first (/health, /v1/*, /fpl/*)
    const publicResponse = await handlePublicRoute(request, env, season);
    if (publicResponse) return publicResponse;

    // Try admin routes (/admin/*)
    const adminResponse = await handleAdminRoute(request, env, season);
    if (adminResponse) return adminResponse;

    // Fallback
    return text("Not found", 404);
  },

  // === Cron handler ===
  // Run harvest; also write a heartbeat key
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        await env.FPL_PULSE_KV.put(`heartbeat:${new Date(event.scheduledTime).toISOString()}`, "1", { expirationTtl: 3600 });
      } catch (err) {
        log.error("cron", "heartbeat_failed", { error: String(err?.message || err) });
      }
      try {
        await harvestIfNeeded(env);
      } catch (err) {
        log.error("cron", "harvest_failed", { error: String(err?.message || err) });
      }
      try {
        await retryErroredEntries(env);
      } catch (err) {
        log.error("cron", "retry_failed", { error: String(err?.message || err) });
      }
      try {
        await updateHealthStateSummary(env);
      } catch (err) {
        log.error("cron", "health_summary_failed", { error: String(err?.message || err) });
      }
    })());
  },
};
