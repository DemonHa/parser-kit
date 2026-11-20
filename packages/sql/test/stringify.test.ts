import { stripSpans } from "@parser-kit/core";
import { type Printable, render } from "@parser-kit/core/print";
import { fieldCoverage } from "@parser-kit/core/print/testing";
import { describe, expect, it, vi } from "vitest";
import type { Expr, Stmt } from "../src/postgres/ast";
import { postgres } from "../src/postgres/index";
import { printExpr } from "../src/postgres/print/expr";
import { flat } from "../src/postgres/print/flat";
import {
  FAMILIES,
  NotPrintableError,
  printStatement,
  type StringifyOptions,
  stringify,
} from "../src/postgres/print/index";
import { printFrom } from "../src/postgres/print/query";
import { CORPUS } from "./corpus";
import { LEXER_EDGE_CASES, MULTI_LINE, SUPPLEMENTAL } from "./parity-corpus";
import { PG_BATTERY } from "./pg-coverage";
import * as dml from "./stringify-cases/dml";
import * as objects from "./stringify-cases/objects";
import * as query from "./stringify-cases/query";
import * as roles from "./stringify-cases/roles";
import * as tables from "./stringify-cases/tables";

// The printer's round-trip harness, over every valid statement the other
// suites hold: the benchmark corpus, the parity lists and the accepted
// PostgreSQL coverage battery rows, plus PRINTER_CASES below.
//
//   P1  parse(stringify(ast)) is the same tree, at widths ∞, 80, 40 and 1
//       (width 1 breaks every line the layout allows, which is where a break
//       the lexer reads as meaning would show), and with every non-default
//       option;
//   P2  printing is idempotent: stringify(parse(stringify(ast))) is the same text;
//   P3  `stringify.<family>.golden.sql` pins each statement family's width-80
//       output of the corpus and the parity SUPPLEMENTAL list, so a layout
//       change shows in review (one file per family, so families landing in
//       parallel touch different files);
//   P4  every variant and every field the printed trees hold was read by the
//       printer, so a field it forgets fails here rather than vanishing.
//
// Statements of a kind its family doesn't print yet throw NotPrintableError
// and are skipped; the test checks that every skip is such a kind
// (STRINGIFY_REPORT=1 prints how many of each remain). Each family keeps its
// own cases in `stringify-cases/<family>.ts`. Regenerate the goldens with `pnpm test -- -u` only
// when the change in them is intended.

// Each family's own cases and the nested variants its printer reads.
const FAMILY_CASES: Record<string, { cases: string[]; kinds: string[] }> = { query, dml, tables, objects, roles };
const PRINTER_CASES = Object.values(FAMILY_CASES).flatMap((family) => family.cases);

const SOURCES = [
  ...PRINTER_CASES,
  ...CORPUS.map((sample) => sample.sql),
  ...SUPPLEMENTAL,
  ...MULTI_LINE,
  ...LEXER_EDGE_CASES,
  ...PG_BATTERY.filter((row) => row.expect === "both" || row.expect === "sql-lite").map((row) => row.sql),
];

const WIDTHS = [Number.POSITIVE_INFINITY, 80, 40, 1];

// Each statement kind's family, and the kinds the families print.
const FAMILY_OF = new Map<string, string>();
const PRINTED_KINDS = new Set<string>();
for (const family of FAMILIES) {
  for (const kind of Object.keys(family.statements)) {
    FAMILY_OF.set(kind, family.name);
    PRINTED_KINDS.add(kind);
  }
  for (const kind of family.pending) FAMILY_OF.set(kind, family.name);
}

type Case = { source: string; stmt: Stmt };

const printable: Case[] = [];
const skipped = new Map<string, number>();
for (const source of SOURCES) {
  for (const stmt of postgres.parse(source)) {
    try {
      stringify(stmt);
      printable.push({ source, stmt });
    } catch (error) {
      if (!(error instanceof NotPrintableError)) throw error;
      // A data-modifying CTE body counts under the kind of its statement.
      skipped.set(error.kind, (skipped.get(error.kind) ?? 0) + 1);
    }
  }
}

const roundTrip = (stmt: Stmt, options: StringifyOptions): unknown =>
  stripSpans(postgres.parse(stringify(stmt, options)));

