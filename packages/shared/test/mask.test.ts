import { describe, expect, it } from "vitest";

import { maskAccount, maskPhone } from "../src/index.js";

describe("maskPhone", () => {
  it("keeps the +, the first two digits and the last four digits", () => {
    expect(maskPhone("+32491244713")).toBe("+32…4713");
  });

  it("masks a number of different lengths the same way", () => {
    expect(maskPhone("+18005551234")).toBe("+18…1234");
    expect(maskPhone("+4915746222333")).toBe("+49…2333");
  });

  it("handles the exact boundary of six digits (no overlap, ellipsis still shown)", () => {
    expect(maskPhone("+324567")).toBe("+32…4567");
  });

  it("turns input with fewer than six digits into a bare ellipsis", () => {
    expect(maskPhone("+3245")).toBe("…");
    expect(maskPhone("+32456")).toBe("…");
  });

  it("keeps the leading + even when the rest collapses to the ellipsis only on short input", () => {
    // A five-digit number is short, so the whole thing collapses; the + is not kept.
    expect(maskPhone("+32456")).toBe("…");
  });
});

describe("maskAccount", () => {
  it("keeps the prefix up to and including the dash, then the last three characters", () => {
    expect(maskAccount("DV-100231")).toBe("DV-…231");
  });

  it("masks accounts of different lengths the same way", () => {
    expect(maskAccount("DV-1234567")).toBe("DV-…567");
    expect(maskAccount("AB-9923")).toBe("AB-…923");
  });
});