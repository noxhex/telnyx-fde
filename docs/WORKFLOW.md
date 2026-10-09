# Conversation workflow

This is the source of truth for the assistant's `conversation_flow`. The provisioning script (task T11) builds the API payload from `assistant/flow.ts`, which mirrors this document. Change this file first, then the code.

## Principles

- **Facts route through variable edges, intent through LLM edges** (ADR-011). Variable edges are listed in priority order, because the first true edge wins.
- **Every prompt node appends** to the base instructions, except Degraded, which replaces them (ADR-012).
- **Each node enables only its own tools.** Transfer and hangup run only as tool nodes.
- **Instructions never discourage tool calls.** On calls, LLM edges fire as transition tool calls, so the base prompt tells the model to call the matching transition as soon as the caller's need is clear.
- **Every boolean is the string `"true"` or `"false"`.**

## Variable contract

Defaults are set on the assistant, so a failed or slow webhook still produces a safe conversation. `session_ok` defaulting to `"false"` is what sends those calls to Degraded.

| Variable | Values | Default | Set by `/dv` from | Used by |
|---|---|---|---|---|
| `session_ok` | `"true"`, `"false"` | `"false"` | `"true"` whenever `/dv` completes | Route call, edge 1 |
| `session_id` | 32 hex characters | `"none"` | hash of the call control id | Route call tool argument |
| `greeting_line` | text | `"Hello"` | `"Hi Thiago"` for a number match, otherwise `"Hello"` | Disclosure |
| `first_name` | text | `"unknown"` | CRM | base instructions |
| `caller_known` | `"true"`, `"false"` | `"false"` | CRM match | base instructions |
| `identity_level` | `anonymous`, `number_match`, `attested` | `"anonymous"` | CRM match and `telnyx_end_user_target_verified` | base instructions |
| `needs_verification` | `"true"`, `"false"` | `"true"` | `"false"` only for `attested` | Route call, edge 4; Verify account |
| `verify_mode` | `full`, `postcode` | `"full"` | `postcode` for a number match | Verify account |
| `area_code` | postcode | `"unknown"` | CRM | base instructions |
| `area_name` | text | `"your area"` | CRM | Outage notice |
| `area_outage` | `"true"`, `"false"` | `"false"` | KV read model | Route call, edge 2 |
| `outage_eta` | spoken time | `"as soon as possible"` | KV read model | Outage notice |
| `repeat_caller` | `"true"`, `"false"` | `"false"` | `CustomerAccount.recordCall`, three or more calls in 24 hours | Route call, edge 3 |
| `diagnostics_enabled` | `"true"`, `"false"` | `"true"` | flag `diagnostics_enabled` | Diagnose, edge 1 |

The only encrypted variable is `mcp_token`, used as the MCP server credential through `{{mcp_token | mcp_enc_key}}`.

## Nodes

| Id | Name | Type | Tools enabled | Notes |
|---|---|---|---|---|
| `n_disclosure` | Disclosure | speak | | Start node |
| `n_route` | Route call | tool, shared webhook `log_disclosure` | | Routes on call setup variables |
| `n_verify` | Verify account | prompt, append | `verify_account`, `check_area_status` | |
| `n_outage_notice` | Outage notice | speak | | |
| `n_outage_help` | Outage help | prompt, append | `report_outage`, `subscribe_updates` (stretch) | |
| `n_triage` | Triage | prompt, append | none | Answers simple questions from its FAQ |
| `n_diagnose` | Diagnose | prompt, append | `run_line_diagnostics`, `report_outage` | |
| `n_ticket` | Repair ticket | prompt, append | `create_ticket` | |
| `n_handoff` | Handoff | speak | | |
| `n_transfer` | Transfer | tool, shared transfer tool | | Its one default edge is used only if the transfer fails |
| `n_message` | Take message | prompt, append | `create_ticket` | |
| `n_degraded` | Degraded | prompt, replace | none | |
| `n_end` | End call | tool, shared hangup tool, with a message | | Terminal |

## Edges

Edges are listed in declaration order, which is evaluation order for variable edges.

**Disclosure**
1. default → Route call

**Route call**
1. `session_ok != "true"` → Degraded
2. `area_outage == "true"` → Outage notice
3. `repeat_caller == "true"` → Handoff
4. `needs_verification == "true"` → Verify account
5. default → Triage

