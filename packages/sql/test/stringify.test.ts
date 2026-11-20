import { stripSpans } from "@parser-kit/core";
import type { Printable } from "@parser-kit/core/print";
import { fieldCoverage } from "@parser-kit/core/print/testing";
import { describe, expect, it } from "vitest";
import type { Expr, Stmt } from "../src/postgres/ast";
import { postgres } from "../src/postgres/index";
import { printExpr } from "../src/postgres/print/expr";
import { NotPrintableError, type StringifyOptions, stringify } from "../src/postgres/print/index";
import { printFrom } from "../src/postgres/print/query";
import { CORPUS } from "./corpus";
import { LEXER_EDGE_CASES, MULTI_LINE, SUPPLEMENTAL } from "./parity-corpus";
import { PG_BATTERY } from "./pg-coverage";

// The printer's round-trip harness, over every valid statement the other
// suites hold: the benchmark corpus, the parity lists and the accepted
// PostgreSQL coverage battery rows.
//
//   P1  parse(stringify(ast)) is the same tree, at widths ∞, 80, 40 and 1
//       (width 1 breaks every line the layout allows, which is where a break
//       the lexer reads as meaning would show);
//   P2  printing is idempotent: stringify(parse(stringify(ast))) is the same text;
//   P3  `stringify.golden.sql` pins the width-80 output of the corpus and
//       the parity SUPPLEMENTAL list, so a layout change shows in review;
//   P4  every variant and every field the printed trees hold was read by the
//       printer, so a field it forgets fails here rather than vanishing.
//
// Statement families still without a printer throw NotPrintableError; those
// statements are skipped, and `stringify.coverage.golden.json` records how many
// of each kind, so the list visibly shrinks as families land. Regenerate the
// goldens with `pnpm test -- -u` only when the change in them is intended.

