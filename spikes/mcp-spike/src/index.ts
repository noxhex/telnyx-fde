/**
 * mcp-spike — spikes S3 and S4. S3: a stateless MCP server over Streamable
 * HTTP in the edge fetch handler (ADR-009). S4: `POST /dv`, a dynamic
 * variables webhook that returns the per-call token encrypted under
 * `MCP_ENC_KEY_SPIKE`, so the round trip to `POST /mcp` as a bearer token
 * can be proven end to end (ADR-008). Routing only: strict method+path
 * matching (ADR-014), then the webhook in src/dv.ts or the MCP dispatch in
 * src/mcp.ts.
 *
 * One log line per request, written however the request ends: `mcp_request`
 * for the MCP route, `dv_request` for the webhook. The MCP line carries the
 * JSON-RPC method and id (peeking at the body before it is handed to the
 * SDK), the user agent, whether an `authorization` header was present, only
 * the last eight characters of the bearer token (never the full token), and
 * the `mcp-protocol-version` header. The webhook line carries the generated
 * token id and the mode; the ciphertext is never logged.
 */

import type { Env, Secrets } from "@telnyx/edge-runtime";

import { handleDv } from "./dv.js";
import { createLogger } from "./log.js";
import type { Fields } from "./log.js";
import { handleMcpPost } from "./mcp.js";
import { parseKey } from "./telnyx-encrypt.js";

const log = createLogger();

/**
 * The spike's telnyx.toml declares no `[[secrets]]` block, so the runtime
 * does not materialise `env.SECRETS`; the optional field keeps the type
 * honest while `process.env.MCP_ENC_KEY_SPIKE` does the real work (edge
 * secrets also arrive as environment variables).
 */
export interface SpikeEnv extends Env {
  SECRETS?: Secrets;
}

/** The edge secret holding the base64url AES-256 key (S4, step 1). */
const KEY_SECRET_HANDLE = "MCP_ENC_KEY_SPIKE";

type RouteName = "dv" | "mcp" | "method_not_allowed" | "not_found";

/** Strict routing: only `POST /dv` and `POST /mcp` are live routes. */
function matchRoute(method: string, pathname: string): RouteName {
  if (pathname !== "/dv" && pathname !== "/mcp") {
    return "not_found";
  }
  if (method !== "POST") {
    return "method_not_allowed";
  }
  return pathname === "/dv" ? "dv" : "mcp";
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

/**
 * Reads the base64url AES-256 key from the edge secret: the typed binding
 * first (present only once telnyx.toml declares a `[[secrets]]` block), then
 * the same-named environment variable, which is how `telnyx-edge secrets
 * add` delivers it to this spike. Returns null when the secret is missing or
 * not a valid 32-byte key; the key material itself is never logged.
 */
async function resolveKey(env: SpikeEnv): Promise<Uint8Array | null> {
  let raw: string | null = null;
  if (env.SECRETS !== undefined) {
    try {
      const value = await env.SECRETS.get(KEY_SECRET_HANDLE);
      raw = value.length > 0 ? value : null;
    } catch {
      raw = null;
    }
  }
  if (raw === null) {
    const fromEnv = process.env[KEY_SECRET_HANDLE];
    raw = fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : null;
  }
  if (raw === null) {
    return null;
  }
  try {
    return parseKey(raw);
  } catch {
    return null;
  }
}

/**
 * The last eight characters of the bearer token, or null when there is no
 * usable `Authorization: Bearer ...` header. The full token is never logged;
 * eight characters are enough to join the `/mcp` line to the token id the
 * `/dv` line logged, which is the whole point of the spike.
 */
function bearerTokenSuffix(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (header === null) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match !== null ? match[1] : null;
  return token !== null && token.length > 0 ? token.slice(-8) : null;
}

export default {
  async fetch(req: Request, env: SpikeEnv): Promise<Response> {
    const url = new URL(req.url);
    const route = matchRoute(req.method, url.pathname);

    // Read the body once, up front, so the log line can carry the JSON-RPC
    // method and id; the SDK transport gets a fresh Request over the same
    // bytes (the edge runtime is given the raw body text, the way the
    // webhook signature check sees the raw body before parsing).
    const bodyText = route === "mcp" ? await req.text() : "";

    // S4's `POST /dv?mode=bad` switch; the query string is ignored by the
    // strict route match and read only by the webhook branch.
    const mode = route === "dv" ? url.searchParams.get("mode") : null;

    let response: Response;
    let dvFields: Fields = {};
    if (route === "not_found") {
      response = Response.json({ error: "not_found" }, { status: 404 });
    } else if (route === "method_not_allowed") {
      response = Response.json(
        { error: "method_not_allowed" },
        { status: 405 },
      );
    } else if (route === "dv") {
      const key = await resolveKey(env);
      if (key === null) {
        // A missing or invalid key is a deploy fault. Fail closed with a
        // loud 500 rather than minting a token under a wrong guess; the
        // error-level dv_request line is what a probe looks for first.
        response = Response.json({ error: "key_unavailable" }, { status: 500 });
        dvFields = { mode };
      } else {
        const result = handleDv(mode, key);
        response = result.response;
        dvFields = { token_id: result.tokenId, mode };
      }
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
      ...(route === "mcp"
        ? { token_suffix: bearerTokenSuffix(req), ...describeBody(bodyText) }
        : {}),
      ...dvFields,
    };
    const event = route === "dv" ? "dv_request" : "mcp_request";
    log.log(response.status >= 500 ? "error" : "info", event, fields);
    return response;
  },
};
