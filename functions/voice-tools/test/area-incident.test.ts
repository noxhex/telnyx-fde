import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { KvNamespace } from "@telnyx/edge-runtime";

import {
  AreaIncident,
  formatEtaBrussels,
  KV_PUBLISH_TIMEOUT_MS,
} from "../src/actors/area-incident.js";
import type { AreaReportInput } from "../src/actors/area-incident.js";
import {
  currentStatus,
  initialState,
  markPublished,
  pruneReports,
  report,
  resolve,
} from "../src/domain/area-incident.js";
import type {
  AreaIncidentState,
  AreaStatus,
  ReportInput,
  Symptom,
} from "../src/domain/area-incident.js";
import type { ActorStorageFake } from "../../../packages/shared/test/fakes/actor-storage.js";
import { createActorStorageFake } from "../../../packages/shared/test/fakes/actor-storage.js";
import { createClockFake } from "../../../packages/shared/test/fakes/clock.js";
import { createKvFake } from "../../../packages/shared/test/fakes/kv.js";

// A fixed Monday in winter, so UTC and Europe/Brussels arithmetic is honest.
const T0 = Date.UTC(2026, 0, 15, 12, 0, 0); // 2026-01-15T12:00:00Z
const HOUR_MS = 60 * 60 * 1000;
const WINDOW_MS = 30 * 60 * 1000;
const ETA_MS = 2 * HOUR_MS;
const THRESHOLD = 3;

/** Deterministic ETA formatting for domain tests: the string is the input. */
const formatEta = (etaAt: number): string => `eta@${String(etaAt)}`;

function reportInput(over: Partial<ReportInput> = {}): ReportInput {
  return {
    accountId: "DV-100001",
    symptom: "no_connection",
    nowMs: T0,
    threshold: THRESHOLD,
    windowMs: WINDOW_MS,
    etaMs: ETA_MS,
    formatEta,
    ...over,
  };
}

/** Feed `accountIds` in order, starting from a fresh area. */
function feed(
  accountIds: string[],
  over: Partial<ReportInput> = {},
): { state: AreaIncidentState; declaredAt: number | null } {
  let s = initialState("8630");
  let declaredAt: number | null = null;
  accountIds.forEach((accountId, index) => {
    const { state, result } = report(s, reportInput({ accountId, nowMs: T0 + index, ...over }));
    s = state;
    if (result.incidentDeclared) {
      declaredAt = index;
    }
  });
  return { state: s, declaredAt };
}

// ---------- initialState ----------

describe("initialState", () => {
  it("starts ok with no reports, no incident, version 0 and an empty outbox", () => {
    expect(initialState("8630")).toEqual({
      v: 1,
      areaCode: "8630",
      status: "ok",
      reports: {},
      incident: null,
      version: 0,
      outbox: null,
    });
  });
});

// ---------- report: counting and dedupe ----------

describe("report counting and dedupe", () => {
  it("counts a first report and stores it under the account", () => {
    const { state, result } = report(initialState("8630"), reportInput());
    expect(result).toEqual({
      reportsInWindow: 1,
      threshold: THRESHOLD,
      counted: true,
      incidentDeclared: false,
      incidentId: null,
      eta: null,
    });
    expect(state.reports).toEqual({ "DV-100001": { at: T0, symptom: "no_connection" } });
    expect(state.status).toBe("ok");
    expect(state.version).toBe(0);
    expect(state.outbox).toBeNull();
  });

  it("a duplicate reporter is not counted but refreshes timestamp and symptom", () => {
    let s = initialState("8630");
    s = report(s, reportInput({ accountId: "DV-100001", nowMs: T0, symptom: "slow" })).state;
    const { state, result } = report(
      s,
      reportInput({ accountId: "DV-100001", nowMs: T0 + 5000, symptom: "intermittent" }),
    );
    expect(result.reportsInWindow).toBe(1);
    expect(result.counted).toBe(false);
    expect(result.incidentDeclared).toBe(false);
    expect(state.reports["DV-100001"]).toEqual({ at: T0 + 5000, symptom: "intermittent" });
  });

  it("a duplicate cannot push the count to the threshold", () => {
    // Threshold 2: the same account reporting twice still counts once.
    const { state, declaredAt } = feed(["DV-100001", "DV-100001"], { threshold: 2 });
    expect(declaredAt).toBeNull();
    expect(state.status).toBe("ok");
    expect(Object.keys(state.reports)).toHaveLength(1);
  });

  it("keeps reports from different accounts separate", () => {
    const { state } = feed(["DV-100001", "DV-100002"]);
    expect(Object.keys(state.reports).sort()).toEqual(["DV-100001", "DV-100002"]);
  });
});

