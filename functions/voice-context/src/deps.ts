/**
 * The dependencies every voice-context route takes as an argument
 * (`handleDv(req, deps)` and friends). index.ts builds the real ones from
 * `env`; tests build fakes and stubs on the fake clock. Timeouts go through
 * the injected `TimeoutRunner` so a test holds every dependency promise and
 * fires every timer by hand (AGENTS.md, Tests).
 *
 * Secrets come through `SecretsDep`, never through `env` directly: reads
 * are memoised per container in index.ts, a failed read is not kept (the
 * next request tries again), and the parsed AES keys behind `getKey` are
 * turned into bytes with `parseKey` once per container per key.
 */

import type { KvNamespace } from "@telnyx/edge-runtime";

import type { Logger, MemoryCache, RefreshingValue } from "@duinvezel/shared";

import type { AccountsClient } from "./clients/accounts.js";
import type { CrmClient } from "./clients/crm.js";
import type { SessionsClient } from "./clients/sessions.js";
import type { AreaStatusDoc, CrmAnswer, DvFlags, TimeoutRunner } from "./config.js";

export interface CachesDep {
  /** Per-postcode status answers, 10 s; null is the "never published, so ok" answer. */
  areas: MemoryCache<AreaStatusDoc | null>;
  /** CRM lookup answers keyed by caller digits, 60 s (negative answers included). */
  crm: MemoryCache<CrmAnswer>;
}

export interface SecretsDep {
  /** The raw secret text, or null when it cannot be read. */
  get(handle: string): Promise<string | null>;
  /** The secret parsed as a base64url AES/HMAC key, or null when unreadable or unparseable. */
  getKey(handle: string): Promise<Uint8Array | null>;
}

export interface VoiceContextDeps {
  now: () => number;
  kv: KvNamespace;
  crm: CrmClient;
  accounts: AccountsClient;
  sessions: SessionsClient;
  caches: CachesDep;
  /**
   * The container's refreshing `flags/global` value (T20): one per
   * container, the last good parse served with no wait and refreshed in the
   * background once its 10 s lifetime has passed.
   */
  flagsValue: RefreshingValue<DvFlags>;
  secrets: SecretsDep;
  log: Logger;
  /** Nonce source for encryptForTelnyx (crypto randomBytes in production, pinned in tests). */
  random: (n: number) => Uint8Array;
  timeout: TimeoutRunner;
}