// Statements written for the printer: the expression kinds no other suite
// reaches, and the cases its rules exist for — operators that would glue into
// a comment or another operator, forms the grammar accepts and PostgreSQL
// does not (each must print the PostgreSQL spelling), set-operation arms and
// WITH placement, and names and strings that need quoting.
const PRINTER_CASES = [
  // operators: gluing, signs, OPERATOR(), associativity
  "SELECT - -1, -(-a), - - - b, @ -1, |/ 25, ~ ~a, - +a, -(1)::int;",
  "SELECT x OPERATOR(pg_catalog.+) y, OPERATOR(pg_catalog.-) 1, x OPERATOR(=) ANY (arr), OPERATOR(-) a * b;",
  "SELECT 2 ^ -3 ^ 4, -2 ^ 2, (a + b) * c, a - (b - c), a || b || c, a && b && c, (a && b) || c, a & (b | c);",
  "SELECT NOT (a AND b) OR c, NOT a = b, (NOT a) = b, a AND (b OR c), NOT NOT a;",
  "SELECT CAST(a + b AS int), (a)::int, -x::int, (-x)::int, a::int[]::text;",
  "SELECT a COLLATE \"C\" < b, x AT TIME ZONE 'UTC' AT TIME ZONE 'x', x AT LOCAL, (a || b) COLLATE \"C\";",
  "SELECT a = ANY (b), a < ALL (SELECT 1), a + ANY (b) + c, a LIKE ANY (b), a NOT ILIKE ALL (b), a = ANY ((1, 2));",
  // non-associative tiers: PostgreSQL rejects the bare chains
  "SELECT (a = b) = c, (a < b) IS NULL, (a IS NULL) IS NULL, (a LIKE b) LIKE c, (a IN (1)) IN (true);",
  "SELECT (a BETWEEN 1 AND 2) BETWEEN true AND false, (a IS TRUE) IS NOT FALSE, a NOT IN (1) IS NULL;",
  'SELECT a BETWEEN b COLLATE "C" AND c, a BETWEEN SYMMETRIC 1 AND 2, a NOT BETWEEN ASYMMETRIC b + 1 AND c;',
  "SELECT a LIKE 'x!%' ESCAPE '!', a NOT SIMILAR TO 'b' ESCAPE '#', a ILIKE b || c;",
  // indirection: PostgreSQL takes it only after a column, a parameter or parentheses
  "SELECT (f(x))[1], (a).b, (a).*, a[1].b, $1[1], (ARRAY[1, 2])[1], (t.c)[1:2], a[:2], a[1:], a[:], (row(1, 2)).f1;",
  "SELECT ((SELECT a FROM t)).x, (SELECT a FROM t)[1];",
  // literals and strings
  "SELECT 'it''s', E'a\\nb', 'tab\there', '', N'x', B'101', X'ff', 1.50, 5., 1e2, 0x1F, .5;",
  "SELECT 'a'\n'b', 'c';",
  "SELECT INTERVAL '1' DAY, INTERVAL(3) '1 s', INTERVAL '1' DAY TO SECOND(3), INTERVAL '1-2' YEAR TO MONTH;",
  "SELECT TIMESTAMP(3) WITH TIME ZONE '2024-01-01', DOUBLE PRECISION '1', \"char\" 'a', varchar(3) 'abc', s.t 'x';",
  "SELECT a::double precision, a::timestamp(3) without time zone, a::interval day to second(3), a::bit varying(4);",
  'SELECT a::character varying(10)[], a::"int", a::pg_catalog.int4, a::"MyType", a::"double precision", a::int ARRAY;',
  // names
  'SELECT 1 AS "select", a AS "Mixed", "from".x, "a""b" FROM "from" AS "user";',
  'SELECT t.*, s.t.* FROM s.t, "T";',
  // calls
  "SELECT count(DISTINCT a), count(ALL a), f(VARIADIC arr), f(a, VARIADIC b), f(a => 1, b := 2), count(*);",
  "SELECT string_agg(a, ',' ORDER BY a DESC), array_agg(DISTINCT a ORDER BY a), pg_catalog.substring(a, 1);",
  'SELECT "normalize"(a, b), normalize(a), normalize(a, nfkd), "xmlelement"(a), "json"(a), json_object(\'{a,1}\');',
  "SELECT substring(a, 1, 2), substring(a FROM 2), substring(a FOR 2), substring(a FROM 1 FOR 2), substring(a SIMILAR b ESCAPE c);",
  "SELECT trim(a), trim(BOTH FROM a), trim(LEADING 'x' FROM a), trim('x' FROM a), position(a || b IN c), position((a IN (1)) IN c);",
  "SELECT extract(epoch FROM x), extract('Day' FROM x), overlay(a PLACING b FROM 1 FOR 2), overlay(a PLACING b FROM 1), COLLATION FOR (a);",
  "SELECT CURRENT_DATE, CURRENT_TIMESTAMP(3), LOCALTIME, USER, SESSION_USER, CURRENT_ROLE;",
  // windows and aggregate modifiers
  "SELECT sum(a) OVER (w ROWS BETWEEN 1 PRECEDING AND UNBOUNDED FOLLOWING EXCLUDE NO OTHERS) FROM t;",
  "SELECT count(*) FILTER (WHERE a) OVER (), lag(a) IGNORE NULLS OVER w, first_value(a) RESPECT NULLS OVER (w) FROM t WINDOW w AS (ORDER BY a USING <);",
  "SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY a DESC NULLS FIRST), rank() OVER (PARTITION BY a, b RANGE CURRENT ROW EXCLUDE TIES) FROM t;",
  "SELECT sum(a) OVER (GROUPS BETWEEN UNBOUNDED PRECEDING AND 2 FOLLOWING EXCLUDE GROUP), sum(a) OVER (ROWS 3 PRECEDING EXCLUDE CURRENT ROW) FROM t;",
  // constructors and predicates
  "SELECT ROW(), ROW(1), (1, 2), ARRAY[[1, 2], [3, 4]], ARRAY[]::int[], ARRAY(SELECT 1), ARRAY[ARRAY[1]];",
  "SELECT (a, b) OVERLAPS ROW(c, d), EXISTS (SELECT 1), NOT EXISTS (SELECT 1), a IN ((SELECT 1)), a NOT IN (SELECT 1);",
  "SELECT a IS DISTINCT FROM b + 1, a IS NOT DISTINCT FROM b, a ISNULL, a NOTNULL, a IS UNKNOWN, a IS NOT NFKC NORMALIZED, a IS NORMALIZED;",
  "SELECT x IS DOCUMENT, x IS NOT DOCUMENT, x IS JSON, x IS NOT JSON OBJECT WITH UNIQUE KEYS, x IS JSON ARRAY WITHOUT UNIQUE;",
  "SELECT CASE WHEN a THEN 1 WHEN b THEN 2 ELSE 3 END, CASE a WHEN 1 THEN 'x' END, CASE WHEN a THEN b END IS NULL;",
  // SQL/JSON
  "SELECT JSON_OBJECT(), JSON_OBJECT(RETURNING jsonb), JSON_OBJECT('a' VALUE 1, (k || 'x') VALUE v FORMAT JSON NULL ON NULL WITH UNIQUE KEYS RETURNING json);",
  "SELECT JSON_OBJECT(k : v ABSENT ON NULL), JSON_ARRAY(), JSON_ARRAY(1, 'a' FORMAT JSON ENCODING utf8 ABSENT ON NULL RETURNING jsonb FORMAT JSON);",
  "SELECT JSON_ARRAY(SELECT a FROM t FORMAT JSON RETURNING jsonb), JSON_ARRAY(SELECT 1);",
  "SELECT JSON_OBJECTAGG(k VALUE v ABSENT ON NULL WITH UNIQUE KEYS RETURNING jsonb) FILTER (WHERE k IS NOT NULL) OVER (PARTITION BY g) FROM t;",
  "SELECT JSON_ARRAYAGG(a ORDER BY b NULL ON NULL RETURNING jsonb), JSON_ARRAYAGG(a FORMAT JSON) OVER () FROM t;",
  "SELECT JSON('{\"a\": 1}' FORMAT JSON WITH UNIQUE KEYS), JSON(a WITHOUT UNIQUE), JSON_SCALAR(1 + 1), JSON_SERIALIZE(a FORMAT JSON RETURNING bytea);",
  "SELECT JSON_VALUE(js, '$.a' PASSING 1 AS x, 'y' AS \"Y\" RETURNING int DEFAULT 0 ON EMPTY ERROR ON ERROR) FROM t;",
  "SELECT JSON_QUERY(js FORMAT JSON, '$.a' RETURNING jsonb WITH CONDITIONAL WRAPPER OMIT QUOTES EMPTY ARRAY ON EMPTY EMPTY OBJECT ON ERROR) FROM t;",
  "SELECT JSON_QUERY(js, '$' WITHOUT WRAPPER KEEP QUOTES ON SCALAR STRING), JSON_QUERY(js, '$' WITH WRAPPER NULL ON ERROR), JSON_EXISTS(js, '$.a' PASSING 1 AS n UNKNOWN ON ERROR) FROM t;",
  "SELECT * FROM JSON_TABLE(js, '$' AS root PASSING 1 AS n COLUMNS (id FOR ORDINALITY, a int PATH '$.a' NULL ON EMPTY, b text FORMAT JSON PATH '$.b' WITH WRAPPER KEEP QUOTES, e bool EXISTS PATH '$.e' FALSE ON ERROR, NESTED PATH '$.c[*]' AS c COLUMNS (x int)) ERROR ON ERROR) AS jt;",
  "SELECT * FROM t, LATERAL JSON_TABLE(t.js, '$[*]' COLUMNS (a text, NESTED '$.b' COLUMNS (b int DEFAULT 1 ON ERROR))) AS j (x, y);",
  // XML
  "SELECT XMLELEMENT(NAME a), XMLELEMENT(NAME \"select\", XMLATTRIBUTES(1 AS x, b), 'c', d), XMLELEMENT(NAME e, 'f');",
  "SELECT XMLFOREST(a, b AS \"B\"), XMLPI(NAME php), XMLPI(NAME php, 'echo'), XMLCONCAT(a, b), XMLCONCAT(a);",
  "SELECT XMLROOT(x, VERSION '1.0', STANDALONE YES), XMLROOT(x, VERSION NO VALUE, STANDALONE NO VALUE), XMLROOT(x, VERSION v, STANDALONE NO);",
  "SELECT XMLPARSE(DOCUMENT a PRESERVE WHITESPACE), XMLPARSE(CONTENT a STRIP WHITESPACE), XMLPARSE(CONTENT a);",
  "SELECT XMLSERIALIZE(DOCUMENT a AS text INDENT), XMLSERIALIZE(CONTENT a AS varchar(10) NO INDENT), XMLSERIALIZE(CONTENT a AS text);",
  "SELECT XMLEXISTS('//a' PASSING BY REF doc), XMLEXISTS(p PASSING doc BY VALUE), XMLEXISTS(('/' || p) PASSING (d || e));",
  "SELECT * FROM XMLTABLE(XMLNAMESPACES('http://x' AS x, DEFAULT 'http://d'), '//row' PASSING BY VALUE doc COLUMNS id int PATH '@id' NOT NULL, name text DEFAULT 'n' || 'm' NULL, ord FOR ORDINALITY) AS x;",
  "SELECT * FROM XMLTABLE('/r' PASSING d COLUMNS a int) x (b), LATERAL XMLTABLE(('/' || p) PASSING (d) COLUMNS a text PATH 'x' DEFAULT 'y');",
  "SELECT * FROM ROWS FROM (XMLELEMENT(NAME a), f(1) AS (a int)) WITH ORDINALITY;",
  // set operations and WITH placement
  "(SELECT 1 ORDER BY 1) UNION SELECT 2;",
  "SELECT 1 UNION (SELECT 2 UNION SELECT 3);",
  "SELECT 1 INTERSECT (SELECT 2 UNION SELECT 3);",
  "(SELECT 1 UNION SELECT 2) INTERSECT SELECT 3;",
  "SELECT 1 UNION SELECT 2 INTERSECT SELECT 3 EXCEPT ALL SELECT 4 INTERSECT ALL SELECT 5;",
  "WITH a AS (SELECT 1) SELECT * FROM a UNION SELECT 2 ORDER BY 1 LIMIT 3;",
  "WITH a AS (SELECT 1) (WITH b AS (SELECT 2) SELECT 3) UNION SELECT 4;",
  "SELECT 1 UNION (WITH b AS (SELECT 2) SELECT * FROM b);",
  "WITH a AS (SELECT 1) (SELECT 1 UNION SELECT 2 ORDER BY 1) UNION SELECT 3;",
  "(WITH a AS (SELECT 1) SELECT 2 ORDER BY 1) UNION SELECT 3;",
  "(SELECT 1 LIMIT 1) UNION ALL (VALUES (2) OFFSET 1) ORDER BY 1 FETCH FIRST 5 ROWS ONLY;",
  "WITH x AS (VALUES (1)) VALUES (2) UNION TABLE x;",
  "WITH RECURSIVE t (n) AS NOT MATERIALIZED (SELECT 1 UNION ALL SELECT n + 1 FROM t) SEARCH DEPTH FIRST BY n SET ord CYCLE n SET is_cycle TO true DEFAULT false USING path SELECT * FROM t;",
  "WITH a AS MATERIALIZED (SELECT 1), b (x, y) AS (SELECT 1, 2) SEARCH BREADTH FIRST BY x, y SET o CYCLE x, y SET c USING p TABLE b;",
  // query clauses
  "SELECT a INTO TEMP TABLE b FROM t; SELECT a INTO GLOBAL TEMPORARY b FROM t; SELECT INTO UNLOGGED x FROM t;",
  "TABLE ONLY t; TABLE s.t ORDER BY 1 LIMIT 1; VALUES (1, 'a') ORDER BY 1 LIMIT 1 OFFSET 1; SELECT FROM t; SELECT;",
  "SELECT * FROM t ORDER BY a FETCH FIRST ROW WITH TIES; SELECT * FROM t ORDER BY a FETCH FIRST (1 + 1) ROWS WITH TIES;",
  "SELECT * FROM t FETCH NEXT ROW ONLY; SELECT * FROM t LIMIT $1 OFFSET $2 ROWS FOR NO KEY UPDATE OF t SKIP LOCKED FOR KEY SHARE;",
  "SELECT a FROM t GROUP BY ROLLUP (a, (b, c)), CUBE ((a)), GROUPING SETS ((), (a), ((a, b)), ((SELECT 1))), (), (rollup(a));",
  "SELECT a FROM t GROUP BY DISTINCT a, (a, b), ROW(a, b) HAVING count(*) > 1 WINDOW w1 AS (PARTITION BY a), w2 AS (w1 ORDER BY b);",
  // FROM items
  "SELECT * FROM a JOIN (b JOIN c ON p) ON q, d CROSS JOIN (e NATURAL JOIN f), g FULL JOIN h USING (x) AS u;",
  "SELECT * FROM (a JOIN b USING (x) AS j) AS k (y, z), (a LEFT JOIN b ON true) RIGHT JOIN c ON true;",
  "SELECT * FROM a NATURAL LEFT JOIN b, LATERAL (SELECT 1) AS s, ROWS FROM (f(1) AS (a int), g()) WITH ORDINALITY AS r (x, y, z);",
  'SELECT * FROM f() AS (a int, b text COLLATE "C"), g() AS x (a int), h(1) WITH ORDINALITY AS y, LATERAL k(VARIADIC a) z;',
  "SELECT * FROM ONLY t AS x (a) TABLESAMPLE system (10), u TABLESAMPLE bernoulli (5, 6) REPEATABLE (1 + 1), (SELECT 1);",
  'SELECT * FROM "xmltable"(a), "json_table"(b), "rows"(c);',
];

