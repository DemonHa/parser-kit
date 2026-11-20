# AGENTS.md — @parser-kit/sql

A typed SQL parser built on `@parser-kit/core`. Its only dialect so far is
PostgreSQL 17 (`gram.y` is the target), exposed as the `postgres` dialect
object: `parse` / `diagnose` (SQL as the server receives it), `parseScript` /
`diagnoseScript` (whole psql / pg_dump scripts) and the `lexer` /
`scriptLexer` tokenizers. More dialects (MySQL next) will sit beside it as
objects of the same shape, each in its own `src/<dialect>/` directory with its
own subpath export. See `README.md` here for the user-facing guide, the coverage
survey and the contributor checklist, and `../core/AGENTS.md` for the kit's
internals and grammar-authoring gotchas.

## Layout

- `src/` — the published code. `index.ts` is the package root
  (`@parser-kit/sql`) and re-exports every dialect.
- `src/postgres/` — the PostgreSQL dialect: `lexer.ts` (tokens, folding,
  strings, psql script lexers), `grammar.ts` (AST types, reserved words, the
  Pratt table, one rule per statement, the two root grammars), `ast.ts` (the
  explicit type-only list of public AST types; `entry.test.ts` keeps it in step
  with `grammar.ts`) and `index.ts` (the `postgres` object and its public
  types; the `@parser-kit/sql/postgres` subpath export). The root `index.ts`
  exposes each dialect's AST types as a namespace (`Postgres.Stmt`) so that
  dialects' same-named types don't collide.
- `src/postgres/print/` — the printer, AST back to SQL (internal: not on the
  `postgres` object or any entry yet). `context.ts` holds the options and the
  lexical rules (keywords, name quoting, strings), `expr.ts` every expression,
  `types.ts` type names, and each statement family has a module declared with
  `defineFamily` (`registry.ts`): `query.ts` (queries and FROM items),
  `dml.ts`, `tables.ts`, `objects.ts` and `roles.ts`. A family lists the kinds
  it prints and the kinds it doesn't print yet, which throw
  `NotPrintableError`; printing a kind means a handler in its family's module
  and cases in `test/stringify-cases/<family>.ts`, so families land in
  parallel without sharing a file.
  `index.ts` joins the families into the statement printer and `stringify`.
  Parentheses come from the grammar's Pratt tables through `precedence`, so a
  group that builds a new node kind needs its printer-only `nodes` / `rhs`
  annotation too. `expr.ts` and `query.ts` import each other: neither may use
  the other's exports at module load, only inside functions. Some AST pieces
  serve several families (`RelationOption`, `GenericOption`, `ObjectRef`,
  `FunctionArg`, the rename / owner / schema actions, `AlterConfigAction`);
  the first family that prints one puts its printer in a shared module
  (`print/shared.ts`) for the others to import, rather than in its own.
- `test/` — unit tests (`postgres.test.ts`), the entry-surface pin
  (`entry.test.ts`), the parity harness and its goldens, the PostgreSQL coverage
  battery (`pg-coverage.ts`) and the pg_dump corpus (`pg-dump-corpus.ts`,
  `fixtures/pg-dump/`, pagila vendored under the PostgreSQL License) and
  `psql-split.ts`, the psql-style statement splitter the corpus test uses.
  `stringify.test.ts` round-trips the corpus, the parity lists, the accepted
  battery rows, the pg_dump statements that parse and each family's cases in
  `stringify-cases/` through the printer (`stringify.<family>.golden.sql` pin
  its width-80 output per statement family; `STRINGIFY_REPORT=1` prints what
  isn't printable yet), and `parity-corpus.ts` holds the parity lists both
  harnesses read.
- `bench/` — the node-sql-parser comparisons. `bench-baseline.json` at the repo
  root keys on their file paths and group names.

Only `build/`, `src/` and the changelog are published (`files` in `package.json`), plus the files npm always adds; CI's Package
job (`../../scripts/verify-packages.sh`) fails if tests, benches, goldens or
fixtures reach the tarball.

## Rules

- **The public API is `src/index.ts` and `src/postgres/index.ts`.** Removing
  or renaming an export or a dialect method, or changing an AST node's shape, is
  a breaking change for npm consumers and needs a changeset that says so.
  `test/entry.test.ts` pins the exported values and the dialect object's keys.
  Lexer and grammar plumbing (`sqlParseLexer`, `copyDataError`, `routineDepth`,
  the root grammars) stays internal: export it from the dialect's `index.ts`
  only on purpose. A new dialect gets its own directory, a subpath in
  `package.json` `exports` and `typesVersions`, and a check in
  `scripts/verify-packages.sh`.
- **New AST fields are optional and left out when absent**, so trees for input
  that doesn't use the construct stay byte-identical (see the README's AST
  conventions).
- **Never regenerate a golden to make a change pass.** `test/parity.*.golden.json`
  pin every corpus AST (spans included) and every `diagnose()` message, and
  `test/stringify.*.golden.sql` the printer's output. When
  output is meant to move, regenerate with `pnpm test -- -u` from the repo root
  and call the diff out.
- **Keep the README's lists in step with the battery.** A change that moves a
  `pg-coverage.ts` or `pg-dump-corpus.ts` row also updates the README tables and
  the "Not yet supported" / "Known wrong ASTs" / "Behaviour changes" lists.
