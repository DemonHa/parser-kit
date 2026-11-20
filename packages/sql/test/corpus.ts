// The shared statement corpus. Two consumers need the exact same statements, so
// it lives here rather than in either of them:
//
//   - `sql-lite.bench.ts` pits sql-lite against `node-sql-parser` over the
//     `pg: true` rows (the two parsers must be fed identical input for the
//     throughput numbers to mean anything).
//   - `parity.test.ts` pins a byte-exact AST golden for every row, so a
//     refactor that changes what these statements parse to is a test failure.
//
// Keeping one array means the parity goldens always cover what the benchmark
// measures. The statements themselves are lifted from `sql-lite.test.ts`.
//
// **Adding a `pg: true` row here is not free.** The bench builds its group names
// from the shared-row counts (`select (5 statements)`, …) and
// `bench-baseline.json` keys on those names, so a new shared row renames the
// groups and `pnpm bench:compare` quietly stops matching them instead of
// reporting a regression. Widen parity coverage in `parity.test.ts`'s own lists,
// and change this array only when you mean to change what the benchmark
// measures — then refresh the baseline.

type Sample = {
  sql: string;
  category: string;
  /** `true` when `node-sql-parser` (PostgreSQL dialect) also accepts it. */
  pg: boolean;
};

export const CORPUS: Sample[] = [
  // --- simple SELECT ---
  { category: "select", pg: true, sql: "SELECT * FROM users u;" },
  { category: "select", pg: true, sql: "SELECT id, name AS n, u.age full_age FROM users u;" },
  { category: "select", pg: true, sql: "SELECT DISTINCT a FROM t;" },
  { category: "select", pg: true, sql: "SELECT DISTINCT ON (a, b) a FROM t;" },
  { category: "select", pg: true, sql: "SELECT 1 OFFSET 5 LIMIT 10;" },
  // --- SELECT: subqueries, windows, set ops, locking ---
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
