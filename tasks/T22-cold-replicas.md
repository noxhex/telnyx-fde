# T22. Calls that survive a replica's first use

**Phase** 2 · **Depends on** T20 · **Code by** implementer agent

## Goal

A call works even when it reaches replicas that have never read their secrets. On 13 October Thiago's first call was not recognised, and on his second `verify_account` failed (DEBUGLOG issue 17). Each replica reads a secret on first use, and that took 0.55 to over 1.0 s. mock-crm's replica also waits up to 1,000 ms for its reads on its first keyed request (T20). One CRM call can meet two of these first uses in a row, the caller's `INTERNAL_KEY` read and mock-crm's read window, about 1.7 s together. The bounds were 1,000 ms for voice-context's secret read and 1,500 ms for both CRM calls. Requests spread over several replicas per function, so first uses keep coming long after a ship.

This card does two things for voice-context and voice-tools. Every read starts on a replica's first request of any kind, as mock-crm's have since T20. The CRM bounds then cover two first uses in a row. Thiago decided on 13 October that the review calls must not depend on warm replicas.

## Read first

- `DEBUGLOG.md`, issues 15 and 17.
- `docs/ARCHITECTURE.md`, Call setup latency budget, and `docs/DECISIONS.md`, ADR-014 with its status line of 12 October.
- `functions/mock-crm/src/index.ts`, `createSecretStore` and `WarmBox`. Copy that pattern.
- voice-context, `src/index.ts`, `src/config.ts`, `src/routes/dv.ts` and `src/clients/crm.ts`.
- voice-tools, `src/index.ts`, `src/config.ts`, `src/clients/crm.ts` and `src/mcp/tools/verify-account.ts`.
- `AGENTS.md`, all of it.

## Files

- voice-context, `src/index.ts`, `src/config.ts`, `src/routes/dv.ts`, `src/clients/crm.ts` and the tests in `functions/voice-context/test/`.
- voice-tools, `src/index.ts`, `src/config.ts`, `src/clients/crm.ts` and the tests in `functions/voice-tools/test/`.

No new dependency. Leave mock-crm and `packages/shared` alone. Each function keeps its own secret store, as mock-crm does.

## 1. Every read starts on a replica's first request

- **voice-context.** On a replica's first request of any kind, start the reads of `TELNYX_PUBLIC_KEY`, `MCP_TOKEN_KEY`, `MCP_ENC_KEY` and `INTERNAL_KEY`, and call `start()` on the flags value. This includes unknown paths and requests that fail authentication.
- **voice-tools.** Do the same for `MCP_TOKEN_KEY` and `INTERNAL_KEY` and the flags value.
- **No waiting.** The request that starts these reads does not wait for them. The reads start once per replica, and nothing changes state before authentication.
- **One read at a time.** A request that needs a secret while its read is running waits for that read. It never starts a second one.
- **What the store keeps.** A success is kept for the life of the replica, including a success that lands after a request stopped waiting. A failed or empty read is not kept, so the next use reads again.

## 2. Bounds that cover two first uses in a row

- **voice-context's internal key.** `INTERNAL_KEY` is read for the CRM lookup. That read is no longer cut at `SECRET_READ_TIMEOUT_MS`, and it counts against the lookup's own bound instead.
- **voice-context's other bounds.**
  - `crmLookupMs` goes from 1,500 to 2,000 ms. That still leaves 1,000 ms of the 3,000 ms soft budget for `Session.create` in step 7.
  - `areaStatusMs` goes from 1,500 to 2,000 ms, because KV reads took 1,083 to 1,639 ms on 13 October.
  - `SECRET_READ_TIMEOUT_MS` stays 1,000 ms for the public key and the two token keys. `SOFT_BUDGET_MS` and the webhook timeout stay too.
- **voice-tools.**
  - `crmAccountMs` goes from 1,500 to 2,500 ms. It includes voice-tools' own `INTERNAL_KEY` read inside `getAccount`.
  - `areaStatusMs` goes from 1,500 to 2,000 ms.
  - A cold `verify_account` should then take about 3 s. That is up to 1.7 s for the account, 0.1 to 0.4 s of actor calls and about 1.1 s for the area status.

Telnyx does not document a timeout for MCP tool calls. A shared webhook tool's default is 5,000 ms (DEBUGLOG, S2 findings).

## 3. A caller number too short to look up

- **No lookup.** When the caller's digits are fewer than eight, `/dv` makes no CRM lookup and touches no `crm/phone/` key. The caller is anonymous, as when there is no phone at all. On 13 October a browser test call arrived with channel `phone_call` and a caller with fewer than six digits. mock-crm answered 404 for it, and voice-context cached that as not found (issue 17).
- **The channel in the log.** The `dv` log line gets a `channel` field holding `telnyx_conversation_channel` as received, cut to 32 characters.

## Tests

- **The first request.** For each function, the first request of any kind starts every read and the flags value once. An unknown path and a wrong signature or key both count. A second request starts none.
- **Joining a read.** A request that needs a secret during the first request's reads joins the read in flight. The test holds one read and two waiters.
- **What is kept.** A failed read is tried again on next use, and a late success is kept.
- **voice-context's lookup.** Hold `INTERNAL_KEY` until 1,200 ms and mock-crm's answer until 600 ms after that, and the caller is identified. Before this card that was `crm_error`. Test the 2,000 ms bound at its boundary.
- **voice-tools' account fetch.** Hold the key until 650 ms and mock-crm until 1,050 ms after that, and `verify_account` passes. Test the 2,500 ms bound at its boundary.
- **The area bounds.** Test both 2,000 ms area bounds at their boundary.
- **A short caller number.** A caller with seven digits gets no lookup and no `crm/phone/` key, and the `dv` line carries `channel`. Eight digits do get a lookup.

## Acceptance

- [ ] `npm run check` passes.
- [ ] Thiago ships voice-context and voice-tools with `--timeout 15m`. A phone call from `DEMO_CALLER_PHONE` without a warm-up greets him by name, `verify_account` passes, and the `dv` line shows the channel.

## Out of scope

- mock-crm, whose read window from T20 stays.
- The soft budget, the bounds of the public key and token key reads, and the webhook timeout.
- The warm-up script (T14).
