import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionDoc } from "@duinvezel/shared";

import { Session } from "../src/actors/session.js";
import {
  create,
  DEFAULT_LOCK_MS,
  DEFAULT_MAX_FAILURES,
  DEFAULT_TTL_MS,
  get,
  markDisclosure,
  recordVerifyFailure,
  setVerified,
} from "../src/domain/session.js";
import { createActorStorageFake } from "../../../packages/shared/test/fakes/actor-storage.js";

const SID = "0123456789abcdef0123456789abcdef";
const T0 = 1_000_000;
const FULL_INPUT = {
  traceId: "trace-abc",
  identity: "number_match" as const,
  accountNumber: "DV-100001",
  postcode: "8630",
  lineId: "line-1",
  callerPhone: "+3258000110",
};

/** A live session created at T0 with the default TTL, overridable per field. */
function liveSession(over: Partial<SessionDoc> = {}): SessionDoc {
  return {
    v: 1,
    sid: SID,
    traceId: "trace-abc",
    identity: "number_match",
    accountNumber: "DV-100001",
    postcode: "8630",
    lineId: "line-1",
    callerPhone: "+3258000110",
    createdAt: T0,
    expiresAt: T0 + DEFAULT_TTL_MS,
    disclosedAt: null,
    verify: { failures: 0, lockedUntil: null },
    ...over,
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const inner of Object.values(value)) {
      deepFreeze(inner);
    }
    Object.freeze(value);
  }
  return value;
}

// ---------- domain: create ----------

describe("create", () => {
  it("creates a session with all optional fields set", () => {
    const { state, result } = create(null, { ...FULL_INPUT, sid: SID, nowMs: T0 });
    expect(result.created).toBe(true);
    expect(result.session).toBe(state);
    expect(state).toEqual({
      v: 1,
      sid: SID,
      traceId: "trace-abc",
      identity: "number_match",
      accountNumber: "DV-100001",
      postcode: "8630",
      lineId: "line-1",
      callerPhone: "+3258000110",
      createdAt: T0,
      expiresAt: T0 + DEFAULT_TTL_MS,
      disclosedAt: null,
      verify: { failures: 0, lockedUntil: null },
    });
  });

  it("creates a session with the optional fields omitted: nulls and the two-hour default", () => {
    const { state, result } = create(null, {
      traceId: "trace-abc",
      identity: "anonymous",
      sid: SID,
      nowMs: T0,
    });
    expect(result.created).toBe(true);
    expect(state.accountNumber).toBeNull();
    expect(state.postcode).toBeNull();
    expect(state.lineId).toBeNull();
    expect(state.callerPhone).toBeNull();
    expect(state.expiresAt).toBe(T0 + 2 * 60 * 60 * 1000);
  });

  it("respects a custom ttlMs", () => {
    const { state } = create(null, {
      traceId: "trace-abc",
      identity: "attested",
      sid: SID,
      nowMs: T0,
      ttlMs: 60_000,
    });
    expect(state.createdAt).toBe(T0);
    expect(state.expiresAt).toBe(T0 + 60_000);
  });

  it("leaves a live session unchanged on a second create, whatever the input says", () => {
    const stored = liveSession();
    const { state, result } = create(stored, {
      traceId: "trace-OTHER",
      identity: "attested",
      accountNumber: "DV-999999",
      postcode: "9999",
      lineId: "line-OTHER",
      callerPhone: "+3258000111",
      sid: SID,
      nowMs: T0 + 1000,
      ttlMs: 5_000,
    });
    expect(result.created).toBe(false);
    expect(result.session).toBe(stored);
    expect(state).toBe(stored);
    // The stored doc kept its identity, account, disclosure and failures.
    expect(state.identity).toBe("number_match");
    expect(state.accountNumber).toBe("DV-100001");
  });

  it("starts a new session when the stored one has expired", () => {
    const expired = liveSession({
      createdAt: T0 - 10_000,
      expiresAt: T0,
      disclosedAt: T0 - 5000,
      verify: { failures: 2, lockedUntil: null },
    });
    const { state, result } = create(expired, { ...FULL_INPUT, sid: SID, nowMs: T0 });
    expect(result.created).toBe(true);
    expect(state.createdAt).toBe(T0);
    expect(state.expiresAt).toBe(T0 + DEFAULT_TTL_MS);
    expect(state.disclosedAt).toBeNull();
    expect(state.verify).toEqual({ failures: 0, lockedUntil: null });
  });

  it("treats a session expiring 1 ms from now as live, and one expiring exactly now as gone", () => {
    const liveByOne = liveSession({ expiresAt: T0 + 1 });
    expect(create(liveByOne, { ...FULL_INPUT, sid: SID, nowMs: T0 }).result.created).toBe(false);
    const goneNow = liveSession({ expiresAt: T0 });
    expect(create(goneNow, { ...FULL_INPUT, sid: SID, nowMs: T0 }).result.created).toBe(true);
  });

  it("still throws for a broken input when a live session exists", () => {
    const stored = liveSession();
    expect(() =>
      create(stored, { ...FULL_INPUT, sid: SID, nowMs: Number.NaN }),
    ).toThrow(RangeError);
    expect(() =>
      create(stored, { ...FULL_INPUT, sid: "not-a-sid", nowMs: T0 }),
    ).toThrow(RangeError);
  });
});

