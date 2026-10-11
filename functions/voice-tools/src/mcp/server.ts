/**
 * The MCP server core, built on the official TypeScript SDK
 * (@modelcontextprotocol/sdk 1.32.1; ADR-009, spike S3). The transport is
 * the SDK's Web Standard Streamable HTTP transport, which speaks fetch
 * `Request`/`Response` directly, so it runs inside the edge fetch handler
 * unmodified: stateless mode (`sessionIdGenerator: undefined`, so no
 * `Mcp-Session-Id`) with JSON responses (`enableJsonResponse: true`).
 *
 * Each POST builds a fresh server and transport pair because the SDK
 * refuses to reuse a stateless transport across requests; both are plain
 * objects with no I/O at construction. The server is built with the loaded
 * session, so every tool handler sees only that session (ADR-008).
 *
 * The one SDK default the card overrides is protocol negotiation: the SDK
 * also echoes the 2024-* versions and falls back to its own latest, so a
 * `setRequestHandler` replacement pins the supported set to
 * 2025-11-25 / 2025-06-18 / 2025-03-26 with 2025-06-18 as the fallback.
 *
 * The shared tool types live here, next to the dispatch that uses them: the
 * tool modules import them type-only, so there is no runtime import cycle.
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
import { z } from "zod";

import type { SessionDoc, Timings } from "@duinvezel/shared";

import type { VoiceToolsDeps } from "../deps.js";
import { checkAreaStatusTool } from "./tools/check-area-status.js";
import { createTicketTool } from "./tools/create-ticket.js";
import { reportOutageTool } from "./tools/report-outage.js";
import { runLineDiagnosticsTool } from "./tools/run-line-diagnostics.js";
import { verifyAccountTool } from "./tools/verify-account.js";

export const SERVER_NAME = "voice-tools";
export const SERVER_VERSION = "0.1.0";

/** Protocol versions this server echoes back on `initialize`. */
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
]);

/** The version offered when the client asks for anything else (the card's fallback, not the SDK's). */
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

/** Everything a tool handler is allowed to see: the caller's own session and the injected dependencies. */
export interface ToolContext {
  session: SessionDoc;
  deps: VoiceToolsDeps;
  timings: Timings;
}

/** What a tool handler answers: text content, with `isError` only on a failed dependency. A type alias (not an interface) so the SDK's index-signature result type accepts it. */
export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType;
  handle(context: ToolContext, args: unknown): Promise<ToolResult>;
}

/** The tool list, in the card's order; tools/list serves exactly this. */
export const TOOLS: readonly ToolDef[] = [
  verifyAccountTool,
  checkAreaStatusTool,
  runLineDiagnosticsTool,
  reportOutageTool,
  createTicketTool,
];

/**
 * One short sentence for an arguments validation failure, naming the first
 * failing argument and what it accepts (the card's Invalid arguments rule).
 * Schema messages are written as predicates ("must be ..."), so "<field>
 * <message>." reads naturally; an argument the tool does not define is
 * named by itself. The sentence ends in a full stop.
 */
function invalidInputSentence(tool: string, error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) {
    return `The arguments for ${tool} are not valid.`;
  }
  if (issue.code === "unrecognized_keys") {
    const keys = (issue as { keys?: unknown[] }).keys ?? [];
    return `${String(keys[0] ?? "argument")} is not an argument of ${tool}.`;
  }
  const field = issue.path.map(String).join(".");
  const message = issue.message.replace(/\.$/, "");
  return field.length > 0 ? `${field} ${message}.` : `${tool}: ${message}.`;
}

/** Builds the server for one request, bound to the caller's session. */
export function buildServer(context: ToolContext): Server {
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
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.inputSchema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = TOOLS.find((candidate) => candidate.name === request.params.name);
    if (tool === undefined) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`);
    }
    const parsed = tool.inputSchema.safeParse(request.params.arguments ?? {});
    if (!parsed.success) {
      // Invalid arguments are a tool execution error (the card's Invalid
      // arguments rule, SEP-1303 in the 2025-11-25 spec): an isError result
      // with one sentence naming the argument, so the model fixes its call
      // — a JSON-RPC error bought nothing and, as S4 showed, can crash the
      // call (DEBUGLOG issue 13). An unknown tool above stays a JSON-RPC
      // error, and so does a malformed request (the SDK's own parsing).
      return {
        content: [{ type: "text", text: invalidInputSentence(tool.name, parsed.error) }],
        isError: true,
      };
    }
    return tool.handle(context, parsed.data);
  });

  return server;
}

/**
 * Answers one authenticated `POST /mcp` request. The transport handles the
 * JSON-RPC framing: notifications-only bodies get HTTP 202 with an empty
 * body, a parse error gets -32700, an unknown method -32601, invalid
 * parameters -32602, and requests get their result as one JSON object.
 * `ping` is answered by the SDK's protocol layer with an empty result.
 */
export async function handleMcpPost(context: ToolContext, req: Request): Promise<Response> {
  const server = buildServer(context);
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
