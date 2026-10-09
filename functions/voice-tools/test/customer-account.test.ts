import { describe, expect, it } from "vitest";

import { CustomerAccount } from "../src/actors/customer-account.js";
import {
  clearExpiredLock,
  createTicket,
  initialState,
  recordCall,
  verify,
} from "../src/domain/customer-account.js";
import type { CustomerAccountState, TicketCategory } from "../src/domain/customer-account.js";
import { createActorStorageFake } from "../../../packages/shared/test/fakes/actor-storage.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LOCK_MS = 15 * 60 * 1000;

// ---------- recordCall ----------

describe("recordCall", () => {
  it("records a first call as one, not a repeat caller", () => {
    let s = initialState();
    const { state, result } = recordCall(s, { callId: "call-1", nowMs: 1000 });
    s = state;
    expect(result).toEqual({
      callCount24h: 1,
      repeatCaller: false,
      lockedUntil: null,
    });
    expect(s.calls).toEqual([{ id: "call-1", at: 1000 }]);
  });

  it("reports a repeat caller at exactly three calls", () => {
    let s = initialState();
    for (const callId of ["call-1", "call-2"]) {
      const { state, result } = recordCall(s, { callId, nowMs: 1000 });
      s = state;
      expect(result.callCount24h).toBe(Number(callId.replace("call-", "")));
      expect(result.repeatCaller).toBe(false);
    }
    // The third call, counted with the first two, crosses the line.
    expect(recordCall(s, { callId: "call-3", nowMs: 1000 }).result).toEqual({
      callCount24h: 3,
      repeatCaller: true,
      lockedUntil: null,
    });
  });

  it("reports a repeat caller at exactly three calls across a window", () => {
    let s = initialState();
    s = recordCall(s, { callId: "a", nowMs: 0 }).state;
    s = recordCall(s, { callId: "b", nowMs: 1 }).state;
    const { state, result } = recordCall(s, { callId: "c", nowMs: 2 });
    expect(result.callCount24h).toBe(3);
    expect(result.repeatCaller).toBe(true);
    expect(state.calls).toHaveLength(3);
  });

  it("does not count a duplicate call id twice (webhook retries)", () => {
    let s = initialState();
    s = recordCall(s, { callId: "call-1", nowMs: 1000 }).state;
    const { state, result } = recordCall(s, { callId: "call-1", nowMs: 1000 });
    expect(result.callCount24h).toBe(1);
    expect(result.repeatCaller).toBe(false);
    expect(state.calls).toHaveLength(1);
  });

  it("keeps a retried call id from pushing the count to the threshold", () => {
    let s = initialState();
    s = recordCall(s, { callId: "a", nowMs: 1000 }).state;
    s = recordCall(s, { callId: "b", nowMs: 1000 }).state;
    // A retry of an already-recorded call must not push the count to three.
    const { state, result } = recordCall(s, { callId: "a", nowMs: 1000 });
    expect(result.callCount24h).toBe(2);
    expect(result.repeatCaller).toBe(false);
    expect(state.calls).toHaveLength(2);
  });

  it("drops a call exactly 24 hours old", () => {
    let s = initialState();
    s = recordCall(s, { callId: "old", nowMs: 0 }).state;
    // Exactly 24 hours later the old call drops out of the window.
    const { state, result } = recordCall(s, { callId: "new", nowMs: DAY_MS });
    expect(result.callCount24h).toBe(1);
    expect(result.repeatCaller).toBe(false);
    expect(state.calls.map((c) => c.id)).toEqual(["new"]);
  });

  it("keeps a call one millisecond short of 24 hours", () => {
    let s = initialState();
    s = recordCall(s, { callId: "still-in", nowMs: 0 }).state;
    const { state, result } = recordCall(s, { callId: "new", nowMs: DAY_MS - 1 });
    expect(result.callCount24h).toBe(2);
    expect(state.calls).toHaveLength(2);
  });

  it("counts only fresh calls for the repeat-caller decision", () => {
    let s = initialState();
    s = recordCall(s, { callId: "a", nowMs: 0 }).state;
    s = recordCall(s, { callId: "b", nowMs: 0 }).state;
    // Two old calls and one fresh call: only the fresh one is counted.
    const { state, result } = recordCall(s, { callId: "c", nowMs: DAY_MS + 1 });
    expect(result.callCount24h).toBe(1);
    expect(result.repeatCaller).toBe(false);
    expect(state.calls.map((c) => c.id)).toEqual(["c"]);
  });

  it("reports the current lockedUntil in its result", () => {
    let s = initialState();
    s = recordCall(s, { callId: "a", nowMs: 1000 }).state;
    // Simulate an active lock by seeding verify.lockedUntil directly.
    s = { ...s, verify: { failures: 0, lockedUntil: 10_000 } };
    const { result } = recordCall(s, { callId: "b", nowMs: 1000 });
    expect(result.lockedUntil).toBe(10_000);
  });

  it("reports a null lockedUntil when the account is not locked", () => {
    let s = initialState();
    const { result } = recordCall(s, { callId: "a", nowMs: 1000 });
    expect(result.lockedUntil).toBeNull();
  });
});

