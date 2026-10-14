# Debug log

Every real problem, with the evidence that found it. Each entry gives the symptom, the evidence, the cause, the fix and what it changed in the design. New entries use the template at the end.

## 1. The Edge CLI install command from the brief returns 404

**Date** 9 Oct 2026 · **Area** tooling

**Symptom.** The install command in the challenge brief failed before anything was installed.

**Evidence.**

```text
$ curl -fsSL https://github.com/team-telnyx/edge-compute/releases/latest/download/telnyx-edge-linux-amd64.tar.gz | tar xz
curl: (22) The requested URL returned error: 404
gzip: stdin: unexpected end of file
```

**Cause.** Release assets now carry the version in their file name (`telnyx-edge-v0.5.9-linux-amd64.tar.gz`), so the unversioned "latest" download link no longer exists.

**Fix.** The Edge Compute quickstart's install resolves the latest tag first and downloads the versioned asset.

**Design impact.** None. Worth passing on as feedback on the brief.

## 2. Arch's OpenCode package is v2, and the Telnyx plugin is v1-only

**Date** 9 Oct 2026 · **Area** tooling

**Symptom.** `pacman -S opencode` offered `opencode-2.0.22`. The download failed on a stale mirror, which is how it got noticed before install.

**Evidence.**

```text
$ npm view @telnyx/opencode version dependencies
0.1.5
{ '@opencode-ai/plugin': '^1.2.27' }
```

OpenCode's v2 migration guide says v1 plugin implementations do not run in v2 and need porting. The brief's commands (`opencode plugin ...`, `opencode auth login --provider telnyx ...`) are v1 syntax.

**Cause.** The Telnyx plugin is built on the v1 plugin SDK, while distribution packages have moved to OpenCode v2.

**Fix.** Installed OpenCode 1.18.35 from npm, pinned, with `OPENCODE_DISABLE_AUTOUPDATE=true`. npm's newer default policy also blocked its postinstall script, which places the platform binary, so it was allowed for this package only after reading the script.

**Design impact.** ADR-018 pins the tool versions.

## 3. The first ship looked stuck

**Date** 9 Oct 2026 · **Area** Edge Compute

**Symptom.** `telnyx-edge ship` of the scaffolded actor project showed "Building your function" for more than six minutes.

**Evidence.**

```text
$ telnyx-edge ship status smoke --logs
✅ The function's latest build succeeded.
$ telnyx-edge deployments smoke
REVISION ID    SHIPPED AT           STATUS      BUILD
a688e84d44c2   Oct 9, 2026, 11:42   deploying   7m37s
$ time telnyx-edge ship
✅ Func 'smoke' is now deployed! (shipped in 11m25s)
```

**Cause.** Not stuck, only slow. About 7.5 minutes of build and 4 of deploy, against the 2 to 3 minutes the assistant backend guide suggests.

**Fix.** None needed. `ship status` and `deployments` show the real state when the CLI's progress display lags.

**Design impact.** ADR-016. Iterate locally with `telnyx-edge dev`, ship only at checkpoints, and record every ship time.

## 4. The counter skipped a number

**Date** 9 Oct 2026 · **Area** Edge Compute, observability

**Symptom.** Two calls to the sample actor returned 7 and 8, and the next call returned 10.

**Evidence.**

```text
$ telnyx-edge logs smoke --type invocations --since 10m --json | jq -c '.data[] | {timestamp, path, duration_ms}'
{"timestamp":"2026-10-09T11:54:41.664Z","path":"/","duration_ms":309.5}
{"timestamp":"2026-10-09T11:54:41.938Z","path":"/favicon.ico","duration_ms":146.4}
{"timestamp":"2026-10-09T11:58:15.052Z","path":"/","duration_ms":287.3}
{"timestamp":"2026-10-09T11:58:15.311Z","path":"/","duration_ms":146.3}
{"timestamp":"2026-10-09T11:58:52.856Z","path":"/","duration_ms":288.2}
{"timestamp":"2026-10-09T11:59:21.305Z","path":"/nope","duration_ms":155.1}
```

The request at 11:58:52 is the missing 9. A query at about 11:59:25 did not show it yet, and the platform records no client IP or user agent.

**Cause.** The sample changes actor state on every path. A browser's favicon request bumped the counter earlier, and the request at 11:58:52 came from an unknown visitor. New public URLs attract that kind of traffic quickly.

**Fix.** None for the throwaway sample. The lessons go into the real functions.

**Design impact.** ADR-014 (strict routing, authentication before state, our own log line with user agent and auth result) and ADR-017 (platform logs lag at least 30 seconds, so detection comes from our own signals).

**A likely source, 10 Oct 2026.** Thirteen seconds after a new version of `mcp-spike` started, at 20:18:08 UTC, a request from `Go-http-client/2.0` hit a path the spike does not serve and got a 404. That looks like a platform probe after a deploy, and may explain the unknown visitor at 11:58:52.

## 5. A KV namespace create timed out but had succeeded

**Date** 9 Oct 2026 · **Area** Edge Compute, KV

**Symptom.** Creating a namespace failed with a client timeout.

**Evidence.**

```text
$ telnyx-edge storage kv create --name fde-smoke
Error: ❌ Request timeout: POST request to https://api.telnyx.com/v2/storage/kvs is taking too long
$ telnyx-edge storage kv list
KV ID                                  NAME        STATUS         CREATED AT
be378fe6-fb1b-4d9e-bf65-540d5b97c2c9   fde-smoke   provision_ok   Oct 9, 2026, 12:02
```

**Cause.** The server finished provisioning after the CLI stopped waiting.

**Fix.** Checked the list before retrying, so no duplicate namespace was created.

**Design impact.** ADR-015. A timeout on a write is an unknown outcome, so every record-creating write takes a dedupe key, and Telnyx API creates send an `Idempotency-Key`.

**Second occurrence, 10 Oct 2026.** Thiago created the project namespace `duinvezel`, and the CLI timed out the same way while the create succeeded. The list shows one namespace of that name, so checking before a retry kept it from being created twice. Its id is in `infra/ids.json`.

```text
$ telnyx-edge storage kv list
KV ID                                  NAME        STATUS         CREATED AT
504d09fa-a57f-4d70-b134-6b97ea537ae1   duinvezel   provision_ok   Oct 10, 2026, 01:48
be378fe6-fb1b-4d9e-bf65-540d5b97c2c9   fde-smoke   provision_ok   Oct 9, 2026, 12:02
```

Two timeouts out of two namespace creates make this the normal behaviour of `telnyx-edge storage kv create` for now, not a one-off.

## 6. Docker bridge networking failed after a kernel update

**Date** 9 Oct 2026 · **Area** Local dev, Docker

**Symptom.** In T01 attempt 1, `telnyx-edge dev` built the bundle, but its compose stack never became healthy. Every container on a bridge network failed the same way, `docker run hello-world` included.

**Evidence.**

```text
$ telnyx-edge dev --no-watch --port 8787
Error response from daemon: failed to set up container networking: failed to create endpoint telnyx-dev-voice-context-1c9b78b3-actor-net-1 on network telnyx-dev-voice-context-1c9b78b3_default: failed to add the host (veth4c83ee3) <=> sandbox (vethf7682df) pair interfaces: operation not supported
Error: ❌ the stack did not become healthy
$ docker run --rm hello-world
docker: Error response from daemon: failed to set up container networking: failed to create endpoint zen_banach on network bridge: failed to add the host (veth9c736c2) <=> sandbox (veth23d2fc4) pair interfaces: operation not supported
$ grep 'upgraded linux ' /var/log/pacman.log | tail -1
[2026-10-09T09:12:11+0200] [ALPM] upgraded linux (7.2.8.arch1-2 -> 7.2.9.arch1-1)
```

**Cause.** The morning's `pacman -Syu` upgraded the kernel package and replaced the modules of the running kernel. The machine kept running 7.2.8 until a reboot at 18:40, so the kernel could not load the veth module that Docker needs to attach a container to a bridge network. Host networking does not use veth pairs, so it still worked.

**Fix.** A reboot into 7.2.9. After it, `docker run hello-world` works, and T01 attempt 2 ran `telnyx-edge dev` for all three functions as the card says, each on port 8787 with the normal bridge network. Before the reboot, the implementer had worked around the failure in attempt 1. It staged each bundle with `telnyx-edge dev` and ran it on the same `function-runtime` image (`sha-d9144b8`) with `--network host`, on ports 8787 to 8789. That proved the shared import was bundled, but the dev stack itself never ran. The feedback for attempt 2 told the implementer to stop and report a broken environment instead of working around it.

**Design impact.** None. After a kernel update, reboot before local dev work.

## 7. GLM-5.3 stopped every reply at 8,192 tokens, and card.sh passed the empty result on

**Date** 9 Oct 2026 · **Area** Inference, OpenCode plugin, run harness

**Symptom.** In the T03 bake-off GLM-5.3 stopped twice in the middle of its work, once as the reviewer on Kimi-K3's branch and once as the implementer on its own branch. Both times its last step was all reasoning and no text. OpenCode still exited 0, so `tools/card.sh` carried on. The empty review became an UNCLEAR verdict (exit 2). The empty change went through `npm run check`, which passed because there was nothing new to check, and the reviewer then asked for changes to files that did not exist. The implementer's report was an aside from an earlier step ("Now let me look at the existing `packages/shared` structure"), because card.sh took the last text it could find.

**Evidence.**

```text
# last step_finish of each cut-off run
reviewer, bake/kimi-k3      {"reason":"length","tokens":{"input":829,"output":0,"reasoning":8193}}
implementer, bake/glm-5.3   {"reason":"length","tokens":{"output":0,"reasoning":8193}}

# @telnyx/opencode 0.1.5, dist/index.js
const output = typeof model.max_output_length === "number" ? model.max_output_length : 16384;
config.provider[PROVIDER_ID] = { npm: "@ai-sdk/openai-compatible", name: "Telnyx", options: {...}, models };
"chat.params": async (input, output) => { ... output.maxOutputTokens = void 0; ... }

# one reply each in a scratch project, asked for every number from 1 to 2500 in words
# (the DeepSeek runs used two wordings, because the first try without the option wrote digits)
model                    max_tokens in the agent file   stop     output   reasoning   total
GLM-5.3                  none                           length     7026        1166    8192
GLM-5.3                  16384                          length    14237        2147   16384
DeepSeek-V4-Flash-0731   none                           stop      14510           0   14510
DeepSeek-V4-Flash-0731   16384                          stop      14250           0   14250
```

