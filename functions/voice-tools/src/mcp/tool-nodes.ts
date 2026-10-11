/**
 * Which workflow node each MCP tool belongs to (docs/WORKFLOW.md), so the
 * request log line can carry `node` next to `tool` (docs/ARCHITECTURE.md,
 * Observability). The log spelling matches the other functions' node
 * fields (`init`, `route_call`).
 */

const TOOL_NODES: Readonly<Record<string, string>> = {
  check_area_status: "verify_account",
  run_line_diagnostics: "diagnose",
};

/** The log spelling of the node a tool belongs to, or null for an unknown tool. */
export function nodeForTool(tool: string): string | null {
  return TOOL_NODES[tool] ?? null;
}
