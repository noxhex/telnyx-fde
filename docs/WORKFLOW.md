# Conversation workflow

This is the source of truth for the assistant's `conversation_flow`. The provisioning script (task T11) builds the API payload from `assistant/flow.ts`, which mirrors this document. Change this file first, then the code.

## Principles

- **Facts route through variable edges, intent through LLM edges** (ADR-011). Variable edges are listed in priority order, because the first true edge wins.
- **Every prompt node appends** to the base instructions, except Degraded, which replaces them (ADR-012).
- **Each prompt node's instructions name the tools it may use** (ADR-020). Every prompt node sees all five MCP tools, because Telnyx documents no per-node limit for MCP tools, and the server's identity checks are the gate. Transfer, hangup and the disclosure log run only as tool nodes.
- **No instruction or message carries `session_id` or `mcp_token`.**
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

| Id | Name | Type | Tools its instructions name | Notes |
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

Every variable edge sets its value type explicitly, String for the `"true"` and `"false"` comparisons and Number for the duration, because the portal's editor types `true` as a Boolean by default (S2, answer 1). The provisioning script sets the types and never relies on a default. Time-based edges fire only on phone calls, not on browser test calls (S2, answer 2), so they are tested by phone.

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
2. LLM. "The caller only wanted to know whether there is an outage at a postcode and has their answer, or wants to end the call." → End call
3. LLM. "The caller cannot verify, is locked out, or asks to talk to a person, such as an engineer or an agent." → Handoff

**Outage notice**
1. default → Outage help

**Outage help**
1. LLM. "The caller has a different problem from the outage, such as a fault that started earlier or a billing question." → Verify account
2. LLM. "The caller asks to talk to a person, such as an engineer or an agent." → Handoff
3. LLM. "The caller has nothing more to ask, or wants to end the call." → End call

**Triage**
1. LLM. "The caller's internet is down, slow or unstable, or they ask for a line check." → Diagnose
2. LLM. "The caller needs a technician or reports physical damage, such as a cut cable or a broken fiber box." → Repair ticket
3. LLM. "The caller asks to talk to a person, such as an engineer or an agent." → Handoff
4. LLM. "The caller has nothing more to ask, or wants to end the call." → End call

**Diagnose**
1. `diagnostics_enabled != "true"` → Repair ticket
2. `telnyx_conversation_duration_secs >= 300` → Handoff
3. LLM. "Diagnostics show the line needs a repair visit, or the caller wants a technician." → Repair ticket
4. LLM. "The caller has nothing more to ask, or wants to end the call." → End call
5. LLM. "The caller asks to talk to a person, such as an engineer or an agent." → Handoff

**Repair ticket**
1. LLM. "The caller has nothing more to ask, or wants to end the call." → End call
2. LLM. "The caller asks to talk to a person, such as an engineer or an agent." → Handoff

**Handoff**
1. default → Transfer

**Transfer**
1. default → Take message (only when the transfer fails)

**Take message**
1. LLM. "The callback request is recorded and read back, the caller does not want one, or the caller wants to end the call." → End call

**Degraded**
1. LLM. "The caller wants to speak with a person." → Handoff
2. LLM. "The caller will call back later or wants to end the call." → End call

## Scripted lines

These are delivered word for word.

| Node | Message |
|---|---|
| Disclosure | {{greeting_line}}, you've reached Duinvezel fiber support. I'm an automated assistant, and this call is recorded so we can improve our service. |
| Outage notice | There's a confirmed outage affecting {{area_name}}. Our engineers are working on it, and we expect your service back {{outage_eta}}. Is that why you're calling, or is there something else I can help with? |
| Handoff | I'll connect you with one of our support engineers now. Please stay on the line. |
| End call | Thanks for calling Duinvezel. Goodbye. |

## Instructions

These are drafts for task T12. Keep them short, since every line costs latency on a voice call.

### Base instructions (assistant level)