**Cause.** The Telnyx plugin for OpenCode clears `maxOutputTokens` on every request to a Telnyx model, so OpenCode never sends `max_tokens`, and the output limit of 16,384 that `opencode models telnyx --verbose` shows is never used. Each model then gets the API's own default. For GLM-5.3 that default is 8,192 tokens per reply, reasoning included. DeepSeek-V4-Flash-0731's is higher, since it wrote 14,510 tokens in one reply without `max_tokens`. An earlier version of this entry guessed that 8,192 applied to every model, and the scratch runs disproved that. Telnyx's inference docs give no default or maximum for `max_tokens`. GLM-5.3 is also missing from the plugin's list of thinking-capable models, so the plugin gives it no `enable_thinking` switch.

**Fix.** Both parts are fixed.

1. `tools/card.sh` now fails a step whose last step ended with reason `length`, or that ended without a final message, as `cutoff:<step>` with exit 4. An implementer that leaves the diff from the start commit empty fails as `no_change`, also exit 4. The final message is now the text of the last step only, so a cut-off step shows an empty report instead of an earlier aside. `--review-only` reruns a cut-off review without another implementer attempt. Both cut-off runs above are flagged by the new checks, and none of the eight normal runs is.
2. The three agent files set `max_tokens: 16384`. `.opencode/opencode.json` cannot do it, because the plugin's `config` hook replaces the whole `provider.telnyx` block, so a model override there is lost. A test with `OPENCODE_CONFIG` showed a dummy provider's limit taking effect, while GLM-5.3 kept the plugin's limit and empty options in the same run. An option in an agent file does reach the API, because the plugin clears only `maxOutputTokens`. With it GLM-5.3 stopped at exactly 16,384 tokens instead of 8,192, and Kimi-K3 accepts it too. The implementer also keeps each write or edit to about 250 lines, so one reply stays well under the cap.

**Design impact.** `CLAUDE.md`, where a cut-off review gets one rerun with `--review-only` and a second cut-off on the same card goes to Thiago. The three agent files, which set `max_tokens`. GLM-5.3 stays the reviewer and does not write code (ADR-018).

**Again at the higher cap, 10 Oct 2026.** Reviewing T07, a 1,351-line diff, GLM-5.3 spent its last step on 16,386 tokens of reasoning and wrote no text, so the 16,384 cap can still be reached. This time `tools/card.sh` failed the run as `cutoff:reviewer` with exit 4, and the one `--review-only` rerun finished and approved. The fix works as intended. Bigger diffs make a cut-off more likely. The T07 follow-up's review was cut off the same way, the second time on that card, and Thiago accepted the follow-up on Claude Code's review. He then raised the reviewer's `max_tokens` to 32,768, the other two agents staying at 16,384. The T06 follow-up's review is the first test of the new value. If Telnyx rejects it, the value goes back to 16,384 and this entry says so. Telnyx accepted it, and that review finished normally. Its largest step was 5,942 tokens, so the higher cap was not needed that time.

**The implementer's cap, 10 Oct 2026.** On T08 Kimi-K3 spent a whole step of 16,384 tokens on reasoning before writing any file, and later stopped twice at its 60-step limit. Thiago raised the implementer to 32,768 tokens and 100 steps. A scratch agent on Kimi-K3 with `max_tokens: 32768` answered normally, so Telnyx accepts the value.

## 8. A flaky timing test hid a measurement bug

**Date** 9 Oct 2026 · **Area** Tests, `packages/shared` timing

**Symptom.** T02 attempt 1 failed `npm run check` on one test. It slept 10 ms of real time, expected at least 10 ms and got 9. The other timing tests passed.

**Evidence.**

```text
× startTimings > measures real wall time for asynchronous work
  → expected 9 to be greater than or equal to 10

# Claude Code's probe on the same code: two kv calls, both pending while an injected clock moves 30 ms
expected {"total":30,"kv":60}   got {"total":30,"kv":0}
```

**Cause.** The tester, DeepSeek-V4-Flash-0731, modelled asynchronous work as clock jumps inside the wrapped function, before its promise existed, so its "parallel" calls never overlapped. One test slept for real instead. To pass both, the implementer read the injected clock when the wrapped function returned its promise instead of when the promise settled, and added `performance.now()` as a second clock. Overlapping calls then measured 0 on the injected clock, and the code read the real clock even with a clock injected.

**Fix.** The feedback on attempt 1 asked for one clock, read when a call starts and again when it settles, and for timing tests that advance the fake clock while the test holds the promises pending. No test sleeps now, and the probe gives 60.

**Design impact.** None.

## 9. `telnyx-edge dev` has no secrets and no KV namespace

**Date** 10 Oct 2026 · **Area** Edge Compute, local dev

**Symptom.** In T05 the implementer could not show `GET /customers` returning a fixture under `telnyx-edge dev`. Every keyed route answered 401, and the flags stayed at their defaults. `/healthz`, unknown paths and the 401 itself behaved as designed.

**Evidence.**

```text
# functions/mock-crm/.telnyx/dev/compose.yaml, the function container's whole environment
PORT: "3000"
DAPR_HTTP_PORT: "3500"
DAPR_HOST: 127.0.0.1
TELNYX_CONFIG_PATH: /app/telnyx.toml
FUNCTION_ENTRY: /app/customer/index.js

# .telnyx/dev/dapr-components/, the only Dapr component in the stack
name: statestore
type: state.postgresql

# node_modules/@telnyx/edge-runtime/dist/build-env.js, how env.SECRETS.get works
const url = `${this.daprUrlRoot}/v1.0/bindings/${this.bindingName}`;
resp = await fetch(url, { method: "POST", ... });
```

`telnyx-edge dev --help` (CLI 0.5.10) describes the stack as the function and actor runtimes, their Dapr sidecars, Dapr placement and scheduler, and a Postgres actor state store, and it has no flag for secrets or an environment file.

**Cause.** The dev stack emulates actors only. It has no secrets binding, so `env.SECRETS.get` fails, and no KV namespace binding, and no environment variables reach the function container. The "local KV" in the CLI's help is the actors' own storage.

**Fix.** Nothing to fix in our code. `mock-crm` fails closed, so a secret it cannot read means 401. The keyed routes are covered by request-level tests, and they get checked on the deployed function in T10.

**Design impact.** No dev-only override, because an override would be an auth bypass that could ship, and the demo and the scripts only ever call deployed functions. Under `telnyx-edge dev` the cards check routing, the fail-closed answers and the actor bindings. Keyed behaviour is proven by the request-level tests and on the deployed functions in T10 (Thiago, 10 Oct).

## 10. A spend limit stopped an agent run mid-edit

**Date** 10 Oct 2026 · **Area** Telnyx Inference, run harness

**Symptom.** The T07 follow-up stopped after six minutes, and the implementer's half-rewritten test file no longer compiled.

**Evidence.**

```text
error: Forbidden: {"errors":[{"code":"10039","title":"Inference spend limit reached",
  "detail":"Inference is paused for this account because its daily inference spend limit was reached.
  It resumes no later than 2026-10-11T00:00:00Z."}]}
$ npm run check
test/area-incident.test.ts(1089,1): error TS1005: '}' expected.
```

**Cause.** The account's daily inference spend limit was reached in the middle of the implementer's run.

**Fix.** Thiago removed the daily cap in the portal. `tools/card.sh --retry` continued the same OpenCode session, with feedback that named the interruption and the broken line and repeated the earlier points, in case the session was gone. The implementer closed the open block and finished the card in 2m19s.

**Design impact.** None. `CLAUDE.md` already stops on 10039, and `card.sh` printed the stop message. An interrupted run is recorded but does not count as a failed attempt.

**A second stop, 10 Oct 2026.** The same error stopped T09's first run at 20:39 UTC, after 8m07s, so a daily cap was still in force that evening. The run had written eight source files and installed the SDK, and the check did not compile. Claude Code stopped without a second try. Inference came back with the daily reset at 00:00 UTC on 11 October, and the retry continued the same session with feedback that listed the files that existed and the ones still missing.

## 11. KV calls from a function take about a second

**Date** 10 Oct 2026 · **Area** Edge Compute, KV

**Symptom.** S1's timing route took about 2.2 s per request, warm. One KV write and one KV read took almost all of it, where the latency budget had assumed 50 ms for a KV read.

**Evidence.** Twenty warm samples, timed with `performance.now()` inside the function (S1 measurements below, data in `~/code/scratch/smoke`).

```text
KV put       1,146 / 1,355 / 1,496 ms   min / median / max, and 1,757 ms 13 s after the series
KV get         668 /   806 /   941 ms
actor call     134 /   141 /   160 ms   and 269 to 284 ms after a pause
```

The runtime's source shows that every KV call is an HTTP request to the KV REST API, through a local endpoint where a proxy replaces the placeholder credential. Actor calls go to the actor sidecar on the same host instead.

