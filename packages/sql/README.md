# @parser-kit/sql

[![npm](https://img.shields.io/npm/v/@parser-kit/sql.svg)](https://www.npmjs.com/package/@parser-kit/sql)

A fast, typed SQL parser for JavaScript and TypeScript, built with [`@parser-kit/core`](https://www.npmjs.com/package/@parser-kit/core). Its first dialect is **PostgreSQL 17**; more dialects are planned. It turns SQL into a span-annotated AST with exported TypeScript types, reads whole psql and pg_dump scripts, and can recover from errors for editor tooling.

- **Nearly all of PostgreSQL 17.** It accepts 604 of the 609 statements in the [coverage battery](#compared-with-node-sql-parser) (node-sql-parser: 235), and every statement in the [pg_dump corpus](#pg_dump-corpus). See [PostgreSQL coverage](#postgresql-coverage) for what is still missing.
- **Fast.** 2–5.5× faster than [`node-sql-parser`](https://www.npmjs.com/package/node-sql-parser) on most [benchmarks](#benchmarks) (about even on a bulk `INSERT`), measured only on input both parsers accept.
- **Typed.** Every node is a discriminated union member (`Stmt`, `Query`, `Expr`, …), exported for `switch (node.kind)`.
- **Dual ESM / CommonJS**, with type declarations. Node 18 or later.

## Install

```sh
npm install @parser-kit/sql
# or
pnpm add @parser-kit/sql
```

`@parser-kit/core` comes along as a dependency. If you import from it directly (`ParseError` for an `instanceof` check, `stripSpans`), add it to your own dependencies too, in a range that matches the one `@parser-kit/sql` declares, so both resolve to the same copy.

## Usage (PostgreSQL dialect)

The PostgreSQL entry points are `sqlLite` (SQL as the server receives it) and `sqlLiteScript` (whole psql scripts). Both have `parse` and `diagnose`.

```ts
import { sqlLite } from "@parser-kit/sql";

const ast = sqlLite.parse("SELECT id, count(DISTINCT tag) FROM posts WHERE created_at > now() - interval '7 days' GROUP BY id");
// → Stmt[]: one node per statement, statements and expressions carrying a { start, end } span
```

The root is a list of statements. `;` separates them, and the last one may leave it out. Empty statements (`;;`, a leading `;`, input that is only comments) produce no node, and `SELECT 1 SELECT 2` is still an error. Unquoted identifiers fold ASCII letters to lower case, as PostgreSQL does, and quoted ones keep their case. Keywords PostgreSQL treats as unreserved (`type`, `role`, `comment`, `data`, `rows`, …) stay usable as names. Comments (`--` and nested `/* */`) are allowed anywhere whitespace is, and they are not kept in the AST. The node types are exported from the package (`Stmt`, `Query`, `Expr`, `ScriptItem`, …), as are the lexers and the token type `SqlTokenType`.

`parse` throws a `ParseError` (exported by `@parser-kit/core`) at the first problem:

```ts
sqlLite.parse("SELECT id FROM users WHERE;");
// Parse Error: Expected a number or a string or … or "(" or a name but found ";" (1:26)
```

`diagnose` recovers at each `;` instead. It returns everything it could parse alongside every error, which is the mode editor tooling wants:

```ts
const { ast, errors } = sqlLite.diagnose("SELECT 1;\nSELECT FROM WHERE;\nDELETE FROM t WHERE id = 1;");
// ast: the SELECT and the DELETE
// errors: [Expected a name but found "where" (2:12)]
```

### Whole psql scripts

`sqlLite` parses SQL the way the PostgreSQL server receives it, so a psql meta-command (`\connect db`) or the rows after `COPY … FROM stdin` are errors there, as they are for the server. `sqlLiteScript` has the same `parse` and `diagnose` and reads a whole file the way psql runs it. That includes pg_dump and pg_dumpall output:

```ts
import { sqlLiteScript } from "@parser-kit/sql";

sqlLiteScript.parse("\\connect app\nCOPY t (a, b) FROM stdin;\n1\tx\n2\ty\n\\.\nSELECT 1;\n");
// → ScriptItem[]:
//   { kind: "psqlMeta", command: "connect", args: "app" }
//   { kind: "copy", …, data: "1\tx\n2\ty\n" }
//   { kind: "select", … }
```

The statements are read by the same rules as `sqlLite`'s, so a script differs from plain SQL only in what sits between statements. `diagnose` also resumes at a meta-command line: a statement left unfinished before one is reported as an error, and the meta-command and what follows it are kept.

## AST conventions

- **Spans.** Statements, expressions, column definitions and constraints have a `span: { start, end }`. Structural parts such as select items, FROM items, CTE entries, `ORDER BY` items, locking clauses and assignments don't. Each end is a `{ row, col }`, with a 1-based `row` and a 0-based `col` (the `(1:26)` in error messages). A span starts and ends at real tokens, so a comment after a node is outside its span. `stripSpans` from `@parser-kit/core` removes them recursively, and the unit tests compare span-stripped trees.
- **Absent fields.** The fields of the original node shapes are always present, with `null` (or `false`) when the clause isn't written: `alias: null`, `where: null`, `ifExists: false`. Fields added since are optional, and they are **left out** when the clause is absent, never `null`. A flag typed `?: true` (`natural?: true` on a join, `withTies?: true` beside `limit`, `only?: true` on a target, `notValid?: true` on a constraint, `variadic?: true` on a call) is either `true` or missing. A `?: boolean` field is present only when the clause is written, and is `false` when its negative spelling is (`NOT MATERIALIZED`, `NOT DEFERRABLE`, `NO INDENT`, `ASYMMETRIC`). Test such a field with `in` or `=== true`/`=== false`, not by comparing to `null`.
- **Names.** A dotted name is a `string[]` with one element per part, folded to lower case unless quoted: `pg_catalog.int4` gives `["pg_catalog", "int4"]` and `"MySchema".f` gives `["MySchema", "f"]`. A quoted part that holds a dot stays one element, so `"a.b"(1)` (one function named `a.b`) gives `name: ["a.b"]` while `a.b(1)` (function `b` in schema `a`) gives `["a", "b"]`. This holds for every name: tables, columns (`{ kind: "name", parts }`), calls, type names (`ColType.name`, including a cast's and a typed literal's type), `RANGE` type option values, and configuration parameters in `SET`, `SHOW`, `RESET`, a routine's `SET`, and `ALTER ROLE` / `ALTER DATABASE … SET | RESET`. A multi-word keyword spelling is a single element: `x::double precision` gives `["double precision"]`, `timestamp(3) with time zone` gives `name: ["timestamp with time zone"], args: [3]`, and `SHOW TIME ZONE` gives `name: ["time zone"]`. A quoted type name that spells one of these (`x::"double precision"`) carries `quoted: true`, as `"char"` and `"int"` do.
- **Implicit values.** A value PostgreSQL supplies for a left-out clause part is a node marked `implicit: true`, so it can be told from a written one. The only one is the count of 1 in a count-less `FETCH FIRST ROW ONLY` / `FETCH NEXT ROWS WITH TIES`: `{ kind: "number", value: 1, implicit: true }`. PostgreSQL gives that constant no location, so its span is the `ROW` / `ROWS` word, the real token standing where the count would be written. A written count, `FETCH FIRST 1 ROW ONLY` included, has no `implicit` key.
- **Numbers.** A number is `{ kind: "number", value: number }`. It also gets a `raw?: string` holding the literal's text (`_` separators dropped, and the sign included where the grammar folds one in) when `value` alone loses something PostgreSQL reads from that text:
  - **Type and scale.** Every decimal literal except the plain digits `String(value)` gives back has `raw`. That covers every literal with a `.` or an exponent, which PostgreSQL types `numeric` rather than `integer` (`1/2` is `0` but `1.0/2` is `0.5`) and whose scale it keeps (`1.50`). So `1.0` gives `{ value: 1, raw: "1.0" }`, `5.` gives `{ value: 5, raw: "5." }`, `1e2` gives `{ value: 100, raw: "1e2" }`. Any other spelling `String(value)` doesn't give back keeps its text too, though PostgreSQL types it `integer`: `007` gives `{ value: 7, raw: "007" }`.
  - **Precision.** A value whose magnitude is 2^53 or more (`9007199254740993`, `1e16`, `0xFFFFFFFFFFFFFFFF`), where a double may not hold every digit, has `raw`, as does one that overflows to ±Infinity (`1e400`, which JSON would write as `null`).

  A plain decimal integer or a `0x` / `0o` / `0b` integer, either below 2^53 (`42`, `1_000`, `0x1F`), has no `raw`. `value` keeps double precision only: `0.1000000000000000055511151231257827` rounds, and `1e-400` reads as `0` (both keep their text in `raw`).
- **Comments** are dropped from the token stream the grammar sees (`sqlParseLexer`). The exported `sqlLexer` still emits `comment` tokens, for highlighters and formatters that tokenize directly.
- **Strings** are decoded. `E'\x41'`, `U&'\0041'` and `'A'` all give `{ kind: "string", value: "A" }`, and `'foo'` + newline + `'bar'` gives `"foobar"`. `N'…'` is a `typedLiteral` of type `bpchar`, as PostgreSQL reads it.
- **Script items.** `sqlLiteScript` returns `ScriptItem[]` (`Stmt | PsqlMeta`) in source order:
  - A meta-command line is `{ kind: "psqlMeta", command, args }`. `command` is the name without its backslash, up to whitespace or another backslash, as psql reads it (`connect`, `restrict`, `.`, `dt+`). `args` is the rest of the line, trimmed and unparsed. psql's own argument syntax (quoting, `:var`, backticks) is not modelled.
  - A `COPY … FROM STDIN` whose rows follow it gets `data?: string`: the lines up to the `\.` terminator, verbatim and undecoded, newlines included and the terminator excluded. The copy node's span stays the statement's own. `sqlLite` never sets `data`.
- **Lists still open at end of input fail.** Because the last `;` is optional, the grammar turns on core's `strictDelimited` option. A `(…)` list that reaches end of input fails with `Expected ")" but found end of input` instead of closing there, so `INSERT INTO t VALUES (1` is an error, not a complete statement.
- **Where a WITH lands.** A `WITH` written over a set operation whose first arm has its own `WITH` goes on the `setOp` node. Every other `WITH` goes on the leftmost `SELECT` (or `VALUES` / `TABLE`) arm, as before.
- **Set-operation tails.** An `ORDER BY` / `LIMIT` / `OFFSET` / locking tail written after a set operation or a parenthesised query applies to the whole query. On a set operation it sits on the `setOp` node as optional fields, and the arms carry no tail.

## Repository layout

The package lives at [`packages/sql`](https://github.com/DemonHa/parser-kit/tree/main/packages/sql) in the parser-kit repo. Only `src/` and its build output are published. The tests, corpora, fixtures and benchmarks stay in the repo.

| File | What it is |
|---|---|
| `src/lexer.ts` | Tokens: identifier folding (ASCII only, non-ASCII letters allowed), quoted and `U&"…"` identifiers, `'…'` / `E'…'` / `$tag$…$tag$` / `B'…'` / `X'…'` / `U&'…'` / `N'…'` strings with every escape PostgreSQL decodes, PostgreSQL numbers (`1e5`, `.5`, `5.`, `0xff`, `0o17`, `0b101`, `1_000`, with PostgreSQL 15+'s rejection of `123abc`), `$1` parameters, comments, and the operator reader. `sqlLexer` emits `comment` tokens. `sqlParseLexer`, which the grammar uses, drops them. `sqlScriptLexer` / `sqlScriptParseLexer` add psql meta-command lines and COPY data blocks |
| `src/grammar.ts` | The grammar: the AST types, the reserved-word set, the expression Pratt table, one rule per statement, and the `sqlLite` / `sqlLiteScript` entry points |
| `src/index.ts` | The package entry: re-exports both |
| `test/sql-lite.test.ts` | Unit tests, one `describe` per feature |
| `test/entry.test.ts` | Pins the package entry's exports |
| `test/psql-split.ts` | A test helper that splits a dump file into statements the way psql does |
| `test/corpus.ts` | The statements the benchmark measures and the parity golden pins |
| `test/parity.test.ts` + `test/parity.*.golden.json` | Byte-exact AST (spans included) and `diagnose()` output for the corpus plus a supplemental list |
| `test/pg-coverage.ts` + `test/pg-coverage.test.ts` | The PostgreSQL coverage battery: 609 statements with the bucket each one lands in |
| `test/pg-dump-corpus.ts` + `test/pg-dump-corpus.test.ts` | The pg_dump corpus: whether each statement of the dumps in `test/fixtures/pg-dump/` parses, and whether each file parses whole through `sqlLiteScript` |
| `bench/sql-lite.bench.ts` | Throughput over the corpus, per category |
| `bench/sql-lite.large.bench.ts` | Throughput on 64 KB / 256 KB / 1 MB multi-statement files, and on the pagila schema dump |
| `bench/sql-lite.workloads.bench.ts` | Throughput on real-world workloads |

## PostgreSQL coverage

### What's supported

The target is PostgreSQL 17's `gram.y`. The lists below are grouped the way the coverage battery is.

**Queries**

- `SELECT` with `DISTINCT [ON]`, the empty select list (`SELECT;`, `SELECT FROM t`), `SELECT INTO`, `TABLE name`, standalone `VALUES`.
- Every join type. `NATURAL` is recorded. Also `USING (…) [AS alias]`, `LATERAL`, and parenthesised and right-nested joins (`a JOIN b JOIN c ON p ON q`).
- Subqueries and derived tables, including `(VALUES …)`, `(TABLE …)` and parenthesised set operations as expression subqueries.
- `ONLY` and the inheritance `*`, alias column lists, column definition lists for record-returning functions (`f() AS x(a int)`), `TABLESAMPLE … REPEATABLE`, `ROWS FROM (…)` and `WITH ORDINALITY`.
- `GROUP BY [DISTINCT | ALL]` with `ROLLUP` / `CUBE` / `GROUPING SETS` and `()`, `HAVING`, `WINDOW`, `ORDER BY … USING op` and `NULLS FIRST | LAST`.
- `LIMIT` / `OFFSET` / `FETCH {FIRST | NEXT} … {ROWS ONLY | WITH TIES}`, with `withTies` recorded. A count-less `FETCH FIRST ROW ONLY` gets the count of 1 PostgreSQL reads, marked `implicit` (see [AST conventions](#ast-conventions)).
- Every locking clause (`FOR [NO KEY] UPDATE`, `FOR [KEY] SHARE`, `OF`, `NOWAIT`, `SKIP LOCKED`, `FOR READ ONLY`), before or after the limit.
- `UNION` / `INTERSECT` / `EXCEPT [ALL | DISTINCT]` with PostgreSQL's precedence (`INTERSECT` binds tighter).
- CTEs can be `RECURSIVE`, `[NOT] MATERIALIZED`, use `SEARCH` and `CYCLE`, and be data-modifying. A `WITH` may lead any DML statement.

**Expressions**

- PostgreSQL's operator precedence table, unary minus and `AT TIME ZONE` / `COLLATE` included (`-2 ^ 2` is `(-2) ^ 2`).
- Any operator, not just a fixed table (`&&`, `<->`, `-|-`, `~~`, `^@`, `^-`, …). Also prefix operators (`|/`, `||/`, `@`, `~`, …) and `OPERATOR(schema.op)`.
- `LIKE` / `ILIKE` / `SIMILAR TO` with `ESCAPE`, regex operators, `ANY` / `SOME` / `ALL` after any operator (`LIKE ANY (…)`, `x ~ ALL (…)`), `IN`, `EXISTS`, `BETWEEN [SYMMETRIC]`, `OVERLAPS`.
- `IS [NOT] DISTINCT FROM`, `IS [NOT] NULL / TRUE / FALSE / UNKNOWN`, postfix `ISNULL` / `NOTNULL`, `IS [NOT] [NFC | NFD | NFKC | NFKD] NORMALIZED`, `IS [NOT] DOCUMENT`, `IS JSON [VALUE | OBJECT | ARRAY | SCALAR] [WITH | WITHOUT UNIQUE [KEYS]]`.
- `AT TIME ZONE`, PostgreSQL 17's `AT LOCAL`, `COLLATE`.
- JSON and jsonpath operators (`->`, `->>`, `#>`, `#>>`, `@>`, `<@`, `?`, `?|`, `?&`, `@?`, `@@`, `#-`).
- `::` casts and `CAST`, `CASE`, `ROW(…)` and implicit rows, `ARRAY[…]` (nested `ARRAY[[…], […]]` included), `ARRAY(subquery)`, subscripts and slices, field selection (`(row).field`, `(f()).*`).
- Special-syntax functions: `EXTRACT`, `POSITION`, `SUBSTRING … FROM … FOR` and `SUBSTRING … SIMILAR … ESCAPE`, `TRIM`, `OVERLAY`, `NORMALIZE(x, NFC)`, `COLLATION FOR (x)`. Also the niladic `CURRENT_DATE` / `CURRENT_TIMESTAMP(p)` / `LOCALTIME` / `CURRENT_USER` family.
- Call arguments: `=>` and `:=` named arguments, `VARIADIC`. Aggregate modifiers: `DISTINCT`, `ALL`, `ORDER BY` inside the call, `FILTER (WHERE …)`, `WITHIN GROUP`. `OVER` with `ROWS` / `RANGE` / `GROUPS` frames and `EXCLUDE`.

**Types and lexical**

- Multi-word types (`double precision`, `character varying(n)`, `timestamp(p) with time zone`, `bit varying`, `interval day to second(p)`), array types including the `int ARRAY` / `int ARRAY[n]` spelling, schema-qualified and quoted types, `SETOF`.
- Typed literals for any type name: `DATE '…'`, `jsonb '{}'`, `timestamptz '…'`, `int4 '42'`, `s.t '…'`, `INTERVAL '…' HOUR TO MINUTE`, `INTERVAL(3) '…'`, `INTERVAL '…' SECOND(3)`.
- Strings: `E'…'` with every PostgreSQL escape, dollar quotes, bit / hex / `U&'…'` strings with `UESCAPE`, `N'…'`, and string constants continued across a line break. `U&"…"` identifiers. Non-ASCII unquoted identifiers.
- Numbers: decimal, hex, octal and binary integers, `_` separators, trailing-dot and exponent forms. Exact text is kept for values a double can't hold (see [AST conventions](#ast-conventions)).

**DML**

- `INSERT` with `DEFAULT VALUES`, `DEFAULT` row items, `OVERRIDING`, a target alias, subscript and field targets (`INSERT INTO t (a[1], b.f)`), and `RETURNING`.
- `ON CONFLICT` with column, expression, `COLLATE` and operator-class targets and a partial-index `WHERE`, or `ON CONSTRAINT`, then `DO NOTHING` / `DO UPDATE … WHERE`.
- `UPDATE … FROM` with multi-column `(a, b) = (…)` / `= (SELECT …)` assignments, subscript and field targets (`SET a[1] = …`, `SET c.f = …`), and `SET col = DEFAULT` (also in `ON CONFLICT DO UPDATE` and `MERGE … UPDATE SET`).
- `DELETE … USING`. `UPDATE` / `DELETE` with `WHERE CURRENT OF cursor`. `UPDATE`, `DELETE` and `TRUNCATE` take `ONLY` / `name *` targets.
- `MERGE` with every `WHEN [NOT] MATCHED [BY SOURCE | TARGET]` form, plus `RETURNING`.
- `COPY` to and from a file, `STDIN` / `STDOUT` or a `PROGRAM`, with a parenthesised option list, the pre-9.0 bare-word options (`CSV HEADER`, `DELIMITER ','`, `BINARY`, `FORCE QUOTE *`, …), and `WHERE`.
- `TRUNCATE` with `RESTART | CONTINUE IDENTITY` and `CASCADE | RESTRICT`.

**Transactions and session**

- `BEGIN` / `START TRANSACTION` with isolation modes, `COMMIT` / `ROLLBACK` / `END` / `ABORT` with `AND [NO] CHAIN`, savepoints, two-phase commit (`PREPARE TRANSACTION`, `COMMIT PREPARED`, `ROLLBACK PREPARED`).
- `SET` / `SHOW` / `RESET`, including `SET TRANSACTION`, `SET SESSION CHARACTERISTICS`, `SET CONSTRAINTS`, `SET [LOCAL] TIME ZONE`, `SET SESSION AUTHORIZATION`, `SET … FROM CURRENT` and the multi-word `SHOW` / `RESET` targets. Each `SET` value is a simple token, as in PostgreSQL (`on`, a word, a string or a number), not an expression. A comma list (`SET search_path = a, b`) works.
- `PREPARE` / `EXECUTE` / `DEALLOCATE`, cursors (`DECLARE` / `FETCH` / `MOVE` / `CLOSE`), `LISTEN` / `NOTIFY` / `UNLISTEN`, `DISCARD`, `LOAD`, `LOCK`, `CALL`, `DO`.

**Utility and maintenance**

- `EXPLAIN` (option list and legacy forms), `ANALYZE`, `VACUUM`, `CLUSTER` and `REINDEX` (all PostgreSQL 17 forms), `CHECKPOINT`, `REFRESH MATERIALIZED VIEW`.

**Tables and indexes**

- **`CREATE TABLE`:**
  - column and table constraints, named column constraints included;
  - `NOT VALID`, `NO INHERIT`, and `DEFERRABLE` / `INITIALLY`;
  - PK / `UNIQUE` with `INCLUDE`, `WITH` and `USING INDEX TABLESPACE`, and `UNIQUE NULLS [NOT] DISTINCT`;
  - foreign-key actions (including `ON DELETE SET NULL (cols)`) and `MATCH`, and `EXCLUDE`;
  - `DEFAULT` as PostgreSQL's restricted expression, so `DEFAULT nextval('s') NOT NULL` works;
  - identity columns and stored generated columns (PostgreSQL 18's `VIRTUAL` is accepted too; see [below](#accepted-but-postgresql-rejects));
  - column `COLLATE`, `STORAGE` and `COMPRESSION`;
  - `LIKE … INCLUDING`, `INHERITS`, typed tables (`OF type`);
  - range / list / hash partitioning and `PARTITION OF … FOR VALUES`;
  - `USING method`, `WITH (…)`, `WITHOUT OIDS`, `TABLESPACE`, `ON COMMIT`, `TEMP` / `UNLOGGED`;
  - `AS SELECT` / `AS TABLE` / `AS EXECUTE … WITH [NO] DATA`.
- **`ALTER TABLE [IF EXISTS] [ONLY] name [*]`**, with action lists that:
  - add and drop columns (`DROP COLUMN IF EXISTS … CASCADE`) and constraints (`ADD CONSTRAINT … NOT VALID`, `VALIDATE`, `ALTER CONSTRAINT`);
  - change a column's type (`TYPE … COLLATE … USING`), default and not-null, and drop an expression;
  - run identity sub-commands (`ADD GENERATED … AS IDENTITY (SEQUENCE NAME …)`, `SET GENERATED`, `RESTART`, `DROP IDENTITY`);
  - set column statistics, storage, compression and `(…)` options;
  - rename, `SET SCHEMA`, `OWNER TO`, `SET TABLESPACE`, `SET ACCESS METHOD`, `SET LOGGED | UNLOGGED`, `[NO] INHERIT`, `OF` / `NOT OF`;
  - manage triggers, rules and row-level security (`ENABLE | DISABLE | FORCE | NO FORCE`);
  - `ATTACH` / `DETACH PARTITION`, storage parameters, `REPLICA IDENTITY`, `CLUSTER ON`, foreign-table `OPTIONS (…)`.
  - `ALTER TABLE ALL IN TABLESPACE` is supported too.
- **Indexes:** `CREATE INDEX` with `CONCURRENTLY`, `ON ONLY`, `USING`, opclasses, `INCLUDE`, `NULLS [NOT] DISTINCT`, `WITH`, `TABLESPACE` and partial `WHERE`. `ALTER INDEX` with rename, `SET` / `RESET`, `SET TABLESPACE`, `ALTER COLUMN … SET STATISTICS` and `ATTACH PARTITION`.

**Other schema objects**

- Views: `CREATE [OR REPLACE] [TEMP] [RECURSIVE] VIEW`, materialized views (`UNLOGGED`, `USING`, `TABLESPACE`, `WITH [NO] DATA`), and `ALTER` on both (rename, `SET SCHEMA`, `OWNER TO`, `SET` / `RESET (…)`). A view also takes `ALTER [COLUMN] … SET | DROP DEFAULT`. A materialized view also takes the table actions PostgreSQL allows on one: `SET TABLESPACE`, `CLUSTER ON`, `SET WITHOUT CLUSTER`, `SET ACCESS METHOD`, `REPLICA IDENTITY`, and `ALTER [COLUMN] … SET STATISTICS | STORAGE | COMPRESSION` and `SET | RESET (…)`.
- Sequences, domains, schemas (with schema elements), databases, extensions and tablespaces: `CREATE`, `ALTER` and `DROP`. `ALTER SEQUENCE` takes `SET LOGGED | UNLOGGED` too. `ALTER EXTENSION` covers `ADD` / `DROP` member, `SET SCHEMA` and `UPDATE`.
- Types: enum, composite (with a per-attribute `COLLATE`), range, base (`CREATE TYPE t (INPUT = …)`) and shell (`CREATE TYPE t`). `ALTER TYPE` supports `ADD VALUE`, `RENAME VALUE`, `RENAME`, `OWNER TO` and `SET SCHEMA`.
- Routines: functions, procedures and aggregates, with SQL-standard bodies (`RETURN expr`, `BEGIN ATOMIC … END`). Also triggers, including `CREATE CONSTRAINT TRIGGER`, `REFERENCING OLD | NEW TABLE` and `WHEN`.
- Policies, publications and subscriptions: `CREATE`, `ALTER` and `DROP`.
- The long tail: `CAST`, `COLLATION`, `CONVERSION`, `STATISTICS`, `EVENT TRIGGER`, `LANGUAGE`, `ACCESS METHOD`, `TEXT SEARCH {PARSER | DICTIONARY | TEMPLATE | CONFIGURATION}`, and `OPERATOR [CLASS | FAMILY]` (`CREATE` and `DROP`). Generic `ALTER … RENAME TO | OWNER TO | SET SCHEMA` covers those kinds, plus procedures, routines, rules, triggers and large objects, as far as PostgreSQL allows each.
- `COMMENT ON` every object kind, and `SECURITY LABEL [FOR provider] ON` the kinds PostgreSQL labels.
- `DROP` for every object kind above except `RULE` and `TRANSFORM`. `DROP ROUTINE` takes signatures as `DROP FUNCTION` / `PROCEDURE` do.

**Roles and privileges**

- `CREATE` / `ALTER` / `DROP ROLE` and `USER`, and `CREATE` / `DROP GROUP`. `ALTER ROLE` covers options, `RENAME` and `[IN DATABASE] SET` / `RESET`.
- `GRANT` / `REVOKE` on every object kind, routines with argument lists included (`ON FUNCTION f(int)`), `ALL … IN SCHEMA`, column privileges, `GRANTED BY`, and role membership with `WITH ADMIN | INHERIT | SET`.
- `ALTER DEFAULT PRIVILEGES`, `DROP OWNED`, `REASSIGN OWNED`.

**SQL/JSON**

- Constructors: `JSON_OBJECT(k VALUE v | k : v, … [{NULL | ABSENT} ON NULL] [{WITH | WITHOUT} UNIQUE [KEYS]] [RETURNING t [FORMAT JSON [ENCODING e]]])`, `JSON_ARRAY(v [FORMAT JSON], …)` and its query form `JSON_ARRAY(SELECT …)`.
- Aggregates: `JSON_OBJECTAGG(k VALUE v …)` and `JSON_ARRAYAGG(v [ORDER BY …] …)`, with `FILTER` and `OVER`.
- Query functions: `JSON_VALUE`, `JSON_QUERY` and `JSON_EXISTS`, with `PASSING`, `RETURNING`, the wrapper and `QUOTES` clauses, and `ON EMPTY` / `ON ERROR`, each taking only the clauses PostgreSQL gives it.
- `JSON_TABLE` as a FROM item, with `FOR ORDINALITY`, regular, `EXISTS` and `NESTED [PATH] … COLUMNS (…)` columns.
- `JSON(v [WITH | WITHOUT UNIQUE [KEYS]])`, `JSON_SCALAR(x)` and `JSON_SERIALIZE(v [RETURNING t])`.
- Each name is a PostgreSQL column-name keyword, and follows gram.y as one. Bare and followed by `(`, it always opens its SQL/JSON form, written with clauses or not: `json_array(1, 2)`, `JSON_OBJECT()` and `JSON_VALUE(j, '$')` give their SQL/JSON nodes. A call shape outside the form is an error (`json_objectagg(k, v)`, `json_arrayagg(DISTINCT a)`, `json_array(a => 1)`). The one plain `call` is JSON_OBJECT's legacy form, `json_object('{a,1}')` / `json_object(keys, values)`, which PostgreSQL also builds as an ordinary function call. A quoted or qualified name is an ordinary function. The names stay usable as column, table and alias names.
- In `FROM`, each SQL/JSON function but `JSON_TABLE` is a table function, its aggregates without `FILTER` or `OVER`. `JSON_TABLE` is a FROM item of its own, and nowhere else, `ROWS FROM` included.

**XML**

- `XMLELEMENT(NAME …, XMLATTRIBUTES(…), …)`, `XMLFOREST`, `XMLPI`, `XMLROOT`, `XMLPARSE`, `XMLSERIALIZE`, `XMLEXISTS`, `XMLCONCAT`, and `XMLTABLE` (with `XMLNAMESPACES`) as a FROM item. Each is a keyword form only when written bare and followed by `(`.

**Foreign data**

- Foreign-data wrappers, servers, user mappings and foreign tables (including `PARTITION OF` and column `OPTIONS`): `CREATE`, `ALTER` and `DROP`. Also `IMPORT FOREIGN SCHEMA` and generic `OPTIONS (ADD | SET | DROP …)` lists.

**psql scripts** (`sqlLiteScript`)

- psql meta-command lines and `COPY … FROM stdin` data blocks, between statements. Both pg_dump corpus files, `\restrict` lines and COPY blocks included, parse end to end.

### Compared with node-sql-parser

The battery in `test/pg-coverage.ts` has 609 distinct statements, all syntactically valid in PostgreSQL 17 (a few need 17 rather than 16). They cover the command reference and the query and expression chapters, from everyday idioms (upserts, pagination, `date_trunc` reports, pg_dump-style DDL) to the long tail. Each statement goes through `sqlLite.parse(sql)` and node-sql-parser 5.1.0's `new Parser().astify(sql, { database: "PostgreSQL" })`:

| Area | Statements | Both | @parser-kit/sql only | node-sql-parser only | Neither |
|---|---:|---:|---:|---:|---:|
| Queries | 99 | 64 | 35 | 0 | 0 |
| Expressions | 87 | 51 | 36 | 0 | 0 |
| Types and lexical | 36 | 20 | 16 | 0 | 0 |
| DML | 77 | 38 | 39 | 0 | 0 |
| Transactions and session | 72 | 19 | 53 | 0 | 0 |
| Utility and maintenance | 35 | 2 | 33 | 0 | 0 |
| Tables and indexes | 84 | 15 | 68 | 0 | 1 |
| Other schema objects | 93 | 18 | 71 | 0 | 4 |
| Roles and privileges | 26 | 8 | 18 | 0 | 0 |
| **Total** | **609** | **235** | **369** | **0** | **5** |

So @parser-kit/sql accepts 604 of the 609 statements (99.2%), and node-sql-parser accepts 235 (38.6%). No statement is accepted by node-sql-parser alone. The five @parser-kit/sql rejects:

- `ALTER TABLE … ADD CONSTRAINT … UNIQUE USING INDEX idx`.
- `ALTER TYPE … ADD / DROP ATTRIBUTE`.
- `ALTER SYSTEM`.
- `CREATE RULE` and `CREATE TRANSFORM`.

"Accepts" means "parses without throwing". It is a necessary condition for a correct AST, not a sufficient one. Known cases where @parser-kit/sql parses a statement into the wrong tree are listed [below](#known-wrong-asts) (there are none at present).

The test fails if any statement changes bucket. To print the table above:

```sh
PG_COVERAGE_REPORT=1 pnpm vitest run packages/sql/test/pg-coverage.test.ts
```

### pg_dump corpus

`test/pg-dump-corpus.test.ts` runs real pg_dump output through `sqlLite.parse`, one statement at a time. `test/psql-split.ts` splits each file the way psql does. It respects strings, dollar quotes and `BEGIN ATOMIC` bodies. It also sets aside `COPY … FROM stdin` data blocks and `\` meta-command lines (`\connect`, `\restrict`, …), which `sqlLite.parse` doesn't take. Every statement's outcome is pinned in `test/pg-dump-corpus.ts`, so a statement that starts or stops parsing fails the test. The test then parses each file whole with `sqlLiteScript`. The errors must fall in exactly the pinned failing statements, and its meta-command and COPY items must match what the splitter found. A file with no failing statement must pass `sqlLiteScript.parse`. The dumps live in `test/fixtures/pg-dump/` (repository only, not in the npm package):

- `pagila-schema.sql` is the [pagila](https://github.com/devrimgunduz/pagila) sample database's schema (pg_dump 15beta2 of a 12.11 server), vendored unmodified under the PostgreSQL License (`pagila-LICENSE.txt`).
- `handwritten-pg17.sql` is written by hand in the shape pg_dumpall/pg_dump 17.6 produce. It covers what the sample dump lacks: `\restrict`, roles, row-level security and policies, default privileges, publications, identity columns, `ALTER INDEX … ATTACH PARTITION`, `BEGIN ATOMIC` bodies and COPY blocks.

| File | Statements | Parse | Rate | COPY blocks | Meta-commands | Parses whole |
|---|---:|---:|---:|---:|---:|---|
| `handwritten-pg17.sql` | 110 | 110 | 100.0% | 4 | 7 | yes |
| `pagila-schema.sql` | 388 | 388 | 100.0% | 0 | 0 | yes |
| **Total** | **498** | **498** | **100.0%** | **4** | **7** | **2 / 2** |

To print the table, or to rewrite `pg-dump-corpus.ts` after a grammar change (review the diff: no row may move to `fail`):

```sh
PG_DUMP_CORPUS_REPORT=1 pnpm vitest run packages/sql/test/pg-dump-corpus.test.ts
PG_DUMP_CORPUS_WRITE=1 pnpm vitest run packages/sql/test/pg-dump-corpus.test.ts
```

### Not yet supported

Every item here was checked against the current grammar and fails to parse.

**Statements**

- `CREATE RULE` (and `DROP RULE`), `CREATE TRANSFORM` (and `DROP TRANSFORM`), `ALTER SYSTEM`.
- `ALTER GROUP … ADD | DROP USER`.
- `USE db` is a MySQL-ism with no PostgreSQL equivalent. It is rejected **on purpose**, and `pg-coverage.test.ts` pins that.

**Actions on objects that are otherwise supported**

- `ALTER TYPE … ADD | DROP | ALTER | RENAME ATTRIBUTE`, and `ALTER TYPE … SET (…)`.
- An action list on `ALTER SEQUENCE` (`OWNER TO r, SET LOGGED`). Each action works alone.
- `ADD CONSTRAINT … UNIQUE | PRIMARY KEY USING INDEX idx`.
- `ALTER FUNCTION … RESET`, and `ALTER PROCEDURE` / `ALTER ROUTINE` attributes (`SECURITY DEFINER`, `IMMUTABLE`, …). Their `RENAME` / `OWNER TO` / `SET SCHEMA` work.
- `… [NO] DEPENDS ON EXTENSION` on functions, procedures, triggers, indexes and materialized views.
- `OPTIONS (…)` on `ALTER INDEX` / `VIEW` / `SEQUENCE` / `MATERIALIZED VIEW`. PostgreSQL's grammar takes it there, though only foreign tables use it.
- Long-tail `ALTER` actions beyond rename / owner / schema, for example:
  - `ALTER EVENT TRIGGER … ENABLE`
  - `ALTER STATISTICS … SET STATISTICS`
  - `ALTER COLLATION … REFRESH VERSION`
  - `ALTER OPERATOR … SET (…)`
  - `ALTER OPERATOR FAMILY … ADD | DROP`
  - `ALTER TEXT SEARCH CONFIGURATION … ADD MAPPING`, `ALTER TEXT SEARCH DICTIONARY … (…)`
- `ALTER ROLE … USER role_list` (undocumented), and `SET TRANSACTION` / `SET SESSION CHARACTERISTICS` inside `ALTER ROLE | DATABASE … SET`.
- `CREATE FUNCTION … SUPPORT fn` and `… TRANSFORM FOR TYPE t`.
- Ordered-set aggregate signatures, `a(int ORDER BY int)`, in `CREATE AGGREGATE`, `COMMENT ON` and `ALTER EXTENSION`.
- `COMMENT ON TYPE` with a full type spelling (`int[]`, `double precision`). It takes a dotted name.

**Clauses and expressions**

- A parenthesised set operation as `JSON_ARRAY`'s query (`JSON_ARRAY((SELECT 1) UNION (SELECT 2))`). `JSON_ARRAY(SELECT …)` works, and `JSON_ARRAY((SELECT 1))` is a one-element array of a scalar subquery, as in PostgreSQL.
- `INSERT … VALUES (…)` followed by a set operation or a query tail (`VALUES (1) UNION SELECT 2`, `VALUES (1) LIMIT 1`). `INSERT … SELECT …` takes both.
- `OPERATOR(…)` in `ORDER BY … USING` and in an exclusion constraint's `WITH` (a plain operator works in both).
- Field selection straight after a parameter: `$1.f`, `$1.*`. `($1).f` and `$1[1]` work.
- An unquoted reserved word as a field step in an assignment target (`SET c.from = …`). Quote it (`c."from"`), as for dotted names' parts.
- `SET col = (DEFAULT)`. `SET col = DEFAULT` works.
- Operator-class options in an `ON CONFLICT` element (`(a ops (k = v))`).
- `SET TIME ZONE INTERVAL(p) '…'`. `SET TIME ZONE INTERVAL '…' HOUR` works.
- A routine name that @parser-kit/sql reserves, such as `left`, after `ON FUNCTION` / `COMMENT ON FUNCTION`.
- A reserved word after the dot in a qualified `HANDLER` / `VALIDATOR` name (`HANDLER s.select`).

**Scripts** (`sqlLiteScript`)

- Rows following a `\copy … from stdin` meta-command are not read as data.
- A meta-command that starts a line inside an unfinished statement is reported as an error. psql would keep the statement buffer instead.
- Text after a `COPY … FROM stdin`'s `;` on the same line, other than whitespace or a `--` comment, is an error. psql would run it after the copy. pg_dump never writes any.
- A `BEGIN ATOMIC` body is framed by counting `begin` / `case` / `end` words, as psql does. A column named `begin` inside a body can throw recovery off, and in a script the COPY framing of later statements too. psql mis-frames such a script the same way.

### Known wrong ASTs

One input is known to parse into the wrong tree. Report any other as a bug.

- A quoted configuration parameter that spells one of `SET` / `SHOW` / `RESET`'s multi-word forms gives that form's tree: `SET "time zone" = 'UTC'` and `SET TIME ZONE 'UTC'` both give `name: ["time zone"]`, and the same holds for `"session authorization"`, `"transaction isolation level"` and `"xml option"`. PostgreSQL reads the quoted spelling as a parameter of that literal name, which doesn't exist, so the statement fails there when run.

Numbers below 2^53 in magnitude keep only double precision (see [AST conventions](#ast-conventions)). That is a documented limitation of the number node, not a wrong tree.

### Accepted, but PostgreSQL rejects

The grammar is deliberately more permissive than PostgreSQL in places. These inputs are syntax errors in PostgreSQL but parse here:

- **Expression shapes PostgreSQL's grammar forbids:**
  - non-associative chains: `a LIKE b LIKE c`, `a IS DISTINCT FROM b IS NULL`;
  - `DEFAULT (a, b) OVERLAPS (c, d)` in a column `DEFAULT`;
  - subscripting without parentheses: `f(x)[1]`, `ARRAY[1, 2][1]`, `ARRAY(SELECT …)[1]` (PostgreSQL requires `(f(x))[1]`);
  - `f(a, *)` and `count(* ORDER BY a)`;
  - `operator(x)` as an ordinary call in a select list.
- **The `at` and `similar` guards look only at the next token**, so `SELECT a + b at FROM t` reads `at` as an alias, and `substring(a = b SIMILAR 'x' ESCAPE '#')` parses. PostgreSQL rejects both.
- **Aliases:** AS_LABEL keywords other than `isnull` / `notnull` / `overlaps` (`day`, `over`, …) are accepted as bare aliases. `isnull`, `notnull` and `overlaps` are refused as bare aliases, but accepted as table aliases after `AS`.
- **Window frames PostgreSQL rejects:** `ROWS BETWEEN CURRENT ROW AND UNBOUNDED PRECEDING`, `ROWS 1 FOLLOWING`.
- **The empty `USING ()` join list.**
- **Impossible type modifiers:** `x::int(4)`.
- **A whole-valued float where PostgreSQL wants an integer constant:** `MODULUS 4.0` or `MODULUS 4.` in a hash partition bound, `int[5.]`.
- **Named parameters** such as `$name`. PostgreSQL only has positional ones (`$1`). @parser-kit/sql keeps `$name` for templated SQL.
- **`UESCAPE` with no string after it:** `SELECT U&'x' uescape FROM t` reads `uescape` as an alias.
- **Names PostgreSQL restricts:**
  - `SET TIME ZONE` with a non-reserved keyword as the zone (`SET TIME ZONE zone`);
  - configuration parameter names that are `type_func_name` keywords (`SET outer = 1`, `SHOW authorization`);
  - `COPY binary FROM stdin` copies a table named `binary`, where `BINARY` is a `type_func_name` keyword in PostgreSQL.
- **Column-name keywords as routine or type names.** PostgreSQL never takes a bare SQL/JSON or XML function name (`json_array`, `xmlelement`, …) as a `func_name` or a type name. Here those positions still take one: `CALL json_array()`, `CREATE FUNCTION json_value() …`, `x::xmlelement`. In an expression or a `FROM` item, the bare name followed by `(` is always the keyword form, as in PostgreSQL.
- **`CREATE INDEX IF NOT EXISTS ON t (…)`** with no index name.
- **`CREATE OR REPLACE MATERIALIZED VIEW`.**
- **Publication and subscription `WITH (…)` lists** take the general option shape, so `ns.name` keys and parenthesised values parse. PostgreSQL's `definition` has neither.
- **PostgreSQL 18's `GENERATED ALWAYS AS (…) VIRTUAL`** columns parse (pagila's schema dump has one), though PostgreSQL 17 requires `STORED`. The PostgreSQL 18 spelling with neither keyword is rejected.

Some errors PostgreSQL raises during analysis rather than parsing are also accepted:

- `VALUES` rows of different lengths;
- `ON CONFLICT DO UPDATE` without a conflict target;
- four-part names like `a.b.c.d` (a cross-database reference);
- a locking clause on `VALUES` or on a set operation (`VALUES (1) FOR UPDATE`, `SELECT 1 UNION SELECT 2 FOR UPDATE`).

node-sql-parser also accepts the `ON CONFLICT` one.

Two smaller divergences: quoted identifiers longer than 63 bytes are not truncated, and when an invalid `E'…'` literal has several errors, the one reported can differ from PostgreSQL's.

### Behaviour changes

These breaks landed before the first npm release, most of them while the grammar was the unpublished `examples/sql-lite` example in the parser-kit repo. They are listed for anyone who tracked it there.

**Inputs that used to parse and are now rejected**, because PostgreSQL rejects them, almost all in its grammar. Two (`GRANT r TO u WITH GRANT OPTION`, `SEQUENCE NAME` in `CREATE SEQUENCE`) are post-parse errors there, refused here because the check is local:

- **Literals and lexing:**
  - unterminated `'…'`, `E'…'`, `"…"`, `B'…'`, `X'…'`, `U&'…'`, `U&"…"` or `/* …` at end of input;
  - the zero-length identifiers `""` and `U&""`;
  - invalid `E'…'` escapes: NUL (`E'\0'`, `E'\x00'`, `E'\u0000'`), invalid UTF-8 (`E'\xC3'`, `E'\777'`), short escapes (`E'\u12'`, `E'\U0041'`), unpaired surrogates (`E'\uD83D'`), and out-of-range code points (`E'\U00110000'`);
  - `U&'x' UESCAPE 'é'`, because the escape character isn't one byte;
  - junk after a number or parameter: `123abc`, `1.5x`, `1e`, `1e+`, `1_`, `1__2`, `0x`, `0xg`, `0x_g`, `0b102`, `0o8`, `$1abc`, `$1_000`.
- **Queries:**
  - a join other than `CROSS` or `NATURAL` with no `ON` / `USING`, wherever a FROM item is read: `a JOIN b`, `a LEFT JOIN b`, and `a JOIN b JOIN c ON p` (the inner join takes the only `ON`, leaving the outer one without a qualifier);
  - `NATURAL CROSS JOIN`;
  - a second `LIMIT` or `OFFSET` (`LIMIT 1 LIMIT 2`, `LIMIT … FETCH FIRST …`), including across parentheses (`(SELECT 1 LIMIT 1) LIMIT 2`, `(… ORDER BY 1) ORDER BY 1`);
  - `WITH TIES` without `ORDER BY`, or with `SKIP LOCKED`;
  - a `FETCH` missing `FIRST | NEXT`, `ROW | ROWS` or `ONLY | WITH TIES`;
  - a tail on an unparenthesised set-operation arm (`SELECT 1 ORDER BY 1 UNION SELECT 2`). Parenthesise the arm;
  - locking on both sides of the limit (`FOR UPDATE LIMIT 1 FOR UPDATE`);
  - a second `WITH` on a parenthesised query that has its own (`WITH a AS (…) (WITH b AS (…) SELECT …)`): `multiple WITH clauses not allowed`.
- **Empty lists:** `x [NOT] IN ()`, `VALUES ()`, `INSERT … VALUES ()`, `SELECT DISTINCT ON ()`, `INSERT INTO t () …`, `ON CONFLICT () …`, and empty subscripts (`a[]`, `SET a[] = 1`).
- **Expressions:**
  - `count(DISTINCT)`, `count(DISTINCT *)`, `f(VARIADIC a, b)`, `ARRAY()`, `ARRAY(1)`, and mixed rows and expressions in `ARRAY[…]`;
  - bare `isnull`, `notnull` and `overlaps` as aliases (`SELECT a overlaps FROM t`, `FROM t isnull`). `AS overlaps` still works;
  - `normalize(x, 'NFC')` and other non-keyword forms;
  - `substring(x SIMILAR p)` without `ESCAPE`;
  - bare `xmlattributes(…)` / `xmlnamespaces(…)` outside XMLELEMENT / XMLTABLE, `xmltable(…)` in an expression, and XML function names in ordinary call shapes (`xmlparse(x)`, `xmlpi(x)`). These used to parse as plain calls;
  - SQL/JSON function names in call shapes their gram.y forms don't take: `json_objectagg(k, v)`, `json_arrayagg(DISTINCT a)`, `json_arrayagg(a, b)`, `json_array(a => 1)`, `json_array(*)`, `json_array(a ORDER BY a)`, `json_value(a)`, `json_exists()`, `json_scalar(a, b)`, `json()`, `WITHIN GROUP` on an aggregate (`json_arrayagg(a) WITHIN GROUP (ORDER BY a)`), a `FILTER` / `OVER` on a non-aggregate (`json_array(1) OVER ()`), and `DISTINCT`, `VARIADIC`, `*`, `ORDER BY` or `OVER` on the legacy `json_object(…)` call. These used to parse as plain calls. A quoted or qualified name still does;
  - `json_table(…)` in an expression or in `ROWS FROM`, and a bare `json_table(…)` in `FROM` without its path string and `COLUMNS` (`FROM json_table(a, b)`), which used to parse as a table-function call.
- **Types:** interval field specs outside PostgreSQL's thirteen (`DAY TO YEAR`, `MONTH TO DAY`), a precision on anything but `SECOND`, `int ARRAY[]`, `int ARRAY[3][4]`, `RETURNS SETOF SETOF int`.
- **DDL:**
  - in a column or domain `DEFAULT`: `IS` tests other than `DISTINCT FROM`, `AT TIME ZONE`, `NOT` / `AND` / `OR`, `LIKE` / `ILIKE` / `SIMILAR TO`, `IN`, `BETWEEN` and `= ANY (…)` (each still parses in parentheses);
  - `COMMENT ON SCHEMA a.b`, since a schema name is one word;
  - multi-part names after `SCHEMA`, `DATABASE`, `LANGUAGE`, `TABLESPACE` and `FOREIGN SERVER` in `GRANT` / `REVOKE`;
  - `GRANT ALL TO u`, `GRANT r TO GROUP u`, `GRANT … ON t TO u WITH ADMIN OPTION`, `GRANT r TO u WITH GRANT OPTION`, `REVOKE GRANT OPTION FOR r FROM u`, `REVOKE ADMIN OPTION FOR SELECT ON t FROM u`;
  - `ALTER ROLE CURRENT_USER RENAME …`, and the reserved role names `public` / `none` around `RENAME`;
  - `rename`, `set`, `reset` or `refresh` as a `CREATE | ALTER DATABASE` option name, and `OWNER TO` inside the option run;
  - `ALTER FUNCTION … SET SCHEMA s` after other attributes: the schema must be a string there, as PostgreSQL's routine `SET` takes one;
  - `ALTER COLUMN … SET AS | RESTART | OWNED BY …`, more than one sequence option per `SET`, and `SEQUENCE NAME` in `CREATE | ALTER SEQUENCE`;
  - `ALTER INDEX IF EXISTS i ATTACH PARTITION j`.
- **Session and utility:**
  - `SET` values that are expressions (`SET x = 1 + 2`, `SET x = lower('A')`, `SET x = null`), also in a routine's `SET` option;
  - `SET NAMES utf8` (an unquoted value), `SET ROLE DEFAULT`, `SET SCHEMA DEFAULT`, `SET TIME ZONE true`, and a trailing comma in a transaction-mode list;
  - `ABORT TO SAVEPOINT`, `END PREPARED`, `COMMIT WORK PREPARED`, `COMMIT | ROLLBACK PREPARED` without a string, and `NOTIFY ch, <non-string>`.

**Trees that changed shape:**

- A count-less `FETCH FIRST ROW ONLY` / `FETCH NEXT ROWS WITH TIES` gives `limit: { kind: "number", value: 1, implicit: true }`, not `limit: null`.
- A bare SQL/JSON function written with none of its clauses gives its SQL/JSON node, not a `call`: `json_array(1, 2)` is a `jsonArray`, `JSON_OBJECT()` a `jsonObject` with no entries, `json_arrayagg(x ORDER BY x)` a `jsonArrayAgg`, `JSON_VALUE(j, '$')` a `jsonValue`, `json(x)` a `jsonParse`, `json_serialize(x)` a `jsonSerialize`, and `JSON_SCALAR(x)` the new `jsonScalar`. So does one written as a `FROM` item (`FROM json_array(1, 2)`). JSON_OBJECT's legacy form stays a `call`.
- Operator precedence follows PostgreSQL. `-2 ^ 2` is `(-2) ^ 2`, `-x COLLATE "C"` is `(-x) COLLATE "C"`, and chained `AT TIME ZONE` nests to the left.
- `2^-2` lexes as the single operator `^-`, as in PostgreSQL. `2 ^ -2` (spaced) is unchanged.
- `INTERSECT` binds tighter than `UNION` / `EXCEPT`, so `SELECT 1 UNION SELECT 2 INTERSECT SELECT 3` is `1 ∪ (2 ∩ 3)`. A tail after a set operation moved from the right arm to the `setOp` node.
- `DEFAULT 'a' COLLATE "C"` is a `default` constraint followed by a column `collate` constraint. It used to be a `collate` expression inside the default.
- `SET TIME ZONE LOCAL` gives `values: "default"`, as PostgreSQL treats `LOCAL`.
- `x::setof int` is a cast to a `setof: true` type, not a cast to `setof` aliased `int`. `f(setof int)` in a routine signature is one unnamed argument. `1::"char"` carries `quoted: true`.
- `U&"…"` is one identifier, and `E'…'` escapes are decoded.
- `SELECT a ISNULL FROM t` is the null test, not an alias. `SELECT x at FROM t` and `SELECT y similar FROM t` read the alias again.
- `COLLATION FOR (x)` is a `collationFor` node, not a column followed by a locking clause.
- Qualified names that were joined with `.` into one string are now a `string[]` of their parts, as table and column names already were: a call's `name` (`pg_catalog.now()` gives `["pg_catalog", "now"]`), a type's `name` (casts, columns, typed literals, routine signatures), a `RANGE` type option's `value`, and a configuration parameter's `name` in `SET` / `SHOW` / `RESET` and `ALTER ROLE` / `ALTER DATABASE … SET | RESET`, and its `parameter` in a routine's `SET`. `"a.b"(1)` and `a.b(1)` used to give the same `name: "a.b"`; they now give `["a.b"]` and `["a", "b"]`. A multi-word spelling is one element (`["double precision"]`, `["time zone"]`, `["all"]` for `SHOW ALL`).
- A number written with a `.`, an exponent or any other spelling `String(value)` doesn't reproduce now carries `raw` (`1.0` gives `{ value: 1, raw: "1.0" }`), so `1` and `1.0` are no longer the same tree. See "AST conventions".

**TypeScript surface.** These widen existing types or add union members, so exhaustive `switch`es and direct field reads may need updating:

- `Assignment.value` is `Expr | DefaultValue`, `SetStmt.values` is `Expr[] | "default" | "fromCurrent"`, and `CreateTableAs.query` is `Query | Execute`.
- A `comment` statement is `{ kind: "comment" } & ObjectRef & { comment }`, so its `name` is optional (`COMMENT ON CAST` has none).
- `Query` has a new kind, `tableCmd`. `Expr` has `fieldSelect`, `arraySubquery`, `isNormalized`, `isDocument`, `normalize`, `collationFor`, `substringSimilar`, `atLocal` and the `xml*` nodes. `Stmt` has many new kinds. `Expr` also has the SQL/JSON nodes (`jsonObject`, `jsonArray`, `jsonArrayQuery`, `jsonObjectAgg`, `jsonArrayAgg`, `jsonValue`, `jsonQuery`, `jsonExists`, `jsonParse`, `jsonScalar`, `jsonSerialize`), and FROM items have `jsonTable` and `xmlTable`.
- The `number` node has an optional `implicit: true`. A composite `createType`'s `attributes` are `ColumnDefinition`s, with an optional `collate`. `AlterViewAction` adds the materialized view's table actions (`setStatistics`, `setStorage`, `setCompression`, `setColumnOptions`, `resetColumnOptions`, `clusterOn`, `setWithoutCluster`, `setAccessMethod`, `replicaIdentity`), and `AlterSequenceAction` adds `setLogged` and `setUnlogged`.
- `anyAll.op` can be `like`, `ilike`, `not like` or `not ilike`. `unary`, `binary` and `anyAll` can carry `opSchema`.
- `ColType.name`, a `call`'s `name`, `RangeOption.value`, the `name` of `SetStmt`, `Show`, `Reset` and the `set` / `reset` actions of `ALTER ROLE` / `ALTER DATABASE`, and a routine `set` option's `parameter` are `string[]`, not `string`.
- `sqlLiteScript` returns `ScriptItem[]`, not `Stmt[]`.

## Benchmarks

Three bench files compare @parser-kit/sql with node-sql-parser 5.1.0 in PostgreSQL mode. The bench files predate the package and label it `sql-lite`, its name as a repo example. **Every head-to-head group uses only input both parsers accept,** except the malformed-input group, whose inputs both parsers reject. `sql-lite.workloads.bench.ts` checks this at load time and refuses to run if either parser rejects a workload. PostgreSQL syntax that node-sql-parser rejects (`DELETE … RETURNING`, `FOR UPDATE SKIP LOCKED`, `ALTER TABLE … RENAME COLUMN`, …) is left out of the comparisons. A real application's SQL would include some of it.

### Real-world workloads (`sql-lite.workloads.bench.ts`)

| Workload | @parser-kit/sql ops/s | mean | node-sql-parser ops/s | mean | Relative |
|---|---:|---:|---:|---:|---|
| OLTP mix: 16 statements, one `parse` call each | 1,651 | 0.61 ms | 465 | 2.15 ms | @parser-kit/sql 3.55× faster |
| Analytics report: 2 CTEs, 3 window functions, 3 joins, `CASE` | 2,285 | 0.44 ms | 800 | 1.25 ms | @parser-kit/sql 2.86× faster |
| Migration script: 19 DDL statements in one 1.6 KB file | 1,898 | 0.53 ms | 559 | 1.79 ms | @parser-kit/sql 3.40× faster |
| Bulk `INSERT`: 10,000 rows of 5 values, 406.5 KB | 4.92 | 203 ms | 4.62 | 216 ms | @parser-kit/sql 1.06× faster |
| Wide `SELECT`: 1,000 columns, 21.3 KB | 90.5 | 11.1 ms | 29.8 | 33.6 ms | @parser-kit/sql 3.04× faster |
| Malformed input: 8 statements, every one throws | 6,769 | 0.15 ms | 1,219 | 0.82 ms | @parser-kit/sql 5.55× faster |

The bulk `INSERT` is the closest workload. Nearly all of that input is literals and commas, so the work is per token. @parser-kit/sql costs roughly 20 µs per 5-value row, and the cost is linear in the row count. Both parsers had ±7–8% variance on this row, and an earlier recording had node-sql-parser 1.29× ahead, so treat it as roughly even. Malformed input shows the widest gap.

### Statement corpus and large files

| Group | @parser-kit/sql ops/s | node-sql-parser ops/s | Relative |
|---|---:|---:|---|
| Whole shared corpus (28 statements) | 1,235 | 371 | 3.33× |
| `select` (5) | 12,562 | 3,647 | 3.44× |
| `select-adv` (4) | 9,911 | 2,574 | 3.85× |
| `cte` (2) | 23,578 | 10,969 | 2.15× |
| `dml` (4) | 11,102 | 5,657 | 1.96× |
| `ddl` (6) | 8,251 | 2,222 | 3.71× |
| `expr` (7) | 8,102 | 2,025 | 4.00× |
| 64 KB file (1,722 statements) | 26.3 | 8.78 | 3.00× |
| 256 KB file (6,889 statements) | 6.95 | 2.10 | 3.31× |
| 1 MB file (27,557 statements) | 1.77 | 0.53 | 3.36× |
| pagila schema dump (388 statements) | 77.6 | — | @parser-kit/sql only |

"Relative" is @parser-kit/sql's speed-up over node-sql-parser. `sql-lite.large.bench.ts` also has a group for @parser-kit/sql alone that parses the pagila schema dump statement by statement. node-sql-parser rejects most pg_dump DDL, so there is no comparison.

### Methodology

- These are [vitest bench](https://vitest.dev/guide/features.html#benchmarking) (tinybench) results: ops/s is iterations of the whole group body per second, and mean is the time per iteration.
- Each workload is built once at module load. Generated inputs are deterministic (no `Math.random`), so every run parses identical text.
- Both parsers are called the way an application would call them: `sqlLite.parse(sql)` against `new Parser().astify(sql, { database: "PostgreSQL" })`, with one `Parser` instance reused.
- **Recorded on:** 2026-11-20, with Node 22.23.5, vitest 3.2.7 and node-sql-parser 5.1.0. The machine was a Linux container with 4 vCPUs (Intel Xeon @ 2.30 GHz) and 15 GB RAM.
- The run was one `pnpm bench:save` with nothing else running. **The numbers are noisy.** Absolute ops/s move a lot between machines and runs (this run's machine was 2–3.5× faster than the previous recording's for both parsers), so compare the ratios, not raw ops/s across runs. Variance (`rme`) stayed within ±4% for most groups. The bulk `INSERT` (±8% and ±7%) and node-sql-parser's 256 KB file (±6%) were the noisiest.

### Running them

From a clone of the repository root:

```sh
pnpm bench                                                               # every bench file
pnpm vitest bench --run packages/sql/bench/sql-lite.workloads.bench.ts   # just the workloads
pnpm bench:compare                                                       # diff against bench-baseline.json
pnpm bench:save                                                          # re-record bench-baseline.json
```

The committed `bench-baseline.json` covers every bench file: the per-construct corpus, the large files, the pagila dump and the workloads. It was recorded in the same run as the tables above, so `bench:compare` shows a delta for every group. Benchmarks don't run in CI.

## Contributing

Run everything from the repository root (`pnpm test`, `pnpm types:check`, `pnpm lint`). The repo-wide workflow is in [CONTRIBUTING.md](https://github.com/DemonHa/parser-kit/blob/main/CONTRIBUTING.md). Specific to this grammar:

- **Tests first, at the level the change lives.** New syntax gets a `describe` block in `test/sql-lite.test.ts` asserting the span-stripped AST with `toEqual`, plus the error message for the nearest malformed input.
- **Follow the [AST conventions](#ast-conventions).** A new field is optional and left out when absent, so trees for input that doesn't use the construct stay byte-identical.
- **Prove new keywords stay unreserved.** PostgreSQL leaves most keywords usable as names, and so does this grammar: only the words in `RESERVED` are refused as bare names. Every feature that matches a new word by value comes with a "keeps … unreserved as names and aliases" test showing the word still works as a column, table and alias (for example `SELECT rows, ordinality FROM t AS rows;`). Don't add to `RESERVED` to make a parse work.
- **Pin observable output in the parity golden.** `parity.test.ts` serialises the full AST, spans included, for every `corpus.ts` row and its own `SUPPLEMENTAL` / `MULTI_LINE` / `LEXER_EDGE_CASES` lists, plus `diagnose()` output for `MALFORMED`. New node shapes go in `SUPPLEMENTAL`, not `corpus.ts`. The benchmark's group names count the corpus's shared rows, and `bench-baseline.json` keys on those names, so a new `pg: true` corpus row renames them and silently disconnects `pnpm bench:compare`. When output is *meant* to move, regenerate with `pnpm test -- -u` (the `--` matters) and call the diff out in review. Never regenerate to make a refactor pass.
- **Update the coverage battery.** If a change makes a `pg-coverage.ts` statement parse (or stop parsing), `pg-coverage.test.ts` fails with an `expected -> actual` line per moved row. Update the row's bucket, re-print the table with `PG_COVERAGE_REPORT=1`, and update the numbers in this README. Update the "Not yet supported", "Known wrong ASTs" and "Accepted, but PostgreSQL rejects" lists too, and add any input that stops parsing to "Behaviour changes". No test pins those lists.
- **Update the pg_dump corpus.** If a change makes a dump statement parse (or stop parsing), `pg-dump-corpus.test.ts` fails the same way. Regenerate `pg-dump-corpus.ts` with `PG_DUMP_CORPUS_WRITE=1`, check that no row moved to `fail`, and update the [pg_dump corpus](#pg_dump-corpus) table from `PG_DUMP_CORPUS_REPORT=1`.