// ---------- domain: get ----------

describe("get", () => {
  it("returns the live session", () => {
    const s = liveSession();
    expect(get(s, T0 + 1000)).toBe(s);
  });

  it("returns the session 1 ms before expiresAt and null exactly at it", () => {
    const s = liveSession();
    expect(get(s, s.expiresAt - 1)).toBe(s);
    expect(get(s, s.expiresAt)).toBeNull();
  });

  it("returns null past expiresAt and when there is no session", () => {
    const s = liveSession();
    expect(get(s, s.expiresAt + 1)).toBeNull();
    expect(get(null, T0)).toBeNull();
  });
});

// ---------- domain: markDisclosure ----------

describe("markDisclosure", () => {
  it("logs the disclosure the first time and keeps the first time afterwards", () => {
    const s = liveSession();
    const first = markDisclosure(s, { nowMs: T0 + 100 });
    expect(first.result).toEqual({ outcome: "logged", traceId: "trace-abc" });
    expect(first.state).not.toBe(s);
    expect((first.state as SessionDoc).disclosedAt).toBe(T0 + 100);

    const second = markDisclosure(first.state, { nowMs: T0 + 200 });
    expect(second.result).toEqual({ outcome: "unchanged", traceId: "trace-abc" });
    expect(second.state).toBe(first.state);
    expect((second.state as SessionDoc).disclosedAt).toBe(T0 + 100);
  });

  it("answers missing on a missing session and changes nothing", () => {
    const { state, result } = markDisclosure(null, { nowMs: T0 });
    expect(result).toEqual({ outcome: "missing", traceId: null });
    expect(state).toBeNull();
  });

  it("answers missing on an expired session and changes nothing", () => {
    const expired = liveSession({ expiresAt: T0 });
    const { state, result } = markDisclosure(expired, { nowMs: T0 });
    expect(result).toEqual({ outcome: "missing", traceId: null });
    expect(state).toBe(expired);
  });

  it("is live 1 ms before expiresAt and gone exactly at it", () => {
    const s = liveSession();
    expect(markDisclosure(s, { nowMs: s.expiresAt - 1 }).result.outcome).toBe("logged");
    expect(markDisclosure(s, { nowMs: s.expiresAt }).result.outcome).toBe("missing");
  });
});

// ---------- domain: setVerified ----------

