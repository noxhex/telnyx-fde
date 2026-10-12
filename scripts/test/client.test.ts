/**
 * Unit tests for the API client: the timeout runner contract, the error
 * mapping and Idempotency-Key stability, and for the response schemas' two
 * accepted wrapper forms — a bare array or a `data` page for lists, a bare
 * object or a `data` wrapper for creates — and nothing looser.
 */

import { describe, expect, it } from "vitest";

import { createClient, idempotencyKey, realTimeoutRunner } from "../provision/client.ts";
import { ApiError, ResponseShapeError, TimeoutFiredError } from "../provision/errors.ts";
import { mcpServer, pageForm, sharedTool, singleForm, unwrapPage, unwrapSingle } from "../provision/schemas.ts";

describe("realTimeoutRunner", () => {
  it("lets a result through when it settles in time", async () => {
    await expect(realTimeoutRunner(() => Promise.resolve(42), 5_000)).resolves.toBe(42);
  });

  it("rejects with TimeoutFiredError and aborts the signal when the budget fires", async () => {
    let given: AbortSignal | undefined;
    const pending = realTimeoutRunner((signal) => {
      given = signal;
      return new Promise<string>(() => {});
    }, 5);
    await expect(pending).rejects.toBeInstanceOf(TimeoutFiredError);
    expect(given?.aborted).toBe(true);
  });
});

describe("idempotencyKey", () => {
  it("is duinvezel-<kind>-<16 hex> of the body's SHA-256, stable for the same body", () => {
    const body = { display_name: "x", timeout_ms: 5000, webhook: { url: "https://a.example.com" } };
    const key = idempotencyKey("tool", body);
    expect(key).toMatch(/^duinvezel-tool-[0-9a-f]{16}$/);
    expect(idempotencyKey("tool", body)).toBe(key);
    expect(idempotencyKey("mcp-server", body)).toMatch(/^duinvezel-mcp-server-[0-9a-f]{16}$/);
    expect(idempotencyKey("assistant", body)).toMatch(/^duinvezel-assistant-[0-9a-f]{16}$/);
  });

  it("changes with the body", () => {
    const body = { a: 1 };
    expect(idempotencyKey("tool", body)).not.toBe(idempotencyKey("tool", { a: 2 }));
  });
});

describe("the client's error mapping", () => {
  const noTimeout = <T>(work: (signal: AbortSignal) => Promise<T>, _ms: number): Promise<T> =>
    work(new AbortController().signal);

  it("reports a non-2xx answer without a JSON error body by status alone", async () => {
    const client = createClient({
      fetchImpl: () => Promise.resolve({ status: 502, text: () => Promise.resolve("bad gateway") }),
      timeoutRunner: noTimeout,
      apiKey: "k",
    });
    const schema = singleForm(mcpServer);
    const failure = await client
      .request({ method: "GET", path: "/ai/mcp_servers", schema: pageForm(mcpServer) })
      .then(
        () => {
          throw new Error("must have rejected");
        },
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as Error).message).toBe("GET /ai/mcp_servers returned 502");
    void schema;
  });

  it("rejects a 2xx answer whose body fails the schema", async () => {
    const client = createClient({
      fetchImpl: () => Promise.resolve({ status: 200, text: () => Promise.resolve(JSON.stringify({ nope: 1 })) }),
      timeoutRunner: noTimeout,
      apiKey: "k",
    });
    const failure = await client
      .request({ method: "GET", path: "/ai/tools", schema: pageForm(sharedTool) })
      .then(
        () => {
          throw new Error("must have rejected");
        },
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(ResponseShapeError);
    expect((failure as Error).message).toContain("GET /ai/tools returned an unexpected response shape");
  });
});

describe("the schemas' two forms and nothing looser", () => {
  const server = {
    id: "s-1",
    name: "duinvezel-voice-tools",
    type: "http",
    url: "https://example.com/mcp",
    api_key_ref: "{{mcp_token | mcp_enc_key}}",
    allowed_tools: ["verify_account"],
    created_at: "2026-10-12T13:00:00.000Z",
  };

  it("accepts the MCP server list both as a bare array and as a page", () => {
    const schema = pageForm(mcpServer);
    const bare = schema.safeParse([server]);
    const page = schema.safeParse({ data: [server], meta: { total_pages: 1 } });
    expect(bare.success).toBe(true);
    expect(page.success).toBe(true);
    if (bare.success) {
      expect(unwrapPage(bare.data)).toHaveLength(1);
    }
    if (page.success) {
      expect(unwrapPage(page.data)).toHaveLength(1);
    }
  });

  it("rejects any other list form", () => {
    const schema = pageForm(mcpServer);
    expect(schema.safeParse({ servers: [server] }).success).toBe(false);
    expect(schema.safeParse("nope").success).toBe(false);
    expect(schema.safeParse({ data: "nope" }).success).toBe(false);
    expect(schema.safeParse([{ name: "no id" }]).success).toBe(false);
  });

  it("accepts a create answer both bare and wrapped in data, and keeps the API's extra keys", () => {
    const schema = singleForm(mcpServer);
    const bare = schema.safeParse(server);
    const wrapped = schema.safeParse({ data: server, idempotent_replayed: true });
    expect(bare.success).toBe(true);
    expect(wrapped.success).toBe(true);
    if (bare.success) {
      expect(unwrapSingle(bare.data).id).toBe("s-1");
    }
    if (wrapped.success) {
      const unwrapped = unwrapSingle(wrapped.data);
      expect(unwrapped.allowed_tools).toEqual(["verify_account"]);
      expect(unwrapped.created_at).toBe("2026-10-12T13:00:00.000Z");
    }
  });

  it("rejects a create answer in any other form", () => {
    const schema = singleForm(mcpServer);
    expect(schema.safeParse({ result: server }).success).toBe(false);
    expect(schema.safeParse({ id: 42 }).success).toBe(false);
    expect(schema.safeParse(null).success).toBe(false);
  });
});
