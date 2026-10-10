/**
 * A small in-memory cache whose entries expire a fixed time after they are
 * written, on an injected clock (ADR-019). One container holds one instance
 * per kind of value (flags, area statuses, CRM lookups); those decide what
 * counts as an answer worth storing — this cache never decides, it only
 * keeps what it is handed, so a timeout, an error or a default can only be
 * kept out by the caller never calling `set` for it.
 *
 * Construction fails fast: `ttlMs` must be a finite number greater than
 * zero and `now` a function, and a bad key or value is rejected — `set`
 * throws on a non-string or empty key and on `undefined` (which `get`
 * uses for a miss), and `get`/`has`/`peekAt` answer a non-string key with
 * a miss. A store made while the clock is broken is a bug the next read
 * should not inherit.
 *
 * Time inputs fail closed (AGENTS.md): while `now` reads non-finite, every
 * read is a miss and every write is dropped, so a broken clock degrades the
 * cache to always-miss instead of pinning entries fresh or stale forever.
 * Reads move the clock once per call; the entry stored at exactly `ttlMs`
 * ago is expired (the age check is strict).
 *
 * Handles (`{}`, `Object.create(null)`, class instances) are stored as
 * references: T08's callers only ever miss on `undefined`, never inspect
 * stored fields, so nothing they do can mutate a hit. Plain data (objects
 * and arrays, to any depth) is deep-frozen at write time, so a later
 * reader that mutates its hit cannot corrupt the next reader's, and the
 * mistake throws instead of spreading.
 */

export interface MemoryCache<T> {
  /** The stored value, or undefined when absent, expired, stored while the clock was broken, or the key is not a string. */
  get(key: string): T | undefined;
  /** The write time of the stored entry, or undefined on any miss. */
  peekAt(key: string): number | undefined;
  /** True exactly when `get` would return a value. */
  has(key: string): boolean;
  /** Stores `value` written at `now()`, deep-frozen when it is plain data. */
  set(key: string, value: T): void;
}

interface Entry<T> {
  value: T;
  at: number;
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return;
  }
  for (const inner of Object.values(value)) {
    deepFreeze(inner);
  }
  Object.freeze(value);
}

/** Freezes plain objects and arrays at any depth; handles (Map, Date, class instances) pass through untouched. */
function freezeIfPlainData<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null || Array.isArray(value)) {
      deepFreeze(value);
    }
  }
  return value;
}

export function createMemoryCache<T>(ttlMs: number, now: () => number): MemoryCache<T> {
  if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new RangeError(
      `createMemoryCache: ttlMs must be a finite number greater than zero, got ${String(ttlMs)}`,
    );
  }
  if (typeof now !== "function") {
    throw new TypeError("createMemoryCache: now must be a function");
  }
  const entries = new Map<string, Entry<T>>();

  const live = (key: string): Entry<T> | undefined => {
    const entry = entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    // A non-finite clock or a corrupt write time can never prove an entry
    // fresh: the strict comparison is false for NaN on either side. The
    // entry is dropped so a later set starts clean.
    if (!(now() - entry.at < ttlMs)) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  };

  return {
    get(key: string): T | undefined {
      if (typeof key !== "string") {
        return undefined;
      }
      return live(key)?.value;
    },
    peekAt(key: string): number | undefined {
      if (typeof key !== "string") {
        return undefined;
      }
      return live(key)?.at;
    },
    has(key: string): boolean {
      if (typeof key !== "string") {
        return false;
      }
      return live(key) !== undefined;
    },
    set(key: string, value: T): void {
      if (typeof key !== "string" || key.length === 0) {
        throw new TypeError(
          `MemoryCache.set: key must be a non-empty string, got ${JSON.stringify(key)}`,
        );
      }
      if (value === undefined) {
        throw new TypeError("MemoryCache.set: value must not be undefined");
      }
      const at = now();
      if (!Number.isFinite(at)) {
        // Fail closed: a write without a trustworthy write time would read
        // back fresh or stale at random, so it is dropped entirely.
        entries.delete(key);
        return;
      }
      entries.set(key, { value: freezeIfPlainData(value), at });
    },
  };
}
