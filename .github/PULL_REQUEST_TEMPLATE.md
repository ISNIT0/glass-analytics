## What and why

<!-- What does this change, and what problem does it solve? Link the issue. -->

## How I tested it

<!-- Commands you ran (pnpm check, pnpm test:e2e…) and anything you checked by hand. -->

## Checklist

- [ ] `pnpm typecheck && pnpm test` pass
- [ ] `pnpm test:e2e` passes (if the SDK, ingest, replay or dashboard changed)
- [ ] New behaviour has tests; SQL changes are tested by executing the SQL
- [ ] Docs updated (`docs/`, tool descriptions, `--help`) if users or agents will notice
- [ ] Changeset added (`pnpm changeset`) if `glass` or `@glassanalytics/web` changed
- [ ] No new runtime dependencies, or the reason is explained above
