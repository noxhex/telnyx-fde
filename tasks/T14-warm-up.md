# T14. A warm-up before the review

**Phase** 2 · **Depends on** T22 · **Code by** implementer agent

**Not run.** On 13 October Thiago chose the warm-up his runbook already has, `t10_smoke` then `t10_inspector`, and the README describes it. The canary design went into the README too. This card stays as the record of the script design.

## Goal

Before the review, Thiago runs one script. It makes every replica of the three functions read its secrets and flags, so the reviewers' calls meet warm replicas.

- **Why it works.** After T22 any request starts a replica's reads, and mock-crm has done so since T20. Once read, the values stay for the life of the replica (DEBUGLOG issue 17).
- **What the script does.** It sends enough requests, in parallel rounds, to reach every replica. It stops when a round comes back warm.
- **What changed.** Thiago shrank T14 to this on 13 October. The canary actor from the outline in `tasks/later.md` goes into the README as the next step.

T22's code is what makes a cold first call survive. This script makes that case rare.

## Read first

- `DEBUGLOG.md`, issue 17 and the T10 measurements.
- `tasks/T22-cold-replicas.md`.
- `functions/voice-context/src/routes/internal-health.ts`, the answer of `GET /internal/health`.
- `scripts/provision.ts` and `scripts/provision/`, for the style of a script and its tests.
- `AGENTS.md`.

## Files

`scripts/warm-up.ts`, which is new, any helpers under `scripts/warm-up/`, and `scripts/test/warm-up.test.ts`. No new dependency, and no change to any function. Like the provisioning script, it imports nothing from `packages/` or `functions/`.

## Behaviour

- **Configuration.** The script reads the three invoke URLs from `infra/ids.json` and `INTERNAL_KEY` from the environment. It never prints the key.
- **A round.** Each round sends these requests at the same time, with a 10 s timeout each:
  - `--per-round` requests to `GET /healthz` on each of the three functions;
  - `--per-round` requests to `GET /internal/health` on voice-context with `x-internal-key`. That route's CRM lookup and actor calls also exercise mock-crm and voice-tools' actors.
- **Per-round output.** For each function the script prints:
  - the count of answers by status;
  - the slowest answer;
  - for the health calls, the slowest `crm` check and the number of answers with `ok` false.
- **Warm.** A round is warm when every request answers 200, every health answer has `ok` true, and every `crm` check took under 200 ms.
- **Stopping.** The script stops after the first warm round, or after `--rounds` rounds, and waits 2 s between rounds. It exits 0 when the last round is warm and 1 otherwise.
- **Defaults.** `--rounds` defaults to 5 and `--per-round` to 12. `--dry-run` prints the plan and sends nothing.

## Tests

- A run with a fake fetch where the first round has a slow `crm` check and the second does not stops after round two and exits 0.
- A run that never warms exits 1 after `--rounds`.
- A request that times out, and a status other than 200, both make the round not warm.
- Test both options twice, once omitted so the default applies and once set to another value.
- `--dry-run` sends nothing.
- The key never appears in the output.
- A missing `INTERNAL_KEY` or `infra/ids.json` stops with a message that names the missing piece and never a value.

## Acceptance

- [ ] `npm run check` passes.
- [ ] After the T22 ships, Thiago runs `node scripts/warm-up.ts` and it ends with a warm round. The next call from `DEMO_CALLER_PHONE` shows no secret read in its `dv` line, with `http` near 0.

## Out of scope

- The canary actor and its alerts. These go into the README as the next step.
- Any function code.
