# Instructions for coding agents working on Glass

Glass is open-source, agent-first analytics that runs in the user's own Cloudflare account. This file is for agents changing Glass itself. (Agents *using* Glass in another project get instructions from `glass init`.)

## Commands

- `pnpm build`: build everything (required before `pnpm dev` and e2e tests)
- `pnpm typecheck`: must pass with no errors
- `pnpm test`: unit and integration tests; run one file with `node --test <path>`
- `pnpm test:e2e`: browser tests against the demo site (needs `npx playwright install chromium`)
- `pnpm dev`: local Worker on :8787 (admin key `dev-admin-key`) and demo site on :8788

Run `pnpm typecheck && pnpm test` before you finish. If you changed the SDK, ingest, replay or dashboard, also run `pnpm test:e2e`.

## Map

- `packages/core/src`: pure logic. Insights (`insights/*.ts`) compile specs to SQL; `sql/dialect.ts` holds the only engine-specific SQL; `filters.ts` is the property and filter language.
- `packages/worker/src`: `app.ts` routes, `service.ts` holds every operation, `api.ts`/`mcp/` are thin surfaces over the service, `ingest.ts` is the ingest pipeline, `stores/` holds the D1 and lake event stores.
- `packages/web/src`: browser SDK. `client.ts` is the public API; `replay.ts` becomes `replay.js`.
- `packages/dashboard/src`: no framework; `h()` in `dom.ts` builds DOM; one file per page in `pages/`.
- `packages/cli/src`: `commands/init.ts` is onboarding; Cloudflare calls go through `cloudflare/wrangler.ts`.

## Rules

1. **New capabilities go in `GlassService`** (`packages/worker/src/service.ts`), validated with zod, then get exposed through `api.ts`, `mcp/tools.ts` and, where useful, the CLI. Don't put logic in route handlers.
2. **SQL must work on SQLite and Basin SQL.** Use `eventsCte()`, `bucketExpr()`, `filtersSql()` and the `Dialect` methods. Timestamps are integer milliseconds (`ts_ms`). No window functions unless they are unavoidable (they're budget-gated in Basin SQL). Inline values only through `d.str()`/`d.num()`.
3. **Test SQL by executing it.** Core tests run compiled queries on real SQLite (`packages/core/test/helpers.ts`). Don't assert on SQL strings except for lake-dialect specifics.
4. **No new runtime dependencies** in the Worker or SDK without the maintainers agreeing in an issue.
5. **Keep the SDK small.** The SDK must not import from `@glassanalytics/core`'s barrel (`@glassanalytics/core`); import specific modules (`@glassanalytics/core/ids`) so zod never reaches the browser bundle.
6. **Errors explain the fix.** Use `HttpError(status, message, hint)` in the Worker and `UsageError(message, hint)` in the CLI.
7. **Migrations are append-only.** Add `packages/worker/migrations/000N_*.sql`; never edit shipped ones.
8. **Write for agents and humans.** Tool descriptions, `summary` strings and error messages are read by models; make them specific and short.
9. Node runs `.ts` sources directly: use `.ts` import extensions and only erasable syntax (no enums, namespaces or parameter properties).
