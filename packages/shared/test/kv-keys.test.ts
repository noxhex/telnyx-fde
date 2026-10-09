import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { assertValidKey, kvKeys, sessionIdFromCallControlId } from "../src/index.js";

const SID = "0123456789abcdef0123456789abcdef";

describe("kvKeys", () => {
  describe("crmPhone", () => {
    it("drops the + and keeps digits only", () => {
      expect(kvKeys.crmPhone("+32491244713")).toBe("crm/phone/32491244713");
    });

    it("strips non-digit characters such as spaces and dashes", () => {
      expect(kvKeys.crmPhone("+32 491 244 713")).toBe("crm/phone/32491244713");
      expect(kvKeys.crmPhone("+32-491-244-713")).toBe("crm/phone/32491244713");
    });
  });

  describe("session", () => {
    it("accepts a 32 lowercase-hex sid", () => {
      expect(kvKeys.session(SID)).toBe(`session/${SID}`);
    });

    it("throws on a sid that is not 32 lowercase hex characters", () => {
      for (const bad of [
        "",
        SID.toUpperCase(),
        "0123456789abcdef0123456789abcdeg",
        "0123456789abcdef0123456789abcde", // 31 chars
        `${SID}f`, // 33 chars
        `${SID.replace("0", "G")}`,
      ]) {
        expect(() => kvKeys.session(bad)).toThrow();
      }
    });
  });

  describe("callback", () => {
    it("accepts a 32 lowercase-hex sid", () => {
      expect(kvKeys.callback(SID)).toBe(`callback/${SID}`);
    });

    it("throws on an invalid sid", () => {
      for (const bad of ["", SID.toUpperCase(), "short", `${SID}f`]) {
        expect(() => kvKeys.callback(bad)).toThrow();
      }
    });
  });

  describe("areaStatus", () => {
    it("accepts a four-digit postcode", () => {
      expect(kvKeys.areaStatus("8630")).toBe("area/8630/status");
    });

    it("throws for anything that is not exactly four digits", () => {
      for (const bad of ["863", "86301", "86a0", "", "ab12"]) {
        expect(() => kvKeys.areaStatus(bad)).toThrow();
      }
    });
  });

  describe("static keys", () => {
    it("builds the fixed keys", () => {
      expect(kvKeys.flags()).toBe("flags/global");
      expect(kvKeys.canaryLast()).toBe("canary/last");
      expect(kvKeys.canaryProbe()).toBe("canary/probe");
    });
  });
});

describe("sessionIdFromCallControlId", () => {
  it("returns the first 32 hex characters of the SHA-256 over the UTF-8 id", () => {
    const id = "Control State:4608e0c0-3f2c-4d:call";
    const expected = createHash("sha256").update(id, "utf8").digest("hex").slice(0, 32);
    expect(sessionIdFromCallControlId(id)).toBe(expected);
  });

  it("is stable for a given call control id", () => {
    const id = "1116-lkj3-df8f-3a:audio";
    expect(sessionIdFromCallControlId(id)).toBe(sessionIdFromCallControlId(id));
  });

  it("produces exactly 32 lowercase hex characters for realistic ids containing colons", () => {
    for (const id of ["aaa:bbb", "call-1234", "øæ:call"]) {
      expect(sessionIdFromCallControlId(id)).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it("returns a known constant for a fixed input", () => {
    // sha256("hello") truncated to 32 hex characters.
    expect(sessionIdFromCallControlId("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e",
    );
  });
});

describe("assertValidKey", () => {
  it("accepts keys built from the allowed character set", () => {
    expect(() => assertValidKey("crm/phone/32491244713")).not.toThrow();
    expect(() => assertValidKey("a-zA-Z0-9-_/=.for")).not.toThrow();
    expect(() => assertValidKey("area/8630/status")).not.toThrow();
    expect(() => assertValidKey("x")).not.toThrow();
  });

  it("rejects an empty key", () => {
    expect(() => assertValidKey("")).toThrow();
  });

  it("rejects a key longer than 256 characters", () => {
    expect(() => assertValidKey("a".repeat(257))).toThrow();
    expect(() => assertValidKey("a".repeat(256))).not.toThrow();
  });

  it("rejects a key containing a colon", () => {
    expect(() => assertValidKey("crm/phone/32:49")).toThrow();
  });

  it("rejects a key containing a plus sign", () => {
    expect(() => assertValidKey("crm/phone/+32491244713")).toThrow();
  });

  it("rejects keys with other characters outside the allowed set", () => {
    for (const bad of ["a b", "a\tb", "a,b", "a@b", "a#b", "a;b"]) {
      expect(() => assertValidKey(bad)).toThrow();
    }
  });
});