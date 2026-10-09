# T03. Telnyx webhook signature verifier

**Phase** 1 · **Depends on** T01 · **Bake-off task**, so implement the code and the tests together

## Goal

Verify that a webhook really comes from Telnyx before any of our code trusts it. This guards the dynamic variables webhook and every webhook tool.

## Read first

- `AGENTS.md`, section Platform facts (signature format, public key field).
- `docs/ARCHITECTURE.md`, section Security model.

## Files

- `packages/shared/src/telnyx-signature.ts` (new), exported from `src/index.ts`.
- `packages/shared/test/telnyx-signature.test.ts` (new).

## Interface

```ts
export type SignatureCheck =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "missing_headers"
        | "bad_timestamp"
        | "stale_timestamp"
        | "bad_signature_encoding"
        | "bad_public_key"
        | "invalid_signature";
    };

export function verifyTelnyxSignature(input: {
  rawBody: string;              // the request body exactly as received
  signature: string | null;     // header telnyx-signature-ed25519, base64
  timestamp: string | null;     // header telnyx-timestamp, Unix seconds
  publicKey: string;            // org key from GET /v2/public_key (data.public), base64
  nowMs: number;
  maxSkewSec?: number;          // default 300
}): SignatureCheck;
```

## Behaviour

- The signed message is the UTF-8 bytes of `` `${timestamp}|${rawBody}` ``.
- Use `node:crypto`. Build the public key with `createPublicKey` from a DER SPKI buffer, which is the fixed prefix `302a300506032b6570032100` (hex) followed by the 32 raw key bytes, then call `verify(null, message, key, signature)`.
- Check in this order and return the first failure.
  1. A missing or empty signature or timestamp gives `missing_headers`.
  2. A timestamp that is not a whole number of seconds gives `bad_timestamp`.
  3. A timestamp more than `maxSkewSec` from `nowMs`, in either direction, gives `stale_timestamp`. A `nowMs` or `maxSkewSec` that is not a finite number gives `stale_timestamp` too, so a broken clock fails closed.
  4. A public key that does not decode to exactly 32 bytes gives `bad_public_key`.
  5. A signature that does not decode to exactly 64 bytes gives `bad_signature_encoding`.
  6. A signature that fails verification gives `invalid_signature`.
- Never throw. Any unexpected error becomes `invalid_signature`.
- The function never logs anything.

## Tests

Generate an Ed25519 key pair inside the test with `generateKeyPairSync("ed25519")`. Get the raw public key from the SPKI DER export (the last 32 bytes), sign test messages with `sign(null, ...)`, and base64-encode both.

## Acceptance

- [ ] `npm run check` passes.
- [ ] One test per outcome. Valid signature, tampered body, signature from a different key, timestamp too old, timestamp too far in the future, missing signature, missing timestamp, non-numeric timestamp, public key of the wrong length, signature of the wrong length, and signature that is not base64.
- [ ] A body containing non-ASCII characters (for example `"Café à Veurne €"`) verifies correctly.
- [ ] A `nowMs` or `maxSkewSec` that is `NaN` or infinite gives `stale_timestamp`.
- [ ] No key material is hard-coded in the repo.

## Out of scope

Fetching the public key from Telnyx, HTTP handling, logging.
