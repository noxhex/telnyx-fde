/**
 * Test helper that signs requests the way Telnyx signs webhooks: Ed25519
 * over `{timestamp}|{raw body}`, the signature in `telnyx-signature-ed25519`
 * and the timestamp in `telnyx-timestamp`. The key pair is generated per
 * test run (AGENTS.md: tests generate their own keys), so no secret
 * material ever lives in the repo.
 */

import { generateKeyPairSync, sign } from "node:crypto";

export interface TestKeyPair {
  /** The 32 raw public key bytes, base64 — what the TELNYX_PUBLIC_KEY secret holds in tests. */
  publicKeyBase64: string;
  /** Signs `{timestamp}|{rawBody}` and returns the base64 signature. */
  sign(timestamp: string, rawBody: string): string;
}

// DER SPKI header for Ed25519; the 32 raw key bytes follow it.
const ED25519_SPKI_PREFIX_BYTES = 12;

export function createTestKeyPair(): TestKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyBase64 = publicKey
    .export({ format: "der", type: "spki" })
    .subarray(ED25519_SPKI_PREFIX_BYTES)
    .toString("base64");
  return {
    publicKeyBase64,
    sign(timestamp: string, rawBody: string): string {
      return sign(null, Buffer.from(`${timestamp}|${rawBody}`, "utf8"), privateKey).toString(
        "base64",
      );
    },
  };
}

export interface SignedRequestOptions {
  keyPair: TestKeyPair;
  /** Serialised to JSON; pass a string to send it verbatim. */
  body: unknown;
  /** Seconds since epoch; defaults to 1,600,000,000. */
  timestampSec?: number;
  /** A timestamp string that bypasses the default, for malformed-value tests. */
  rawTimestamp?: string;
  path?: string;
  method?: string;
  userAgent?: string;
}

/** Builds a properly signed POST request. */
export function makeSignedRequest(options: SignedRequestOptions): Request {
  const rawBody =
    typeof options.body === "string" ? options.body : JSON.stringify(options.body ?? {});
  const timestamp = options.rawTimestamp ?? String(options.timestampSec ?? 1_600_000_000);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "telnyx-timestamp": timestamp,
    "telnyx-signature-ed25519": options.keyPair.sign(timestamp, rawBody),
    "user-agent": options.userAgent ?? "Telnyx-Webhook/1.0",
  };
  return new Request(`http://voice-context.test${options.path ?? "/dv"}`, {
    method: options.method ?? "POST",
    headers,
    body: rawBody,
  });
}

/** Builds a request with no signature headers at all. */
export function makeUnsignedRequest(options: {
  body?: unknown;
  path?: string;
  method?: string;
  userAgent?: string;
}): Request {
  const rawBody =
    typeof options.body === "string" ? options.body : JSON.stringify(options.body ?? {});
  return new Request(`http://voice-context.test${options.path ?? "/dv"}`, {
    method: options.method ?? "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": options.userAgent ?? "Telnyx-Webhook/1.0",
    },
    body: rawBody,
  });
}

/** A valid `assistant.initialization` webhook body; override per test. */
export function makeDvBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    data: {
      event_type: "assistant.initialization",
      payload: {
        telnyx_end_user_target: "+3258000110",
        telnyx_agent_target: "+3258000120",
        call_control_id: "v3:6A0bCdEf1:2026-10-10T09:00:00Z",
        telnyx_conversation_channel: "phone_call",
        ...overrides,
      },
    },
  };
}
