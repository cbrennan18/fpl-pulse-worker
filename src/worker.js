export default {
  async fetch(request, env, ctx) {
    return new Response(
      JSON.stringify({
        status: "ok",
        version: env.APP_VERSION || "dev",
        season: env.SEASON || null,
        ts: Date.now(),
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  },

  async scheduled(event, env, ctx) {
    // Cron heartbeat for now
    console.log("Cron fired at", new Date(event.scheduledTime).toISOString());
  },
};