// A failure line: the source, what was printed, and the first line of the error.
const failure = (source: string, stmt: Stmt, options: StringifyOptions, error: unknown): string => {
  let out: string;
  try {
    out = stringify(stmt, options);
  } catch (e) {
    out = `(threw ${String(e)})`;
  }
  return `${JSON.stringify(options)}: ${source}\n  printed: ${out}\n  ${String(error).split("\n")[0]}`;
};

describe("stringify round trips", () => {
  it("skips only the kinds a family doesn't print yet", () => {
    const report = [...skipped]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([kind, count]) => `${FAMILY_OF.get(kind)}/${kind}: ${count}`);
    if (process.env.STRINGIFY_REPORT) {
      // eslint-disable-next-line no-console
      console.log(`[stringify] ${printable.length} statements printed; not yet printable:\n  ${report.join("\n  ")}`);
    }
    expect([...skipped.keys()].filter((kind) => PRINTED_KINDS.has(kind) || !FAMILY_OF.has(kind))).toEqual([]);
  });

  const options: StringifyOptions[] = [
    ...WIDTHS.map((width) => ({ width })),
    { keywordCase: "lower", identifierQuote: "always", strings: "escape" },
    { width: 40, keywordCase: "lower", identifierQuote: "always", strings: "escape", indent: "\t" },
  ];
  for (const o of options) {
    it(`P1: parses back to the same tree with ${JSON.stringify({ ...o, width: String(o.width) })}`, () => {
      const failures: string[] = [];
      for (const { source, stmt } of printable) {
        try {
          expect(roundTrip(stmt, o)).toStrictEqual(stripSpans([stmt]));
        } catch (error) {
          failures.push(failure(source, stmt, o, error));
        }
      }
      expect(failures).toEqual([]);
    });
  }

  it("P2: printing what it printed gives the same text", () => {
    const failures: string[] = [];
    for (const { source, stmt } of printable) {
      for (const width of WIDTHS) {
        const once = stringify(stmt, { width });
        const twice = stringify(postgres.parse(once), { width });
        if (twice !== once) failures.push(`width ${width}: ${source}\n  once:  ${once}\n  twice: ${twice}`);
      }
    }
    expect(failures).toEqual([]);
  });

  // The one-line fast path lays out what the general renderer would.
  it("prints one line at width Infinity exactly as render does", () => {
    const differ = printable.filter(({ stmt }) => {
      const doc = printStatement(stmt);
      return flat(doc) !== render(doc, { width: Number.POSITIVE_INFINITY });
    });
    expect(differ.map(({ source }) => source)).toEqual([]);
  });

  const pinnedSources = new Set([...CORPUS.map((sample) => sample.sql), ...SUPPLEMENTAL, ...PRINTER_CASES]);
  const pinned = printable.filter(({ source }) => pinnedSources.has(source));
  for (const family of FAMILIES) {
    const own = pinned.filter(({ stmt }) => FAMILY_OF.get(stmt.kind) === family.name);
    if (own.length === 0) continue;
    it(`P3: pins the width-80 output of the ${family.name} statements`, async () => {
      const out = own.map(
        ({ source, stmt }) => `-- ${source.replace(/\n/g, "\n-- ")}\n${stringify(stmt, { width: 80 })}\n`,
      );
      await expect(out.join("\n")).toMatchFileSnapshot(`./stringify.${family.name}.golden.sql`);
    });
  }

  // `fieldCoverage` names a variant by its `kind` alone, so two unions' variants
  // of one name (an expression and a FROM item `subquery`) count as one: a
  // field read on either counts for both. P1's full-tree comparison is what
  // catches a dropped field there.
  it("P4: reads every variant and field of the trees it prints", () => {
    // Every expression, FROM item and printed statement variant is listed, and
    // the nested variants each family's cases file names, so one the corpus
    // never reaches is reported too.
    const kinds = [
      ...Object.keys(printExpr.handlers),
      ...Object.keys(printFrom.handlers),
      ...PRINTED_KINDS,
      ...Object.values(FAMILY_CASES).flatMap((family) => family.kinds),
    ];
    const coverage = fieldCoverage({ key: "kind", kinds });
    for (const { stmt } of printable) stringify(coverage.track(stmt));
    expect(coverage.report()).toEqual({ kinds: [], fields: [] });
  });
});

