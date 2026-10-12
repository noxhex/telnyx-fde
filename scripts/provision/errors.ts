/**
 * `scripts/provision/errors.ts` — the errors the provisioning run can stop
 * with. Every message is built here, so no message ever carries the API key,
 * a secret, a token, an environment variable's value or a phone number beyond
 * its last four digits.
 */

/** Base class for every expected failure of the run. The entry point prints `error: <message>` and exits 1. */
export class ProvisionError extends Error {}

/**
 * A missing or malformed environment variable. Names the variable, never its
 * value, and is raised before any request goes out.
 */
export class ConfigError extends ProvisionError {
  constructor(variable: string, reason: string) {
    super(`environment variable ${variable} ${reason}`);
    this.name = "ConfigError";
  }
}

/** The integration secret `mcp_enc_key` is not on the account (DEBUGLOG issue 13: it must match the edge secret). */
export class MissingSecretError extends ProvisionError {
  constructor(identifier: string) {
    super(
      `integration secret ${identifier} is not on the account; T10 writes it ` +
        "together with the edge secret MCP_ENC_KEY from one saved value — run those steps first",
    );
    this.name = "MissingSecretError";
  }
}

/** A non-2xx answer from the API. The path never carries its query, and the message never the body that was sent. */
export class ApiError extends ProvisionError {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly code: string | undefined;
  readonly title: string | undefined;

  constructor(method: string, path: string, status: number, code: string | undefined, title: string | undefined) {
    const where = `${method} ${path} returned ${status}`;
    const what =
      code !== undefined
        ? ` (code ${code}${title !== undefined ? `, "${title}"` : ""})`
        : title !== undefined
          ? ` ("${title}")`
          : "";
    super(`${where}${what}`);
    this.name = "ApiError";
    this.method = method;
    this.path = path;
    this.status = status;
    this.code = code;
    this.title = title;
  }
}

/**
 * A request that hit its 15-second timeout. A timeout is an unknown outcome
 * (ADR-015, DEBUGLOG issue 5): the request may have landed, so the run stops
 * and the next run reads the current state before it writes.
 */
export class HttpTimeoutError extends ProvisionError {
  constructor(method: string, path: string, ms: number) {
    super(
      `${method} ${path} timed out after ${ms} ms; the outcome of that request ` +
        "is unknown — run the script again, it reads the current state before it writes",
    );
    this.name = "HttpTimeoutError";
  }
}

/**
 * Internal signal the timeout runner rejects with when the budget fires. The
 * client turns it into the HttpTimeoutError that names the request.
 */
export class TimeoutFiredError extends Error {
  constructor() {
    super("timeout fired");
    this.name = "TimeoutFiredError";
  }
}

/** A 2xx answer whose body does not match the schema the script reads. */
export class ResponseShapeError extends ProvisionError {
  constructor(method: string, path: string, detail: string) {
    super(`${method} ${path} returned an unexpected response shape (${detail})`);
    this.name = "ResponseShapeError";
  }
}

/** The phone number is not on the account, or a created resource came back without a field the script needs. */
export class NotFoundError extends ProvisionError {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}