// ---------- verify ----------

describe("verify", () => {
  const base = {
    submitted: { postcode: "8630", accountNumber: "DV-100001" },
    expected: { postcode: "8630", accountNumber: "DV-100001" },
  };

  it("returns ok for correct full details and resets failures", () => {
    let s: CustomerAccountState = {
      ...initialState(),
      verify: { failures: 2, lockedUntil: null },
    };
    const { state, result } = verify(s, { ...base, mode: "full", nowMs: 1000 });
    expect(result.outcome).toBe("ok");
    expect(result.attemptsLeft).toBe(3);
    expect(result.lockedUntil).toBeNull();
    expect(state.verify.failures).toBe(0);
    expect(state.verify.lockedUntil).toBeNull();
  });

  it("increments the failure count on a wrong postcode", () => {
    let s = initialState();
    const { state, result } = verify(s, {
      ...base,
      mode: "full",
      nowMs: 1000,
      submitted: { postcode: "9999", accountNumber: "DV-100001" },
    });
    expect(result.outcome).toBe("wrong");
    expect(result.attemptsLeft).toBe(2);
    expect(result.lockedUntil).toBeNull();
    expect(state.verify.failures).toBe(1);
  });

  it("locks after three failures by default and resets the counter", () => {
    let s = initialState();
    const t0 = 1000;
    for (let i = 1; i <= 3; i++) {
      const { state, result } = verify(s, {
        ...base,
        mode: "full",
        nowMs: t0 + i,
        submitted: { postcode: "9999", accountNumber: "DV-100001" },
      });
      s = state;
      if (i < 3) {
        expect(result.outcome).toBe("wrong");
        expect(result.attemptsLeft).toBe(3 - i);
        expect(result.lockedUntil).toBeNull();
      } else {
        // The third failure reaches maxFailures and locks the account.
        expect(result.outcome).toBe("wrong");
        expect(result.attemptsLeft).toBe(0);
        expect(result.lockedUntil).toBe(t0 + 3 + DEFAULT_LOCK_MS);
      }
    }
    expect(s.verify.failures).toBe(0);
    expect(s.verify.lockedUntil).toBe(t0 + 3 + DEFAULT_LOCK_MS);
  });

  it("respects a custom maxFailures value", () => {
    let s = initialState();
    const t0 = 1000;
    for (let i = 1; i <= 2; i++) {
      const { state, result } = verify(s, {
        ...base,
        mode: "full",
        nowMs: t0 + i,
        maxFailures: 2,
        submitted: { postcode: "9999", accountNumber: "DV-100001" },
      });
      s = state;
      expect(result.outcome).toBe("wrong");
      if (i === 2) {
        expect(result.attemptsLeft).toBe(0);
        expect(result.lockedUntil).toBe(t0 + 2 + DEFAULT_LOCK_MS);
      }
    }
    expect(s.verify.lockedUntil).toBe(t0 + 2 + DEFAULT_LOCK_MS);
  });

  it("respects a custom lockMs value", () => {
    let s = initialState();
    const t0 = 1000;
    const lockMs = 5 * 60 * 1000;
    for (let i = 1; i <= 3; i++) {
      const { state, result } = verify(s, {
        ...base,
        mode: "full",
        nowMs: t0 + i,
        lockMs,
        submitted: { postcode: "9999", accountNumber: "DV-100001" },
      });
      s = state;
      if (i === 3) {
        expect(result.lockedUntil).toBe(t0 + 3 + lockMs);
      }
    }
  });

  it("refuses even correct details while locked", () => {
    let s: CustomerAccountState = {
      ...initialState(),
      verify: { failures: 0, lockedUntil: 100_000 },
    };
    // lockedUntil is in the future relative to nowMs=50_000.
    const { state, result } = verify(s, {
      ...base,
      mode: "full",
      nowMs: 50_000,
    });
    expect(result.outcome).toBe("locked");
    expect(result.attemptsLeft).toBe(0);
    expect(result.lockedUntil).toBe(100_000);
    // State is untouched: nothing compared or reset.
    expect(state.verify).toEqual({ failures: 0, lockedUntil: 100_000 });
    expect(state.calls).toEqual(s.calls);
  });

  it("unlocks once the lock time has passed and accepts correct details", () => {
    let s: CustomerAccountState = {
      ...initialState(),
      verify: { failures: 0, lockedUntil: 100_000 },
    };
    // lockedUntil (100_000) has passed at nowMs=100_001.
    const { state, result } = verify(s, {
      ...base,
      mode: "full",
      nowMs: 100_001,
    });
    expect(result.outcome).toBe("ok");
    expect(result.lockedUntil).toBeNull();
    expect(state.verify.failures).toBe(0);
  });

  it("starts a fresh failure counter after the lock expires", () => {
    let s: CustomerAccountState = {
      ...initialState(),
      verify: { failures: 0, lockedUntil: 1000 },
    };
    // Lock expired; a fresh failure starts a new counter.
    const first = verify(s, {
      ...base,
      mode: "full",
      nowMs: 100_000,
      submitted: { postcode: "9999", accountNumber: "DV-100001" },
    });
    expect(first.result.outcome).toBe("wrong");
    expect(first.state.verify.failures).toBe(1);
  });

  it("postcode mode ignores the account number", () => {
    const { result } = verify(initialState(), {
      mode: "postcode",
      submitted: { postcode: "8630", accountNumber: "WRONG-ACCOUNT" },
      expected: { postcode: "8630", accountNumber: "DV-100001" },
      nowMs: 1000,
    });
    expect(result.outcome).toBe("ok");
  });

  it("postcode mode still rejects a wrong postcode", () => {
    const { result } = verify(initialState(), {
      mode: "postcode",
      submitted: { postcode: "9999" },
      expected: { postcode: "8630", accountNumber: "DV-100001" },
      nowMs: 1000,
    });
    expect(result.outcome).toBe("wrong");
  });

  it("normalises leading/trailing space and case", () => {
    const { result } = verify(initialState(), {
      mode: "full",
      submitted: { postcode: " 8630 ", accountNumber: "dv-100001" },
      expected: { postcode: "8630", accountNumber: "DV-100001" },
      nowMs: 1000,
    });
    expect(result.outcome).toBe("ok");
  });

  it("normalises internal spaces", () => {
    const { result } = verify(initialState(), {
      mode: "full",
      submitted: { postcode: "8 6 3 0", accountNumber: "DV - 100001" },
      expected: { postcode: "8630", accountNumber: "DV-100001" },
      nowMs: 1000,
    });
    expect(result.outcome).toBe("ok");
  });

  it("does not match when the submitted postcode has different content", () => {
    const { result } = verify(initialState(), {
      mode: "full",
      submitted: { postcode: " 8631 ", accountNumber: "DV-100001" },
      expected: { postcode: "8630", accountNumber: "DV-100001" },
      nowMs: 1000,
    });
    expect(result.outcome).toBe("wrong");
  });
});

