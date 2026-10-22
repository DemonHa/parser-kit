import { Parser } from "node-sql-parser";
import { bench, describe } from "vitest";
import { sqlLite } from "./index";

// Real-world workloads: sql-lite vs node-sql-parser on the shapes of SQL an
// application actually feeds a parser, rather than the one-construct-per-row
// corpus `sql-lite.bench.ts` measures.
//
//   - an OLTP query mix (point lookups, pagination, small writes);
//   - one analytics report (CTEs, window functions, joins, CASE);
//   - a schema migration script handed over as a single multi-statement file;
//   - large generated inputs: a 10,000-row INSERT and a 1,000-column SELECT;
//   - malformed input, where both parsers have to throw.
//
// Every valid input here is one both parsers accept, so each group compares
// like with like. That is checked at module load, below: a statement either
// parser rejects fails the run instead of quietly benchmarking an early throw.
// The PG syntax node-sql-parser rejects (DELETE ... RETURNING, FOR UPDATE SKIP
// LOCKED, ALTER TABLE ... RENAME COLUMN, ...) is deliberately left out.
//
// These groups are not in `bench-baseline.json`, so `pnpm bench:compare` shows
// them without a delta.

const nodeParser = new Parser();
const parseWithNode = (sql: string) => nodeParser.astify(sql, { database: "PostgreSQL" });

// --- OLTP mix: what a typical web backend sends, one statement per call ---
const OLTP = [
  "SELECT id, email, display_name FROM users WHERE id = $1;",
  "SELECT o.id, o.total, o.created_at FROM orders o WHERE o.customer_id = $1 ORDER BY o.created_at DESC LIMIT 20 OFFSET 40;",
  "SELECT p.id, p.name, p.price FROM products p WHERE p.category_id = $1 AND p.active = true AND p.price BETWEEN $2 AND $3 ORDER BY p.price;",
  "SELECT count(*) FROM sessions WHERE user_id = $1 AND expires_at > now();",
  "SELECT u.id, u.email, a.city FROM users u LEFT JOIN addresses a ON a.user_id = u.id WHERE u.email = $1;",
  "SELECT exists (SELECT 1 FROM users WHERE email = $1);",
  "SELECT * FROM users WHERE lower(email) = lower($1) AND deleted_at IS NULL;",
  "INSERT INTO orders (customer_id, status, total) VALUES ($1, 'pending', $2) RETURNING id, created_at;",
  "INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES ($1, $2, $3, $4), ($1, $5, $6, $7);",
  "INSERT INTO carts (user_id, product_id, quantity) VALUES ($1, $2, $3) ON CONFLICT (user_id, product_id) DO NOTHING;",
  "UPDATE users SET last_login_at = now(), login_count = login_count + 1 WHERE id = $1;",
  "UPDATE inventory SET quantity = quantity - $2 WHERE product_id = $1 AND quantity >= $2 RETURNING quantity;",
  "UPDATE orders SET status = 'cancelled' WHERE id = $1 AND status IN ('pending', 'processing');",
  "DELETE FROM sessions WHERE expires_at < now();",
  "BEGIN;",
  "COMMIT;",
];

// --- analytics: one reporting query of the kind a BI tool generates ---
const ANALYTICS = `WITH monthly AS (
  SELECT date_trunc('month', o.created_at) AS month, o.customer_id,
         sum(oi.quantity * oi.unit_price) AS revenue, count(DISTINCT o.id) AS orders
  FROM orders o
  JOIN order_items oi ON oi.order_id = o.id
  WHERE o.status <> 'cancelled' AND o.created_at >= '2024-01-01'
  GROUP BY 1, 2
), ranked AS (
  SELECT month, customer_id, revenue, orders,
         rank() OVER (PARTITION BY month ORDER BY revenue DESC) AS rnk,
         sum(revenue) OVER (PARTITION BY customer_id ORDER BY month
                            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_revenue,
         lag(revenue) OVER (PARTITION BY customer_id ORDER BY month) AS prev_revenue
  FROM monthly
)
SELECT r.month, c.name, c.country, r.revenue, r.orders, r.running_revenue,
       CASE WHEN r.prev_revenue IS NULL THEN NULL
            ELSE round((r.revenue - r.prev_revenue) / r.prev_revenue * 100, 2) END AS growth_pct,
       coalesce(s.segment, 'unassigned') AS segment
FROM ranked r
JOIN customers c ON c.id = r.customer_id
LEFT JOIN customer_segments s ON s.customer_id = c.id
WHERE r.rnk <= 10
ORDER BY r.month DESC, r.revenue DESC;`;