// ---------- report: the window ----------

describe("report window", () => {
  it("drops a report exactly windowMs old", () => {
    let s = initialState("8630");
    s = report(s, reportInput({ accountId: "DV-100001", nowMs: T0 })).state;
    const { state, result } = report(
      s,
      reportInput({ accountId: "DV-100002", nowMs: T0 + WINDOW_MS }),
    );
    expect(result.reportsInWindow).toBe(1);
    expect(Object.keys(state.reports)).toEqual(["DV-100002"]);
  });

  it("keeps a report one millisecond short of windowMs", () => {
    let s = initialState("8630");
    s = report(s, reportInput({ accountId: "DV-100001", nowMs: T0 })).state;
    const { result } = report(s, reportInput({ accountId: "DV-100002", nowMs: T0 + WINDOW_MS - 1 }));
    expect(result.reportsInWindow).toBe(2);
  });

  it("an old report leaving the window cannot declare the incident", () => {
    let s = initialState("8630");
    s = report(s, reportInput({ accountId: "DV-100001", nowMs: T0, threshold: 3 })).state;
    s = report(s, reportInput({ accountId: "DV-100002", nowMs: T0, threshold: 3 })).state;
    // Both earlier reports have left the window; this third one stands alone.
    const { state, result } = report(
      s,
      reportInput({ accountId: "DV-100003", nowMs: T0 + WINDOW_MS, threshold: 3 }),
    );
    expect(result.reportsInWindow).toBe(1);
    expect(result.incidentDeclared).toBe(false);
    expect(state.status).toBe("ok");
  });

  it("a refreshed duplicate keeps the account inside the window", () => {
    let s = initialState("8630");
    s = report(s, reportInput({ accountId: "DV-100001", nowMs: T0, threshold: 2 })).state;
    // Refresh DV-100001 near the end of the window...
    s = report(s, reportInput({ accountId: "DV-100001", nowMs: T0 + WINDOW_MS - 1, threshold: 2 }))
      .state;
    // ...so it is still alive when DV-100002 reports one window later.
    const { result } = report(
      s,
      reportInput({ accountId: "DV-100002", nowMs: T0 + WINDOW_MS + 1, threshold: 2 }),
    );
    expect(result.reportsInWindow).toBe(2);
    expect(result.incidentDeclared).toBe(true);
  });
});

// ---------- report: declaring the incident ----------