// ---------- clearExpiredLock ----------

describe("clearExpiredLock", () => {
  it("removes a lock whose time has passed", () => {
    const s: CustomerAccountState = {
      ...initialState(),
      verify: { failures: 2, lockedUntil: 10_000 },
    };
    const next = clearExpiredLock(s, 10_001);
    expect(next.verify.lockedUntil).toBeNull();
    // Failures are left untouched; only the lock is cleared.
    expect(next.verify.failures).toBe(2);
  });

  it("removes a lock exactly at the boundary", () => {
    const s: CustomerAccountState = {
      ...initialState(),
      verify: { failures: 0, lockedUntil: 10_000 },
    };
    // At nowMs === lockedUntil the lock has elapsed.
    expect(clearExpiredLock(s, 10_000).verify.lockedUntil).toBeNull();
  });

  it("keeps a lock one millisecond before it expires", () => {
    const s: CustomerAccountState = {
      ...initialState(),
      verify: { failures: 0, lockedUntil: 10_000 },
    };
    expect(clearExpiredLock(s, 9_999).verify.lockedUntil).toBe(10_000);
  });

  it("keeps a lock that is still in the future", () => {
    const s: CustomerAccountState = {
      ...initialState(),
      verify: { failures: 0, lockedUntil: 10_000 },
    };
    expect(clearExpiredLock(s, 5_000).verify.lockedUntil).toBe(10_000);
  });

  it("leaves an unlocked account unchanged", () => {
    const s = initialState();
    expect(clearExpiredLock(s, 1_000)).toEqual(s);
  });
});

