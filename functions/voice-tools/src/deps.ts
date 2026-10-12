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

import type { Logger, MemoryCache, RefreshingValue } from "@duinvezel/shared";

import type { AreaStatusDoc } from "./area-status.js";
import type { AccountsClient } from "./clients/accounts.js";
import type { AreasClient } from "./clients/areas.js";
import type { CrmClient } from "./clients/crm.js";
import type { SessionsClient } from "./clients/sessions.js";
import type { TimeoutRunner } from "./config.js";
import type { ToolsFlags } from "./flags.js";

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
  /** `CUSTOMER_ACCOUNT` typed with the class's own method shapes (T19). */
  accounts: AccountsClient;
  /** `AREA_INCIDENT` typed with the class's own method shapes (T19). */
  areas: AreasClient;
  caches: CachesDep;
  /**
   * The container's refreshing `flags/global` value (T20): one per
   * container, the last good parse served with no wait and refreshed in the
   * background once its 10 s lifetime has passed. Undefined when there is
   * no KV binding (`telnyx-edge dev`), where the defaults apply.
   */
  flagsValue: RefreshingValue<ToolsFlags> | undefined;
  secrets: SecretsDep;
  log: Logger;
  /** Randomness for the internal-session sid (crypto randomBytes in production, pinned in tests). */
  random: (n: number) => Uint8Array;
  timeout: TimeoutRunner;
}
