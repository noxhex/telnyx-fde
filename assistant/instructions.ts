/**
 * `assistant/instructions.ts` — reads the files of `assistant/instructions/`.
 * This is the only module in `assistant/` that does I/O; `flow.ts` stays
 * pure so the payload it builds is exactly what T11's tests compare.
 *
 * Each text comes back without trailing whitespace, so a file's final
 * newline never makes T11 see a difference from what the API stored.
 */

import { readFileSync } from "node:fs";

import type { Instructions } from "./flow.ts";

function readInstruction(file: string): string {
  const text = readFileSync(new URL(`./instructions/${file}`, import.meta.url), "utf8");
  return text.replace(/\s+$/, "");
}

export function loadInstructions(): Instructions {
  return {
    base: readInstruction("base.md"),
    verify: readInstruction("verify.md"),
    outageHelp: readInstruction("outage-help.md"),
    triage: readInstruction("triage.md"),
    diagnose: readInstruction("diagnose.md"),
    repairTicket: readInstruction("repair-ticket.md"),
    takeMessage: readInstruction("take-message.md"),
    degraded: readInstruction("degraded.md"),
  };
}
