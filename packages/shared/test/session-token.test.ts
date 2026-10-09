import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { mintSessionToken, verifySessionToken } from "../src/index.js";

const SID = "0123456789abcdef0123456789abcdef";
const NOW_MS = 1_760_000_000_000;
const EXP = NOW_MS + 3_600_000;

// A deterministic key so no test depends on OS randomness.
const KEY = new Uint8Array(32).fill(7);

function b64url(input: Uint8Array | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  return buf.toString("base64url");
}

/** Build a token whose HMAC is computed over the exact message spec expects. */
function buildToken(opts: { version?: string; payload?: string; hmacKey?: Uint8Array } = {}): string {
  const version = opts.version ?? "v1";
  const payload = opts.payload ?? b64url(JSON.stringify({ v: 1, sid: SID, exp: EXP }));
  const hmacKey = opts.hmacKey ?? KEY;
  const message = `${version}.${payload}`;
  const sig = b64url(createHmac("sha256", Buffer.from(hmacKey)).update(message, "utf8").digest());
  return `${version}.${payload}.${sig}`;
}

/** Flip the low bit of the first decoded byte of a base64url part. */
function flipFirstByte(part: string): string {
  const bytes = Buffer.from(part, "base64url");
  bytes[0] ^= 0x01;
  return bytes.toString("base64url");
}

describe("mintSessionToken", () => {
  it("mints a v1 token with three parts and no base64url padding", () => {
    const token = mintSessionToken({ sid: SID, exp: EXP }, KEY);
    const parts = token.split(".");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("v1");
    expect(token).not.toMatch(/=/);
  });

  it("encodes the claims as base64url JSON in the payload part", () => {
    const token = mintSessionToken({ sid: SID, exp: EXP }, KEY);
    const [, payload] = token.split(".");
    expect(JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))).toEqual({
      v: 1,
      sid: SID,
      exp: EXP,
    });
  });

  it("is deterministic for the same claims and key", () => {
    const a = mintSessionToken({ sid: SID, exp: EXP }, KEY);
    const b = mintSessionToken({ sid: SID, exp: EXP }, KEY);
    expect(a).toBe(b);
  });
});