describe("report declaring", () => {
  it("only the report reaching exactly N distinct accounts declares", () => {
    let s = initialState("8630");
    const seen: boolean[] = [];
    for (const [index, accountId] of ["DV-100001", "DV-100002", "DV-100003"].entries()) {
      const { state, result } = report(s, reportInput({ accountId, nowMs: T0 + index }));
      s = state;
      seen.push(result.incidentDeclared);
    }
    expect(seen).toEqual([false, false, true]);
    expect(s.status).toBe("outage");
  });

  it("declares with the INC-<area>-<UTC stamp> id, etaAt = nowMs + etaMs, version 1", () => {
    let s = initialState("8630");
    for (const accountId of ["DV-100001", "DV-100002"]) {
      s = report(s, reportInput({ accountId })).state;
    }
    const { state, result } = report(s, reportInput({ accountId: "DV-100003" }));
    const id = "INC-8630-202601151200";
    expect(result).toEqual({
      reportsInWindow: 3,
      threshold: THRESHOLD,
      counted: true,
      incidentDeclared: true,
      incidentId: id,
      eta: formatEta(T0 + ETA_MS),
    });
    expect(state.incident).toEqual({
      id,
      declaredAt: T0,
      etaAt: T0 + ETA_MS,
      reporters: 3,
    });
    expect(state.version).toBe(1);
    expect(state.outbox).toEqual({
      state: "outage",
      incidentId: id,
      eta: formatEta(T0 + ETA_MS),
      version: 1,
      updatedAt: T0,
    });
  });

  it("declares on a duplicate-refresh too, when another account tips the count", () => {
    // DV-100001 reports, then again (not counted), then DV-100002 declares
    // at threshold 2 — the declaring report is counted, the duplicate was not.
    let s = initialState("8630");
    s = report(s, reportInput({ accountId: "DV-100001", threshold: 2 })).state;
    const dup = report(s, reportInput({ accountId: "DV-100001", threshold: 2, nowMs: T0 + 1 }));
    expect(dup.result.counted).toBe(false);
    expect(dup.result.incidentDeclared).toBe(false);
    const third = report(
      dup.state,
      reportInput({ accountId: "DV-100002", threshold: 2, nowMs: T0 + 2 }),
    );
    expect(third.result.counted).toBe(true);
    expect(third.result.incidentDeclared).toBe(true);
  });

  it("never declares twice during an outage, but keeps storing reports", () => {
    let s = initialState("8630");
    for (const accountId of ["DV-100001", "DV-100002", "DV-100003"]) {
      s = report(s, reportInput({ accountId })).state;
    }
    s = markPublished(s, 1); // the first outbox has been published
    const { state, result } = report(s, reportInput({ accountId: "DV-100004", nowMs: T0 + 10 }));
    expect(result.counted).toBe(true);
    expect(result.incidentDeclared).toBe(false);
    expect(result.incidentId).toBe("INC-8630-202601151200");
    expect(result.eta).toBe(formatEta(T0 + ETA_MS));
    expect(result.reportsInWindow).toBe(4);
    expect(state.version).toBe(1);
    expect(state.outbox).toBeNull();
    expect(state.incident?.reporters).toBe(3); // the count at declaration time
    expect(Object.keys(state.reports)).toHaveLength(4);
  });

  it("a duplicate report during an outage still gets the incident id and eta", () => {
    let s = initialState("8630");
    for (const accountId of ["DV-100001", "DV-100002", "DV-100003"]) {
      s = report(s, reportInput({ accountId })).state;
    }
    const { result } = report(s, reportInput({ accountId: "DV-100001", nowMs: T0 + 10 }));
    expect(result.counted).toBe(false);
    expect(result.incidentDeclared).toBe(false);
    expect(result.incidentId).toBe("INC-8630-202601151200");
    expect(result.eta).toBe(formatEta(T0 + ETA_MS));
  });
});

// ---------- resolve ----------

describe("resolve", () => {
  function outageState(): AreaIncidentState {
    return feed(["DV-100001", "DV-100002", "DV-100003"]).state;
  }

  it("resolves: back to ok, reports and incident cleared, version and outbox set", () => {
    const { state, result } = resolve(outageState(), { nowMs: T0 + HOUR_MS });
    expect(result).toEqual({ resolved: true, incidentId: "INC-8630-202601151200" });
    expect(state.status).toBe("ok");
    expect(state.reports).toEqual({});
    expect(state.incident).toBeNull();
    expect(state.version).toBe(2);
    expect(state.outbox).toEqual({
      state: "ok",
      incidentId: null,
      eta: null,
      version: 2,
      updatedAt: T0 + HOUR_MS,
    });
  });

  it("is a no-op on an area that is already ok", () => {
    const s = initialState("8630");
    const { state, result } = resolve(s, { nowMs: T0 });
    expect(result).toEqual({ resolved: false, incidentId: null });
    expect(state).toBe(s); // unchanged, not even a copy
  });

  it("increments the version across declare, resolve, re-declare", () => {
    let s = outageState();
    expect(s.version).toBe(1);
    s = resolve(s, { nowMs: T0 + HOUR_MS }).state;
    expect(s.version).toBe(2);
    for (const accountId of ["DV-100001", "DV-100002", "DV-100003"]) {
      s = report(s, reportInput({ accountId, nowMs: T0 + 2 * HOUR_MS })).state;
    }
    expect(s.version).toBe(3);
    expect(s.outbox?.version).toBe(3);
  });
});