// ---------- createTicket ----------

describe("createTicket", () => {
  const ticketInput = (over: Partial<Parameters<typeof createTicket>[1]> = {}) => ({
    dedupeKey: "call-123|repair_visit",
    ticketId: "T-0001",
    category: "repair_visit" as TicketCategory,
    summary: "Fiber down in the street",
    nowMs: 1000,
    window: "tomorrow 08:00-12:00",
    ...over,
  });

  it("creates a ticket and returns created: true", () => {
    const s = initialState();
    const { state, result } = createTicket(s, ticketInput());
    expect(result).toEqual({
      ticketId: "T-0001",
      created: true,
      window: "tomorrow 08:00-12:00",
    });
    expect(state.tickets).toEqual([
      {
        id: "T-0001",
        dedupeKey: "call-123|repair_visit",
        category: "repair_visit",
        summary: "Fiber down in the street",
        createdAt: 1000,
        window: "tomorrow 08:00-12:00",
      },
    ]);
  });

  it("returns the existing ticket with created: false on a duplicate dedupe key", () => {
    let s = initialState();
    s = createTicket(s, ticketInput()).state;
    const { state, result } = createTicket(s, ticketInput({ summary: "changed" }));
    expect(result).toEqual({
      ticketId: "T-0001",
      created: false,
      window: "tomorrow 08:00-12:00",
    });
    // No new ticket is appended.
    expect(state.tickets).toHaveLength(1);
  });

  it("appends multiple tickets with different dedupe keys", () => {
    let s = initialState();
    s = createTicket(s, ticketInput()).state;
    const second = createTicket(
      s,
      ticketInput({ dedupeKey: "call-456", ticketId: "T-0002", category: "callback" }),
    );
    expect(second.result.created).toBe(true);
    expect(second.state.tickets).toHaveLength(2);
  });

  it("keeps the category in the dedupe key: repair_visit and callback for one call are two tickets", () => {
    let s = initialState();
    s = createTicket(s, ticketInput()).state;
    // Same session id, different category: a distinct key, a second ticket.
    const callback = createTicket(
      s,
      ticketInput({ dedupeKey: "call-123|callback", ticketId: "T-0002", category: "callback" }),
    );
    expect(callback.result.created).toBe(true);
    expect(callback.state.tickets).toHaveLength(2);
    // The same full key twice still dedupes to the ticket it created.
    const retry = createTicket(
      callback.state,
      ticketInput({ dedupeKey: "call-123|callback", ticketId: "T-0003", category: "callback" }),
    );
    expect(retry.result).toEqual({
      ticketId: "T-0002",
      created: false,
      window: "tomorrow 08:00-12:00",
    });
    expect(retry.state.tickets).toHaveLength(2);
  });

  it("truncates a summary longer than 300 characters", () => {
    const long = "x".repeat(350);
    const { result, state } = createTicket(initialState(), ticketInput({ summary: long }));
    expect(result.created).toBe(true);
    expect(state.tickets[0].summary).toHaveLength(300);
  });

  it("keeps a summary of exactly 300 characters", () => {
    const exact = "y".repeat(300);
    const { state } = createTicket(initialState(), ticketInput({ summary: exact }));
    expect(state.tickets[0].summary).toBe(exact);
  });

  it("keeps a short summary untouched", () => {
    const { state } = createTicket(initialState(), ticketInput({ summary: "short" }));
    expect(state.tickets[0].summary).toBe("short");
  });
});

