# S2. Workflow routing on a tool node

**Type** Spike · **Code** none · **Hands-on** Thiago, in the portal or through the API · **Needs** S1 shipped (for the POST logging)

## Goal

Answer the five open questions at the end of `docs/WORKFLOW.md` with a real assistant before we build on the router design (ADR-010). No webhook is needed, because dynamic variable defaults on the assistant are enough to drive the routing.

## Setup

1. **Shared webhook tool** `spike_log`. POST to `https://smoke-0be3d15b-5.telnyxcompute.com/spike-log`, with one body parameter `session_id` (string). The smoke function logs the body and returns 200.
2. **Assistant** `spike-routing`, model `moonshotai/Kimi-K2.6`, any voice. Set the assistant greeting to the words "greeting field", so you can hear whether it plays.
3. **Dynamic variable defaults** on the assistant.

   | Variable | Value |
   |---|---|
   | `session_id` | `abc123` |
   | `greeting_line` | `Hi Thiago` |
   | `area_outage` | `true` |
   | `repeat_caller` | `false` |

4. **Workflow.**
   - Start with a speak node, message "{{greeting_line}}, this is the routing spike.", with one default edge to the tool node.
   - Tool node using `spike_log`, with edges in this order. `area_outage == "true"` goes to prompt node A. `repeat_caller == "true"` goes to prompt node B. The default edge goes to prompt node C.
   - Prompt nodes A, B and C each say a fixed sentence ("Outage branch", "Repeat branch", "Default branch") and have no edges.
   - Prompt node C also gets a variable edge `telnyx_conversation_duration_secs >= 20` to a prompt node D that says "Time branch".
5. Assign the US number to `spike-routing` for the test, and move it later.

## Tests

| # | Change | Call and listen for | Answers question |
|---|---|---|---|
| 1 | Defaults as above | Outage branch, right after the speak node, without you saying anything | 1 |
| 2 | `area_outage=false`, `repeat_caller=true` | Repeat branch | 1, edge order |
| 3 | Both `false` | Default branch, then after 20 s and one sentence from you, Time branch | 2 |
| 4 | Any | Whether "greeting field" is spoken as well as the speak node | 3 |
| 5 | Any | `telnyx-edge logs smoke --type runtime` shows `session_id` `abc123` in the POST body | 4 |

For question 5 (an edge to another assistant), check the Assistants API reference and the portal's edge editor. No call is needed.

## Done when

- The open questions in `docs/WORKFLOW.md` are replaced by answers, each with the evidence (log line or call time).
- ADR-010 is marked Accepted, or rewritten if routing on a tool node does not work. The fallback is a prompt node router whose instructions make the model call the transition immediately.
- Anything surprising goes into `DEBUGLOG.md`.