describe("setVerified", () => {
  const proof = { accountNumber: "DV-200002", postcode: "8670", lineId: "line-2" };

  it("sets the verified identity and replaces whatever account the session had", () => {
    const s = liveSession();
    const { state, result } = setVerified(s, { ...proof, nowMs: T0 + 100 });
    expect(result).toEqual({ outcome: "verified", lockedUntil: null });
    expect(state).not.toBe(s);
    const doc = state as SessionDoc;
    expect(doc.identity).toBe("verified");
    expect(doc.accountNumber).toBe("DV-200002");
    expect(doc.postcode).toBe("8670");
    expect(doc.lineId).toBe("line-2");
    // The rest of the session is untouched.
    expect(doc.traceId).toBe("trace-abc");
    expect(doc.callerPhone).toBe("+3258000110");
    expect(doc.expiresAt).toBe(s.expiresAt);
  });

  it("verifies a session that had no account", () => {
    const s = liveSession({ identity: "anonymous", accountNumber: null, postcode: null });
    const { state, result } = setVerified(s, { ...proof, nowMs: T0 + 100 });
    expect(result.outcome).toBe("verified");
    expect((state as SessionDoc).accountNumber).toBe("DV-200002");
  });

  it("is refused while the verify lock is active", () => {
    const s = liveSession({ verify: { failures: 0, lockedUntil: T0 + 60_000 } });
    const { state, result } = setVerified(s, { ...proof, nowMs: T0 + 1000 });
    expect(result).toEqual({ outcome: "locked", lockedUntil: T0 + 60_000 });
    expect(state).toBe(s);
  });

  it("is locked 1 ms before lockedUntil and free exactly at it", () => {
    const lockedUntil = T0 + 60_000;
    const s = liveSession({ verify: { failures: 0, lockedUntil } });
    expect(setVerified(s, { ...proof, nowMs: lockedUntil - 1 }).result.outcome).toBe("locked");
    const at = setVerified(s, { ...proof, nowMs: lockedUntil });
    expect(at.result.outcome).toBe("verified");
  });

  it("answers missing on a missing or expired session", () => {
    const missing = setVerified(null, { ...proof, nowMs: T0 });
    expect(missing.result).toEqual({ outcome: "missing", lockedUntil: null });
    expect(missing.state).toBeNull();
    const expired = liveSession({ expiresAt: T0 });
    const gone = setVerified(expired, { ...proof, nowMs: T0 });
    expect(gone.result).toEqual({ outcome: "missing", lockedUntil: null });
    expect(gone.state).toBe(expired);
  });

  it("is live 1 ms before expiresAt and gone exactly at it", () => {
    const s = liveSession();
    expect(setVerified(s, { ...proof, nowMs: s.expiresAt - 1 }).result.outcome).toBe("verified");
    expect(setVerified(s, { ...proof, nowMs: s.expiresAt }).result.outcome).toBe("missing");
  });
});

// ---------- domain: recordVerifyFailure ----------

