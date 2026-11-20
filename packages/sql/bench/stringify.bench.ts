import { Parser } from "node-sql-parser";
import { bench, describe } from "vitest";
import type { Stmt } from "../src/postgres/ast";
import { postgres } from "../src/postgres/index";
import { NotPrintableError, stringify } from "../src/postgres/print/index";
import { CORPUS } from "../test/corpus";

// Printing speed: the PostgreSQL printer against node-sql-parser's `sqlify`,
// each printing its own parser's AST of the same statements. Only statements
// both parsers accept and the printer already prints are used (the shared
// corpus rows, plus an OLTP-style query mix and one analytics report). Both
// ASTs are built once, outside the timed loop.
//
// `sqlify` writes one line with every name quoted, so it is closest to
// compact mode (`width: Infinity`, the default). Pretty mode (`width: 80`)
// measures the layout's fits() scans on top of that.
//
// The groups were added after `bench-baseline.json` was last saved, so until
// the next `pnpm bench:save` `pnpm bench:compare` shows them without a delta.

const nodeParser = new Parser();
const opt = { database: "PostgreSQL" };

const QUERIES = [
  ...CORPUS.filter((sample) => sample.pg).map((sample) => sample.sql),
  "SELECT o.id, o.total, o.created_at FROM orders o WHERE o.customer_id = $1 ORDER BY o.created_at DESC LIMIT 20 OFFSET 40;",
  "SELECT p.id, p.name, p.price FROM products p WHERE p.category_id = $1 AND p.active = true AND p.price BETWEEN $2 AND $3 ORDER BY p.price;",
  "SELECT u.id, u.email, a.city FROM users u LEFT JOIN addresses a ON a.user_id = u.id WHERE u.email = $1;",
  "SELECT * FROM users WHERE lower(email) = lower($1) AND deleted_at IS NULL;",
  `WITH monthly AS (
     SELECT date_trunc('month', o.created_at) AS month, o.customer_id, sum(o.total) AS revenue
     FROM orders o JOIN customers c ON c.id = o.customer_id
     WHERE o.status IN ('paid', 'shipped') AND o.created_at >= '2024-01-01'
     GROUP BY 1, 2
   )
   SELECT month, customer_id, revenue,
          rank() OVER (PARTITION BY month ORDER BY revenue DESC) AS position,
          CASE WHEN revenue > 1000 THEN 'gold' WHEN revenue > 100 THEN 'silver' ELSE 'bronze' END AS tier
   FROM monthly
   ORDER BY month, position
   LIMIT 100;`,
];

// A statement whose family has no printer yet is left out; any other throw fails the run.
const prints = (stmt: Stmt): boolean => {
  try {
    stringify(stmt);
    return true;
  } catch (error) {
    if (error instanceof NotPrintableError) return false;
    throw error;
  }
};

// Each statement's two ASTs; a statement either side can't handle is left out.
const ours: Stmt[] = [];
const theirs: unknown[] = [];
for (const sql of QUERIES) {
  const [stmt] = postgres.parse(sql);
  let ast: unknown;
  try {
    ast = nodeParser.astify(sql, opt);
    nodeParser.sqlify(ast as never, opt);
  } catch {
    continue;
  }
  if (stmt !== undefined && prints(stmt)) {
    ours.push(stmt);
    theirs.push(ast);
  }
}

// A fixed group name: `bench-baseline.json` keys on it, and the statement count
// grows as statement families get printers.
describe("stringify vs sqlify", () => {
  bench("@parser-kit/sql stringify (compact)", () => {
    for (const stmt of ours) stringify(stmt);
  });
  bench("@parser-kit/sql stringify (width 80)", () => {
    for (const stmt of ours) stringify(stmt, { width: 80 });
  });
  bench("node-sql-parser sqlify", () => {
    for (const ast of theirs) nodeParser.sqlify(ast as never, opt);
  });
});