// --- migration: a schema script, parsed as one file ---
const MIGRATION_STATEMENTS = [
  "CREATE SCHEMA IF NOT EXISTS app;",
  "CREATE TABLE app.users (id bigserial PRIMARY KEY, email varchar(255) NOT NULL UNIQUE, display_name text, password_hash text NOT NULL, created_at timestamp with time zone NOT NULL DEFAULT now(), updated_at timestamp);",
  "CREATE TABLE app.teams (id serial PRIMARY KEY, name varchar(100) NOT NULL, owner_id bigint NOT NULL REFERENCES app.users (id) ON DELETE CASCADE);",
  "CREATE TABLE app.memberships (team_id int NOT NULL, user_id bigint NOT NULL, role varchar(20) NOT NULL DEFAULT 'member', joined_at timestamp DEFAULT now(), PRIMARY KEY (team_id, user_id), FOREIGN KEY (team_id) REFERENCES app.teams (id), FOREIGN KEY (user_id) REFERENCES app.users (id));",
  "CREATE TABLE app.events (id bigserial PRIMARY KEY, project_id int, kind text NOT NULL, payload jsonb, created_at timestamp DEFAULT now());",
  "CREATE TYPE app.status AS ENUM ('active', 'paused', 'closed');",
  "CREATE SEQUENCE app.invoice_seq START 1000;",
  "CREATE INDEX idx_users_email ON app.users (email);",
  "CREATE UNIQUE INDEX idx_teams_name ON app.teams (name);",
  "CREATE INDEX idx_events_project ON app.events (project_id, created_at);",
  "CREATE INDEX idx_events_kind ON app.events USING btree (kind);",
  "CREATE VIEW app.team_members AS SELECT t.id, t.name, u.email FROM app.teams t JOIN app.memberships m ON m.team_id = t.id JOIN app.users u ON u.id = m.user_id;",
  "ALTER TABLE app.users ADD COLUMN last_login_at timestamp;",
  "ALTER TABLE app.memberships ADD CONSTRAINT memberships_role_unique UNIQUE (team_id, role);",
  "ALTER TABLE app.events DROP COLUMN payload;",
  "ALTER TABLE app.teams RENAME TO groups;",
  "DROP INDEX IF EXISTS app.idx_old;",
  "TRUNCATE app.events;",
  "GRANT SELECT, INSERT, UPDATE ON app.users TO app_rw;",
];
const MIGRATION = MIGRATION_STATEMENTS.join("\n");

// --- large generated inputs (deterministic, no Math.random) ---
const INSERT_ROWS = 10_000;
const BULK_INSERT = `INSERT INTO events (id, user_id, kind, amount, note) VALUES\n${Array.from(
  { length: INSERT_ROWS },
  (_, i) => `(${i + 1}, ${(i * 7919) % 1000}, 'kind_${i % 12}', ${((i * 31) % 10_000) / 100}, 'row ${i}')`,
).join(",\n")};`;

