# Extending Glass

Glass is built from small registries so the common extensions are one file each. Every example here has a test pattern next to it in the repository.

## Add a query type

1. Create `packages/core/src/insights/paths.ts`:

   ```ts
   import { z } from 'zod/v4';
   import { eventsCte, num, text } from '../sql/source.ts';
   import { iso, resolveRange } from '../time.ts';
   import type { QueryContext, ResultBase } from './types.ts';

   export const pathsSpec = z.object({
     project: z.string().optional(),
     from: z.union([z.string(), z.number()]).optional(),
     to: z.union([z.string(), z.number()]).optional(),
     start: z.string().describe('Page path the paths start from.'),
   });

   export async function runPaths(spec: z.infer<typeof pathsSpec>, ctx: QueryContext): Promise<ResultBase & { next: { path: string; people: number }[] }> {
     const range = resolveRange(spec.from, spec.to, ctx.now);
     const d = ctx.dialect;
     const sql = `WITH ${eventsCte(d, { project: ctx.project, ...range, events: ['$pageview'] })} …`;
     const rows = await ctx.execute(sql);
     return { kind: 'paths', sql: [sql], range: { from: iso(range.from), to: iso(range.to) }, summary: '…', next: rows.map((r) => ({ path: text(r.path), people: num(r.n) })) };
   }
   ```

2. Register it in `packages/core/src/insights/index.ts`:

   ```ts
   paths: define({ description: 'Where people go next after a page.', schema: pathsSpec, run: runPaths }),
   ```

You now have `POST /api/query {"kind":"paths"}`, an MCP tool `query_paths` and `glass query paths --spec '…'`. Write tests in `packages/core/test/` that insert events with `insert()` and execute your SQL on SQLite (see `insights.test.ts`).

Rules for portable SQL: start from `eventsCte()` (it scopes to the project and range, and resolves people as `pid`); use `ts_ms` integer arithmetic or `bucketExpr()` for time; filters via `filtersSql()`; anything engine-specific goes in `Dialect`.

## Add an MCP tool

Add a method to `GlassService` (`packages/worker/src/service.ts`) that validates its input with zod and returns a plain object with a `summary`. Then add an entry to `TOOLS` in `packages/worker/src/mcp/tools.ts`:

```ts
{
  name: 'list_cohorts',
  title: 'List cohorts',
  description: 'Saved groups of people, with their definitions and sizes.',
  input: inputs.listCohorts,
  scope: 'read',
  run: (s, a) => s.listCohorts(a),
},
```

Add an HTTP route in `packages/worker/src/api.ts` and a CLI command if people will want it from a terminal. Test through `testApp()` in `packages/worker/test/app.test.ts`, which runs the real Worker on SQLite.

## Add a storage engine

Implement two interfaces:

- `Dialect` (`packages/core/src/sql/dialect.ts`): literals, JSON access, month arithmetic and table names for your engine.
- `EventStore` (`packages/worker/src/stores/types.ts`): `write(events)`, `writeIdentity(link)`, `query(sql)`, `deletePersonEvents(project, ids)`.

Then select it in `createStore()` (`packages/worker/src/app.ts`) from an environment variable, and add a provisioning step to `glass init` if it needs resources. Run the core insight tests against your dialect if your engine can run locally (DuckDB and ClickHouse both can).

## Add a framework snippet

Add an entry to `FRAMEWORKS` and a detection rule in `detectFramework()` (`packages/core/src/instrument.ts`). `glass init` and the `instrument` tool pick it up automatically.

## Enrich events at ingest

`toRows()` in `packages/worker/src/ingest.ts` is the enrichment step. Add a column through a new migration (and `EVENT_COLUMNS`, and the lake schema), or add derived values to `props`. Keep ingest fast: it runs on every request.

## Change the dashboard

Pages are functions from a route to DOM nodes (`packages/dashboard/src/pages/`), built with `h()` from `dom.ts`. Add a page to `PAGES` in `main.ts`. Wrap anything that shows numbers in `panel(…, { sql })` so "Show SQL" works.