describe("recordVerifyFailure", () => {
  it("counts attemptsLeft down with the defaults", () => {
    const s = liveSession();
    const first = recordVerifyFailure(s, { nowMs: T0 + 1 });
    expect(first.result).toEqual({ outcome: "counted", attemptsLeft: 2, lockedUntil: null });
    expect(first.result.attemptsLeft).toBe(DEFAULT_MAX_FAILURES - 1);
    expect((first.state as SessionDoc).verify).toEqual({ failures: 1, lockedUntil: null });

    const second = recordVerifyFailure(first.state, { nowMs: T0 + 2 });
    expect(second.result).toEqual({ outcome: "counted", attemptsLeft: 1, lockedUntil: null });
    expect((second.state as SessionDoc).verify).toEqual({ failures: 2, lockedUntil: null });
  });

  it("locks at exactly three failures, resetting the counter", () => {
    let s: SessionDoc | null = liveSession();
    for (let i = 1; i <= 3; i++) {
      const { state, result } = recordVerifyFailure(s, { nowMs: T0 + i });
      s = state;
      if (i < 3) {
        expect(result.outcome).toBe("counted");
        expect(result.attemptsLeft).toBe(3 - i);
        expect(result.lockedUntil).toBeNull();
      } else {
        // The third failure reaches maxFailures and locks.
        expect(result).toEqual({
          outcome: "locked",
          attemptsLeft: 0,
          lockedUntil: T0 + 3 + DEFAULT_LOCK_MS,
        });
      }
    }
    expect(s).not.toBeNull();
    expect((s as SessionDoc).verify).toEqual({
      failures: 0,
      lockedUntil: T0 + 3 + DEFAULT_LOCK_MS,
    });
  });

  it("respects a custom maxFailures and a custom lockMs", () => {
    let s: SessionDoc | null = liveSession();
    for (let i = 1; i <= 2; i++) {
      const { state, result } = recordVerifyFailure(s, {
        nowMs: T0 + i,
        maxFailures: 2,
        lockMs: 5_000,
      });
      s = state;
      if (i === 1) {
        expect(result).toEqual({ outcome: "counted", attemptsLeft: 1, lockedUntil: null });
      } else {
        expect(result).toEqual({
          outcome: "locked",
          attemptsLeft: 0,
          lockedUntil: T0 + 2 + 5_000,
        });
      }
    }
  });

  it("refuses a further failure while locked and changes nothing", () => {
    const lockedUntil = T0 + 1000 + DEFAULT_LOCK_MS;
    const s = liveSession({ verify: { failures: 0, lockedUntil } });
    const { state, result } = recordVerifyFailure(s, { nowMs: T0 + 1001 });
    expect(result).toEqual({ outcome: "locked", attemptsLeft: 0, lockedUntil });
    expect(state).toBe(s);
  });

  it("is locked 1 ms before lockedUntil and counts from zero again exactly at it", () => {
    const lockedUntil = T0 + 60_000;
    const s = liveSession({ verify: { failures: 0, lockedUntil } });
    const before = recordVerifyFailure(s, { nowMs: lockedUntil - 1 });
    expect(before.result.outcome).toBe("locked");
    expect(before.state).toBe(s);

    const at = recordVerifyFailure(s, { nowMs: lockedUntil });
    expect(at.result).toEqual({ outcome: "counted", attemptsLeft: 2, lockedUntil: null });
    expect((at.state as SessionDoc).verify).toEqual({ failures: 1, lockedUntil: null });
  });

  it("answers missing on a missing or expired session", () => {
    const missing = recordVerifyFailure(null, { nowMs: T0 });
    expect(missing.result).toEqual({ outcome: "missing", attemptsLeft: 0, lockedUntil: null });
    expect(missing.state).toBeNull();
    const expired = liveSession({ expiresAt: T0 });
    const gone = recordVerifyFailure(expired, { nowMs: T0 });
    expect(gone.result).toEqual({ outcome: "missing", attemptsLeft: 0, lockedUntil: null });
    expect(gone.state).toBe(expired);
  });

  it("is live 1 ms before expiresAt and gone exactly at it", () => {
    const s = liveSession();
    expect(recordVerifyFailure(s, { nowMs: s.expiresAt - 1 }).result.outcome).toBe("counted");
    expect(recordVerifyFailure(s, { nowMs: s.expiresAt }).result.outcome).toBe("missing");
  });

  it("still throws for a broken input when the session is missing", () => {
    expect(() => recordVerifyFailure(null, { nowMs: Number.NaN })).toThrow(RangeError);
    expect(() => markDisclosure(null, { nowMs: Number.NaN })).toThrow(RangeError);
    expect(() =>
      setVerified(null, { accountNumber: "DV-1", postcode: "8630", lineId: "l", nowMs: Number.NaN }),
    ).toThrow(RangeError);
  });
});

// ---------- same object, no mutation ----------

describe("unchanged calls and mutation", () => {
  it("a function that changes nothing returns the very object it was given", () => {
    const stored = liveSession({ disclosedAt: T0 + 50 });
    expect(create(stored, { ...FULL_INPUT, sid: SID, nowMs: T0 + 1 }).state).toBe(stored);
    expect(markDisclosure(stored, { nowMs: T0 + 1 }).state).toBe(stored);

    const locked = liveSession({ verify: { failures: 0, lockedUntil: T0 + 60_000 } });
    const proof = { accountNumber: "DV-1", postcode: "8630", lineId: "l" };
    expect(setVerified(locked, { ...proof, nowMs: T0 + 1 }).state).toBe(locked);
    expect(recordVerifyFailure(locked, { nowMs: T0 + 1 }).state).toBe(locked);

    // Missing and expired sessions: the input reference comes straight back.
    expect(markDisclosure(null, { nowMs: T0 }).state).toBeNull();
    expect(create(null, { ...FULL_INPUT, sid: SID, nowMs: T0 }).state).not.toBeNull();
    const expired = liveSession({ expiresAt: T0 });
    expect(setVerified(expired, { ...proof, nowMs: T0 }).state).toBe(expired);
    expect(recordVerifyFailure(expired, { nowMs: T0 }).state).toBe(expired);
  });

  it("no function mutates its state or its input, even frozen ones", () => {
    const state = deepFreeze(
      liveSession({ verify: { failures: 1, lockedUntil: null } }),
    );
    const createInput = deepFreeze({ ...FULL_INPUT, sid: SID, nowMs: T0 + 1, ttlMs: 5_000 });
    const failureInput = deepFreeze({ nowMs: T0 + 1, maxFailures: 5, lockMs: 60_000 });
    const verifiedInput = deepFreeze({
      accountNumber: "DV-200002",
      postcode: "8670",
      lineId: "line-2",
      nowMs: T0 + 1,
    });
    const before = JSON.stringify(state);

    create(state, createInput);
    markDisclosure(state, deepFreeze({ nowMs: T0 + 1 }));
    setVerified(state, verifiedInput);
    recordVerifyFailure(state, failureInput);
    get(state, T0 + 1);

    expect(JSON.stringify(state)).toBe(before);
    expect(createInput).toEqual({
      ...FULL_INPUT,
      sid: SID,
      nowMs: T0 + 1,
      ttlMs: 5_000,
    });
    expect(failureInput).toEqual({ nowMs: T0 + 1, maxFailures: 5, lockMs: 60_000 });
    expect(verifiedInput).toEqual({
      accountNumber: "DV-200002",
      postcode: "8670",
      lineId: "line-2",
      nowMs: T0 + 1,
    });
  });
});

