import type { ParseError } from "@parser-kit/core";
import { expect, it } from "vitest";
import { CORPUS } from "./corpus";
import { sqlLite } from "./index";

// --- byte-exact parity harness ---
//
// The example suites assert on *shapes*: `stripSpans` output compared with
// `toEqual`, error messages matched with a regex. That leaves plenty of room
// for an internal change to shift something observable — a span by one column,
// a recovered statement, the wording of a diagnostic — without turning a test
// red. Spans in particular are asserted almost nowhere: `parse` here strips
// them before comparing, and so does the `lex` helper.
//
// This harness closes that gap. It serialises the full AST — spans included,
// nothing stripped — for every statement below, plus the errors `diagnose()`
// collects for a fixed list of malformed inputs, and compares the result
// byte-for-byte against a committed golden. A refactor that is supposed to
// preserve behaviour must leave those files untouched.
//
// The goldens are generated from the parser's current behaviour, not derived
// from a spec, so they are only meaningful if they are recorded *before* the
// change under test. Regenerate them with `pnpm test -- -u` (the `--` is
// required — pnpm swallows a bare `-u` and exits 0 without running anything)
// when a behaviour change is intended and reviewed, never to make a refactor
// pass.
//
// What it does *not* pin: `ParseError.stack`, which is not portable enough to
// commit. A change to stack capture has to bring its own assertions.

