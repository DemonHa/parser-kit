import { readdirSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { loadModule, parseSync } from "libpg-query";
import { beforeAll, describe, expect, it } from "vitest";
import type { Stmt } from "../src/postgres/ast";
import { postgres } from "../src/postgres/index";
import { NotPrintableError, type StringifyOptions, stringify } from "../src/postgres/print/index";
import { CORPUS } from "./corpus";
import { LEXER_EDGE_CASES, MULTI_LINE, SUPPLEMENTAL } from "./parity-corpus";
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
// properties over the whole corpus: the benchmark corpus, the parity lists,
// every PostgreSQL coverage battery row (accepted or not), every statement of
// the pg_dump fixtures (parsing or not) and each printer family's cases.
//
//   1. Parser agreement. `postgres.parse` accepts a source exactly when
//      PostgreSQL's grammar does, and when both accept it they find the same
//      number of statements.
//   2. Printer meaning-preservation. For every statement the printer can
//      print, PostgreSQL parses the printed SQL to the same tree as the
//      original source. Our own round-trip test (`stringify.test.ts`) compares
//      our trees, so it can't see a meaning our parser and printer both get
//      wrong; this compares PostgreSQL's. Statements whose kind isn't printable
//      yet throw `NotPrintableError` and are counted as skipped, so coverage
//      grows by itself as statement families land.
//
// The comparison is of libpg_query's full JSON parse tree, not its
// fingerprint: a fingerprint ignores constants, which would hide `1.0`
// becoming `1`. The only thing normalised away is position: every
// `location` / `*_location` field and the statement's `stmt_location` /
// `stmt_len`. Nothing else is rewritten.
//
// Where the two deliberately disagree, the source is listed in
// `PARSER_DIFFERENCES` or `PRINTER_DIFFERENCES` with its reason, and the test
// checks that each listed difference still holds, so an entry can't go stale.
// Nothing is skipped silently: a new disagreement is either a bug to fix or a
// new entry. `LIBPG_QUERY_REPORT=1` prints the counts.

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
  "IGNORE / RESPECT NULLS on a window function (the `nullTreatment` node) is not in PostgreSQL 17's grammar; this grammar parses it. Not yet in the README's permissive list.";
const RELOPTIONS =
  "CREATE TABLE's WITH (…) takes the general option shape COPY's options use, so `x -1`, `force_quote *` and `force_null (a, 'b')` parse there; PostgreSQL's reloptions take only `name [= value]`. Not yet in the README's permissive list.";

const PARSER_DIFFERENCES: ParserDifference[] = [
  // Accepted here, rejected by PostgreSQL 17. README: "Accepted, but PostgreSQL rejects".
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
  // Accepted here, rejected by PostgreSQL 17, and not yet listed in the README.
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
  {
    sql: 'SELECT a BETWEEN b COLLATE "C" AND c, a BETWEEN SYMMETRIC 1 AND 2, a NOT BETWEEN ASYMMETRIC b + 1 AND c;',
    acceptedBy: "ours",
    reason:
      "BETWEEN's lower bound is a b_expr in PostgreSQL, which has no COLLATE; this grammar takes `b COLLATE \"C\"` there. Not yet in the README's permissive list.",
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

/** A source whose printed SQL PostgreSQL parses to a different tree, with why that is accepted. */
type PrinterDifference = { sql: string; reason: string };

const PG_CATALOG =
  "PostgreSQL's raw tree qualifies a type's keyword spelling with pg_catalog; our tree keeps the bare name, which the printer writes and PostgreSQL resolves to the same pg_catalog type through the search path.";

const PRINTER_DIFFERENCES: PrinterDifference[] = [
  // `N'…'` is a typedLiteral of type `bpchar` (README: AST conventions), printed `bpchar '…'`.
  { sql: "SELECT N'national', n'char';", reason: PG_CATALOG },
  {
    sql: "SELECT 'it''s', E'a\\nb', 'tab\there', '', N'x', B'101', X'ff', 1.50, 5., 1e2, 0x1F, .5;",
    reason: PG_CATALOG,
  },
  // A quoted `"interval"` gives the same tree as the bare word (the grammar's
  // KEYWORD_TYPE_NAMES leaves `interval` out because both name one type).
  { sql: `SELECT "interval" '1', a::"interval", a::"between", "row" 'x';`, reason: PG_CATALOG },
  {
    sql: "SELECT * FROM t LIMIT ALL;",
    reason:
      "LIMIT ALL gives `limit: null`, the same tree as no LIMIT, so it prints as no LIMIT; PostgreSQL keeps a null limitCount. The two mean the same.",
  },
  {
    sql: "SELECT '{}'::int[3], '{}'::text[][];",
    reason:
      "A type's array sizes and dimension count aren't in the tree (`array: true`), so `int[3]` and `text[][]` print as `int[]` and `text[]`. PostgreSQL ignores both, so the meaning is the same.",
  },
  // Printer known limits, each a real meaning change the tree can't express.
  {
    sql: "(WITH a AS (SELECT 1) SELECT 2 ORDER BY 1) UNION SELECT 3;",
    reason:
      "Known limit: the tree gives `(WITH a … SELECT …) UNION …` and `WITH a … SELECT … UNION …` the same shape, and the printer writes the second, which scopes the CTE over every arm.",
  },
  {
    sql: 'SELECT "system_user", "current_catalog", "current_schema", "collation", "isnull" FROM "similar" AS "full";',
    reason:
      "Known limit: a lone quoted `system_user` / `current_catalog` / `current_schema` column gives the same tree as the bare SQL function, which the printer writes.",
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
    ...PG_BATTERY.map((row) => row.sql),
    ...DUMP_STATEMENTS,
  ]),
];

// The layouts compared: one line, a narrow width, width 1 (every break the
// layout allows, where a break the lexer reads as meaning would show), and the
// non-default lexical options.
const OPTIONS: StringifyOptions[] = [
  { width: Number.POSITIVE_INFINITY },
  { width: 40 },
  { width: 1 },
  { width: 40, keywordCase: "lower", identifierQuote: "always", strings: "escape" },
];

const isPositional = (key: string): boolean => key === "location" || key.endsWith("_location") || key === "stmt_len";

/** `value` with every positional field removed, recursively. */
const normalise = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalise);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) if (!isPositional(key)) out[key] = normalise(field);
  return out;
};

