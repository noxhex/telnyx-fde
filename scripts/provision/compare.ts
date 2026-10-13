/**
 * `scripts/provision/compare.ts` — the comparison between what the script
 * sends and what the API returns. It compares only what the script sends.
 *
 * - An object matches when every key the script sends matches the API's
 *   value for that key; keys the API adds are ignored (a node's `position`,
 *   a tool node's resolved `tool`, nulls for unsent fields).
 * - A list matches when it has the same length and each item matches in
 *   order, with two exceptions: `conversation_flow.nodes` match by `id` in
 *   any order (edges keep their order, which is their evaluation order), and
 *   the assistant's attached shared tools — the `tool_id`s of the entries in
 *   its `tools` list — match `tool_ids` as a set.
 * - Numbers match by value, so the API's `300.0` matches `300`.
 * - A shared tool's `<type>` object is compared with the API's
 *   `tool_definition` (DEBUGLOG, S2 findings).
 * - The greeting goes out as the empty string (DEBUGLOG issue 18), and a
 *   read-back of `""`, `null` or no `greeting` at all counts as equal; any
 *   other text is a difference.
 */

import type { JsonObject } from "./schemas.ts";

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The recursive match: subset for objects, in-order for arrays, value equality otherwise. */
export function matchValue(expected: unknown, actual: unknown): boolean {
  if (typeof expected === "number" && typeof actual === "number") {
    return expected === actual;
  }
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((value, index) => matchValue(value, actual[index]))
    );
  }
  if (isJsonObject(expected)) {
    return (
      isJsonObject(actual) &&
      Object.keys(expected).every((key) => matchValue(expected[key], actual[key]))
    );
  }
  return Object.is(expected, actual);
}

/** Nodes match by `id` in any order; each pair matches key by key. */
function matchNodes(expected: unknown, actual: unknown): boolean {
  if (!Array.isArray(expected) || !Array.isArray(actual) || expected.length !== actual.length) {
    return false;
  }
  return expected.every((expectedNode) => {
    if (!isJsonObject(expectedNode)) {
      return false;
    }
    const actualNode = actual.find(
      (candidate) => isJsonObject(candidate) && candidate["id"] === expectedNode["id"],
    );
    return actualNode !== undefined && matchValue(expectedNode, actualNode);
  });
}

/** The flow: same start node, nodes matched by `id` in any order, edges in declaration order. */
export function matchConversationFlow(expected: unknown, actual: unknown): boolean {
  if (!isJsonObject(expected) || !isJsonObject(actual)) {
    return false;
  }
  return (
    matchValue(expected["start_node_id"], actual["start_node_id"]) &&
    matchNodes(expected["nodes"], actual["nodes"]) &&
    matchValue(expected["edges"], actual["edges"])
  );
}

/**
 * The assistant's attached shared tools are the `tool_id`s of the entries in
 * its `tools` list, because the API returns no `tool_ids` field (DEBUGLOG, S2
 * read-back), and they match `tool_ids` as a set. With no `tools` list at all
 * the assistant has no attachments.
 */
export function matchToolIds(expected: unknown, actualTools: unknown): boolean {
  if (!Array.isArray(expected)) {
    return false;
  }
  const actualIds = new Set<string>();
  if (Array.isArray(actualTools)) {
    for (const entry of actualTools) {
      if (isJsonObject(entry) && typeof entry["tool_id"] === "string") {
        actualIds.add(entry["tool_id"]);
      }
    }
  }
  return expected.length === actualIds.size && expected.every((id) => typeof id === "string" && actualIds.has(id));
}

/**
 * The greeting goes out as the empty string, and the API may read that back
 * as `""`, `null` or no `greeting` at all; all three count as equal. Any
 * other text — such as the Disclosure line T11 sent — is a difference.
 */
export function matchGreeting(expected: unknown, actual: unknown): boolean {
  if (expected === "" && (actual === "" || actual === null || actual === undefined)) {
    return true;
  }
  return matchValue(expected, actual);
}

/**
 * The assistant's managed fields, in the order their names appear in an
 * `updated (...)` line. `telephony_settings` is not among them: it is only
 * ever sent when a read finds recording off, and then as the API returned it
 * with only `recording_settings.enabled` changed.
 */
export const ASSISTANT_MANAGED_FIELDS: readonly string[] = [
  "name",
  "model",
  "instructions",
  "enabled_features",
  "greeting",
  "voice_settings",
  "dynamic_variables",
  "dynamic_variables_webhook_url",
  "dynamic_variables_webhook_timeout_ms",
  "mcp_servers",
  "tool_ids",
  "conversation_flow",
];

/** The names of the managed fields that differ from what the API returned. */
export function diffAssistant(desired: JsonObject, actual: JsonObject): string[] {
  const changed: string[] = [];
  for (const field of ASSISTANT_MANAGED_FIELDS) {
    if (field === "conversation_flow") {
      if (!matchConversationFlow(desired[field], actual[field])) {
        changed.push(field);
      }
    } else if (field === "tool_ids") {
      if (!matchToolIds(desired[field], actual["tools"])) {
        changed.push(field);
      }
    } else if (field === "greeting") {
      if (!matchGreeting(desired[field], actual[field])) {
        changed.push(field);
      }
    } else if (!matchValue(desired[field], actual[field])) {
      changed.push(field);
    }
  }
  return changed;
}

/**
 * The managed fields of a shared tool; the `<type>` object is compared with
 * `tool_definition`. `preset_body_fields` is a managed field of the
 * disclosure tool like the rest of its `webhook` object: it sits inside that
 * object, so this same comparison covers it, and an old read-back without a
 * preset differs.
 */
export function diffTool(desired: JsonObject, actual: JsonObject): string[] {
  const changed: string[] = [];
  for (const field of ["display_name", "type", "timeout_ms"]) {
    if (!matchValue(desired[field], actual[field])) {
      changed.push(field);
    }
  }
  const type = desired["type"];
  if (typeof type === "string" && !matchValue(desired[type], actual["tool_definition"])) {
    changed.push(type);
  }
  return changed;
}

/** The managed fields of the MCP server, in their `updated (...)` order. */
export function diffMcpServer(desired: JsonObject, actual: JsonObject): string[] {
  const changed: string[] = [];
  for (const field of ["name", "type", "url", "api_key_ref", "allowed_tools"]) {
    if (!matchValue(desired[field], actual[field])) {
      changed.push(field);
    }
  }
  return changed;
}

/* Recording. */

function toRecord(value: unknown): JsonObject {
  return isJsonObject(value) ? value : {};
}

/**
 * Whether the assistant's recording is on. The API's default is `true`, so a
 * missing `telephony_settings` or `recording_settings` counts as on; only an
 * explicit `enabled: false` counts as off.
 */
export function recordingIsOn(assistant: JsonObject): boolean {
  const telephony = toRecord(assistant["telephony_settings"]);
  const recording = toRecord(telephony["recording_settings"]);
  return recording["enabled"] !== false;
}

/**
 * `telephony_settings` exactly as the API returned it, with only
 * `recording_settings.enabled` changed to `true`, so the TeXML application id
 * and the other settings stay as they are.
 */
export function telephonySettingsWithRecordingOn(assistant: JsonObject): JsonObject {
  const telephony = toRecord(assistant["telephony_settings"]);
  return {
    ...telephony,
    recording_settings: { ...toRecord(telephony["recording_settings"]), enabled: true },
  };
}
