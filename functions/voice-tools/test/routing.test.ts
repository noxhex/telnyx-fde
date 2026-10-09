import { describe, expect, it } from "vitest";

import { SHARED_VERSION } from "@duinvezel/shared";

import { route } from "../src/index.js";

describe("route", () => {
  it("serves GET /healthz with the service name and shared version", () => {
    const result = route("GET", "/healthz");

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      ok: true,
      svc: "voice-tools",
      shared: SHARED_VERSION,
    });
  });

  it("returns 404 for a wrong method on /healthz", () => {
    expect(route("POST", "/healthz")).toEqual({
      status: 404,
      body: { error: "not_found" },
    });
  });

  it("returns 404 for an unknown path", () => {
    expect(route("GET", "/nope")).toEqual({
      status: 404,
      body: { error: "not_found" },
    });
  });
});
