# T24. Call setup inside the webhook timeout

**Phase** 2 · **Depends on** T22 · **Code by** implementer agent

## Goal

`/dv` answers inside the assistant's 4,000 ms webhook timeout on a fresh replica while KV is slow, and it accepts a caller whose number is withheld. Today a call can lose its token in three ways, listed below. When `/dv` answers late or answers an error, Telnyx uses the variable defaults, so `session_ok` stays `"false"`, the call goes to Degraded and it has no MCP token (`docs/ARCHITECTURE.md`, Failure modes). Only voice-context changes, so only voice-context needs a ship.

## Evidence, 14 October

- KV was about twice as slow as on 13 October. voice-context's health check KV probe, a put and then a get, took 3,981 and 3,797 ms at 06:45 and 06:50 UTC. In the two browser calls at 06:27 and 06:32 UTC, the five area reads in `/dv` ran into their 2,000 ms bound. Their `dv` lines show `total` 2,014 and 2,888 ms, with `kv` 9,013 and 9,577 ms summed over the reads.
- On a fresh replica the secret reads cost the second call 890 ms (`http` in its `dv` line). Secret reads on fresh replicas have taken more than 1,000 ms. That happened to voice-context's `INTERNAL_KEY` on 13 October (DEBUGLOG issue 17) and to voice-tools' `MCP_TOKEN_KEY` at 06:27:54 UTC today, an `auth_failed` line with reason `secret_error` and `http` 1000.

## The three ways a call loses its token

1. **The public key read is cut at 1,000 ms** (`SECRET_READ_TIMEOUT_MS`). On a fresh replica it can take longer, and `/dv` then answers 403 `no_key`.
2. **The 3,000 ms soft budget starts after the signature check.** A phone call whose caller mock-crm answered waits for the CRM cache write in KV, which has a 2,500 ms bound cut by the budget. With this morning's KV a put took about 2.3 to 2.5 s, so the write ends near the end of the budget, and at its end when mock-crm is cold. On a fresh replica that adds up to 1,000 ms for the key, so the answer takes 3.5 to 4.0 s of server time before the network, and 4,000 ms is the webhook timeout itself.
3. **A withheld caller number.** The payload schema requires `telnyx_end_user_target` to be a string, and `telnyx_end_user_target_verified` to be a boolean when present. We have never seen what Telnyx sends for a withheld number. If the target is missing or null, or the flag is null, `/dv` answers 400.

The same slow KV can also cost a known caller the outage notice. When the caller's area read runs out, `/dv` answers `area_outage` `"false"` with the reason `area_unknown`.

## Keep the session small

This card has a budget. Thiago asked for small cards and lean sessions on 13 October.

- Read `functions/voice-context/src/routes/dv.ts`, `functions/voice-context/src/config.ts`, and in `functions/voice-context/src/routes/disclosure.ts` only `readSecretTimed`, `readSecretKeyTimed` and `verifySignedRequest`.
- In `functions/voice-context/test/dv.test.ts`, find the tests to change or copy by searching for `SOFT_BUDGET_MS`, `SECRET_READ_TIMEOUT_MS`, `areaStatusMs`, `no_key` and `telnyx_end_user_target`. You do not need to read the whole file.
- Plan briefly. Run `npx vitest run functions/voice-context` while you work, and `npm run check` once at the end.
- Do not run `telnyx-edge dev`.

## Files

- `functions/voice-context/src/routes/dv.ts`
- `functions/voice-context/src/config.ts`
- `functions/voice-context/src/routes/disclosure.ts`, only if a helper needs a bound passed in
- `functions/voice-context/test/dv.test.ts`, and any other voice-context test that pins one of the old values

Change no other file.

## Changes