// expr.ts and query.ts import each other; each must load first on its own.
describe("printer modules", () => {
  it("load and print when imported alone", async () => {
    const [stmt] = postgres.parse("WITH a AS (SELECT (SELECT 1) + x FROM t) SELECT * FROM a");
    vi.resetModules();
    const fromQuery = await import("../src/postgres/print/query");
    expect(render(fromQuery.printQuery(stmt as Extract<Stmt, { kind: "select" }>))).toBe(
      "WITH a AS (SELECT (SELECT 1) + x FROM t) SELECT * FROM a",
    );
    vi.resetModules();
    const fromExpr = await import("../src/postgres/print/expr");
    const [select] = postgres.parse("SELECT (SELECT 1) + x") as Extract<Stmt, { kind: "select" }>[];
    expect(render(fromExpr.expr(select!.columns[0]!.expr))).toBe("(SELECT 1) + x");
  });
});

describe("stringify options", () => {
  const two = postgres.parse("select a, b from t where x = 'it''s'; select 1");

  it("prints statements one per line, each ending in a semicolon", () => {
    expect(stringify(two)).toBe("SELECT a, b FROM t WHERE x = 'it''s';\nSELECT 1;");
    expect(stringify(two, { semicolons: "between" })).toBe("SELECT a, b FROM t WHERE x = 'it''s';\nSELECT 1");
    expect(stringify(two, { semicolons: "never" })).toBe("SELECT a, b FROM t WHERE x = 'it''s'\nSELECT 1");
    expect(stringify(two[1]!)).toBe("SELECT 1;");
    expect(stringify(two[1]!, { semicolons: "never" })).toBe("SELECT 1");
  });

  it("prints an expression or a type alone", () => {
    const [stmt] = postgres.parse("SELECT a::varchar(3)[] FROM t WHERE (a + b) * c > 1");
    const select = stmt as Extract<Stmt, { kind: "select" }>;
    expect(stringify(select.where!)).toBe("(a + b) * c > 1");
    const cast = select.columns[0]!.expr as Extract<Expr, { kind: "cast" }>;
    expect(stringify(cast.type)).toBe("varchar(3)[]");
  });

  it("lays out to a width, with the indent given", () => {
    expect(stringify(two[0]!, { width: 20, indent: "\t" })).toBe("SELECT a, b\nFROM t\nWHERE x = 'it''s';");
    expect(stringify(two[0]!, { width: 10 })).toBe("SELECT\n  a,\n  b\nFROM t\nWHERE\n  x =\n    'it''s';");
  });

  it("cases keywords, quotes names and escapes strings as asked", () => {
    const [stmt] = postgres.parse("SELECT a AS b FROM s.t WHERE c = E'x\\ny' AND d IS NOT NULL");
    expect(stringify(stmt!, { keywordCase: "lower" })).toBe(
      "select a as b from s.t where c = 'x\ny' and d is not null;",
    );
    expect(stringify(stmt!, { identifierQuote: "always" })).toBe(
      `SELECT "a" AS "b" FROM "s"."t" WHERE "c" = 'x\ny' AND "d" IS NOT NULL;`,
    );
    expect(stringify(stmt!, { strings: "escape" })).toBe(
      "SELECT a AS b FROM s.t WHERE c = E'x\\ny' AND d IS NOT NULL;",
    );
  });

  it("keeps function and type names minimal under identifierQuote: always", () => {
    const [stmt] = postgres.parse("SELECT count(a)::int, pg_catalog.lower(b) FROM t");
    expect(stringify(stmt!, { identifierQuote: "always" })).toBe(
      `SELECT count("a")::int, pg_catalog.lower("b") FROM "t";`,
    );
  });
});

