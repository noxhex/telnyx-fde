import { describe, expect, it } from "vitest";
import {
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";

import { verifyTelnyxSignature } from "../src/index.js";

interface KeyPair {
  publicKeyRawB64: string;
  privateKey: KeyObject;
}

/** Generate an Ed25519 key pair and expose the raw public key bytes. */
function makeKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spkiDer = Buffer.from(
    publicKey.export({ type: "spki", format: "der" }) as unknown as ArrayBuffer,
  );
  const raw = spkiDer.subarray(spkiDer.length - 32);
  return {
    publicKeyRawB64: raw.toString("base64"),
    privateKey,
  };
}

function signMessage(keyPair: KeyPair, timestamp: string, body: string): string {
  const message = Buffer.from(`${timestamp}|${body}`, "utf8");
  return sign(null, message, keyPair.privateKey).toString("base64");
}

const TIMESTAMP = "1600000000";
const NOW_MS = 1600000000 * 1000;
const BODY = "{\"hello\":\"world\"}";

describe("verifyTelnyxSignature", () => {
  it("accepts a valid signature", () => {
    const keyPair = makeKeyPair();
    const result = verifyTelnyxSignature({
      rawBody: BODY,
      signature: signMessage(keyPair, TIMESTAMP, BODY),
      timestamp: TIMESTAMP,
      publicKey: keyPair.publicKeyRawB64,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: true });
  });

  it("accepts a signature when the timestamp is within maxSkewSec in either direction", () => {
    const keyPair = makeKeyPair();
    const body = BODY;
    const ts = "1600000000";
    const result = verifyTelnyxSignature({
      rawBody: body,
      signature: signMessage(keyPair, ts, body),
      timestamp: ts,
      publicKey: keyPair.publicKeyRawB64,
      nowMs: NOW_MS + 4 * 60 * 1000, // 4 minutes in the future, under 300s
    });
    expect(result).toEqual({ ok: true });
  });

  it("rejects a body that was tampered with", () => {
    const keyPair = makeKeyPair();
    const result = verifyTelnyxSignature({
      rawBody: "{\"hello\":\"tampered\"}",
      signature: signMessage(keyPair, TIMESTAMP, BODY),
      timestamp: TIMESTAMP,
      publicKey: keyPair.publicKeyRawB64,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("rejects a signature made with a different key", () => {
    const signer = makeKeyPair();
    const checker = makeKeyPair();
    const result = verifyTelnyxSignature({
      rawBody: BODY,
      signature: signMessage(signer, TIMESTAMP, BODY),
      timestamp: TIMESTAMP,
      publicKey: checker.publicKeyRawB64,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("rejects a timestamp that is too old", () => {
    const keyPair = makeKeyPair();
    const ts = "1599999000"; // 1000 seconds ago
    const result = verifyTelnyxSignature({
      rawBody: BODY,
      signature: signMessage(keyPair, ts, BODY),
      timestamp: ts,
      publicKey: keyPair.publicKeyRawB64,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("rejects a timestamp too far in the future", () => {
    const keyPair = makeKeyPair();
    const ts = "1600000600"; // 600 seconds ahead
    const result = verifyTelnyxSignature({
      rawBody: BODY,
      signature: signMessage(keyPair, ts, BODY),
      timestamp: ts,
      publicKey: keyPair.publicKeyRawB64,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("rejects a missing signature", () => {
    const keyPair = makeKeyPair();
    const result = verifyTelnyxSignature({
      rawBody: BODY,
      signature: null,
      timestamp: TIMESTAMP,
      publicKey: keyPair.publicKeyRawB64,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: "missing_headers" });
  });

  it("rejects an empty signature", () => {
    const keyPair = makeKeyPair();
    const result = verifyTelnyxSignature({
      rawBody: BODY,
      signature: "",
      timestamp: TIMESTAMP,
      publicKey: keyPair.publicKeyRawB64,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: "missing_headers" });
  });

  it("rejects a missing timestamp", () => {
    const keyPair = makeKeyPair();
    const result = verifyTelnyxSignature({
      rawBody: BODY,
      signature: signMessage(keyPair, TIMESTAMP, BODY),
      timestamp: null,
      publicKey: keyPair.publicKeyRawB64,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: "missing_headers" });
  });

  it("rejects an empty timestamp", () => {
    const keyPair = makeKeyPair();
    const result = verifyTelnyxSignature({
      rawBody: BODY,
      signature: signMessage(keyPair, TIMESTAMP, BODY),
      timestamp: "",
      publicKey: keyPair.publicKeyRawB64,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: "missing_headers" });
  });

  it("rejects a non-numeric timestamp", () => {
    const keyPair = makeKeyPair();
    const result = verifyTelnyxSignature({
      rawBody: BODY,
      signature: signMessage(keyPair, "abc", BODY),
      timestamp: "abc",
      publicKey: keyPair.publicKeyRawB64,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: "bad_timestamp" });
  });

  it("rejects a non-integer timestamp", () => {
    const keyPair = makeKeyPair();
    const result = verifyTelnyxSignature({
      rawBody: BODY,
      signature: signMessage(keyPair, "1600000000.5", BODY),
      timestamp: "1600000000.5",
      publicKey: keyPair.publicKeyRawB64,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: "bad_timestamp" });
  });

  it("rejects a public key of the wrong length", () => {
    const keyPair = makeKeyPair();
    const shortKey = Buffer.from([1, 2, 3]).toString("base64");
    const result = verifyTelnyxSignature({
      rawBody: BODY,
      signature: signMessage(keyPair, TIMESTAMP, BODY),
      timestamp: TIMESTAMP,
      publicKey: shortKey,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: "bad_public_key" });
  });

  it("rejects a signature of the wrong length", () => {
    const keyPair = makeKeyPair();
    const shortSig = Buffer.from([1, 2, 3]).toString("base64");
    const result = verifyTelnyxSignature({
      rawBody: BODY,
      signature: shortSig,
      timestamp: TIMESTAMP,
      publicKey: keyPair.publicKeyRawB64,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: "bad_signature_encoding" });
  });

  it("rejects a signature that is not base64", () => {
    const keyPair = makeKeyPair();
    const result = verifyTelnyxSignature({
      rawBody: BODY,
      signature: "!!! not base64 !!!",
      timestamp: TIMESTAMP,
      publicKey: keyPair.publicKeyRawB64,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: "bad_signature_encoding" });
  });

  it("rejects a public key that is not base64", () => {
    const keyPair = makeKeyPair();
    const result = verifyTelnyxSignature({
      rawBody: BODY,
      signature: signMessage(keyPair, TIMESTAMP, BODY),
      timestamp: TIMESTAMP,
      publicKey: "!!!not base64!!!",
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: false, reason: "bad_public_key" });
  });

  it("accepts a signature over a body with non-ASCII characters", () => {
    const keyPair = makeKeyPair();
    const body = "Café à Veurne €";
    const result = verifyTelnyxSignature({
      rawBody: body,
      signature: signMessage(keyPair, TIMESTAMP, body),
      timestamp: TIMESTAMP,
      publicKey: keyPair.publicKeyRawB64,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: true });
  });
});