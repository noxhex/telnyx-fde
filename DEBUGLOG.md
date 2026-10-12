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

The table gets these numbers together with the CRM timeouts, from the timing run after the re-ship.

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
