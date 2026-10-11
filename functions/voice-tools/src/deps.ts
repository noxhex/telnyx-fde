/**
 * The dependencies every voice-tools route takes as an argument
 * (`handleMcp(req, deps)` and friends). index.ts builds the real ones from
 * `env`; tests build fakes and stubs on the fake clock. Timeouts go through
 * the injected `TimeoutRunner` so a test holds every dependency promise and
 * fires every timer by hand (AGENTS.md, Tests).
 *
 * Secrets come through `SecretsDep`, never through `env` directly: reads
 * are memoised per container in index.ts, a failed read is not kept (the
 * next request tries again), and `MCP_TOKEN_KEY` is turned into bytes with
 * `parseKey` once per container, exactly what card T09 asks for.
 *
 * `kv` is optional: `telnyx-edge dev` has no KV binding (DEBUGLOG issue 9),
 * and routes that need it fail closed. The actor bindings exist under dev.
 */

import type { KvNamespace } from "@telnyx/edge-runtime";

import type { Logger, MemoryCache } from "@duinvezel/shared";

import type { AreaStatusDoc } from "./area-status.js";
import type { CrmClient } from "./clients/crm.js";
import type { SessionsClient } from "./clients/sessions.js";
import type { TimeoutRunner } from "./config.js";

export interface CachesDep {
  /** Per-postcode status answers, 10 s; null is the "never published, so ok" answer. */
  areas: MemoryCache<AreaStatusDoc | null>;
}

export interface SecretsDep {
  /** The raw secret text, or null when it cannot be read. */
  get(handle: string): Promise<string | null>;
  /** The secret parsed as a base64url AES/HMAC key, or null when unreadable or unparseable. */
  getKey(handle: string): Promise<Uint8Array | null>;
}

export interface VoiceToolsDeps {
  now: () => number;
  kv: KvNamespace | undefined;
  sessions: SessionsClient;
  crm: CrmClient;
  caches: CachesDep;
  secrets: SecretsDep;
  log: Logger;
  /** Randomness for the internal-session sid (crypto randomBytes in production, pinned in tests). */
  random: (n: number) => Uint8Array;
  timeout: TimeoutRunner;
}
