/**
 * `scripts/provision/run.ts` — the provisioning run, in the card's order:
 * the `mcp_enc_key` secret check, the three shared tools, the MCP server, the
 * assistant, the phone number, and the ids file. Every step reads first and
 * creates or updates only when a managed field differs; a dry run sends only
 * GET requests and writes no file.
 */

import { z } from "zod";

import type { ConversationFlow, Instructions, ToolIds } from "../../assistant/flow.ts";
import type { Client } from "./client.ts";
import { idempotencyKey } from "./client.ts";
import {
  diffAssistant,
  diffMcpServer,
  diffTool,
  recordingIsOn,
  telephonySettingsWithRecordingOn,
} from "./compare.ts";
import {
  ALLOWED_TOOLS,
  ASSISTANT_NAME,
  MCP_SECRET_IDENTIFIER,
  MCP_SERVER_NAME,
  assistantBody,
  mcpServerBody,
  sharedToolBodies,
} from "./desired.ts";
import { MissingSecretError, NotFoundError } from "./errors.ts";
import type { IdsFound } from "./ids.ts";
import { deepStrictEqual, idsFileSchema, mergeIds, serialiseIds } from "./ids.ts";
import type { Assistant, JsonObject, SharedTool } from "./schemas.ts";
import {
  assistant,
  assistantsList,
  integrationSecretEntry,
  mcpServer,
  pageForm,
  phoneNumberList,
  phoneNumberResponse,
  sharedTool,
  singleForm,
  unwrapPage,
  unwrapSingle,
} from "./schemas.ts";

export type ProvisionDeps = {
  client: Client;
  /** The parsed `infra/ids.json`. */
  idsFile: Record<string, unknown>;
  /** Writes the serialised file; never called on a dry run or when nothing changed. */
  writeIds: (serialised: string) => void;
  instructions: Instructions;
  transferTo: string;
  phoneNumber: string;
  dryRun: boolean;
  print: (line: string) => void;
  /** Overrides for tests; the constants of desired.ts are the defaults. */
  allowedTools?: readonly string[];
  buildFlow?: (args: { toolIds: ToolIds; instructions: Instructions }) => ConversationFlow;
};

/** Reads every page of a list endpoint, asking for `page[size]=100` on each request. */
async function listAll<T>(client: Client, path: string, item: z.ZodType<T>): Promise<T[]> {
  const items: T[] = [];
  for (let pageNumber = 1; ; pageNumber += 1) {
    const parsed = await client.request({
      method: "GET",
      path,
      query: { "page[size]": "100", "page[number]": String(pageNumber) },
      schema: pageForm(item),
    });
    const page = unwrapPage(parsed);
    items.push(...page);
    const totalPages = totalPagesOf(parsed);
    if (totalPages !== undefined ? pageNumber >= totalPages : page.length < 100) {
      return items;
    }
  }
}

/**
 * The answer's `meta.total_pages`, when it carries one. `GET /ai/tools` and
 * the other Telnyx v2 lists answer with `meta` (`page_number`, `page_size`,
 * `total_pages`, `total_results`, DEBUGLOG S2 read-back), and an API may
 * answer shorter pages than `page[size]` asks for — so a short page is not
 * the last one, only `meta.total_pages` says which is. The MCP server list's
 * bare array has no `meta`; there the first page shorter than 100 is the
 * last, as before.
 */
function totalPagesOf(parsed: unknown): number | undefined {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const meta = (parsed as Record<string, unknown>)["meta"];
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    return undefined;
  }
  const totalPages = (meta as Record<string, unknown>)["total_pages"];
  return typeof totalPages === "number" && Number.isFinite(totalPages) && totalPages >= 0
    ? totalPages
    : undefined;
}

const DRY_RUN_ID = "dry-run";