// ---------- broken inputs fail closed ----------

describe("broken inputs throw RangeError", () => {
  const proof = { accountNumber: "DV-1", postcode: "8630", lineId: "l" };

  it.each([Number.NaN, Infinity, -Infinity])("create throws for nowMs = %s", (bad) => {
    expect(() => create(null, { ...FULL_INPUT, sid: SID, nowMs: bad })).toThrow(RangeError);
  });

  it.each([Number.NaN, Infinity, -Infinity, 0, -1])("create throws for ttlMs = %s", (bad) => {
    expect(() =>
      create(null, { ...FULL_INPUT, sid: SID, nowMs: T0, ttlMs: bad }),
    ).toThrow(RangeError);
  });

  it.each([
    "",
    "0123456789abcdef0123456789abcde", // 31 chars
    "0123456789abcdef0123456789abcdef0", // 33 chars
    "0123456789ABCDEF0123456789ABCDEF", // uppercase
    "0123456789abcdef0123456789abcdeg", // not hex
    "session-0123456789abcdef0123456789",
  ])("create throws for sid = %j", (bad) => {
    expect(() => create(null, { ...FULL_INPUT, sid: bad, nowMs: T0 })).toThrow(RangeError);
  });

  it.each([Number.NaN, Infinity, -Infinity])("get throws for nowMs = %s", (bad) => {
    expect(() => get(liveSession(), bad)).toThrow(RangeError);
    expect(() => get(null, bad)).toThrow(RangeError);
  });

  it.each([Number.NaN, Infinity, -Infinity])("markDisclosure throws for nowMs = %s", (bad) => {
    expect(() => markDisclosure(liveSession(), { nowMs: bad })).toThrow(RangeError);
  });

  it.each([Number.NaN, Infinity, -Infinity])("setVerified throws for nowMs = %s", (bad) => {
    expect(() => setVerified(liveSession(), { ...proof, nowMs: bad })).toThrow(RangeError);
  });

  it.each([Number.NaN, Infinity, -Infinity])(
    "recordVerifyFailure throws for nowMs = %s",
    (bad) => {
      expect(() => recordVerifyFailure(liveSession(), { nowMs: bad })).toThrow(RangeError);
    },
  );

  it.each([Number.NaN, Infinity, -Infinity, 0, -1])(
    "recordVerifyFailure throws for lockMs = %s",
    (bad) => {
      expect(() => recordVerifyFailure(liveSession(), { nowMs: T0, lockMs: bad })).toThrow(
        RangeError,
      );
    },
  );

  it.each([Number.NaN, Infinity, -Infinity, 0, -1, 2.5])(
    "recordVerifyFailure throws for maxFailures = %s",
    (bad) => {
      expect(() =>
        recordVerifyFailure(liveSession(), { nowMs: T0, maxFailures: bad }),
      ).toThrow(RangeError);
    },
  );
});

// ---------- actor adapter ----------

