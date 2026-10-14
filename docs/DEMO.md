# Demo script

Skeleton for the review session. Finalise it in T17 once every path works.

## Before the session

- Raise or remove the daily inference spend cap, which also limits the assistant's own model calls.
- Reset the demo state, warm the functions and put two simulated reports on 8670, as the README says under "Before a demo".
- Check with `scripts/demo.sh flags` that every flag has its default value.
- Open three terminals, tailing `voice-context`, tailing `voice-tools`, and one free for commands.
- Open the assistant's conversation history in the portal, and have MCP Inspector ready as a fallback.
- Charge the phone.

## Live demo, 8 to 10 minutes

| Time | What happens | What it shows |
|---|---|---|
| 0:00 | The problem in one sentence, and the architecture diagram | Use case |
| 0:30 | Call 1 from the demo phone, area 8630 quiet. Greeting by name, the disclosure, postcode verification, "my internet is down", diagnostics, an outage report counted as 1 of 3 | Dynamic variables, speak node, workflow steps, MCP calls, CustomerAccount and AreaIncident actors, the trace id in the live logs |
| 3:30 | `scripts/demo.sh reports 8630 2`. The second simulated report crosses the threshold, and the area status changes in KV | Exactly-once declaration, the outbox publish, KV read model |
| 5:00 | Call 2 from the same phone. It hears the outage notice seconds into the call, before saying anything | Variable routing on data, a speak node with variables |
| 6:00 | `scripts/demo.sh reset`, then `scripts/demo.sh reports 8670 2`. Run them only when no reviewer call is in progress. Call 3 waits about 15 seconds after them, because the cleared status of 8630 reaches KV a few seconds after the reset and warm replicas keep area statuses for 10 seconds | A clean start for call 3. 8630 is out of outage, and the demo phone is not a repeat caller |
| 6:30 | `scripts/demo.sh flags set crm_fail true`. Call 3 still greets him by name from the KV cache, but diagnostics fail, and the assistant says so and offers a person | Observability, feature flags without a redeploy, the cache absorbing a CRM outage, graceful degradation |
| 8:00 | Restore the flag with `scripts/demo.sh flags set crm_fail false`. The reviewers call the number themselves as unknown callers, if they like | Unknown caller path |

## Walkthrough, 7 to 10 minutes

1. Why this use case, and who it serves.
2. The workflow. The router tool node, variable edges against LLM edges, speak nodes for anything verbatim, append against replace, and tools scoped per node.
3. The MCP server. Stateless, the per-call token, identity levels, and why tools never take an account id.
4. Where each piece of state lives, using the table in `docs/ARCHITECTURE.md`.
5. Telnyx Inference through OpenCode. The bake-off, the roles, and what the ledger shows.
6. The hardest bug, told from `DEBUGLOG.md` with its evidence.
7. Tradeoffs and what we would do next.

## Questions to prepare for

| Question | Where the answer is |
|---|---|
| Why an actor and not KV for outage reports? | ADR-004 |
| Why not read area status from the actor? | ADR-005 |
| What happens if the webhook is slow or down? | ARCHITECTURE, Failure modes |
| How does the MCP server know who is calling? | ADR-008 |
| Can a caller trick the model into another account? | ADR-008, ADR-013 |
| Why did routing go on a tool node? | ADR-010 |
| How would you know within a minute that it broke? | ADR-017, README |
| How did the Telnyx models do? | DOGFOODING.md |
