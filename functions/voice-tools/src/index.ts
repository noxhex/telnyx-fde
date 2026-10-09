// Re-export the actor class from the entry point so it is bundled and
// shipped with the function; the exported name must equal the [[actors]]
// type in telnyx.toml.
export { CustomerAccount } from "./actors/customer-account.js";

import type { Env } from "@telnyx/edge-runtime";

import { SHARED_VERSION } from "@duinvezel/shared";

const SERVICE_NAME = "voice-tools";

export interface RouteResult {
  status: number;
  body: Record<string, unknown>;
}

export function route(method: string, pathname: string): RouteResult {
  if (method === "GET" && pathname === "/healthz") {
    return {
      status: 200,
      body: { ok: true, svc: SERVICE_NAME, shared: SHARED_VERSION },
    };
  }
  return { status: 404, body: { error: "not_found" } };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const result = route(req.method, url.pathname);
    return Response.json(result.body, { status: result.status });
  },
};
