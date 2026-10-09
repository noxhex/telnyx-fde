import { generateKeyPairSync, sign, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { verifyTelnyxSignature } from "../src/index.js";

// Wrap verify in a mock that delegates to the real implementation, so one
// test below can make it throw. Every other test uses the real verify.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, verify: vi.fn(actual.verify) };
});

const NOW_MS = 1_760_000_000_000;
const NOW_SEC = String(Math.floor(NOW_MS / 1000));
const BODY = '{"data":{"event_type":"assistant.initialization"}}';

interface TestKey {
  publicKeyBase64: string;
  privateKey: KeyObject;
}

function generateTestKey(): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  const rawPublicKey = spki.subarray(spki.length - 32);
  return { publicKeyBase64: rawPublicKey.toString("base64"), privateKey };
}

function signPayload(privateKey: KeyObject, timestamp: string, rawBody: string): string {
  const message = Buffer.from(`${timestamp}|${rawBody}`, "utf8");
  return sign(null, message, privateKey).toString("base64");
}

function signedInput(key: TestKey, overrides: Record<string, unknown> = {}) {
  return {
    rawBody: BODY,
    signature: signPayload(key.privateKey, NOW_SEC, BODY),
    timestamp: NOW_SEC,
    publicKey: key.publicKeyBase64,
    nowMs: NOW_MS,
    ...overrides,
  };
}

