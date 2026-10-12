/**
 * `scripts/provision/schemas.ts` — zod schemas for every response the script
 * reads. The reference leaves some wrappers unclear: the MCP server list is
 * documented as a bare array while Telnyx's SDK reads it as a page, and a
 * create may or may not wrap the object in `data`. The schemas accept both
 * forms and nothing looser. Object schemas are loose on purpose (the API adds
 * keys the script ignores, such as `created_at`), but every key the script
 * reads is validated.
 */

import { z } from "zod";

export type JsonObject = Record<string, unknown>;
const jsonObject: z.ZodType<JsonObject> = z.record(z.string(), z.unknown());

/* Integration secrets (GET /integration_secrets). */

export const integrationSecretEntry = z.looseObject({
  identifier: z.string(),
});
export type IntegrationSecretEntry = z.infer<typeof integrationSecretEntry>;

/* Shared tools (GET /ai/tools, POST /ai/tools, PATCH /ai/tools/{id}). */

export const sharedTool = z.looseObject({
  id: z.string(),
  display_name: z.string().optional(),
  type: z.string().optional(),
  timeout_ms: z.number().optional(),
  tool_definition: jsonObject.optional(),
});
export type SharedTool = z.infer<typeof sharedTool>;

/* MCP servers (GET/POST /ai/mcp_servers, PUT /ai/mcp_servers/{id}). */

export const mcpServer = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
  type: z.string().optional(),
  url: z.string().optional(),
  api_key_ref: z.string().nullish(),
  allowed_tools: z.array(z.string()).nullish(),
});
export type McpServer = z.infer<typeof mcpServer>;

/* Assistants (GET/POST /ai/assistants, GET/POST /ai/assistants/{id}). */

export const assistantSummary = z.looseObject({
  id: z.string(),
  name: z.string(),
});
export type AssistantSummary = z.infer<typeof assistantSummary>;

export const assistantsList = z.looseObject({
  data: z.array(assistantSummary),
});

export const assistant = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
  model: z.string().optional(),
  instructions: z.string().optional(),
  greeting: z.string().optional(),
  enabled_features: z.array(z.string()).optional(),
  voice_settings: jsonObject.optional(),
  dynamic_variables: z.record(z.string(), z.unknown()).optional(),
  dynamic_variables_webhook_url: z.string().optional(),
  dynamic_variables_webhook_timeout_ms: z.number().optional(),
  mcp_servers: z.array(jsonObject).optional(),
  tools: z.array(jsonObject).optional(),
  tool_ids: z.array(z.string()).optional(),
  conversation_flow: jsonObject.optional(),
  telephony_settings: jsonObject.optional(),
});
export type Assistant = z.infer<typeof assistant>;

/* Phone numbers (GET /phone_numbers, PATCH /phone_numbers/{id}). */

export const phoneNumberEntry = z.looseObject({
  id: z.string(),
  phone_number: z.string().optional(),
  connection_id: z.string().nullish(),
});
export type PhoneNumberEntry = z.infer<typeof phoneNumberEntry>;

export const phoneNumberList = z.looseObject({
  data: z.array(phoneNumberEntry),
});

export const phoneNumberResponse = z.looseObject({
  data: phoneNumberEntry,
});

/*
 * Wrapper forms. A list page can be a bare array (the MCP server list, as
 * documented) or an object with `data` (as the SDK reads it, and as every
 * other list here answers). A single-resource answer can be the bare object
 * or wrapped in `data`. Both forms parse, nothing looser.
 */

export function pageForm<S extends z.ZodType>(item: S) {
  return z.union([z.array(item), z.looseObject({ data: z.array(item) })]);
}

export function singleForm<S extends z.ZodType>(item: S) {
  return z.union([item, z.looseObject({ data: item })]);
}

/** Reads the items out of either list form. */
export function unwrapPage<T>(parsed: T[] | { data: T[] }): T[] {
  return Array.isArray(parsed) ? parsed : parsed.data;
}

/** Reads the object out of either single-resource form; the object always has an `id`, the wrapper never does. */
export function unwrapSingle<T extends { id: string }>(parsed: T | { data: T }): T {
  return "id" in parsed ? parsed : parsed.data;
}
