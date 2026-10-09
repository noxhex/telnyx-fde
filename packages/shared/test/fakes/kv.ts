/**
 * In-memory fake of the Telnyx KV binding (`KvNamespace` from
 * `@telnyx/edge-runtime`), for tests that must not touch the real service.
 * `KvFake extends KvNamespace`, so a fake can be passed anywhere the real
 * binding goes.
 *
 * TTL is evaluated lazily against the injected clock on every access; an
 * expired key behaves as deleted (and is purged). As on the platform,
 * fractional TTLs are floored and a TTL below one second means the key never
 * expires. `list` always returns every matching key on one page
 * (`list_complete: true`, never a `cursor`): the fake holds the whole
 * namespace in memory, so pagination would add machinery without behavioural
 * value.
 *
 * Every call is appended to `calls` so a test can assert that a route never
 * touched KV; `reset()` clears that log (not the data).
 */

import type {
  KvGetJsonOptions,
  KvGetTextOptions,
  KvListOptions,
  KvListResult,
  KvNamespace,
  KvPutOptions,
} from "@telnyx/edge-runtime";

export interface KvFakeCall {
  method: "get" | "put" | "delete" | "list";
  key?: string;
  options?: KvGetTextOptions | KvGetJsonOptions | KvPutOptions | KvListOptions;
}

export interface KvFake extends KvNamespace {
  readonly calls: KvFakeCall[];
  /** Clears the recorded calls, not the stored data. */
  reset(): void;
}

interface KvEntry {
  value: string;
  /** Epoch ms at which the key expires (`now >= expiresAtMs` means gone). */
  expiresAtMs: number | null;
}

class KvFakeImpl implements KvFake {
  readonly calls: KvFakeCall[] = [];
  private readonly entries = new Map<string, KvEntry>();

  constructor(private readonly clock: () => number) {}

  get(key: string, options?: KvGetTextOptions): Promise<string | null>;
  get<T>(key: string, options: KvGetJsonOptions): Promise<T | null>;
  async get(
    key: string,
    options?: KvGetTextOptions | KvGetJsonOptions,
  ): Promise<unknown> {
    this.calls.push({ method: "get", key, options });
    const entry = this.live(key);
    if (entry === null) {
      return null;
    }
    if (options?.type === "json") {
      // Mirrors the real binding: a stored empty string yields null on a
      // JSON read instead of a SyntaxError.
      if (entry.value === "") {
        return null;
      }
      return JSON.parse(entry.value) as unknown;
    }
    return entry.value;
  }

  async put(key: string, value: string, options: KvPutOptions = {}): Promise<void> {
    this.calls.push({ method: "put", key, options });
    let expiresAtMs: number | null = null;
    if (options.expirationTtl !== undefined) {
      // Time inputs fail closed (AGENTS.md): a non-finite TTL is a bug, so
      // reject it instead of silently pinning the key forever.
      if (!Number.isFinite(options.expirationTtl)) {
        throw new Error(`Invalid expirationTtl: ${options.expirationTtl}`);
      }
      // Mirrors the platform: fractional TTLs are floored and values below
      // one second are ignored, so the key then never expires.
      const ttlSeconds = Math.floor(options.expirationTtl);
      if (ttlSeconds >= 1) {
        expiresAtMs = this.clock() + ttlSeconds * 1000;
      }
    }
    this.entries.set(key, { value, expiresAtMs });
  }

  async delete(key: string): Promise<void> {
    this.calls.push({ method: "delete", key });
    // Like the real binding, deleting a missing key succeeds silently.
    this.entries.delete(key);
  }

  async list(options: KvListOptions = {}): Promise<KvListResult> {
    this.calls.push({ method: "list", options });
    const result: KvListResult = { keys: [], list_complete: true };
    for (const name of [...this.entries.keys()].sort()) {
      if (options.prefix !== undefined && !name.startsWith(options.prefix)) {
        continue;
      }
      if (this.live(name) === null) {
        continue;
      }
      result.keys.push({ name });
    }
    return result;
  }

  reset(): void {
    this.calls.length = 0;
  }

  /** Returns the entry unless absent or expired (expired entries are purged). */
  private live(key: string): KvEntry | null {
    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAtMs !== null && this.clock() >= entry.expiresAtMs) {
      this.entries.delete(key);
      return null;
    }
    return entry;
  }
}

export function createKvFake(clock: () => number): KvFake {
  return new KvFakeImpl(clock);
}
