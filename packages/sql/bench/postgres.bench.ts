import { Parser } from "node-sql-parser";
import { bench, describe } from "vitest";
import { postgres } from "../src/index";
import { CORPUS } from "../test/corpus";

// Benchmark the @parser-kit/sql PostgreSQL dialect (`postgres.parse`) against the popular `node-sql-parser`
// package. The corpus lives in `corpus.ts` so this bench and the byte-exact
// parity goldens in `parity.test.ts` measure and pin the same statements.
//
// node-sql-parser is a PEG-based parser; @parser-kit/sql is built on parser-kit's
// combinator + pratt machinery. To keep the throughput numbers fair we only
// pit the two against statements *both* accept (the `pg: true` rows in the
// corpus). The remaining rows are PG syntax node-sql-parser rejects — they're
// kept so the coverage summary reflects where @parser-kit/sql goes further.

const SHARED = CORPUS.filter((s) => s.pg);
const CATEGORIES = [...new Set(CORPUS.map((s) => s.category))];

const nodeParser = new Parser();
const parseWithNode = (sql: string) => nodeParser.astify(sql, { database: "PostgreSQL" });

// One-off coverage summary (printed at collection time). Confirms the corpus is
// actually shared and highlights the statements only @parser-kit/sql accepts.
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
    `\n[coverage] @parser-kit/sql: ${CORPUS.length}/${CORPUS.length} statements | ` +
      `node-sql-parser (PostgreSQL): ${nodeOk}/${CORPUS.length} statements\n`,
  );
}

// --- head-to-head over the full shared corpus ---
describe(`whole shared corpus (${SHARED.length} statements)`, () => {
  bench("@parser-kit/sql", () => {
    for (const { sql } of SHARED) postgres.parse(sql);
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
    bench("@parser-kit/sql", () => {
      for (const { sql } of samples) postgres.parse(sql);
    });
    bench("node-sql-parser", () => {
      for (const { sql } of samples) parseWithNode(sql);
    });
  });
}

// --- @parser-kit/sql parsing statements node-sql-parser rejects (coverage advantage) ---
describe("@parser-kit/sql only: PG syntax node-sql-parser rejects", () => {
  const only = CORPUS.filter((s) => !s.pg);
  bench("@parser-kit/sql", () => {
    for (const { sql } of only) postgres.parse(sql);
  });
});
