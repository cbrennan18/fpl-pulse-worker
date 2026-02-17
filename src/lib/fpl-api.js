import { log } from './utils.js';

// === Circuit breaker for FPL API ===
// Prevents hammering FPL API when it's down
export const circuitBreaker = {
  failures: 0,
  openUntil: 0,
  maxFailures: 15,
  resetTimeout: 15 * 60 * 1000, // 15 minutes

  isOpen() {
    if (this.openUntil > 0 && Date.now() < this.openUntil) {
      return true;
    }
    if (this.openUntil > 0 && Date.now() >= this.openUntil) {
      // Circuit breaker timeout expired, reset
      this.reset();
    }
    return false;
  },

  recordFailure() {
    this.failures++;
    if (this.failures >= this.maxFailures) {
      this.openUntil = Date.now() + this.resetTimeout;
      log.error("circuit_breaker", "open", {
        failures: this.failures,
        reset_timeout_min: this.resetTimeout / 60000,
        open_until: new Date(this.openUntil).toISOString(),
      });
    }
  },

  recordSuccess() {
    if (this.failures > 0) {
      this.failures = Math.max(0, this.failures - 1); // Gradual recovery
    }
  },

  reset() {
    const prevFailures = this.failures;
    this.failures = 0;
    this.openUntil = 0;
    log.info("circuit_breaker", "reset", { previous_failures: prevFailures });
  }
};

// === FPL fetch helper ===
export async function fetchJson(url, init = {}) {
  const res = await fetch(url, {
    method: "GET",
    headers: { "Accept": "application/json", ...(init.headers || {}) },
    cf: { cacheEverything: false }, // no edge cache on admin fetches
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`FPL fetch failed ${res.status} ${res.statusText} :: ${url} :: ${txt.slice(0,200)}`);
  }
  return res.json();
}

// === Backfill helpers ===
export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export async function fetchJsonWithRetry(url, tries = 3, baseDelay = 200) {
  // Check circuit breaker before making request
  if (circuitBreaker.isOpen()) {
    throw new Error(`Circuit breaker OPEN - FPL API temporarily unavailable`);
  }

  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { "Accept": "application/json" }, cf: { cacheEverything: false } });

      // Handle rate limiting and service unavailability
      if (res.status === 429 || res.status === 503) {
        const retryAfter = res.headers.get("Retry-After");
        const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : Math.min(baseDelay * Math.pow(2, i + 2), 10000);
        log.warn("fpl_api", "rate_limited", {
          status: res.status,
          url,
          wait_ms: waitMs,
          retry_attempt: i + 1,
          max_retries: tries,
        });
        circuitBreaker.recordFailure();
        if (i < tries - 1) await sleep(waitMs);
        lastErr = new Error(`HTTP ${res.status} for ${url}`);
        continue;
      }

      if (!res.ok) {
        if (res.status !== 404) circuitBreaker.recordFailure();
        throw new Error(`HTTP ${res.status} for ${url}`);
      }

      // Success - record it for circuit breaker
      circuitBreaker.recordSuccess();
      return await res.json();
    } catch (err) {
      lastErr = err;
      circuitBreaker.recordFailure();
      if (i < tries - 1) await sleep(baseDelay * Math.pow(2, i)); // 200ms, 400ms, 800ms
    }
  }
  throw lastErr;
}

export async function fetchBootstrap() {
  return fetchJsonWithRetry("https://fantasy.premierleague.com/api/bootstrap-static/");
}