// The benchmark corpus is picked for head-to-head fairness against
// node-sql-parser, not for grammar coverage, and every row of it is a single
// line. These fill both gaps: the node families the benchmark never reaches,
// and — see MULTI_LINE — spans past row 1.
const SUPPLEMENTAL = [
  // --- from-clause forms ---
  "SELECT 1 FROM users u JOIN teams t ON u.team_id = t.id;",
  "SELECT 1 FROM a LEFT JOIN b USING (id) CROSS JOIN c;",
  "SELECT * FROM a CROSS JOIN LATERAL unnest(a.tags) t;",
  "SELECT * FROM t AS x TABLESAMPLE bernoulli (10) REPEATABLE (5);",
  // --- the expression grammar: pratt levels and the special-call dispatch ---
  "SELECT -a, NOT b FROM t;",
  "SELECT CASE WHEN a THEN 1 WHEN b THEN 2 ELSE 3 END, CASE x WHEN 1 THEN 'a' END FROM t;",
  "SELECT ARRAY[1, 2, 3], a[1], b[1:2] FROM t;",
  "SELECT ROW(1, 2) FROM t;",
  "SELECT extract(year FROM d), position('a' IN s), substring(s FROM 1 FOR 2), trim(BOTH 'x' FROM s) FROM t;",
  "SELECT a IS NULL, b IS NOT NULL, c IS DISTINCT FROM d, e IS NOT DISTINCT FROM f FROM t;",
  "SELECT true, false, null, a IS TRUE, b IS NOT FALSE FROM t;",
  "SELECT a SIMILAR TO 'x%', b AT TIME ZONE 'utc', c COLLATE \"C\" FROM t;",
  "SELECT a IN (SELECT id FROM u), b NOT IN (1, 2) FROM t;",
  "SELECT EXISTS (SELECT 1 FROM u) FROM t;",
  "SELECT INTERVAL '1 day' FROM t;",
  "SELECT count(*) FILTER (WHERE a > 1) FROM t;",
  "SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY x) FROM t;",
  "SELECT count(*) FROM t;",
  // DISTINCT inside a call is accepted and deliberately not recorded, so this
  // row pins acceptance and the call's span, not a distinguishable node.
  "SELECT count(distinct x) FROM t;",
  "SELECT t.* FROM t;",
  // --- clause tails ---
  "SELECT sum(x) OVER (PARTITION BY a ORDER BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) FROM t;",
  "SELECT sum(x) OVER (RANGE BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING) FROM t;",
  "SELECT sum(x) OVER (ORDER BY id ROWS UNBOUNDED PRECEDING) FROM t;",
  "SELECT sum(x) OVER (ROWS 5 PRECEDING) FROM t;",
  "SELECT a FROM t GROUP BY CUBE (a, b), ROLLUP (c), GROUPING SETS ((a), ());",
  "SELECT 1 OFFSET 5 ROWS FETCH NEXT 3 ROWS WITH TIES;",
  "SELECT 1 UNION VALUES (2);",
  "SELECT * FROM t FOR NO KEY UPDATE FOR KEY SHARE SKIP LOCKED;",
  // --- statement families and clause tails the benchmark corpus misses ---
  "ALTER TABLE t ADD COLUMN age int;",
  "ALTER TABLE t ADD CONSTRAINT pk PRIMARY KEY (id);",
  "ALTER TABLE t ALTER COLUMN email SET NOT NULL;",
  "ALTER TABLE t ALTER COLUMN status DROP DEFAULT;",
  "ALTER TABLE t RENAME COLUMN old TO new;",
  "ALTER TABLE t RENAME CONSTRAINT pk_old TO pk_new;",
  "ALTER TABLE t DROP COLUMN age;",
  "ALTER TABLE t ALTER email DROP NOT NULL;",
  "ALTER TABLE t ALTER COLUMN status SET DEFAULT 'active';",
  "ALTER TABLE t ALTER COLUMN n SET DATA TYPE bigint;",
  "CREATE SEQUENCE s RESTART WITH 1;",
  "ALTER TABLE t RENAME TO t2;",
  "ALTER TABLE t OWNER TO admin;",
  "ALTER TABLE t REPLICA IDENTITY USING INDEX t_pkey;",
  "CREATE TABLE t (id int NOT NULL DEFAULT 0, u text UNIQUE, parent int REFERENCES p (id) ON DELETE CASCADE, CHECK (id > 0));",
  "CREATE TABLE t (a int NULL, b int, FOREIGN KEY (b) REFERENCES p (id));",
  "CREATE TABLE snap AS SELECT id, name FROM users;",
  "CREATE SEQUENCE s MINVALUE -100 NO CYCLE OWNED BY NONE;",
  "CREATE SEQUENCE IF NOT EXISTS s AS bigint INCREMENT BY 2 MINVALUE 1 NO MAXVALUE START WITH 10 CACHE 5 CYCLE OWNED BY t.id;",
  "CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy');",
  "CREATE DOMAIN positive int CHECK (VALUE > 0);",
  "CREATE AGGREGATE sum_agg(numeric) (SFUNC = numeric_add, STYPE = numeric, INITCOND = '0');",
  "CREATE TRIGGER audit AFTER INSERT OR UPDATE OF a, b ON accounts FOR EACH ROW WHEN (new.active) EXECUTE FUNCTION log_change(1, 'x');",
  "CREATE MATERIALIZED VIEW IF NOT EXISTS mv AS SELECT * FROM t WITH NO DATA;",
  "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx ON users (email) INCLUDE (name, id);",
  "CREATE OR REPLACE FUNCTION add(a integer, b integer DEFAULT 0) RETURNS integer LANGUAGE sql IMMUTABLE STRICT AS $$SELECT a + b$$;",
  "CREATE FUNCTION h() RETURNS int LANGUAGE sql LEAKPROOF ROWS 100 SET x FROM CURRENT AS $$SELECT 1$$;",
  "CREATE FUNCTION g() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public COST 100 PARALLEL SAFE AS $$SELECT 1$$;",
  "GRANT SELECT, UPDATE (a, b) ON TABLE t1, t2 TO alice, bob WITH GRANT OPTION;",
  "REVOKE GRANT OPTION FOR SELECT ON t FROM alice CASCADE;",
  "BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE;",
  "START TRANSACTION ISOLATION LEVEL REPEATABLE READ NOT DEFERRABLE;",
  "SAVEPOINT sp;",
  "ROLLBACK TO SAVEPOINT sp;",
  "RELEASE SAVEPOINT sp;",
  "COMMIT AND CHAIN;",
  "SET search_path = public, app;",
  "SHOW search_path;",
  "RESET ALL;",
  "DO $$ SELECT 1 $$ LANGUAGE sql;",
  "COMMENT ON COLUMN users.email IS $q$primary contact$q$;",
  "DEALLOCATE PREPARE my_stmt;",
  "INSERT INTO t (a) VALUES (1) ON CONFLICT DO UPDATE SET a = 2 WHERE t.a > 0;",
];

// Every span in the corpus above starts and ends on row 1, which makes it blind
// to the one thing the input stream does besides advance a column: `line++,
// col = 0` on a newline. These inputs put tokens on rows 2+ and run newlines
// *through* the readers that scan multi-character runs — dollar strings, nested
// block comments, quoted strings — which is exactly where a slice-based rewrite
// of that scan can drop the bookkeeping.
const MULTI_LINE = [
  "CREATE OR REPLACE FUNCTION add(a integer, b integer)\nRETURNS integer\nLANGUAGE sql AS $$\n  SELECT a + b;\n$$;\nSELECT 1;",
  "/* a\n   /* nested\n      still nested */\n   outer */\nSELECT 1;",
  "-- leading comment\nSELECT\n  a,\n  b\nFROM t\nWHERE a = 1;",
  "SELECT 'multi\nline\nstring' FROM t;",
  "CREATE TABLE t (\n  id int PRIMARY KEY,\n  name text NOT NULL\n);\nALTER TABLE t ADD COLUMN age int;",
];

