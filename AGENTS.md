# AGENTS.md

Rules for coding agents working in this repository. Read this file and your task card before you change anything.

## The project

A Telnyx AI voice assistant for Duinvezel, a fictional fiber ISP. It runs on Telnyx Edge Compute (Functions, KV, Stateful Actors) with a custom MCP server. Start with these documents.

- `docs/ARCHITECTURE.md` describes the components, data contracts and security model.
- `docs/DECISIONS.md` explains why things are the way they are. Do not contradict an accepted decision. If a card seems to require it, stop and ask.
- `docs/WORKFLOW.md` defines the conversation workflow and the dynamic variables.
- `tasks/` holds the task cards. Work on exactly one card at a time.

## Golden rules

1. Change only the files your card lists. If you need another file, say so in your report instead of editing it.
2. Run `npm run check` before you finish. It must pass. Fix the cause of a failure, never weaken or delete a test to make it pass.
3. Never run `git commit`, `git push`, `telnyx-edge ship` or `telnyx-edge secrets`. A human does those.
4. Never put secrets, keys or tokens in code, tests, fixtures or logs. Tests generate their own keys.
5. Do not add dependencies unless the card allows them. The allowed baseline is `@telnyx/edge-runtime`, `zod`, `typescript`, `vitest` and `@types/node`.
6. If the card is ambiguous or conflicts with the docs, stop and put the question in your report. Do not guess.

## Stack

- TypeScript with `strict` on, ES modules, Node built-ins only through the `node:` prefix.
- Edge Functions use the fetch-handler shape, `export default { async fetch(req: Request, env: Env) }`, with an umbrella `telnyx.toml` per function.
- `zod` validates every external input (webhook bodies, MCP arguments, KV values read back).
- `vitest` for tests.

## Layout

```text
packages/shared/      shared code (logging, timing, crypto, signatures, KV keys, types)
  src/
  test/
functions/
  voice-context/      call setup webhook and Route call tool webhook
  voice-tools/        MCP server, owner of the actor classes
  mock-crm/           fake ISP back office
    src/
      index.ts        fetch handler and routing only
      routes/         one file per route
      domain/         pure business logic, no I/O
      actors/         thin actor adapters (voice-tools only)
    test/
assistant/            assistant config and workflow builder (T11)
scripts/              provisioning, flags, simulations
infra/ids.json        platform ids (functions, KV namespace, assistant)
spikes/               throwaway experiments (S3, S4)
tools/                run harness for task cards (card.sh), not part of the solution
docs/  tasks/
```

## Conventions

- **Domain logic is pure.** Functions in `src/domain/` take state and input and return new state and output. They never read the clock (pass `nowMs` in), never do I/O and never throw for expected outcomes. Return a result object instead.
- **Actors are thin adapters.** An actor method loads its state, calls the domain function, saves the result, sets or clears its alarm and returns. All rules live in the domain function and are unit-tested there.
- **Routing is strict.** Each function matches exact method and path pairs. Anything else returns 404 before any KV or actor access. Authentication (signature, bearer token or internal key) runs before any state access.
- **KV keys** come only from `packages/shared/src/kv-keys.ts`. Keys allow `a-z A-Z 0-9 - _ / = .` only, so never put `+` or `:` in a key.
- **Logging** goes through `packages/shared/src/log.ts`. Each request produces one JSON line at the end, using the field names in `docs/ARCHITECTURE.md` (Observability). Mask phone and account numbers with the helpers. Never log tokens, keys, signatures or full request bodies.
- **Timing.** Wrap every KV, actor and HTTP call in the timing helper, so the request log line carries `latency_ms` per hop.
- **Timeouts.** Every outbound call has an explicit timeout below the remaining budget. On a timeout, degrade as the card says. Never let a request run into the platform's 30-second limit.
- **Idempotency.** Anything that creates a record takes a dedupe key (ADR-015).
- **Booleans for dynamic variables** are the strings `"true"` and `"false"`.

## Platform facts that are easy to get wrong

- The dynamic variables webhook response must nest values under `dynamic_variables`. A flat object is silently ignored.
- Telnyx signs webhooks with Ed25519. The signature is in `telnyx-signature-ed25519`, the timestamp in `telnyx-timestamp`, and the signed message is `{timestamp}|{raw body}`. Verify against the raw body text, before parsing JSON.
- The org public key comes from `GET /v2/public_key`, in the field `data.public` (not `data.public_key`).
- Encrypted dynamic variables use AES-256-GCM. The value is base64url of a 12-byte nonce, then the ciphertext, then the 16-byte tag, with no associated data.
- KV has no transactions or compare-and-swap. Never build a counter or a lock on KV. Use an actor.
- Actors run one call at a time per instance name. Writes are durable when a method returns. Instance fields are only a cache and disappear on restart, so keep state in `this.ctx.storage`.
- An actor has one alarm. `setAlarm` takes milliseconds since the epoch and replaces any earlier alarm. Alarm handlers can run more than once, so make them idempotent. `deleteAll()` does not clear the alarm.
- Actor method calls go through a stub, `env.BINDING.idFromName(name).method(args)`. Arguments and results must be plain JSON-serialisable data.
- Actor methods have a 30-second budget, and alarm handlers 15 minutes.

## Tests

- Unit-test every domain function, including the failure and edge cases the card lists.
- Use the fakes in `packages/shared/test/fakes/` for KV, actor storage and the clock. Do not call real Telnyx services from tests.
- Tests must be deterministic. Inject time and randomness.

## Commands

```bash
npm install                       # once, at the repo root
npm run check                     # typecheck everything, then run all tests
npx vitest run <pattern>          # run some tests
cd functions/<name> && telnyx-edge dev    # run a function and its actors locally
telnyx-edge logs <name> --tail --json     # live logs of a deployed function
```

## Your report

Finish every task with a short report under four headings, Changes, Tests, Deviations and Questions. Under Deviations, list anything you did differently from the card and why. Keep it factual.