/** PostgreSQL's statement trees for `sql`, positions removed; throws when PostgreSQL rejects it. */
const pgTrees = (sql: string): unknown[] =>
  ((parseSync(sql) as { stmts?: { stmt: unknown }[] }).stmts ?? []).map((raw) => normalise(raw.stmt));

const accepts = (parse: () => unknown): boolean => {
  try {
    parse();
    return true;
  } catch {
    return false;
  }
};

/** The path to the first place `a` and `b` differ, and both values there. */
const firstDifference = (a: unknown, b: unknown, path = "$"): string => {
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const key of keys) {
      const x = (a as Record<string, unknown>)[key];
      const y = (b as Record<string, unknown>)[key];
      if (!isDeepStrictEqual(x, y)) return firstDifference(x, y, `${path}.${key}`);
    }
  }
  return `${path}: ${JSON.stringify(a)} became ${JSON.stringify(b)}`;
};

beforeAll(async () => {
  await loadModule();
});

describe("libpg_query differential", () => {
  // The normalisation removes positions and nothing else: a constant's type,
  // parentheses that change grouping and a quoted name all still show.
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
  });

  it("accepts exactly what PostgreSQL accepts, with the same statement count", () => {
    const disagreements: string[] = [];
    const counts: string[] = [];
    let agree = 0;
    for (const sql of SOURCES) {
      const ours = accepts(() => postgres.parse(sql));
      const theirs = accepts(() => parseSync(sql));
      if (ours !== theirs) {
        disagreements.push(`${ours ? "ours" : "postgres"}: ${sql}`);
        continue;
      }
      agree++;
      if (ours && postgres.parse(sql).length !== pgTrees(sql).length) counts.push(sql);
    }
    const expected = PARSER_DIFFERENCES.map(({ sql, acceptedBy }) => `${acceptedBy}: ${sql}`);
    report(`parser: ${agree} agree, ${disagreements.length} disagree (${expected.length} allowlisted)`);
    expect(counts).toEqual([]);
    expect(disagreements.sort()).toEqual(expected.sort());
  });

  it("prints SQL that PostgreSQL parses to the same tree", () => {
    const mismatches = new Map<string, string[]>();
    let printed = 0;
    let differing = 0;
    let skipped = 0;
    for (const sql of SOURCES) {
      let stmts: Stmt[];
      let expected: unknown[];
      try {
        stmts = postgres.parse(sql);
        expected = pgTrees(sql);
      } catch {
        continue; // a parser disagreement, checked above
      }
      if (stmts.length !== expected.length) continue; // a statement-count disagreement, checked above
      stmts.forEach((stmt, i) => {
        try {
          stringify(stmt);
        } catch (error) {
          if (!(error instanceof NotPrintableError)) throw error;
          skipped++;
          return;
        }
        printed++;
        let differs = false;
        for (const options of OPTIONS) {
          const out = stringify(stmt, options);
          let problem: string | undefined;
          try {
            const got = pgTrees(out);
            if (!isDeepStrictEqual(got, [expected[i]])) problem = firstDifference([expected[i]], got);
          } catch (error) {
            problem = `PostgreSQL rejects it: ${String(error)}`;
          }
          if (problem === undefined) continue;
          differs = true;
          const lines = mismatches.get(sql) ?? [];
          lines.push(
            `${JSON.stringify({ ...options, width: String(options.width) })}\n    printed: ${out}\n    ${problem}`,
          );
          mismatches.set(sql, lines);
        }
        if (differs) differing++;
      });
    }
    const allowed = new Set(PRINTER_DIFFERENCES.map(({ sql }) => sql));
    const unexpected = [...mismatches].filter(([sql]) => !allowed.has(sql));
    const stale = [...allowed].filter((sql) => !mismatches.has(sql));
    report(
      `printer: ${printed} statements printed, ${printed - differing} agree, ${differing} differ (in ${mismatches.size} sources, ${allowed.size} allowlisted); ${skipped} not printable yet`,
    );
    expect(unexpected.map(([sql, lines]) => `${sql}\n  ${lines.join("\n  ")}`)).toEqual([]);
    expect(stale).toEqual([]);
  });
});

function report(line: string): void {
  // eslint-disable-next-line no-console
  if (process.env.LIBPG_QUERY_REPORT) console.log(`[libpg_query] ${line}`);
}