// Inputs whose lexing is more interesting than their parsing: the radix,
// separator, exponent and leading-dot number forms; E-strings in *both* cases,
// since the prefix is case-insensitive by default and a dispatch keyed on the
// literal prefix character would silently disable the lowercase form; doubled
// quotes; dollar quoting; non-ASCII *inside* string and quoted-identifier
// bodies, which pins column counting across a multi-byte run (a non-ASCII
// character can never *start* a token in this grammar, so that path is in
// MALFORMED below); and the operator / punctuation-trie partition.
const LEXER_EDGE_CASES = [
  "SELECT 0xff, 1_000, 1e5, .5, 1.5e-3 FROM t;",
  "SELECT E'a\\nb', e'lower\\tprefix', 'it''s', \"MixedCase\" FROM t;",
  "SELECT 'héllo wörld', 'naïve — em dash' FROM \"café\";",
  "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$SELECT 1$$;",
  "SELECT a || b, c @> d, x::int, $1, $name FROM t;",
  "/* outer /* inner */ still outer */ SELECT 1; -- trailing\n",
];

// Malformed inputs, each trailed by a statement that recovery at the `;` sync
// point can reach. Annotated per row rather than as a prose list, so adding one
// can't leave the descriptions off by one.
const MALFORMED = [
  // A failure inside a construct: the siblings around it survive.
  "CREATE TABLE t (id int, 42 bad, ok text);\nDROP TABLE t;",
  // An unknown keyword where a clause was expected.
  "SELECT * FRUM t;\nSELECT 1;",
  // A backtracked branch whose deeper error `preferFarthest` substitutes in.
  // sql-lite enables it; js-lite does not, so this is the only harness that
  // covers that substitution.
  "CREATE TABLE IF NOT EXIST foo (id int);\nSELECT 1;",
  // A clause truncated at the statement terminator.
  "SELECT * FROM;\nSELECT 2;",
  // A lexer error, which surfaces lazily at the parser's first peek.
  "SELECT $ FROM t;\nSELECT 3;",
  // Two independent failures in one input: pins the order diagnostics come out
  // in, and that recovery keeps going after the first one.
  "SELECT * FROM;\nSELECT * FRUM u;\nSELECT 4;",
  "CREATE TABLE a (id int, 42 bad);\nSELECT * FROM;\nSELECT 5;",
  // A non-ASCII character at a *token start* — the only input here that drives
  // the out-of-range path of an ASCII-indexed dispatch or char-class table. It
  // is a lex error in this grammar, which is why it belongs in this list.
  "SELECT é FROM t;\nSELECT 6;",
];

// Record a throw rather than propagating it, so one bad case doesn't abort the
// run and hide every case after it. The assertions below turn what it caught
// into a readable list of offending sources.
const capture = <T>(run: () => T): T | { thrown: string } => {
  try {
    return run();
  } catch (error) {
    return { thrown: String(error) };
  }
};

const threw = (value: unknown): value is { thrown: string } =>
  typeof value === "object" && value !== null && "thrown" in value;

const serialise = (entries: unknown[]) => `${JSON.stringify(entries, null, 2)}\n`;

// `message` already carries the start position; `end` is not in it and would
// otherwise be unpinned.
const describeError = (error: ParseError) => ({ message: error.message, end: error.end });

it("parses the corpus to byte-identical ASTs", async () => {
  const sources = [...CORPUS.map((sample) => sample.sql), ...SUPPLEMENTAL, ...MULTI_LINE, ...LEXER_EDGE_CASES];
  const entries = sources.map((source) => ({ source, ast: capture(() => sqlLite.parse(source)) }));

  // Every source above is valid SQL, so `capture` must not have caught
  // anything. Without this a corpus row with a typo in it degrades to a pinned
  // error string, and the constructs it was added to cover go unpinned while
  // the golden still looks healthy.
  expect(entries.filter((entry) => threw(entry.ast)).map((entry) => entry.source)).toEqual([]);

  await expect(serialise(entries)).toMatchFileSnapshot("./parity.ast.golden.json");
});

it("reports byte-identical diagnostics for malformed input", async () => {
  const entries = MALFORMED.map((source) => ({
    source,
    ...capture(() => {
      const { ast, errors } = sqlLite.diagnose(source);
      return { errors: errors.map(describeError), ast };
    }),
  }));

  // Recovery is the point of these inputs: if a change makes `diagnose` throw
  // instead of collecting, the golden diff alone would not say so loudly.
  expect(entries.filter(threw).map((entry) => entry.source)).toEqual([]);

  await expect(serialise(entries)).toMatchFileSnapshot("./parity.diagnostics.golden.json");
});
