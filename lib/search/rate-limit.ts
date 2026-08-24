/**
 * Best-effort in-memory request throttle for the search route.
 *
 * The route fans out to third-party feeds on every call, so an unthrottled
 * client can turn this site into a free amplifier against those providers (and
 * burn its own quota). State lives in the isolate, so this is a courtesy limit
 * rather than a security boundary — a durable object or KV counter would be
 * needed to make it exact across isolates.
 */

export type RateLimitConfig = {
  windowMs: number;
  maxRequests: number;
  /** Cap on tracked clients so the map cannot grow without bound. */
  maxTrackedClients: number;
};

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  windowMs: 60_000,
  maxRequests: 20,
  maxTrackedClients: 5_000,
};

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

export type RateLimitStore = Map<string, number[]>;

const defaultStore: RateLimitStore = new Map();

/** Derives a client key from Cloudflare's connecting-IP header, falling back to XFF. */
export function clientKey(request: Request): string {
  const direct = request.headers.get("cf-connecting-ip");
  if (direct) return direct;
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim() || "unknown";
  return "unknown";
}

export function checkRateLimit(
  key: string,
  now: number = Date.now(),
  config: RateLimitConfig = DEFAULT_RATE_LIMIT,
  store: RateLimitStore = defaultStore,
): RateLimitResult {
  const windowStart = now - config.windowMs;
  const recent = (store.get(key) ?? []).filter((timestamp) => timestamp > windowStart);

  if (recent.length >= config.maxRequests) {
    store.set(key, recent);
    const oldest = recent[0] ?? now;
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + config.windowMs - now) / 1000)),
    };
  }

  recent.push(now);
  store.set(key, recent);
  pruneStore(store, windowStart, config.maxTrackedClients);

  return { allowed: true, remaining: config.maxRequests - recent.length, retryAfterSeconds: 0 };
}

function pruneStore(store: RateLimitStore, windowStart: number, maxTrackedClients: number): void {
  if (store.size <= maxTrackedClients) return;
  for (const [key, timestamps] of store) {
    const live = timestamps.filter((timestamp) => timestamp > windowStart);
    if (live.length === 0) store.delete(key);
    else store.set(key, live);
  }
  // Still over budget after expiring stale windows: drop oldest insertions.
  while (store.size > maxTrackedClients) {
    const oldestKey = store.keys().next().value;
    if (oldestKey === undefined) break;
    store.delete(oldestKey);
  }
}
