/**
 * `scripts/provision/client.ts` — the HTTP client the provisioning run uses.
 * It takes an injected `fetch` and an injected timeout runner, so the tests
 * record every request and fire timeouts by hand. Every request carries the
 * API key only in the `Authorization` header, is aborted when its 15-second
 * budget fires, and gets its body validated by the caller's zod schema before
 * the script reads it.
 */

import { createHash } from "node:crypto";

import { z } from "zod";

import { ApiError, HttpTimeoutError, ResponseShapeError, TimeoutFiredError } from "./errors.ts";

export const API_BASE_URL = "https://api.telnyx.com/v2";
export const REQUEST_TIMEOUT_MS = 15_000;

/** The `fetch` shape the client needs — Node's global `fetch` satisfies it. */
export type FetchInit = {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
};
export type FetchResult = {
  status: number;
  text: () => Promise<string>;
};
export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResult>;

/**
 * Runs `work` under a budget of `ms` milliseconds. The runner hands `work` an
 * AbortSignal, and when the budget fires it rejects with `TimeoutFiredError`
 * and aborts the signal, so the underlying request is cancelled. A late settle
 * of `work` after the timeout is ignored.
 */
export type TimeoutRunner = <T>(work: (signal: AbortSignal) => Promise<T>, ms: number) => Promise<T>;

/** The production timeout runner, built on `AbortController` and `setTimeout`. */
export const realTimeoutRunner: TimeoutRunner = <T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<T> => {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutFiredError());
    }, ms);
    work(controller.signal).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
};

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type ClientRequest<T> = {
  method: HttpMethod;
  /** Path under the base URL, without a query string, for example `/ai/tools`. */
  path: string;
  /** Query parameters, encoded with `URLSearchParams` so an E.164 `+` reaches the API as `%2B`. */
  query?: Record<string, string>;
  body?: unknown;
  idempotencyKey?: string;
  schema: z.ZodType<T>;
};

export type Client = {
  request: <T>(req: ClientRequest<T>) => Promise<T>;
};

const errorBodySchema = z.looseObject({
  errors: z.array(
    z.looseObject({
      code: z.string().optional(),
      title: z.string().optional(),
      detail: z.string().optional(),
    }),
  ),
});

/**
 * Builds the client. `apiKey` is written to the `Authorization` header of
 * every request and nowhere else.
 */
export function createClient(input: {
  fetchImpl: FetchLike;
  timeoutRunner: TimeoutRunner;
  apiKey: string;
  baseUrl?: string;
}): Client {
  const { fetchImpl, timeoutRunner, apiKey } = input;
  const baseUrl = input.baseUrl ?? API_BASE_URL;

  async function request<T>(req: ClientRequest<T>): Promise<T> {
    const query = req.query !== undefined ? `?${new URLSearchParams(req.query).toString()}` : "";
    const url = `${baseUrl}${req.path}${query}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
    let bodyText: string | undefined;
    if (req.body !== undefined) {
      headers["Content-Type"] = "application/json";
      bodyText = JSON.stringify(req.body);
    }
    if (req.idempotencyKey !== undefined) {
      headers["Idempotency-Key"] = req.idempotencyKey;
    }

    let response: { status: number; bodyText: string };
    try {
      response = await timeoutRunner(async (signal) => {
        const res = await fetchImpl(url, { method: req.method, headers, body: bodyText, signal });
        return { status: res.status, bodyText: await res.text() };
      }, REQUEST_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof TimeoutFiredError) {
        throw new HttpTimeoutError(req.method, req.path, REQUEST_TIMEOUT_MS);
      }
      throw error;
    }

    if (response.status < 200 || response.status >= 300) {
      let code: string | undefined;
      let title: string | undefined;
      try {
        const parsed = errorBodySchema.safeParse(JSON.parse(response.bodyText));
        if (parsed.success && parsed.data.errors.length > 0) {
          code = parsed.data.errors[0].code;
          title = parsed.data.errors[0].title;
        }
      } catch {
        // Not a JSON error body: report the status alone.
      }
      throw new ApiError(req.method, req.path, response.status, code, title);
    }

    let json: unknown;
    try {
      json = JSON.parse(response.bodyText);
    } catch {
      throw new ResponseShapeError(req.method, req.path, "body is not JSON");
    }
    const parsed = req.schema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const detail = issue !== undefined ? `${issue.path.join(".") || "(root)"}: ${issue.message}` : "invalid";
      throw new ResponseShapeError(req.method, req.path, detail);
    }
    return parsed.data;
  }

  return { request };
}

/**
 * The `Idempotency-Key` of a create (ADR-015, DEBUGLOG issue 5): a create that
 * timed out and is run again sends the same body, so it sends the same key and
 * gets replayed instead of doubled.
 */
export function idempotencyKey(kind: "tool" | "mcp-server" | "assistant", body: unknown): string {
  const digest = createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex");
  return `duinvezel-${kind}-${digest.slice(0, 16)}`;
}