const WIDE_COLUMNS = 1_000;
const WIDE_SELECT = `SELECT ${Array.from({ length: WIDE_COLUMNS }, (_, i) =>
  i % 3 === 0 ? `t.col_${i}` : i % 3 === 1 ? `coalesce(t.col_${i}, 0) AS c${i}` : `t.col_${i} + 1 AS c${i}`,
).join(", ")} FROM wide_table t WHERE t.id = 1;`;

// --- malformed input: each one rejected by both parsers ---
const INVALID = [
  "SELECT FROM WHERE;",
  "SELECT * FROM users WHERE (id = 1;",
  "SELECT id, FROM users;",
  "INSERT INTO t (a, b) VALUES (1, 2;",
  "UPDATE t SET = 1 WHERE id = 2;",
  "CREATE TABLE t (id int,, name text);",
  "SELEC id FROM users;",
  "DELETE users WHERE id = 1;",
];

// --- like-with-like guard ---
{
  const accepted = (parse: (sql: string) => unknown, sql: string) => {
    try {
      parse(sql);
      return true;
    } catch {
      return false;
    }
  };
  const valid = [...OLTP, ANALYTICS, MIGRATION, BULK_INSERT, WIDE_SELECT];
  for (const sql of valid) {
    for (const [name, parse] of [
      ["sql-lite", (s: string) => sqlLite.parse(s)],
      ["node-sql-parser", parseWithNode],
    ] as const) {
      if (!accepted(parse, sql)) throw new Error(`${name} rejects a workload input: ${sql.slice(0, 120)}`);
    }
  }
  for (const sql of INVALID) {
    if (accepted((s) => sqlLite.parse(s), sql) || accepted(parseWithNode, sql)) {
      throw new Error(`an INVALID input was accepted: ${sql}`);
    }
  }
  const kb = (sql: string) => (Buffer.byteLength(sql, "utf8") / 1024).toFixed(1);
  // eslint-disable-next-line no-console
  console.log(
    `\n[workloads] migration ${kb(MIGRATION)}KB | bulk insert ${kb(BULK_INSERT)}KB | ` +
      `wide select ${kb(WIDE_SELECT)}KB\n`,
  );
}

const swallow = (parse: (sql: string) => unknown, sql: string) => {
  try {
    parse(sql);
  } catch {
    /* the throw is the work being measured */
  }
};

describe(`workload: OLTP mix (${OLTP.length} statements)`, () => {
  bench("sql-lite", () => {
    for (const sql of OLTP) sqlLite.parse(sql);
  });
  bench("node-sql-parser", () => {
    for (const sql of OLTP) parseWithNode(sql);
  });
});

describe("workload: analytics report (CTEs, windows, joins)", () => {
  bench("sql-lite", () => {
    sqlLite.parse(ANALYTICS);
  });
  bench("node-sql-parser", () => {
    parseWithNode(ANALYTICS);
  });
});

describe(`workload: migration script (${MIGRATION_STATEMENTS.length} statements, one file)`, () => {
  bench("sql-lite", () => {
    sqlLite.parse(MIGRATION);
  });
  bench("node-sql-parser", () => {
    parseWithNode(MIGRATION);
  });
});

describe(`workload: bulk INSERT (${INSERT_ROWS} rows)`, () => {
  bench("sql-lite", () => {
    sqlLite.parse(BULK_INSERT);
  });
  bench("node-sql-parser", () => {
    parseWithNode(BULK_INSERT);
  });
});

describe(`workload: wide SELECT (${WIDE_COLUMNS} columns)`, () => {
  bench("sql-lite", () => {
    sqlLite.parse(WIDE_SELECT);
  });
  bench("node-sql-parser", () => {
    parseWithNode(WIDE_SELECT);
  });
});

describe(`workload: malformed input (${INVALID.length} statements, each throws)`, () => {
  bench("sql-lite", () => {
    for (const sql of INVALID) swallow((s) => sqlLite.parse(s), sql);
  });
  bench("node-sql-parser", () => {
    for (const sql of INVALID) swallow(parseWithNode, sql);
  });
});