// ---------- broken inputs fail closed ----------

describe("broken inputs throw RangeError", () => {
  const correct = { postcode: "8630", accountNumber: "DV-100001" };

  it.each([NaN, Infinity, -Infinity])(
    "recordCall throws for nowMs = %s",
    (bad) => {
      expect(() =>
        recordCall(initialState(), { callId: "c", nowMs: bad as unknown as number }),
      ).toThrow(RangeError);
    },
  );

  it.each([NaN, Infinity, -Infinity])(
    "verify throws for nowMs = %s",
    (bad) => {
      expect(() =>
        verify(initialState(), {
          mode: "full",
          submitted: correct,
          expected: correct,
          nowMs: bad as unknown as number,
        }),
      ).toThrow(RangeError);
    },
  );

  it.each([NaN, Infinity, -Infinity])(
    "verify throws for lockMs = %s",
    (bad) => {
      expect(() =>
        verify(initialState(), {
          mode: "full",
          submitted: correct,
          expected: correct,
          nowMs: 1000,
          lockMs: bad as unknown as number,
        }),
      ).toThrow(RangeError);
    },
  );

  it.each([NaN, Infinity, -Infinity, 0, -1, 2.5])(
    "verify throws for maxFailures = %s",
    (bad) => {
      expect(() =>
        verify(initialState(), {
          mode: "full",
          submitted: correct,
          expected: correct,
          nowMs: 1000,
          maxFailures: bad as unknown as number,
        }),
      ).toThrow(RangeError);
    },
  );

  it.each([NaN, Infinity, -Infinity])(
    "clearExpiredLock throws for nowMs = %s",
    (bad) => {
      expect(() => clearExpiredLock(initialState(), bad as unknown as number)).toThrow(RangeError);
    },
  );

  it.each([NaN, Infinity, -Infinity])(
    "createTicket throws for nowMs = %s",
    (bad) => {
      expect(() =>
        createTicket(initialState(), {
          dedupeKey: "call-123",
          ticketId: "T-0001",
          category: "repair_visit",
          summary: "s",
          nowMs: bad as unknown as number,
          window: "tomorrow",
        }),
      ).toThrow(RangeError);
    },
  );
});

// ---------- actor adapter ----------

