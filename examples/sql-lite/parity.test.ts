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
  // Column-alias lists after an alias, on each leaf item kind, and ONLY.
  "SELECT * FROM ONLY t AS x (a, b) TABLESAMPLE system (10), (VALUES (1, 2)) AS v (c, d);",
  "SELECT * FROM generate_series(1, 3) g (n) JOIN ONLY (s.u) ON true, LATERAL (SELECT 1) l (one);",
  // Parenthesised joins, nested-paren subqueries, ROWS FROM and WITH ORDINALITY.
  "SELECT * FROM ((a JOIN b ON true) j JOIN c USING (id)) AS x (p, q), ((SELECT 1) UNION (SELECT 2)) s;",
  "SELECT * FROM ROWS FROM (f(1), g()) WITH ORDINALITY AS r (a, b, n), unnest(arr) WITH ORDINALITY u;",
  // --- the expression grammar: pratt levels and the special-call dispatch ---
  "SELECT -a, NOT b FROM t;",
  "SELECT +a, -2 ^ 2, a ^ b ^ c, a % b, a::int ^ 2 FROM t;",
  "SELECT a & b, c | d, e # f, g << 1, h >> 1, doc @? '$.x' FROM t;",
  "SELECT CASE WHEN a THEN 1 WHEN b THEN 2 ELSE 3 END, CASE x WHEN 1 THEN 'a' END FROM t;",
  "SELECT ARRAY[1, 2, 3], a[1], b[1:2] FROM t;",
  "SELECT ROW(1, 2) FROM t;",
  "SELECT extract(year FROM d), position('a' IN s), substring(s FROM 1 FOR 2), trim(BOTH 'x' FROM s) FROM t;",
  "SELECT a IS NULL, b IS NOT NULL, c IS DISTINCT FROM d, e IS NOT DISTINCT FROM f FROM t;",
  "SELECT true, false, null, a IS TRUE, b IS NOT FALSE FROM t;",
  "SELECT a SIMILAR TO 'x%', b AT TIME ZONE 'utc', c COLLATE \"C\" FROM t;",
  "SELECT a IN (SELECT id FROM u), b NOT IN (1, 2) FROM t;",
  // Implicit rows, OVERLAPS (both row spellings, under NOT and AND), the BETWEEN
  // modifiers and the IS JSON family. `symmetric` is a key the between node
  // carries only when written; the corpus's plain `age BETWEEN 1 AND 10` row and
  // the `c NOT BETWEEN` below pin its omission.
  "SELECT (a, b), (a, b) = (1, 2), x = ANY ((a, b)) FROM t;",
  "SELECT (a, b) OVERLAPS (c, d), ROW(a, b) OVERLAPS ROW(c, d), NOT (a, b) OVERLAPS (c, d) AND e FROM t;",
  "SELECT a BETWEEN SYMMETRIC 1 AND 2, b NOT BETWEEN ASYMMETRIC 1 AND 2, c NOT BETWEEN 1 AND 2 FROM t;",
  "SELECT a IS JSON, b IS NOT JSON OBJECT WITH UNIQUE KEYS, c IS JSON ARRAY WITHOUT UNIQUE FROM t;",
  "SELECT EXISTS (SELECT 1 FROM u) FROM t;",
  "SELECT INTERVAL '1 day' FROM t;",
  // The niladic keyword functions (with and without a precision, which is
  // omitted rather than null when absent), the typed datetime literals, whose
  // type node carries its own span, and both spellings of OVERLAY.
  "SELECT current_date, current_timestamp(3), localtime(0), user, session_user FROM t;",
  "SELECT date '2024-01-01', time '10:00', timestamp(3) with time zone '2024-01-01 00:00' FROM t;",
  "SELECT overlay(s PLACING 'ab' FROM 2 FOR 3), overlay(s PLACING 'x' FROM 1), overlay(s, 'x', 1) FROM t;",
  "CREATE TABLE t (at timestamp DEFAULT current_timestamp, d date DEFAULT date '2020-01-01');",
  "SELECT count(*) FILTER (WHERE a > 1) FROM t;",
  "SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY x) FROM t;",
  "SELECT count(*) FROM t;",
  // The call modifiers that live inside the argument list: DISTINCT, an
  // aggregate ORDER BY, and PG's named-argument notation. Each is a key the
  // call node carries only when it is present, so these rows pin both the
  // modifier and — against the plain `count(*)` row above — its omission.
  "SELECT count(distinct x) FROM t;",
  "SELECT array_agg(a ORDER BY b DESC) FROM t;",
  "SELECT string_agg(a, ',' ORDER BY b) FROM t;",
  "SELECT f(a => 1, b => 2) FROM t;",
  // IGNORE / RESPECT NULLS wraps the call, nesting inside FILTER and OVER.
  "SELECT lag(x) IGNORE NULLS OVER (ORDER BY id) FROM t;",
  "SELECT count(x) RESPECT NULLS FILTER (WHERE x) OVER () FROM t;",
  "SELECT t.* FROM t;",
  // --- clause tails ---
  "SELECT sum(x) OVER (PARTITION BY a ORDER BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) FROM t;",
  "SELECT sum(x) OVER (RANGE BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING) FROM t;",
  "SELECT sum(x) OVER (ORDER BY id ROWS UNBOUNDED PRECEDING) FROM t;",
  "SELECT sum(x) OVER (ROWS 5 PRECEDING) FROM t;",
  // EXCLUDE is a frame key present only when written; the rows above pin its omission.
  "SELECT sum(x) OVER (ORDER BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING EXCLUDE CURRENT ROW) FROM t;",
  "SELECT sum(x) OVER (GROUPS 1 PRECEDING EXCLUDE TIES), sum(x) OVER (RANGE CURRENT ROW EXCLUDE NO OTHERS) FROM t;",
  // USING is an order-item key present only when written; `c DESC` pins its omission.
  "SELECT a FROM t ORDER BY a USING <, b USING > NULLS FIRST, c DESC;",
  "SELECT a FROM t GROUP BY CUBE (a, b), ROLLUP (c), GROUPING SETS ((a), ());",
  "SELECT a FROM t GROUP BY DISTINCT a, ();",
  "SELECT a, count(*) INTO TABLE reports.summary FROM t GROUP BY ALL a;",
  "SELECT a INTO GLOBAL TEMP scratch FROM t;",
  "SELECT 1 OFFSET 5 ROWS FETCH NEXT 3 ROWS WITH TIES;",
  "SELECT 1 UNION VALUES (2);",
  "SELECT * FROM t FOR NO KEY UPDATE FOR KEY SHARE SKIP LOCKED;",
  // CTE materialization and the recursive-CTE SEARCH / CYCLE tails, each a key
  // the CTE node carries only when written (the plain-CTE corpus rows pin the omission).
  "WITH a AS MATERIALIZED (SELECT 1), b AS NOT MATERIALIZED (SELECT 2) SELECT * FROM a, b;",
  "WITH RECURSIVE t (id) AS (SELECT 1) SEARCH BREADTH FIRST BY id SET ord CYCLE id SET is_cycle TO 'Y' DEFAULT 'N' USING path SELECT * FROM t;",
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
  "ALTER TABLE IF EXISTS s.t ADD COLUMN IF NOT EXISTS a int, ADD IF NOT EXISTS b text, DROP c, OWNER TO bob;",
  "ALTER TABLE IF EXISTS t RENAME TO t2;",
  // The other ALTER targets; only INDEX and VIEW take an action list.
  "ALTER SCHEMA s RENAME TO s2;",
  "ALTER DOMAIN app.d ADD CONSTRAINT pos CHECK (VALUE > 0) NOT VALID;",
  "ALTER DOMAIN d DROP CONSTRAINT IF EXISTS pos CASCADE;",
  "ALTER DOMAIN d SET DEFAULT 0;",
  "ALTER TYPE mood ADD VALUE IF NOT EXISTS 'meh' BEFORE 'sad';",
  "ALTER TYPE mood RENAME VALUE 'sad' TO 'blue';",
  "ALTER TYPE mood SET SCHEMA archive;",
  "ALTER INDEX IF EXISTS i SET (fillfactor = 70), RESET (deduplicate_items), SET TABLESPACE ts;",
  "ALTER FUNCTION s.f(double precision, a int) RENAME TO g;",
  "ALTER FUNCTION f(int) IMMUTABLE NOT LEAKPROOF SECURITY DEFINER SET search_path = public;",
  "ALTER AGGREGATE a(*) OWNER TO r;",
  "ALTER VIEW IF EXISTS v ALTER COLUMN c SET DEFAULT 1, OWNER TO r, SET (security_barrier);",
  "ALTER MATERIALIZED VIEW m RENAME COLUMN a TO b;",
  "ALTER SEQUENCE IF EXISTS s RESTART WITH 5 OWNED BY t.id;",
  "ALTER SEQUENCE s SET SCHEMA archive;",
  "CREATE TABLE t (id int NOT NULL DEFAULT 0, u text UNIQUE, parent int REFERENCES p (id) ON DELETE CASCADE, CHECK (id > 0));",
  "CREATE TABLE t (a int NULL, b int, FOREIGN KEY (b) REFERENCES p (id));",
  // LIKE as a table item and the clauses after the element list, each a key the
  // node carries only when written — against the rows above, which write none.
  "CREATE TABLE t (LIKE app.src INCLUDING DEFAULTS EXCLUDING INDEXES, id int) INHERITS (p, app.q);",
  "CREATE TABLE t (id int) WITH (fillfactor = 70, autovacuum_enabled, x -1, y = 'z') ON COMMIT DELETE ROWS TABLESPACE ts;",
  "CREATE TABLE t (id int) WITH (toast.autovacuum_enabled = false, force_quote *, force_null (a, 'b'));",
  "CREATE TABLE t (a, b) WITH (fillfactor = 70) ON COMMIT DROP TABLESPACE ts AS SELECT 1, 2 WITH NO DATA;",
  // Declarative partitioning: PARTITION BY after the element list, and each
  // PARTITION OF bound, DEFAULT included, with and without an element list of
  // its own.
  'CREATE TABLE m (a int, b text) INHERITS (p) PARTITION BY RANGE (a, lower(b) COLLATE "C" text_pattern_ops, (a + 1)) WITH (fillfactor = 70) TABLESPACE ts;',
  "CREATE TABLE m_lo PARTITION OF m FOR VALUES FROM (0, MINVALUE) TO (100, MAXVALUE);",
  "CREATE TABLE m_ab PARTITION OF m (a WITH OPTIONS NOT NULL, b DEFAULT 'x', CONSTRAINT k CHECK (a > 0)) FOR VALUES IN ('a', 'b') PARTITION BY HASH (a);",
  "CREATE TABLE m_h0 PARTITION OF m FOR VALUES WITH (MODULUS 4, REMAINDER 0) WITH (fillfactor = 70) ON COMMIT DROP;",
  "CREATE TABLE IF NOT EXISTS m_rest PARTITION OF app.m DEFAULT;",
  // The foreign-key tail (MATCH, ON DELETE / ON UPDATE in either order) and the
  // DEFERRABLE / INITIALLY attributes, column- and table-level. Each new key is
  // present only when its clause is, so the pre-existing constraint rows stay
  // as they were.
  "CREATE TABLE t (a int REFERENCES p (id) MATCH FULL ON UPDATE CASCADE ON DELETE SET DEFAULT DEFERRABLE INITIALLY DEFERRED NOT NULL, b int UNIQUE NOT DEFERRABLE, CONSTRAINT fk FOREIGN KEY (b) REFERENCES p ON DELETE NO ACTION ON UPDATE SET NULL INITIALLY IMMEDIATE, PRIMARY KEY (a) DEFERRABLE);",
  "ALTER TABLE t ADD CONSTRAINT fk FOREIGN KEY (a) REFERENCES p MATCH SIMPLE ON UPDATE RESTRICT NOT DEFERRABLE;",
  // Identity columns (with and without a sequence option list), a stored
  // generated column and a column-level COLLATE. `options` is present only when
  // its list is written.
  'CREATE TABLE t (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, n int GENERATED BY DEFAULT AS IDENTITY (START WITH 10 INCREMENT BY 5 NO CYCLE), d int GENERATED ALWAYS AS (n * 2) STORED, s text COLLATE "C" NOT NULL);',
  "ALTER TABLE t ADD COLUMN k int GENERATED BY DEFAULT AS IDENTITY;",
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
  // --- multi-word type names: the spellings typeRef used to alias apart ---
  "SELECT a::double precision, b::timestamp(3) with time zone, c::interval day to second FROM t;",
  "CREATE TABLE t (a character varying(10), b bit varying(4), c time without time zone, d double precision[]);",
  "CREATE FUNCTION f(double precision, a timestamp with time zone) RETURNS int LANGUAGE sql AS $$SELECT 1$$;",
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
  // PREPARE with and without a (multi-word) type list, over a query and a
  // WITH-led DML body; EXECUTE with and without arguments.
  "PREPARE q (int, double precision, timestamp with time zone) AS SELECT $1, $2 FROM t WHERE c = $3;",
  "PREPARE ins AS WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x RETURNING id;",
  "EXECUTE q (1, 2.5, now());",
  "EXECUTE ins;",
  "INSERT INTO t (a) VALUES (1) ON CONFLICT DO UPDATE SET a = 2 WHERE t.a > 0;",
  "CREATE TABLE t (flags bit DEFAULT B'1011', mask bit DEFAULT X'ff', label text DEFAULT U&'\\0041');",
  // Index columns with an operator class, ordering and NULLS placement, and an
  // index's storage parameters.
  "CREATE UNIQUE INDEX i ON t USING btree (lower(a) text_pattern_ops DESC NULLS LAST, b NULLS FIRST, c ASC) INCLUDE (d) WITH (fillfactor = 70, deduplicate_items = off) WHERE d > 0;",
  // --- EXCLUDE table constraints ---
  "CREATE TABLE t (r tsrange, EXCLUDE USING gist (r WITH &&) INCLUDE (r) WHERE (r IS NOT NULL) DEFERRABLE);",
  "ALTER TABLE t ADD CONSTRAINT no_overlap EXCLUDE (a WITH =, b WITH <>), ADD exclude text;",
  // INSERT's DEFAULT VALUES, DEFAULT row items, AS alias, OVERRIDING and ON
  // CONFLICT ON CONSTRAINT; the INSERT rows above pin the keys they omit.
  "INSERT INTO t AS x DEFAULT VALUES RETURNING x.id;",
  "INSERT INTO t (a, b) VALUES (DEFAULT, 1), (2, DEFAULT);",
  "INSERT INTO t AS x (a) OVERRIDING SYSTEM VALUE VALUES (1) ON CONFLICT ON CONSTRAINT t_pkey DO UPDATE SET a = x.a + 1;",
  "INSERT INTO t OVERRIDING USER VALUE SELECT * FROM u ON CONFLICT ON CONSTRAINT t_pkey DO NOTHING;",
  // The DROP object kinds past the original six, each with its own per-kind key
  // (signatures, table, force), which the corpus's DROP TABLE row pins absent.
  "DROP FUNCTION IF EXISTS f(int, double precision), s.g CASCADE;",
  "DROP PROCEDURE p(IN a int, OUT b text);",
  "DROP AGGREGATE myavg(*), s.agg(int) RESTRICT;",
  "DROP TRIGGER IF EXISTS trg ON s.t CASCADE;",
  "DROP DATABASE IF EXISTS db WITH (FORCE);",
  "DROP MATERIALIZED VIEW IF EXISTS mv, s.mv2;",
  "DROP DOMAIN d; DROP EXTENSION IF EXISTS hstore CASCADE; DROP ROLE a, b; DROP USER u;",
  // --- CREATE DATABASE, SCHEMA, EXTENSION and TABLESPACE ---
  "CREATE DATABASE d WITH OWNER = bob TEMPLATE template0 ENCODING 'UTF8' CONNECTION LIMIT -1 IS_TEMPLATE false;",
  "CREATE SCHEMA IF NOT EXISTS s AUTHORIZATION CURRENT_USER;",
  "CREATE SCHEMA s AUTHORIZATION bob CREATE TABLE t (id int) CREATE OR REPLACE VIEW v AS SELECT id FROM t GRANT SELECT ON t TO bob;",
  "CREATE SCHEMA AUTHORIZATION bob;",
  "CREATE EXTENSION IF NOT EXISTS hstore WITH SCHEMA public VERSION '1.4' CASCADE;",
  "CREATE TABLESPACE ts OWNER bob LOCATION '/data' WITH (seq_page_cost = 1.5);",
  // --- TEMPORARY, UNLOGGED and scoped CREATE TABLE ---
  "CREATE TEMP TABLE t (id int) ON COMMIT DELETE ROWS;",
  "CREATE UNLOGGED TABLE IF NOT EXISTS s.t (id int, note text);",
  "CREATE GLOBAL TEMPORARY TABLE t (id int);",
  "CREATE LOCAL TEMP TABLE snap AS SELECT 1 AS one;",
  // --- COPY: each location, the option shapes (bare, word, string, list, `*`)
  // and WHERE; a query source, WITH-prefixed DML with RETURNING included ---
  "COPY s.t (a, b) FROM STDIN WITH (FORMAT csv, HEADER MATCH, NULL '', FORCE_NOT_NULL (a, b), FREEZE) WHERE a > 0;",
  "COPY t TO PROGRAM 'gzip > /tmp/t.gz' (FORMAT csv, FORCE_QUOTE *, DELIMITER ';', ENCODING 'UTF8');",
  "COPY (WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x RETURNING id) TO STDOUT;",
  "COPY (SELECT a FROM t UNION SELECT b FROM u) TO '/tmp/out.csv' (HEADER);",
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
// MALFORMED below); the operator / punctuation-trie partition; and the three
// letter-prefixed literal forms, whose prefixes are case-insensitive for the
// same reason the E-string's is, and whose bodies are decoded (unicode) or
// validated (bit / hex) before the parser ever sees them.
const LEXER_EDGE_CASES = [
  "SELECT 0xff, 1_000, 1e5, .5, 1.5e-3 FROM t;",
  "SELECT E'a\\nb', e'lower\\tprefix', 'it''s', \"MixedCase\" FROM t;",
  "SELECT 'héllo wörld', 'naïve — em dash' FROM \"café\";",
  "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$SELECT 1$$;",
  "SELECT a || b, c @> d, x::int, $1, $name FROM t;",
  "/* outer /* inner */ still outer */ SELECT 1; -- trailing\n",
  "SELECT B'1011', b'0', X'ff', x'AB' FROM t;",
  "SELECT U&'\\0041', U&'d\\0061t\\+000061', U&'d!0061t!+000061' UESCAPE '!' FROM t;",
  "SELECT U&'it''s' uescape, b, x, u FROM t;",
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
  // The three croak sites in the letter-prefixed literal readers. A lexer
  // croak has to leave the cursor somewhere recovery can resync from, and the
  // only way to see that is to pin what `diagnose` salvages: the first two
  // read past the whole literal, so the trailing statement survives.
  "SELECT B'12' FROM t;\nSELECT 1;",
  "SELECT U&'\\00' FROM t;\nSELECT 2;",
  // The UESCAPE character is read as a whole `'…'` for exactly this reason —
  // croaking with its closing quote unconsumed left that quote to open a
  // runaway string that ate the rest of the input.
  "SELECT U&'x' UESCAPE '5' FROM t;\nSELECT 3;",
  // A truncated tail is rejected on the same test: one legal character is not
  // enough if the quote that would have closed it never arrived. The one row
  // here whose trailing statement is *not* recoverable, and necessarily so —
  // the unclosed literal swallowed it, exactly as an unclosed `'…'` would.
  "SELECT U&'\\0041' UESCAPE '!\nSELECT 4;",
  // A lex error *inside* a multi-word type name's lookahead. Filling the
  // lookahead buffer consumes the offending character, so typeRef has to report
  // it rather than discard it along with the failed tail. Both errors survive,
  // but this is the one row here whose list is not in source order: the
  // lookahead runs, and reports, before the syntax error it declines to cause.
  "CREATE TABLE t (c timestamp with é);\nSELECT 7;",
  // The same mechanism with the tail completing rather than failing, which is
  // the more surprising outcome and so pinned separately: `interval day` is a
  // type, the bad character is the statement's only error, and the column
  // definition around it recovers into the AST whole.
  "CREATE TABLE t (c interval day é);\nSELECT 8;",
  // The constraint-attribute tail after UNIQUE / PRIMARY KEY / REFERENCES peeks
  // a second token only past a `not`. Peeking unconditionally, the bad
  // character after the comma would fail inside the UNIQUE handler and take
  // column `a` down with it. The second row is the peek it does take: the
  // column is lost, exactly as NOT NULL's own `null` lookup would lose it.
  "CREATE TABLE t (a int UNIQUE, é int);\nSELECT 9;",
  "CREATE TABLE t (a int UNIQUE NOT é);\nSELECT 10;",
  // At table level the tail's peek meets the bad character inside the UNIQUE
  // item, so recovery resyncs at the next comma and the table survives with
  // both columns.
  "CREATE TABLE t (a int, UNIQUE (a) é, b int);\nSELECT 11;",
  // A failure inside a LIKE item recovers like one inside a column: the
  // element-list siblings around it survive.
  "CREATE TABLE t (id int, LIKE src INCLUDING everything, ok text);\nSELECT 12;",
  // So does one inside a PARTITION OF element list, the second list a CREATE
  // TABLE can carry.
  "CREATE TABLE p PARTITION OF m (a NOT NULL, b DEFAULT, c DEFAULT 0) DEFAULT;\nSELECT 13;",
  // The empty-list check peeks past the `(`, which must report a lex error on
  // the first item rather than throw it past recovery: the table survives.
  "CREATE TABLE p PARTITION OF m (é a NOT NULL, b DEFAULT 1) DEFAULT;\nSELECT 14;",
  // A `(` in FROM ahead of no query word is read as a parenthesised join, so a
  // lone table in parentheses fails at its `)`.
  "SELECT * FROM (a);\nSELECT 15;",
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
