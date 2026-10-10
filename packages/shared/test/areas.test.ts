import { describe, expect, it } from "vitest";

import { AREAS, areaNameForPostcode } from "../src/areas.js";

describe("AREAS", () => {
  it("covers the five Duinvezel postcodes with their area names", () => {
    expect(AREAS).toHaveLength(5);
    expect(Object.fromEntries(AREAS.map((a) => [a.postcode, a.name]))).toEqual({
      "8620": "Nieuwpoort",
      "8630": "Veurne",
      "8660": "De Panne",
      "8670": "Koksijde",
      "8600": "Diksmuide",
    });
  });

  it("uses four-digit postcodes only, so each goes straight into kvKeys.areaStatus", () => {
    for (const area of AREAS) {
      expect(area.postcode).toMatch(/^\d{4}$/);
    }
  });

  it("cannot be mutated: the list and every entry are frozen", () => {
    expect(Object.isFrozen(AREAS)).toBe(true);
    for (const area of AREAS) {
      expect(Object.isFrozen(area)).toBe(true);
    }
  });
});

describe("areaNameForPostcode", () => {
  it("returns the name for each of the five postcodes", () => {
    for (const area of AREAS) {
      expect(areaNameForPostcode(area.postcode)).toBe(area.name);
    }
  });

  it("returns null outside the service area", () => {
    expect(areaNameForPostcode("9000")).toBeNull();
    expect(areaNameForPostcode("")).toBeNull();
    expect(areaNameForPostcode("863")).toBeNull();
    expect(areaNameForPostcode("86300")).toBeNull();
  });
});