1. **One deadline from arrival.** The soft budget, still `SOFT_BUDGET_MS` at 3,000 ms, starts when `handleDv` starts, before the body read and the signature check. The two token key reads are cut to what remains of it, like every other wait in `/dv` already is. So `/dv` answers within 3,000 ms of server time plus CPU, whatever a replica's first reads cost. Whatever runs out degrades the way it does now.
2. **Secret reads wait up to 2,000 ms.** `SECRET_READ_TIMEOUT_MS` goes from 1,000 to 2,000 ms, on every voice-context route. The public key read comes first, so it always fits in the budget. A read that runs out still fails closed, with 403 `no_key` for the public key and 500 `secret_error` for a token key.
3. **Area reads get 2,500 ms.** `TIMEOUTS.areaStatusMs` goes from 2,000 to 2,500 ms, still cut to what remains of the budget.
4. **A withheld caller.** `telnyx_end_user_target` may be missing, null or any string, and `telnyx_end_user_target_verified` may be missing or null. A missing or null target is handled exactly like a caller with fewer than eight digits. That means anonymous, no lookup, no mock-crm call, no `crm/phone/` key, and no `callerPhone` in the session. The log's `caller` is then null. A null `telnyx_end_user_target_verified` counts as false. A string target keeps today's behaviour.
5. **The CRM cache write never holds the answer.** Thiago decided this on 14 October. Once the lookup has its result, nothing in the answer waits on KV. When mock-crm answered, `/dv` starts the cache write as it does now, and answers without waiting for it. The area reads still count, because the outage notice needs them. They start together with the lookup and keep their own bound. The write keeps its 2,500 ms bound, no longer cut by the budget. When it settles it writes its own log line, with event `crm_cache_write`, the call's `trace_id`, an `outcome` of `ok`, `failed` or `timeout`, and `latency_ms`. The `dv` line's `cache_write` field reads `started` when a write started, and stays out otherwise. A failing write can never reject anything or surface as an unhandled rejection.
6. **Comments.** Update the doc comments that state the old values, the old budget start or the awaited cache write, in `dv.ts` (the header's steps 4, 6/7 and 8) and `config.ts`.

## Tests

Follow the rules in AGENTS.md, with each bound tested at the limit and just past it, and a late settlement after each timeout.

- The budget starts at arrival. With a public key read that settles at 1,200 ms, a dependency still pending at 3,000 ms after arrival is answered as its failure reason, at 3,000 ms and not later. The same dependency settling just inside the deadline is used.
- A public key read that settles at the 2,000 ms bound passes the signature check. One still pending at the bound answers 403 `no_key`, and its late settlement changes nothing.
- A token key read still pending when the budget runs out answers 500 `secret_error` at the deadline, not 2,000 ms after the read started.
- An area read that settles within 2,500 ms is used. One still pending at the bound leaves the area unknown, with `area_unknown` for a known caller in that area.
- With mock-crm answering and the KV put held pending, `/dv` answers 200 with its token before the put settles, and the `dv` line has `cache_write` `started`. When the held put then resolves, one `crm_cache_write` line follows with outcome `ok`. A put still pending at 2,500 ms logs `timeout`, and its late settlement logs nothing more. A rejected put logs `failed`. An answer from memory or KV, or a failed lookup, starts no write.
- Three payloads answer 200 with a token and `identity_level` `"anonymous"`, with no mock-crm call and no `crm/phone/` read or write. One has `telnyx_end_user_target` null, one has it missing, and one has `telnyx_end_user_target_verified` null next to an anonymous target.
- Tests that pinned the old start of the budget or the old numbers change with them. Do not delete, skip or loosen any other test. Name every changed test in your report.

## Acceptance

- [ ] `npm run check` passes, and the test count grows only by the new tests.
- [ ] Claude Code's review breaks the change on purpose and a test fails each time. The mutations are the budget starting after the signature check again, a 1,000 ms secret bound, uncut token key reads, a 2,000 ms area bound, a schema that rejects a null target, and an answer that waits for the cache write again.

## Out of scope

- voice-tools. Its MCP auth read keeps its 1,000 ms bound for now. A fresh replica answered one `tools/list` with 503 this morning, and Telnyx opened the session again four seconds later.
- The webhook timeout on the assistant, and mock-crm.
- What callers hear. Card T25 covers that.