```text
You are the voice assistant for Duinvezel, a fiber internet provider on the Belgian coast, and you speak with customers on the phone.

Style
- Use short sentences and ask one question at a time.
- Never repeat the recording notice or the opening question. Once the caller has said why they are calling, act on it, and if part of it was unclear, ask only about that part.
- Read account numbers, postcodes and ticket numbers digit by digit, and confirm important details by reading them back. Say other numbers, such as minutes and times, the normal way.
- Never read a full account number back. Use only its last three digits.
- Once the caller is verified, call them by their first name.

Rules
- State only facts that come from the caller, from a tool result or from the context below. Never invent a tool result.
- If a tool fails or is not available, say you cannot reach that system right now and offer to connect the caller with a person.
- Never ask for passwords or payment card details.
- Never say how many outage reports an area has, or how many it takes to declare an outage.
- Report an outage only when the caller says their service is down completely and agrees to the report. Never report slow or dropping internet as an outage.

People and callbacks
- When the caller asks to talk to a person, such as an engineer or an agent, call the transition to a person straight away, even before verification. Offer a callback only if the transfer does not go through.
- Create a callback ticket only after the caller has agreed to a callback.
- Before you create any ticket, ask what time suits the caller and put it in the summary. Create it once, because a second request for the same kind of ticket returns the same ticket number.
- Read back the ticket number and the window from the result, and never promise another time. If the caller asked for a different time, say it is noted on the ticket.

Moving on
- As soon as the caller's need matches one of your next steps, call the matching transition tool. Do not announce the step change.
- Never say goodbye yourself. When the caller has nothing more to ask or wants to end the call, call the transition that ends the call straight away. It says goodbye and hangs up.

Context for this call
- Caller first name {{first_name}}
- Known customer {{caller_known}}, identity level {{identity_level}}
- Area {{area_name}}, postcode {{area_code}}
- Outage in this area {{area_outage}}, expected back {{outage_eta}}
- Routing flags session ok {{session_ok}}, outage {{area_outage}}, repeat caller {{repeat_caller}}, needs verification {{needs_verification}}, diagnostics on {{diagnostics_enabled}}
```

The last line names every custom variable an edge reads, and nothing else, because in S2 the portal listed a custom variable only once it appeared in the assistant's text (DEBUGLOG, S2 findings). `telnyx_conversation_duration_secs` is a system variable, and that rule covered only custom variables.

### Verify account (append)

```text
In this step you confirm the caller's identity before any account work.
- If the call has just started, speak first, before the caller says anything, and ask "How can I help you today?".
- Verification mode is {{verify_mode}}. In postcode mode the caller's number already matched an account, so ask only for the postcode. In full mode, ask for the account number, which starts with DV, and then the postcode.
- Call verify_account only once the caller has given every answer this mode needs. If one is missing, ask for it. Never guess an answer or leave one empty, and never confirm or deny details yourself.
- When the result says verified, thank the caller by the first name it gives, then go on with what they asked for.
- If the result says the account is locked, say they can try again after the minutes the tool gives, and offer a person.
- If the result says account_number_unclear or postcode_unclear, the caller's answer was probably misheard. Ask them to repeat it one character at a time, then call verify_account again. This does not count as a failed attempt.
- If the result says account_number_needed or postcode_needed, ask for that answer, then call verify_account again.
- Needs verification is {{needs_verification}}. If that is false, the caller is already verified, so move on to Triage without asking anything.
- If the caller only wants to know about an outage and does not want to verify, ask for their postcode and use check_area_status.
```

### Outage help (append)

```text
The caller is in an area with a confirmed outage. They have just heard about it and been asked whether it is why they are calling.
- If it is, offer to add their report if their service is down completely, or to connect them with a person. Make both offers in one sentence.
- Call report_outage with the symptom no_connection only if they say their service is down completely and agree.
- Never report slow or dropping internet as an outage.
- Keep it short. Most callers only want to know it is being fixed.
```

### Triage (append)

