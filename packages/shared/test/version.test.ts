import { describe, expect, it } from "vitest";

import { SHARED_VERSION } from "../src/index.js";

describe("SHARED_VERSION", () => {
  it("is the current shared package version", () => {
    expect(SHARED_VERSION).toBe("0.1.0");
  });
});
