/**
 * Structured request logging for the spike, mirroring the fixed line shape
 * of packages/shared/src/log.ts (`ts`, `level`, `svc`, `event`, then the
 * fields) so the runtime logs stay greppable with the same jq filters. The
 * spike is standalone (not in the npm workspaces), so it keeps its own copy
 * instead of importing @duinvezel/shared.
 */

export type Level = "debug" | "info" | "warn" | "error";
export type Fields = Record<string, unknown>;

export interface Logger {
  log(level: Level, event: string, fields?: Fields): void;
}

const SERVICE_NAME = "mcp-spike";

export function createLogger(): Logger {
  return {
    log(level: Level, event: string, fields: Fields = {}): void {
      const line = {
        ts: new Date().toISOString(),
        level,
        svc: SERVICE_NAME,
        event,
        ...fields,
      };
      process.stdout.write(`${JSON.stringify(line)}\n`);
    },
  };
}