// ---------- markPublished ----------

describe("markPublished", () => {
  it("clears the outbox whose version was published", () => {
    const s = feed(["DV-100001", "DV-100002", "DV-100003"]).state;
    const cleared = markPublished(s, 1);
    expect(cleared.outbox).toBeNull();
    expect(cleared.version).toBe(1);
    expect(cleared.status).toBe("outage");
  });

  it("ignores a stale publish: an older version cannot clear a newer outbox", () => {
    const s = feed(["DV-100001", "DV-100002", "DV-100003"]).state; // outbox v1
    expect(markPublished(s, 0)).toBe(s);
    expect(markPublished(s, 2)).toBe(s); // newer than the outbox: also no
    expect(s.outbox).not.toBeNull();
  });

  it("leaves an empty outbox alone", () => {
    const s = initialState("8630");
    expect(markPublished(s, 0)).toBe(s);
  });
});

// ---------- currentStatus ----------

describe("currentStatus", () => {
  it("reports ok for a fresh area", () => {
    expect(currentStatus(initialState("8630"), formatEta)).toEqual({
      state: "ok",
      incidentId: null,
      eta: null,
      version: 0,
      updatedAt: 0,
    });
  });

  it("returns the pending outbox verbatim while it waits to be published", () => {
    const s = feed(["DV-100001", "DV-100002", "DV-100003"]).state;
    expect(currentStatus(s, formatEta)).toBe(s.outbox);
  });

  it("derives the outage status from the incident once published", () => {
    // `feed` reports at T0, T0+1, T0+2, so the declaration lands at T0+2.
    let s = feed(["DV-100001", "DV-100002", "DV-100003"]).state;
    s = markPublished(s, 1);
    expect(currentStatus(s, formatEta)).toEqual({
      state: "outage",
      incidentId: "INC-8630-202601151200",
      eta: formatEta(T0 + 2 + ETA_MS),
      version: 1,
      updatedAt: T0 + 2,
    });
  });

  it("keeps the resolved status from the outbox until it is published", () => {
    let s = feed(["DV-100001", "DV-100002", "DV-100003"]).state;
    s = resolve(s, { nowMs: T0 + HOUR_MS }).state;
    expect(currentStatus(s, formatEta).updatedAt).toBe(T0 + HOUR_MS);
  });
});

// ---------- pruneReports ----------

describe("pruneReports", () => {
  it("drops reports older than the window and keeps fresh ones", () => {
    let s = initialState("8630");
    s = report(s, reportInput({ accountId: "DV-100001", nowMs: T0 })).state;
    s = report(s, reportInput({ accountId: "DV-100002", nowMs: T0 + WINDOW_MS - 1 })).state;
    const pruned = pruneReports(s, { nowMs: T0 + WINDOW_MS, windowMs: WINDOW_MS });
    expect(Object.keys(pruned.reports)).toEqual(["DV-100002"]);
  });

  it("returns the same object when nothing is pruned", () => {
    const s = feed(["DV-100001", "DV-100002"]).state;
    expect(pruneReports(s, { nowMs: T0 + 1, windowMs: WINDOW_MS })).toBe(s);
  });

  it.each([NaN, Infinity, -Infinity])("throws for nowMs = %s", (bad) => {
    expect(() =>
      pruneReports(initialState("8630"), { nowMs: bad, windowMs: WINDOW_MS }),
    ).toThrow(RangeError);
  });

  it.each([NaN, Infinity, -Infinity])("throws for windowMs = %s", (bad) => {
    expect(() => pruneReports(initialState("8630"), { nowMs: T0, windowMs: bad })).toThrow(
      RangeError,
    );
  });
});

