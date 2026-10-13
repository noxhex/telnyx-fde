import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { KvNamespace } from "@telnyx/edge-runtime";

import { AreaIncident, formatEtaBrussels } from "../src/actors/area-incident.js";
import type {
  AreaIncidentMeta,
  AreaReportInput,
} from "../src/actors/area-incident.js";
import {
  currentStatus,
  initialState,
  markPublished,
  pruneReports,
  report,
  reset,
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
  it("a report exactly windowMs old still counts", () => {
    let s = initialState("8630");
    s = report(s, reportInput({ accountId: "DV-100001", nowMs: T0 })).state;
    const { state, result } = report(
      s,
      reportInput({ accountId: "DV-100002", nowMs: T0 + WINDOW_MS, threshold: 2 }),
    );
    expect(result.reportsInWindow).toBe(2);
    expect(Object.keys(state.reports).sort()).toEqual(["DV-100001", "DV-100002"]);
    // Threshold 2 reached by the still-counting report: it declares.
    expect(result.incidentDeclared).toBe(true);
  });

  it("drops a report one millisecond past the window", () => {
    let s = initialState("8630");
    s = report(s, reportInput({ accountId: "DV-100001", nowMs: T0 })).state;
    const { state, result } = report(
      s,
      reportInput({ accountId: "DV-100002", nowMs: T0 + WINDOW_MS + 1 }),
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
      reportInput({ accountId: "DV-100003", nowMs: T0 + WINDOW_MS + 1, threshold: 3 }),
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

// ---------- reset (T15) ----------

describe("reset", () => {
  it("from outage: clears reports and incident, sets ok, raises the version and fills the outbox", () => {
    const s = feed(["DV-100001", "DV-100002", "DV-100003"]).state;
    const { state, result } = reset(s, { nowMs: T0 + HOUR_MS });
    expect(result).toEqual({ version: 2 });
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

  it("from ok with reports: clears them and still raises the version and fills the outbox", () => {
    const s = report(initialState("8630"), reportInput()).state;
    expect(s.version).toBe(0); // the declaration never happened
    const { state, result } = reset(s, { nowMs: T0 + HOUR_MS });
    expect(result).toEqual({ version: 1 });
    expect(state.status).toBe("ok");
    expect(state.reports).toEqual({});
    expect(state.version).toBe(1);
    expect(state.outbox).toEqual({
      state: "ok",
      incidentId: null,
      eta: null,
      version: 1,
      updatedAt: T0 + HOUR_MS,
    });
  });

  it("unlike resolve, it is not a no-op on a fresh area", () => {
    const s = initialState("8630");
    const { state } = reset(s, { nowMs: T0 });
    expect(state).not.toBe(s);
    expect(state.version).toBe(1);
    expect(state.outbox?.state).toBe("ok");
  });

  it.each([NaN, Infinity, -Infinity])("throws for nowMs = %s", (bad) => {
    expect(() => reset(initialState("8630"), { nowMs: bad })).toThrow(RangeError);
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
  it("drops a report 1 ms past the window and keeps one exactly at it", () => {
    let s = initialState("8630");
    s = report(s, reportInput({ accountId: "DV-100001", nowMs: T0 })).state;
    s = report(s, reportInput({ accountId: "DV-100002", nowMs: T0 + 1 })).state;
    const pruned = pruneReports(s, { nowMs: T0 + WINDOW_MS + 1, windowMs: WINDOW_MS });
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

  async function storedMeta(storage: ActorStorageFake): Promise<AreaIncidentMeta> {
    const meta = await storage.get<AreaIncidentMeta>("meta");
    expect(meta).toBeDefined();
    return meta as AreaIncidentMeta;
  }

  let logLines: Record<string, unknown>[];

  beforeEach(() => {
    vi.useFakeTimers({ now: T0 });
    logLines = [];
    // The adapter's logger writes to stdout; capture every line as JSON.
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      logLines.push(JSON.parse(String(chunk)) as Record<string, unknown>);
      return true;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** The captured log lines for one event. */
  function logged(event: string): Record<string, unknown>[] {
    return logLines.filter((line) => line.event === event);
  }

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

  it("a declaring report writes nothing to KV and sets the alarm to now", async () => {
    const kv = createKvFake(createClockFake(T0).now);
    const { actor, storage } = makeActor(kv);
    await actor.report(actorReport({ accountId: "DV-100001", traceId: "t1" }));
    const result = await actor.report(
      actorReport({ accountId: "DV-100002", nowMs: T0 + 1, traceId: "t1" }),
    );
    expect(result.incidentDeclared).toBe(true);
    // No KV call at all: the decision is durable, the alarm publishes it.
    expect(kv.calls).toEqual([]);
    expect(await storage.getAlarm()).toBe(T0); // now
    const s = await storedState(storage);
    expect(s.outbox?.state).toBe("outage");
    expect(await storedMeta(storage)).toEqual({
      windowMs: WINDOW_MS,
      publishFailures: 0,
      changeTraceId: "t1",
      confirmDueAtMs: null,
      lastStatus: s.outbox,
    });
  });

  it("a resolve writes nothing to KV and sets the alarm to now", async () => {
    const kv = createKvFake(createClockFake(T0).now);
    const { actor, storage } = makeActor(kv);
    await actor.report(actorReport({ accountId: "DV-100001" }));
    await actor.report(actorReport({ accountId: "DV-100002", nowMs: T0 + 1 }));
    await actor.alarm({ retryCount: 0, isRetry: false }); // v1 published
    kv.reset();
    vi.setSystemTime(T0 + HOUR_MS);
    const result = await actor.resolve({ nowMs: T0 + HOUR_MS });
    expect(result.resolved).toBe(true);
    expect(kv.calls).toEqual([]);
    expect(await storage.getAlarm()).toBe(T0 + HOUR_MS); // now
    expect((await storedState(storage)).outbox).toMatchObject({ state: "ok", version: 2 });
  });

  it("the alarm publishes the outbox and confirms with markPublished", async () => {
    const clock = createClockFake(T0);
    const kv = createKvFake(clock.now);
    const { actor, storage } = makeActor(kv);
    await actor.report(actorReport({ accountId: "DV-100001" }));
    const result = await actor.report(actorReport({ accountId: "DV-100002", nowMs: T0 + 1 }));
    expect(result.incidentDeclared).toBe(true);
    expect(result.incidentId).toBe(INCIDENT_ID);
    await actor.alarm({ retryCount: 0, isRetry: false });
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

  it("the alarm's publish times out at exactly 5,000 ms and marks the confirming write", async () => {
    const { kv, hang } = switchableKv();
    hang();
    const { actor, storage } = makeActor(kv);
    await actor.report(actorReport({ accountId: "DV-100001", traceId: "t1" }));
    await actor.report(actorReport({ accountId: "DV-100002", nowMs: T0 + 1, traceId: "t1" }));
    const run = actor.alarm({ retryCount: 0, isRetry: false });
    await vi.advanceTimersByTimeAsync(5_000); // the literal KV write budget
    await run;
    expect(logged("publish_retry")).toHaveLength(1);
    expect(logged("publish_retry")[0]).toMatchObject({
      area: "8630",
      version: 1,
      trace_id: "t1",
      error: "kv_publish_timeout",
      latency_ms: { total: 5_000, kv: 5_000 },
    });
    // The confirming write is marked 30 s out, the ladder is armed at +5 s.
    expect((await storedMeta(storage)).confirmDueAtMs).toBe(T0 + 35_000);
    expect((await storedMeta(storage)).publishFailures).toBe(1);
    expect(await storage.getAlarm()).toBe(T0 + 10_000);
    expect((await storedState(storage)).outbox?.state).toBe("outage");
  });

  it("a held write that settles 1 ms before the 5,000 ms timeout succeeds", async () => {
    let releaseHeld!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      releaseHeld = resolveGate;
    });
    const kv = { put: () => gate } as unknown as KvNamespace;
    const { actor, storage } = makeActor(kv);
    await actor.report(actorReport({ accountId: "DV-100001" }));
    await actor.report(actorReport({ accountId: "DV-100002", nowMs: T0 + 1 }));
    storage.reset();
    const run = actor.alarm({ retryCount: 0, isRetry: false });
    await vi.advanceTimersByTimeAsync(4_999);
    releaseHeld();
    await run;
    expect((await storedState(storage)).outbox).toBeNull();
    expect(logged("publish_retry")).toEqual([]);
    expect(logged("publish")).toHaveLength(1);
    expect(logged("publish")[0].latency_ms).toEqual({ total: 4_999, kv: 4_999 });
    expect((await storedMeta(storage)).confirmDueAtMs).toBeNull();
    // Nothing is still due: the alarm is not re-armed.
    expect(storage.calls.filter((c) => c.method === "setAlarm")).toEqual([]);
  });

  it("retries with 5 s, 15 s, then 60 s backoff until the publish lands", async () => {
    const { kv, fail, ok } = switchableKv();
    fail(new Error("kv_down"));
    const { actor, storage } = makeActor(kv);
    await actor.report(actorReport({ accountId: "DV-100001" }));
    await actor.report(actorReport({ accountId: "DV-100002", nowMs: T0 + 1 }));
    // The change armed the alarm to fire straight away.
    expect(await storage.getAlarm()).toBe(T0);

    await actor.alarm({ retryCount: 0, isRetry: false });
    expect(await storage.getAlarm()).toBe(T0 + 5_000);
    expect((await storedMeta(storage)).publishFailures).toBe(1);

    vi.setSystemTime(T0 + 5_000);
    await actor.alarm({ retryCount: 0, isRetry: false });
    expect(await storage.getAlarm()).toBe(T0 + 20_000);
    expect((await storedMeta(storage)).publishFailures).toBe(2);

    vi.setSystemTime(T0 + 20_000);
    await actor.alarm({ retryCount: 0, isRetry: false });
    expect((await storedMeta(storage)).publishFailures).toBe(3);
    expect(await storage.getAlarm()).toBe(T0 + 80_000);

    vi.setSystemTime(T0 + 80_000);
    await actor.alarm({ retryCount: 0, isRetry: false });
    expect((await storedMeta(storage)).publishFailures).toBe(4);
    expect(await storage.getAlarm()).toBe(T0 + 140_000);

    // KV recovers: the next alarm publishes and the backoff stops.
    ok();
    vi.setSystemTime(T0 + 140_000);
    storage.reset();
    await actor.alarm({ retryCount: 0, isRetry: false });
    expect((await storedState(storage)).outbox).toBeNull();
    expect((await storedMeta(storage)).publishFailures).toBe(0);
    expect(storage.calls.filter((c) => c.method === "setAlarm")).toEqual([]);
  });

  it("a redelivered alarm after a successful publish changes nothing", async () => {
    const clock = createClockFake(T0);
    const kv = createKvFake(clock.now);
    const { actor, storage } = makeActor(kv);
    await actor.report(actorReport({ accountId: "DV-100001" }));
    await actor.report(actorReport({ accountId: "DV-100002", nowMs: T0 + 1 }));
    await actor.alarm({ retryCount: 0, isRetry: false }); // publishes v1
    storage.reset();
    kv.reset();
    await actor.alarm({ retryCount: 1, isRetry: true });
    await actor.alarm({ retryCount: 2, isRetry: true });
    expect(kv.calls).toEqual([]); // nothing left to publish
    expect(storage.calls.filter((c) => c.method === "put")).toEqual([]);
    expect(storage.calls.filter((c) => c.method === "setAlarm")).toEqual([]);
  });

  it("the alarm prunes reports strictly older than the last reported window", async () => {
    const clock = createClockFake(T0);
    const kv = createKvFake(clock.now);
    const { actor, storage } = makeActor(kv);
    await actor.report(actorReport({ accountId: "DV-100001", nowMs: T0 }));
    // At exactly windowMs the report still counts; 1 ms later it is pruned.
    vi.setSystemTime(T0 + WINDOW_MS);
    await actor.alarm({ retryCount: 0, isRetry: false });
    expect(Object.keys((await storedState(storage)).reports)).toEqual(["DV-100001"]);
    vi.setSystemTime(T0 + WINDOW_MS + 1);
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

  it("resolve publishes the ok status through the alarm and clears the incident", async () => {
    const clock = createClockFake(T0);
    const kv = createKvFake(clock.now);
    const { actor, storage } = makeActor(kv);
    await actor.report(actorReport({ accountId: "DV-100001" }));
    await actor.report(actorReport({ accountId: "DV-100002", nowMs: T0 + 1 }));
    await actor.alarm({ retryCount: 0, isRetry: false }); // publishes v1
    vi.setSystemTime(T0 + HOUR_MS);
    const result = await actor.resolve({ nowMs: T0 + HOUR_MS });
    expect(result).toEqual({ resolved: true, incidentId: INCIDENT_ID });
    await actor.alarm({ retryCount: 0, isRetry: false }); // publishes v2
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

  it("reset saves, sets the alarm to now, and the alarm publishes the ok status to KV", async () => {
    const clock = createClockFake(T0);
    const kv = createKvFake(clock.now);
    const { actor, storage } = makeActor(kv);
    await actor.report(actorReport({ accountId: "DV-100001" }));
    await actor.report(actorReport({ accountId: "DV-100002", nowMs: T0 + 1 }));
    await actor.alarm({ retryCount: 0, isRetry: false }); // v1 outage published
    vi.setSystemTime(T0 + HOUR_MS);
    kv.reset();
    const result = await actor.reset({ nowMs: T0 + HOUR_MS, traceId: "t9" });
    expect(result).toEqual({ version: 2 });
    // No KV call from the method itself: the alarm publishes it.
    expect(kv.calls).toEqual([]);
    expect(await storage.getAlarm()).toBe(T0 + HOUR_MS); // now
    const meta = await storedMeta(storage);
    expect(meta.changeTraceId).toBe("t9");
    expect(meta.lastStatus).toEqual({
      state: "ok",
      incidentId: null,
      eta: null,
      version: 2,
      updatedAt: T0 + HOUR_MS,
    });
    await actor.alarm({ retryCount: 0, isRetry: false }); // v2 published
    const published = await kv.get<AreaStatus>("area/8630/status", { type: "json" });
    expect(published).toEqual({
      state: "ok",
      incidentId: null,
      eta: null,
      version: 2,
      updatedAt: T0 + HOUR_MS,
    });
    const s = await storedState(storage);
    expect(s).toMatchObject({ status: "ok", reports: {}, incident: null, outbox: null, version: 2 });
  });

  it("reset on a fresh area still publishes a fresh ok status (unlike resolve)", async () => {
    const clock = createClockFake(T0);
    const kv = createKvFake(clock.now);
    const { actor, storage } = makeActor(kv);
    const result = await actor.reset({ nowMs: T0, traceId: "t9" });
    expect(result).toEqual({ version: 1 });
    expect(await storage.getAlarm()).toBe(T0); // now
    await actor.alarm({ retryCount: 0, isRetry: false });
    const published = await kv.get<AreaStatus>("area/8630/status", { type: "json" });
    expect(published).toEqual({
      state: "ok",
      incidentId: null,
      eta: null,
      version: 1,
      updatedAt: T0,
    });
  });

  it("reset writes one actor line with the outcome, the area and the trace id", async () => {
    const kv = createKvFake(createClockFake(T0).now);
    const { actor } = makeActor(kv);
    await actor.reset({ nowMs: T0, traceId: "trace-9" });
    const line = logged("actor")[0];
    expect(line).toMatchObject({
      method: "reset",
      trace_id: "trace-9",
      area: "8630",
      outcome: "reset",
      latency_ms: { total: 0, actor: 0 },
    });
    expect("account" in line).toBe(false);
  });

  // ---------- actor call logging ----------

  it("report writes one actor line per call with the masked account and outcome", async () => {
    const kv = createKvFake(createClockFake(T0).now);
    const { actor } = makeActor(kv);
    await actor.report(actorReport({ accountId: "DV-100001", traceId: "trace-1" }));
    await actor.report(actorReport({ accountId: "DV-100001", nowMs: T0 + 1, traceId: "trace-1" }));
    await actor.report(actorReport({ accountId: "DV-100002", nowMs: T0 + 2, traceId: "trace-1" }));
    const lines = logged("actor");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({
      svc: "voice-tools",
      level: "info",
      actor: "AreaIncident",
      method: "report",
      trace_id: "trace-1",
      area: "8630",
      account: "DV-…001",
      outcome: "counted",
      latency_ms: { total: 0, actor: 0 },
    });
    expect(lines[1].outcome).toBe("duplicate");
    expect(lines[2].outcome).toBe("declared");
    // No unmasked account number anywhere in the log.
    expect(JSON.stringify(logLines)).not.toContain("DV-100001");
  });

  it("report without a trace id logs trace_id null", async () => {
    const kv = createKvFake(createClockFake(T0).now);
    const { actor } = makeActor(kv);
    await actor.report(actorReport());
    expect(logged("actor")[0]).toMatchObject({ trace_id: null, outcome: "counted" });
  });

  it("resolve writes resolved and unchanged actor lines, without an account", async () => {
    const kv = createKvFake(createClockFake(T0).now);
    const { actor } = makeActor(kv);
    await actor.resolve({ nowMs: T0, traceId: "trace-9" });
    await actor.report(actorReport({ accountId: "DV-100001", traceId: "trace-9" }));
    await actor.report(actorReport({ accountId: "DV-100002", nowMs: T0 + 1, traceId: "trace-9" }));
    vi.setSystemTime(T0 + HOUR_MS);
    await actor.resolve({ nowMs: T0 + HOUR_MS, traceId: "trace-9" });
    const lines = logged("actor").filter((line) => line.method === "resolve");
    expect(lines.map((line) => line.outcome)).toEqual(["unchanged", "resolved"]);
    expect(lines[0]).toMatchObject({ method: "resolve", trace_id: "trace-9", area: "8630" });
    expect(lines[0].latency_ms).toEqual({ total: 0, actor: 0 });
    expect(lines[1].latency_ms).toEqual({ total: 0, actor: 0 });
    expect("account" in lines[0]).toBe(false);
  });

  it("a throwing report logs outcome error and rethrows", async () => {
    const kv = createKvFake(createClockFake(T0).now);
    const { actor } = makeActor(kv);
    await expect(actor.report(actorReport({ nowMs: NaN, traceId: "trace-7" }))).rejects.toThrow(
      RangeError,
    );
    const lines = logged("actor");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "error",
      method: "report",
      outcome: "error",
      trace_id: "trace-7",
    });
    expect(String(lines[0].error)).toContain("nowMs");
  });

  it("a throwing resolve logs outcome error and rethrows", async () => {
    const kv = createKvFake(createClockFake(T0).now);
    const { actor } = makeActor(kv);
    await expect(actor.resolve({ nowMs: Infinity, traceId: "trace-8" })).rejects.toThrow(
      RangeError,
    );
    expect(logged("actor")[0]).toMatchObject({
      level: "error",
      method: "resolve",
      outcome: "error",
      trace_id: "trace-8",
    });
  });

  // ---------- publish logging and trace id ----------

  it("publish and publish_retry carry the trace id of the change that set the outbox", async () => {
    const { kv, fail, ok } = switchableKv();
    const { actor } = makeActor(kv);
    ok();
    await actor.report(actorReport({ accountId: "DV-100001", traceId: "trace-plain" }));
    fail(new Error("kv_down"));
    await actor.report(actorReport({ accountId: "DV-100002", nowMs: T0 + 1, traceId: "trace-declare" }));
    // The declaring change armed the alarm; its failed publishes carry its trace id.
    await actor.alarm({ retryCount: 0, isRetry: false });
    expect(logged("publish_retry")).toHaveLength(1);
    expect(logged("publish_retry")[0]).toMatchObject({
      area: "8630",
      version: 1,
      trace_id: "trace-declare",
      latency_ms: { total: 0, kv: 0 },
    });
    // The ladder's failed retries carry the same trace id.
    await actor.alarm({ retryCount: 1, isRetry: true });
    expect(logged("publish_retry")).toHaveLength(2);
    expect(logged("publish_retry")[1]).toMatchObject({ version: 1, trace_id: "trace-declare" });
    // And so does the eventual publish from the alarm.
    ok();
    vi.setSystemTime(T0 + 15_000);
    await actor.alarm({ retryCount: 0, isRetry: false });
    expect(logged("publish")).toHaveLength(1);
    expect(logged("publish")[0]).toMatchObject({
      area: "8630",
      version: 1,
      trace_id: "trace-declare",
      latency_ms: { total: 0, kv: 0 },
    });
  });

  it("a publish from the alarm logs publish, and the method itself never does", async () => {
    const kv = createKvFake(createClockFake(T0).now);
    const { actor } = makeActor(kv);
    await actor.report(actorReport({ accountId: "DV-100001", traceId: "trace-1" }));
    await actor.report(actorReport({ accountId: "DV-100002", nowMs: T0 + 1, traceId: "trace-1" }));
    expect(logged("publish")).toEqual([]);
    await actor.alarm({ retryCount: 0, isRetry: false });
    expect(logged("publish")).toHaveLength(1);
    expect(logged("publish")[0]).toMatchObject({
      version: 1,
      trace_id: "trace-1",
      latency_ms: { total: 0, kv: 0 },
    });
    expect(logged("publish_retry")).toEqual([]);
  });

  // ---------- the retry ladder does not restart ----------

  it("repeated failed publishes climb the ladder instead of restarting it", async () => {
    const { kv, fail } = switchableKv();
    fail(new Error("kv_down"));
    const { actor, storage } = makeActor(kv);
    // v1 declares; the alarm fires straight away and fails: the ladder starts at 5 s.
    await actor.report(actorReport({ accountId: "DV-100001", traceId: "t1" }));
    await actor.report(actorReport({ accountId: "DV-100002", nowMs: T0 + 1, traceId: "t1" }));
    await actor.alarm({ retryCount: 0, isRetry: false });
    expect((await storedMeta(storage)).publishFailures).toBe(1);
    expect(await storage.getAlarm()).toBe(T0 + 5_000);
    // A new change (resolve, v2) moves the alarm to now, ahead of the ladder rung…
    vi.setSystemTime(T0 + 2_000);
    await actor.resolve({ nowMs: T0 + 2_000, traceId: "t2" });
    expect(await storage.getAlarm()).toBe(T0 + 2_000);
    // …and its failure goes UP the ladder to 15 s, not back to 5.
    await actor.alarm({ retryCount: 0, isRetry: false });
    expect((await storedMeta(storage)).publishFailures).toBe(2);
    expect(await storage.getAlarm()).toBe(T0 + 17_000);
    // A third change (re-declare, v3) moves the alarm to now again…
    vi.setSystemTime(T0 + 3_000);
    await actor.report(actorReport({ accountId: "DV-100003", nowMs: T0 + 3_000, traceId: "t3" }));
    const declaring = await actor.report(
      actorReport({ accountId: "DV-100004", nowMs: T0 + 3_001, traceId: "t3" }),
    );
    expect(declaring.incidentDeclared).toBe(true);
    expect(await storage.getAlarm()).toBe(T0 + 3_000);
    // …and its failure lands on 60 s.
    await actor.alarm({ retryCount: 0, isRetry: false });
    expect((await storedMeta(storage)).publishFailures).toBe(3);
    expect(await storage.getAlarm()).toBe(T0 + 63_000);
    expect(logged("publish_retry")).toHaveLength(3);
  });

  // ---------- confirming write ----------

  it("a late timed-out publish is corrected by the confirming write", async () => {
    let releaseHeld!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      releaseHeld = resolveGate;
    });
    let holding = true;
    const landed: AreaStatus[] = [];
    // Models KV honestly: a put lands when its promise settles, not when it
    // is called, so the held write can arrive late.
    const kv = {
      put: (_key: string, value: string) => {
        if (holding) {
          return gate.then(() => {
            landed.push(JSON.parse(value) as AreaStatus);
          });
        }
        landed.push(JSON.parse(value) as AreaStatus);
        return Promise.resolve();
      },
    } as unknown as KvNamespace;
    const { actor, storage } = makeActor(kv);

    // v1 declares; the alarm's publish is held until after the 5,000 ms timeout.
    await actor.report(actorReport({ accountId: "DV-100001", traceId: "trace-v1" }));
    await actor.report(actorReport({ accountId: "DV-100002", nowMs: T0 + 1, traceId: "trace-v1" }));
    const first = actor.alarm({ retryCount: 0, isRetry: false });
    await vi.advanceTimersByTimeAsync(5_000);
    await first;
    expect(logged("publish_retry")[0]).toMatchObject({
      error: "kv_publish_timeout",
      trace_id: "trace-v1",
    });
    expect((await storedMeta(storage)).confirmDueAtMs).toBe(T0 + 35_000);
    expect(await storage.getAlarm()).toBe(T0 + 10_000);

    // A newer change arrives while the confirming write is pending. It moves
    // the alarm to now (ahead of the ladder rung) and writes no KV itself.
    holding = false;
    vi.setSystemTime(T0 + 5_100);
    await actor.resolve({ nowMs: T0 + 5_100, traceId: "trace-v2" });
    expect(await storage.getAlarm()).toBe(T0 + 5_100);
    expect(landed).toEqual([]);

    // The alarm publishes v2 straight away — and re-arms for the confirming
    // write, which is still due at its own time.
    await actor.alarm({ retryCount: 0, isRetry: false });
    expect(landed.at(-1)).toMatchObject({ state: "ok", version: 2, updatedAt: T0 + 5_100 });
    expect((await storedState(storage)).outbox).toBeNull();
    expect(await storage.getAlarm()).toBe(T0 + 35_000);

    // The held v1 write finally lands, clobbering v2 with the stale status.
    releaseHeld();
    await gate;
    await Promise.resolve();
    expect(landed.at(-1)).toMatchObject({ state: "outage", version: 1 });

    // At the due time the confirming write restores the newest status.
    vi.setSystemTime(T0 + 35_000);
    await actor.alarm({ retryCount: 0, isRetry: false });
    expect(landed.at(-1)).toEqual({
      state: "ok",
      incidentId: null,
      eta: null,
      version: 2,
      updatedAt: T0 + 5_100,
    });
    expect((await storedMeta(storage)).confirmDueAtMs).toBeNull();
    expect(logged("publish").at(-1)).toMatchObject({
      area: "8630",
      version: 2,
      trace_id: "trace-v2",
    });
  });

  it("a failed confirming write is retried on the ladder and keeps the marker", async () => {
    const { kv, hang, ok } = switchableKv();
    hang();
    const { actor, storage } = makeActor(kv);
    await actor.report(actorReport({ accountId: "DV-100001", traceId: "trace-v1" }));
    await actor.report(actorReport({ accountId: "DV-100002", nowMs: T0 + 1, traceId: "trace-v1" }));
    const first = actor.alarm({ retryCount: 0, isRetry: false });
    await vi.advanceTimersByTimeAsync(5_000);
    await first;
    const dueAt = T0 + 35_000;
    expect((await storedMeta(storage)).confirmDueAtMs).toBe(dueAt);

    // The ladder's next alarm publishes the outbox once KV answers again…
    ok();
    vi.setSystemTime(T0 + 10_000);
    await actor.alarm({ retryCount: 0, isRetry: false });
    expect((await storedState(storage)).outbox).toBeNull();
    // …but the timed-out write still owes a confirming write at dueAt.
    expect(await storage.getAlarm()).toBe(dueAt);

    // When the confirming write times out at 5,000 ms as well, the marker
    // stays and the ladder arms the next attempt.
    hang();
    vi.setSystemTime(dueAt);
    const confirming = actor.alarm({ retryCount: 0, isRetry: false });
    await vi.advanceTimersByTimeAsync(5_000);
    await confirming;
    expect((await storedMeta(storage)).confirmDueAtMs).toBe(dueAt);
    expect((await storedMeta(storage)).publishFailures).toBe(1);
    expect(await storage.getAlarm()).toBe(dueAt + 10_000);
  });
});