```text
# node_modules/@telnyx/edge-runtime 0.16.0, dist/build-env.js
const PLACEHOLDER_API_KEY = "auth-proxy-will-replace-this";
env[e.binding] = new KvNamespaceImpl(namespaceId, telnyxBaseUrl, PLACEHOLDER_API_KEY);
# dist/kv-namespace.js, every get, put, delete and list
return `${this.baseUrl.replace(/\/+$/, "")}/storage/kvs/${encodeURIComponent(this.namespaceId)}/keys`;
resp = await fetch(url, { method: "GET", headers: { ...this.authHeader() } });
# dist/runtime-endpoints.js
const DEFAULT_TELNYX_BASE_URL = "http://localhost:3601";
actorUrlRoot: `http://${host}:${port}`,      // DAPR_HOST and DAPR_HTTP_PORT, default 127.0.0.1:3500
```

**Cause.** A property of the platform, not a bug in our code. KV from inside a function is a REST call, and S1 measured it at about 0.8 s per read and 1.4 s per write. We cannot see how that time splits between the proxy and the KV service.

**Fix.** Nothing to fix on our side, so the design works around it.

**Design impact.** ADR-019 moves sessions from KV to a `Session` actor (card T18) and puts memory caches in front of the hot KV reads, 10 seconds for flags and area statuses and 60 seconds for CRM results. The call setup webhook timeout is 4,000 ms, and `docs/ARCHITECTURE.md` (Call setup latency budget) has the new timeouts and expected times. T08 and T09 follow them, and T10 times the first request after each ship and the call from voice-context to mock-crm.

## 12. `telnyx-edge dev` refuses a function that only references shared actors

**Date** 10 Oct 2026 · **Area** Edge Compute CLI 0.5.10, `telnyx-edge dev`

**Symptom.** The T08 dev check could not run. `voice-context` declares the `CustomerAccount` and `Session` types under its own bindings and ships no class, as the shared-actors doc describes, and the dev stack refuses to start.

**Evidence.**

```text
$ cd functions/voice-context && telnyx-edge dev --generate-only
Error: ❌ actor class(es) CustomerAccount, Session are not exported by "src/index.ts"
💡 The local actor runtime resolves actor classes by named export. Re-export each actor class from your entry point, e.g. `export { CustomerAccount } from "./CustomerAccount";`.
```

The shared-actors doc (https://developers.telnyx.com/docs/edge-compute/stateful-actors/shared-actors.md) says "The reference function declares the same `type` under a different `binding` and ships **no** actor class". Its walkthrough ships the reference with `telnyx-edge ship` and never runs it under dev.

**Cause.** The dev command requires every `[[actors]]` type to be exported from `main`. That fits an owner but not a reference function, and even `--generate-only` refuses, so the command offers no way around it.

**Fix.** None in our code. Re-exporting the classes would make voice-context a second owner, which the doc rules out.

**Design impact.** The three keyless checks the T08 card wanted under dev (`/healthz` 200, an unknown path 404, an unsigned `POST /dv` 403) are covered by `test/routing.test.ts`, which drives the real fetch handler with a dev-like env, and by `scripts/smoke.sh` on the deployed function in T10. T10 ships voice-tools, the owner, before voice-context, because the doc says a reference type resolves only against an owner already on the account.

## 13. A call crashed when its MCP token could not be decrypted

**Date** 10 Oct 2026 · **Area** AI Assistants, per-caller credentials

**Symptom.** In S4's bad path the browser call started normally, then crashed when the caller asked for the echo tool. The phone path was not tested.

**Evidence.** Thiago's test at 20:24:23 UTC. `/dv?mode=bad` logged token id `8F9Bet0RjXCOmnuZ` with mode `bad`, and returned the same shape as the good path with one bit of the encrypted value flipped inside the GCM tag. No request reached `/mcp` afterwards. Telnyx's per-caller credentials page (https://developers.telnyx.com/docs/inference/ai-assistants/per-caller-credentials) describes a different outcome when "decryption fails". It says "No connection is attempted, so none is ever made unauthenticated, and its tools are unavailable for that conversation", and "An assistant whose MCP server drops out of a conversation loses that server's tools for the whole conversation".

**Cause.** Not known. Decryption failed as intended, since no unauthenticated request arrived, but the platform ended the call instead of carrying on without the tools. The crash came when the caller asked for the tool, not at the start of the call.

**Fix.** None on our side. The prompts cannot handle a call that has ended.

**Design impact.** ADR-008 and the Failure modes table in `docs/ARCHITECTURE.md`. A mismatch between the integration secret and the edge secret does not just remove the tools, it ends the call at the first tool use. So both copies of the key are always written together from one value, as T10's steps do, and every key change gets a real test call before the demo.

## 14. mock-crm answered 401 to every keyed request

**Date** 12 Oct 2026 · **Area** Edge Compute, secrets

**Symptom.** After T10's ships, the deployed mock-crm answered 401 to all 22 keyed requests. They came from the timing block, from `scripts/smoke.sh`, from voice-context's health checks and from Thiago's lookups of his own number. voice-tools accepted the same key from the env file for `POST /internal/sessions`, so the key was right. Each 401 took 302 to 307 ms on the server, against 2 to 6 ms for `/healthz`.

**Evidence.** mock-crm's own log line shows where the time went. Its `http` hop times the secret read, and every keyed request spent the 300 ms its code allows.

```text
# telnyx-edge logs mock-crm --type runtime, trimmed, and the other 20 alike
[2026-10-12T05:40:38.946Z] {"event":"crm_request","route":"customers","status":401,"latency_ms":{"total":302,"http":301}}
[2026-10-12T05:54:48.684Z] {"event":"crm_request","route":"customers","status":401,"latency_ms":{"total":300,"http":300}}
# functions/mock-crm/src/index.ts
export const SECRET_READ_TIMEOUT_MS = 300;
```

voice-tools and voice-context read the same secrets through the same `env.SECRETS.get`, bounded at 1,000 ms and kept for the container's life after the first success. Their first reads after the ship took longer than 300 ms.

```text
# voice-context, first GET /internal/health, one read (INTERNAL_KEY); the nine calls after it show "http":0
"latency_ms":{"total":3378,"http":732,"crm":398,"actor":965,"kv":2645}
# voice-tools, first POST /internal/sessions, two reads (INTERNAL_KEY, then MCP_TOKEN_KEY)
"latency_ms":{"total":1568,"http":1127,"actor":431}
# voice-context invocations, smoke's unsigned POST /dv, whose only call is the TELNYX_PUBLIC_KEY read
2026-10-12T05:56:19.051Z POST /dv 403 546 ms
```

**Cause.** A secret read is an HTTP call through the Dapr sidecar (issue 9), and deployed it took 0.55 to 0.75 s the first time in a container. mock-crm bounded every read at 300 ms and kept nothing, so each request read again and each read timed out. A secret that cannot be read counts as missing, and authentication failed closed with 401, as designed. `DEMO_CALLER_PHONE` has the same bound and no memo, so the demo number could not have matched either. `telnyx-edge dev` has no secrets binding (issue 9), so T10 was the first time this path ran. The flags read has the same flaw. `FLAGS_TIMEOUT_MS` is 300 ms where a KV read takes about 0.8 s (issue 11), so `crm_fail` and `crm_delay_ms` would never apply on the deployed function. No request got that far in T10.

**Fix.** The T10 follow-up (T10 card, Follow-up of 12 October). mock-crm keeps each secret after its first successful read, as the other two functions do, and bounds secret reads and the flags read at 1,000 ms, their value. Claude Code's probe of the real handler, with a secret read of 600 ms, answered the first keyed request in 1.2 s and the next three in 0 ms with one read of each secret. mock-crm gets shipped again.

**Design impact.** A secret read costs 0.55 to 0.75 s once per container, and the call setup budget in `docs/ARCHITECTURE.md` has no line for it (T10 measurements below).

## 15. mock-crm's flags read timed out on every refresh

**Date** 12 Oct 2026 · **Area** Edge Compute, KV

**Symptom.** After the re-ship of 12 October, every flags read in mock-crm stopped at its 1,000 ms bound. So `crm_fail` and `crm_delay_ms` never applied, and once per 10-second cache lifetime a lookup took a second longer. voice-context's health check showed it as a CRM check of 1,009 to 1,032 ms on calls 1, 5 and 9, against 7 to 20 ms on the others.

**Evidence.** All six keyed requests that read the flags, from 11:42:05 to 12:06:51, logged the bound as their `kv` hop. The one KV read that ran with a longer bound, `verify_account`'s area status read, took 1,149 ms.

```text
# telnyx-edge logs mock-crm --type runtime, trimmed
[2026-10-12T11:42:05.144Z] {"route":"customers","status":200,"latency_ms":{"total":2170,"http":1167,"kv":1001}}
[2026-10-12T11:53:24.500Z] {"route":"customers","status":200,"latency_ms":{"total":1001,"http":0,"kv":1001}}
[2026-10-12T11:53:36.161Z] {"route":"customers","status":200,"latency_ms":{"total":1001,"http":0,"kv":1001}}
[2026-10-12T11:53:47.783Z] {"route":"customers","status":200,"latency_ms":{"total":1001,"http":0,"kv":1000}}
[2026-10-12T11:54:57.381Z] {"route":"customers","status":200,"latency_ms":{"total":1001,"http":0,"kv":1001}}
[2026-10-12T12:06:51.100Z] {"route":"customers","status":200,"latency_ms":{"total":1000,"http":0,"kv":1000}}
# telnyx-edge logs voice-tools --type runtime, trimmed, the area status read has a 1,500 ms bound
[2026-10-12T11:55:07.594Z] {"event":"mcp","tool":"verify_account","latency_ms":{"total":1579,"http":1,"actor":392,"crm":30,"kv":1149}}
```

**Cause.** A KV read now takes longer than the 1,000 ms that all three functions give their flags read. S1 measured 668 to 941 ms (issue 11). mock-crm caches the defaults for 10 seconds after a timeout, so each refresh paid the full second and the flags never changed. voice-context and voice-tools cache nothing after a timeout, so each `/dv` and each `report_outage` would pay up to a second and get the defaults. Neither has run yet on the deployed functions, so their logs show no flags read.

**Fix.** Card T20, as Thiago decided on 12 October. A flags cache serves the last good value, refreshes it in the background once its lifetime has passed, keeps a late success, and gives the defaults only until a container's first successful read. mock-crm also starts its two secret reads and its flags read together on a container's first request, so its first keyed lookup waits for the slowest read instead of their sum.

**Design impact.** Flags apply one background read after a change instead of never, and only a container's first requests wait for KV (ADR-019, Status). The area status caches keep their 1,500 ms bound, which the one measured read stayed under.

## 16. Actor log lines are not in the function's log, and the platform redacts trace ids

**Date** 12 Oct 2026 · **Area** Edge Compute, logs

**Symptom.** Eleven minutes after the MCP Inspector check, `telnyx-edge logs voice-tools --type runtime --since 1h --last 250` had no line with the session's trace id `internal-<sid>`. T10's acceptance expected the actor's log line there.

**Evidence.** Claude Code read the logs on 12 October with read-only commands.

- The actor lines are in the actor type's own log. `telnyx-edge actors logs Session --type runtime` has the `create` and `setVerified` lines of the Inspector's session, and `telnyx-edge actors logs CustomerAccount --type runtime` its `verify` line. voice-tools' function log has none.
- Every trace id of the form `internal-<sid>` reads `internal-[redacted]`, in voice-tools' own lines and in the actor lines alike. The actor lines' `sid` field reads `[redacted]`. Our logger redacts by field name only (`packages/shared/src/log.ts`), and neither `trace_id` nor `sid` matches, so the platform does it. It also redacts the sidecar's address in the runtime's start line.
- The invocation records are not redacted. `telnyx-edge actors logs Session --type invocations` names each instance by its full sid, and mock-crm's invocation log shows each `GET /customers` with the full phone number in its query.

```text
# telnyx-edge actors logs Session --type runtime, trimmed
[2026-10-12T11:55:04.103Z] {"svc":"voice-tools","event":"actor","actor":"Session","method":"create","trace_id":"internal-[redacted]","sid":"[redacted]","outcome":"created"}
# telnyx-edge actors logs CustomerAccount --type runtime, trimmed
[2026-10-12T11:55:06.446Z] {"svc":"voice-tools","event":"actor","actor":"CustomerAccount","method":"verify","trace_id":"internal-[redacted]","outcome":"ok"}
# telnyx-edge logs voice-tools --type runtime, trimmed
[2026-10-12T11:55:07.594Z] {"event":"mcp","tool":"verify_account","trace_id":"internal-[redacted]","status":200}
[function-runtime] listening on :8080; dapr=http://[redacted]:3500; ...
```

**Cause.** Actor methods write to the actor type's log stream, which the CLI shows under `telnyx-edge actors logs`. The platform redacts some values in runtime logs. Every 32-hex sid we logged was redacted, and so was the sidecar's address. Its rules are not documented.

**Fix.** None for internal sessions. Their lines join by time and method.

**Design impact.** Our runtime logs may not join a call's lines by trace id. A real call uses its call control id as trace id (`docs/ARCHITECTURE.md`, Observability), and the first real call in T11 shows whether the platform redacts that too. If it does, the trace id needs a form the platform leaves alone. Evidence for a call includes `telnyx-edge actors logs <Type>` and the call's time window (T13, T15).

## 17. The first calls missed a known caller and a verification

**Date** 13 Oct 2026 · **Area** Edge Compute, replicas

**Symptom.** Thiago's first call from `DEMO_CALLER_PHONE`, at 14:35 Brussels time, was not recognised. On his next call the assistant greeted him by name, but `verify_account` failed when he gave his postcode, and the assistant offered a person.

**Evidence.** Claude Code read the runtime and invocation logs of the three functions and the actor logs with read-only commands. Times are UTC, and server times come from the invocation records. The logs hold five calls, two more than Thiago listed.

| Call | `/dv` | `dv` line | What failed |
|---|---|---|---|
| 12:35:13, his phone (his call 1) | 2,621 ms | anonymous, `crm_error`, crm 1,001 ms, secret reads 2,036 ms | voice-context's `INTERNAL_KEY` read hit its 1,000 ms bound, so no request reached mock-crm. mock-crm has no invocation before 12:39 |
| 12:39:36, his phone, ended before Route call | 2,587 ms | anonymous, `crm_timeout`, crm 1,748 ms, secret reads 1,894 ms | voice-context's secret reads, then mock-crm's first keyed request on its replica, 1,023 ms on the server |
| 12:39:46, his phone (his call 2) | 2,215 ms | `number_match`, crm 300 ms | `verify_account` at 12:40:14, crm 1,500 ms, a timeout. mock-crm's `GET /accounts` was its replica's first keyed request, 1,014 ms on the server, and started 0.66 s after voice-tools began the fetch |
| 12:43:34, browser (his call 3) | 1,730 ms | anonymous, crm 205 ms | nothing. `verify_account` for Marie and `run_line_diagnostics` passed |
| 12:45:32, his phone | 1,889 ms | `number_match`, crm 103 ms | `verify_account` at 12:46:03, crm 1,500 ms, a timeout. mock-crm's `GET /accounts` was again a replica's first keyed request, 1,024 ms on the server |

```text
# telnyx-edge logs mock-crm --type runtime, trimmed. http is the secret reads, kv the wait for the flags.
[2026-10-13T12:40:16.632Z] {"event":"crm_request","route":"accounts","status":200,"latency_ms":{"total":1014,"http":592,"kv":407}}
# telnyx-edge logs voice-tools --type runtime, trimmed
[2026-10-13T12:40:16.457Z] {"event":"mcp","method":"tools/call","tool":"verify_account","outcome":"error","latency_ms":{"total":1636,"actor":127,"crm":1500}}
```

The 0.66 s before mock-crm's handler started is voice-tools' own first `INTERNAL_KEY` read on its replica. `getAccount` awaits it inside the 1,500 ms bound (`functions/voice-tools/src/clients/crm.ts`). voice-context's lookup does the same inside its bound, after cutting the read at 1,000 ms (`functions/voice-context/src/index.ts`).

mock-crm served its eight requests from four replicas. Each replica keeps a steady offset between the platform's timestamp and the line's own `ts`, of -1.04, +1.12, -0.80 and +0.68 s. No replica started during the calls. The runtime logs show no `listening on :8080` line after 06:58 for mock-crm, 06:23 for voice-context and 00:07 for voice-tools. These replicas had run for hours without needing a secret, and their first keyed request paid for it.

**Cause.** Each replica reads a secret on first use, which took 0.55 to over 1.0 s. mock-crm's replica also waits up to 1,000 ms for its three reads on its first keyed request (T20). A CRM call can meet two first uses in a row, the caller's `INTERNAL_KEY` read and mock-crm's read window, about 1.7 s together. The bounds were 1,000 ms for voice-context's secret read and 1,500 ms for both CRM calls. Requests spread over several replicas per function, so first uses keep coming long after a ship, not only after a quiet night.

**Fix.** Card T22. voice-context and voice-tools start every read on a replica's first request of any kind, as mock-crm has since T20, and the CRM bounds cover two first uses in a row. Card T14 was to add a warm-up script. Thiago chose the smoke test and one MCP Inspector call from his runbook instead, and the README describes them under "Before a demo".

**Design impact.** ADR-014's exception for reads extends to all three functions, and the budget table in `docs/ARCHITECTURE.md` changes with T22.

## 18. The disclosure line played twice

**Date** 13 Oct 2026 · **Area** AI Assistants, workflow

**Symptom.** Every call heard the disclosure line twice, on the phone and in the browser.

**Evidence.**

- T11 sets the assistant's `greeting` to the Disclosure node's line (`assistantBody` in `scripts/provision/desired.ts`). In S2 a speak start node replaced the greeting (S2 findings).
- Only the speak node Disclosure runs before the tool node Route call, so the model has no turn in which to repeat the line.
- On all four calls that got that far, Route call reached `/tools/disclosure` 15 to 17 s after `/dv` answered. The line has 25 words, about 8 s of speech, so that fits two plays and not one.

**Cause.** Most likely the greeting now plays before the speak start node. In S2 the greeting had other words and never played. The transcripts in the portal's Conversation History would settle it.

**Fix.** Card T23. Provisioning sends an empty greeting. The next call also tests the cause, since it should hear the line once and reach Route call about 8 s sooner.

**Design impact.** T11's rule for `greeting` no longer holds.

## 19. The disclosure tool never carried the call's session id

**Date** 13 Oct 2026 · **Area** AI Assistants, webhook tools

**Symptom.** All four `/tools/disclosure` requests answered `invalid_sid` with `logged: false`, so no session recorded its disclosure.

**Evidence.**

```text
# telnyx-edge logs voice-context --type runtime, trimmed
[2026-10-13T12:35:32.544Z] {"event":"disclosure","node":"route_call","outcome":"invalid_sid","logged":false,"status":200}
```

The route checks the Telnyx signature first and answers 403 when it fails (`functions/voice-context/src/routes/disclosure.ts`). All four answered 200, so Telnyx signed them.

**Cause.** The tool node's model fills `session_id`, a body parameter of `log_disclosure`, from what it can see. In S2 the instructions named the variable. Since Thiago's decision of 12 October no instruction or message carries `session_id`, so the model had nothing to fill it with.

**Fix.** Card T23. `log_disclosure` gets `session_id` as a preset body field, `{{session_id}}`. Telnyx fills presets from the dynamic variables and keeps them out of the model's view (https://developers.telnyx.com/docs/inference/ai-assistants/preset-webhook-parameters). Its body schema no longer asks the model for anything.

**Design impact.** T11's shape for the disclosure tool changes. The unsigned path from T11's decision 7 is not needed, because Telnyx signs webhook tool requests.

## 20. A slow call setup could cost a phone call its token

**Date** 14 Oct 2026 · **Area** Edge Compute, KV and replicas

**Symptom.** No call has failed this way yet. On the morning of the review Thiago's smoke test failed voice-context's KV probe twice. Claude Code then checked the call setup budget against the morning's numbers and found that a phone call on a fresh replica could get its variables too late or not at all.

**Evidence.** Claude Code read the logs with read-only commands. Times are UTC.

```text
# telnyx-edge logs voice-context --type runtime, trimmed, the two browser calls and the first smoke run
[2026-10-14T06:27:43.220Z] {"event":"dv","channel":"phone_call","identity":"anonymous","outcome":"ok","status":200,"latency_ms":{"total":2014,"http":9,"kv":9013,"actor":401}}
[2026-10-14T06:32:56.557Z] {"event":"dv","channel":"phone_call","identity":"anonymous","outcome":"ok","status":200,"latency_ms":{"total":2888,"http":890,"kv":9577,"actor":481}}
[2026-10-14T06:45:21.935Z] {"event":"health","ok":false,"status":503,"checks":{"kv":{"ok":false,"latency_ms":3981},"crm":{"ok":true,"latency_ms":41}}}
# telnyx-edge logs voice-tools --type runtime, trimmed
[2026-10-14T06:27:54.401Z] {"event":"auth_failed","route":"mcp","reason":"secret_error","status":503,"latency_ms":{"total":1002,"http":1000}}
```

- In both calls the five area reads ran into their 2,000 ms bound. The KV probe's put took about 2.3 to 2.5 s and its get ran out at 1.5 s, about twice the times of 13 October.
- A fresh replica's secret reads cost the second call 890 ms. voice-tools' token key read on a fresh replica ran past its 1,000 ms bound, and Telnyx opened the MCP session again four seconds later. The first call's transcript has the caller speaking from 06:27:54.7, 0.3 s after the 503. Telnyx opened the session again as their sentence ended, which may have added about half a second to the reply. The silence after the disclosure came from the instructions, which T25 changed, and not from the 503.

**Cause.** Three gaps in `/dv`.

1. The public key read was cut at 1,000 ms, and a fresh replica's first read can take longer. `/dv` then answers 403.
2. The 3,000 ms budget started after that read. A phone call whose caller mock-crm answered also waited for the CRM cache write in KV. On a fresh replica that came to 3.5 to 4.0 s of server time, against a webhook timeout of 4,000 ms.
3. The payload schema rejected a missing or null caller, which a withheld number may bring. Telnyx does not document what it sends then.

When `/dv` answers late or with an error, Telnyx uses the defaults, so the call goes to Degraded with no MCP token (`docs/ARCHITECTURE.md`, Failure modes). Browser test calls never look the caller up, so they could not show the second gap.

**Fix.** Card T24. The budget starts when the request arrives, and the token key reads are cut to what remains, so `/dv` answers within 3,000 ms of server time. Secret reads wait up to 2,000 ms and area reads up to 2,500 ms. The cache write no longer holds the answer and logs its own `crm_cache_write` line. A missing or null caller is anonymous.

**Design impact.** The call setup budget in `docs/ARCHITECTURE.md` changes. T26 raised voice-tools' MCP auth read to 2,000 ms as well. On the first call after T26's ship, at 12:49 UTC, that read took 1,031 ms on a fresh replica, and the session opened.

## 21. Both transfers failed before anything rang

**Date** 14 Oct 2026 · **Area** Voice, outbound voice profiles

**Symptom.** In two afternoon calls the assistant said it would connect the caller with a support engineer, and then that the transfer did not go through. One call came from Thiago's mobile, the other from the browser. Nothing rang.

**Evidence.** Both transcripts hold the `transfer` tool's result, from `GET /v2/ai/conversations/{id}/messages`. It came back 1.0 and 0.5 s after the tool call. Apart from the call control id, left out here, the two results are the same.

```text
{"status":403,"body":{"errors":[{"code":"10010","detail":"Dialed number is not included in whitelisted countries D13. This dialed number is not a number from whitelisted countries present in the OB profile associated with the connection making the call. To solve it the customer can add the number country to the whitelist of the given OB profile.","title":null}],"telnyx_error":{"error_code":"D13"}},"error_name":"Error during dial command"}
```

The shared transfer tool dials `TRANSFER_TO` from the assistant's number (`scripts/provision/desired.ts`). The provisioning script attaches that number to the assistant's TeXML application (`scripts/provision/run.ts`).

**Cause.** The outbound voice profile of the connection making the call did not allow Belgium, so Telnyx refused the dial command. The transcripts show no other error. On the call from Thiago's mobile the transfer would have rung that same busy phone, but nothing was dialled. After each failure the call went to Take message, as designed.

**Fix.** At 15:19 Brussels time Thiago allowed Europe on the account's default outbound voice profile in the portal. The provisioning script calls only `/ai/tools`, `/ai/mcp_servers`, `/ai/assistants` and `/phone_numbers`, so it never reads or changes a profile. The README lists the step under Manual setup. In the evening rehearsal the transfer in Geert's browser call rang Thiago's mobile at 15:24 UTC, and the tool's result read `Transfer completed` (issue 28).

**Design impact.** A transfer from a call made on `TRANSFER_TO` rings the phone that is already on the call. The repeat-caller path from Thiago's mobile can therefore never reach a person, and transfers are tested from the browser.

## 22. A known caller was greeted as unknown after mock-crm scaled to zero

**Date** 14 Oct 2026 · **Area** Edge Compute, replicas

**Symptom.** Thiago's first afternoon check call from his mobile, at 14:49 Brussels time, greeted him as an unknown caller. His next call, 30 s later, greeted him by name.

**Evidence.** Claude Code read the logs with read-only commands. Times are UTC.

```text
# telnyx-edge logs voice-context --type runtime, trimmed
[2026-10-14T12:49:50.163Z] {"event":"dv","identity":"anonymous","cache":"miss","outcome":"degraded","reasons":["crm_timeout"],"status":200,"latency_ms":{"total":2509,"http":48,"kv":10453,"actor":484}}
# telnyx-edge logs mock-crm --type runtime, trimmed
[2026-10-14T12:40:40.227Z] [function-runtime] SIGTERM received, shutting down
[2026-10-14T12:46:32.953Z] [function-runtime] SIGTERM received, shutting down
[2026-10-14T12:50:01.148Z] [function-runtime] listening on :8080
[2026-10-14T12:50:08.280Z] {"event":"crm_request","route":"customers","status":200,"latency_ms":{"total":1043,"http":718,"kv":279}}
```

- `/dv` already races the caller's KV copy against mock-crm, for up to 2,000 ms (`lookupCaller` in `functions/voice-context/src/routes/dv.ts`). Neither side answered.
- A KV copy lives 600 s (`CRM_KV_TTL_SEC`), and nothing had looked his number up for hours.
- mock-crm's last request before the call came at 06:50:49. Its two replicas stopped at 12:40 and 12:46. The lookup left voice-context at about 12:49:48, a new replica started 13 s later, and it answered 20 s after the lookup began.
- voice-context itself was warm. Its secret reads took 48 ms.

**Cause.** mock-crm had no replica left, and its first request waited about 20 s for a new one. No bound inside the 4,000 ms webhook timeout can cover that.

**Fix.** None in code before the review. The warm-up's smoke test calls mock-crm, which starts a replica when none is running, and on 14 October its replicas then ran for almost six hours without a request. Thiago runs the warm-up at 15:45 and again just before the first demo call. The canary in the README's next step would keep a replica up all the time.

**Design impact.** A call that meets mock-crm with no replica greets a known caller as unknown and asks for the full verification. The README lists it under Known issues.

## 23. The model did everything from Verify

**Date** 14 Oct 2026 · **Area** AI Assistants, workflow

**Symptom.** After verification the model never moved on to Triage or Diagnose. In one call the caller asked for an engineer and then for a live agent. The model offered a callback twice, created one the caller had not agreed to, and only then offered a person.

**Evidence.** The transcripts give each message's `flow_node_id`. Five calls used MCP tools, and until the transfer in the last one every tool ran from `n_verify`.

| Call (UTC) | Tools called from `n_verify` |
|---|---|
| 06:27, browser | `verify_account` twice, `run_line_diagnostics` |
| 06:32, browser | `verify_account` twice, `run_line_diagnostics`, `report_outage` |
| 12:50, phone | `verify_account`, `run_line_diagnostics` |
| 12:54, browser | `verify_account`, `run_line_diagnostics` |
| 13:00, browser | `verify_account`, `run_line_diagnostics`, `create_ticket` |

In the last call the transfer then failed (issue 21), and Take message asked for a good time. The model called `create_ticket` again with that time in the summary. The `CustomerAccount` actor logged `outcome: existing`, because a ticket is idempotent per call and category (ADR-015), so the time never reached ticket T-2238.

**Cause.** ADR-020 lets every prompt node see all five MCP tools, and only the instructions say which belong to a step. Verify's instructions name `verify_account` and `check_area_status`, and the model used the others anyway. Diagnose's outage rule from T25 and Take message's text were then not in its prompt.

**Fix.** Card T27. The base instructions say each step uses only the tools it names, and Verify moves on as soon as the caller is verified. A request for a person goes to Handoff straight away, a callback is created only once the caller agrees, and the caller's time goes into the one `create_ticket` call.

The scope rule did not hold. In the rehearsal's first call at 13:53, with T27 live, the model again ran the line check and the report from Verify. Thiago chose to drop the rule rather than press harder, since no call has yet shown whether a step change between two prompt nodes leaves a pause (issue 24). Card T28 removes it and puts the outage rule into the base instructions, next to the ticket rules, so the rules that must hold apply in every step. A plainer rule in Verify is the next step after the review (README, Known issues).

**Design impact.** ADR-020's consequences gain this evidence.

## 24. The assistant went silent after the outage notice

**Date** 14 Oct 2026 · **Area** AI Assistants, workflow

**Symptom.** In the rehearsal's path A call the outage notice played straight after the disclosure. Then the line stayed silent until the assistant asked whether Thiago's internet was down completely.

**Evidence.** The transcript, times UTC. The `system` line is Telnyx's own.

```text
13:57:21.865 n_outage_notice assistant  There's a confirmed outage affecting Veurne. Our engineers are working on it, and we expect your service back by 19:56 today.
13:57:38.361 -               system     [long silence]
13:57:38.770 n_outage_help   assistant  Is your own internet down completely right now?
```

**Cause.** Outage notice is a speak node, and its default edge leads to the prompt node Outage help. The model got no turn when Outage help started, so it waited for the caller until Telnyx's silence prompt, 16.5 s after the notice began. A tool node does hand the model a turn. Route call does so before Verify in every call since T25, Transfer did before Take message (issue 21), and the tool node in S2 did too (S2 findings).

**Fix.** Card T28. The notice's own line ends with the follow-up question, "Is that why you're calling, or is there something else I can help with?", so the caller's answer starts the model's turn.

**Design impact.** A speak node followed by a prompt node must end with a question. Outage notice is the only one in the workflow.

## 25. A misheard first request brought back the recording notice

**Date** 14 Oct 2026 · **Area** AI Assistants, speech recognition

**Symptom.** In the rehearsal's path C call Thiago said his internet was down. The assistant answered that the call was recorded and asked again how it could help, so he had to repeat himself.

**Evidence.** The transcript, times UTC.

```text
13:53:16.133 n_verify assistant  How can I help you today, Thiago?
13:53:20.538 n_verify user       Uh, it looks recorded in Internet phone.
13:53:23.194 n_verify assistant  I understand. Yes, this call is recorded for quality and training purposes. That's standard for our support line. How can I help you today, Thiago?
```

**Cause.** Speech recognition turned the first request into words about recording, and the model answered those words. It happened in Verify before any tool call or step change, so it does not come from T27. The opening question also repeated the name the disclosure had just used, as T25 wrote it.

**Fix.** Card T28. The base instructions say never to repeat the recording notice or the opening question, to act on the caller's first request, and to ask only about a part that was unclear. The opening question no longer uses the name.

**Design impact.** None.

## 26. A demo report answered 503 although every report landed

**Date** 14 Oct 2026 · **Area** Demo tooling, actors

**Symptom.** In the rehearsal `scripts/demo.sh reports 8630 3` answered 503 with `report_unavailable`.

**Evidence.** Times UTC.

```text
# telnyx-edge actors logs AreaIncident, trimmed
[2026-10-14T13:56:39.312Z] {"method":"report","area":"8630","outcome":"counted","reports_in_window":2,"threshold":3}
[2026-10-14T13:56:39.615Z] {"method":"report","area":"8630","outcome":"declared","reports_in_window":3,"threshold":3}
[2026-10-14T13:56:42.207Z] {"event":"publish","area":"8630","version":3,"latency_ms":{"total":2565,"kv":2565}}
[2026-10-14T13:56:42.264Z] {"method":"report","area":"8630","outcome":"counted","reports_in_window":4,"threshold":3}
# telnyx-edge logs voice-tools --type runtime, trimmed
[2026-10-14T13:56:41.661Z] {"event":"internal_demo","route":"reports","outcome":"report_unavailable","status":503,"latency_ms":{"total":2554,"actor":2553}}
```

**Cause.** Thiago's own report in the call before was the first, so the second simulated report declared the incident. The actor's alarm then wrote the new status to KV, which took 2.6 s. An actor runs one call at a time, so the third simulated report waited behind that write, and the route's bound of 2,000 ms per report (`demoReportMs` in `functions/voice-tools/src/config.ts`) ran out. The report itself landed 0.6 s later.

**Fix.** None before the review. After a caller's own report, `reports 8630 2` is enough, so the report that declares the incident is the last one sent. When the route answers 503, the `AreaIncident` log shows what landed.

**Design impact.** The demo route's bound does not cover an alarm queued on the same actor.

## 27. Callers spoke into the pause before the opening question

**Date** 14 Oct 2026 · **Area** AI Assistants, workflow

**Symptom.** In the evening rehearsal Thiago found the pause between the disclosure and "How can I help you today?" long enough that callers start to talk.

**Evidence.** The seven rehearsal calls that went to Verify, from their transcripts. Route call's tool call follows the spoken disclosure, and the question is the model's first reply in Verify.

| Call (UTC) | Route call's webhook | Route call to the question |
|---|---|---|
| 15:14, phone | 0.54 s | 1.18 s |
| 15:16, phone | 0.43 s | 1.36 s |
| 15:18, browser | 0.62 s | 1.09 s |
| 15:19, browser | 0.31 s | 0.58 s |
| 15:21, browser | 0.28 s | 0.50 s |
| 15:23, browser | 0.48 s | 1.28 s |
| 15:25, browser | 0.45 s | 0.68 s |

**Cause.** The question came from the model's turn after Route call. That turn waited for the disclosure webhook and then for the model's reply.

**Fix.** Card T29. The disclosure line ends with the question, and Verify and Triage tell the model it has been asked and to wait for the answer.

**Design impact.** Every path now hears the question. On the outage path the outage notice follows it about 0.7 s later, on the repeat-caller path the Handoff line, and on the Degraded path the model's apology. The model still gets a turn after Route call. Before T25, with no line about the opening, it waited in the call at 06:27 and asked on its own in the call at 06:32, so the first call after T29 shows whether the new line holds.

## 28. The caller heard silence while the transfer rang

**Date** 14 Oct 2026 · **Area** AI Assistants, transfer

**Symptom.** In the evening rehearsal Geert's browser call was transferred to Thiago's mobile. On the browser side the caller heard nothing while the mobile rang.

**Evidence.** The transcript, times UTC. The result came 16.4 s after the tool call.

```text
15:24:47.525 n_handoff  assistant  I'll connect you with one of our support engineers now. Please stay on the line.
15:24:51.224 n_transfer CALL       transfer {}
15:25:07.654 n_transfer RESULT     Transfer completed
```

**Cause.** The shared transfer tool set only `targets` and `from` (`scripts/provision/desired.ts`). Telnyx documents ringback for the caller only for a warm transfer with acceptance, where the caller stays with the assistant while it talks to the person who answered (ADR-021).

**Fix.** Card T29 makes the transfer warm, with the engineer's acceptance and voicemail detection (ADR-021). The Handoff line tells the caller to expect ringing.

**Design impact.** ADR-021. Its settings are tested only once Thiago's calls after T29 go through.

## S1 measurements

Smoke test numbers from 9 Oct, server side, from invocation logs.

| Request | Duration |
|---|---|
| First request after the deploy | 537 ms |
| First request after a pause (four samples) | 287 to 309 ms |
| Follow-up requests (seven samples) | 139 to 155 ms |

Each of these requests includes one round trip to the counter actor.

S1, 10 Oct. `GET /timing` on the smoke function times one KV put, one KV get of the same key and one counter actor call with `performance.now()`. The request duration is server side, from `telnyx-edge logs smoke --type invocations`. The data is in `~/code/scratch/smoke` (`warm.jsonl`, `cold.jsonl`, `invocations.json`), and the ship took 5 min 50 s.

| Measure | Warm, 20 samples (min / median / max) | 13 s after the warm series | After 26 min idle |
|---|---|---|---|
| Request duration | 1,965 / 2,257 / 2,548 ms | 2,968 ms | 2,450 ms |
| KV put | 1,146 / 1,355 / 1,496 ms | 1,757 ms | 1,310 ms |
| KV get | 668 / 806 / 941 ms | 940 ms | 852 ms |
| Actor round trip | 134 / 141 / 160 ms | 269 ms | 284 ms |

**No cold start was captured.** The two samples in `cold.jsonl` ran on the container that served the warm series. Its age was 3 h 48 min and 4 h 14 min, so it started at about 07:20 UTC, right after the ship, and stayed up through the 26-minute idle period. The first of those samples came only 13 s after the warm series. The best cold-start number is still the 537 ms first request after the 9 Oct deploy, which made no KV call.

**KV calls dominate.** From inside a function a KV read takes about 0.8 s and a write about 1.4 s, warm, where the latency budget in `docs/ARCHITECTURE.md` assumed 50 ms for a read. The actor round trip is about 140 ms warm and 270 to 290 ms after even a short pause, as on 9 Oct.

**`dynamic_variables_webhook_timeout_ms` is 4,000 ms, approved by Thiago on 10 October.** The card's rule takes the slowest cold call setup estimate times 1.5, rounded up to 500 ms, at most 4,000 ms. On the current T08 design the slowest call setup is a CRM cache miss after a pause. Its flags read (0.9 s), CRM cache read (0.9 s) and mock-crm call (about 1.2 s, an estimate, because S1 did not measure a call between functions) run one after another, followed by the slowest of the parallel steps, the 1.8 s session write. That is about 4.8 s, which times 1.5 is 7.3 s, so the 4,000 ms cap applies, and T08's budgets have to change to fit under it. They did, in ADR-019 and the budget in `docs/ARCHITECTURE.md`.

## T10 measurements

12 Oct 2026, times in UTC. Thiago ran the steps from `~/code/scratch/t10/t10.sh`. Client times come from `curl`, server times from `telnyx-edge logs <name> --type invocations`, and voice-context's checks from its `/internal/health` answers (`~/code/scratch/t10/health-*.json`) and its runtime log.

**Ships.** Each ship ran with `--timeout 15m` and finished on its own. voice-tools bundles the MCP SDK, and its ship took the longest.

| Function | Shipped in, CLI | Wall time | Bundle | Archive |
|---|---|---|---|---|
| mock-crm | 5m15s | 5m18s | 771,466 bytes | 125,679 bytes |
| voice-tools | 6m40s | 6m45s | 3,721,123 bytes | 688,612 bytes |
| voice-context | 5m5s | 5m10s | 791,817 bytes | 130,757 bytes |

**First request after the ship.** A `GET /` reached each function 2.3 to 5.4 s before our first request, and got a 404 in 20 to 44 ms on the server. It looks like the post-deploy probe of issue 4. So our first request was not the container's first, and these are not true cold starts.

| Function | Probe `GET /`, server | First `/healthz`, server / client | Five warm `/healthz`, server / client |
|---|---|---|---|
| mock-crm | 05:40:35.584, 44 ms | 16 ms / 163 ms | 2.2 to 5.8 ms / 102 to 141 ms |
| voice-tools | 05:48:23.358, 24 ms | 17 ms / 154 ms | 2.6 to 3.1 ms / 104 to 139 ms |
| voice-context | 05:54:40.337, 20 ms | 14 ms / 143 ms | 1.7 to 2.6 ms / 101 to 121 ms |

S1's first request after its 9 Oct deploy took 537 ms, and it included an actor call.

**voice-context's dependency calls.** Ten `GET /internal/health` calls from 05:54:48 to 05:55:13, and smoke's at 05:56:24. The four checks run in parallel inside one request. The secret read happens before them, once per container.

| Check | First call | The ten after it | S1, warm min / median / max |
|---|---|---|---|
| KV put, then get of the same key | 2,645 ms | 2,471 to 2,958 ms, and one failure at 2,501 ms | put plus get per sample, 1,827 / 2,109 / 2,404 ms |
| `CustomerAccount.snapshot` | 483 ms | 8 to 17 ms | actor round trip 134 / 141 / 160 ms, and 269 to 284 ms after a pause |
| `Session.get` | 482 ms | 8 to 14 ms | as above |
| Secret read, `INTERNAL_KEY` | 732 ms | 0 ms, kept from the first | not measured |
| CRM lookup | 398 ms | 308 to 323 ms | not measured, and this row only shows mock-crm's 401 after its 300 ms timeout (issue 14) |

The other functions' first calls agree. voice-tools' first `POST /internal/sessions` spent 1,127 ms on its two secret reads and 431 ms on `Session.create`, and `SESSION.get` then took 7 ms on `initialize` and `tools/list`. voice-context's first read of `TELNYX_PUBLIC_KEY`, for smoke's unsigned `POST /dv`, took about 546 ms.

**The checks that failed.** `ok` was false on all eleven calls. `crm` failed every time, because mock-crm answered 401 (issue 14). `kv` failed once, on the fourth call at 05:54:56, after 2,501 ms. That matches a timeout. Either the put hit its 2,500 ms bound, or the get hit its 1,500 ms bound after a put of about 1.0 s, and the summed `kv` hop cannot tell which. `customer_account` and `session` passed every time.

**Not measured yet.** mock-crm's own keyed latency and voice-context's call to it, because every keyed request ended in the 300 ms timeout and a 401. They come from the timing run after the follow-up's re-ship, and so do the CRM timeouts. The MCP Inspector check did not run, because `t10_inspector` runs only after a passing smoke.

**Budget.** Three findings move the call setup budget in `docs/ARCHITECTURE.md`.

- A secret read costs 0.55 to 0.75 s once per container, and the budget has no line for it. `/dv` reads `TELNYX_PUBLIC_KEY` for the signature check before its soft budget starts. On a new container's first call, that read uses most of the second the budget leaves for the signature check, the token, cold-start work and the network. The two token keys are read in parallel with the flags, the CRM lookup and the area statuses, inside the soft budget.
- KV is slower than in S1. Put plus get took 2.47 to 2.96 s, where S1 took 1.83 to 2.40 s, and one call hit a KV timeout. The CRM cache write (2,500 ms, cut by the soft budget) and the flags and area reads (1,000 and 1,500 ms on a cache miss) have less headroom than the table assumes. The split between put and get is not measured.
- Warm actor calls took 8 to 17 ms, far below S1's 141 ms and the table's 0.15 s. The first actor calls after the ship took 431 to 483 ms, above the 269 to 284 ms S1 saw after a pause.

**The re-ship.** After the follow-up (issue 14), Thiago shipped mock-crm (Updated At 11:41) and voice-tools (11:52) again, then ran the timing for mock-crm and voice-context, `scripts/smoke.sh` and the MCP Inspector check. voice-context was not shipped again. All 11 smoke checks passed, and the Inspector listed the five tools and verified Marie's fixture account. The ship times did not reach Claude Code, so the numbers below come from the platform logs and the health answers in `~/code/scratch/t10/run-115322/`.

| Function | Probe `GET /`, server | First `/healthz`, server | Five warm `/healthz`, server |
|---|---|---|---|
| mock-crm | 11:41:57.089, 22 ms | 16 ms, 5.2 s after the probe | 2.2 to 3.5 ms |
| voice-tools | 11:52:13.606, 20 ms | 17 ms, 6.0 s after the probe | 2.6 to 6.8 ms |

mock-crm's first keyed request took 2,174 ms on the server. Its log line shows the two secret reads one after the other, 1,167 ms together, then the flags read stopped by its 1,000 ms bound (issue 15). The next four took 2.4 to 5.3 ms.

voice-context's ten `GET /internal/health` calls ran from 11:53:23 to 11:53:52, and smoke's at 11:55:03.

| Check | First call | The ten after it |
|---|---|---|
| KV put, then get of the same key | 2,699 ms | 2,609 to 3,118 ms, and one failure at 2,501 ms |
| CRM lookup | 1,032 ms | 7 to 20 ms, and 1,009 ms on calls 5 and 9 |
| `CustomerAccount.snapshot` | 49 ms | 8 to 16 ms |
| `Session.get` | 49 ms | 7 to 15 ms |
| Secret read, `INTERNAL_KEY` | 0 ms | 0 ms |

The secret read shows 0 ms throughout, so the container that answered had read it before. The CRM checks near a second are mock-crm's flags reads hitting their bound, at 11:53:24.5, 11:53:36.2 and 11:53:47.8 in mock-crm's log. Without them a warm call from voice-context to mock-crm took 7 to 20 ms.

voice-tools, from its runtime log and the actor invocation records.

| Request | Server | Split |
|---|---|---|
| First `POST /internal/sessions` (smoke), new container | 1,675 ms | two secret reads 1,278 ms, `Session.create` 382 ms |
| Second `POST /internal/sessions` (Inspector) | 382 ms | `Session.create` 378 ms, secrets kept |
| MCP `initialize`, `notifications/initialized`, `tools/list` | 8 to 36 ms | `Session.get` 5 to 8 ms |
| `tools/call` `verify_account` | 1,581 ms | area status KV read 1,149 ms, actor calls 392 ms, mock-crm 30 ms |

**A new actor instance costs about 0.4 s.** `Session.create` ran in 22 to 24 ms inside the actor, per its invocation records, while the call from voice-tools took 378 to 382 ms. Each session is a new instance, because its name is a new sid. The canary instances already existed, and voice-context's first health call reached them in 49 ms after six hours without a call. So the 431 to 483 ms of the first run were first calls to new instances, not cold containers. Every call setup creates a new `Session` instance, so it should pay this once. `verify_account`'s 392 ms of actor calls include the first call to the instance of DV-100002, Marie's fixture account.

**The checks that failed.** `ok` was false once in eleven calls, on call 9 at 11:53:48.925, when the KV check timed out after 2,501 ms. Across both runs the KV check failed 2 of 22 times. `crm`, `customer_account` and `session` passed every time.

**CRM timeouts.** voice-context's lookup and voice-tools' account fetch stay at 1,500 ms, decided by Thiago on 12 October. The reasoning is in `docs/ARCHITECTURE.md`, Call setup latency budget.

**The actor log line.** T10's last acceptance item looked for the actor's line in `telnyx-edge logs voice-tools`. It is in `telnyx-edge actors logs Session` and `CustomerAccount` instead, and the platform redacts the trace id's hex (issue 16).

**After T20.** Thiago shipped all three functions again on the evening of 12 October. All 11 smoke checks passed, and the MCP Inspector verified Marie's fixture account. The terminal output was lost in a restart, so the numbers come from the platform logs between 19:32 and 19:57 UTC and the health answers in `~/code/scratch/t10/run-195613/`.

- **mock-crm's deploy.** It started 13 containers and stopped 13 between 19:36:53 and 19:37:31.
- **The probe and the first keyed lookup.** The platform's probe at 19:37:31 was the first request of the replica it reached and started its reads. The first keyed lookup at 19:37:38 took 675 ms on the server, with the secrets already read and 670 ms of waiting for the flags. The next lookups took 0 to 2 ms.
- **The flags reads.** Every `flags_read` line has `ok`, at 1,198 to 1,425 ms.
- **voice-context's ten health calls.**

| Check | First call | The nine after it |
|---|---|---|
| KV put, then get of the same key | 2,834 ms | 2,542 to 3,293 ms, no failure |
| CRM lookup | 92 ms | 8 to 13 ms |
| `CustomerAccount.snapshot` | 95 ms | 8 to 11 ms |
| `Session.get` | 93 ms | 9 to 10 ms |

T20's acceptance holds. The first keyed lookup stayed under 1,000 ms, the flags apply, and no CRM check came near a second.

## T11 first calls, 13 October

Thiago ran `node scripts/provision.ts --dry-run`, then the real run, at 03:29 and 03:30 Brussels time. The real run created the three shared tools, the MCP server and the assistant, moved the number to the assistant's TeXML application and wrote `infra/ids.json`. The second run, which should print `unchanged` throughout, comes with T23's changes. His first calls came at 14:35 to 14:46 Brussels time. Claude Code read the logs with read-only commands. Issues 17 to 19 hold the bugs, and these are the other answers.

- **The trace id survives.** A real call's `trace_id` is its call control id, such as `v3:lhTGKCD0…`. It appears in full in voice-context's and voice-tools' runtime lines and in the `Session` and `CustomerAccount` actor lines, so a call's lines join by trace id. The platform still redacts the 32-hex sid (issue 16).
- **Telnyx signs webhook tool requests.** All four `/tools/disclosure` requests passed the signature check that `/dv` uses (issue 19).
- **Prompt nodes reach the MCP tools without a tool field.** `verify_account` came from Verify account and `run_line_diagnostics` from Diagnose (ADR-020).
- **Telnyx opens the MCP session twice per call.** It sends `initialize`, `notifications/initialized` and `tools/list` within about 2 s of `/dv`, and again 20 to 25 s later, as the call reaches its first prompt node. Each request reads the session with one `Session.get`.
- **The browser test call counts as a phone call.** It arrived with channel `phone_call` and a caller of fewer than six digits, so `/dv` looked those digits up. mock-crm answered 404, and voice-context cached a "not found" for them. T22 skips the lookup below eight digits and logs the channel.
- **Thiago's log commands at 14:46 printed nothing** for voice-context and voice-tools. His capture at 14:49 and Claude Code's `telnyx-edge logs <name> --type runtime` at 15:03, with the defaults of `--since 1h` and `--last 50`, show every line. This was not reproduced. `--tail` prints only lines that arrive after it starts, and the runbook's helpers keep only their own events, so either would print nothing for these calls.
- **His two calls from his phone recorded two calls on DV-100001.** A third within 24 hours makes him a repeat caller (path D). T15's reset clears this before the review.

## S2 findings

**Date** 10 Oct 2026 · **Area** AI Assistants, conversation workflow

**Setup.** As in the S2 card, on the assistant `spike-routing` (`assistant-4e892a8f-91c3-4503-8e2f-86afcef47a3e`). A speak start node led to a tool node with the shared webhook tool `spike_log`, which posts `session_id` to the smoke function, and the tool node's edges led to prompt nodes A to D.

**Evidence.** The smoke function's runtime log has a `spike_log` POST with `session_id` `abc123` at 14:00:43, 14:04:39, 14:05:24 and 14:06:18 UTC. The calls are in the Conversation History of `spike-routing`.

**Calls.** Calls 1 to 3 were browser test calls from the portal, channel `web_call`.

- Call 1, with `area_outage` `"true"`, went from the speak node straight to "Outage branch" without the caller saying anything.
- Call 2, with `repeat_caller` `"true"`, gave "Repeat branch".
- Call 3, with both `"false"`, gave "Default branch". The edge `telnyx_conversation_duration_secs >= 20`, typed Number, never fired on the browser calls.
- On a real phone call to the account's US number the same edge fired, and node D said "Time branch".
- The assistant's greeting, "greeting field", never played. Only the speak node's line did.

The answers are at the end of `docs/WORKFLOW.md`, and ADR-010 is accepted.

**Portal findings.**

- The edge editor and the Dynamic Variables section list only the custom variables that appear in the assistant's text. Thiago referenced `area_outage`, `repeat_caller` and `session_id` in the instructions to make them selectable.
- The edge editor types the value `true` as a Boolean by default, so a comparison with the variable's string needs the String type set by hand.
- The defaults field warns that JSON-like values such as `true` are stored as plain strings.
- The Blank Workflow template starts with a prompt node whose type cannot be changed. Thiago added a speak node and set it as Start, and its edge came out as a default edge.
- The edge editor's Target Type menu listed only Workflow node, while `spike-routing` was the only assistant in the account.
- The phone number hung up instantly until it was attached to the assistant's application (`ai-assistant-<id>`), and for a few minutes after that, then worked. Browser test calls worked right away.

**Design impact.** Time-based edges are tested by phone (`docs/WORKFLOW.md`, path G, and T13), and the provisioning script sets every edge's value type explicitly (T11).

**Read back through the API, 12 October.** Thiago saved `GET /v2/ai/assistants/<id>` of `spike-routing` and `GET /v2/ai/tools` in `~/code/scratch/t11/`. They show how the API returns what the portal made, which T11's comparison relies on.

- Prompt nodes come back with `instructions_mode` `append`, `tools_mode` `replace`, `shared_tool_ids` null and `tools` empty. The workflow guide says a new node starts with every tool of the assistant, so that is how a node without tool settings reads.
- Tool nodes come back with the resolved `tool`, a `position`, and `message` null when they have none. Speak nodes carry a `position` too.
- Edges come back with `id`, `start_node_id`, `target` and `condition` only, and the Number literal reads `20.0`.
- The assistant has no `tool_ids` field. Its attached shared tool appears in `tools`, with `shared` true and its `tool_id`. `mcp_servers` is an empty list.
- A shared tool reads as `id`, `type`, `display_name`, `tool_definition`, `timeout_ms` and `created_at`. Telnyx's SDK creates one with the definition under a field named after its type, such as `webhook` (https://github.com/team-telnyx/telnyx-node/blob/master/api.md). The `spike_log` definition holds `name`, `description`, `url`, `method`, the three parameter schemas, `headers`, `async` and two preset fields. Telnyx's own "Default transfer" holds `targets` with `name` and `to`, and `from` set to `{{telnyx_agent_target}}`. "Default hangup" holds a `description`. Every tool has `timeout_ms` 5,000.
- The voice is `Telnyx.Ultra.f786b574-daa5-4673-aa0c-cbe3e8534c02` with its settings, and recording is on, dual channel, mp3.

## S3 findings

**Date** 10 Oct 2026 · **Area** Edge Compute, MCP transport

**The official SDK runs in the edge fetch handler.** `@modelcontextprotocol/sdk` 1.32.1 ships `WebStandardStreamableHTTPServerTransport` (`server/webStandardStreamableHttp.js`), a pure Web Standard transport: `Request`/`Response`/`ReadableStream`, no `node:` imports. In stateless mode (`sessionIdGenerator: undefined`) with `enableJsonResponse: true`, every POST gets one `application/json` body back and no `Mcp-Session-Id` header. The card's whole behaviour matrix passed locally against `telnyx-edge dev` (CLI 0.5.10): `initialize` echoes `2025-11-25` / `2025-06-18` / `2025-03-26` and answers `2025-06-18` to anything else (`2024-11-05` included), notifications get a bare 202, `ping` gets `{}`, `tools/list` and `tools/call` `echo` work, an unknown tool gets JSON-RPC error -32602 over HTTP 200, `GET /mcp` gets a 405 and unknown paths a 404, and every request writes one JSON log line with the rpc method/id, `user_agent`, `has_authorization` and the `mcp-protocol-version` header. MCP Inspector 2.10.1 (`--cli --transport http`) listed the tools and called `echo` with the text "hello" against the local server.

**Two SDK defaults needed overriding.** The negotiation: the SDK echoes the 2024-* versions and falls back to its own latest, so a `setRequestHandler` replacement pins the card's three versions and the `2025-06-18` fallback. And a stateless transport cannot be reused (`Stateless transport cannot be reused across requests`), so each POST builds a fresh `Server` + transport pair; both are plain objects, no I/O at construction.

**The SDK server enforces the Streamable HTTP accept rules itself.** A POST whose `Accept` lacks either `application/json` or `text/event-stream` gets a 406 JSON-RPC error before any dispatch. Worth knowing if a client (Telnyx included) ever sends a bare `Accept: application/json`.

**What the reference client (inspector's SDK client) sends locally.**

```text
{"event":"mcp_request","route":"mcp","status":200,"user_agent":"node","has_authorization":false,"mcp_protocol_version":null,"rpc_method":"initialize","rpc_id":0}
{"event":"mcp_request","route":"mcp","status":202,"user_agent":"node","has_authorization":false,"mcp_protocol_version":"2025-11-25","rpc_method":"notifications/initialized","rpc_id":null}
{"event":"mcp_request","route":"method_not_allowed","status":405,"user_agent":"node","has_authorization":false,"mcp_protocol_version":"2025-11-25"}
{"event":"mcp_request","route":"mcp","status":200,"user_agent":"node","has_authorization":false,"mcp_protocol_version":"2025-11-25","rpc_method":"tools/list","rpc_id":1}
{"event":"mcp_request","route":"mcp","status":200,"user_agent":"node","has_authorization":false,"mcp_protocol_version":"2025-11-25","rpc_method":"tools/call","rpc_id":2}
```

User agent is `node`. One `initialize` per connection, with integer id 0 and no `mcp-protocol-version` header; every request after it carries the negotiated version in that header, notifications included. Right after `initialize` the client opens `GET /mcp` for the server-to-client stream, takes our 405 without complaint and proceeds to `tools/list` and `tools/call`. JSON-RPC ids are integers counting up from 0 per connection.

**What Telnyx's client sends, deployed, 10 Oct.** Thiago shipped the spike to `https://mcp-spike-fdb8da70-9.telnyxcompute.com`, registered it through the API (`POST /v2/ai/mcp_servers`, type `http` accepted, id `f95f0bc9-c0c1-433e-9696-9910bd55523f`) and attached it to `spike-mcp`, a plain single-prompt assistant, instead of `spike-routing`, so the test stayed clear of the workflow and the smoke function. On a browser test call, asked to echo hello, the assistant said hello back. The runtime log for that call, from `telnyx-edge logs mcp-spike --type runtime`, trimmed to the fields that matter:

