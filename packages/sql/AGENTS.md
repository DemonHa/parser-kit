# AGENTS.md — @parser-kit/sql

A typed SQL parser built on `@parser-kit/core`. Its only dialect so far is
PostgreSQL 17 (`gram.y` is the target). The entry points are `sqlLite` (SQL as
the server receives it) and `sqlLiteScript` (whole psql / pg_dump scripts); the
names date from when this grammar was the `examples/sql-lite` example and are
kept for now. See `README.md` here for the user-facing guide, the coverage
survey and the contributor checklist, and `../core/AGENTS.md` for the kit's
internals and grammar-authoring gotchas.

## Layout

- `src/` — the published code. `lexer.ts` (tokens, folding, strings, psql
  script lexers), `grammar.ts` (AST types, reserved words, the Pratt table, one
  rule per statement, the entry points), `index.ts` (the package entry),
  `psql-split.ts` (a test helper, not exported from the entry).
- `test/` — unit tests (`sql-lite.test.ts`), the entry-surface pin
  (`entry.test.ts`), the parity harness and its goldens, the PostgreSQL coverage
  battery (`pg-coverage.ts`) and the pg_dump corpus (`pg-dump-corpus.ts`,
  `fixtures/pg-dump/`, pagila vendored under the PostgreSQL License).
- `bench/` — the node-sql-parser comparisons. `bench-baseline.json` at the repo
  root keys on their file paths and group names.

Only `build/` and `src/` are published (`files` in `package.json`); CI's Package
job (`../../scripts/verify-packages.sh`) fails if tests, benches, goldens or
fixtures reach the tarball.

## Rules

- **The public API is `src/index.ts`.** Removing or renaming an export, or
  changing an AST node's shape, is a breaking change for npm consumers and needs
  a changeset that says so. `test/entry.test.ts` pins the exported values.
- **New AST fields are optional and left out when absent**, so trees for input
  that doesn't use the construct stay byte-identical (see the README's AST
  conventions).
- **Never regenerate a golden to make a change pass.** `test/parity.*.golden.json`
  pin every corpus AST (spans included) and every `diagnose()` message. When
  output is meant to move, regenerate with `pnpm test -- -u` from the repo root
  and call the diff out.
- **Keep the README's lists in step with the battery.** A change that moves a
  `pg-coverage.ts` or `pg-dump-corpus.ts` row also updates the README tables and
  the "Not yet supported" / "Known wrong ASTs" / "Behaviour changes" lists.