describe("verifySessionToken", () => {
  it("accepts a valid token and returns its claims", () => {
    const token = mintSessionToken({ sid: SID, exp: EXP }, KEY);
    expect(verifySessionToken(token, KEY, NOW_MS)).toEqual({
      ok: true,
      claims: { v: 1, sid: SID, exp: EXP },
    });
  });

  it("accepts an exp exactly one millisecond after nowMs", () => {
    const token = mintSessionToken({ sid: SID, exp: NOW_MS + 1 }, KEY);
    expect(verifySessionToken(token, KEY, NOW_MS)).toEqual({ ok: true, claims: { v: 1, sid: SID, exp: NOW_MS + 1 } });
  });

  it("rejects a token whose exp equals nowMs as expired", () => {
    const token = mintSessionToken({ sid: SID, exp: NOW_MS }, KEY);
    expect(verifySessionToken(token, KEY, NOW_MS)).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects an expired token", () => {
    const token = mintSessionToken({ sid: SID, exp: NOW_MS - 1 }, KEY);
    expect(verifySessionToken(token, KEY, NOW_MS)).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a tampered payload", () => {
    const token = mintSessionToken({ sid: SID, exp: EXP }, KEY);
    const [version, payload, sig] = token.split(".");
    const tampered = `${version}.${flipFirstByte(payload)}.${sig}`;
    expect(verifySessionToken(tampered, KEY, NOW_MS)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a tampered signature", () => {
    const token = mintSessionToken({ sid: SID, exp: EXP }, KEY);
    const [version, payload, sig] = token.split(".");
    const tampered = `${version}.${payload}.${flipFirstByte(sig)}`;
    expect(verifySessionToken(tampered, KEY, NOW_MS)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a token signed with a different key", () => {
    const token = mintSessionToken({ sid: SID, exp: EXP }, KEY);
    const otherKey = new Uint8Array(32).fill(9);
    expect(verifySessionToken(token, otherKey, NOW_MS)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a token with the wrong number of parts as malformed", () => {
    const valid = mintSessionToken({ sid: SID, exp: EXP }, KEY);
    const [, payload, sig] = valid.split(".");
    for (const bad of [
      "v1",
      `v1.${payload}`,
      `v1.${payload}.${sig}.extra`,
      "",
    ]) {
      expect(verifySessionToken(bad, KEY, NOW_MS)).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("rejects an unsupported version before checking the signature", () => {
    const token = buildToken({ version: "v2" });
    expect(verifySessionToken(token, KEY, NOW_MS)).toEqual({
      ok: false,
      reason: "unsupported_version",
    });
  });

  it("rejects a payload that is not valid base64url as malformed", () => {
    const payload = "%%%not base64url%%%";
    const message = `v1.${payload}`;
    const sig = b64url(createHmac("sha256", Buffer.from(KEY)).update(message, "utf8").digest());
    expect(verifySessionToken(`v1.${payload}.${sig}`, KEY, NOW_MS)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("rejects a payload that decodes but is not valid JSON as malformed", () => {
    const payload = b64url("not-json");
    const message = `v1.${payload}`;
    const sig = b64url(createHmac("sha256", Buffer.from(KEY)).update(message, "utf8").digest());
    expect(verifySessionToken(`v1.${payload}.${sig}`, KEY, NOW_MS)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("rejects a payload that is valid JSON but lacks the expected fields", () => {
    const payload = b64url(JSON.stringify({ v: 1, sid: SID }));
    const message = `v1.${payload}`;
    const sig = b64url(createHmac("sha256", Buffer.from(KEY)).update(message, "utf8").digest());
    expect(verifySessionToken(`v1.${payload}.${sig}`, KEY, NOW_MS)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("never throws, even on garbage input", () => {
    const key = new Uint8Array(32).fill(5);
    for (const token of ["", "v1", ".", "%not-base64%", "v1..sig", "v1.a.b.c.d"]) {
      expect(() => verifySessionToken(token, key, NOW_MS)).not.toThrow();
    }
  });

  it("rejects a valid token as expired when nowMs is not finite, so a broken clock fails closed", () => {
    const token = mintSessionToken({ sid: SID, exp: EXP }, KEY);
    for (const broken of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(verifySessionToken(token, KEY, broken)).toEqual({ ok: false, reason: "expired" });
    }
  });

  it("rejects correctly signed claims whose exp parses to Infinity as malformed", () => {
    // 1e999 is valid JSON syntax but overflows to Infinity when parsed. The
    // JSON is written by hand because JSON.stringify would emit null instead.
    const payload = b64url(`{"v":1,"sid":"${SID}","exp":1e999}`);
    const token = buildToken({ payload });
    expect(verifySessionToken(token, KEY, NOW_MS)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("rejects correctly signed claims with a string exp as malformed", () => {
    const payload = b64url(JSON.stringify({ v: 1, sid: SID, exp: String(EXP) }));
    const token = buildToken({ payload });
    expect(verifySessionToken(token, KEY, NOW_MS)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("rejects a signature that differs from the canonical one only in its padding bits", () => {
    const token = mintSessionToken({ sid: SID, exp: EXP }, KEY);
    const [version, payload, sig] = token.split(".");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    // The 32-byte HMAC encodes to 43 base64url characters and the last one
    // carries two unused bits, so flipping the low bit of its index decodes
    // to the exact same HMAC bytes.
    const variant = `${sig.slice(0, -1)}${alphabet[alphabet.indexOf(sig[sig.length - 1]) ^ 1]}`;
    expect(Buffer.from(variant, "base64url")).toEqual(Buffer.from(sig, "base64url"));
    expect(verifySessionToken(`${version}.${payload}.${variant}`, KEY, NOW_MS)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });
});