```text
[2026-10-10T19:33:34.315Z] {"event":"mcp_request","route":"mcp","status":200,"user_agent":"python-httpx/0.28.1","has_authorization":false,"mcp_protocol_version":null,"rpc_method":"initialize","rpc_id":0}
[2026-10-10T19:33:34.888Z] {"event":"mcp_request","route":"mcp","status":202,"user_agent":"python-httpx/0.28.1","has_authorization":false,"mcp_protocol_version":"2025-11-25","rpc_method":"notifications/initialized","rpc_id":null}
[2026-10-10T19:33:34.936Z] {"event":"mcp_request","route":"mcp","status":200,"user_agent":"python-httpx/0.28.1","has_authorization":false,"mcp_protocol_version":"2025-11-25","rpc_method":"tools/list","rpc_id":1}
[2026-10-10T19:33:40.744Z] {"event":"mcp_request","route":"mcp","status":200,"user_agent":"python-httpx/0.28.1","has_authorization":false,"mcp_protocol_version":"2025-11-25","rpc_method":"tools/call","rpc_id":2}
# telnyx-edge logs mcp-spike --type invocations, the same four requests
POST 200 51.359882ms   POST 202 10.307329ms   POST 200 9.473758ms   POST 200 15.197362ms
```

- One `initialize` at the start of the conversation, with JSON-RPC id 0 and no protocol header yet. The `tools/call` six seconds later came without a new `initialize`, so Telnyx's client initialises once per conversation, not per request.
- Protocol version `2025-11-25` on every request after `initialize`, one of the three versions the server accepts.
- User agent `python-httpx/0.28.1`, and no `authorization` header, because no credential was configured. S4 tests the bearer token.
- No `GET /mcp` at all, so the 405 never came into play, and no 406, so Telnyx's `Accept` header satisfies the SDK.
- Every request was a POST taking 9 to 51 ms on our side.