```text
Find out what the caller needs in one or two questions, then move on. If they have already said what they need, move on straight away.
If the call has just started, speak first and ask "How can I help you today?".
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
- Call report_outage only when the caller says their service is down completely. Ask first whether they want to report it as an outage, and call it with the symptom no_connection only if they agree. If that report declares a new incident, tell the caller our engineers have just been alerted.
- Never report slow or dropping internet as an outage, whatever the line check shows.
- If the result suggests restarting the fiber box, walk the caller through it once.
- If a tool returns needs_verification, apologise and offer a person.
```

### Repair ticket (append)

```text
Create a repair ticket.
- Confirm the problem in one sentence and ask when someone is usually home.
- Call create_ticket once, with category repair_visit and a one-sentence summary that includes when someone is home.
- Read back the ticket number and the visit window from the result.
```

### Take message (append)

```text
The transfer to a person did not go through. Apologise once, then offer a callback.
- If the caller wants one, ask for a short description of the problem and a good time to call back.
- Call create_ticket once, with category callback and a summary that includes the time they gave.
- Read back the ticket number and the window from the result. If the window differs from the time they gave, say that time is noted on the ticket.
```

### Degraded (replace)

```text
You are the Duinvezel phone assistant. The account systems cannot be reached right now, so you cannot look anything up or make changes.
- Speak first, as soon as this step starts. Apologise once, say the systems are temporarily unavailable, and offer to connect the caller with a person.
- Do not promise anything about outages, accounts or repairs.
- If the caller prefers, tell them they can call back later.
- As soon as the caller wants a person or wants to end the call, call the matching transition tool. Never say goodbye yourself.
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
| G. Time guard | Stay in Diagnose past 300 s (lower it in a test version), on a phone call, because browser test calls never fire a time-based edge | Handoff | duration in transcript |
| H. Lockout | Three wrong postcodes, then a second call | Locked on both calls, Handoff | `CustomerAccount.verify` returns `locked` |
| I. Threshold crossing | `scripts/simulate-reports.ts` twice, then a live report | Incident declared once, next caller hears Outage notice | `incident_declared=true` exactly once |
| J. Token failure | Wrong `MCP_ENC_KEY` in a test deploy | Telnyx's docs say the tools go missing and the model offers a person, but in S4 a browser call crashed at the first tool use (DEBUGLOG issue 13) | no MCP requests for the trace id |
| K. Transfer fails | Invalid transfer target in a test version | Take message | `create_ticket` with category `callback` |

## Answers from spike S2

Spike S2 ran on 10 October on the assistant `spike-routing` (`assistant-4e892a8f-91c3-4503-8e2f-86afcef47a3e`). The evidence is the smoke function's runtime log, with `spike_log` POSTs at 14:00:43, 14:04:39, 14:05:24 and 14:06:18 UTC, and the assistant's Conversation History (DEBUGLOG, S2 findings).

1. **Variable edges on a tool node work with custom dynamic variables.** On a browser test call with `area_outage` set to `"true"`, the call went from the speak node straight to "Outage branch", without the caller saying anything. With `repeat_caller` set to `"true"` it took "Repeat branch". The comparison is against the String `"true"`. The portal's edge editor picks the Boolean type for `true` by default, so the type has to be set.
2. **A numeric comparison takes a Number literal.** The edge `telnyx_conversation_duration_secs >= 20`, with the value typed as Number, never fired on browser test calls. On a real phone call the same edge fired and node D said "Time branch".
3. **A speak start node replaces the assistant's greeting.** The greeting, set to the words "greeting field", did not play. Only the speak node's line did. On 13 October the calls most likely heard both, with the greeting set to the Disclosure line (DEBUGLOG issue 18), so T23 sends an empty greeting.
4. **A shared webhook tool on a tool node receives `session_id` from the dynamic variable of the same name.** Every `spike_log` POST carried `abc123`, the variable's default.
5. **An edge to another assistant is still open.** The edge editor's Target Type menu listed only Workflow node, but `spike-routing` was the only assistant in the account then, so an assistant target may appear only once a second one exists. The API reference settles it before T16.