**Verify account**
1. LLM. "Verification succeeded, or the caller was already verified, and they need help with their connection or account." → Triage
2. LLM. "The caller only wanted to know whether there is an outage at a postcode, and has their answer." → End call
3. LLM. "The caller cannot verify, is locked out, or asks for a person." → Handoff

**Outage notice**
1. default → Outage help

**Outage help**
1. LLM. "The caller has a different problem from the outage, such as a fault that started earlier or a billing question." → Verify account
2. LLM. "The caller asks for a person." → Handoff
3. LLM. "The caller has what they need and is ready to end the call." → End call

**Triage**
1. LLM. "The caller's internet is down, slow or unstable." → Diagnose
2. LLM. "The caller needs a technician or reports physical damage, such as a cut cable or a broken fiber box." → Repair ticket
3. LLM. "The caller asks for a person." → Handoff
4. LLM. "The caller's question is answered and they are ready to end the call." → End call

**Diagnose**
1. `diagnostics_enabled != "true"` → Repair ticket
2. `telnyx_conversation_duration_secs >= 300` → Handoff
3. LLM. "Diagnostics show the line needs a repair visit, or the caller wants a technician." → Repair ticket
4. LLM. "The problem is fixed or explained and the caller is ready to end the call." → End call
5. LLM. "The caller asks for a person." → Handoff

**Repair ticket**
1. LLM. "The ticket is created and read back, and the caller is ready to end the call." → End call
2. LLM. "The caller asks for a person." → Handoff

**Handoff**
1. default → Transfer

**Transfer**
1. default → Take message (only when the transfer fails)

**Take message**
1. LLM. "The callback request is recorded and read back." → End call

**Degraded**
1. LLM. "The caller wants to speak with a person." → Handoff
2. LLM. "The caller will call back later or wants to end the call." → End call

## Scripted lines

These are delivered word for word.

| Node | Message |
|---|---|
| Disclosure | {{greeting_line}}, you've reached Duinvezel fiber support. I'm an automated assistant, and this call is recorded so we can improve our service. |
| Outage notice | There's a confirmed outage affecting {{area_name}}. Our engineers are working on it, and we expect your service back {{outage_eta}}. |
| Handoff | I'll connect you with one of our support engineers now. Please stay on the line. |
| End call | Thanks for calling Duinvezel. Goodbye. |

## Instructions

These are drafts for task T12. Keep them short, since every line costs latency on a voice call.

### Base instructions (assistant level)

```text
You are the voice assistant for Duinvezel, a fiber internet provider on the Belgian coast, and you speak with customers on the phone.

Style
- Use short sentences and ask one question at a time.
- Read numbers digit by digit and confirm important details by reading them back.
- Never read a full account number back. Use only its last three digits.

Rules
- State only facts that come from the caller, from a tool result or from the context below. Never invent a tool result.
- If a tool fails or is not available, say you cannot reach that system right now and offer to connect the caller with a person.
- Never ask for passwords or payment card details.

Moving on
- As soon as the caller's need matches one of your next steps, call the matching transition tool. Do not announce the step change.

Context for this call
- Caller first name {{first_name}}
- Known customer {{caller_known}}, identity level {{identity_level}}
- Area {{area_name}}, postcode {{area_code}}
- Outage in this area {{area_outage}}, expected back {{outage_eta}}
```

### Verify account (append)

```text
In this step you confirm the caller's identity before any account work.
- Verification mode is {{verify_mode}}. In postcode mode the caller's number already matched an account, so ask only for the postcode. In full mode, ask for the account number, which starts with DV, and then the postcode.
- Call verify_account once you have the answers. Never confirm or deny details yourself.
- If the result says the account is locked, say they can try again after the minutes the tool gives, and offer a person.
- Needs verification is {{needs_verification}}. If that is false, the caller is already verified, so move on to Triage without asking anything.
- If the caller only wants to know about an outage and does not want to verify, ask for their postcode and use check_area_status.
```

### Outage help (append)

```text
The caller is in an area with a confirmed outage, and has just heard about it.
- Ask whether their problem matches the outage. If it does, call report_outage with the symptom that fits, so the engineers can see how many customers are affected.
- If subscribe_updates is available, offer a text message when the service is back.
- Keep it short. Most callers only want to know it is being fixed.
```

