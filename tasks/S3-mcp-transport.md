# S3. MCP transport in the edge runtime

**Type** Spike · **Code by** implementer agent · **Hands-on** Thiago registers the MCP server · **Decides** ADR-009

## Goal

Find out whether the official MCP TypeScript SDK runs inside the edge fetch handler, or whether we implement the small JSON-RPC subset ourselves. Then prove that a Telnyx assistant can list and call a tool on our server, and record exactly what Telnyx's MCP client sends.

## Files

- `spikes/mcp-spike/` scaffolded with `cd spikes && telnyx-edge new-func --actor --name=mcp-spike`, with the sample actor and the `[[actors]]` block removed.
- `spikes/mcp-spike/src/index.ts`, plus any helper files in `spikes/mcp-spike/src/`.

The `@modelcontextprotocol/sdk` dependency is allowed in this spike only.

## Behaviour

- `POST /mcp` is a stateless MCP server over Streamable HTTP. Every request is answered on its own with `Content-Type: application/json`. No SSE stream and no `Mcp-Session-Id`.
- `initialize` answers with the protocol version the client asked for if it is one of `2025-11-25`, `2025-06-18` or `2025-03-26`, and otherwise with `2025-06-18`. Capabilities are `{ "tools": {} }`, and server info names `mcp-spike`.
- `notifications/initialized` and any other notification get HTTP 202 with an empty body.
- `ping` returns an empty result.
- `tools/list` returns one tool, `echo`, with input schema `{ text: string }`.
- `tools/call` for `echo` returns `{ content: [{ type: "text", text: <the text> }] }`. An unknown tool returns a JSON-RPC error.
- `GET /mcp` returns 405. Any other path returns 404.
- Every request logs one JSON line with the JSON-RPC method, id, `user-agent`, whether an `authorization` header was present (never its value), and the `mcp-protocol-version` header.

## Steps

1. Try the SDK first, using its Streamable HTTP server transport in stateless mode with JSON responses, adapted to the fetch handler's `Request` and `Response`. If it does not work within about 30 minutes of effort, implement the methods above by hand. Either way, report what you tried and what failed.
2. Test locally with `telnyx-edge dev` in the background, then `npx @modelcontextprotocol/inspector`, connecting with the Streamable HTTP transport to the local `/mcp` URL. List the tools and call `echo`.
3. Thiago ships it (`time telnyx-edge ship`), registers it as an MCP server in Telnyx (type `http`, the deployed `/mcp` URL), attaches it to the `spike-routing` assistant and asks it in a test chat or call to use the echo tool with the text "hello".
4. Check `telnyx-edge logs mcp-spike --type runtime` for the requests Telnyx sent.

## Done when

- MCP Inspector lists and calls `echo` against both the local and the deployed server.
- The Telnyx assistant calls `echo` successfully, and the log shows Telnyx's requests.
- ADR-009 records SDK or hand-rolled, with the reason.
- `DEBUGLOG.md` notes what Telnyx's client sends, including the protocol version, user agent, whether it initializes once per call or per request, and which headers arrive.
