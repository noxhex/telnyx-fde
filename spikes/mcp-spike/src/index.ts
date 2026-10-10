/**
 * mcp-spike — spike S3, a stateless MCP server over Streamable HTTP in the
 * edge fetch handler (ADR-009). Routing only: strict method+path matching
 * (ADR-014), then the MCP dispatch in src/mcp.ts. One `mcp_request` log
 * line per request, written however the request ends, with the JSON-RPC
 * method and id (peeking at the body before it is handed to the SDK), the
 * user agent, whether an `authorization` header was present (never its
 * value) and the `mcp-protocol-version` header.
 */

import type { Env } from "@telnyx/edge-runtime";

import { createLogger } from "./log.js";
import type { Fields } from "./log.js";
import { handleMcpPost } from "./mcp.js";

const log = createLogger();

type RouteName = "mcp" | "method_not_allowed" | "not_found";

/** Strict routing: only `POST /mcp` is a live route. */
function matchRoute(method: string, pathname: string): RouteName {
  if (pathname !== "/mcp") {
    return "not_found";
  }
  if (method !== "POST") {
    return "method_not_allowed";
  }
  return "mcp";
}

/**
 * The JSON-RPC method and id, for the log line only. The body is parsed a
 * second time by the SDK for the actual dispatch, so a parse failure here
 * only blanks the log fields; the SDK still answers with its own parse
 * error. Batches log `batch_size` instead of a single method and id.
 */
function describeBody(bodyText: string): Fields {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { rpc_method: null, rpc_id: null };
  }
  if (Array.isArray(parsed)) {
    return { rpc_method: null, rpc_id: null, batch_size: parsed.length };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { rpc_method: null, rpc_id: null };
  }
  const message = parsed as Record<string, unknown>;
  const rpcId = message.id;
  return {
    rpc_method: typeof message.method === "string" ? message.method : null,
    rpc_id:
      typeof rpcId === "string" || typeof rpcId === "number" ? rpcId : null,
  };
}

export default {
  async fetch(req: Request, _env: Env): Promise<Response> {
    const url = new URL(req.url);
    const route = matchRoute(req.method, url.pathname);

    // Read the body once, up front, so the log line can carry the JSON-RPC
    // method and id; the SDK transport gets a fresh Request over the same
    // bytes (the edge runtime is given the raw body text, the way the
    // webhook signature check sees the raw body before parsing).
    const bodyText = route === "mcp" ? await req.text() : "";

    let response: Response;
    if (route === "not_found") {
      response = Response.json({ error: "not_found" }, { status: 404 });
    } else if (route === "method_not_allowed") {
      response = Response.json(
        { error: "method_not_allowed" },
        { status: 405 },
      );
    } else {
      response = await handleMcpPost(
        new Request(req.url, {
          method: req.method,
          headers: req.headers,
          body: bodyText,
        }),
      );
    }

    const fields: Fields = {
      route,
      status: response.status,
      user_agent: req.headers.get("user-agent"),
      has_authorization: req.headers.has("authorization"),
      mcp_protocol_version: req.headers.get("mcp-protocol-version"),
      ...(route === "mcp" ? describeBody(bodyText) : {}),
    };
    log.log(response.status >= 500 ? "error" : "info", "mcp_request", fields);
    return response;
  },
};
