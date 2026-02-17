// === Shared test mocks for KV and fetch ===

/**
 * In-memory KV mock that implements the Cloudflare KV API surface
 * used by the worker: get(), put(), delete(), list().
 */
export function createMockKV(initial = {}) {
  const store = new Map(Object.entries(initial));

  return {
    async get(key, opts) {
      const val = store.get(key) ?? null;
      if (val === null) return null;
      if (opts?.type === "json") return JSON.parse(val);
      return val;
    },
    async put(key, value, _opts) {
      store.set(key, typeof value === "string" ? value : JSON.stringify(value));
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix = "", cursor, limit = 1000 } = {}) {
      const keys = [];
      for (const k of store.keys()) {
        if (k.startsWith(prefix)) keys.push({ name: k });
      }
      return { keys: keys.slice(0, limit), cursor: null, list_complete: true };
    },
    // Test helper: read raw store
    _store: store,
    _getJSON(key) {
      const v = store.get(key);
      return v ? JSON.parse(v) : null;
    },
  };
}

/**
 * Create a mock env object with a fresh KV namespace.
 */
export function createMockEnv(kvInitial = {}) {
  return {
    FPL_PULSE_KV: createMockKV(kvInitial),
    SEASON: "2025",
    REFRESH_TOKEN: "test-token",
    APP_VERSION: "test",
  };
}

/**
 * Install a mock for globalThis.fetch that routes FPL API URLs
 * to provided handler functions. Returns a cleanup function.
 *
 * Usage:
 *   const cleanup = mockFetch({
 *     "https://fantasy.premierleague.com/api/entry/123/": { id: 123, ... },
 *     "https://fantasy.premierleague.com/api/bootstrap-static/": bootstrapData,
 *   });
 *   // ... run tests ...
 *   cleanup();
 */
export function mockFetch(routes = {}) {
  const original = globalThis.fetch;

  globalThis.fetch = async (url, _opts) => {
    const urlStr = typeof url === "string" ? url : url.url;

    if (routes[urlStr] !== undefined) {
      const val = routes[urlStr];

      // If the route value is a function, call it to get the response
      if (typeof val === "function") return val(urlStr);

      // If it's a Response, return it directly
      if (val instanceof Response) return val;

      // If it's an Error, throw it
      if (val instanceof Error) throw val;

      // Otherwise, wrap in a JSON response
      return new Response(JSON.stringify(val), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Unmatched URLs return 404
    return new Response("Not found", { status: 404 });
  };

  return () => { globalThis.fetch = original; };
}

/**
 * Helper to create a minimal FPL bootstrap-static response.
 */
export function createBootstrap({ season = 2025, events = [] } = {}) {
  return {
    events: events.length ? events : [
      {
        id: 1,
        deadline_time: `${season}-08-16T17:30:00Z`,
        finished: true,
        data_checked: true,
        is_current: false,
      },
      {
        id: 2,
        deadline_time: `${season}-08-23T17:30:00Z`,
        finished: true,
        data_checked: true,
        is_current: false,
      },
      {
        id: 3,
        deadline_time: `${season}-08-30T17:30:00Z`,
        finished: false,
        data_checked: false,
        is_current: true,
      },
    ],
  };
}