const SOURCES = [
  ...PRINTER_CASES,
  ...CORPUS.map((sample) => sample.sql),
  ...SUPPLEMENTAL,
  ...MULTI_LINE,
  ...LEXER_EDGE_CASES,
  ...PG_BATTERY.filter((row) => row.expect === "both" || row.expect === "sql-lite").map((row) => row.sql),
];

const QUERY_KINDS = ["select", "values", "tableCmd", "setOp"];

const WIDTHS = [Number.POSITIVE_INFINITY, 80, 40, 1];

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
      skipped.set(error.kind, (skipped.get(error.kind) ?? 0) + 1);
    }
  }
}

const roundTrip = (stmt: Stmt, options: StringifyOptions): unknown =>
  stripSpans(postgres.parse(stringify(stmt, options)));

describe("stringify round trips", () => {
  it("records which statements print and which are not yet printable", async () => {
    const coverage = {
      printed: printable.length,
      notYetPrintable: Object.fromEntries([...skipped].sort(([a], [b]) => a.localeCompare(b))),
    };
    await expect(`${JSON.stringify(coverage, null, 2)}\n`).toMatchFileSnapshot("./stringify.coverage.golden.json");
  });

  it("P1: parses back to the same tree at every width", () => {
    const failures: string[] = [];
    for (const { source, stmt } of printable) {
      const expected = stripSpans([stmt]);
      for (const width of WIDTHS) {
        let out = "";
        try {
          out = stringify(stmt, { width });
          expect(roundTrip(stmt, { width })).toEqual(expected);
        } catch (error) {
          failures.push(`width ${width}: ${source}\n  printed: ${out}\n  ${String(error).split("\n")[0]}`);
          break;
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("P1: parses back to the same tree with lower-case keywords, quoted names and E-strings", () => {
    const options: StringifyOptions = { keywordCase: "lower", identifierQuote: "always", strings: "escape" };
    const failures = printable
      .filter(({ stmt }) => {
        try {
          return !equal(roundTrip(stmt, options), stripSpans([stmt]));
        } catch {
          return true;
        }
      })
      .map(({ source }) => source);
    expect(failures).toEqual([]);
  });

  it("P2: printing what it printed gives the same text", () => {
    const failures: string[] = [];
    for (const { source, stmt } of printable) {
      for (const width of [Number.POSITIVE_INFINITY, 80]) {
        const once = stringify(stmt, { width });
        const twice = stringify(postgres.parse(once), { width });
        if (twice !== once) failures.push(`${source}\n  once:  ${once}\n  twice: ${twice}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("P3: pins the width-80 output", async () => {
    const out = [...CORPUS.map((sample) => sample.sql), ...SUPPLEMENTAL]
      .map((source) => {
        const printed = postgres.parse(source).map((stmt) => {
          try {
            return stringify(stmt, { width: 80 });
          } catch (error) {
            if (!(error instanceof NotPrintableError)) throw error;
            return `-- not yet printable: ${error.kind}`;
          }
        });
        return `-- ${source.replace(/\n/g, "\n-- ")}\n${printed.join("\n")}\n`;
      })
      .join("\n");
    await expect(out).toMatchFileSnapshot("./stringify.golden.sql");
  });

  it("P4: reads every variant and field of the trees it prints", () => {
    // Every expression, FROM item and query variant is listed, so one the
    // corpus never reaches is reported too.
    const kinds = [...Object.keys(printExpr.handlers), ...Object.keys(printFrom.handlers), ...QUERY_KINDS];
    const coverage = fieldCoverage({ key: "kind", kinds });
    for (const { stmt } of printable) stringify(coverage.track(stmt));
    expect(coverage.report()).toEqual({ kinds: [], fields: [] });
  });
});

const equal = (a: unknown, b: unknown): boolean => {
  try {
    expect(a).toEqual(b);
    return true;
  } catch {
    return false;
  }
};

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

  it("throws NotPrintableError for a statement family not printed yet", () => {
    const [stmt] = postgres.parse("CREATE TABLE t (a int)");
    expect(() => stringify(stmt!)).toThrow(NotPrintableError);
    expect(() => stringify(stmt!)).toThrow('A "createTable" statement is not yet printable');
    // Nested in a query, as a data-modifying CTE body, it throws all the same.
    const [cte] = postgres.parse("WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d");
    expect(() => stringify(cte!)).toThrow('A "delete" statement is not yet printable');
  });
});
