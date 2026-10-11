/**
 * `check_area_status` — a read-only tool any identity may call (card T09).
 * Input is a four-digit Belgian postcode. For one of Duinvezel's five areas
 * it answers the published state from the KV read model (through the
 * per-container memory cache, `../area-status.ts`); any other postcode
 * answers `{ area_name: null, state: "unknown" }` without touching KV, so
 * asking about somewhere we do not serve never costs a read.
 *
 * A failed read (timeout, KV error, unparseable document) is one sentence
 * the model can say aloud with `isError: true`, not a made-up status.
 */

import { z } from "zod";

import { areaNameForPostcode } from "@duinvezel/shared";

import { readAreaStatus } from "../../area-status.js";
import type { ToolContext } from "../server.js";

export const checkAreaStatusInput = z.strictObject({
  postcode: z
    .string({ error: "must be a string" })
    .regex(/^\d{4}$/, "must be exactly four digits"),
});

export const CHECK_AREA_STATUS_NAME = "check_area_status";

const DESCRIPTION =
  "Checks whether there is a known internet outage at a Belgian four-digit postcode. " +
  "Use it whenever the caller asks about an outage or names a postcode, before saying anything " +
  "about service status yourself. It answers with the area name, the state (ok or outage) and, " +
  "during an outage, when service is expected back. Duinvezel only serves the coast around " +
  "Nieuwpoort, Veurne, De Panne, Koksijde and Diksmuide.";

const FAILURE_SENTENCE = "The area status system is not responding right now.";

export async function handleCheckAreaStatus(
  context: ToolContext,
  args: unknown,
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  const { postcode } = args as z.infer<typeof checkAreaStatusInput>;
  const areaName = areaNameForPostcode(postcode);
  if (areaName === null) {
    // Outside the five areas: a fixed answer, never a KV read.
    return {
      content: [
        { type: "text", text: JSON.stringify({ area_name: null, state: "unknown" }) },
      ],
    };
  }
  const read = await readAreaStatus(context.deps, context.timings, postcode);
  if (read.outcome !== "ok") {
    return { content: [{ type: "text", text: FAILURE_SENTENCE }], isError: true };
  }
  const doc = read.status;
  // A missing key is an answer, and it means ok.
  const result =
    doc === null
      ? { area_name: areaName, state: "ok", eta: null }
      : { area_name: areaName, state: doc.state, eta: doc.eta };
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

export const checkAreaStatusTool = {
  name: CHECK_AREA_STATUS_NAME,
  description: DESCRIPTION,
  inputSchema: checkAreaStatusInput,
  handle: handleCheckAreaStatus,
};