The S3 ship took about 4 min 30 s.

**MCP Inspector against the deployed server, 10 Oct.** Claude Code ran MCP Inspector 2.10.1's CLI against the deployed `/mcp` at 19:39 UTC. `tools/list` returned `echo` with its input schema, and `tools/call` with the text "hello" returned "hello". The log shows its requests in the same order as locally, `initialize`, `notifications/initialized`, a `GET /mcp` that got the 405 and was tolerated, then `tools/list` and `tools/call`, each 2 to 10 ms on our side.

## S4 findings

**Date** 10 Oct 2026 · **Area** AI Assistants, per-caller credentials

**Setup.** Thiago stored one key twice, as the integration secret `mcp_enc_key_spike` and the edge secret `MCP_ENC_KEY_SPIKE`, and shipped `mcp-spike` with the S4 code in about 4 min 30 s, the same as its S3 ship. The MCP server `mcp-spike` got `api_key_ref` `{{mcp_token | mcp_enc_key_spike}}`, and the assistant `spike-mcp` (`assistant-d67f035e-02e6-4a6d-ab5c-c4590afffb89`) points its dynamic variables webhook at the spike's `/dv`. The spike read the edge secret from its environment, and `/dv` returned the token.

**Good path, browser call at 20:22:56 UTC.** Telnyx called `/dv` with the user agent `ai_assistants`, and the spike logged token id `3HsBmLGb6RSB3sU6`. From 0.3 s later every MCP request carried the bearer token with the suffix `6RSB3sU6`, `initialize` and `notifications/initialized` included, through `tools/list` and the `tools/call` at 20:23:05. The assistant said hello back. So Telnyx decrypts `encrypted_dynamic_variables.mcp_token` with the integration secret and sends the plain token as the bearer token on every request of the conversation.

**Bad path, browser call at 20:24:23 UTC.** `/dv?mode=bad` returned a value that fails decryption, no `/mcp` request arrived, and the call crashed when the caller asked for the tool (issue 13).

---

## Template

```markdown
## N. Short description of the symptom

**Date** · **Area**

**Symptom.** What we saw.

**Evidence.** The log lines, command output or transcript that showed it.

**Cause.** What was actually wrong.

**Fix.** What we changed.

**Design impact.** The ADR or doc this changed, or "none".
```
