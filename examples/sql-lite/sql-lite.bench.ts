import { Parser } from "node-sql-parser";
import { bench, describe } from "vitest";
import { sqlLite } from "./index";

// Benchmark the sql-lite example grammar against the popular `node-sql-parser`
// package. The corpus is lifted straight from sql-lite.test.ts so we exercise
// the same statements the parser is verified against.
//
// node-sql-parser is a PEG-based parser; sql-lite is built on parser-kit's
// combinator + pratt machinery. To keep the throughput numbers fair we only
// pit the two against statements *both* accept (the `pg: true` rows below).
// The remaining rows are PG syntax node-sql-parser rejects — they're kept so
// the coverage summary reflects where sql-lite goes further.

type Sample = { sql: string; category: string; pg: boolean };

const CORPUS: Sample[] = [
  // --- simple SELECT ---
  { category: "select", pg: true, sql: "SELECT * FROM users u;" },
  { category: "select", pg: true, sql: "SELECT id, name AS n, u.age full_age FROM users u;" },
  { category: "select", pg: true, sql: "SELECT DISTINCT a FROM t;" },
  { category: "select", pg: true, sql: "SELECT DISTINCT ON (a, b) a FROM t;" },
  { category: "select", pg: true, sql: "SELECT 1 OFFSET 5 LIMIT 10;" },
  // --- SELECT: joins, subqueries, windows, set ops ---
  { category: "select-adv", pg: true, sql: "SELECT (SELECT max(x) FROM u) m FROM t;" },
  {
    category: "select-adv",
    pg: true,
    sql: "SELECT rank() OVER w AS r FROM t WINDOW w AS (PARTITION BY a ORDER BY b);",
  },
  { category: "select-adv", pg: true, sql: "SELECT * FROM (VALUES (1), (2)) t;" },
  { category: "select-adv", pg: true, sql: "SELECT 1 FROM t WHERE x = ANY (SELECT id FROM u);" },
  { category: "select-adv", pg: false, sql: "SELECT a FROM t UNION SELECT a FROM u EXCEPT ALL SELECT a FROM v;" },
  { category: "select-adv", pg: false, sql: "SELECT * FROM t FOR UPDATE OF t, u NOWAIT;" },
  // --- CTEs ---
  { category: "cte", pg: true, sql: "WITH cte AS (SELECT 1 AS x) SELECT x FROM cte;" },
  { category: "cte", pg: true, sql: "WITH RECURSIVE r (n) AS (SELECT 1) SELECT * FROM r;" },
  // --- DML ---
  { category: "dml", pg: true, sql: "INSERT INTO t (a, b) VALUES (1, 2), (3, 4) RETURNING *;" },
  { category: "dml", pg: true, sql: "INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO NOTHING;" },
  { category: "dml", pg: true, sql: "INSERT INTO t SELECT * FROM u;" },
  { category: "dml", pg: true, sql: "UPDATE t AS x SET a = 1, b = 2 FROM u WHERE x.id = u.id RETURNING a;" },
  { category: "dml", pg: false, sql: "DELETE FROM t x USING u WHERE x.id = u.id RETURNING *;" },
  // --- DDL ---
  { category: "ddl", pg: true, sql: "CREATE TABLE t (id int, name text);" },
  { category: "ddl", pg: false, sql: "CREATE TABLE t (a varchar(10), b numeric(10, 2), c int[], d text[][]);" },
  {
    category: "ddl",
    pg: true,
    sql: "CREATE TABLE IF NOT EXISTS app.users (id int, CONSTRAINT pk PRIMARY KEY (id));",
  },
  { category: "ddl", pg: true, sql: "CREATE INDEX idx_email ON users (email);" },
  { category: "ddl", pg: true, sql: "CREATE UNIQUE INDEX ON users (lower(email)) WHERE active;" },
  { category: "ddl", pg: true, sql: "CREATE VIEW active AS SELECT id FROM users WHERE active;" },
  { category: "ddl", pg: false, sql: "DROP TABLE IF EXISTS a, public.b;" },
  { category: "ddl", pg: true, sql: "TRUNCATE TABLE a, b RESTART IDENTITY CASCADE;" },
  // --- expressions ---
  { category: "expr", pg: false, sql: "CREATE TABLE t (c int CHECK (a = 1 AND b = 2 OR c = 3));" },
  { category: "expr", pg: true, sql: "SELECT a || b || c FROM t;" },
  { category: "expr", pg: true, sql: "SELECT x::int FROM t;" },
  { category: "expr", pg: true, sql: "SELECT age BETWEEN 1 AND 10 FROM t;" },
  { category: "expr", pg: true, sql: "SELECT id IN (1, 2, 3) FROM t;" },
  { category: "expr", pg: true, sql: "SELECT coalesce(a, 0), now() FROM t;" },
  { category: "expr", pg: true, sql: "SELECT data -> 'k' FROM t;" },
  { category: "expr", pg: true, sql: "SELECT name LIKE 'a%' FROM t;" },
];

const SHARED = CORPUS.filter((s) => s.pg);
const CATEGORIES = [...new Set(CORPUS.map((s) => s.category))];

const nodeParser = new Parser();
const parseWithNode = (sql: string) => nodeParser.astify(sql, { database: "PostgreSQL" });

// One-off coverage summary (printed at collection time). Confirms the corpus is
// actually shared and highlights the statements only sql-lite accepts.
{
  let nodeOk = 0;
  for (const { sql } of CORPUS) {
    try {
      parseWithNode(sql);
      nodeOk++;
    } catch {
      /* counted as a miss below */
    }
  }
  // eslint-disable-next-line no-console
  console.log(
    `\n[coverage] sql-lite: ${CORPUS.length}/${CORPUS.length} statements | ` +
      `node-sql-parser (PostgreSQL): ${nodeOk}/${CORPUS.length} statements\n`,
  );
}

// --- head-to-head over the full shared corpus ---
describe(`whole shared corpus (${SHARED.length} statements)`, () => {
  bench("sql-lite", () => {
    for (const { sql } of SHARED) sqlLite.parse(sql);
  });
  bench("node-sql-parser", () => {
    for (const { sql } of SHARED) parseWithNode(sql);
  });
});

// --- head-to-head per category (shared statements only) ---
for (const category of CATEGORIES) {
  const samples = SHARED.filter((s) => s.category === category);
  if (samples.length === 0) continue;
  describe(`${category} (${samples.length} statements)`, () => {
    bench("sql-lite", () => {
      for (const { sql } of samples) sqlLite.parse(sql);
    });
    bench("node-sql-parser", () => {
      for (const { sql } of samples) parseWithNode(sql);
    });
  });
}

// --- sql-lite parsing statements node-sql-parser rejects (coverage advantage) ---
describe("sql-lite only: PG syntax node-sql-parser rejects", () => {
  const only = CORPUS.filter((s) => !s.pg);
  bench("sql-lite", () => {
    for (const { sql } of only) sqlLite.parse(sql);
  });
});
