/**
 * `POST /mcp` — the MCP endpoint the assistant calls during a conversation
 * (card T09, ADR-009). The bearer token is verified and the session loaded
 * before anything else happens — before the body is even read, because the
 * token is a header, so an unauthenticated request never costs a body read
 * (ADR-014). Every authenticated request then gets a fresh stateless
 * server bound to its own session.
 *
 * One `mcp` log line per request, with the JSON-RPC method (peeking at the
 * body text before the SDK parses it), tool and workflow node for
 * `tools/call`, the session's trace id and identity, the outcome, the HTTP
 * status and the per-hop latencies. Auth failures log `auth_failed` with
 * the reason and the user agent instead.
 */

import { startTimings } from "@duinvezel/shared";

import type { SessionDoc } from "@duinvezel/shared";

import {
  authenticateMcp,
  jsonRpcErrorBody,
  UNAUTHORIZED_MESSAGE,
  UNAVAILABLE_MESSAGE,
} from "../auth.js";
import type { VoiceToolsDeps } from "../deps.js";
import { handleMcpPost } from "../mcp/server.js";
import { nodeForTool } from "../mcp/tool-nodes.js";

interface RpcDescription {
  method: string | null;
  tool: string | null;
  batchSize: number | null;
}

/**
 * The JSON-RPC method and tool, for the log line only. The SDK parses the
 * body a second time for the actual dispatch, so a parse failure or an
 * unusual shape here only blanks the log fields.
 */
function describeBody(bodyText: string): RpcDescription {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (Array.isArray(parsed)) {
      return { method: null, tool: null, batchSize: parsed.length };
    }
    if (parsed === null || typeof parsed !== "object") {
      return { method: null, tool: null, batchSize: null };
    }
    const message = parsed as Record<string, unknown>;
    const params = message.params;
    const tool =
      message.method === "tools/call" &&
      params !== null &&
      typeof params === "object" &&
      typeof (params as Record<string, unknown>).name === "string"
        ? ((params as Record<string, unknown>).name as string)
        : null;
    return {
      method: typeof message.method === "string" ? message.method : null,
      tool,
      batchSize: null,
    };
  } catch {
    return { method: null, tool: null, batchSize: null };
  }
}

/** One JSON-RPC message, from a single answer or from a batch element. */
function messageSignalsError(message: unknown): boolean {
  if (message === null || typeof message !== "object") {
    return false;
  }
  const record = message as Record<string, unknown>;
  if ("error" in record) {
    return true;
  }
  const result = record.result;
  return (
    result !== null &&
    typeof result === "object" &&
    (result as Record<string, unknown>).isError === true
  );
}

/**
 * True when the SDK's JSON answer means trouble for the caller: any
 * message carrying an `error` member (a batch: any element), or a
 * `tools/call` result that is `isError`. Only 200 answers can carry these
 * — anything at 400 or above is counted by its status already — and a 202
 * has no body, so its parse failure answers false.
 */
async function responseBodySignalsError(res: Response): Promise<boolean> {
  if (res.status !== 200) {
    return false;
  }
  try {
    const body: unknown = await res.clone().json();
    return Array.isArray(body) ? body.some(messageSignalsError) : messageSignalsError(body);
  } catch {
    return false;
  }
}

function logMcp(
  deps: VoiceToolsDeps,
  session: SessionDoc,
  rpc: RpcDescription,
  outcome: "ok" | "error",
  status: number,
  latency: Record<string, unknown>,
): void {
  deps.log.log(outcome === "error" ? "error" : "info", "mcp", {
    method: rpc.method,
    tool: rpc.tool,
    node: rpc.tool !== null ? nodeForTool(rpc.tool) : null,
    trace_id: session.traceId,
    identity: session.identity,
    outcome,
    status,
    ...(rpc.batchSize !== null ? { batch_size: rpc.batchSize } : {}),
    latency_ms: latency,
  });
}

export async function handleMcp(req: Request, deps: VoiceToolsDeps): Promise<Response> {
  const timings = startTimings(deps.now);

  // Auth before the body is read: an unauthenticated caller never makes the
  // function buffer and parse a body (the token check needs only headers).
  const auth = await authenticateMcp(req.headers.get("authorization"), deps, timings);
  if (!auth.ok) {
    deps.log.log("warn", "auth_failed", {
      route: "mcp",
      reason: auth.reason,
      user_agent: req.headers.get("user-agent"),
      status: auth.status,
      latency_ms: timings.snapshot(),
    });
    return Response.json(
      jsonRpcErrorBody(auth.status === 401 ? UNAUTHORIZED_MESSAGE : UNAVAILABLE_MESSAGE),
      { status: auth.status },
    );
  }

  // Read the body once, so the log line can carry the JSON-RPC method; the
  // SDK transport gets a fresh Request over the same bytes.
  const bodyText = await req.text();
  const rpc = describeBody(bodyText);

  const sdkReq = new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: bodyText,
  });
  const res = await handleMcpPost({ session: auth.session, deps, timings }, sdkReq);

  const bodyError = await responseBodySignalsError(res);
  const outcome: "ok" | "error" = res.status >= 400 || bodyError ? "error" : "ok";
  logMcp(deps, auth.session, rpc, outcome, res.status, timings.snapshot());
  return res;
}
