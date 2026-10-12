/**
 * `scripts/provision/ids.ts` — `infra/ids.json`. Every id the script creates
 * or finds goes into it, the file holds no phone number, and it is written
 * only when a value changed, with two-space indentation and a final newline.
 * The keys the script does not own (`kvNamespaceId`, `functions`) stay as
 * they are.
 */

import { z } from "zod";

import type { SharedToolKey } from "./desired.ts";

/** Only the parts of `infra/ids.json` the script reads are validated; the rest passes through untouched. */
export const idsFileSchema = z.looseObject({
  functions: z.looseObject({
    "voice-context": z.looseObject({ invokeUrl: z.string() }),
    "voice-tools": z.looseObject({ invokeUrl: z.string() }),
  }),
});

export type IdsFound = {
  assistant: { id: string; name: string; texmlAppId: string | undefined };
  mcpServer: { id: string; name: string };
  tools: Record<SharedToolKey, { id: string; name: string } | undefined>;
  phoneNumber: { id: string };
};

/** Merges the found ids into the parsed file, keeping every key the script does not own. */
export function mergeIds(existing: Record<string, unknown>, found: IdsFound): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };
  merged["assistant"] = {
    id: found.assistant.id,
    name: found.assistant.name,
    ...(found.assistant.texmlAppId !== undefined ? { texmlAppId: found.assistant.texmlAppId } : {}),
  };
  merged["mcpServer"] = { id: found.mcpServer.id, name: found.mcpServer.name };
  const tools: Record<string, unknown> = {};
  for (const key of ["logDisclosure", "transfer", "hangup"] as const) {
    const tool = found.tools[key];
    if (tool !== undefined) {
      tools[key] = { id: tool.id, name: tool.name };
    }
  }
  merged["tools"] = tools;
  merged["phoneNumber"] = { id: found.phoneNumber.id };
  return merged;
}

/** Strict structural equality: same keys, arrays in order, numbers by value. */
export function deepStrictEqual(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") {
    return a === b;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => deepStrictEqual(value, b[index]))
    );
  }
  if (isRecord(a) || isRecord(b)) {
    if (!isRecord(a) || !isRecord(b)) {
      return false;
    }
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    return (
      keysA.length === keysB.length &&
      keysA.every((key) => key in b && deepStrictEqual(a[key], b[key]))
    );
  }
  return Object.is(a, b);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The exact bytes of the file: two-space indentation and a final newline. */
export function serialiseIds(ids: Record<string, unknown>): string {
  return `${JSON.stringify(ids, null, 2)}\n`;
}
