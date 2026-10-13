/**
 * The CustomerAccount actor client for voice-tools' own binding (T19,
 * ADR-006). One instance per CRM account; the instance name is the account
 * number. voice-tools ships the class, so this client speaks the class's
 * own types directly — no wire re-validation, exactly like `sessions.ts`.
 *
 * Every method passes the session's `traceId` through as the actor's
 * `traceId` argument, so the actor's log lines join the call's trace
 * (docs/ARCHITECTURE.md, Observability). Timeouts are the caller's job
 * (the tool wraps the call in the injected `TimeoutRunner`).
 */

import type { ActorNamespace } from "@telnyx/edge-runtime";

import type {
  CreateTicketResult,
  VerifyInput,
  VerifyResult,
} from "../domain/customer-account.js";
import type { NewTicketInput } from "../actors/customer-account.js";

export interface AccountsClient {
  /** Check submitted details against the CRM's expected values, counting failures and lockouts. */
  verify(accountNumber: string, input: VerifyInput, traceId: string): Promise<VerifyResult>;
  /** Create a ticket, idempotently per dedupe key (ADR-015). */
  createTicket(
    accountNumber: string,
    input: NewTicketInput,
    traceId: string,
  ): Promise<CreateTicketResult>;
  /** The demo reset (T15): clear calls, verification failures and the lock; tickets survive. */
  reset(accountNumber: string, traceId: string): Promise<void>;
}

interface CustomerAccountRpc {
  verify(input: VerifyInput, traceId?: string): Promise<VerifyResult>;
  createTicket(input: NewTicketInput, traceId?: string): Promise<CreateTicketResult>;
  reset(traceId?: string): Promise<void>;
}

export function createAccountsClient(namespace: ActorNamespace): AccountsClient {
  const stubFor = (accountNumber: string): CustomerAccountRpc =>
    namespace.idFromName(accountNumber) as unknown as CustomerAccountRpc;
  return {
    verify(accountNumber, input, traceId) {
      return stubFor(accountNumber).verify(input, traceId);
    },
    createTicket(accountNumber, input, traceId) {
      return stubFor(accountNumber).createTicket(input, traceId);
    },
    reset(accountNumber, traceId) {
      return stubFor(accountNumber).reset(traceId);
    },
  };
}
