# mcp-spike

Spike S3 (`tasks/S3-mcp-transport.md`): a stateless MCP server over Streamable
HTTP inside the edge fetch handler, on the official SDK. Decides ADR-009;
findings are in `DEBUGLOG.md` ("S3 findings").

Scaffolded with `telnyx-edge new-func --actor`, with the sample actor and the
`[[actors]]` block removed (no actors needed: every request is self-contained).

## Layout

| File | Purpose |
| --- | --- |
| `telnyx.toml` | Project manifest: function identity only, no bindings. |
| `src/index.ts` | Fetch handler. Strict routing (`POST /mcp` only, `GET /mcp` a 405, anything else a 404) and one `mcp_request` JSON log line per request. |
| `src/mcp.ts` | The MCP server. `@modelcontextprotocol/sdk`'s Web Standard Streamable HTTP transport in stateless mode with JSON responses, one `echo` tool, and the card's protocol-version negotiation as a `setRequestHandler` override. |
| `src/log.ts` | The one-line-per-request structured logger (spike-local copy of the shared line shape). |
| `package.json` / `tsconfig.json` | Standalone TypeScript project (not in the npm workspaces; `@modelcontextprotocol/sdk` is allowed in this spike only). |

## Run and probe

```sh
npm install
telnyx-edge dev --port 8787
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:8787/mcp \
  --transport http --method tools/list
```

Every MCP POST needs `Accept: application/json, text/event-stream` and
`Content-Type: application/json`; the SDK answers 406 or 415 otherwise.

Check: `npx tsc --noEmit` in this directory.
