# Instructions for coding agents working on Dataflare

Dataflare is open-source, agent-first analytics that runs in the user's own Cloudflare account. This file is for agents changing Dataflare itself. (Agents _using_ Dataflare in another project get instructions from `dataflare init`.)

## Commands

- `pnpm build`: build everything (required before `pnpm dev` and e2e tests)
- `pnpm typecheck`: must pass with no errors
- `pnpm test`: unit and integration tests; run one file with `node --test <path>`
- `pnpm test:e2e`: browser tests against the demo site (needs `npx playwright install chromium`)
- `pnpm dev`: local Worker on :8787 (admin key `dev-admin-key`) and demo site on :8788
- `pnpm quality`: tests with coverage, then the coverage and complexity ratchet (see below); `--fast` checks complexity only
- `pnpm quality:hotspots`: the most complex, least tested functions and files
- `pnpm knip`: unused files, dependencies and exports (unused files and dependencies fail CI)
- `pnpm size`: gzipped size of each bundle against its budget in `scripts/size.ts` (after `pnpm build`)
- `pnpm mutation --changed origin/main`: mutation testing of the core, worker and cli files you changed; survivors are bugs no test would catch

Run `pnpm check` (typecheck, lint, knip, tests, quality) before you finish; after `pnpm build`, also `pnpm size`. If you changed the SDK, ingest, replay or dashboard, also run `pnpm test:e2e`.

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
5. **Keep the SDK small.** The SDK must not import from `@dataflare/core`'s barrel (`@dataflare/core`); import specific modules (`@dataflare/core/ids`) so zod never reaches the browser bundle.
6. **Errors explain the fix.** Use `HttpError(status, message, hint)` in the Worker and `UsageError(message, hint)` in the CLI.
7. **Migrations are append-only.** Add `packages/worker/migrations/000N_*.sql`; never edit shipped ones.
8. **Write for agents and humans.** Tool descriptions, `summary` strings and error messages are read by models; make them specific and short.
9. Node runs `.ts` sources directly: use `.ts` import extensions and only erasable syntax (no enums, namespaces or parameter properties).

## Quality ratchet

`quality-baseline.json` holds a line-coverage floor per package and every function whose cognitive complexity is over the threshold (15). `pnpm quality` and the Quality workflow on every PR fail if a change:

- lowers line coverage of any package, or the total, by more than 0.1 points;
- adds a function over the threshold; or
- makes a function already listed in the baseline more complex.

The PR gets a comment with coverage before and after, the changed lines no test runs, and every function whose complexity changed. Leave the codebase better than you found it:

1. **Test what you add.** Aim for every changed line to be covered; `pnpm quality` lists the changed lines no test runs.
2. **Shrink what you touch.** If you edit a function in the baseline, try to bring it down: early returns instead of nesting, a lookup table instead of a long `if`/`switch`, a named helper per step.
3. **Lock improvements in.** When `pnpm quality` reports improvements, run `pnpm quality:update` and commit `quality-baseline.json` with your change.
4. **Don't loosen the baseline to get green.** `pnpm quality:update` refuses to lower a floor or add debt unless you pass `--allow-regression`. Use it only when the change is right, for example when code moved and kept its complexity, and say why in the PR. The PR comment flags every loosening for the reviewer.

Without [uv](https://docs.astral.sh/uv/) the Python-backed lake tests skip, so local coverage reads low; `pnpm quality` then only warns about coverage, and CI enforces it. The dashboard and the browser SDK are covered by the e2e suite, which the coverage numbers don't include yet, so they read 0%.

## Security and review checks on PRs

- **Security workflow**: zizmor and actionlint audit `.github/workflows` (pin actions to full commit SHAs, least-privilege `permissions`, `persist-credentials: false` unless the job pushes, untrusted values only through `env`), and dependency review fails a PR that adds a vulnerable dependency. Run `uvx zizmor .github/workflows` locally after editing a workflow.
- **CodeQL** (repository setting) scans every PR; **secret scanning push protection** rejects pushes that contain credentials.
- **CodeRabbit** reviews every PR using `.coderabbit.yaml`, which points it at this file. Treat its comments like a reviewer's: fix what is right, reply where it is wrong.
- **Mutation** comments a mutation score and the surviving mutants for changed core, worker and cli files. It doesn't block merging, but when you add tests, kill the survivors in code you touched.
