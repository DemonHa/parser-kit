import { stripSpans } from "@parser-kit/core";
import { Parser } from "node-sql-parser";
import { describe, expect, it } from "vitest";
import { sqlLite } from "./index";
import { type Bucket, PG_BATTERY } from "./pg-coverage";

// Re-measures the PostgreSQL coverage battery in `pg-coverage.ts` and pins
// every row's bucket. A row moving from "neither" to "sql-lite" is the point of
// a grammar change; a row moving the other way is a regression. Either way the
// failure lists the statement, and the fix is to update its recorded bucket
// and the README's coverage table, which is copied from this test's report
// (run with PG_COVERAGE_REPORT=1 to print it).

const nodeParser = new Parser();

const accepts = (parse: () => unknown): boolean => {
  try {
    parse();
    return true;
  } catch {
    return false;
  }
};

const measure = (sql: string): Bucket => {
  const lite = accepts(() => sqlLite.parse(sql));
  const node = accepts(() => nodeParser.astify(sql, { database: "PostgreSQL" }));
  if (lite && node) return "both";
  if (lite) return "sql-lite";
  return node ? "node" : "neither";
};

const BUCKETS: Bucket[] = ["both", "sql-lite", "node", "neither"];

describe("PostgreSQL coverage battery", () => {
  it("holds distinct statements", () => {
    const seen = new Set<string>();
    const dupes = PG_BATTERY.filter((row) => seen.size === seen.add(row.sql).size).map((row) => row.sql);
    expect(dupes).toEqual([]);
  });

  it("matches the recorded bucket for every statement", () => {
    const measured = PG_BATTERY.map((row) => ({ ...row, actual: measure(row.sql) }));
    const moved = measured.filter((row) => row.actual !== row.expect);
    expect(moved.map((row) => `${row.expect} -> ${row.actual}: ${row.sql}`)).toEqual([]);

    if (process.env.PG_COVERAGE_REPORT) {
      const areas = [...new Set(measured.map((row) => row.area))];
      const table = [...areas, "total"].map((area) => {
        const rows = area === "total" ? measured : measured.filter((row) => row.area === area);
        const count = (bucket: Bucket) => rows.filter((row) => row.actual === bucket).length;
        return { area, statements: rows.length, ...Object.fromEntries(BUCKETS.map((b) => [b, count(b)])) };
      });
      // eslint-disable-next-line no-console
      console.table(table);
    }
  });

  it("rejects USE, a MySQL-ism PostgreSQL has no equivalent of, on purpose", () => {
    expect(() => sqlLite.parse("USE app;")).toThrow(/Expected a statement but found "use"/);
  });
});

// "Parses" is necessary, not sufficient. These battery rows are the ones whose
// shape is easiest to get subtly wrong while still parsing; each asserts the
// structure PostgreSQL gives the statement (one type name, one call with its
// modifiers, a distinct-from test rather than equality).
describe("PostgreSQL coverage battery: AST spot checks", () => {
  const firstColumn = (sql: string) => (stripSpans(sqlLite.parse(sql)) as any)[0].columns;

  const battery = (fragment: string) => {
    const row = PG_BATTERY.find((r) => r.sql.includes(fragment));
    if (!row) throw new Error(`no battery row contains ${fragment}`);
    return row.sql;
  };

  it("reads multi-word cast targets as one type name", () => {
    const [withTz, , withoutTz] = firstColumn(battery("now()::timestamp with time zone"));
    expect(withTz.expr).toMatchObject({ kind: "cast", type: { name: "timestamp with time zone" } });
    expect(withoutTz.expr).toMatchObject({ kind: "cast", type: { name: "time without time zone" } });
  });

  it("marks DISTINCT and ORDER BY inside an aggregate call", () => {
    const [, distinct] = firstColumn(battery("count(DISTINCT user_id)"));
    expect(distinct.expr).toEqual({
      kind: "call",
      name: "count",
      args: [{ kind: "name", parts: ["user_id"] }],
      distinct: true,
    });

    const [agg] = firstColumn(battery("array_agg(DISTINCT tag ORDER BY tag)"));
    expect(agg.expr).toMatchObject({ name: "array_agg", distinct: true, orderBy: [{ expr: { parts: ["tag"] } }] });
  });

  it("keeps IS [NOT] DISTINCT FROM apart from equality", () => {
    const [stmt] = stripSpans(sqlLite.parse(battery("a IS DISTINCT FROM b"))) as any[];
    expect(stmt.where).toMatchObject({
      op: "or",
      left: { kind: "isDistinct", negated: false },
      right: { kind: "isDistinct", negated: true },
    });
  });

  it("keeps character varying(n) as one parameterised column type", () => {
    const [stmt] = stripSpans(sqlLite.parse(battery("name character varying(255)"))) as any[];
    expect(stmt.items[1].dataType).toEqual({ name: "character varying", args: [255], array: false });
  });
});
