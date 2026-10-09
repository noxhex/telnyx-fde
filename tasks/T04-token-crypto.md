# T04. Session tokens and Telnyx encryption

**Phase** 1 · **Depends on** T01

## Goal

Mint and check the per-call token the MCP server receives as its bearer token (ADR-008), and encrypt it the way Telnyx expects for `encrypted_dynamic_variables`.

## Read first

- `docs/DECISIONS.md`, ADR-008.
- `AGENTS.md`, section Platform facts (encryption format).

## Files

- `packages/shared/src/session-token.ts` and `packages/shared/src/telnyx-encrypt.ts` (new), exported from `src/index.ts`.
- `packages/shared/test/session-token.test.ts` and `packages/shared/test/telnyx-encrypt.test.ts` (new).

## Interface

```ts
// session-token.ts
export interface SessionClaims { v: 1; sid: string; exp: number }   // exp in ms since epoch
export type TokenCheck =
  | { ok: true; claims: SessionClaims }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "unsupported_version" };

export function mintSessionToken(claims: { sid: string; exp: number }, hmacKey: Uint8Array): string;
export function verifySessionToken(token: string, hmacKey: Uint8Array, nowMs: number): TokenCheck;

// telnyx-encrypt.ts
export function parseKey(base64url: string): Uint8Array;
export function encryptForTelnyx(
  plaintext: string,
  key: Uint8Array,
  randomBytes?: (n: number) => Uint8Array,
): string;
export function decryptForTests(value: string, key: Uint8Array): string;
```

## Behaviour

- **Token format.** `v1.<base64url(JSON claims)>.<base64url(HMAC-SHA256 over "v1." + payload part)>`, with no padding.
- **Verification.** Split into exactly three parts, check the version prefix, recompute the HMAC and compare with `timingSafeEqual`, then check `exp`. A token whose `exp` is at or before `nowMs` is expired, and so is any token when `nowMs` is not a finite number, so a broken clock fails closed. Claims need `v` 1, a string `sid` and a finite numeric `exp`, or the token is `malformed`. Only the canonical unpadded encoding of the signature verifies. Never throw. Any parse problem is `malformed`.
- **Keys.** `parseKey` accepts base64url with or without `=` padding and throws unless the result is exactly 32 bytes.
- **Encryption.** `encryptForTelnyx` returns base64url of a 12-byte random nonce, then the AES-256-GCM ciphertext, then the 16-byte tag, with no associated data. It throws if the plaintext is over 8192 bytes.
- `decryptForTests` reverses it and throws on a wrong key or tampered data. It exists only for tests and spikes, so leave it out of production code paths.

## Acceptance

- [ ] `npm run check` passes.
- [ ] Token tests cover a valid token, a tampered payload, a tampered signature, an expired token, the wrong number of parts, an unsupported version, bad base64, a `nowMs` that is `NaN` or infinite, an `exp` that is not finite, and a signature that differs from the canonical one only in its padding bits.
- [ ] Encryption tests cover a round trip, a wrong key, one flipped byte anywhere in the value, a plaintext over 8192 bytes, key parsing with and without padding, and a key of the wrong length.
- [ ] A fixed `randomBytes` in one test gives a deterministic output, so the format is pinned.

## Out of scope

Storing keys, calling Telnyx.
