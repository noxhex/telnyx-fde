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
