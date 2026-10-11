/**
 * Which workflow node each MCP tool belongs to (docs/WORKFLOW.md), so the
 * request log line can carry `node` next to `tool` (docs/ARCHITECTURE.md,
 * Observability). The log spelling matches the other functions' node
 * fields (`init`, `route_call`).
 */

const TOOL_NODES: Readonly<Record<string, string>> = {
  verify_account: "verify_account",
  check_area_status: "verify_account",
  run_line_diagnostics: "diagnose",
  // Enabled on Outage help and Diagnose (docs/WORKFLOW.md); the log names
  // the first one. Likewise create_ticket names Repair ticket, its first.
  report_outage: "outage_help",
  create_ticket: "repair_ticket",
};

/** The log spelling of the node a tool belongs to, or null for an unknown tool. */
export function nodeForTool(tool: string): string | null {
  return TOOL_NODES[tool] ?? null;
}
