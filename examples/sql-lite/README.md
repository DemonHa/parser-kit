# sql-lite

A PostgreSQL-flavoured SQL grammar built with [`@parser-kit/core`](../../packages/core). It is not published. It exists for three reasons:

- **An example.** It's the largest grammar in the repo and the one to read for keyword tiers, Pratt operator tables, hand-written `custom` rules, backtracking and error recovery working together on a real language.
- **The kit's integration test.** Its 400+ unit tests, plus byte-exact AST and diagnostic goldens, are what catch a "generic" core change that quietly breaks a real grammar.
- **A benchmark.** It is measured against [`node-sql-parser`](https://www.npmjs.com/package/node-sql-parser) (PostgreSQL mode), the most widely used JavaScript SQL parser.

Despite the name, it covers most of the SQL applications send to PostgreSQL, though gaps remain, most notably comments inside a statement and some pg_dump-style DDL (see [PostgreSQL coverage](#postgresql-coverage)).

## Usage

```ts
import { sqlLite } from "./index";

const ast = sqlLite.parse("SELECT id, count(DISTINCT tag) FROM posts WHERE created_at > now() - interval '7 days' GROUP BY id;");
// → Stmt[]: one node per statement, every node carrying a { start, end } span
```

The root is a list of statements, and **every statement needs its terminating `;`**. Unquoted identifiers fold to lower case, quoted ones keep their case, and keywords PostgreSQL treats as unreserved (`type`, `role`, `comment`, `data`, `rows`, …) stay usable as names. The node types are exported from `grammar.ts` (`Stmt`, `Query`, `Expr`, …).

`parse` throws a `ParseError` at the first problem:

```ts
sqlLite.parse("SELECT id FROM users WHERE;");
// ParseError: Expected a number or a string or … or "(" or a name but found ";" (1:26)
```

`diagnose` recovers at each `;` instead and returns everything it could parse alongside every error. That's the mode editor tooling wants:

```ts
const { ast, errors } = sqlLite.diagnose("SELECT 1;\nSELECT FROM WHERE;\nDELETE FROM t WHERE id = 1;");
// ast: the SELECT and the DELETE
// errors: [Expected a name but found "from" (2:7)]
```

## Layout

| File | What it is |
|---|---|
| `lexer.ts` | Tokens: identifier folding, quoted identifiers, `'…'` / `E'…'` / `$tag$…$tag$` / `B'…'` / `X'…'` / `U&'…'` strings, `U&"…"` identifiers, PostgreSQL numbers (`1e5`, `.5`, `0xff`, `1_000`), `$1` parameters, comments, and the operator reader |
| `grammar.ts` | The grammar: the AST types, the reserved-word set, the expression Pratt table, and one rule per statement |
| `index.ts` | Re-exports both |
| `sql-lite.test.ts` | Unit tests, one `describe` per feature |
| `corpus.ts` | The statements the benchmark measures and the parity golden pins |
| `parity.test.ts` + `parity.*.golden.json` | Byte-exact AST (spans included) and `diagnose()` output for the corpus plus a supplemental list |
| `pg-coverage.ts` + `pg-coverage.test.ts` | The PostgreSQL coverage battery: 599 statements with the bucket each one lands in |
| `sql-lite.bench.ts` | Throughput over the corpus, per category |
| `sql-lite.large.bench.ts` | Throughput on 64 KB / 256 KB / 1 MB multi-statement files |
| `sql-lite.workloads.bench.ts` | Throughput on real-world workloads |

## PostgreSQL coverage

### What's supported

- **Queries.** `SELECT` with `DISTINCT [ON]`, every join type (`NATURAL`, `USING`, `LATERAL`, parenthesised joins), subqueries and derived tables, `ONLY`, alias column lists, `TABLESAMPLE … REPEATABLE`, `ROWS FROM (…)` and `WITH ORDINALITY`. Also: `GROUP BY [DISTINCT | ALL]` with `ROLLUP` / `CUBE` / `GROUPING SETS`, `HAVING`, `WINDOW`, `ORDER BY … USING` and `NULLS FIRST/LAST`, `LIMIT` / `OFFSET` / `FETCH FIRST … ROWS ONLY | WITH TIES`, every locking clause (`FOR [NO KEY] UPDATE`, `FOR [KEY] SHARE`, `OF`, `NOWAIT`, `SKIP LOCKED`), `UNION` / `INTERSECT` / `EXCEPT [ALL]`, standalone `VALUES`, `SELECT INTO`. CTEs can be `RECURSIVE`, `[NOT] MATERIALIZED`, use `SEARCH` and `CYCLE`, and be data-modifying.
- **Expressions.** The full operator precedence table: arithmetic, bitwise, `||`, comparison, `LIKE` / `ILIKE` / `SIMILAR TO` with `ESCAPE`, regex `~` operators, `IS [NOT] DISTINCT FROM`, `IS [NOT] NULL / TRUE / UNKNOWN`, `IS JSON [OBJECT | ARRAY | SCALAR] [WITH UNIQUE KEYS]`, `BETWEEN [SYMMETRIC]`, `IN`, `ANY` / `SOME` / `ALL`, `EXISTS`, `OVERLAPS`, `AT TIME ZONE`, `COLLATE`. JSON and jsonpath operators (`->`, `->>`, `#>`, `#>>`, `@>`, `<@`, `?`, `?|`, `?&`, `@?`, `@@`, `#-`), `::` casts and `CAST`, `CASE`, `ROW(…)`, `ARRAY[…]`, subscripts and slices. Special-syntax functions: `EXTRACT`, `POSITION`, `SUBSTRING … FROM … FOR`, `TRIM`, `OVERLAY`, the niladic `CURRENT_DATE` / `CURRENT_TIMESTAMP(p)` / `LOCALTIME` / `CURRENT_USER` family. Aggregate modifiers: `DISTINCT`, `ORDER BY` inside the call, `FILTER (WHERE …)`, `WITHIN GROUP`, `=>` named arguments, `OVER` with `ROWS` / `RANGE` / `GROUPS` frames and `EXCLUDE`.
- **Types and literals.** Multi-word types (`double precision`, `character varying(n)`, `timestamp(p) with time zone`, `bit varying`, `interval day to second`), array types, schema-qualified types, typed literals (`DATE '…'`, `TIMESTAMP '…'`, `INTERVAL '…' HOUR TO MINUTE`), dollar-quoted strings, bit / hex / Unicode-escape strings with `UESCAPE`.
- **DML.** `INSERT` with `DEFAULT VALUES`, `DEFAULT` row items, `OVERRIDING`, `ON CONFLICT (cols) | ON CONSTRAINT … DO NOTHING | DO UPDATE … WHERE`, a target alias, and `RETURNING`. `UPDATE … FROM` with multi-column `(a, b) = (…)` / `= (SELECT …)` assignments. `DELETE … USING`. `MERGE` with every `WHEN [NOT] MATCHED [BY SOURCE | TARGET]` form, plus `RETURNING`. `COPY` to and from a file, `STDIN` / `STDOUT` or a `PROGRAM`, with a parenthesised option list and `WHERE`. `TRUNCATE`.
- **DDL.**
  - **`CREATE TABLE`:** column and table constraints, identity and stored generated columns, `COLLATE`, foreign-key actions / `MATCH` / `DEFERRABLE`, `EXCLUDE`, `LIKE … INCLUDING`, `INHERITS`, range / list / hash partitioning and `PARTITION OF … FOR VALUES`, `WITH (…)`, `TABLESPACE`, `ON COMMIT`, `TEMP` / `UNLOGGED`, `AS SELECT … WITH [NO] DATA`.
  - **`ALTER TABLE`:** action lists that add or drop columns and constraints, `ALTER COLUMN` type / default / not-null, renames, `SET SCHEMA`, `OWNER TO`, triggers, `ATTACH` / `DETACH PARTITION`, storage parameters, `REPLICA IDENTITY`, `CLUSTER ON`.
  - **Other `CREATE` targets:** indexes (with `CONCURRENTLY`, `USING`, opclasses, `INCLUDE`, partial `WHERE`, `WITH`), views and materialized views, sequences, enum / composite / range types, domains, schemas, databases, extensions, tablespaces, functions, procedures, aggregates, triggers, roles and users.
  - **`DROP`:** all of those except tablespaces.
  - **`ALTER`:** schemas, domains, types, indexes, functions, aggregates, views, materialized views and sequences.
  - Plus `COMMENT ON` and `REFRESH MATERIALIZED VIEW`.
- **Access control and utility.** `GRANT` / `REVOKE` on tables, columns, sequences, schemas, databases, types and `ALL … IN SCHEMA`, and role membership. Transactions with isolation modes, `AND [NO] CHAIN` and savepoints. `SET` / `SHOW` / `RESET`. `LOCK`, `CALL`, `DO`, `PREPARE` / `EXECUTE` / `DEALLOCATE`. Cursors (`DECLARE` / `FETCH` / `MOVE` / `CLOSE`). `EXPLAIN` (option list and legacy forms), `ANALYZE`, `VACUUM`.

### Compared with node-sql-parser

The battery in `pg-coverage.ts` has 599 distinct statements, all syntactically valid in PostgreSQL 17 (a few need 17 rather than 16). They cover the command reference and the query and expression chapters, from everyday idioms (upserts, pagination, `date_trunc` reports, pg_dump-style DDL) to the long tail. Each statement goes through `sqlLite.parse(sql)` and node-sql-parser 5.1.0's `new Parser().astify(sql, { database: "PostgreSQL" })`:

| Area | Statements | Both | sql-lite only | node-sql-parser only | Neither |
|---|---:|---:|---:|---:|---:|
| Queries | 93 | 58 | 30 | 2 | 3 |
| Expressions | 87 | 47 | 21 | 4 | 15 |
| Types and lexical | 34 | 17 | 11 | 3 | 3 |
| DML | 77 | 32 | 35 | 6 | 4 |
| Transactions and session | 70 | 17 | 33 | 0 | 20 |
| Utility and maintenance | 35 | 2 | 21 | 0 | 12 |
| Tables and indexes | 84 | 13 | 40 | 2 | 29 |
| Other schema objects | 93 | 15 | 37 | 3 | 38 |
| Roles and privileges | 26 | 8 | 6 | 0 | 12 |
| **Total** | **599** | **209** | **234** | **20** | **136** |

So sql-lite accepts 443 of the 599 statements (74%) and node-sql-parser accepts 229 (38%). "Accepts" means "parses without throwing". It is a necessary condition for a correct AST, not a sufficient one. The known cases where sql-lite parses a statement into the wrong tree are listed [below](#known-wrong-asts).

The test fails if any statement changes bucket. To print the table above:

```sh
PG_COVERAGE_REPORT=1 pnpm vitest run examples/sql-lite/pg-coverage.test.ts
```

### Not yet supported

These are roughly ordered by how often real SQL hits them. Every item has a failing statement in the battery or was confirmed in a separate run.

**Lexical**

- **Comments inside a statement.** Comments are only trivia *between* statements: `SELECT id, -- primary key` followed by a line break fails, as does `SELECT /* note */ 1;`. This is the most common real-world failure.
- Numbers with a trailing dot (`5.`, `1.e3`).

**Statements**

- `CREATE` / `ALTER` / `DROP POLICY`, `ALTER DEFAULT PRIVILEGES`, `ALTER ROLE` / `ALTER USER`, `CREATE GROUP`, `DROP OWNED`, `REASSIGN OWNED`.
- `REINDEX`, `CLUSTER`, `CHECKPOINT`, `LOAD`.
- `LISTEN` / `NOTIFY` / `UNLISTEN`, `DISCARD`.
- `SET TRANSACTION`, `SET SESSION CHARACTERISTICS`, `SET CONSTRAINTS`, `SET` / `RESET SESSION AUTHORIZATION`, `SET … FROM CURRENT`, multi-word `SHOW TRANSACTION ISOLATION LEVEL`.
- `END` and `ABORT` (the transaction synonyms), and two-phase commit (`PREPARE TRANSACTION`, `COMMIT PREPARED`, `ROLLBACK PREPARED`).
- `ALTER DATABASE`, `ALTER EXTENSION`, `ALTER PROCEDURE`, `ALTER TABLESPACE`, `ALTER TRIGGER`, `ALTER SYSTEM`, `DROP TABLESPACE`.
- Some actions on objects that are otherwise supported: `ALTER INDEX … ATTACH PARTITION`, `ALTER MATERIALIZED VIEW … SET TABLESPACE`, `ALTER TYPE … ADD / DROP ATTRIBUTE`, and the shell type `CREATE TYPE name;`.
- `COMMENT ON` anything but a table, column, index, type or schema (views, functions, constraints, triggers, roles, extensions, …).
- The `TABLE name` command.
- The long tail: `RULE`, `EVENT TRIGGER`, `PUBLICATION`, `SUBSCRIPTION`, `CAST`, `COLLATION`, `CONVERSION`, `OPERATOR [CLASS | FAMILY]`, `SERVER`, `USER MAPPING`, `FOREIGN TABLE`, `IMPORT FOREIGN SCHEMA`, `STATISTICS`, `TEXT SEARCH …`, `LANGUAGE`, `ACCESS METHOD`, `TRANSFORM`, `SECURITY LABEL`.
- `USE db` is a MySQL-ism with no PostgreSQL equivalent. It is rejected **on purpose**, and `pg-coverage.test.ts` pins that.

**Clauses**

- **`DEFAULT <expr>` followed by `NOT NULL`**, as in `id integer DEFAULT nextval('s'::regclass) NOT NULL`. pg_dump emits this for nearly every table. `DEFAULT` takes a full expression, so the `NOT` is read as the start of `NOT LIKE` / `NOT IN`. (Other constraints after `DEFAULT` work.)
- **`ONLY`** on `ALTER TABLE`, `UPDATE`, `DELETE`, `TRUNCATE` and `CREATE INDEX … ON ONLY`. pg_dump emits `ALTER TABLE ONLY`. `SELECT … FROM ONLY`, `MERGE INTO ONLY` and `LOCK ONLY` work.
- **`ALTER TABLE`:**
  - `ADD CONSTRAINT … NOT VALID`
  - `[ENABLE | DISABLE | FORCE | NO FORCE] ROW LEVEL SECURITY`
  - `ALTER COLUMN … TYPE … USING`
  - `DROP COLUMN IF EXISTS` and `DROP COLUMN … CASCADE`
  - identity sub-commands (`ADD GENERATED`, `SET GENERATED`, `RESTART`, `DROP IDENTITY`)
  - `SET STATISTICS`, `SET STORAGE`, `SET COMPRESSION`, `DROP EXPRESSION`
  - `SET LOGGED` / `SET UNLOGGED`, `[NO] INHERIT`, `ALTER CONSTRAINT`
  - `UNIQUE USING INDEX`
  - `ALTER TABLE ALL IN TABLESPACE`
- **Constraints:**
  - named column constraints (`qty int CONSTRAINT qty_pos CHECK (…)`; named *table* constraints work)
  - `UNIQUE NULLS NOT DISTINCT`, on a constraint and on `CREATE UNIQUE INDEX`
  - `INCLUDE`, `WITH` and `USING INDEX TABLESPACE` on `UNIQUE` / `PRIMARY KEY`
  - `ON DELETE SET NULL (cols)`
  - `CHECK … NO INHERIT`
- **Other `CREATE TABLE` options:** `COMPRESSION` / `STORAGE` on a column, typed tables (`OF type`), `USING heap`, `WITHOUT OIDS`, `CREATE TABLE … AS TABLE` / `AS EXECUTE`.
- `TABLESPACE` on `CREATE INDEX` and `CREATE MATERIALIZED VIEW` (`CREATE TABLE … TABLESPACE` works).
- **`ON CONFLICT` targets that aren't plain columns:** expressions, a partial-index `WHERE`, or `COLLATE`.
- **`UPDATE` targets:** `SET col = DEFAULT` (the multi-column form accepts `DEFAULT`), and subscript or field targets (`SET arr[1] = …`).
- `WHERE CURRENT OF cursor` on `UPDATE` and `DELETE`.
- Legacy `COPY` options without parentheses (`COPY t FROM STDIN CSV HEADER`).
- `GRANT` / `REVOKE … ON FUNCTION f(argtypes)`. It works without the argument list. Also missing: `GRANTED BY`, and the PostgreSQL 16 `WITH INHERIT / SET` role options.
- **Routine bodies and triggers:** SQL-standard function bodies (`RETURN expr`, `BEGIN ATOMIC … END`), trigger `REFERENCING OLD / NEW TABLE`, `CREATE CONSTRAINT TRIGGER`.
- **Views:** `CREATE RECURSIVE VIEW`, `CREATE TEMP VIEW`.
- Column definition lists for record-returning functions (`FROM json_to_record(…) AS x(a int, b text)`).
- `JOIN … USING (…) AS alias`, the legacy inheritance `*` after a table name, and the empty select list `SELECT;`.

**Expressions**

- `ARRAY(subquery)` and nested `ARRAY[[…], […]]` constructors.
- The `&&` overlap operator, and operators outside the fixed table: `<->`, `-|-`, `&<`, `^@`, prefix `|/` / `||/` / `@` / `~`, and `OPERATOR(schema.op)`.
- `LIKE` / `ILIKE` with `ANY` / `ALL`.
- Field selection from a composite value: `(row_value).field`, `(f()).*`.
- The postfix `ISNULL` / `NOTNULL` operators. The select-list form `a ISNULL` reads as an alias; see below.
- `:=` named arguments (`=>` works), `VARIADIC` arguments, `count(ALL x)`.
- SQL/JSON clause syntax: `JSON_OBJECT('a' VALUE 1)`, `JSON_VALUE(… RETURNING int)`, `JSON_TABLE(… COLUMNS (…))`. The plain-argument forms parse as ordinary calls.
- XML keyword functions (`XMLELEMENT(NAME …)`, `XMLPARSE(DOCUMENT …)`) and `IS [NFC] NORMALIZED`. (`normalize(x, NFC)` parses as an ordinary call, with `nfc` read as a column name.)
- `substring(… SIMILAR … ESCAPE …)` and PostgreSQL 17's `AT LOCAL`.

**Types**

- Typed literals for types other than `date`, `time`, `timestamp` and `interval`: `jsonb '{}'`, `timestamptz '…'`, `uuid '…'`, `int4 '42'`, … (The `'…'::type` cast works for every type.)
- The `int ARRAY` / `int ARRAY[3]` spelling (`int[]` works).
- Interval precision: `interval(3) '1 s'`, `INTERVAL '1' SECOND(3)`.

### Known wrong ASTs

These statements parse without error, but the tree they produce is wrong:

- **`-2 ^ 2` parses as `-(2 ^ 2)`.** In PostgreSQL, unary minus binds tighter than `^`, so the value is 4, not -4.
- **`NATURAL` is dropped.** `a NATURAL JOIN b` yields the same node as `a JOIN b` with no condition.
- **`WITH TIES` is dropped.** `FETCH FIRST 3 ROWS WITH TIES` yields the same `limit` as `FETCH FIRST 3 ROWS ONLY`.
- **`SELECT a ISNULL FROM t` reads `isnull` as a column alias.** PostgreSQL reads it as the null test.
- **`DEFAULT 'x' COLLATE "C"` folds the collation into the default expression** instead of applying it to the column.
- **Numeric literals become JavaScript numbers,** so integers beyond 2^53 lose precision (`12345678901234567890`).

### Accepted, but PostgreSQL rejects

The grammar is deliberately more permissive than PostgreSQL in places. These inputs are syntax errors in PostgreSQL but parse here:

- **`DEFAULT` accepts a full expression.** PostgreSQL's restricted form doesn't allow `DEFAULT 5 IS NULL`, `DEFAULT a = 1 AND b`, and so on.
- **Joins with no condition:** `a JOIN b` without `ON` / `USING`, and `NATURAL CROSS JOIN`.
- **Repeated or conflicting row limits:** `LIMIT 1 LIMIT 2`, `LIMIT … FETCH FIRST …`. Also `WITH TIES` with no `ORDER BY`.
- **Window frames PostgreSQL rejects:** `ROWS BETWEEN CURRENT ROW AND UNBOUNDED PRECEDING`, `ROWS 1 FOLLOWING`.
- **Empty lists:** `IN ()`, `USING ()`, `VALUES ()`.
- **Subscripting a call without parentheses:** `f(x)[1]`. PostgreSQL requires `(f(x))[1]`.
- **Impossible type modifiers and interval ranges:** `x::int(4)`, `interval '1' DAY TO YEAR`.
- **Junk after a number:** `SELECT 123abc` reads as `123 AS abc`. PostgreSQL 15+ rejects it.
- **`UESCAPE` with no string after it:** `SELECT U&'x' uescape FROM t` reads `uescape` as an alias. PostgreSQL requires a string literal after `UESCAPE`.
- **`WITH ADMIN OPTION` / `ADMIN OPTION FOR` on object privileges.** Only role grants allow them.

Some errors PostgreSQL raises during analysis rather than parsing are also accepted: `VALUES` rows of different lengths, `ON CONFLICT DO UPDATE` without a conflict target, and four-part names like `a.b.c.d` (a cross-database reference). node-sql-parser also accepts the `ON CONFLICT` one.

## Benchmarks

Three bench files compare sql-lite with node-sql-parser 5.1.0 in PostgreSQL mode. **Every head-to-head group uses only input both parsers accept,** except the malformed-input group, whose inputs both parsers reject. `sql-lite.workloads.bench.ts` checks this at load time and refuses to run if either parser rejects a workload. PostgreSQL syntax that node-sql-parser rejects (`DELETE … RETURNING`, `FOR UPDATE SKIP LOCKED`, `ALTER TABLE … RENAME COLUMN`, …) is left out of the comparisons. A real application's SQL would include some of it.

### Real-world workloads (`sql-lite.workloads.bench.ts`)

| Workload | sql-lite ops/s | mean | node-sql-parser ops/s | mean | Relative |
|---|---:|---:|---:|---:|---|
| OLTP mix: 16 statements, one `parse` call each | 817 | 1.22 ms | 227 | 4.41 ms | sql-lite 3.61× faster |
| Analytics report: 2 CTEs, 3 window functions, 3 joins, `CASE` | 1,180 | 0.85 ms | 361 | 2.77 ms | sql-lite 3.27× faster |
| Migration script: 19 DDL statements in one 1.6 KB file | 1,048 | 0.95 ms | 285 | 3.51 ms | sql-lite 3.68× faster |
| Bulk `INSERT`: 10,000 rows of 5 values, 406.5 KB | 1.80 | 557 ms | 2.31 | 432 ms | node-sql-parser 1.29× faster |
| Wide `SELECT`: 1,000 columns, 21.3 KB | 38.6 | 25.9 ms | 12.9 | 77.3 ms | sql-lite 2.98× faster |
| Malformed input: 8 statements, every one throws | 2,213 | 0.45 ms | 468 | 2.14 ms | sql-lite 4.73× faster |

The bulk `INSERT` is the one workload where node-sql-parser wins. Nearly all of that input is literals and commas, so the work is per token, and sql-lite costs roughly 55 µs per 5-value row. That cost is linear: a separate scaling run from 1,250 to 20,000 rows showed no superlinear growth. Malformed input shows the widest gap.

### Statement corpus and large files

| Group | sql-lite ops/s | node-sql-parser ops/s | Relative |
|---|---:|---:|---|
| Whole shared corpus (28 statements) | 662 | 162 | 4.07× |
| `select` (5) | 4,859 | 1,441 | 3.37× |
| `select-adv` (4) | 4,534 | 1,049 | 4.32× |
| `cte` (2) | 7,879 | 3,114 | 2.53× |
| `dml` (4) | 5,091 | 2,119 | 2.40× |
| `ddl` (6) | 3,159 | 925 | 3.42× |
| `expr` (7) | 3,520 | 865 | 4.07× |
| 64 KB file (1,722 statements) | 11.0 | 4.23 | 2.60× |
| 256 KB file (6,889 statements) | 3.01 | 0.97 | 3.09× |
| 1 MB file (27,557 statements) | 0.73 | 0.25 | 2.98× |

"Relative" is sql-lite's speed-up over node-sql-parser.

### Methodology

- These are [vitest bench](https://vitest.dev/guide/features.html#benchmarking) (tinybench) results: ops/s is iterations of the whole group body per second, and mean is the time per iteration.
- Each workload is built once at module load. Generated inputs are deterministic (no `Math.random`), so every run parses identical text.
- Both parsers are called the way an application would call them: `sqlLite.parse(sql)` against `new Parser().astify(sql, { database: "PostgreSQL" })`, with one `Parser` instance reused.
- **Recorded on:** 2026-10-22, with Node 22.22.0, vitest 3.2.7 and node-sql-parser 5.1.0. The machine was a Linux container with 4 vCPUs (Intel Xeon @ 2.80 GHz) and 15 GB RAM.
- The run was one `pnpm bench` with nothing else running. Absolute numbers move with machine load, so trust the ratios over raw ops/s. Variance (`rme`) stayed within ±5% for most groups. The bulk `INSERT`, the wide `SELECT` and the 64 KB and 256 KB files ranged from ±6% to ±11%.

### Running them

```sh
pnpm bench                                                          # every bench file
pnpm vitest bench --run examples/sql-lite/sql-lite.workloads.bench.ts   # just the workloads
pnpm bench:compare                                                  # diff against bench-baseline.json
```

The committed `bench-baseline.json` currently covers only `sql-lite.bench.ts`, the per-construct corpus whose deltas track grammar changes. The large-file and workload groups aren't in it, so `bench:compare` prints them without a delta. The next `pnpm bench:save` will add them, because it runs every bench file. Benchmarks don't run in CI.

## Contributing

The repo-wide workflow is in [CONTRIBUTING.md](../../CONTRIBUTING.md). Specific to this grammar:

- **Tests first, at the level the change lives.** New syntax gets a `describe` block in `sql-lite.test.ts` asserting the span-stripped AST with `toEqual`, plus the error message for the nearest malformed input.
- **Prove new keywords stay unreserved.** PostgreSQL leaves most keywords usable as names, and so does this grammar: only the words in `RESERVED` are refused as bare names. Every feature that matches a new word by value comes with a "keeps … unreserved as names and aliases" test showing the word still works as a column, table and alias (for example `SELECT rows, ordinality FROM t AS rows;`). Don't add to `RESERVED` to make a parse work.
- **Pin observable output in the parity golden.** `parity.test.ts` serialises the full AST, spans included, for every `corpus.ts` row and its own `SUPPLEMENTAL` / `MULTI_LINE` / `LEXER_EDGE_CASES` lists, plus `diagnose()` output for `MALFORMED`. New node shapes go in `SUPPLEMENTAL`, not `corpus.ts`: the benchmark's group names count the corpus's shared rows, `bench-baseline.json` keys on those names, and a new `pg: true` corpus row renames them, which silently disconnects `pnpm bench:compare`. When output is *meant* to move, regenerate with `pnpm test -- -u` (the `--` matters) and call the diff out in review. Never regenerate to make a refactor pass.
- **Update the coverage battery.** If a change makes a `pg-coverage.ts` statement parse (or stop parsing), `pg-coverage.test.ts` fails with an `expected -> actual` line per moved row. Update the row's bucket, re-print the table with `PG_COVERAGE_REPORT=1`, and update the numbers in this README. Update the "Not yet supported", "Known wrong ASTs" and "Accepted, but PostgreSQL rejects" lists too: they aren't pinned by any test.
