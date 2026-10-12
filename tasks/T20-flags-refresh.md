# T20. Flags that refresh in the background, and mock-crm's first request

**Phase** 2 · **Depends on** T10, and runs after T11 · **Code by** implementer agent

## Goal

The feature flags apply on the deployed functions, and only a container's first requests wait for KV. Today a KV read takes longer than the 1,000 ms all three functions give their flags read (DEBUGLOG issue 15). So `crm_fail`, `crm_delay_ms`, `dv_force_error`, `diagnostics_enabled` and the incident flags never apply, and a refresh can add a second to a request. mock-crm also reads its two secrets and its flags one after another on a new container, so its first keyed lookup took 2,174 ms, above voice-context's 1,500 ms CRM timeout. Thiago decided the behaviour below on 12 October.

## Read first

- `DEBUGLOG.md`, issues 11, 14 and 15, and the T10 measurements.
- `docs/ARCHITECTURE.md`, Call setup latency budget, and `docs/DECISIONS.md`, ADR-014 and ADR-019 with their status lines of 12 October.
- The flags reads as they are, `functions/mock-crm/src/flags.ts` and `src/index.ts`, `readFlags` in `functions/voice-context/src/routes/dv.ts`, and `functions/voice-tools/src/flags.ts`.
- `packages/shared/src/memory-cache.ts`, for the conventions of the shared caches.
- `AGENTS.md`, all of it.

## Files

- `packages/shared/src/refreshing-value.ts` (new), its export from `packages/shared/src/index.ts`, and `packages/shared/test/refreshing-value.test.ts`.
- mock-crm, `src/index.ts`, `src/flags.ts`, `src/routes/customers.ts` and the tests in `functions/mock-crm/test/`.
- voice-context, `src/routes/dv.ts`, `src/deps.ts`, `src/index.ts`, `src/config.ts` and the tests in `functions/voice-context/test/`.
- voice-tools, `src/flags.ts`, `src/deps.ts`, `src/index.ts`, `src/mcp/tools/report-outage.ts` and the tests in `functions/voice-tools/test/`.

No new dependency.

## 1. A value that refreshes in the background

`createRefreshingValue` in `packages/shared` holds one value read from KV for the life of a container. Each function makes one for its flags at module scope, next to its other caches, and each test makes a fresh one.

It takes `read`, which resolves with the parsed value or rejects, `lifetimeMs`, `fallback`, `now`, a timeout runner, and an optional `onSettled`.

- **The last good value.** A read that resolves is a successful read. Its value becomes the last good value, stamped with the time it settled. A read that rejects changes nothing.
- **`get(waitMs)`.** With a last good value, `get` returns it at once and never waits. If the value's age has reached `lifetimeMs` and no read is in flight, it first starts one in the background. Without a last good value, `get` starts a read if none is in flight, then waits for the read in flight for at most `waitMs`. It returns that read's value if it succeeds in time, else `fallback`. The fallback is never stored.
- **One read at a time.** At most one read is in flight, and every caller that needs it shares it. A read that has not settled `lifetimeMs` after it started no longer counts as in flight, so the next `get` may start another.
- **A late success counts.** A read that succeeds after its waiter gave up still becomes the last good value. A value never replaces one from a read that started later.
- **`start()`.** Starts a read when there is no last good value and none in flight, and returns at once.
- **`onSettled`.** Called once for every read that settles, with `outcome` `"ok"` or `"error"` and the read's duration in ms.
- **Time fails closed.** While `now()` is not finite, `get` behaves as if there were no last good value, and a read that settles then is not stored, as in the memory cache.

## 2. The flags in all three functions

- mock-crm, voice-context and voice-tools read `flags/global` through one refreshing value per container, with `lifetimeMs` 10,000, their current cache lifetime, and `waitMs` 1,000, their current bound. voice-context still cuts the wait to what remains of its soft budget.
- Each function's parser stays as it is, with a default for each missing or invalid flag. A missing key is an answer, so its value is the defaults the parser gives, and it becomes the last good value like any other answer. Only a timeout or a KV error is a failed read.
- A request that answers from the last good value waits for nothing. The `kv` hop on its log line times only what the request itself waited.
- The behaviour a caller notices is that a changed flag applies within about one lifetime plus one KV read, and that only a container's first requests can wait for KV.

## 3. mock-crm's first request

- On a container's first request of any kind, unknown paths and `/healthz` included, mock-crm starts its `INTERNAL_KEY` read, its `DEMO_CALLER_PHONE` read and its flags read together. That request does not wait for them unless its route needs them, so an unknown path still answers 404 at once and `/healthz` 200. This is the one exception to ADR-014 (its status line of 12 October). The reads change no state and happen once per container.
- The secret reads become shared too. A request that needs a secret while that secret's read is in flight waits for that read instead of starting another. Kept values and failed reads otherwise behave as the T10 follow-up made them. A success is kept for the container's life, and a timeout, an error or an empty value is not kept, so a later request reads again.
- A keyed request waits for what it needs within one window of 1,000 ms, which opens when it first waits for a read. Each of its waits ends when its read settles or the window closes. So the first keyed lookup on a new container waits for the slowest of its reads, not their sum, and never more than 1,000 ms in all.
- The order of use stays. The `INTERNAL_KEY` check comes first, and a missing or wrong key answers 401 without waiting for anything else. The flags apply after the check, and `DEMO_CALLER_PHONE` is used only on `/customers`.