### Triage (append)

```text
Find out what the caller needs in one or two questions, then move on.
Answer simple questions yourself, using only the FAQ below.

FAQ
- The support team takes calls from 08:00 to 20:00 on weekdays and from 09:00 to 17:00 on Saturdays.
- Restarting the fiber box means unplugging it for 30 seconds and plugging it back in.
- Duinvezel plans are Basic at 300 Mbps, Plus at 1 Gbps and Max at 2 Gbps.
- Bills go out on the first of the month, and can be paid by direct debit or bank transfer.
```

### Diagnose (append)

```text
Help with a connection that is down, slow or unstable.
- Call run_line_diagnostics first and explain the result in plain words.
- If the line is down and the result says nearby customers may be affected, call report_outage with the matching symptom. If that report declares a new incident, tell the caller our engineers have just been alerted.
- If the result suggests restarting the fiber box, walk the caller through it once.
- If a tool returns needs_verification, apologise and offer a person.
```

### Repair ticket (append)

```text
Create a repair ticket.
- Confirm the problem in one sentence and ask when someone is usually home.
- Call create_ticket with category repair_visit and a one-sentence summary.
- Read back the ticket number and the visit window.
```

### Take message (append)

```text
The transfer to a person did not go through. Apologise once, then take a callback request.
- Ask for a short description of the problem and a good time to call back.
- Call create_ticket with category callback.
- Read back the ticket number and when the team will call.
```

### Degraded (replace)

```text
You are the Duinvezel phone assistant. The account systems cannot be reached right now, so you cannot look anything up or make changes.
- Apologise once, say the systems are temporarily unavailable, and offer to connect the caller with a person.
- Do not promise anything about outages, accounts or repairs.
- If the caller prefers, tell them they can call back later.
- As soon as the caller wants a person or wants to end the call, call the matching transition tool.
```

## Paths to test

Every path gets at least one real phone call before the demo. The evidence column is what to look for in our logs and in the conversation transcript.

| Path | How to trigger | Expected nodes | Evidence |
|---|---|---|---|
| A. Known caller, outage in area | Demo number, area with an incident | Disclosure, Route call, Outage notice, Outage help, End call | `dv` with `area_outage=true`, `report_outage` call |
| B. Unknown caller | Any other number | Disclosure, Route call, Verify (full), Triage, Diagnose, Repair ticket, End call | `verify_account` ok, diagnostics, ticket |
| C. Number match, no outage | Demo number, quiet area | Verify (postcode), Triage, and on | `identity_level=number_match` |
| D. Repeat caller | Third call within 24 hours | Handoff, Transfer | `repeat_caller=true` |
| E. Webhook down | Flag `dv_force_error` | Degraded, then Handoff or End call | `dv` 500 log, defaults used |
| F. Diagnostics switched off | Flag `diagnostics_enabled=false` | Diagnose jumps straight to Repair ticket | no `run_line_diagnostics` call |
| G. Time guard | Stay in Diagnose past 300 s (lower it in a test version) | Handoff | duration in transcript |
| H. Lockout | Three wrong postcodes, then a second call | Locked on both calls, Handoff | `CustomerAccount.verify` returns `locked` |
| I. Threshold crossing | `scripts/simulate-reports.ts` twice, then a live report | Incident declared once, next caller hears Outage notice | `incident_declared=true` exactly once |
| J. Token failure | Wrong `MCP_ENC_KEY` in a test deploy | Tools missing, model offers a person | no MCP requests for the trace id |
| K. Transfer fails | Invalid transfer target in a test version | Take message | `create_ticket` with category `callback` |

## Open questions for spike S2

1. Do variable edges on a tool node work with custom dynamic variables, or only with `telnyx_last_tool_status_code`?
2. Which literal type does a numeric comparison take, for `telnyx_conversation_duration_secs >= 300`?
3. Does the assistant's own greeting play in addition to a speak start node, or should it be empty?
4. Does a shared webhook tool on a tool node receive `session_id` from a dynamic variable of the same name?
5. What does an edge targeting another assistant look like in the API (stretch, for a second-line assistant)?