// ---------- broken inputs fail closed ----------

describe("broken inputs throw RangeError", () => {
  it.each([NaN, Infinity, -Infinity])("report throws for nowMs = %s", (bad) => {
    expect(() => report(initialState("8630"), reportInput({ nowMs: bad }))).toThrow(RangeError);
  });

  it.each([NaN, Infinity, -Infinity])("report throws for windowMs = %s", (bad) => {
    expect(() => report(initialState("8630"), reportInput({ windowMs: bad }))).toThrow(RangeError);
  });

  it.each([NaN, Infinity, -Infinity])("report throws for etaMs = %s", (bad) => {
    expect(() => report(initialState("8630"), reportInput({ etaMs: bad }))).toThrow(RangeError);
  });

  it.each([NaN, Infinity, -Infinity, 0, -1, 2.5])("report throws for threshold = %s", (bad) => {
    expect(() =>
      report(initialState("8630"), reportInput({ threshold: bad as number })),
    ).toThrow(RangeError);
  });

  it("a broken input changes nothing: no report, no declaration", () => {
    const before = initialState("8630");
    expect(() => report(before, reportInput({ nowMs: NaN }))).toThrow(RangeError);
    expect(before).toEqual(initialState("8630"));
  });

  it.each([NaN, Infinity, -Infinity])("resolve throws for nowMs = %s", (bad) => {
    expect(() => resolve(initialState("8630"), { nowMs: bad })).toThrow(RangeError);
  });
});

// ---------- soak: 50 reports, 10 accounts, exactly one declaration ----------