describe("CustomerAccount actor adapter", () => {
  // A helper that seeds fresh storage with an initial state and returns an
  // actor wired to that storage, plus the storage itself for assertions.
  function makeActor() {
    const storage = createActorStorageFake();
    return { storage, actor: new CustomerAccount({ storage } as never, {} as never) };
  }

  async function seed(state: CustomerAccountState) {
    const storage = createActorStorageFake();
    await storage.put("state", state);
    return storage;
  }

  it("exposes the whole state under the storage key 'state'", async () => {
    const storage = await seed(initialState());
    const actor = new CustomerAccount({ storage } as never, {} as never);
    const snap = await actor.snapshot();
    expect(snap).toEqual(initialState());
  });

  it("recordCall persists the updated state and returns the result", async () => {
    const storage = await seed(initialState());
    const actor = new CustomerAccount({ storage } as never, {} as never);
    const result = await actor.recordCall({ callId: "call-1", nowMs: 1000 });
    expect(result).toEqual({ callCount24h: 1, repeatCaller: false, lockedUntil: null });
    const stored = await storage.get<CustomerAccountState>("state");
    expect(stored?.calls).toEqual([{ id: "call-1", at: 1000 }]);
  });

  it("verify stores the state and does not touch the alarm on success", async () => {
    const storage = await seed(initialState());
    const actor = new CustomerAccount({ storage } as never, {} as never);
    const result = await actor.verify({
      mode: "full",
      submitted: { postcode: "8630", accountNumber: "DV-100001" },
      expected: { postcode: "8630", accountNumber: "DV-100001" },
      nowMs: 1000,
    });
    expect(result.outcome).toBe("ok");
    expect(await storage.getAlarm()).toBeNull();
  });

  it("verify sets the alarm to lockedUntil when it locks", async () => {
    const storage = await seed(initialState());
    const actor = new CustomerAccount({ storage } as never, {} as never);
    for (let i = 1; i <= 3; i++) {
      await actor.verify({
        mode: "full",
        submitted: { postcode: "9999", accountNumber: "DV-100001" },
        expected: { postcode: "8630", accountNumber: "DV-100001" },
        nowMs: 1000 + i,
      });
    }
    const alarm = await storage.getAlarm();
    expect(alarm).toBe(1000 + 3 + DEFAULT_LOCK_MS);
  });

  it("alarm clears an expired lock and saves", async () => {
    const locked: CustomerAccountState = {
      ...initialState(),
      verify: { failures: 0, lockedUntil: 0 },
    };
    const storage = await seed(locked);
    const actor = new CustomerAccount({ storage } as never, {} as never);
    await actor.alarm({ retryCount: 0, isRetry: false });
    const stored = await storage.get<CustomerAccountState>("state");
    expect(stored?.verify.lockedUntil).toBeNull();
  });

  it("alarm is safe to run twice and idempotent", async () => {
    const locked: CustomerAccountState = {
      ...initialState(),
      verify: { failures: 1, lockedUntil: 0 },
    };
    const storage = await seed(locked);
    const actor = new CustomerAccount({ storage } as never, {} as never);
    await actor.alarm({ retryCount: 0, isRetry: false });
    await actor.alarm({ retryCount: 1, isRetry: true });
    const stored = await storage.get<CustomerAccountState>("state");
    expect(stored?.verify.lockedUntil).toBeNull();
    expect(stored?.verify.failures).toBe(1);
  });

  it("alarm does not clear a lock that has not expired", async () => {
    const locked: CustomerAccountState = {
      ...initialState(),
      verify: { failures: 0, lockedUntil: Number.MAX_SAFE_INTEGER },
    };
    const storage = await seed(locked);
    const actor = new CustomerAccount({ storage } as never, {} as never);
    await actor.alarm({ retryCount: 0, isRetry: false });
    const stored = await storage.get<CustomerAccountState>("state");
    expect(stored?.verify.lockedUntil).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("createTicket generates a T- ticket id and a window", async () => {
    const storage = await seed(initialState());
    const actor = new CustomerAccount({ storage } as never, {} as never);
    const result = await actor.createTicket({
      dedupeKey: "call-123",
      category: "repair_visit",
      summary: "Fiber down",
      nowMs: 1000,
    });
    expect(result.created).toBe(true);
    expect(result.ticketId).toMatch(/^T-\d{4}$/);
    expect(result.window).toBeTruthy();
    const stored = await storage.get<CustomerAccountState>("state");
    expect(stored?.tickets).toHaveLength(1);
    expect(stored?.tickets[0].id).toBe(result.ticketId);
    expect(stored?.tickets[0].dedupeKey).toBe("call-123");
  });

  it("snapshot returns a copy of the persisted state", async () => {
    const seeded = initialState();
    seeded.calls.push({ id: "call-1", at: 1000 });
    const storage = await seed(seeded);
    const actor = new CustomerAccount({ storage } as never, {} as never);
    const snap = await actor.snapshot();
    expect(snap.calls).toEqual([{ id: "call-1", at: 1000 }]);
    // Mutating the snapshot does not affect the stored state.
    snap.calls.push({ id: "mutated", at: 9999 });
    const stored = await storage.get<CustomerAccountState>("state");
    expect(stored?.calls).toEqual([{ id: "call-1", at: 1000 }]);
  });
});