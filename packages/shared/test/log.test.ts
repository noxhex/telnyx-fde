import { describe, expect, it } from "vitest";

import { createLogger } from "../src/index.js";
import type { Level } from "../src/index.js";

const NOW_MS = 1_760_000_000_000;

function makeSink() {
  const lines: string[] = [];
  return {
    lines,
    sink: (line: string) => {
      lines.push(line);
    },
  };
}

// A clock that returns a fixed instant, for deterministic `ts` assertions.
function fixedNow(ms = NOW_MS) {
  return () => ms;
}

describe("createLogger", () => {
  it("emits one JSON object per line with ts, level, svc, event, then the fields", () => {
    const { lines, sink } = makeSink();
    const log = createLogger("voice-context", sink, fixedNow());
    log.log("info", "dv", { outcome: "ok", status: 200 });

    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]);
    expect(line).toEqual({
      ts: new Date(NOW_MS).toISOString(),
      level: "info",
      svc: "voice-context",
      event: "dv",
      outcome: "ok",
      status: 200,
    });
  });

  it("emits one line per call, even for repeated events", () => {
    const { lines, sink } = makeSink();
    const log = createLogger("svc", sink, fixedNow());
    log.log("info", "a");
    log.log("warn", "b");
    expect(lines).toHaveLength(2);
  });

  it("honours every level", () => {
    const { lines, sink } = makeSink();
    const log = createLogger("svc", sink, fixedNow());
    for (const level of ["debug", "info", "warn", "error"] as Level[]) {
      log.log(level, "event");
    }
    expect(lines.map((l) => JSON.parse(l).level)).toEqual([
      "debug",
      "info",
      "warn",
      "error",
    ]);
  });

  it("uses the injected clock for the timestamp", () => {
    const { lines, sink } = makeSink();
    const log = createLogger("svc", sink, fixedNow(1_700_000_000_123));
    log.log("info", "event");
    expect(JSON.parse(lines[0]).ts).toBe(new Date(1_700_000_000_123).toISOString());
  });

  it("does not throw when no sink is supplied", () => {
    const log = createLogger("svc", undefined, fixedNow());
    expect(() => log.log("info", "event", { a: 1 })).not.toThrow();
  });

  describe("child", () => {
    it("merges its fields into every line it writes", () => {
      const { lines, sink } = makeSink();
      const log = createLogger("svc", sink, fixedNow());
      const child = log.child({ trace_id: "trace-1" });

      child.log("info", "one", { a: 1 });
      child.log("warn", "two");

      expect(lines).toHaveLength(2);
      for (const line of lines) {
        expect(JSON.parse(line).trace_id).toBe("trace-1");
      }
      expect(JSON.parse(lines[0]).a).toBe(1);
    });

    it("leaves the parent's lines free of the child fields", () => {
      const { lines, sink } = makeSink();
      const log = createLogger("svc", sink, fixedNow());
      const child = log.child({ trace_id: "trace-1" });

      child.log("info", "child-event");
      log.log("info", "parent-event");

      expect(JSON.parse(lines[0]).trace_id).toBe("trace-1");
      expect(JSON.parse(lines[1])).not.toHaveProperty("trace_id");
    });
  });

  describe("redaction", () => {
    it("redacts a top-level field whose name contains a reserved word", () => {
      const { lines, sink } = makeSink();
      const log = createLogger("svc", sink, fixedNow());
      log.log("info", "event", {
        api_key: "sekret",
        signature: "sig",
        token: "tok",
        authorization: "auth",
        secret: "secret",
        password: "pw",
        safe: "kept",
      });

      const line = JSON.parse(lines[0]);
      expect(line.api_key).toBe("[redacted]");
      expect(line.signature).toBe("[redacted]");
      expect(line.token).toBe("[redacted]");
      expect(line.authorization).toBe("[redacted]");
      expect(line.secret).toBe("[redacted]");
      expect(line.password).toBe("[redacted]");
      expect(line.safe).toBe("kept");
    });

    it("redacts case-insensitively", () => {
      const { lines, sink } = makeSink();
      const log = createLogger("svc", sink, fixedNow());
      log.log("info", "event", {
        API_KEY: "a",
        Authorization: "b",
        ToKeN: "c",
        notSensitive: "visible",
      });

      const line = JSON.parse(lines[0]);
      expect(line.API_KEY).toBe("[redacted]");
      expect(line.Authorization).toBe("[redacted]");
      expect(line.ToKeN).toBe("[redacted]");
      expect(line.notSensitive).toBe("visible");
    });

    it("redacts nested fields at any depth", () => {
      const { lines, sink } = makeSink();
      const log = createLogger("svc", sink, fixedNow());
      log.log("info", "event", {
        outer: {
          inner: { access_token: "abc", ok: true },
          visible: "value",
        },
      });

      const line = JSON.parse(lines[0]);
      expect(line.outer.inner.access_token).toBe("[redacted]");
      expect(line.outer.inner.ok).toBe(true);
      expect(line.outer.visible).toBe("value");
    });

    it("redacts reserved words inside array elements and deep objects", () => {
      const { lines, sink } = makeSink();
      const log = createLogger("svc", sink, fixedNow());
      log.log("info", "event", {
        list: [{ access_token: "no", id: 3 }],
        nested: { a: { b: { password: "pw", fine: 1 } } },
      });

      const line = JSON.parse(lines[0]);
      expect(line.list[0].access_token).toBe("[redacted]");
      expect(line.list[0].id).toBe(3);
      expect(line.nested.a.b.password).toBe("[redacted]");
      expect(line.nested.a.b.fine).toBe(1);
    });

    it("does not redact the structural fields ts, level, svc and event", () => {
      const { lines, sink } = makeSink();
      const log = createLogger("svc", sink, fixedNow());
      log.log("error", "event", { api_key: "x" });

      const line = JSON.parse(lines[0]);
      expect(line.ts).toBe(new Date(NOW_MS).toISOString());
      expect(line.level).toBe("error");
      expect(line.svc).toBe("svc");
      expect(line.event).toBe("event");
    });
  });

  describe("structural fields", () => {
    it("never lets a field overwrite ts, level, svc or event", () => {
      const { lines, sink } = makeSink();
      const log = createLogger("svc", sink, fixedNow());
      log.log("info", "call.started", {
        ts: "forged",
        level: "error",
        svc: "forged-svc",
        event: "forged-event",
      });

      const line = JSON.parse(lines[0]);
      expect(line.ts).toBe(new Date(NOW_MS).toISOString());
      expect(line.level).toBe("info");
      expect(line.svc).toBe("svc");
      expect(line.event).toBe("call.started");
    });

    it("never lets a child field overwrite ts, level, svc or event either", () => {
      const { lines, sink } = makeSink();
      const log = createLogger("svc", sink, fixedNow());
      const child = log.child({ level: "error", svc: "forged-svc", trace_id: "t-1" });
      child.log("warn", "real-event");

      const line = JSON.parse(lines[0]);
      expect(line.level).toBe("warn");
      expect(line.svc).toBe("svc");
      expect(line.event).toBe("real-event");
      expect(line.trace_id).toBe("t-1");
    });
  });
});