export async function provision(deps: ProvisionDeps): Promise<void> {
  const ids = idsFileSchema.parse(deps.idsFile);
  const voiceContextUrl = ids.functions["voice-context"].invokeUrl;
  const voiceToolsUrl = ids.functions["voice-tools"].invokeUrl;

  /* 1. The integration secret. The script checks that it exists and never writes it (T10 did, with the edge secret). */
  const secrets = await listAll(deps.client, "/integration_secrets", integrationSecretEntry);
  if (!secrets.some((secret) => secret.identifier === MCP_SECRET_IDENTIFIER)) {
    throw new MissingSecretError(MCP_SECRET_IDENTIFIER);
  }
  deps.print(`secret ${MCP_SECRET_IDENTIFIER}: present`);

  /* 2. The three shared tools, found by display_name. */
  const existingTools = await listAll(deps.client, "/ai/tools", sharedTool);
  const toolIds: ToolIds = { logDisclosure: "", transfer: "", hangup: "" };
  const toolNames: Record<string, string> = {};
  for (const desired of sharedToolBodies({
    voiceContextUrl,
    transferTo: deps.transferTo,
    phoneNumber: deps.phoneNumber,
  })) {
    const displayName = String(desired.body["display_name"]);
    toolNames[desired.key] = displayName;
    const existing: SharedTool | undefined = existingTools.find((tool) => tool.display_name === displayName);
    if (existing === undefined) {
      if (deps.dryRun) {
        deps.print(`tool ${displayName}: would create`);
        toolIds[desired.key] = DRY_RUN_ID;
        continue;
      }
      const created = unwrapSingle(
        await deps.client.request({
          method: "POST",
          path: "/ai/tools",
          body: desired.body,
          idempotencyKey: idempotencyKey("tool", desired.body),
          schema: singleForm(sharedTool),
        }),
      );
      deps.print(`tool ${displayName} (${created.id}): created`);
      toolIds[desired.key] = created.id;
      continue;
    }
    const changed = diffTool(desired.body, existing);
    if (changed.length === 0) {
      deps.print(`tool ${displayName} (${existing.id}): unchanged`);
    } else if (deps.dryRun) {
      deps.print(`tool ${displayName} (${existing.id}): would update (${changed.join(", ")})`);
    } else {
      await deps.client.request({
        method: "PATCH",
        path: `/ai/tools/${existing.id}`,
        body: desired.body,
        schema: singleForm(sharedTool),
      });
      deps.print(`tool ${displayName} (${existing.id}): updated (${changed.join(", ")})`);
    }
    toolIds[desired.key] = existing.id;
  }

  /* 3. The MCP server, found by name; an update sends the full body (PUT). */
  const desiredMcp = mcpServerBody({ voiceToolsUrl, allowedTools: deps.allowedTools ?? ALLOWED_TOOLS });
  const servers = await listAll(deps.client, "/ai/mcp_servers", mcpServer);
  const existingServer = servers.find((server) => server.name === MCP_SERVER_NAME);
  let mcpServerId: string;
  if (existingServer === undefined) {
    if (deps.dryRun) {
      deps.print(`mcp_server ${MCP_SERVER_NAME}: would create`);
      mcpServerId = DRY_RUN_ID;
    } else {
      const created = unwrapSingle(
        await deps.client.request({
          method: "POST",
          path: "/ai/mcp_servers",
          body: desiredMcp,
          idempotencyKey: idempotencyKey("mcp-server", desiredMcp),
          schema: singleForm(mcpServer),
        }),
      );
      deps.print(`mcp_server ${MCP_SERVER_NAME} (${created.id}): created`);
      mcpServerId = created.id;
    }
  } else {
    mcpServerId = existingServer.id;
    const changed = diffMcpServer(desiredMcp, existingServer);
    if (changed.length === 0) {
      deps.print(`mcp_server ${MCP_SERVER_NAME} (${mcpServerId}): unchanged`);
    } else if (deps.dryRun) {
      deps.print(`mcp_server ${MCP_SERVER_NAME} (${mcpServerId}): would update (${changed.join(", ")})`);
    } else {
      await deps.client.request({
        method: "PUT",
        path: `/ai/mcp_servers/${mcpServerId}`,
        body: desiredMcp,
        schema: singleForm(mcpServer),
      });
      deps.print(`mcp_server ${MCP_SERVER_NAME} (${mcpServerId}): updated (${changed.join(", ")})`);
    }
  }

  /* 4. The assistant, found by name and then read in full. */
  const desiredAssistant = assistantBody({
    toolIds,
    mcpServerId,
    instructions: deps.instructions,
    voiceContextUrl,
    allowedTools: deps.allowedTools ?? ALLOWED_TOOLS,
    ...(deps.buildFlow !== undefined ? { buildFlow: deps.buildFlow } : {}),
  });
  const summaries = (
    await deps.client.request({ method: "GET", path: "/ai/assistants", schema: assistantsList })
  ).data;
  const summary = summaries.find((candidate) => candidate.name === ASSISTANT_NAME);
  let state: Assistant | undefined;
  if (summary === undefined) {
    if (deps.dryRun) {
      deps.print(`assistant ${ASSISTANT_NAME}: would create`);
    } else {
      state = unwrapSingle(
        await deps.client.request({
          method: "POST",
          path: "/ai/assistants",
          body: desiredAssistant,
          idempotencyKey: idempotencyKey("assistant", desiredAssistant),
          schema: singleForm(assistant),
        }),
      );
      deps.print(`assistant ${ASSISTANT_NAME} (${state.id}): created`);
      if (!recordingIsOn(state)) {
        /* The API default switches recording on; this branch only covers an account-level override. */
        state = unwrapSingle(
          await deps.client.request({
            method: "POST",
            path: `/ai/assistants/${state.id}`,
            body: { ...desiredAssistant, telephony_settings: telephonySettingsWithRecordingOn(state) },
            schema: singleForm(assistant),
          }),
        );
        deps.print(`assistant ${ASSISTANT_NAME} (${state.id}): updated (telephony_settings)`);
      }
    }
  } else {
    state = unwrapSingle(
      await deps.client.request({
        method: "GET",
        path: `/ai/assistants/${summary.id}`,
        schema: singleForm(assistant),
      }),
    );
    const changed = diffAssistant(desiredAssistant, state);
    const recordingOff = !recordingIsOn(state);
    const fieldNames = recordingOff ? [...changed, "telephony_settings"] : changed;
    if (!recordingOff && changed.length === 0) {
      deps.print(`assistant ${ASSISTANT_NAME} (${state.id}): unchanged`);
    } else if (deps.dryRun) {
      deps.print(`assistant ${ASSISTANT_NAME} (${state.id}): would update (${fieldNames.join(", ")})`);
    } else {
      const body: JsonObject = recordingOff
        ? { ...desiredAssistant, telephony_settings: telephonySettingsWithRecordingOn(state) }
        : desiredAssistant;
      state = unwrapSingle(
        await deps.client.request({
          method: "POST",
          path: `/ai/assistants/${state.id}`,
          body,
          schema: singleForm(assistant),
        }),
      );
      deps.print(`assistant ${ASSISTANT_NAME} (${state.id}): updated (${fieldNames.join(", ")})`);
    }
  }

  const telephonySettings = (state?.telephony_settings ?? {}) as JsonObject;
  let texmlAppId: string | undefined =
    typeof telephonySettings["default_texml_app_id"] === "string"
      ? telephonySettings["default_texml_app_id"]
      : undefined;
  if (texmlAppId === undefined && state !== undefined && !deps.dryRun) {
    /* A create echo may not carry the freshly made TeXML application yet: re-read once. */
    state = unwrapSingle(
      await deps.client.request({
        method: "GET",
        path: `/ai/assistants/${state.id}`,
        schema: singleForm(assistant),
      }),
    );
    const settings = (state.telephony_settings ?? {}) as JsonObject;
    texmlAppId =
      typeof settings["default_texml_app_id"] === "string" ? settings["default_texml_app_id"] : undefined;
  }
  if (texmlAppId === undefined && !deps.dryRun) {
    throw new NotFoundError(
      `assistant ${ASSISTANT_NAME} has no telephony_settings.default_texml_app_id to attach the number to`,
    );
  }

  /* 5. The phone number, moved to the assistant's TeXML application. */
  const last4 = deps.phoneNumber.slice(-4);
  const numbers = (
    await deps.client.request({
      method: "GET",
      path: "/phone_numbers",
      query: { "filter[phone_number]": deps.phoneNumber },
      schema: phoneNumberList,
    })
  ).data;
  /* Only an exact match counts. An API that ignores or loosens the filter, or that writes the
   * number in another form, must never make the script move a number it was not given. */
  const number = numbers.find((entry) => entry.phone_number === deps.phoneNumber);
  if (number === undefined) {
    throw new NotFoundError(`no phone number ending ${last4} is on the account`);
  }
  if (texmlAppId !== undefined && number.connection_id === texmlAppId) {
    deps.print(`phone_number ...${last4} (${number.id}): unchanged`);
  } else {
    if (!deps.dryRun) {
      await deps.client.request({
        method: "PATCH",
        path: `/phone_numbers/${number.id}`,
        body: { connection_id: texmlAppId },
        schema: phoneNumberResponse,
      });
    }
    deps.print(
      `phone_number ...${last4} (${number.id}): ${deps.dryRun ? "would update" : "updated"} ` +
        "(connection_id); the number needs a few minutes before calls go through",
    );
  }

  /* The ids file, written only when a value changed. */
  const found: IdsFound = {
    assistant: { id: state?.id ?? DRY_RUN_ID, name: ASSISTANT_NAME, texmlAppId },
    mcpServer: { id: mcpServerId, name: MCP_SERVER_NAME },
    tools: {
      logDisclosure: { id: toolIds.logDisclosure, name: toolNames["logDisclosure"] ?? "" },
      transfer: { id: toolIds.transfer, name: toolNames["transfer"] ?? "" },
      hangup: { id: toolIds.hangup, name: toolNames["hangup"] ?? "" },
    },
    phoneNumber: { id: number.id },
  };
  const merged = mergeIds(deps.idsFile, found);
  if (deepStrictEqual(deps.idsFile, merged)) {
    deps.print("ids infra/ids.json: unchanged");
  } else {
    if (!deps.dryRun) {
      deps.writeIds(serialiseIds(merged));
    }
    deps.print(`ids infra/ids.json: ${deps.dryRun ? "would write" : "written"}`);
  }
}