describe("verifyTelnyxSignature", () => {
  it("accepts a valid signature", () => {
    const key = generateTestKey();
    expect(verifyTelnyxSignature(signedInput(key))).toEqual({ ok: true });
  });

  it("rejects a tampered body", () => {
    const key = generateTestKey();
    const result = verifyTelnyxSignature(signedInput(key, { rawBody: `${BODY} ` }));
    expect(result).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("rejects a signature made with a different key", () => {
    const signer = generateTestKey();
    const other = generateTestKey();
    const result = verifyTelnyxSignature(
      signedInput(signer, { publicKey: other.publicKeyBase64 }),
    );
    expect(result).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("rejects a timestamp that is too old", () => {
    const key = generateTestKey();
    const oldSec = String(Math.floor(NOW_MS / 1000) - 301);
    const result = verifyTelnyxSignature(
      signedInput(key, {
        timestamp: oldSec,
        signature: signPayload(key.privateKey, oldSec, BODY),
      }),
    );
    expect(result).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("rejects a timestamp too far in the future", () => {
    const key = generateTestKey();
    const futureSec = String(Math.floor(NOW_MS / 1000) + 301);
    const result = verifyTelnyxSignature(
      signedInput(key, {
        timestamp: futureSec,
        signature: signPayload(key.privateKey, futureSec, BODY),
      }),
    );
    expect(result).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("rejects a missing or empty signature header", () => {
    const key = generateTestKey();
    for (const signature of [null, ""]) {
      expect(verifyTelnyxSignature(signedInput(key, { signature }))).toEqual({
        ok: false,
        reason: "missing_headers",
      });
    }
  });

  it("rejects a missing or empty timestamp header", () => {
    const key = generateTestKey();
    for (const timestamp of [null, ""]) {
      expect(verifyTelnyxSignature(signedInput(key, { timestamp }))).toEqual({
        ok: false,
        reason: "missing_headers",
      });
    }
  });

  it("rejects a timestamp that is not a whole number of seconds", () => {
    const key = generateTestKey();
    for (const timestamp of ["not-a-timestamp", "1760000000.5", "-1760000000"]) {
      expect(verifyTelnyxSignature(signedInput(key, { timestamp }))).toEqual({
        ok: false,
        reason: "bad_timestamp",
      });
    }
  });

  it("rejects a public key that does not decode to 32 bytes", () => {
    const key = generateTestKey();
    for (const length of [16, 33]) {
      const publicKey = Buffer.alloc(length, 7).toString("base64");
      expect(verifyTelnyxSignature(signedInput(key, { publicKey }))).toEqual({
        ok: false,
        reason: "bad_public_key",
      });
    }
  });

  it("rejects a signature that does not decode to 64 bytes", () => {
    const key = generateTestKey();
    const signature = Buffer.alloc(63, 1).toString("base64");
    expect(verifyTelnyxSignature(signedInput(key, { signature }))).toEqual({
      ok: false,
      reason: "bad_signature_encoding",
    });
  });

  it("rejects a signature that is not base64", () => {
    const key = generateTestKey();
    const result = verifyTelnyxSignature(signedInput(key, { signature: "%%not base64%%" }));
    expect(result).toEqual({ ok: false, reason: "bad_signature_encoding" });
  });

  it("accepts a skew of exactly maxSkewSec and honours a custom maxSkewSec", () => {
    const key = generateTestKey();
    const edgeSec = String(Math.floor(NOW_MS / 1000) - 300);
    const edgeInput = signedInput(key, {
      timestamp: edgeSec,
      signature: signPayload(key.privateKey, edgeSec, BODY),
    });
    expect(verifyTelnyxSignature(edgeInput)).toEqual({ ok: true });
    expect(verifyTelnyxSignature({ ...edgeInput, maxSkewSec: 60 })).toEqual({
      ok: false,
      reason: "stale_timestamp",
    });
  });

  it("verifies a body containing non-ASCII characters", () => {
    const key = generateTestKey();
    const rawBody = "Café à Veurne €";
    const result = verifyTelnyxSignature(
      signedInput(key, {
        rawBody,
        signature: signPayload(key.privateKey, NOW_SEC, rawBody),
      }),
    );
    expect(result).toEqual({ ok: true });
  });

  it("rejects a non-finite nowMs as a stale timestamp", () => {
    const key = generateTestKey();
    for (const nowMs of [NaN, Infinity, -Infinity]) {
      expect(verifyTelnyxSignature(signedInput(key, { nowMs }))).toEqual({
        ok: false,
        reason: "stale_timestamp",
      });
    }
  });

  it("rejects a non-finite maxSkewSec as a stale timestamp", () => {
    const key = generateTestKey();
    for (const maxSkewSec of [NaN, Infinity]) {
      expect(verifyTelnyxSignature(signedInput(key, { maxSkewSec }))).toEqual({
        ok: false,
        reason: "stale_timestamp",
      });
    }
  });

  it("returns invalid_signature when verification throws unexpectedly", () => {
    const key = generateTestKey();
    vi.mocked(verify).mockImplementationOnce(() => {
      throw new Error("unexpected crypto failure");
    });
    expect(verifyTelnyxSignature(signedInput(key))).toEqual({
      ok: false,
      reason: "invalid_signature",
    });
  });

  describe("check order", () => {
    it("reports missing headers before a malformed timestamp", () => {
      const key = generateTestKey();
      const result = verifyTelnyxSignature(
        signedInput(key, { signature: null, timestamp: "not-a-timestamp" }),
      );
      expect(result).toEqual({ ok: false, reason: "missing_headers" });
    });

    it("reports a malformed timestamp before staleness", () => {
      const key = generateTestKey();
      const result = verifyTelnyxSignature(
        signedInput(key, { timestamp: "not-a-timestamp", nowMs: NaN }),
      );
      expect(result).toEqual({ ok: false, reason: "bad_timestamp" });
    });

    it("reports staleness before a bad public key", () => {
      const key = generateTestKey();
      const oldSec = String(Math.floor(NOW_MS / 1000) - 301);
      const result = verifyTelnyxSignature(
        signedInput(key, {
          timestamp: oldSec,
          signature: signPayload(key.privateKey, oldSec, BODY),
          publicKey: Buffer.alloc(16, 7).toString("base64"),
        }),
      );
      expect(result).toEqual({ ok: false, reason: "stale_timestamp" });
    });

    it("reports a bad public key before bad signature encoding", () => {
      const key = generateTestKey();
      const result = verifyTelnyxSignature(
        signedInput(key, {
          publicKey: Buffer.alloc(16, 7).toString("base64"),
          signature: Buffer.alloc(63, 1).toString("base64"),
        }),
      );
      expect(result).toEqual({ ok: false, reason: "bad_public_key" });
    });

    it("reports bad signature encoding before verification", () => {
      const key = generateTestKey();
      const result = verifyTelnyxSignature(
        signedInput(key, { signature: Buffer.alloc(63, 1).toString("base64") }),
      );
      expect(result).toEqual({ ok: false, reason: "bad_signature_encoding" });
    });
  });
});
