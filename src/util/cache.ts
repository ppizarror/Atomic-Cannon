/**
 * Bounded memo caches — the insert-then-evict-oldest guard three separate renderers each
 * hand-wrote (the bitmap-font label cache, CTank's tint/silhouette caches, and the particle
 * system's tinted-sprite cache), plus one that had no guard at all and grew unbounded.
 *
 * A Map iterates in insertion order, so `keys().next()` IS the oldest entry — evicting that one
 * (rather than clearing the whole map) matters: a full clear turns a momentary overflow into a
 * rebuild storm where every subsequent frame misses on everything it just discarded.
 */

/**
 * Insert `value` under `key`, then evict oldest-first until the map is back within `max`.
 *
 * Note this is INSERTION order, not use order — a true LRU would re-insert on every hit, and
 * these caches are read on the hot draw path where that extra Map churn isn't worth it. The
 * entries are cheap to rebuild, so the occasional eviction of a still-hot key is fine.
 */
export function capSet<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}
