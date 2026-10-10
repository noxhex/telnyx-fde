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

**Again at the higher cap, 10 Oct 2026.** Reviewing T07, a 1,351-line diff, GLM-5.3 spent its last step on 16,386 tokens of reasoning and wrote no text, so the 16,384 cap can still be reached. This time `tools/card.sh` failed the run as `cutoff:reviewer` with exit 4, and the one `--review-only` rerun finished and approved. The fix works as intended. Bigger diffs make a cut-off more likely.

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

**Design impact.** Acceptance item 3 of T05 is only half provable locally, and the keyed half moves to T10. How the demo makes local keyed calls is open for Thiago.

## S1 measurements

Smoke test numbers so far, server side, from invocation logs. S1 adds KV timings and cold starts.

| Request | Duration |
|---|---|
| First request after the deploy | 537 ms |
| First request after a pause (four samples) | 287 to 309 ms |
| Follow-up requests (seven samples) | 139 to 155 ms |

Each of these requests includes one round trip to the counter actor.

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
