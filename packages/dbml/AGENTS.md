# AGENTS.md — @parser-kit/dbml

A typed DBML parser built on `@parser-kit/core`. The incumbent, and the de facto
spec, is [`@dbml/core`](https://www.npmjs.com/package/@dbml/core) 12.x (its
`dbmlv2` parser). The package entry is a `dbml` object with `parse` and
`diagnose`, plus the lexer (`dbmlLexer`, `DbmlTokenType`) for highlighters. It
is published to npm as `@parser-kit/dbml` (first release 0.1.0). See
`../core/AGENTS.md` for the kit's internals and grammar-authoring gotchas, and
`../sql` for the package this one mirrors.

## Layout

The layout below is where code goes; a new construct follows it.

- `src/` — the published code.
  - `index.ts` — the package entry.
  - `lexer.ts` — the lexer, the parse-stream wrapper (comments dropped,
    identifiers case-folded, and, for `diagnose`, line breaks restored after
    an unterminated string inside brackets), the raw-name lookup and the note
    dedent (`dedentNote`).
  - `grammar/` — one module per construct (`table.ts`, `column.ts`, `ref.ts`,
    `enum.ts`, `project.ts`, `note.ts`, `indexes.ts`, `group.ts`,
    `partial.ts`, `injection.ts`, `records.ts`), the shared rules in `common.ts` (names,
    strings, values, the settings framework, the `{ … }` body reader and
    `defineElement`), `recovery.ts` (what `diagnose` skips after an error, and
    which errors it drops as cascades), and two registries: `root.ts`
    (`ELEMENTS`, the top-level elements, plus the top-level loop and its
    recovery) and `table-items.ts`
    (`TABLE_ITEMS`, what may appear in a table body besides columns). Each
    module defines its AST types next to its rules; `src/ast.ts` only
    re-exports them. A new construct is a new module plus one line in a
    registry; a new setting is one line in its context's `SettingsSpec`
    (`COLUMN_SETTINGS`, `TABLE_SETTINGS`, …), plus a member of the `Setting`
    union in `common.ts` when it has a new `kind`.
- `test/` — vitest, one file per area (`table.test.ts`, `ref.test.ts`, …) so
  parallel changes add files instead of editing a shared one. `entry.test.ts`
  pins the public surface, and `readme.test.ts` runs the README's examples. The corpus (`corpus.ts`), the parity harness and its
  goldens (`parity.*.golden.json`) and the differential test against
  `@dbml/core` live here too.
- `bench/` — comparisons against `@dbml/core` (its full `Parser.parse`) and
  `@dbml/parse` (its lex + parse stage alone); `incumbent.ts` says what each
  one measures, `generate.ts` builds the large schemas. `bench-baseline.json`
  at the repo root keys on their file paths and group names.

Only `build/`, `src/` and the changelog are published (`files` in
`package.json`), plus the files npm always adds; CI's Package job
(`../../scripts/verify-packages.sh`) fails if tests, benches, goldens or
fixtures reach the tarball.

## Rules

- **The public API is `src/index.ts`.** `test/entry.test.ts` pins its exported
  values and the parameters of `dbml.parse` / `dbml.diagnose` (and their return
  types once the AST exists); any change to the exports updates it. Don't
  export grammar internals (rules, the raw-name lookup).
- **Add a changeset** (`@parser-kit/dbml`) for every user-visible change: new
  syntax, a moved AST shape or error message, a new export. The package is
  pre-1.0, so breaking changes are `minor` (see `../../CONTRIBUTING.md`).
- **Match `@dbml/core`'s syntax.** Accept what it accepts and reject what it
  rejects, syntactically. Where its docs and its implementation disagree,
  follow the implementation. Semantic checks (unknown tables, duplicates, empty
  tables, partial merging, colour validation) are not parse errors. Every
  intended difference goes in the differential test's allowlist with a
  reason, and in the README's "Differences from @dbml/core" list.
- **Keywords are case-insensitive and contextual, never reserved.** `Table`,
  `table` and `TABLE` are the same keyword, and a column, table, enum value or
  alias may still be named `note`, `ref`, `indexes`, `checks`, `records`,
  `table`, `enum`, `project`, `pk`, `null`, `default` or `as`. Every keyword gets
  a "keeps *word* usable as a name" test. Decide between a keyword and a name
  with token lookahead in a `custom()` rule, not with `attempt()`.