## 4. An unreadable `DEMO_CALLER_PHONE` answers 503

On `/customers`, when the digits match no fixture account and `DEMO_CALLER_PHONE` could not be read (a timeout, an error, or an empty or missing value), mock-crm answers 503 `{ "error": "unavailable" }`, the answer `crm_fail` gives, instead of 404. voice-context treats a 503 as a failed lookup, so it caches no "not found" for what may be the demo number. Digits that match a fixture account still answer 200, and a malformed query still answers 404.

## 5. Logging

Each function writes one `flags_read` line through its logger for every flags read that settles, from `onSettled`, with `outcome` and `latency_ms` `{ total, kv }`. So the logs show how long reads take and whether background refreshes succeed, even when no request waited for them.

## Tests

Use held promises, a manual timeout runner and a manual clock, never real time (AGENTS.md, Tests). Keep every existing test unless a point above changes what it checks, and change such a test rather than delete it. The tests that pin today's behaviour, defaults cached after a timeout in mock-crm and nothing cached after a timeout or a missing key in voice-context and voice-tools, change to the new behaviour.

- **The refreshing value.**
  - A first `get` that the read answers in time returns its value. One still pending at `waitMs` returns the fallback, and when that read succeeds later the next `get` returns its value without a new read.
  - After a first read that timed out and then rejected, the next `get` starts a new read. The fallback is never returned once a value exists.
  - With a last good value, `get` never waits, also while a refresh it started never settles. No read starts at an age of `lifetimeMs` minus 1, one starts at exactly `lifetimeMs`, and a second `get` before it settles starts none.
  - Two callers without a value share one read, so `read` is called once.
  - A read in flight for `lifetimeMs` minus 1 still blocks a new one, and one in flight for exactly `lifetimeMs` does not.
  - When an older read settles after a newer one, the newer value stays.
  - A refresh that rejects keeps the old value, and the next `get` starts another read.
  - `start()` starts one read, and does nothing when a value or a read exists.
  - `onSettled` is called once per read with its outcome and duration.
  - A non-finite clock, as in point 1.
- **mock-crm.**
  - A flags document read after 1,000 ms applies on the next request, and `crm_fail` and `crm_delay_ms` apply from the last good value.
  - A lookup after the lifetime answers at once with the old flags and starts one read.
  - The first request of a container, an unknown path and `/healthz` in turn, starts the three reads once and answers without waiting. A keyed request while they are in flight joins them, so each read runs once.
  - The first keyed lookup, with `INTERNAL_KEY` settling at 600 ms, `DEMO_CALLER_PHONE` at 800 ms and the flags at 1,100 ms, answers when the 1,000 ms window closes, with both secrets and the default flags. The flags read's late success applies to the next request.
  - A wrong key answers 401 without waiting for the flags.
  - An unknown number with `DEMO_CALLER_PHONE` timed out answers 503, a fixture number in the same state answers 200, and an unknown number with `DEMO_CALLER_PHONE` read answers 404.
  - One test drives the real `default.fetch` across two requests with a fake env, so a refreshing value or a secret store made per request instead of per container fails (the cleanup item "T10 follow-up, the production box").
- **voice-context.** `/dv` with a last good value does not wait for KV, also while the refresh never settles. The first `/dv` still cuts its flags wait to the soft budget. `dv_force_error` from a late success applies to the next call.
- **voice-tools.** `report_outage` uses the flags from a late success on its next call, and with a last good value a tool call never waits for KV.
- **Logging.** Each function writes one `flags_read` line per settled read, with its outcome, and none while no read runs.

## Acceptance

- [ ] `npm run check` passes.
- [ ] Thiago ships all three functions with `--timeout 15m` and runs the timing for mock-crm and voice-context again. mock-crm's first keyed lookup on a container takes at most about 1,000 ms on the server, its log shows `flags_read` lines with `ok`, and voice-context's health shows no CRM check near a second after the first call.

## Out of scope

- The area status caches. They keep their 1,500 ms bound and their read on a miss, because the one measured read took 1,149 ms (DEBUGLOG issue 15) and a stale area status would delay an outage notice.
- mock-crm's digits-only `phone` query. voice-context strips every non-digit from the caller's number before the lookup (`dv.ts`, step 3), so a plus never reaches mock-crm.
- The CRM timeouts, which stay at 1,500 ms (`docs/ARCHITECTURE.md`, Call setup latency budget).
- The secret reads of voice-context and voice-tools.
