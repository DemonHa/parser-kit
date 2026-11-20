# @parser-kit/dbml

## 0.1.0

### Minor Changes

- [#103](https://github.com/DemonHa/parser-kit/pull/103) [`5e3d190`](https://github.com/DemonHa/parser-kit/commit/5e3d1905c9455526bba32bfd50dad347f9cdc249) Thanks [@DemonHa](https://github.com/DemonHa)! - First release of `@parser-kit/dbml`, a typed DBML parser built on `@parser-kit/core`. `dbml.parse(text)` parses a DBML document into a span-annotated `DbmlDocument` and throws a `ParseError` at the first error; `dbml.diagnose(text)` recovers at each settings list, body line and top-level element, and returns `{ ast, errors }` with every error it finds. It reads the DBML language as `@dbml/core` 12 does: `Project`, `Table` (schemas, aliases, settings, custom properties, column types and settings, notes), `Ref` in short, long and inline form with optional sides and composite endpoints, `Enum`, `indexes` and `checks`, `TableGroup`, sticky notes, `TablePartial` with `~partial` injection, and `records`. Keywords are case-insensitive and contextual, so they stay usable as names. `dbmlLexer` tokenizes DBML with comments kept, for highlighters, and every AST node type is exported. The package parses only: it doesn't resolve names, merge partials or validate. The README lists the deliberate differences from `@dbml/core` and what isn't supported yet (`DiagramView`, `Dep`, `Metadata`, `use` / `reuse`). Ships as dual ESM/CommonJS with type declarations, and depends only on `@parser-kit/core`.

### Patch Changes

- Updated dependencies [[`7ed2825`](https://github.com/DemonHa/parser-kit/commit/7ed2825629a1f8e19fcc3670a3945966d04c4dc8), [`2c0567b`](https://github.com/DemonHa/parser-kit/commit/2c0567b63b3b71d8ec31b8ca7e623c93a9ca46f1), [`87a9cbd`](https://github.com/DemonHa/parser-kit/commit/87a9cbd8e023c43d05ce29e33e7acc939eb3ce3c)]:
  - @parser-kit/core@0.3.0
