import { readdirSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { ParseError } from "@parser-kit/core";
import { formatSqlError, loadModule, parseSync, SqlError } from "libpg-query";
import { beforeAll, describe, expect, it } from "vitest";
import type { Stmt } from "../src/postgres/ast";
import { postgres } from "../src/postgres/index";
import { NotPrintableError, type StringifyOptions, stringify } from "../src/postgres/print/index";
import { CORPUS } from "./corpus";
import { COMMENT_CASES, withComments } from "./format-cases";
import { LEXER_EDGE_CASES, MALFORMED, MULTI_LINE, SUPPLEMENTAL } from "./parity-corpus";
import { PG_BATTERY } from "./pg-coverage";
import { splitPsqlScript } from "./psql-split";
import * as dml from "./stringify-cases/dml";
import * as objects from "./stringify-cases/objects";
import * as query from "./stringify-cases/query";
import * as roles from "./stringify-cases/roles";
import * as tables from "./stringify-cases/tables";

// --- differential test against libpg_query ---
//
// `libpg-query` (pinned in the workspace catalog) is PostgreSQL 17's own raw
// parser, libpg_query, compiled to WebAssembly. It is the oracle for two
// properties over the corpus: the benchmark corpus, the parity lists
// (`MALFORMED` included), every PostgreSQL coverage battery row (accepted or
// not), every statement of the pg_dump fixtures (parsing or not) and each
// printer family's cases.
//
//   1. Parser agreement. `postgres.parse` accepts a source exactly when
//      PostgreSQL's grammar does, and when both accept it they find the same
//      number of statements.
//   2. Printer meaning-preservation. For every statement the printer can
//      print, PostgreSQL parses the printed SQL to the same tree as the
//      original source, at every layout in `OPTIONS`. Our own round-trip test
//      (`stringify.test.ts`) compares our trees, so it can't see a meaning our
//      parser and printer both get wrong; this compares PostgreSQL's.
//      Statements whose kind isn't printable yet throw `NotPrintableError` and
//      are counted as skipped, so coverage grows by itself as statement
//      families land. Sources of more than one statement are also printed
//      whole, with the statements' separators.
//   3. Formatter meaning-preservation. `postgres.format` of every source both
//      parsers accept, as written and with a comment before every token (plus
//      the comment cases), gives PostgreSQL the same statement trees at every
//      layout, comments and all.
//
// The comparison is of libpg_query's full JSON parse tree for each statement,
// not its fingerprint: a fingerprint ignores constants, which would hide `1.0`
// becoming `1`. The statement wrapper (`RawStmt`, with its offset and length)
// is dropped, and so is every numeric `location` / `*_location` field, which
// is a byte offset. Nothing else is rewritten. (`CREATE TABLESPACE`'s
// `location` is the directory, a string, and is kept.)
//
// Where the two deliberately disagree, the source is listed in
// `PARSER_DIFFERENCES` or `PRINTER_DIFFERENCES` with its reason. A printer
// entry names every path where the trees differ, and must match exactly at
// every layout, so the rest of the statement is still checked, and its source must
// still be in the corpus and printable, so an entry can't go stale; a parser
// entry that stops holding fails too. Nothing is skipped
// silently: a new disagreement is either a bug to fix or a new entry.
// `LIBPG_QUERY_REPORT=1` prints the counts.

// The pg_dump fixtures' statements, split as psql would, parsing or not.
const DUMP_STATEMENTS = readdirSync(new URL("./fixtures/pg-dump/", import.meta.url))
  .filter((file) => file.endsWith(".sql"))
  .flatMap(
    (file) => splitPsqlScript(readFileSync(new URL(`./fixtures/pg-dump/${file}`, import.meta.url), "utf8")).statements,
  )
  .map((statement) => statement.sql);

/** The one pg_dump statement that starts with `head`. */
function dumpStatement(head: string): string {
  const [match, ...more] = DUMP_STATEMENTS.filter((sql) => sql.startsWith(head));
  if (match === undefined || more.length > 0) throw new Error(`Expected one pg_dump statement starting ${head}`);
  return match;
}

/** A source where `postgres.parse` and PostgreSQL deliberately disagree on acceptance. */
type ParserDifference = { sql: string; acceptedBy: "ours" | "postgres"; reason: string };

const NOT_YET_SUPPORTED = "Not supported yet (README: Not yet supported).";
const IGNORE_NULLS =
  "IGNORE / RESPECT NULLS on a window function (the `nullTreatment` node) is not in PostgreSQL 17's grammar; this grammar parses it.";
const RELOPTIONS =
  "CREATE TABLE's WITH (…) takes the general option shape COPY's options use, so `x -1`, `force_quote *` and `force_null (a, 'b')` parse there; PostgreSQL's reloptions take only `name [= value]`.";
const QUALIFIED_OPTIONS =
  "COPY's and utility statements' (…) option lists take the general option shape, so a qualified name (`toast.x`) and a number in a value list (`list ('a', 2)`) parse; PostgreSQL's take neither.";
const EMPTY_AGGREGATE_SIGNATURE =
  "CREATE AGGREGATE takes an empty `()` signature before its definition list; PostgreSQL has none (a zero-argument aggregate is `(*)`, and the old-style form has no signature at all).";

// Each "ours" entry is in the README's "Accepted, but PostgreSQL rejects" list.
const PARSER_DIFFERENCES: ParserDifference[] = [
  {
    sql: dumpStatement("CREATE TABLE public.film ("),
    acceptedBy: "ours",
    reason: "PostgreSQL 18's GENERATED ALWAYS AS (…) VIRTUAL column; PostgreSQL 17 requires STORED.",
  },
  {
    sql: "SELECT a || b, c @> d, x::int, $1, $name FROM t;",
    acceptedBy: "ours",
    reason: "Named parameters (`$name`) are kept for templated SQL; PostgreSQL only has positional ones.",
  },
  {
    sql: "SELECT U&'it''s' uescape, b, x, u FROM t;",
    acceptedBy: "ours",
    reason: "`uescape` with no string after it is read as an alias.",
  },
  { sql: "SELECT lag(x) IGNORE NULLS OVER (ORDER BY id) FROM t;", acceptedBy: "ours", reason: IGNORE_NULLS },
  { sql: "SELECT count(x) RESPECT NULLS FILTER (WHERE x) OVER () FROM t;", acceptedBy: "ours", reason: IGNORE_NULLS },
  {
    sql: "SELECT count(*) FILTER (WHERE a) OVER (), lag(a) IGNORE NULLS OVER w, first_value(a) RESPECT NULLS OVER (w) FROM t WINDOW w AS (ORDER BY a USING <);",
    acceptedBy: "ours",
    reason: IGNORE_NULLS,
  },
  {
    sql: "CREATE TABLE t (id int) WITH (fillfactor = 70, autovacuum_enabled, x -1, y = 'z') ON COMMIT DELETE ROWS TABLESPACE ts;",
    acceptedBy: "ours",
    reason: RELOPTIONS,
  },
  {
    sql: "CREATE TABLE t (id int) WITH (toast.autovacuum_enabled = false, force_quote *, force_null (a, 'b'));",
    acceptedBy: "ours",
    reason: RELOPTIONS,
  },
  { sql: "CREATE TABLE t (a int) WITH (y = (a, 'b', -0))", acceptedBy: "ours", reason: RELOPTIONS },
  {
    sql: 'SELECT a BETWEEN b COLLATE "C" AND c, a BETWEEN SYMMETRIC 1 AND 2, a NOT BETWEEN ASYMMETRIC b + 1 AND c;',
    acceptedBy: "ours",
    reason:
      'BETWEEN\'s lower bound is a b_expr in PostgreSQL, which has no COLLATE; this grammar takes `b COLLATE "C"` there.',
  },
  {
    sql: "SELECT B'12' FROM t;\nSELECT 1;",
    acceptedBy: "postgres",
    reason:
      "PostgreSQL's lexer takes any characters in B'…' and checks the digits only when the value is read; this lexer rejects a digit other than 0 or 1 while lexing (a MALFORMED row).",
  },
  {
    sql: `ALTER VIEW v SET (x = (1, 'b', on, true, -2), y = *, toast.z = "Off")`,
    acceptedBy: "ours",
    reason: RELOPTIONS,
  },
  {
    sql: 'CREATE AGGREGATE agg () ("Odd" = f, SFUNC = f, STYPE = int)',
    acceptedBy: "ours",
    reason: EMPTY_AGGREGATE_SIGNATURE,
  },
  {
    sql: "CREATE AGGREGATE agg () (HYPOTHETICAL, SFUNC = f, STYPE = int)",
    acceptedBy: "ours",
    reason: EMPTY_AGGREGATE_SIGNATURE,
  },
  { sql: "CLUSTER (x.verbose)", acceptedBy: "ours", reason: QUALIFIED_OPTIONS },
  { sql: "COPY binary t FROM STDIN (toast.header)", acceptedBy: "ours", reason: QUALIFIED_OPTIONS },
  {
    sql: "COPY t TO STDOUT (format csv, \"Odd\" 'x', toast.x 1, list ('a', 2, -3, true), w true, n \"true\", s 'it''s')",
    acceptedBy: "ours",
    reason: QUALIFIED_OPTIONS,
  },
  {
    sql: "COPY binary FROM STDIN",
    acceptedBy: "ours",
    reason: "`COPY binary FROM stdin` copies a table named `binary`; BINARY is a type_func_name keyword in PostgreSQL.",
  },
  // Battery rows recorded as rejected here: statements not supported yet.
  { sql: "ALTER SYSTEM SET work_mem = '64MB';", acceptedBy: "postgres", reason: NOT_YET_SUPPORTED },
  {
    sql: "ALTER TABLE users ADD CONSTRAINT users_email_key UNIQUE USING INDEX users_email_idx;",
    acceptedBy: "postgres",
    reason: NOT_YET_SUPPORTED,
  },
  {
    sql: "ALTER TYPE address_type ADD ATTRIBUTE country text, DROP ATTRIBUTE IF EXISTS zip;",
    acceptedBy: "postgres",
    reason: NOT_YET_SUPPORTED,
  },
  {
    sql: "CREATE RULE no_delete AS ON DELETE TO users DO INSTEAD NOTHING;",
    acceptedBy: "postgres",
    reason: NOT_YET_SUPPORTED,
  },
  {
    sql: "CREATE TRANSFORM FOR hstore LANGUAGE plpython3u (FROM SQL WITH FUNCTION hstore_to_plpython(internal), TO SQL WITH FUNCTION plpython_to_hstore(internal));",
    acceptedBy: "postgres",
    reason: NOT_YET_SUPPORTED,
  },
];

/**
 * A single-statement source whose printed SQL PostgreSQL parses to a
 * different tree: every path where the two trees differ, in order, and why
 * that is accepted. Any other difference in the statement still fails.
 */
type PrinterDifference = { sql: string; paths: string[]; reason: string };

const TARGETS = "$.0.SelectStmt.targetList";
const DO_PATHS = [0, 1].flatMap((i) => [
  `$.0.DoStmt.args.${i}.DefElem.defname`,
  `$.0.DoStmt.args.${i}.DefElem.arg.String.sval`,
]);
const DO_ORDER =
  "Our tree keeps DO's language and body, not their order, and the printer writes `DO LANGUAGE l 'body'`. PostgreSQL's tree lists them in source order; the order means nothing.";

const PRINTER_DIFFERENCES: PrinterDifference[] = [
  // The roles family: spellings our tree doesn't tell apart, printed as the keyword form.
  {
    sql: 'ALTER ROLE "current_user" WITH LOGIN',
    paths: ["$.0.AlterRoleStmt.role.roletype", "$.0.AlterRoleStmt.role.rolename"],
    reason:
      'A quoted `"current_user"` gives the same tree as the CURRENT_USER pseudo-role (parseRoleSpec), and the printer writes the keyword. To PostgreSQL the quoted one is a role of that name.',
  },
  {
    sql: 'ALTER ROLE r SET "time zone" TO "local"',
    paths: ["$.0.AlterRoleSetStmt.setstmt.name"],
    reason:
      'A parameter quoted as `"time zone"` gives the same tree as SET TIME ZONE, and the printer writes the special form, which PostgreSQL reads as `timezone`.',
  },
  {
    sql: 'DROP TYPE "between", int, "int", "double precision", s.ty',
    paths: ["$.0.DropStmt.objects.2.TypeName.names"],
    reason:
      "A quoted `\"int\"` gives the same tree as `int` (the name's quoting isn't kept), and the printer writes the keyword type, which PostgreSQL reads as `pg_catalog.int4`.",
  },
  {
    sql: 'DROP DOMAIN "int", integer, "setof"',
    paths: ["$.0.DropStmt.objects.0.TypeName.names"],
    reason: 'A quoted `"int"`, as in the row above.',
  },
  {
    sql: "COMMENT ON LARGE OBJECT 1e400 IS 'x'",
    paths: ["$.0.CommentStmt.object.Float.fval"],
    reason:
      "A large object's number is kept as a JavaScript number, so one that overflows is Infinity and prints as `1e999`, which reads back as Infinity. PostgreSQL keeps the text, and rejects both as out of an oid's range.",
  },
  {
    sql: "SECURITY LABEL ON LARGE OBJECT -1e400 IS 'x'",
    paths: ["$.0.SecLabelStmt.object.Float.fval"],
    reason: "An overflowing large object number, as in the row above.",
  },
  {
    sql: "GRANT SELECT ON LARGE OBJECT 1e400, -0 TO u",
    paths: ["$.0.GrantStmt.objects.0.Float.fval"],
    reason: "An overflowing large object number, as in the rows above.",
  },
  // Our tree loses the difference, and PostgreSQL resolves both to the same thing.
  {
    sql: "SELECT N'national', n'char';",
    paths: [`${TARGETS}.0.ResTarget.val.TypeCast.typeName.names`, `${TARGETS}.1.ResTarget.val.TypeCast.typeName.names`],
    reason:
      "`N'…'` is a typedLiteral of type `bpchar` (README: AST conventions), printed `bpchar '…'`. PostgreSQL's tree has `pg_catalog.bpchar` for the source and `bpchar` for the print, which the search path resolves to the same type.",
  },
  {
    sql: "SELECT 'it''s', E'a\\nb', 'tab\there', '', N'x', B'101', X'ff', 1.50, 5., 1e2, 0x1F, .5;",
    paths: [`${TARGETS}.4.ResTarget.val.TypeCast.typeName.names`],
    reason: "`N'x'`, as in the row above.",
  },
  {
    sql: `SELECT "interval" '1', a::"interval", a::"between", "row" 'x';`,
    paths: [`${TARGETS}.1.ResTarget.val.TypeCast.typeName.names`],
    reason:
      "A cast to `\"interval\"` gives the same tree as one to `interval` (the grammar's KEYWORD_TYPE_NAMES leaves it out, since both name one type), and the printer writes the keyword. PostgreSQL's tree has a bare `interval` for the source and `pg_catalog.interval` for the print, which the search path resolves to the same type.",
  },
  {
    sql: "SELECT * FROM t LIMIT ALL;",
    paths: ["$.0.SelectStmt.limitCount", "$.0.SelectStmt.limitOption"],
    reason:
      "LIMIT ALL gives `limit: null`, the same tree as no LIMIT, so it prints as no LIMIT. PostgreSQL's tree has LIMIT NULL (an `isnull` constant) for the source, which also means no limit.",
  },
  {
    sql: "SELECT '{}'::int[3], '{}'::text[][];",
    paths: [
      `${TARGETS}.0.ResTarget.val.TypeCast.typeName.arrayBounds.0.Integer.ival`,
      `${TARGETS}.1.ResTarget.val.TypeCast.typeName.arrayBounds`,
    ],
    reason:
      "A type's array sizes and dimension count aren't in our tree (`array: true`), so `int[3]` and `text[][]` print as `int[]` and `text[]`. PostgreSQL ignores both, so the meaning is the same.",
  },
  {
    sql: "COPY t FROM STDIN DELIMITERS '|' WITH (header)",
    paths: ["$.0.CopyStmt.options.1.DefElem.arg"],
    reason:
      "A legacy COPY keeps its options in one list whose `header` has no value, whether written `(header)` or as the bare word, and the printer writes every option as a bare word it can (`DELIMITER '|' HEADER`). PostgreSQL's tree has no argument for `(header)` and `true` for HEADER, which mean the same.",
  },
  {
    sql: "DO 'SELECT 1' LANGUAGE \"My Lang\"",
    paths: DO_PATHS,
    reason: DO_ORDER,
  },
  {
    sql: "DO $$ SELECT 1 $$ LANGUAGE sql;",
    paths: DO_PATHS,
    reason: DO_ORDER,
  },
  {
    sql: "CREATE TABLE t (a varchar(10), b numeric(10, 2), c int[], d text[][]);",
    paths: ["$.0.CreateStmt.tableElts.3.ColumnDef.typeName.arrayBounds"],
    reason: "A type's dimension count isn't in our tree, as in the row above.",
  },
  {
    sql: "CREATE TABLE arr (tags text[], matrix int[][], scores integer ARRAY[3], b bit varying(8), iv interval day to second(3));",
    paths: [
      "$.0.CreateStmt.tableElts.1.ColumnDef.typeName.arrayBounds",
      "$.0.CreateStmt.tableElts.2.ColumnDef.typeName.arrayBounds.0.Integer.ival",
    ],
    reason: "A type's array sizes and dimension count aren't in our tree, as in the row above.",
  },
  {
    sql: 'CREATE INDEX i ON t (nulls NULLS FIRST, a nulls, (x) "asc")',
    paths: ["$.0.IndexStmt.indexParams.2.IndexElem.expr", "$.0.IndexStmt.indexParams.2.IndexElem.name"],
    reason:
      "An index element `(x)` gives the same tree as the column `x`, which the printer writes. PostgreSQL's tree has an expression for the source, but it indexes an expression that is a plain column as that column.",
  },
  {
    sql: "CREATE STATISTICS (mcv) ON (a::int), (b) FROM t",
    paths: ["$.0.CreateStatsStmt.exprs.1.StatsElem.expr", "$.0.CreateStatsStmt.exprs.1.StatsElem.name"],
    reason:
      "A parenthesised column `(b)` gives the same tree as the column `b`, which the printer writes. PostgreSQL's tree has an expression element for the source and a column element for the print; CREATE STATISTICS stores both as the column (same `stxkeys`, no `stxexprs`, checked on PostgreSQL 16).",
  },
  // Printer known limits: real meaning changes our tree can't express.
  {
    sql: 'CREATE INDEX i ON t USING gist (a gist_trgm_ops (siglen = 32), (a + b), (c COLLATE "C"), (d::text) DESC, (e IS NULL))',
    paths: [
      "$.0.IndexStmt.indexParams.2.IndexElem.expr",
      "$.0.IndexStmt.indexParams.2.IndexElem.name",
      "$.0.IndexStmt.indexParams.2.IndexElem.collation",
    ],
    reason:
      'An index element `(c COLLATE "C")` gives the same tree as `c COLLATE "C"`, and the printer writes the second: the column with its own collation, where PostgreSQL indexes the first as an expression.',
  },
  {
    sql: "ALTER FUNCTION f(int) SET schema = 'x'",
    paths: ["$.0.AlterFunctionStmt.actions.0.DefElem.arg.VariableSetStmt.name"],
    reason:
      "A generic SET of a parameter named `schema` gives the same tree as the SCHEMA form (`search_path`), which the printer writes: the form is the one that sets a real parameter, while PostgreSQL rejects `schema` as an unrecognised parameter when the statement runs.",
  },
  {
    sql: "(WITH a AS (SELECT 1) SELECT 2 ORDER BY 1) UNION SELECT 3;",
    paths: ["$.0.SelectStmt.larg.withClause", "$.0.SelectStmt.withClause"],
    reason:
      "Our tree gives `(WITH a … SELECT …) UNION …` and `WITH a … SELECT … UNION …` the same shape, and the printer writes the second, which scopes the CTE over every arm.",
  },
  {
    sql: 'SELECT "system_user", "current_catalog", "current_schema", "collation", "isnull" FROM "similar" AS "full";',
    paths: [0, 1, 2].flatMap((i) => [
      `${TARGETS}.${i}.ResTarget.val.ColumnRef`,
      `${TARGETS}.${i}.ResTarget.val.${["FuncCall", "SQLValueFunction", "SQLValueFunction"][i]}`,
    ]),
    reason:
      "A lone quoted `system_user` / `current_catalog` / `current_schema` column gives the same tree as the bare SQL function, which the printer writes.",
  },
];

// Each source once, though some sit in more than one list.
const SOURCES = [
  ...new Set([
    ...[query, dml, tables, objects, roles].flatMap((family) => family.cases),
    ...CORPUS.map((sample) => sample.sql),
    ...SUPPLEMENTAL,
    ...MULTI_LINE,
    ...LEXER_EDGE_CASES,
    ...MALFORMED,
    ...PG_BATTERY.map((row) => row.sql),
    ...DUMP_STATEMENTS,
  ]),
];

// The layouts compared: the default (one line), width 80 (the goldens' width),
// a narrow width, width 1 (every break the layout allows, where a break the
// lexer reads as meaning would show), and the non-default lexical options.
const OPTIONS: StringifyOptions[] = [
  {},
  { width: 80 },
  { width: 40 },
  { width: 1 },
  { width: 40, keywordCase: "lower", identifierQuote: "always", strings: "escape" },
];

/** `value` without its positions: every numeric `location` / `*_location` field, recursively. */
const normalise = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalise);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    const positional = (key === "location" || key.endsWith("_location")) && typeof field === "number";
    if (!positional) out[key] = normalise(field);
  }
  return out;
};

