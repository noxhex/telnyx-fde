# Duinvezel fiber support

A Telnyx AI voice assistant for Duinvezel, a fictional fiber provider on the Belgian coast. It runs on Telnyx Edge Compute with a custom MCP server. The rest of this README comes with card T17.

## Call the assistant

Call **+1 650 536 0717**.

- **The start of the call.** You hear a short notice that the call is recorded, and then the assistant asks how it can help.
- **Verification.** Your number is not on file, so the assistant asks for an account number and a postcode before it acts on an account.
- **Four test accounts.** Each one shows one scenario, so a lockout on one never blocks the others.

| Account | Postcode | Name | Try saying | What it shows |
|---|---|---|---|---|
| DV-100004 | 8620 | Lotte | "My internet is slow." | Verification, then a line test that comes back clean |
| DV-100005 | 8660 | Wout | "My connection keeps dropping." | The line test finds a problem. The assistant walks you through a restart and books a repair visit with a time window |
| DV-100006 | 8670 | Anke | "I have no internet at all." | The line test shows the line down. Your outage report is the third from Koksijde, so the area goes into outage with an ETA, and the next caller from 8670 hears an outage notice first |
| DV-100007 | 8600 | Geert | Give a wrong postcode three times | The account locks for 15 minutes, and the assistant transfers you to a support engineer |

Before the review the demo state is reset, and two simulated outage reports are put on 8670.

Thiago shows the recognised-caller path from his own phone. That path is a greeting by name, a postcode-only check and the outage notice for his area.