describe("Session actor adapter", () => {
  async function wire(
    state: SessionDoc | null = null,
    id: string = SID,
  ): Promise<{
    storage: ReturnType<typeof createActorStorageFake>;
    actor: Session;
  }> {
    const storage = createActorStorageFake();
    if (state !== null) {
      await storage.put("state", state);
    }
    storage.reset();
    return { storage, actor: new Session({ storage, id } as never, {} as never) };
  }

  function writeCalls(storage: ReturnType<typeof createActorStorageFake>) {
    return storage.calls.filter((c) => c.method !== "get" && c.method !== "getAlarm");
  }

  it("fills the sid from the instance name, stores the doc and sets the alarm to expiresAt", async () => {
    const { storage, actor } = await wire();
    const result = await actor.create({ ...FULL_INPUT, nowMs: T0 });
    expect(result.created).toBe(true);
    expect(result.session.sid).toBe(SID);
    const stored = await storage.get<SessionDoc>("state");
    expect(stored?.sid).toBe(SID);
    expect(stored?.expiresAt).toBe(T0 + DEFAULT_TTL_MS);
    expect(await storage.getAlarm()).toBe(T0 + DEFAULT_TTL_MS);
  });

  it("sets the alarm to a custom ttl's expiresAt", async () => {
    const { storage, actor } = await wire();
    await actor.create({ ...FULL_INPUT, nowMs: T0, ttlMs: 30_000 });
    expect(await storage.getAlarm()).toBe(T0 + 30_000);
  });

  it("a second create on a live session writes nothing and returns existing", async () => {
    const { storage, actor } = await wire(liveSession());
    const result = await actor.create({
      traceId: "trace-OTHER",
      identity: "attested",
      nowMs: T0 + 1000,
    });
    expect(result.created).toBe(false);
    expect(result.session.sid).toBe(SID);
    expect(writeCalls(storage)).toEqual([]);
  });

  it("create after expiry saves the new session and re-arms the alarm", async () => {
    const { storage, actor } = await wire(
      liveSession({ createdAt: T0 - 10_000, expiresAt: T0 }),
    );
    const result = await actor.create({ ...FULL_INPUT, nowMs: T0 });
    expect(result.created).toBe(true);
    const stored = await storage.get<SessionDoc>("state");
    expect(stored?.createdAt).toBe(T0);
    expect(await storage.getAlarm()).toBe(T0 + DEFAULT_TTL_MS);
  });

  it("get returns the live session and null for an expired or missing one", async () => {
    const s = liveSession();
    const live = await wire(s);
    expect(await live.actor.get({ nowMs: T0 + 1000 })).toEqual(s);
    expect(writeCalls(live.storage)).toEqual([]);

    const expired = await wire(liveSession({ expiresAt: T0 }));
    expect(await expired.actor.get({ nowMs: T0 })).toBeNull();

    const missing = await wire();
    expect(await missing.actor.get({ nowMs: T0 })).toBeNull();
  });

  it("markDisclosure saves the disclosure once on a live session", async () => {
    const { storage, actor } = await wire(liveSession());
    const first = await actor.markDisclosure({ nowMs: T0 + 100 });
    expect(first).toEqual({ outcome: "logged", traceId: "trace-abc" });
    const stored = await storage.get<SessionDoc>("state");
    expect(stored?.disclosedAt).toBe(T0 + 100);

    storage.reset();
    const second = await actor.markDisclosure({ nowMs: T0 + 200 });
    expect(second).toEqual({ outcome: "unchanged", traceId: "trace-abc" });
    expect(writeCalls(storage)).toEqual([]);
  });

  it("setVerified saves the verified identity and the new account", async () => {
    const { storage, actor } = await wire(liveSession());
    const result = await actor.setVerified({
      accountNumber: "DV-200002",
      postcode: "8670",
      lineId: "line-2",
      nowMs: T0 + 100,
    });
    expect(result).toEqual({ outcome: "verified", lockedUntil: null });
    const stored = await storage.get<SessionDoc>("state");
    expect(stored?.identity).toBe("verified");
    expect(stored?.accountNumber).toBe("DV-200002");
  });

  it("recordVerifyFailure saves the counted failure", async () => {
    const { storage, actor } = await wire(liveSession());
    const result = await actor.recordVerifyFailure({ nowMs: T0 + 1 });
    expect(result).toEqual({ outcome: "counted", attemptsLeft: 2, lockedUntil: null });
    const stored = await storage.get<SessionDoc>("state");
    expect(stored?.verify).toEqual({ failures: 1, lockedUntil: null });
  });

  it("markDisclosure, setVerified and recordVerifyFailure on a missing session write nothing", async () => {
    const { storage, actor } = await wire();
    expect((await actor.markDisclosure({ nowMs: T0 })).outcome).toBe("missing");
    expect(
      (
        await actor.setVerified({
          accountNumber: "DV-1",
          postcode: "8630",
          lineId: "l",
          nowMs: T0,
        })
      ).outcome,
    ).toBe("missing");
    expect((await actor.recordVerifyFailure({ nowMs: T0 })).outcome).toBe("missing");
    // Nothing stored, no writes at all: a guessed sid leaves no state behind.
    expect(writeCalls(storage)).toEqual([]);
    expect(await storage.get("state")).toBeUndefined();
    expect(await storage.getAlarm()).toBeNull();
  });

  it("markDisclosure, setVerified and recordVerifyFailure on an expired session write nothing", async () => {
    const { storage, actor } = await wire(liveSession({ expiresAt: T0 }));
    const at = T0 + 1000;
    expect((await actor.markDisclosure({ nowMs: at })).outcome).toBe("missing");
    expect(
      (
        await actor.setVerified({
          accountNumber: "DV-1",
          postcode: "8630",
          lineId: "l",
          nowMs: at,
        })
      ).outcome,
    ).toBe("missing");
    expect((await actor.recordVerifyFailure({ nowMs: at })).outcome).toBe("missing");
    expect(writeCalls(storage)).toEqual([]);
  });

  it("the alarm deletes an expired session and is safe to run twice", async () => {
    const { storage, actor } = await wire(
      liveSession({ createdAt: 0, expiresAt: 1 }),
    );
    await actor.alarm({ retryCount: 0, isRetry: false });
    expect(await storage.get("state")).toBeUndefined();
    expect(storage.calls.map((c) => c.method)).toEqual(["get", "deleteAll", "get"]);
    // A redelivered alarm finds nothing and does nothing.
    await actor.alarm({ retryCount: 1, isRetry: true });
    expect(await storage.get("state")).toBeUndefined();
  });

  it("the alarm re-arms itself for a live session (one created again after an expiry)", async () => {
    const farFuture = 4_000_000_000_000; // 2096: live under the real clock.
    const { storage, actor } = await wire(
      liveSession({ createdAt: farFuture - DEFAULT_TTL_MS, expiresAt: farFuture }),
    );
    await actor.alarm({ retryCount: 0, isRetry: false });
    expect(await storage.getAlarm()).toBe(farFuture);
    // The state is untouched.
    expect(await storage.get<SessionDoc>("state")).toMatchObject({ sid: SID });
  });

  it("the alarm does nothing when there is no state", async () => {
    const { storage, actor } = await wire();
    await actor.alarm({ retryCount: 0, isRetry: false });
    expect(writeCalls(storage)).toEqual([]);
  });
});

