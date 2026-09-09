import { Parser } from "node-sql-parser";
import { bench, describe } from "vitest";
import { sqlLite } from "./index";

// Large-file throughput: how do sql-lite and node-sql-parser compare when fed a
// single big multi-statement SQL blob (think a schema dump or migration file)?
//
// We only use statements *both* parsers accept so the numbers are apples-to-
// apples. The blob is built once per size at module load, then each parser gets
// the whole thing in one `parse` call — mirroring how you'd hand a real file to
// either library.

// Statements node-sql-parser (PostgreSQL) also accepts. A fixed, independent
// subset — deliberately not `CORPUS.filter((s) => s.pg)` from `corpus.ts`, since
// widening it would change the generated blob and invalidate this bench's baseline.
const SHARED_STATEMENTS = [
  "SELECT * FROM users u;",
  "SELECT id, name AS n, u.age full_age FROM users u;",
  "SELECT DISTINCT a FROM t;",
  "SELECT 1 OFFSET 5 LIMIT 10;",
  "SELECT (SELECT max(x) FROM u) m FROM t;",
  "SELECT * FROM (VALUES (1), (2)) t;",
  "WITH cte AS (SELECT 1 AS x) SELECT x FROM cte;",
  "INSERT INTO t (a, b) VALUES (1, 2), (3, 4) RETURNING *;",
  "INSERT INTO t SELECT * FROM u;",
  "UPDATE t AS x SET a = 1, b = 2 FROM u WHERE x.id = u.id RETURNING a;",
  "CREATE TABLE t (id int, name text);",
  "CREATE INDEX idx_email ON users (email);",
  "CREATE VIEW active AS SELECT id FROM users WHERE active;",
  "SELECT a || b || c FROM t;",
  "SELECT x::int FROM t;",
  "SELECT age BETWEEN 1 AND 10 FROM t;",
  "SELECT id IN (1, 2, 3) FROM t;",
  "SELECT coalesce(a, 0), now() FROM t;",
  "SELECT name LIKE 'a%' FROM t;",
];

// Build a blob of roughly `targetKB` kilobytes by cycling through the shared
// statements (deterministic — no Math.random, so runs are reproducible).
function buildBlob(targetKB: number): string {
  const targetBytes = targetKB * 1024;
  const parts: string[] = [];
  let size = 0;
  let i = 0;
  while (size < targetBytes) {
    const stmt = SHARED_STATEMENTS[i % SHARED_STATEMENTS.length]!;
    parts.push(stmt);
    size += stmt.length + 1; // + newline
    i++;
  }
  return parts.join("\n");
}

const SIZES_KB = [64, 256, 1024];
const BLOBS = SIZES_KB.map((kb) => ({ kb, sql: buildBlob(kb) }));

const nodeParser = new Parser();
const parseWithNode = (sql: string) => nodeParser.astify(sql, { database: "PostgreSQL" });

// One-off report: actual byte size + statement count per blob.
{
  const lines = BLOBS.map(({ kb, sql }) => {
    const bytes = Buffer.byteLength(sql, "utf8");
    const stmts = sql.split(";").length - 1;
    return `  ~${kb}KB target -> ${(bytes / 1024).toFixed(1)}KB, ${stmts} statements`;
  });
  // eslint-disable-next-line no-console
  console.log(`\n[large-file corpus]\n${lines.join("\n")}\n`);
}

for (const { sql } of BLOBS) {
  const bytes = Buffer.byteLength(sql, "utf8");
  const label = `${(bytes / 1024).toFixed(0)}KB file`;
  describe(label, () => {
    bench("sql-lite", () => {
      sqlLite.parse(sql);
    });
    bench("node-sql-parser", () => {
      parseWithNode(sql);
    });
  });
}