/** PostgreSQL's statement trees for `sql`, positions removed; throws a `SqlError` when PostgreSQL rejects it. */
const pgTrees = (sql: string): unknown[] =>
  ((parseSync(sql) as { stmts?: { stmt: unknown }[] }).stmts ?? []).map((raw) => normalise(raw.stmt));

/** Whether `parse` returns; only the parse error `rejected` names counts as a rejection, anything else propagates. */
const accepts = (parse: () => unknown, rejected: abstract new (...args: never[]) => Error): boolean => {
  try {
    parse();
    return true;
  } catch (error) {
    if (error instanceof rejected) return false;
    throw error;
  }
};

/** One place two trees differ: its path, and the value on each side (undefined where absent). */
type Difference = { path: string; from: unknown; to: unknown };

/**
 * Every place `a` and `b` differ. Objects are compared key by key and arrays
 * of one length item by item; anything else that differs (arrays of different
 * lengths included) is one difference.
 */
const differences = (a: unknown, b: unknown, path = "$"): Difference[] => {
  if (isDeepStrictEqual(a, b)) return [];
  const bothObjects = a !== null && b !== null && typeof a === "object" && typeof b === "object";
  if (
    bothObjects &&
    Array.isArray(a) === Array.isArray(b) &&
    (!Array.isArray(a) || a.length === (b as unknown[]).length)
  ) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    return keys.flatMap((key) =>
      differences((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`),
    );
  }
  return [{ path, from: a, to: b }];
};

/**
 * What is wrong with `printed` as SQL for the statements whose trees are
 * `expected`: nothing (undefined) when PostgreSQL parses it to trees that
 * differ at exactly the `allowed` paths.
 */
const printedProblem = (expected: unknown[], printed: string, allowed: readonly string[] = []): string | undefined => {
  let got: unknown[];
  try {
    got = pgTrees(printed);
  } catch (error) {
    if (!(error instanceof SqlError)) throw error;
    return `PostgreSQL rejects it: ${formatSqlError(error, printed)}`;
  }
  const found = differences(expected, got);
  if (
    isDeepStrictEqual(
      found.map(({ path }) => path),
      allowed,
    )
  )
    return undefined;
  const lines = found.map(({ path, from, to }) => `${path}: ${JSON.stringify(from)} became ${JSON.stringify(to)}`);
  const listed = allowed.length > 0 ? `\n    listed: ${allowed.join(", ")}` : "";
  return `${lines.length > 0 ? lines.join("\n    ") : "no difference"}${listed}`;
};

const optionsLabel = (options: StringifyOptions): string =>
  JSON.stringify({ ...options, ...("width" in options && { width: String(options.width) }) });

beforeAll(async () => {
  await loadModule();
});

describe("libpg_query differential", () => {
  // The normalisation removes positions and nothing else: a constant's type,
  // parentheses that change grouping, a quoted name and a string `location`
  // all still show.
  it("compares trees without positions, keeping everything else", () => {
    const same = (a: string, b: string): boolean => isDeepStrictEqual(pgTrees(a), pgTrees(b));
    expect(same("SELECT  a   + 1 FROM t", "SELECT a+1\nFROM t")).toBe(true);
    expect(
      same(
        "SELECT * FROM JSON_TABLE(js, '$' AS root COLUMNS (a int))",
        "SELECT *\nFROM JSON_TABLE(\n  js, '$' AS root COLUMNS (a int))",
      ),
    ).toBe(true);
    expect(same("SELECT 1.0", "SELECT 1")).toBe(false);
    expect(same("SELECT a - (b - c)", "SELECT a - b - c")).toBe(false);
    expect(same('SELECT "A"', "SELECT A")).toBe(false);
    expect(same("SELECT a::int", "SELECT a::int4")).toBe(false);
    expect(same("CREATE TABLESPACE ts LOCATION '/a'", "CREATE TABLESPACE ts LOCATION '/b'")).toBe(false);
  });

  // An allowlisted source is still compared everywhere outside its listed
  // differences: a further change in it fails, and so does the listed
  // difference disappearing.
  it("holds an allowlisted source to exactly its listed differences", () => {
    const entry = PRINTER_DIFFERENCES.find(({ sql }) => sql.includes("1.50"));
    expect(entry).toBeDefined();
    const { sql, paths: allowed } = entry!;
    const expected = pgTrees(sql);
    const printed = stringify(postgres.parse(sql)[0]!);
    expect(printedProblem(expected, printed, allowed)).toBeUndefined();
    expect(printedProblem(expected, printed.replace("1.50", "1.5"), allowed)).toBeDefined();
    expect(printedProblem(expected, sql, allowed)).toBe(`no difference\n    listed: ${allowed.join(", ")}`);
    expect(printedProblem(expected, "SELECT FROM WHERE", allowed)).toMatch(/^PostgreSQL rejects it/);
  });

  it("accepts exactly what PostgreSQL accepts, with the same statement count", () => {
    const disagreements: string[] = [];
    const counts: string[] = [];
    let bothAccept = 0;
    let bothReject = 0;
    for (const sql of SOURCES) {
      const ours = accepts(() => postgres.parse(sql), ParseError);
      const theirs = accepts(() => parseSync(sql), SqlError);
      if (ours !== theirs) {
        disagreements.push(`${ours ? "ours" : "postgres"}: ${sql}`);
      } else if (!ours) {
        bothReject++;
      } else {
        bothAccept++;
        const [mine, pg] = [postgres.parse(sql).length, pgTrees(sql).length];
        if (mine !== pg) counts.push(`${mine} statements here, ${pg} in PostgreSQL: ${sql}`);
      }
    }
    const expected = PARSER_DIFFERENCES.map(({ sql, acceptedBy }) => `${acceptedBy}: ${sql}`);
    report(
      `parser: ${bothAccept} sources both accept, ${bothReject} both reject, ${disagreements.length} disagree (${expected.length} allowlisted)`,
    );
    expect(counts).toEqual([]);
    expect(disagreements.sort()).toEqual(expected.sort());
  });

  it("prints SQL that PostgreSQL parses to the same tree", () => {
    const allowed = new Map(PRINTER_DIFFERENCES.map((entry) => [entry.sql, entry.paths]));
    const compared = new Set<string>();
    const failures: string[] = [];
    let printed = 0;
    let differing = 0;
    let skipped = 0;
    let notCompared = 0;
    for (const sql of SOURCES) {
      let stmts: Stmt[];
      let expected: unknown[];
      try {
        stmts = postgres.parse(sql);
        expected = pgTrees(sql);
      } catch {
        notCompared++; // rejected by either parser: checked above
        continue;
      }
      if (stmts.length !== expected.length) {
        notCompared++; // a statement-count disagreement, checked above
        continue;
      }
      const listed = allowed.get(sql);
      if (listed !== undefined && stmts.length !== 1) {
        failures.push(`${sql}\n  a PRINTER_DIFFERENCES entry must be a single statement`);
        continue;
      }
      let whole = true;
      stmts.forEach((stmt, i) => {
        for (const options of OPTIONS) {
          let out: string;
          try {
            out = stringify(stmt, options);
          } catch (error) {
            if (error instanceof NotPrintableError) {
              skipped++;
              whole = false;
              return;
            }
            failures.push(`${sql}\n  ${optionsLabel(options)}: stringify threw ${String(error)}`);
            whole = false;
            return;
          }
          if (options === OPTIONS[0]) printed++;
          if (options === OPTIONS.at(-1) && listed !== undefined) compared.add(sql);
          const problem = printedProblem([expected[i]], out, listed);
          if (problem === undefined) continue;
          failures.push(`${sql}\n  ${optionsLabel(options)}\n    printed: ${out}\n    ${problem}`);
        }
        if (listed !== undefined) differing++;
      });
      // A source of several statements, printed whole with its separators.
      if (whole && stmts.length > 1) {
        const out = stringify(stmts);
        const problem = printedProblem(expected, out);
        if (problem !== undefined) failures.push(`${sql}\n  whole\n    printed: ${out}\n    ${problem}`);
      }
    }
    report(
      `printer: ${printed} statements printed, ${printed - differing} the same tree, ${differing} with listed differences; ${skipped} not printable yet; ${notCompared} sources not compared (a parser disagreement or rejected by both)`,
    );
    expect(failures).toEqual([]);
    // An entry whose source left the corpus, or is no longer printable, would
    // otherwise go unchecked.
    expect(PRINTER_DIFFERENCES.map(({ sql }) => sql).filter((sql) => !compared.has(sql))).toEqual([]);
  });

  it("formats SQL, comments and all, that PostgreSQL parses to the same trees", () => {
    const allowed = new Map(PRINTER_DIFFERENCES.map((entry) => [entry.sql, entry.paths]));
    const failures: string[] = [];
    let formatted = 0;
    for (const sql of [...SOURCES, ...COMMENT_CASES]) {
      let expected: unknown[];
      try {
        // COPY rows and meta-commands are psql's, not PostgreSQL's.
        const items = postgres.parseScript(sql);
        if (items.some((item) => item.kind === "psqlMeta" || (item.kind === "copy" && item.location.kind === "stdin")))
          continue;
        expected = pgTrees(sql);
        if (items.length !== expected.length) continue; // a statement-count disagreement, checked above
      } catch {
        continue; // rejected by either parser: checked above
      }
      for (const text of [sql, withComments(sql)]) {
        if (text === null) continue;
        formatted++;
        for (const options of OPTIONS) {
          const out = postgres.format(text, options);
          const problem = printedProblem(expected, out, allowed.get(sql));
          if (problem !== undefined)
            failures.push(`${text}\n  ${optionsLabel(options)}\n    formatted: ${out}\n    ${problem}`);
        }
      }
    }
    report(`format: ${formatted} sources formatted`);
    expect(formatted).toBeGreaterThan(2000);
    expect(failures).toEqual([]);
  });

  it("lists each source once", () => {
    for (const list of [PARSER_DIFFERENCES, PRINTER_DIFFERENCES]) {
      const sources = list.map(({ sql }) => sql);
      expect(sources.filter((sql, i) => sources.indexOf(sql) !== i)).toEqual([]);
    }
  });
});

function report(line: string): void {
  // eslint-disable-next-line no-console
  if (process.env.LIBPG_QUERY_REPORT) console.log(`[libpg_query] ${line}`);
}