// ---------- actor logging ----------

describe("Session logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Seeds fresh storage, wires an actor named like a real instance
  // (idFromName(sid)), captures what the shared logger writes to stdout and
  // returns a reader for the `"actor"` lines it emitted.
  async function wire(state: SessionDoc | null = null) {
    const storage = createActorStorageFake();
    if (state !== null) {
      await storage.put("state", state);
    }
    const actor = new Session({ storage, id: SID } as never, {} as never);
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const lines = (): Record<string, unknown>[] =>
      spy.mock.calls
        .map((call) => String(call[0]))
        .filter((text) => text.includes('"event":"actor"'))
        .map((text) => JSON.parse(text) as Record<string, unknown>);
    return { storage, actor, lines };
  }

  /** latency_ms is the timing helper's snapshot: an object with total and the actor hop, never a bare number. */
  function expectLatencyShape(line: Record<string, unknown>) {
    expect(line.latency_ms).toEqual(
      expect.objectContaining({ total: expect.any(Number), actor: expect.any(Number) }),
    );
  }

  it("create writes one line with the trace id, sid, method, masked account, outcome and latency", async () => {
    const { actor, lines } = await wire();
    await actor.create({ ...FULL_INPUT, nowMs: T0 });
    expect(lines()).toHaveLength(1);
    const line = lines()[0];
    expect(line).toMatchObject({
      level: "info",
      svc: "voice-tools",
      event: "actor",
      actor: "Session",
      method: "create",
      trace_id: "trace-abc",
      sid: SID,
      account: "DV-…001",
      outcome: "created",
    });
    expectLatencyShape(line);
    // No field carries the caller's phone number.
    expect(JSON.stringify(line)).not.toContain("3258000110");
    expect(JSON.stringify(line)).not.toContain(FULL_INPUT.callerPhone);
  });

  it("create on an existing session logs existing, and a session without an account logs account null", async () => {
    const { actor, lines } = await wire(liveSession({ accountNumber: null }));
    await actor.create({ ...FULL_INPUT, nowMs: T0 + 1 });
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({
      method: "create",
      outcome: "existing",
      account: null,
      trace_id: "trace-abc",
      sid: SID,
    });
    expectLatencyShape(lines()[0]);
  });

  it("markDisclosure prefers the trace id argument and falls back to the stored session's", async () => {
    const { actor, lines } = await wire(liveSession());
    await actor.markDisclosure({ nowMs: T0 + 1 }, "trace-explicit");
    await actor.markDisclosure({ nowMs: T0 + 2 });
    expect(lines().map((l) => [l.method, l.trace_id, l.outcome, l.account])).toEqual([
      ["markDisclosure", "trace-explicit", "logged", "DV-…001"],
      ["markDisclosure", "trace-abc", "unchanged", "DV-…001"],
    ]);
    expectLatencyShape(lines()[0]);
    expectLatencyShape(lines()[1]);
  });

  it("markDisclosure on a missing session logs trace_id and account null", async () => {
    const { actor, lines } = await wire();
    await actor.markDisclosure({ nowMs: T0 });
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({
      method: "markDisclosure",
      outcome: "missing",
      trace_id: null,
      account: null,
      sid: SID,
    });
    expectLatencyShape(lines()[0]);
  });

  it("setVerified logs its outcome with the new account masked", async () => {
    const { actor, lines } = await wire(liveSession());
    await actor.setVerified(
      { accountNumber: "DV-200002", postcode: "8670", lineId: "line-2", nowMs: T0 + 1 },
      "trace-9",
    );
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({
      method: "setVerified",
      trace_id: "trace-9",
      outcome: "verified",
      account: "DV-…002",
      sid: SID,
    });
    expect(JSON.stringify(lines()[0])).not.toContain("DV-200002");
    expectLatencyShape(lines()[0]);
  });

  it("recordVerifyFailure logs counted, then locked at the third failure", async () => {
    const { actor, lines } = await wire(liveSession());
    await actor.recordVerifyFailure({ nowMs: T0 + 1 }, "trace-7");
    await actor.recordVerifyFailure({ nowMs: T0 + 2 }, "trace-7");
    await actor.recordVerifyFailure({ nowMs: T0 + 3 }, "trace-7");
    // A further failure while locked logs the stored session's trace id.
    await actor.recordVerifyFailure({ nowMs: T0 + 4 });
    expect(lines().map((l) => [l.method, l.trace_id, l.outcome])).toEqual([
      ["recordVerifyFailure", "trace-7", "counted"],
      ["recordVerifyFailure", "trace-7", "counted"],
      ["recordVerifyFailure", "trace-7", "locked"],
      ["recordVerifyFailure", "trace-abc", "locked"],
    ]);
    for (const line of lines()) {
      expectLatencyShape(line);
    }
  });

  it("get writes no line", async () => {
    const { actor, lines } = await wire(liveSession());
    await actor.get({ nowMs: T0 + 1 });
    expect(lines()).toHaveLength(0);
  });

  it("a method that throws logs one error line and rethrows", async () => {
    const { actor, lines } = await wire();
    await expect(
      actor.create({ ...FULL_INPUT, nowMs: Number.NaN }),
    ).rejects.toThrow(RangeError);
    expect(lines()).toHaveLength(1);
    const line = lines()[0];
    expect(line).toMatchObject({
      level: "error",
      event: "actor",
      actor: "Session",
      method: "create",
      trace_id: "trace-abc",
      sid: SID,
      account: null,
      outcome: "error",
    });
    expectLatencyShape(line);
  });

  it("a failing setVerified logs the stored session's trace id on the error line", async () => {
    const { actor, lines } = await wire(liveSession());
    await expect(
      actor.setVerified({
        accountNumber: "DV-200002",
        postcode: "8670",
        lineId: "line-2",
        nowMs: Number.NaN,
      }),
    ).rejects.toThrow(RangeError);
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({
      level: "error",
      method: "setVerified",
      trace_id: "trace-abc",
      account: "DV-…001",
      outcome: "error",
    });
    expectLatencyShape(lines()[0]);
  });
});