describe("a surge of reports declares exactly once", () => {
  /** mulberry32: a tiny deterministic PRNG so the run is reproducible. */
  function seededRandom(seed: number): () => number {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("50 reports from 10 accounts in seeded random order", () => {
    const random = seededRandom(0xdecaf);
    const accounts = Array.from({ length: 10 }, (_, i) => `DV-1000${String(i).padStart(2, "0")}`);
    const symptoms: Symptom[] = ["no_connection", "slow", "intermittent", "other"];
    const threshold = 5;

    let s = initialState("8630");
    const inWindow = new Set<string>();
    let declarations = 0;
    let incidentId: string | null = null;

    for (let n = 0; n < 50; n++) {
      const accountId = accounts[Math.floor(random() * accounts.length)];
      const symptom = symptoms[Math.floor(random() * symptoms.length)];
      const { state, result } = report(
        s,
        reportInput({
          accountId,
          symptom,
          nowMs: T0 + n * 1000,
          threshold,
          windowMs: 10 * HOUR_MS, // everything stays in the window
        }),
      );
      s = state;
      const wasRepeat = inWindow.has(accountId);
      inWindow.add(accountId);
      expect(result.reportsInWindow).toBe(inWindow.size);
      expect(result.counted).toBe(!wasRepeat);
      if (result.incidentDeclared) {
        declarations += 1;
        incidentId = result.incidentId;
        // The declaration lands exactly when the fifth distinct account arrives.
        expect(inWindow.size).toBe(threshold);
      } else if (incidentId !== null) {
        expect(result.incidentId).toBe(incidentId); // never a second id
      }
    }

    expect(declarations).toBe(1);
    expect(s.status).toBe("outage");
    expect(s.version).toBe(1);
    expect(Object.keys(s.reports)).toHaveLength(10);
    expect(s.incident?.reporters).toBe(threshold);
  });
});

// ---------- formatEtaBrussels ----------

describe("formatEtaBrussels", () => {
  // T0 is 2026-01-15T12:00:00Z; Europe/Brussels is at UTC+1 in January.
  it("formats a same-day ETA as 'by HH:mm today'", () => {
    expect(formatEtaBrussels(T0 + 2 * HOUR_MS, T0)).toBe("by 15:00 today");
  });

  it("formats a late-evening ETA on the same Brussels day", () => {
    const etaAt = Date.UTC(2026, 0, 15, 22, 30); // 23:30 in Brussels
    expect(formatEtaBrussels(etaAt, T0)).toBe("by 23:30 today");
  });

  it("formats a next-day ETA as 'by HH:mm tomorrow'", () => {
    const etaAt = Date.UTC(2026, 0, 16, 9, 15); // 10:15 in Brussels
    expect(formatEtaBrussels(etaAt, T0)).toBe("by 10:15 tomorrow");
  });

  it("still counts as today when UTC has rolled over but Brussels has not", () => {
    // 2026-01-15T23:30Z is 00:30 on the 16th in Brussels: that is "tomorrow".
    const now = Date.UTC(2026, 0, 15, 23, 30);
    const etaAt = Date.UTC(2026, 0, 16, 22, 0); // 23:00 on the 16th in Brussels
    expect(formatEtaBrussels(etaAt, now)).toBe("by 23:00 today");
  });

  it("honours the summer offset (CEST, UTC+2)", () => {
    const now = Date.UTC(2026, 6, 1, 10, 0); // 12:00 in Brussels
    expect(formatEtaBrussels(now + 3 * HOUR_MS, now)).toBe("by 15:00 today");
  });

  it("dates an ETA beyond tomorrow explicitly", () => {
    const etaAt = Date.UTC(2026, 0, 18, 16, 45); // 17:45 on the 18th in Brussels
    expect(formatEtaBrussels(etaAt, T0)).toBe("by 17:45 on 2026-01-18");
  });
});

// ---------- actor adapter ----------

/** A KV stub whose put does whatever `impl` currently says. */
function switchableKv(): { kv: KvNamespace; fail(error: Error): void; hang(): void; ok(): void } {
  let impl: () => Promise<void> = async () => {};
  return {
    kv: { put: () => impl() } as unknown as KvNamespace,
    fail(error: Error) {
      impl = () => Promise.reject(error);
    },
    hang() {
      impl = () => new Promise<never>(() => {});
    },
    ok() {
      impl = async () => {};
    },
  };
}

describe("AreaIncident actor adapter", () => {
  const INCIDENT_ID = "INC-8630-202601151200";

  function makeActor(kv: KvNamespace): { actor: AreaIncident; storage: ActorStorageFake } {
    const storage = createActorStorageFake();
    const actor = new AreaIncident({ id: "8630", storage } as never, { KV: kv } as never);
    return { actor, storage };
  }

  function actorReport(over: Partial<AreaReportInput> = {}): AreaReportInput {
    return {
      accountId: "DV-100001",
      symptom: "no_connection",
      nowMs: T0,
      threshold: 2,
      windowMs: WINDOW_MS,
      etaMs: ETA_MS,
      ...over,
    };
  }

  async function storedState(storage: ActorStorageFake): Promise<AreaIncidentState> {
    const s = await storage.get<AreaIncidentState>("state");
    expect(s).toBeDefined();
    return s as AreaIncidentState;
  }

  beforeEach(() => {
    vi.useFakeTimers({ now: T0 });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("records a report, sets areaCode from the instance name, touches no KV", async () => {
    const clock = createClockFake(T0);
    const kv = createKvFake(clock.now);
    const { actor, storage } = makeActor(kv);
    const result = await actor.report(actorReport());
    expect(result).toEqual({
      reportsInWindow: 1,
      threshold: 2,
      counted: true,
      incidentDeclared: false,
      incidentId: null,
      eta: null,
    });
    const s = await storedState(storage);
    expect(s.areaCode).toBe("8630");
    expect(s.reports["DV-100001"]).toEqual({ at: T0, symptom: "no_connection" });
    expect(kv.calls.filter((c) => c.method === "put")).toEqual([]);
    expect(await storage.getAlarm()).toBeNull();
  });

  it("publishes on declaration and confirms with markPublished", async () => {
    const clock = createClockFake(T0);
    const kv = createKvFake(clock.now);
    const { actor, storage } = makeActor(kv);
    await actor.report(actorReport({ accountId: "DV-100001" }));
    const result = await actor.report(actorReport({ accountId: "DV-100002", nowMs: T0 + 1 }));
    expect(result.incidentDeclared).toBe(true);
    expect(result.incidentId).toBe(INCIDENT_ID);
    // The KV read model holds the declared status…
    const published = await kv.get<AreaStatus>("area/8630/status", { type: "json" });
    expect(published).toEqual({
      state: "outage",
      incidentId: INCIDENT_ID,
      eta: "by 15:00 today", // etaAt = 14:00 UTC → 15:00 in Brussels
      version: 1,
      updatedAt: T0 + 1,
    });
    // …and the durable state shows the publish was confirmed.
    const s = await storedState(storage);
    expect(s.outbox).toBeNull();
    expect(s.version).toBe(1);
    expect(s.status).toBe("outage");
  });

  it("keeps the result and the decision when the publish fails, and arms the alarm", async () => {
    const { kv, fail } = switchableKv();
    fail(new Error("kv_down"));
    const logSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { actor, storage } = makeActor(kv);
    await actor.report(actorReport({ accountId: "DV-100001" }));
    const result = await actor.report(actorReport({ accountId: "DV-100002", nowMs: T0 + 1 }));
    // The caller still gets its result: the decision was saved first.
    expect(result.incidentDeclared).toBe(true);
    const s = await storedState(storage);
    expect(s.outbox?.state).toBe("outage");
    expect(await storage.getAlarm()).toBe(T0 + 5_000);
    expect(await storage.get("meta")).toEqual({
      windowMs: WINDOW_MS,
      publishFailures: 1,
    });
    const lines = logSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(lines).toContain('"event":"publish_retry"');
    expect(lines).toContain('"area":"8630"');
    expect(lines).toContain("kv_down");
  });

  it("treats a hanging KV as a failed publish after 300 ms", async () => {
    const { kv, hang } = switchableKv();
    hang();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true); // swallow publish_retry
    const { actor, storage } = makeActor(kv);
    await actor.report(actorReport({ accountId: "DV-100001" }));
    const pending = actor.report(actorReport({ accountId: "DV-100002", nowMs: T0 + 1 }));
    await vi.advanceTimersByTimeAsync(KV_PUBLISH_TIMEOUT_MS);
    const result = await pending;
    expect(result.incidentDeclared).toBe(true);
    expect(await storage.getAlarm()).toBe(T0 + KV_PUBLISH_TIMEOUT_MS + 5_000);
    expect((await storedState(storage)).outbox?.state).toBe("outage");
  });

  it("retries with 5 s, 15 s, then 60 s backoff until the publish lands", async () => {
    const { kv, fail, ok } = switchableKv();
    fail(new Error("kv_down"));
    vi.spyOn(process.stdout, "write").mockImplementation(() => true); // swallow publish_retry
    const { actor, storage } = makeActor(kv);
    await actor.report(actorReport({ accountId: "DV-100001" }));
    await actor.report(actorReport({ accountId: "DV-100002", nowMs: T0 + 1 }));
    expect(await storage.getAlarm()).toBe(T0 + 5_000);

    await actor.alarm({ retryCount: 0, isRetry: false });
    expect(await storage.getAlarm()).toBe(T0 + 15_000);
    expect((await storage.get<{ publishFailures: number }>("meta"))?.publishFailures).toBe(2);

    vi.setSystemTime(T0 + 15_000);
    await actor.alarm({ retryCount: 0, isRetry: false });
    expect(await storage.getAlarm()).toBe(T0 + 15_000 + 60_000);
    expect((await storage.get<{ publishFailures: number }>("meta"))?.publishFailures).toBe(3);

    vi.setSystemTime(T0 + 15_000 + 60_000);
    await actor.alarm({ retryCount: 0, isRetry: false });
    expect((await storage.get<{ publishFailures: number }>("meta"))?.publishFailures).toBe(4);
    expect(await storage.getAlarm()).toBe(T0 + 15_000 + 120_000);

    // KV recovers: the next alarm publishes and the backoff stops.
    ok();
    vi.setSystemTime(T0 + 15_000 + 120_000);
    storage.reset();
    await actor.alarm({ retryCount: 0, isRetry: false });
    expect((await storedState(storage)).outbox).toBeNull();
    expect((await storage.get<{ publishFailures: number }>("meta"))?.publishFailures).toBe(0);
    expect(storage.calls.filter((c) => c.method === "setAlarm")).toEqual([]);
  });

  it("a redelivered alarm after a successful publish changes nothing", async () => {
    const clock = createClockFake(T0);
    const kv = createKvFake(clock.now);
    const { actor, storage } = makeActor(kv);
    await actor.report(actorReport({ accountId: "DV-100001" }));
    await actor.report(actorReport({ accountId: "DV-100002", nowMs: T0 + 1 }));
    storage.reset();
    kv.reset();
    await actor.alarm({ retryCount: 1, isRetry: true });
    await actor.alarm({ retryCount: 2, isRetry: true });
    expect(kv.calls).toEqual([]); // nothing left to publish
    expect(storage.calls.filter((c) => c.method === "put")).toEqual([]);
    expect(storage.calls.filter((c) => c.method === "setAlarm")).toEqual([]);
  });

  it("the alarm prunes reports older than the last reported window", async () => {
    const clock = createClockFake(T0);
    const kv = createKvFake(clock.now);
    const { actor, storage } = makeActor(kv);
    await actor.report(actorReport({ accountId: "DV-100001", nowMs: T0 }));
    // Move past the window and run the alarm: the lone report is pruned.
    vi.setSystemTime(T0 + WINDOW_MS);
    await actor.alarm({ retryCount: 0, isRetry: false });
    expect((await storedState(storage)).reports).toEqual({});
    // Running it again is a no-op.
    storage.reset();
    await actor.alarm({ retryCount: 1, isRetry: true });
    expect(storage.calls.filter((c) => c.method === "put")).toEqual([]);
  });

  it("status returns the current area status", async () => {
    const clock = createClockFake(T0);
    const kv = createKvFake(clock.now);
    const { actor } = makeActor(kv);
    expect(await actor.status()).toEqual({
      state: "ok",
      incidentId: null,
      eta: null,
      version: 0,
      updatedAt: 0,
    });
    await actor.report(actorReport({ accountId: "DV-100001" }));
    await actor.report(actorReport({ accountId: "DV-100002", nowMs: T0 + 1 }));
    expect(await actor.status()).toEqual({
      state: "outage",
      incidentId: INCIDENT_ID,
      eta: "by 15:00 today",
      version: 1,
      updatedAt: T0 + 1,
    });
  });

  it("resolve publishes the ok status and clears the incident", async () => {
    const clock = createClockFake(T0);
    const kv = createKvFake(clock.now);
    const { actor, storage } = makeActor(kv);
    await actor.report(actorReport({ accountId: "DV-100001" }));
    await actor.report(actorReport({ accountId: "DV-100002", nowMs: T0 + 1 }));
    vi.setSystemTime(T0 + HOUR_MS);
    const result = await actor.resolve({ nowMs: T0 + HOUR_MS });
    expect(result).toEqual({ resolved: true, incidentId: INCIDENT_ID });
    const published = await kv.get<AreaStatus>("area/8630/status", { type: "json" });
    expect(published).toEqual({
      state: "ok",
      incidentId: null,
      eta: null,
      version: 2,
      updatedAt: T0 + HOUR_MS,
    });
    const s = await storedState(storage);
    expect(s.status).toBe("ok");
    expect(s.incident).toBeNull();
    expect(s.reports).toEqual({});
    expect(s.outbox).toBeNull();
  });

  it("resolve on an ok area is a no-op and writes nothing", async () => {
    const clock = createClockFake(T0);
    const kv = createKvFake(clock.now);
    const { actor, storage } = makeActor(kv);
    const result = await actor.resolve({ nowMs: T0 });
    expect(result).toEqual({ resolved: false, incidentId: null });
    expect(storage.calls.filter((c) => c.method === "put")).toEqual([]);
    expect(kv.calls).toEqual([]);
  });
});
