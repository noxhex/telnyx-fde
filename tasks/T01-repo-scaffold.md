# T01. Repo scaffold and workspace bundling

**Phase** 1 · **Depends on** nothing

## Goal

Set up the monorepo with npm workspaces, a shared package and three function skeletons registered with Telnyx. Prove that code imported from `packages/shared` bundles into a function, because every later card relies on it.

## Read first

- `AGENTS.md`, sections Stack, Layout and Commands.
- Environment variable syntax for `telnyx.toml`, at https://developers.telnyx.com/docs/edge-compute/configuration/environment-variables.md (fetch it).

## Files

- **Repo root.** `package.json`, `tsconfig.base.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore` (extend the existing one) and `infra/ids.json`.
- **Shared package.** `packages/shared/package.json`, `tsconfig.json`, `src/index.ts`, `src/version.ts` and `test/version.test.ts`.
- **Functions.** `functions/voice-context/`, `functions/voice-tools/` and `functions/mock-crm/` each get `package.json`, `tsconfig.json`, `telnyx.toml`, `src/index.ts` and `test/routing.test.ts`.

## Steps

1. Create the three functions from inside `functions/` with `telnyx-edge new-func --actor --name=<name>`, one at a time, because function creation is rate-limited. This registers each function and writes its `func_id` into `telnyx.toml`. Keep the `[edge_compute]` block as generated.
2. In all three, delete the sample actor class and the `[[actors]]` block. Actors arrive in T06 and T07.
3. Set up npm workspaces for `packages/*` and `functions/*`. `packages/shared` is consumed by the functions as `@duinvezel/shared`.
4. `packages/shared/src/version.ts` exports `SHARED_VERSION = "0.1.0"`.
5. Each function's `src/index.ts` is a fetch handler with strict routing. `GET /healthz` returns 200 with `{ "ok": true, "svc": "<function name>", "shared": SHARED_VERSION }` and touches no state. Every other method and path returns 404 with `{ "error": "not_found" }`.
6. Keep the routing logic in a pure function, `route(method, pathname)`, so `test/routing.test.ts` can check it without a server.
7. Root scripts. `npm run typecheck` type-checks every workspace, `npm test` runs vitest across the repo, and `npm run check` runs both.
8. Create `infra/ids.json`, the one place for platform ids. Record each function's name, `func_id` and invoke URL from `telnyx-edge list`, and leave `"kvNamespaceId": null` for Thiago to fill in.

## Acceptance

- [ ] `npm install && npm run check` passes at the repo root.
- [ ] `telnyx-edge list` shows `voice-context`, `voice-tools` and `mock-crm`.
- [ ] For each function, `telnyx-edge dev` started in the background serves `GET /healthz` with the shared version string, which proves the workspace import is bundled. `GET /nope` returns 404. Stop the server afterwards.
- [ ] The routing tests cover the health route, a wrong method on it, and an unknown path.
- [ ] Nothing is shipped.

## Report

Include the local port each `telnyx-edge dev` used, and any problem with bundling the shared package or with a manifest that has no `[[actors]]` block. If a manifest without actors does not work, keep a minimal placeholder actor and say so.

## Out of scope

KV and actor bindings, secrets, real routes.
