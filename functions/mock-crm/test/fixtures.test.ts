import { describe, expect, it } from "vitest";

import {
  DEMO_ACCOUNT_NUMBER,
  findAccountByPhoneDigits,
  listAccounts,
  phoneDigits,
} from "../src/domain/fixtures.js";

describe("fixtures", () => {
  it("holds eight accounts across the five Duinvezel postcodes", () => {
    const accounts = listAccounts();
    expect(accounts).toHaveLength(8);
    expect(new Set(accounts.map((a) => a.postcode))).toEqual(
      new Set(["8620", "8630", "8660", "8670", "8600"]),
    );
  });

  it("keeps the demo account plus at least two more in 8630 Veurne", () => {
    const veurne = listAccounts().filter((a) => a.postcode === "8630");
    expect(veurne.length).toBeGreaterThanOrEqual(3);
    expect(veurne.some((a) => a.accountNumber === DEMO_ACCOUNT_NUMBER)).toBe(true);
  });

  it("covers every line profile, with the demo account down", () => {
    const profiles = new Set(listAccounts().map((a) => a.lineProfile));
    expect(profiles).toEqual(new Set(["ok", "degraded", "down"]));

    const demo = listAccounts().find((a) => a.accountNumber === DEMO_ACCOUNT_NUMBER);
    expect(demo).toMatchObject({ firstName: "Thiago", lineProfile: "down" });
  });

  it("commits no real phone number for the demo account", () => {
    const demo = listAccounts().find((a) => a.accountNumber === DEMO_ACCOUNT_NUMBER);
    expect(demo?.phone).toBe("");

    for (const other of listAccounts()) {
      if (other.accountNumber !== DEMO_ACCOUNT_NUMBER) {
        expect(other.phone).toMatch(/^\+325800000\d$/);
      }
    }
  });

  it("keeps +3258000001 in the fixtures for the canary lookup", () => {
    expect(findAccountByPhoneDigits("3258000001", null)).not.toBeNull();
  });

  it("normalises punctuation when looking a number up", () => {
    expect(phoneDigits("+32 58.00.00.01")).toBe("3258000001");
  });
});
