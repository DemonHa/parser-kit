import { Parser } from "node-sql-parser";
import { bench, describe } from "vitest";
import { CORPUS } from "./corpus";
import { sqlLite } from "./index";

// Benchmark the sql-lite example grammar against the popular `node-sql-parser`
// package. The corpus lives in `corpus.ts` so this bench and the byte-exact
// parity goldens in `parity.test.ts` measure and pin the same statements.
//
// node-sql-parser is a PEG-based parser; sql-lite is built on parser-kit's
// combinator + pratt machinery. To keep the throughput numbers fair we only
// pit the two against statements *both* accept (the `pg: true` rows in the
// corpus). The remaining rows are PG syntax node-sql-parser rejects — they're
// kept so the coverage summary reflects where sql-lite goes further.

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