describe("stringify on hand-built trees", () => {
  const name = (...parts: string[]): Printable<Expr> => ({ kind: "name", parts });
  const num = (value: number): Printable<Expr> => ({ kind: "number", value });

  it("quotes names from their value, with no spans needed", () => {
    expect(stringify(name("MyCol"))).toBe('"MyCol"');
    expect(stringify(name("select"))).toBe('"select"');
    expect(stringify(name("s", "my table", 'a"b'))).toBe('s."my table"."a""b"');
  });

  it("keeps signs and operators from gluing", () => {
    expect(stringify({ kind: "binary", op: "-", left: name("a"), right: num(-1) })).toBe("a - -1");
    expect(stringify({ kind: "unary", op: "-", operand: num(-1) })).toBe("- -1");
    expect(stringify({ kind: "unary", op: "-", operand: { kind: "unary", op: "-", operand: name("a") } })).toBe("- -a");
    expect(stringify({ kind: "binary", op: "*", left: num(-1), right: name("a") })).toBe("-1 * a");
    expect(stringify({ kind: "binary", op: "^", left: num(-1), right: name("a") })).toBe("-1 ^ a");
    expect(stringify({ kind: "cast", expr: num(-1), type: { name: ["int"], args: [], array: false } })).toBe(
      "(-1)::int",
    );
  });

  it("spells a prefix operator the grammar can't read bare as OPERATOR()", () => {
    expect(stringify({ kind: "unary", op: "!!=", operand: name("a") })).toBe("OPERATOR(!!=) a");
  });

  it("parenthesises what the tree nests, and nothing else", () => {
    const sum: Printable<Expr> = { kind: "binary", op: "+", left: name("a"), right: name("b") };
    expect(stringify({ kind: "binary", op: "*", left: sum, right: sum })).toBe("(a + b) * (a + b)");
    expect(stringify({ kind: "binary", op: "+", left: sum, right: sum })).toBe("a + b + (a + b)");
    expect(
      stringify({
        kind: "binary",
        op: "=",
        left: sum,
        right: { kind: "binary", op: "=", left: num(1), right: num(2) },
      }),
    ).toBe("a + b = (1 = 2)");
  });

  it("quotes a call that would otherwise read as a keyword form", () => {
    expect(stringify({ kind: "call", name: ["xmlelement"], args: [name("a")] })).toBe('"xmlelement"(a)');
    expect(stringify({ kind: "call", name: ["normalize"], args: [name("a"), name("b")] })).toBe('"normalize"(a, b)');
    expect(stringify({ kind: "call", name: ["normalize"], args: [name("a")] })).toBe("normalize(a)");
  });

  it("quotes a function name PostgreSQL can't take bare, unless it is its keyword form", () => {
    // PG's col_name keywords: a round trip can't see these, as this parser takes them bare.
    const [stmt] = postgres.parse(
      'SELECT "numeric"(x), "int"(1), "timestamp"(x), coalesce(a, b), "coalesce"(DISTINCT a), substring(a, 1), f("out" => 1) FROM "int"(1), t TABLESAMPLE "bit" (1);',
    );
    expect(stringify(stmt!)).toBe(
      'SELECT "numeric"(x), "int"(1), "timestamp"(x), coalesce(a, b), "coalesce"(DISTINCT a), substring(a, 1), f("out" => 1) FROM "int"(1), t TABLESAMPLE "bit" (1);',
    );
    expect(stringify({ kind: "call", name: ["pg_catalog", "numeric"], args: [name("x")] })).toBe(
      "pg_catalog.numeric(x)",
    );
  });

  it("writes PostgreSQL's spelling where this grammar is more lenient", () => {
    const print = (sql: string) => stringify(postgres.parse(sql)[0]!);
    // OVERLAPS is an a_expr to PG: parenthesised in b_expr and c_expr positions.
    const overlaps = "SELECT x BETWEEN ((a, b) OVERLAPS (c, d)) AND y, POSITION(((a, b) OVERLAPS (c, d)) IN x);";
    expect(print(overlaps)).toBe(overlaps);
    const xml = "SELECT XMLEXISTS(((a, b) OVERLAPS (c, d)) PASSING x), (a, b) OVERLAPS (c, d) AND e;";
    expect(print(xml)).toBe(xml);
    // POSITION's operands are both b_expr.
    const position = `SELECT POSITION('a' IN (b COLLATE "C")), POSITION('a' IN b || c);`;
    expect(print(position)).toBe(position);
    // A reserved-to-PG or function-only word is quoted as a column or table name.
    const names = 'SELECT "system_user", "collation" FROM "similar";';
    expect(print(names)).toBe(names);
  });

  it("throws NotPrintableError for a statement family not printed yet", () => {
    const [stmt] = postgres.parse("CREATE TABLE t (a int)");
    expect(() => stringify(stmt!)).toThrow(NotPrintableError);
    expect(() => stringify(stmt!)).toThrow('A "createTable" statement is not yet printable');
    // Nested in a query, as a data-modifying CTE body, it throws all the same.
    const [cte] = postgres.parse("WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d");
    expect(() => stringify(cte!)).toThrow('A "delete" statement is not yet printable');
  });
});
