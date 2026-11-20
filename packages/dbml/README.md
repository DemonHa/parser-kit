# @parser-kit/dbml

[![npm](https://img.shields.io/npm/v/@parser-kit/dbml.svg)](https://www.npmjs.com/package/@parser-kit/dbml)

A fast, typed [DBML](https://dbml.dbdiagram.io/docs/) parser for JavaScript and TypeScript, built with [`@parser-kit/core`](https://www.npmjs.com/package/@parser-kit/core). It turns DBML into a span-annotated AST with exported TypeScript types, and can recover from errors for editor tooling.

- **The DBML language as [`@dbml/core`](https://www.npmjs.com/package/@dbml/core) 12 reads it:** `Project`, `Table`, `Ref`, `Enum`, indexes and checks, `TableGroup`, sticky notes, `TablePartial` and `records`. A differential test holds it to `@dbml/core` 12.1.0, and the few deliberate [differences](#differences-from-dbmlcore) are listed below.
- **Fast.** About 2× faster than `@dbml/parse`'s lex and parse stage, and 10–22× faster than `@dbml/core`'s `Parser.parse`, which also validates and builds a model. See [Benchmarks](#benchmarks).
- **Recovers from errors.** `dbml.diagnose` reports every error it finds and keeps the rest of the document: a bad setting, line or element is dropped, not the whole file.
- **Typed.** Every element, table item, setting and value is a discriminated union member (`Element`, `TableItem`, `Setting`, `Value`, …), exported for `switch (node.type)` or `switch (node.kind)`.
- **Small.** About 13 KB minified and gzipped, `@parser-kit/core` included, with no other dependencies.
- **Dual ESM / CommonJS**, with type declarations. Node 18 or later.

## Install

```sh
npm install @parser-kit/dbml
# or
pnpm add @parser-kit/dbml
```

`@parser-kit/core` comes along as a dependency. If you import from it directly (`ParseError` for an `instanceof` check, `stripSpans`), add it to your own dependencies too, in a range that matches the one `@parser-kit/dbml` declares, so both resolve to the same copy.

## Usage

| Export | What it is |
|---|---|
| `dbml.parse(text)` | Parses a DBML document into a `DbmlDocument`, or throws a `ParseError` at the first error |
| `dbml.diagnose(text)` | The same, but recovers: returns `{ ast: DbmlDocument, errors: ParseError[] }` |
| `dbmlLexer` | The lexer, comments included, for highlighters: a `Lexer<DbmlTokenType>` from `@parser-kit/core` |
| AST types | `DbmlDocument`, `Element`, `Table`, `Column`, `Ref`, `Setting`, `Value`, … (type-only exports) |

```ts
import { dbml } from "@parser-kit/dbml";

const doc = dbml.parse(`
Table users {
  id integer [pk, increment]
  email varchar(255) [unique, not null]
}

Table posts {
  id integer [pk]
  user_id integer [ref: > users.id]
  title text
}
`);

for (const element of doc.elements) {
  if (element.type === "table") console.log(element.name.name.value, element.items.length);
}
// users 2
// posts 3
```

`parse` throws a `ParseError` (exported by `@parser-kit/core`) at the first error. Its `msg` is the message, `start` and `end` are positions, and `message` adds the position:

```ts
dbml.parse("Table users {\n  id integer [pk, uniq]\n}");
// ParseError: Expected ":" but found "]" (2:22)
```

`diagnose` never throws. It returns everything it could read alongside every error, which is what an editor wants:

```ts
const { ast, errors } = dbml.diagnose(`
Table users {
  id integer [pk, uniq]
  email varchar [not null]
  name
}

Enum status {
  active
}
`);
// errors: Expected ":" but found "]" (3:22)
//         Expected a column type but found a new line (5:6)
// ast.elements: the users table (columns id and email) and the status enum
```

The methods don't use `this`, so `const { parse } = dbml` and `sources.map(dbml.parse)` work.

## Supported syntax

Everything below parses to its own node. Keywords are case-insensitive (`Table`, `table`, `TABLE`) and contextual, never reserved: a table, column, enum value or alias may be called `note`, `ref`, `table`, `indexes`, `records`, `pk`, `null` and so on.

- **Project:** `Project name { … }`, name optional, with one `key: 'string'` property (`database_type: 'PostgreSQL'`) or note per line, in both note forms.
- **Table:** a schema-qualified or quoted name (`Table s."order items"`), an alias (`as U`), settings (`[headercolor: #3498DB, note: '…']` plus custom properties, multi-word keys included), and a single-line body (`Table a { id int }`).
  - **Columns:** types with arguments (`varchar(255)`, `decimal(10, 2)`, `varchar(MAX)`), array suffixes (`int[]`, `int[3]`), quoted (`"double precision"`) and schema-qualified (`s.status`) types.
  - **Column settings:** `pk` / `primary key`, `null` / `not null`, `unique`, `increment`, `default:` (number, signed or with an exponent, string, backtick expression, `true` / `false` / `null`, enum value), `note:`, inline `ref:` (repeatable), `check:` (repeatable) and custom properties. A bare `pk` or `unique` may follow the type (`id int pk`). A settings list may span lines.
  - **Notes:** `Note: '…'` and `Note { '…' }`.
  - **Indexes:** `indexes { … }` with single, composite (`(a, b)`), expression (`` (`lower(email)`) ``) and mixed entries, several fields per line, a per-column `[asc]` / `[desc]`, and the settings `pk`, `unique`, `name`, `type` and `note`.
  - **Checks:** `` checks { `price >= 0` [name: 'positive_price'] } ``.
- **Ref:** short (`Ref name: a.b > c.d`), long (`Ref name { a.b > c.d }`) and inline (`[ref: > users.id]`) forms; the relations `<`, `>`, `-` and `<>` with optional sides (`>?`, `?<>?`, …); composite (`t.(a, b)`) and schema-qualified (`s.t.c`) endpoints; the settings `delete:` / `update:` (`cascade`, `restrict`, `set null`, `set default`, `no action`), `color:`, `inactive`, `note:` and custom properties.
- **Enum:** schema-qualified names, an alias (`enum v2.job_status as JobStatus`), quoted values and value notes (`"on hold" [note: '…']`).
- **TableGroup:** `TableGroup name [color: #hex, note: '…'] { … }`, custom settings included, with one member (`users`, `s.posts`) or `Note` per line.
- **Sticky notes:** `Note name [color: #hex] { '…' }` at the top level.
- **TablePartial and injection:** `TablePartial name [headercolor: #hex, note: '…'] { … }`, whose body takes columns, notes, indexes and checks, and `~name` inside a table. Injections are kept where they are written, not merged.
- **records:** top level (`records users(id, name) [example] { … }`) and inside a table (`records (id, name) { … }`, column list optional). One row per line, fields separated by commas; a field may be a string, a signed number, `true` / `false` / `null`, a backtick expression or an enum value (`status.active`), or empty (`1, , 3`).
- **Lexical:** `//` and `/* */` comments anywhere whitespace may go; `'…'` strings with escapes (`\'`, `\n`, `\t`, `\uHHHH`, line continuation, …); `'''…'''` multi-line strings; `"…"` quoted names; backtick expressions (raw, may span lines); colors (`#3498DB`); Unicode and digit-led names (`bảng`, `2fa_code`); CRLF line endings.

## The AST at a glance

`dbml.parse` returns a `DbmlDocument`: `{ type: "document", elements, span }`. Elements and table items are discriminated by `type`; values and settings by `kind`.

| Element `type` | Node | Main fields |
|---|---|---|
| `"project"` | `Project` | `name`, `items` (`ProjectProperty` and `Note`) |
| `"table"` | `Table` | `name` (`QualifiedName`), `alias`, `settings`, `items`: `Column`, `Note`, `Indexes`, `Checks`, `PartialInjection`, `Records` |
| `"ref"` | `Ref` | `name`, `form` (`"short"` / `"long"`), `left`, `relation`, `right`, `settings` |
| `"enum"` | `Enum` | `name`, `alias`, `values` |
| `"tableGroup"` | `TableGroup` | `name`, `settings`, `items` (members and `Note`) |
| `"stickyNote"` | `StickyNote` | `name`, `settings`, `value` |
| `"tablePartial"` | `TablePartial` | `name`, `settings`, `items` (`Column`, `Note`, `Indexes`, `Checks`) |
| `"records"` | `Records` | `table`, `columns`, `settings`, `rows` |

Inline refs are settings on their column (`{ kind: "ref", relation, target }`), not `Ref` elements. A column, with spans removed by `stripSpans` from `@parser-kit/core`:

```ts
import { stripSpans } from "@parser-kit/core";

const [table] = dbml.parse("Table t {\n  price decimal(10, 2) [default: 1.50, note: 'it\\'s']\n}").elements;
stripSpans(table.items[0]);
// {
//   type: "column",
//   name: { value: "price" },
//   dataType: {
//     name: { schema: null, name: { value: "decimal" } },
//     args: [{ kind: "number", value: 10 }, { kind: "number", value: 2 }],
//     arraySizes: [],
//   },
//   settings: [
//     { kind: "default", value: { kind: "number", value: 1.5, raw: "1.50" } },
//     { kind: "note", value: { kind: "string", value: "it's" } },
//   ],
// }
```

- **Spans.** Every element, item, name, value and setting has a `span: { start, end }`. Each end is a `{ row, col }`, with a 1-based `row` and a 0-based `col` (the `(2:22)` in error messages). String and quoted-name spans include their quotes. A span starts and ends at real tokens, so a comment after a node is outside it.
- **Names** keep their case as written. An `Ident` is `{ value, quoted?: true, span }`, and a quoted name is decoded (`"full name"` gives `{ value: "full name", quoted: true }`). A dotted name is a `QualifiedName`, `{ schema: Ident | null, name: Ident }`. A ref endpoint is `{ table: QualifiedName, columns: Ident[], composite }`: the last part is the column, the one before it the table and the one before that the schema.
- **Strings are decoded.** `'it\'s'` gives `"it's"`. A `'''…'''` string carries `multiline: true`, and double-quoted text where a string is expected (`[note: "x"]`) carries `doubleQuoted: true`. Note text is dedented the way `@dbml/core` does it (except an index's `note:`, which core keeps as written too); other strings keep their text as written. Backtick expressions are kept raw.
- **Numbers.** A number is `{ kind: "number", value }`, with any sign folded in. It also has `raw`, the text as written, whenever `value` alone would lose it: `1.50`, `1e5`, `007`, `-0`, or an integer beyond `Number.MAX_SAFE_INTEGER`. `42` and `-7` have no `raw`.
- **Settings** are an ordered list in source order, duplicates kept. Known flags and keys have their own `kind` (`pk`, `null`, `unique`, `default`, `note`, `ref`, `action`, `check`, …); other `key: value` settings, and known ones that only carry a value (`headercolor`, `color`, an index's `name` and `type`, a check's `name`), are `{ kind: "property", key, value }`.
- **Absent fields** are `null` or `[]` (`alias: null`, `args: null` without parentheses). Optional flags are `?: true`, present only when set (`quoted`, `multiline`, `leftOptional`, …); a few yes/no fields are plain booleans, always present (`not` on a `null` setting, `composite` on an endpoint).
- **Comments are not kept.** `dbmlLexer` still emits them as `comment` tokens.
- **Nothing is resolved.** This is a syntax tree: schemas are not defaulted, partials are not merged, and refs, enum types, group members and records targets are not checked against the tables they name.

## Error recovery

`dbml.diagnose` resynchronises at three levels, innermost first:

| Where the error is | What is dropped | Where reading resumes |
|---|---|---|
| A settings list `[…]`, or a records column list `(…)` | the setting | the list's next `,` or `]` |
| A `{ … }` body: table, partial, project, enum, group, indexes, checks, records rows | the line | the next line, or the body's `}` |
| The top level | the element | the next element keyword that starts a line, outside braces |

Junk after a complete item (`id int pk junk`) keeps the item and reports the junk once. Errors come out in source order, and an error that is a consequence of an earlier one (an unclosed list at the end of input, closers swallowed by an unterminated string) is reported once, not again for every body around it. `diagnose` costs about what `parse` does.

`dbml.parse` still throws at the first error, and it is always the error `diagnose` reports first.

Recovery is a best effort. Some errors take more with them than you might expect: a missing `}` makes the elements after it read as lines of that body, and a list left open (`[` or `(` with no closer) runs until the next brace, because line breaks don't end a list.

## Differences from @dbml/core

`@parser-kit/dbml` follows `@dbml/core` 12.1.0's `dbmlv2` parser, not its docs, where the two disagree. Its differential test runs the whole corpus, the malformed inputs and about 830 generated mutants through both parsers. These are the deliberate differences, all syntactic edge cases:

**Semantic checks are not done.** `@dbml/core` validates after parsing; this package doesn't, so it accepts documents core rejects for duplicate names or settings (`[unique, unique]`), unknown tables or columns in refs, empty tables, records whose field count differs from the column list, colors that aren't 3- or 6-digit hex (`#3a5x`), and so on. Partials are not merged.

**Rejected here, accepted by `@dbml/core`'s parser:**

- More than two parts in a table, enum, sticky-note, group-member or records-target name (`Table a.b.c`), more than three in a ref endpoint, or more than three in a records field's enum value (`s.e.v.w`). Core's parser reads these as a nested schema.
- A single-part inline ref target (`[ref: > id]`).
- Repeated signs (`--1`, `- -1`) in a default or a records field.
- Chained type suffixes (`int(1)(2)`, `int[](1)`) and comma-separated array sizes (`int[1,2]`).
- YAML front matter (`---` … `---`).
- An empty Ref or Note body, and an empty composite after a schema (`s.a.()`). Core rejects these too, but only in its validator.
- A glued comment or a CRLF line break between a field and a later-line `[`: an index sort order (`id// c⏎[desc]`, `id\r\n[desc]`) or a column type's array suffix (`text// c⏎[]`), and a glued block comment before `[` (`text/* c */[3]`, `id/* c */[desc]`).

**Accepted here, rejected by `@dbml/core`:**

- A comment as the only separator between glued tokens (`id/**/int`, `(id)/* c */[unique]`), and a `\r` before a header's settings list (`Table a\r\n[note: 'x']`). This package drops comments and `\r` before parsing.
- `(id)// c⏎[unique]`: a later-line `[` after a glued line comment starts a new index entry.
- An element keyword as a Project property key (`table: 'x'`).

**Read differently:** `text/* c */[]` is the type `text` and an empty settings list here, and the array type `text[]` in core.

**Model details:** an empty note is `""` here (core: `null`), and index fields keep their source order.

## Not yet supported

- `DiagramView`, `Dep` (lineage), `Metadata`, and the multi-file `use` / `reuse` imports. They are errors today.
- Architecture files (front matter with `diagram_type: arch`).
- A semantic pass: schema defaulting, partial merging, and resolving and validating names (what `@dbml/core` reports as validation errors).
- Printing an AST back to DBML.
- Keeping comments in the AST.

## Benchmarks

Measured with vitest bench against `@dbml/core` 12.1.0 and `@dbml/parse` 12.1.0, on Node 22 in a shared cloud container; each range is three runs. Absolute numbers moved by up to a third between runs (the committed `bench-baseline.json` is one of the slower ones), so trust the ratios.

| Input | `@parser-kit/dbml` | vs `@dbml/parse` (lex + parse) | vs `@dbml/core` `Parser.parse` (full) |
|---|---|---|---|
| Whole corpus (107 documents, 23.1 KB) | 163–205 ops/s | 1.9–2.1× faster | 18–22× faster |
| Six realistic schemas (10.7 KB) | 442–482 ops/s | 1.8–2.4× faster | 14–16× faster |
| Generated, 1,035 lines (23 KB) | 5.6 ms | 2.0–2.5× faster | 10–13× faster |
| Generated, 5,052 lines (115 KB) | 24.9 ms | 2.0–2.1× faster | 12–14× faster |
| Generated, 20,090 lines (463 KB) | 104 ms | 1.9–2.2× faster | 15–17× faster |

- **Like for like** is the `@dbml/parse` column: its compiler's lex and parse stage, which builds a syntax tree and collects syntax errors but doesn't validate or bind. The bench skips that stage's front-matter re-lex, which a real `@dbml/core` call pays, so the ratio there is conservative (about 1.3–1.6× larger without the skip).
- **`Parser.parse`** is what a `@dbml/core` user calls. It also validates, binds and builds its model, so it is not like for like; it is shown for scale.
- **Cost per KB** is about 200–265 µs in the runs above, flat from 23 KB to 463 KB. A separate run that kept doubling the generated schema found it flat up to 1.86 MB, and a single string or backtick expression linear up to 2 MB (the committed bench stops at 463 KB and 500 KB).
- **`diagnose`** costs what `parse` costs on valid input, and is about 2× faster than `@dbml/parse`'s recovering parse stage on input with errors.

From a clone of the repository root: `pnpm vitest bench --run packages/dbml/bench`.

## Contributing

Run everything from the repository root (`pnpm test`, `pnpm types:check`, `pnpm lint`). The repo-wide workflow is in [CONTRIBUTING.md](https://github.com/DemonHa/parser-kit/blob/main/CONTRIBUTING.md), and the package's layout and rules are in [`AGENTS.md`](https://github.com/DemonHa/parser-kit/blob/main/packages/dbml/AGENTS.md).

## License

MIT
