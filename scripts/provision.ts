/**
 * `scripts/provision.ts` — the entry point. Thiago runs it from the repo root
 * with `node scripts/provision.ts`, optionally with `--dry-run`, on Node 26's
 * built-in type stripping and with no build step.
 *
 * It reads `TELNYX_API_KEY`, `TRANSFER_TO` and `DUINVEZEL_PHONE_NUMBER` from
 * the environment (Thiago loads them from `~/.config/telnyx/env`), validates
 * them before any request goes out, wires the real fetch and timeout runner
 * into the client, and prints one line per resource. Ids come from and go to
 * `infra/ids.json`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { loadInstructions } from "../assistant/instructions.ts";
import { createClient, realTimeoutRunner } from "./provision/client.ts";
import { ConfigError, ProvisionError } from "./provision/errors.ts";
import { provision } from "./provision/run.ts";

/** E.164: a plus and 7 to 15 digits. */
const E164 = /^\+[0-9]{7,15}$/;

export type EnvConfig = {
  apiKey: string;
  transferTo: string;
  phoneNumber: string;
};

/**
 * Validates the environment. A missing variable, or a number that is not
 * E.164, stops the script before any request; the error names the variable,
 * never its value.
 */
export function readEnvConfig(env: Record<string, string | undefined>): EnvConfig {
  const apiKey = env["TELNYX_API_KEY"];
  if (apiKey === undefined || apiKey === "") {
    throw new ConfigError("TELNYX_API_KEY", "is missing");
  }
  const transferTo = env["TRANSFER_TO"];
  if (transferTo === undefined || transferTo === "") {
    throw new ConfigError("TRANSFER_TO", "is missing");
  }
  if (!E164.test(transferTo)) {
    throw new ConfigError("TRANSFER_TO", "is not an E.164 number (a plus and 7 to 15 digits)");
  }
  const phoneNumber = env["DUINVEZEL_PHONE_NUMBER"];
  if (phoneNumber === undefined || phoneNumber === "") {
    throw new ConfigError("DUINVEZEL_PHONE_NUMBER", "is missing");
  }
  if (!E164.test(phoneNumber)) {
    throw new ConfigError("DUINVEZEL_PHONE_NUMBER", "is not an E.164 number (a plus and 7 to 15 digits)");
  }
  return { apiKey, transferTo, phoneNumber };
}

export const IDS_FILE_URL = new URL("../infra/ids.json", import.meta.url);

async function main(argv: string[]): Promise<void> {
  const args = argv.slice(2);
  let dryRun = false;
  for (const arg of args) {
    if (arg === "--dry-run") {
      dryRun = true;
    } else {
      throw new ProvisionError(`unknown argument: ${arg} (usage: node scripts/provision.ts [--dry-run])`);
    }
  }
  const config = readEnvConfig(process.env);
  const idsFile = JSON.parse(readFileSync(IDS_FILE_URL, "utf8")) as Record<string, unknown>;
  await provision({
    client: createClient({
      fetchImpl: (url, init) => fetch(url, init),
      timeoutRunner: realTimeoutRunner,
      apiKey: config.apiKey,
    }),
    idsFile,
    writeIds: (serialised) => {
      writeFileSync(IDS_FILE_URL, serialised, "utf8");
    },
    instructions: loadInstructions(),
    transferTo: config.transferTo,
    phoneNumber: config.phoneNumber,
    dryRun,
    print: (line) => {
      console.log(line);
    },
  });
}

const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  main(process.argv).then(
    () => {
      process.exitCode = 0;
    },
    (error: unknown) => {
      const message =
        error instanceof ProvisionError ? error.message : error instanceof Error ? error.message : String(error);
      console.error(`error: ${message}`);
      process.exitCode = 1;
    },
  );
}
