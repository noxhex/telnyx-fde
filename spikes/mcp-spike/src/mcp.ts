/**
 * The MCP server, built on the official TypeScript SDK (ADR-009). The
 * transport is the SDK's Web Standard Streamable HTTP transport
 * (@modelcontextprotocol/sdk 1.32.1), which speaks fetch `Request`/`Response`
 * directly, so it runs inside the edge fetch handler unmodified.
 *
 * Stateless mode, exactly as the card requires: no session id generator, so
 * no `Mcp-Session-Id` is issued or checked, and `enableJsonResponse` makes
 * every POST answer with one `application/json` body instead of an SSE
 * stream. The SDK refuses to reuse a stateless transport across requests,
 * so each POST builds a fresh server and transport pair; both are cheap
 * objects with no I/O at construction.
 *
 * The one place the SDK's defaults diverge from the card is protocol
 * negotiation: the SDK also echoes the 2024-* versions and falls back to
 * its latest (2025-11-25), while the card pins the supported set to
 * 2025-11-25 / 2025-06-18 / 2025-03-26 and the fallback to 2025-06-18.
 * `setRequestHandler` replaces the built-in initialize handler with the
 * card's negotiation.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  InitializeRequestSchema,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

export const SERVER_NAME = "mcp-spike";
export const SERVER_VERSION = "0.1.0";

/** Protocol versions this server echoes back on `initialize`. */
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
]);

/** The version offered when the client asks for anything else. */
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

const ECHO_TOOL = {
  name: "echo",
  description: "Returns the given text unchanged.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "The text to echo back." },
    },
    required: ["text"],
    additionalProperties: false,
  },
} as const;

function buildServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  // The card's negotiation, replacing the SDK's built-in initialize handler
  // (setRequestHandler replaces any previous handler for the same method).
  server.setRequestHandler(InitializeRequestSchema, (request) => {
    const requested = request.params.protocolVersion;
    return {
      protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.has(requested)
        ? requested
        : DEFAULT_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    };
  });

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [ECHO_TOOL],
  }));

  server.setRequestHandler(CallToolRequestSchema, (request) => {
    if (request.params.name !== ECHO_TOOL.name) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Unknown tool: ${request.params.name}`,
      );
    }
    const args = request.params.arguments ?? {};
    const text = (args as Record<string, unknown>).text;
    if (typeof text !== "string") {
      throw new McpError(
        ErrorCode.InvalidParams,
        "echo requires a string argument `text`",
      );
    }
    return { content: [{ type: "text", text }] };
  });

  return server;
}

/**
 * Answers one `POST /mcp` request. The transport handles the JSON-RPC
 * framing: notifications-only bodies get HTTP 202 with an empty body,
 * malformed JSON gets a -32700 error response, and requests get their
 * result as one JSON object. `ping` is answered by the SDK's protocol
 * layer with an empty result.
 */
export async function handleMcpPost(req: Request): Promise<Response> {
  const server = buildServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    // JSON responses are fully buffered when handleRequest resolves, so the
    // per-request pair can be torn down immediately.
    await transport.close();
  }
}
