/**
 * Small TTL cache for upstream responses.
 *
 * The route fans out to the same handful of feeds on every request, and those
 * feeds update on the order of minutes, not milliseconds. Without this, ten
 * users asking for headlines in the same minute produce thirty outbound
 * requests for identical bytes. State lives in the isolate, so this is a
 * best-effort cache like the rate limiter — a cache miss is always safe.
 */

export type CacheEntry = { value: string; expiresAt: number };
export type CacheStore = Map<string, CacheEntry>;

/** Feeds are refreshed on the order of minutes; a short TTL keeps news fresh. */
export const DEFAULT_TTL_MS = 120_000;

/** Bounds memory: the isolate is shared and entries are whole documents. */
export const MAX_ENTRIES = 60;

const store: CacheStore = new Map();

/**
 * Drops expired entries, then evicts oldest-first until the store fits.
 * Map preserves insertion order, so the first key is the oldest write.
 */
function prune(cache: CacheStore, now: number, maxEntries: number): void {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

export function readCache(key: string, now = Date.now(), cache: CacheStore = store): string | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    cache.delete(key);
    return null;
  }
  // Refresh insertion order so frequently read entries are evicted last.
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

export function writeCache(
  key: string,
  value: string,
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now(),
  cache: CacheStore = store,
  maxEntries = MAX_ENTRIES,
): void {
  cache.delete(key);
  cache.set(key, { value, expiresAt: now + ttlMs });
  prune(cache, now, maxEntries);
}

/** Exported for tests. */
export function clearCache(cache: CacheStore = store): void {
  cache.clear();
}