- **Newlines are tokens.** DBML is line-oriented, but newlines inside `[ … ]`
  and `( … )` are whitespace. Treat `\r` as whitespace so CRLF files parse.
- **AST shape.** Elements and items are discriminated by `type`, values and
  settings by `kind`. Every node carries a `span`; string and identifier spans
  include their quotes. Identifiers keep their raw case and a `quoted?: true`
  flag; the one exception is the key of a known `key: value` setting stored
  as a `property` (`headercolor`, a Ref's `color`, an index's `name` and
  `type`, a check's `name`), which is lowercased so it reads like the other
  known settings. Settings are an ordered list in source order, duplicates kept. Fields
  that existed when a node was introduced are always present (`null` or `[]`
  when absent); fields added later are optional and left out when absent, so
  existing trees stay byte-identical. Flags are `?: true`.
- **Numbers keep their source text unless it is a plain integer.** A number is
  `{ kind: "number", value, raw? }`. `raw` is the literal as written with any
  sign folded in (a space after the sign is dropped: `- 1.5` gives `-1.5`), and
  is present whenever that text is not exactly what
  `String(value)` gives back for an integer: any `.`, exponent, trailing zeros,
  leading zeros or a value outside the safe-integer range. `42` and `-7` have no
  `raw`; `1.50`, `1e5`, `-0.0` and `007` do. This matches `@parser-kit/sql`.
- **Strings are decoded.** `'…'` is single-line and processes escapes;
  `'''…'''` may span lines, processes escapes and carries `multiline: true`.
  Only note values are dedented, `'…'` and `'''…'''` alike, with the lexer's
  `dedentNote` (as `@dbml/core` does); an index's `note:` setting is the
  exception, and other strings, such as a `'''` default, keep their text as
  written. Double-quoted text where a string is expected (a note, a default, a
  property value) is a string too, as in `@dbml/core`, flagged
  `doubleQuoted: true`. Backtick expressions are kept raw.
- **Error recovery.** `diagnose` resynchronises at a settings list's next `,`
  or `]`, a body's next line and the next element that starts a line, and
  records errors through `report` in `recovery.ts`, never `ctx.report`
  directly, so cascades are dropped in one place. A body read with `readBody`
  and a list read with `readSettings` recover with no extra code; a header
  with a list before its `{` also passes on `openSwallowed` (see
  `readHeaderSettings`), for a `{` an unterminated string took with it. Look ahead
  with `lookAhead` / `peekPastNewlines`, not `ctx.peekAhead`, so a lexer error
  met in lookahead is recorded rather than losing the item. `parse` must still
  throw exactly `diagnose`'s first error; the parity harness checks it.
- **Error messages** use the core style, `Expected X but found Y`, with readable
  displays (`"Table"`, `a column type`, …). Error tests match `ParseError.msg`
  exactly, plus `start`.
- **Unit tests** compare `stripSpans(ast)` with `toEqual`, and assert spans on at
  least one multi-line document per construct. A change that adds a construct
  also adds realistic multi-line documents to `test/corpus.ts`.
- **Never regenerate a golden to make a change pass.** `test/parity.*.golden.json`
  pin every corpus AST (spans included) and every `diagnose()` message. When
  output is meant to move, regenerate with `pnpm test -- -u` from the repo root
  (a bare `-u` is swallowed by pnpm), rebase on the latest `main` first, and call
  the diff out in the PR. Biome ignores `*.golden.json`.
- **`@dbml/core` is only ever a test and bench dependency**, pinned to an exact
  version in the workspace catalog, and so is `@dbml/parse` (bench only), kept
  at the version `@dbml/core` depends on. Upgrading them is its own change that
  re-runs the differential test and updates the allowlist.
- **README.** `README.md` is the npm page. A change that adds syntax, moves
  the AST, changes recovery or adds a difference from `@dbml/core` updates it
  in the same change. `test/readme.test.ts` reads its code examples out of the
  README and runs them, and checks its prose claims with equivalent inputs, so
  keep the two in step.
- **Before pushing**, run `pnpm lint`, `pnpm types:check`, `pnpm test` and
  `pnpm build` from the repo root, plus `bash scripts/verify-packages.sh` when
  packaging changes.
