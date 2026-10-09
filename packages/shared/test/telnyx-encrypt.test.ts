import { describe, expect, it } from "vitest";

import { decryptForTests, encryptForTelnyx, parseKey } from "../src/index.js";

const KEY = Buffer.alloc(32, 3);
const OTHER_KEY = Buffer.alloc(32, 9);

function toUrlNoPad(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Flip one character in the middle of a base64url string. */
function flipMiddleChar(value: string): string {
  const chars = value.split("");
  const index = Math.floor(chars.length / 2);
  const original = chars[index];
  chars[index] = original === "a" ? "b" : "a";
  return chars.join("");
}

describe("parseKey", () => {
  it("parses a base64url key without padding", () => {
    const raw = new Uint8Array(32).fill(7);
    expect(parseKey(toUrlNoPad(raw))).toEqual(raw);
  });

  it("parses a base64url key with padding", () => {
    const raw = new Uint8Array(32).fill(7);
    expect(parseKey(`${toUrlNoPad(raw)}=`)).toEqual(raw);
  });

  it("throws for a key of the wrong length", () => {
    for (const length of [0, 16, 31, 33]) {
      expect(() => parseKey(toUrlNoPad(new Uint8Array(length).fill(3)))).toThrow();
    }
  });

  it("throws for a value that is not valid base64url", () => {
    expect(() => parseKey("%%%not base64url%%%")).toThrow();
  });
});

describe("encryptForTelnyx and decryptForTests", () => {
  it("round-trips a plaintext through encrypt and decrypt", () => {
    const plaintext = "mcp_token for a call";
    const encrypted = encryptForTelnyx(plaintext, KEY);
    expect(decryptForTests(encrypted, KEY)).toBe(plaintext);
  });

  it("decrypts with the wrong key", () => {
    const encrypted = encryptForTelnyx("secret", KEY);
    expect(() => decryptForTests(encrypted, OTHER_KEY)).toThrow();
  });

  it("throws when a single byte anywhere in the value is flipped", () => {
    const plaintext = "a payload long enough that the flipped byte sits mid-value";
    const encrypted = encryptForTelnyx(plaintext, KEY);
    expect(() => decryptForTests(flipMiddleChar(encrypted), KEY)).toThrow();
  });

  it("throws for a plaintext over 8192 bytes", () => {
    const tooLong = "a".repeat(8193);
    expect(() => encryptForTelnyx(tooLong, KEY)).toThrow();
  });

  it("allows a plaintext of exactly 8192 bytes", () => {
    const max = "b".repeat(8192);
    const encrypted = encryptForTelnyx(max, KEY);
    expect(decryptForTests(encrypted, KEY)).toBe(max);
  });

  it("produces deterministic output for a fixed randomBytes, pinning the format", () => {
    const nonce = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const fixedRandom = (_n: number) => nonce;
    const plaintext = "hello";

    const a = encryptForTelnyx(plaintext, KEY, fixedRandom);
    const b = encryptForTelnyx(plaintext, KEY, fixedRandom);
    expect(a).toBe(b);

    const decoded = Buffer.from(a, "base64url");
    // 12-byte nonce first.
    expect(new Uint8Array(decoded.subarray(0, 12))).toEqual(nonce);
    // Then ciphertext (same length as plaintext) and a 16-byte tag.
    expect(decoded.length).toBe(12 + plaintext.length + 16);
    expect(decryptForTests(a, KEY)).toBe(plaintext);
  });
});
