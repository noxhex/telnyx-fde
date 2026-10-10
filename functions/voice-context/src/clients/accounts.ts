/**
 * The CustomerAccount shared-actor client (hand-rolled stub narrowing, per
 * the shared-actors doc: voice-context ships no class, it reaches the class
 * voice-tools ships through the `CUSTOMER_ACCOUNT` binding). Only the two
 * methods /dv and /internal/health call are typed here; the instance name
 * is the account number.
 *
 * `recordCall` takes the callId and nowMs, with the trace id as the second
 * argument, and the result repeats the actor's: `repeatCaller` from the
 * third call in 24 hours. Results over RPC are plain JSON, validated before
 * use — a shape drift degrades to an actor failure instead of corrupting a
 * variable.
 */

import type { ActorNamespace } from "@telnyx/edge-runtime";

export interface RecordCallOutcome {
  repeatCaller: boolean;
}

export interface AccountsClient {
  recordCall(
    accountNumber: string,
    input: { callId: string; nowMs: number },
    traceId: string,
  ): Promise<RecordCallOutcome>;
  /** The canary's deep health check only needs the call to succeed. */
  snapshot(accountNumber: string): Promise<unknown>;
}

interface CustomerAccountRpc {
  recordCall(input: { callId: string; nowMs: number }, traceId: string): Promise<unknown>;
  snapshot(): Promise<unknown>;
}

function asRecordCallOutcome(raw: unknown): RecordCallOutcome {
  if (
    raw !== null &&
    typeof raw === "object" &&
    typeof (raw as { repeatCaller?: unknown }).repeatCaller === "boolean"
  ) {
    return { repeatCaller: (raw as { repeatCaller: boolean }).repeatCaller };
  }
  throw new Error("CustomerAccount.recordCall returned an unexpected shape");
}

export function createAccountsClient(namespace: ActorNamespace): AccountsClient {
  const stubFor = (accountNumber: string): CustomerAccountRpc =>
    namespace.idFromName(accountNumber) as unknown as CustomerAccountRpc;
  return {
    async recordCall(accountNumber, input, traceId) {
      const raw = await stubFor(accountNumber).recordCall(input, traceId);
      return asRecordCallOutcome(raw);
    },
    async snapshot(accountNumber) {
      return stubFor(accountNumber).snapshot();
    },
  };
}
