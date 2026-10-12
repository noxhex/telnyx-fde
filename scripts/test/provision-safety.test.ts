/**
 * Safety: a timeout stops the run as an unknown outcome, a missing
 * `mcp_enc_key` stops before any write, malformed environment stops before
 * any request, `--dry-run` sends only GET requests, and an error answer
 * stops the run with method, path, status and code.
 */

import { describe, expect, it, vi } from "vitest";

import { loadInstructions } from "../../assistant/instructions.ts";
import { readEnvConfig } from "../provision.ts";
import { ConfigError, HttpTimeoutError, MissingSecretError, NotFoundError } from "../provision/errors.ts";
import { provision } from "../provision/run.ts";
import { ManualTimeouts } from "./manual-timeout.ts";
import { FakeApi, PHONE_NUMBER, TRANSFER_TO, makeDeps } from "./fake-api.ts";

describe("a create that timed out", () => {
  it("stops the run, says the outcome is unknown, aborts the request and leaves the late result alone", async () => {
    const api = new FakeApi();
    api.holdNextRequest();
    const timeouts = new ManualTimeouts();
    const deps = makeDeps({ api, timeoutRunner: timeouts.runner });

    const running = provision(deps);
    await vi.waitFor(() => {
      expect(api.requests).toHaveLength(3);
    });
    expect(api.requests[2]?.method).toBe("POST");
    const firstKey = api.requests[2]?.headers["Idempotency-Key"];
    expect(firstKey).toMatch(/^duinvezel-tool-[0-9a-f]{16}$/);

    timeouts.fire(2);
    const failure = await running.then(
      () => {
        throw new Error("the run must have rejected");
      },
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(HttpTimeoutError);
    expect((failure as Error).message).toContain("POST /ai/tools timed out after 15000 ms");
    expect((failure as Error).message).toContain("the outcome of that request is unknown");
    expect(deps.lines).toEqual(["secret mcp_enc_key: present"]);

    /* The held request was aborted, and nothing more went out. */
    expect(api.requests[2]?.aborted).toBe(true);
    expect(timeouts.wasAborted(2)).toBe(true);
    expect(api.requests).toHaveLength(3);
    expect(deps.written).toHaveLength(0);

    /* The held create settles after the timeout fired: the late result covers nothing. */
    api.settleHeld({ status: 200, text: () => Promise.resolve(JSON.stringify({ id: "tool-late" })) });
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(api.requests).toHaveLength(3);
    expect(deps.written).toHaveLength(0);
  });

  it("sends the same Idempotency-Key when it is run again", async () => {
    const first = new FakeApi();
    first.holdNextRequest();
    const firstTimeouts = new ManualTimeouts();
    const running = provision(makeDeps({ api: first, timeoutRunner: firstTimeouts.runner }));
    await vi.waitFor(() => {
      expect(first.requests).toHaveLength(3);
    });
    firstTimeouts.fire(2);
    await expect(running).rejects.toThrowError(/timed out/);
    const firstKey = first.requests[2]?.headers["Idempotency-Key"];

    const second = new FakeApi();
    await provision(makeDeps({ api: second, timeoutRunner: new ManualTimeouts().runner }));
    const create = second.requests.find((r) => r.method === "POST" && r.path === "/ai/tools");
    expect(create?.headers["Idempotency-Key"]).toBe(firstKey);
  });
});

describe("the integration secret", () => {
  it("stops before any write when mcp_enc_key is missing", async () => {
    const api = new FakeApi({ secrets: ["unrelated_key"] });
    const deps = makeDeps({ api, timeoutRunner: new ManualTimeouts().runner });
    const failure = await provision(deps).then(
      () => {
        throw new Error("the run must have rejected");
      },
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(MissingSecretError);
    expect((failure as Error).message).toContain("integration secret mcp_enc_key is not on the account");
    expect(api.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /integration_secrets"]);
    expect(deps.written).toHaveLength(0);
    expect(deps.lines).toEqual([]);
  });
});

describe("the environment", () => {
  const good = { TELNYX_API_KEY: "k", TRANSFER_TO, DUINVEZEL_PHONE_NUMBER: PHONE_NUMBER };

  it("stops before any request and names the variable when one is missing", () => {
    expect(() => readEnvConfig({})).toThrowError(ConfigError);
    expect(() => readEnvConfig({})).toThrowError(/^environment variable TELNYX_API_KEY is missing$/);
    expect(() => readEnvConfig({ TELNYX_API_KEY: "k" })).toThrowError(
      /^environment variable TRANSFER_TO is missing$/,
    );
    expect(() => readEnvConfig({ TELNYX_API_KEY: "k", TRANSFER_TO })).toThrowError(
      /^environment variable DUINVEZEL_PHONE_NUMBER is missing$/,
    );
  });

  it.each([
    ["+123456", "seven digits is nine, six is too few"],
    ["+1234567890123456", "sixteen digits is one too many"],
    ["32479123456", "no plus"],
    ["+32 479 12 34 56", "spaces"],
    ["+32SECRET12345", "letters"],
  ])("rejects a number that is not E.164: %s (%s), naming the variable and never its value", (bad) => {
    expect(() => readEnvConfig({ ...good, TRANSFER_TO: bad })).toThrowError(
      /^environment variable TRANSFER_TO is not an E\.164 number/,
    );
    expect(() => readEnvConfig({ ...good, DUINVEZEL_PHONE_NUMBER: bad })).toThrowError(
      /^environment variable DUINVEZEL_PHONE_NUMBER is not an E\.164 number/,
    );
    try {
      readEnvConfig({ ...good, TRANSFER_TO: bad });
      expect.unreachable("must have thrown");
    } catch (error) {
      expect((error as Error).message).not.toContain(bad);
    }
  });

  it.each([["+1234567", "exactly 7 digits"], ["+123456789012345", "exactly 15 digits"]])(
    "accepts an E.164 number at the boundary: %s (%s)",
    (number) => {
      const config = readEnvConfig({ ...good, TRANSFER_TO: number, DUINVEZEL_PHONE_NUMBER: number });
      expect(config).toEqual({ apiKey: "k", transferTo: number, phoneNumber: number });
    },
  );
});

describe("--dry-run", () => {
  it("sends only GET requests and writes no file on an empty account", async () => {
    const api = new FakeApi();
    const deps = makeDeps({ api, timeoutRunner: new ManualTimeouts().runner, overrides: { dryRun: true } });
    await provision(deps);

    expect(api.requests.every((r) => r.method === "GET")).toBe(true);
    expect(deps.written).toHaveLength(0);
    expect(deps.lines).toEqual([
      "secret mcp_enc_key: present",
      "tool duinvezel-log-disclosure: would create",
      "tool duinvezel-transfer: would create",
      "tool duinvezel-hangup: would create",
      "mcp_server duinvezel-voice-tools: would create",
      "assistant Duinvezel Support: would create",
      "phone_number ...0143 (pn-0001): would update (connection_id); the number needs a few minutes before calls go through",
      "ids infra/ids.json: would write",
    ]);
  });

  it("prints unchanged and writes no file on an account that already matches", async () => {
    const api = new FakeApi();
    const first = makeDeps({ api, timeoutRunner: new ManualTimeouts().runner });
    await provision(first);
    const before = api.requests.length;

    const dry = makeDeps({
      api,
      timeoutRunner: new ManualTimeouts().runner,
      overrides: { dryRun: true, idsFile: JSON.parse(first.written[0] ?? "{}") as Record<string, unknown> },
    });
    await provision(dry);

    expect(api.requests.slice(before).every((r) => r.method === "GET")).toBe(true);
    expect(dry.written).toHaveLength(0);
    expect(dry.lines).toEqual([
      "secret mcp_enc_key: present",
      "tool duinvezel-log-disclosure (tool-0001-uuid): unchanged",
      "tool duinvezel-transfer (tool-0002-uuid): unchanged",
      "tool duinvezel-hangup (tool-0003-uuid): unchanged",
      "mcp_server duinvezel-voice-tools (mcp-server-0001-uuid): unchanged",
      "assistant Duinvezel Support (assistant-0001-uuid): unchanged",
      "phone_number ...0143 (pn-0001): unchanged",
      "ids infra/ids.json: unchanged",
    ]);
  });
});

describe("the phone number lookup", () => {
  it("stops with no PATCH and no ids file when the API answers only other numbers", async () => {
    const api = new FakeApi({
      phoneNumbers: [
        { id: "pn-other-1", phone_number: "+32470009988", connection_id: "app-x" },
        { id: "pn-other-2", phone_number: "+12025550100", connection_id: "app-y" },
      ],
      ignorePhoneNumberFilter: true,
    });
    const deps = makeDeps({ api, timeoutRunner: new ManualTimeouts().runner });
    const failure = await provision(deps).then(
      () => {
        throw new Error("the run must have rejected");
      },
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(NotFoundError);
    expect((failure as Error).message).toBe("no phone number ending 0143 is on the account");
    /* The run touched no other number: no PATCH /phone_numbers/<id> went out. */
    expect(api.requests.filter((r) => r.method === "PATCH")).toHaveLength(0);
    expect(deps.written).toHaveLength(0);
    expect(api.phoneNumbers.map((entry) => entry.connection_id)).toEqual(["app-x", "app-y"]);
  });

  it("stops the same way on a dry run, with only GET requests", async () => {
    const api = new FakeApi({
      phoneNumbers: [{ id: "pn-other-1", phone_number: "+32470009988", connection_id: "app-x" }],
      ignorePhoneNumberFilter: true,
    });
    const deps = makeDeps({ api, timeoutRunner: new ManualTimeouts().runner, overrides: { dryRun: true } });
    await expect(provision(deps)).rejects.toThrowError("no phone number ending 0143 is on the account");
    expect(api.requests.every((r) => r.method === "GET")).toBe(true);
    expect(api.requests.some((r) => r.method === "GET" && r.path === "/phone_numbers")).toBe(true);
    expect(deps.written).toHaveLength(0);
  });
});

describe("error answers", () => {
  it("stops the run with method, path, status and the API's first error code and title", async () => {
    const api = new FakeApi();
    api.failOn("POST", "/ai/tools", 422, {
      errors: [{ code: "10015", title: "Validation error", detail: "transfer.from is not a number" }],
    });
    const deps = makeDeps({ api, timeoutRunner: new ManualTimeouts().runner });
    await expect(provision(deps)).rejects.toThrowError(
      'POST /ai/tools returned 422 (code 10015, "Validation error")',
    );
    expect(api.requests).toHaveLength(3);
    expect(deps.written).toHaveLength(0);
  });

  it("stops at once on a 403", async () => {
    const api = new FakeApi();
    api.failOn("GET", "/integration_secrets", 403, { errors: [{ code: "10009", title: "Forbidden" }] });
    const deps = makeDeps({ api, timeoutRunner: new ManualTimeouts().runner });
    await expect(provision(deps)).rejects.toThrowError('GET /integration_secrets returned 403 (code 10009, "Forbidden")');
    expect(api.requests).toHaveLength(1);
  });

  it("stops at once on an error that mentions the spend limit (10039)", async () => {
    const api = new FakeApi();
    api.failOn("GET", "/ai/tools", 403, {
      errors: [{ code: "10039", title: "Inference spend limit reached", detail: "Inference is paused" }],
    });
    const deps = makeDeps({ api, timeoutRunner: new ManualTimeouts().runner });
    await expect(provision(deps)).rejects.toThrowError('GET /ai/tools returned 403 (code 10039, "Inference spend limit reached")');
    expect(api.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /integration_secrets",
      "GET /ai/tools",
    ]);
    expect(deps.written).toHaveLength(0);
  });
});
