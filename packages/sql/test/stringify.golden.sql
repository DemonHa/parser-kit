-- SELECT * FROM users u;
SELECT * FROM users AS u;

-- SELECT id, name AS n, u.age full_age FROM users u;
SELECT id, name AS n, u.age AS full_age FROM users AS u;

-- SELECT DISTINCT a FROM t;
SELECT DISTINCT a FROM t;

-- SELECT DISTINCT ON (a, b) a FROM t;
SELECT DISTINCT ON (a, b) a FROM t;

-- SELECT 1 OFFSET 5 LIMIT 10;
SELECT 1 LIMIT 10 OFFSET 5;

-- SELECT (SELECT max(x) FROM u) m FROM t;
SELECT (SELECT max(x) FROM u) AS m FROM t;

-- SELECT rank() OVER w AS r FROM t WINDOW w AS (PARTITION BY a ORDER BY b);
SELECT rank() OVER w AS r FROM t WINDOW w AS (PARTITION BY a ORDER BY b);

-- SELECT * FROM (VALUES (1), (2)) t;
SELECT * FROM (VALUES (1), (2)) AS t;

-- SELECT 1 FROM t WHERE x = ANY (SELECT id FROM u);
SELECT 1 FROM t WHERE x = ANY (SELECT id FROM u);

-- SELECT a FROM t UNION SELECT a FROM u EXCEPT ALL SELECT a FROM v;
SELECT a FROM t UNION SELECT a FROM u EXCEPT ALL SELECT a FROM v;

-- SELECT * FROM t FOR UPDATE OF t, u NOWAIT;
SELECT * FROM t FOR UPDATE OF t, u NOWAIT;

-- WITH cte AS (SELECT 1 AS x) SELECT x FROM cte;
WITH cte AS (SELECT 1 AS x) SELECT x FROM cte;

-- WITH RECURSIVE r (n) AS (SELECT 1) SELECT * FROM r;
WITH RECURSIVE r (n) AS (SELECT 1) SELECT * FROM r;

-- INSERT INTO t (a, b) VALUES (1, 2), (3, 4) RETURNING *;
-- not yet printable: insert

-- INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO NOTHING;
-- not yet printable: insert

-- INSERT INTO t SELECT * FROM u;
-- not yet printable: insert

-- UPDATE t AS x SET a = 1, b = 2 FROM u WHERE x.id = u.id RETURNING a;
-- not yet printable: update

-- DELETE FROM t x USING u WHERE x.id = u.id RETURNING *;
-- not yet printable: delete

-- CREATE TABLE t (id int, name text);
-- not yet printable: createTable

-- CREATE TABLE t (a varchar(10), b numeric(10, 2), c int[], d text[][]);
-- not yet printable: createTable

-- CREATE TABLE IF NOT EXISTS app.users (id int, CONSTRAINT pk PRIMARY KEY (id));
-- not yet printable: createTable

-- CREATE INDEX idx_email ON users (email);
-- not yet printable: createIndex

-- CREATE UNIQUE INDEX ON users (lower(email)) WHERE active;
-- not yet printable: createIndex

-- CREATE VIEW active AS SELECT id FROM users WHERE active;
-- not yet printable: createView

-- DROP TABLE IF EXISTS a, public.b;
-- not yet printable: drop

-- TRUNCATE TABLE a, b RESTART IDENTITY CASCADE;
-- not yet printable: truncate

-- CREATE TABLE t (c int CHECK (a = 1 AND b = 2 OR c = 3));
-- not yet printable: createTable

-- SELECT a || b || c FROM t;
SELECT a || b || c FROM t;

-- SELECT x::int FROM t;
SELECT x::int FROM t;

-- SELECT age BETWEEN 1 AND 10 FROM t;
SELECT age BETWEEN 1 AND 10 FROM t;

-- SELECT id IN (1, 2, 3) FROM t;
SELECT id IN (1, 2, 3) FROM t;

-- SELECT coalesce(a, 0), now() FROM t;
SELECT coalesce(a, 0), now() FROM t;

-- SELECT data -> 'k' FROM t;
SELECT data -> 'k' FROM t;

-- SELECT name LIKE 'a%' FROM t;
SELECT name LIKE 'a%' FROM t;

-- SELECT 1 FROM users u JOIN teams t ON u.team_id = t.id;
SELECT 1 FROM users AS u JOIN teams AS t ON u.team_id = t.id;

-- SELECT 1 FROM a LEFT JOIN b USING (id) CROSS JOIN c;
SELECT 1 FROM a LEFT JOIN b USING (id) CROSS JOIN c;

-- SELECT * FROM a CROSS JOIN LATERAL unnest(a.tags) t;
SELECT * FROM a CROSS JOIN LATERAL unnest(a.tags) AS t;

-- SELECT * FROM t AS x TABLESAMPLE bernoulli (10) REPEATABLE (5);
SELECT * FROM t AS x TABLESAMPLE bernoulli (10) REPEATABLE (5);

-- SELECT * FROM ONLY t AS x (a, b) TABLESAMPLE system (10), (VALUES (1, 2)) AS v (c, d);
SELECT *
FROM ONLY t AS x (a, b) TABLESAMPLE system (10), (VALUES (1, 2)) AS v (c, d);

-- SELECT * FROM generate_series(1, 3) g (n) JOIN ONLY (s.u) ON true, LATERAL (SELECT 1) l (one);
SELECT *
FROM
  generate_series(1, 3) AS g (n)
  JOIN ONLY s.u ON TRUE,
  LATERAL (SELECT 1) AS l (one);

-- SELECT * FROM ((a JOIN b ON true) j JOIN c USING (id)) AS x (p, q), ((SELECT 1) UNION (SELECT 2)) s;
SELECT *
FROM
  ((a JOIN b ON TRUE) AS j JOIN c USING (id)) AS x (p, q),
  (SELECT 1 UNION SELECT 2) AS s;

-- SELECT * FROM ROWS FROM (f(1), g()) WITH ORDINALITY AS r (a, b, n), unnest(arr) WITH ORDINALITY u;
SELECT *
FROM
  ROWS FROM (f(1), g()) WITH ORDINALITY AS r (a, b, n),
  unnest(arr) WITH ORDINALITY AS u;

-- SELECT -a, NOT b FROM t;
SELECT -a, NOT b FROM t;

-- SELECT +a, -2 ^ 2, a ^ b ^ c, a % b, a::int ^ 2 FROM t;
SELECT +a, -2 ^ 2, a ^ b ^ c, a % b, a::int ^ 2 FROM t;

-- SELECT a & b, c | d, e # f, g << 1, h >> 1, doc @? '$.x' FROM t;
SELECT a & b, c | d, e # f, g << 1, h >> 1, doc @? '$.x' FROM t;

-- SELECT CASE WHEN a THEN 1 WHEN b THEN 2 ELSE 3 END, CASE x WHEN 1 THEN 'a' END FROM t;
SELECT CASE WHEN a THEN 1 WHEN b THEN 2 ELSE 3 END, CASE x WHEN 1 THEN 'a' END
FROM t;

-- SELECT ARRAY[1, 2, 3], a[1], b[1:2] FROM t;
SELECT ARRAY[1, 2, 3], a[1], b[1:2] FROM t;

-- SELECT ROW(1, 2) FROM t;
SELECT ROW(1, 2) FROM t;

-- SELECT extract(year FROM d), position('a' IN s), substring(s FROM 1 FOR 2), trim(BOTH 'x' FROM s) FROM t;
SELECT
  EXTRACT(year FROM d),
  POSITION('a' IN s),
  SUBSTRING(s FROM 1 FOR 2),
  TRIM(BOTH 'x' FROM s)
FROM t;

-- SELECT a IS NULL, b IS NOT NULL, c IS DISTINCT FROM d, e IS NOT DISTINCT FROM f FROM t;
SELECT a IS NULL, b IS NOT NULL, c IS DISTINCT FROM d, e IS NOT DISTINCT FROM f
FROM t;

-- SELECT true, false, null, a IS TRUE, b IS NOT FALSE FROM t;
SELECT TRUE, FALSE, NULL, a IS TRUE, b IS NOT FALSE FROM t;

-- SELECT a SIMILAR TO 'x%', b AT TIME ZONE 'utc', c COLLATE "C" FROM t;
SELECT a SIMILAR TO 'x%', b AT TIME ZONE 'utc', c COLLATE "C" FROM t;

-- SELECT a IN (SELECT id FROM u), b NOT IN (1, 2) FROM t;
SELECT a IN (SELECT id FROM u), b NOT IN (1, 2) FROM t;

-- SELECT (a, b), (a, b) = (1, 2), x = ANY ((a, b)) FROM t;
SELECT (a, b), (a, b) = (1, 2), x = ANY ((a, b)) FROM t;

-- SELECT (a, b) OVERLAPS (c, d), ROW(a, b) OVERLAPS ROW(c, d), NOT (a, b) OVERLAPS (c, d) AND e FROM t;
SELECT
  (a, b) OVERLAPS (c, d),
  ROW(a, b) OVERLAPS ROW(c, d),
  NOT (a, b) OVERLAPS (c, d) AND e
FROM t;

-- SELECT a BETWEEN SYMMETRIC 1 AND 2, b NOT BETWEEN ASYMMETRIC 1 AND 2, c NOT BETWEEN 1 AND 2 FROM t;
SELECT
  a BETWEEN SYMMETRIC 1 AND 2,
  b NOT BETWEEN ASYMMETRIC 1 AND 2,
  c NOT BETWEEN 1 AND 2
FROM t;

-- SELECT a IS JSON, b IS NOT JSON OBJECT WITH UNIQUE KEYS, c IS JSON ARRAY WITHOUT UNIQUE FROM t;
SELECT
  a IS JSON,
  b IS NOT JSON OBJECT WITH UNIQUE KEYS,
  c IS JSON ARRAY WITHOUT UNIQUE KEYS
FROM t;

-- SELECT EXISTS (SELECT 1 FROM u) FROM t;
SELECT EXISTS (SELECT 1 FROM u) FROM t;

-- SELECT INTERVAL '1 day' FROM t;
SELECT INTERVAL '1 day' FROM t;

-- SELECT current_date, current_timestamp(3), localtime(0), user, session_user FROM t;
SELECT CURRENT_DATE, CURRENT_TIMESTAMP(3), LOCALTIME(0), USER, SESSION_USER
FROM t;

-- SELECT date '2024-01-01', time '10:00', timestamp(3) with time zone '2024-01-01 00:00' FROM t;
SELECT
  date '2024-01-01',
  time '10:00',
  timestamp(3) with time zone '2024-01-01 00:00'
FROM t;

-- SELECT overlay(s PLACING 'ab' FROM 2 FOR 3), overlay(s PLACING 'x' FROM 1), overlay(s, 'x', 1) FROM t;
SELECT
  OVERLAY(s PLACING 'ab' FROM 2 FOR 3),
  OVERLAY(s PLACING 'x' FROM 1),
  overlay(s, 'x', 1)
FROM t;

-- CREATE TABLE t (at timestamp DEFAULT current_timestamp, d date DEFAULT date '2020-01-01');
-- not yet printable: createTable

-- SELECT count(*) FILTER (WHERE a > 1) FROM t;
SELECT count(*) FILTER (WHERE a > 1) FROM t;

-- SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY x) FROM t;
SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY x) FROM t;

-- SELECT count(*) FROM t;
SELECT count(*) FROM t;

-- SELECT count(distinct x) FROM t;
SELECT count(DISTINCT x) FROM t;

-- SELECT array_agg(a ORDER BY b DESC) FROM t;
SELECT array_agg(a ORDER BY b DESC) FROM t;

-- SELECT string_agg(a, ',' ORDER BY b) FROM t;
SELECT string_agg(a, ',' ORDER BY b) FROM t;

-- SELECT f(a => 1, b => 2) FROM t;
SELECT f(a => 1, b => 2) FROM t;

-- SELECT lag(x) IGNORE NULLS OVER (ORDER BY id) FROM t;
SELECT lag(x) IGNORE NULLS OVER (ORDER BY id) FROM t;

-- SELECT count(x) RESPECT NULLS FILTER (WHERE x) OVER () FROM t;
SELECT count(x) RESPECT NULLS FILTER (WHERE x) OVER () FROM t;

-- SELECT t.* FROM t;
SELECT t.* FROM t;

-- SELECT sum(x) OVER (PARTITION BY a ORDER BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) FROM t;
SELECT
  sum(x) OVER (
    PARTITION BY a
    ORDER BY id
    ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING
  )
FROM t;

-- SELECT sum(x) OVER (RANGE BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING) FROM t;
SELECT sum(x) OVER (RANGE BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING) FROM t;

-- SELECT sum(x) OVER (ORDER BY id ROWS UNBOUNDED PRECEDING) FROM t;
SELECT sum(x) OVER (ORDER BY id ROWS UNBOUNDED PRECEDING) FROM t;

-- SELECT sum(x) OVER (ROWS 5 PRECEDING) FROM t;
SELECT sum(x) OVER (ROWS 5 PRECEDING) FROM t;

-- SELECT sum(x) OVER (ORDER BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING EXCLUDE CURRENT ROW) FROM t;
SELECT
  sum(x) OVER (
    ORDER BY id
    ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING EXCLUDE CURRENT ROW
  )
FROM t;

-- SELECT sum(x) OVER (GROUPS 1 PRECEDING EXCLUDE TIES), sum(x) OVER (RANGE CURRENT ROW EXCLUDE NO OTHERS) FROM t;
SELECT
  sum(x) OVER (GROUPS 1 PRECEDING EXCLUDE TIES),
  sum(x) OVER (RANGE CURRENT ROW EXCLUDE NO OTHERS)
FROM t;

-- SELECT a FROM t ORDER BY a USING <, b USING > NULLS FIRST, c DESC;
SELECT a FROM t ORDER BY a USING <, b USING > NULLS FIRST, c DESC;

-- SELECT a FROM t GROUP BY CUBE (a, b), ROLLUP (c), GROUPING SETS ((a), ());
SELECT a FROM t GROUP BY CUBE (a, b), ROLLUP (c), GROUPING SETS (a, ());

-- SELECT a FROM t GROUP BY DISTINCT a, ();
SELECT a FROM t GROUP BY DISTINCT a, ();

-- SELECT a, count(*) INTO TABLE reports.summary FROM t GROUP BY ALL a;
SELECT a, count(*) INTO reports.summary FROM t GROUP BY a;

-- SELECT a INTO GLOBAL TEMP scratch FROM t;
SELECT a INTO GLOBAL TEMP scratch FROM t;

-- SELECT 1 ORDER BY 1 OFFSET 5 ROWS FETCH NEXT 3 ROWS WITH TIES;
SELECT 1 ORDER BY 1 OFFSET 5 FETCH FIRST 3 ROWS WITH TIES;

-- SELECT 1 UNION VALUES (2);
SELECT 1 UNION VALUES (2);

-- SELECT * FROM t FOR NO KEY UPDATE FOR KEY SHARE SKIP LOCKED;
SELECT * FROM t FOR NO KEY UPDATE FOR KEY SHARE SKIP LOCKED;

-- WITH a AS MATERIALIZED (SELECT 1), b AS NOT MATERIALIZED (SELECT 2) SELECT * FROM a, b;
WITH a AS MATERIALIZED (SELECT 1), b AS NOT MATERIALIZED (SELECT 2)
SELECT *
FROM a, b;

-- WITH RECURSIVE t (id) AS (SELECT 1) SEARCH BREADTH FIRST BY id SET ord CYCLE id SET is_cycle TO 'Y' DEFAULT 'N' USING path SELECT * FROM t;
WITH RECURSIVE
  t (id) AS (SELECT 1)
  SEARCH BREADTH FIRST BY id SET ord
  CYCLE id SET is_cycle TO 'Y' DEFAULT 'N' USING path
SELECT *
FROM t;

-- ALTER TABLE t ADD COLUMN age int;
-- not yet printable: alterTable

-- ALTER TABLE t ADD CONSTRAINT pk PRIMARY KEY (id);
-- not yet printable: alterTable

-- ALTER TABLE t ALTER COLUMN email SET NOT NULL;
-- not yet printable: alterTable

-- ALTER TABLE t ALTER COLUMN status DROP DEFAULT;
-- not yet printable: alterTable

-- ALTER TABLE t RENAME COLUMN old TO new;
-- not yet printable: alterTable

-- ALTER TABLE t RENAME CONSTRAINT pk_old TO pk_new;
-- not yet printable: alterTable

-- ALTER TABLE t DROP COLUMN age;
-- not yet printable: alterTable

-- ALTER TABLE t ALTER email DROP NOT NULL;
-- not yet printable: alterTable

-- ALTER TABLE t ALTER COLUMN status SET DEFAULT 'active';
-- not yet printable: alterTable

-- ALTER TABLE t ALTER COLUMN n SET DATA TYPE bigint;
-- not yet printable: alterTable

-- CREATE SEQUENCE s RESTART WITH 1;
-- not yet printable: createSequence

-- ALTER TABLE t RENAME TO t2;
-- not yet printable: alterTable

-- ALTER TABLE t OWNER TO admin;
-- not yet printable: alterTable

-- ALTER TABLE t REPLICA IDENTITY USING INDEX t_pkey;
-- not yet printable: alterTable

-- ALTER TABLE IF EXISTS s.t ADD COLUMN IF NOT EXISTS a int, ADD IF NOT EXISTS b text, DROP c, OWNER TO bob;
-- not yet printable: alterTable

-- ALTER TABLE IF EXISTS t RENAME TO t2;
-- not yet printable: alterTable

-- ALTER TABLE t DROP CONSTRAINT IF EXISTS c CASCADE, VALIDATE CONSTRAINT k, SET TABLESPACE fast, SET WITHOUT CLUSTER;
-- not yet printable: alterTable

-- ALTER TABLE t ENABLE REPLICA TRIGGER audit, ENABLE TRIGGER ALL, DISABLE TRIGGER USER, CLUSTER ON t_pkey, SET (fillfactor = 70), RESET (x);
-- not yet printable: alterTable

-- ALTER TABLE s.t SET SCHEMA archive;
-- not yet printable: alterTable

-- ALTER TABLE t ATTACH PARTITION p FOR VALUES FROM (1) TO (10);
-- not yet printable: alterTable

-- ALTER TABLE t DETACH PARTITION p CONCURRENTLY;
-- not yet printable: alterTable

-- ALTER SCHEMA s RENAME TO s2;
-- not yet printable: alterSchema

-- ALTER DOMAIN app.d ADD CONSTRAINT pos CHECK (VALUE > 0) NOT VALID;
-- not yet printable: alterDomain

-- ALTER DOMAIN d DROP CONSTRAINT IF EXISTS pos CASCADE;
-- not yet printable: alterDomain

-- ALTER DOMAIN d SET DEFAULT 0;
-- not yet printable: alterDomain

-- ALTER TYPE mood ADD VALUE IF NOT EXISTS 'meh' BEFORE 'sad';
-- not yet printable: alterType

-- ALTER TYPE mood RENAME VALUE 'sad' TO 'blue';
-- not yet printable: alterType

-- ALTER TYPE mood SET SCHEMA archive;
-- not yet printable: alterType

-- ALTER INDEX IF EXISTS i SET (fillfactor = 70), RESET (deduplicate_items), SET TABLESPACE ts;
-- not yet printable: alterIndex

-- ALTER FUNCTION s.f(double precision, a int) RENAME TO g;
-- not yet printable: alterFunction

-- ALTER FUNCTION f(int) IMMUTABLE NOT LEAKPROOF SECURITY DEFINER SET search_path = public;
-- not yet printable: alterFunction

-- ALTER AGGREGATE a(*) OWNER TO r;
-- not yet printable: alterAggregate

-- ALTER VIEW IF EXISTS v ALTER COLUMN c SET DEFAULT 1, OWNER TO r, SET (security_barrier);
-- not yet printable: alterView

-- ALTER MATERIALIZED VIEW m RENAME COLUMN a TO b;
-- not yet printable: alterView

-- ALTER SEQUENCE IF EXISTS s RESTART WITH 5 OWNED BY t.id;
-- not yet printable: alterSequence

-- ALTER SEQUENCE s SET SCHEMA archive;
-- not yet printable: alterSequence

-- CREATE TABLE t (id int NOT NULL DEFAULT 0, u text UNIQUE, parent int REFERENCES p (id) ON DELETE CASCADE, CHECK (id > 0));
-- not yet printable: createTable

-- CREATE TABLE t (a int NULL, b int, FOREIGN KEY (b) REFERENCES p (id));
-- not yet printable: createTable

-- CREATE TABLE t (LIKE app.src INCLUDING DEFAULTS EXCLUDING INDEXES, id int) INHERITS (p, app.q);
-- not yet printable: createTable

-- CREATE TABLE t (id int) WITH (fillfactor = 70, autovacuum_enabled, x -1, y = 'z') ON COMMIT DELETE ROWS TABLESPACE ts;
-- not yet printable: createTable

-- CREATE TABLE t (id int) WITH (toast.autovacuum_enabled = false, force_quote *, force_null (a, 'b'));
-- not yet printable: createTable

-- CREATE TABLE t (a, b) WITH (fillfactor = 70) ON COMMIT DROP TABLESPACE ts AS SELECT 1, 2 WITH NO DATA;
-- not yet printable: createTableAs

-- CREATE TABLE m (a int, b text) INHERITS (p) PARTITION BY RANGE (a, lower(b) COLLATE "C" text_pattern_ops, (a + 1)) WITH (fillfactor = 70) TABLESPACE ts;
-- not yet printable: createTable

-- CREATE TABLE m_lo PARTITION OF m FOR VALUES FROM (0, MINVALUE) TO (100, MAXVALUE);
-- not yet printable: createTable

-- CREATE TABLE m_ab PARTITION OF m (a WITH OPTIONS NOT NULL, b DEFAULT 'x', CONSTRAINT k CHECK (a > 0)) FOR VALUES IN ('a', 'b') PARTITION BY HASH (a);
-- not yet printable: createTable

-- CREATE TABLE m_h0 PARTITION OF m FOR VALUES WITH (MODULUS 4, REMAINDER 0) WITH (fillfactor = 70) ON COMMIT DROP;
-- not yet printable: createTable

-- CREATE TABLE IF NOT EXISTS m_rest PARTITION OF app.m DEFAULT;
-- not yet printable: createTable

-- CREATE TABLE t (a int REFERENCES p (id) MATCH FULL ON UPDATE CASCADE ON DELETE SET DEFAULT DEFERRABLE INITIALLY DEFERRED NOT NULL, b int UNIQUE NOT DEFERRABLE, CONSTRAINT fk FOREIGN KEY (b) REFERENCES p ON DELETE NO ACTION ON UPDATE SET NULL INITIALLY IMMEDIATE, PRIMARY KEY (a) DEFERRABLE);
-- not yet printable: createTable

-- ALTER TABLE t ADD CONSTRAINT fk FOREIGN KEY (a) REFERENCES p MATCH SIMPLE ON UPDATE RESTRICT NOT DEFERRABLE;
-- not yet printable: alterTable

-- CREATE TABLE t (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, n int GENERATED BY DEFAULT AS IDENTITY (START WITH 10 INCREMENT BY 5 NO CYCLE), d int GENERATED ALWAYS AS (n * 2) STORED, s text COLLATE "C" NOT NULL);
-- not yet printable: createTable

-- ALTER TABLE t ADD COLUMN k int GENERATED BY DEFAULT AS IDENTITY;
-- not yet printable: alterTable

-- CREATE TABLE snap AS SELECT id, name FROM users;
-- not yet printable: createTableAs

-- CREATE SEQUENCE s MINVALUE -100 NO CYCLE OWNED BY NONE;
-- not yet printable: createSequence

-- CREATE SEQUENCE IF NOT EXISTS s AS bigint INCREMENT BY 2 MINVALUE 1 NO MAXVALUE START WITH 10 CACHE 5 CYCLE OWNED BY t.id;
-- not yet printable: createSequence

-- CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy');
-- not yet printable: createType

-- CREATE DOMAIN positive int CHECK (VALUE > 0);
-- not yet printable: createDomain

-- CREATE AGGREGATE sum_agg(numeric) (SFUNC = numeric_add, STYPE = numeric, INITCOND = '0');
-- not yet printable: createAggregate

-- CREATE TRIGGER audit AFTER INSERT OR UPDATE OF a, b ON accounts FOR EACH ROW WHEN (new.active) EXECUTE FUNCTION log_change(1, 'x');
-- not yet printable: createTrigger

-- CREATE MATERIALIZED VIEW IF NOT EXISTS mv AS SELECT * FROM t WITH NO DATA;
-- not yet printable: createView

-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx ON users (email) INCLUDE (name, id);
-- not yet printable: createIndex

-- CREATE OR REPLACE FUNCTION add(a integer, b integer DEFAULT 0) RETURNS integer LANGUAGE sql IMMUTABLE STRICT AS $$SELECT a + b$$;
-- not yet printable: createFunction

-- CREATE FUNCTION h() RETURNS int LANGUAGE sql LEAKPROOF ROWS 100 SET x FROM CURRENT AS $$SELECT 1$$;
-- not yet printable: createFunction

-- CREATE FUNCTION g() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public COST 100 PARALLEL SAFE AS $$SELECT 1$$;
-- not yet printable: createFunction

-- SELECT a::double precision, b::timestamp(3) with time zone, c::interval day to second FROM t;
SELECT
  a::double precision,
  b::timestamp(3) with time zone,
  c::interval day to second
FROM t;

-- CREATE TABLE t (a character varying(10), b bit varying(4), c time without time zone, d double precision[]);
-- not yet printable: createTable

-- CREATE FUNCTION f(double precision, a timestamp with time zone) RETURNS int LANGUAGE sql AS $$SELECT 1$$;
-- not yet printable: createFunction

-- GRANT SELECT, UPDATE (a, b) ON TABLE t1, t2 TO alice, bob WITH GRANT OPTION;
-- not yet printable: grant

-- REVOKE GRANT OPTION FOR SELECT ON t FROM alice CASCADE;
-- not yet printable: revoke

-- BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE;
-- not yet printable: begin

-- START TRANSACTION ISOLATION LEVEL REPEATABLE READ NOT DEFERRABLE;
-- not yet printable: begin

-- SAVEPOINT sp;
-- not yet printable: savepoint

-- ROLLBACK TO SAVEPOINT sp;
-- not yet printable: rollback

-- RELEASE SAVEPOINT sp;
-- not yet printable: releaseSavepoint

-- COMMIT AND CHAIN;
-- not yet printable: commit

-- SET search_path = public, app;
-- not yet printable: set

-- SHOW search_path;
-- not yet printable: show

-- RESET ALL;
-- not yet printable: reset

-- DO $$ SELECT 1 $$ LANGUAGE sql;
-- not yet printable: do

-- COMMENT ON COLUMN users.email IS $q$primary contact$q$;
-- not yet printable: comment

-- DEALLOCATE PREPARE my_stmt;
-- not yet printable: deallocate

-- PREPARE q (int, double precision, timestamp with time zone) AS SELECT $1, $2 FROM t WHERE c = $3;
-- not yet printable: prepare

-- PREPARE ins AS WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x RETURNING id;
-- not yet printable: prepare

-- EXECUTE q (1, 2.5, now());
-- not yet printable: execute

-- EXECUTE ins;
-- not yet printable: execute

-- DECLARE c BINARY INSENSITIVE NO SCROLL CURSOR WITH HOLD FOR SELECT id FROM t ORDER BY id FETCH FIRST 10 ROWS ONLY;
-- not yet printable: declare

-- DECLARE c2 SCROLL ASENSITIVE CURSOR WITHOUT HOLD FOR WITH x AS (SELECT 1) SELECT * FROM x;
-- not yet printable: declare

-- FETCH NEXT FROM c;
-- not yet printable: fetch

-- FETCH PRIOR IN c;
-- not yet printable: fetch

-- FETCH ABSOLUTE -1 FROM c;
-- not yet printable: fetch

-- FETCH RELATIVE 2 c;
-- not yet printable: fetch

-- FETCH 5 FROM c;
-- not yet printable: fetch

-- FETCH ALL IN c;
-- not yet printable: fetch

-- FETCH FORWARD 3 FROM c;
-- not yet printable: fetch

-- FETCH BACKWARD ALL FROM c;
-- not yet printable: fetch

-- FETCH c;
-- not yet printable: fetch

-- MOVE LAST IN c;
-- not yet printable: move

-- MOVE FORWARD FROM c;
-- not yet printable: move

-- CLOSE c;
-- not yet printable: close

-- CLOSE ALL;
-- not yet printable: close

-- INSERT INTO t (a) VALUES (1) ON CONFLICT DO UPDATE SET a = 2 WHERE t.a > 0;
-- not yet printable: insert

-- CREATE TABLE t (flags bit DEFAULT B'1011', mask bit DEFAULT X'ff', label text DEFAULT U&'\0041');
-- not yet printable: createTable

-- CREATE UNIQUE INDEX i ON t USING btree (lower(a) text_pattern_ops DESC NULLS LAST, b NULLS FIRST, c ASC) INCLUDE (d) WITH (fillfactor = 70, deduplicate_items = off) WHERE d > 0;
-- not yet printable: createIndex

-- CREATE TABLE t (r tsrange, EXCLUDE USING gist (r WITH &&) INCLUDE (r) WHERE (r IS NOT NULL) DEFERRABLE);
-- not yet printable: createTable

-- ALTER TABLE t ADD CONSTRAINT no_overlap EXCLUDE (a WITH =, b WITH <>), ADD exclude text;
-- not yet printable: alterTable

-- INSERT INTO t AS x DEFAULT VALUES RETURNING x.id;
-- not yet printable: insert

-- INSERT INTO t (a, b) VALUES (DEFAULT, 1), (2, DEFAULT);
-- not yet printable: insert

-- INSERT INTO t AS x (a) OVERRIDING SYSTEM VALUE VALUES (1) ON CONFLICT ON CONSTRAINT t_pkey DO UPDATE SET a = x.a + 1;
-- not yet printable: insert

-- INSERT INTO t OVERRIDING USER VALUE SELECT * FROM u ON CONFLICT ON CONSTRAINT t_pkey DO NOTHING;
-- not yet printable: insert

-- DROP FUNCTION IF EXISTS f(int, double precision), s.g CASCADE;
-- not yet printable: drop

-- DROP PROCEDURE p(IN a int, OUT b text);
-- not yet printable: drop

-- DROP AGGREGATE myavg(*), s.agg(int) RESTRICT;
-- not yet printable: drop

-- DROP TRIGGER IF EXISTS trg ON s.t CASCADE;
-- not yet printable: drop

-- DROP DATABASE IF EXISTS db WITH (FORCE);
-- not yet printable: drop

-- DROP MATERIALIZED VIEW IF EXISTS mv, s.mv2;
-- not yet printable: drop

-- DROP DOMAIN d; DROP EXTENSION IF EXISTS hstore CASCADE; DROP ROLE a, b; DROP USER u;
-- not yet printable: drop
-- not yet printable: drop
-- not yet printable: drop
-- not yet printable: drop

-- CREATE DATABASE d WITH OWNER = bob TEMPLATE template0 ENCODING 'UTF8' CONNECTION LIMIT -1 IS_TEMPLATE false;
-- not yet printable: createDatabase

-- CREATE SCHEMA IF NOT EXISTS s AUTHORIZATION CURRENT_USER;
-- not yet printable: createSchema

-- CREATE SCHEMA s AUTHORIZATION bob CREATE TABLE t (id int) CREATE OR REPLACE VIEW v AS SELECT id FROM t GRANT SELECT ON t TO bob;
-- not yet printable: createSchema

-- CREATE SCHEMA AUTHORIZATION bob;
-- not yet printable: createSchema

-- CREATE EXTENSION IF NOT EXISTS hstore WITH SCHEMA public VERSION '1.4' CASCADE;
-- not yet printable: createExtension

-- CREATE TABLESPACE ts OWNER bob LOCATION '/data' WITH (seq_page_cost = 1.5);
-- not yet printable: createTablespace

-- EXPLAIN SELECT * FROM t;
-- not yet printable: explain

-- EXPLAIN ANALYZE VERBOSE WITH x AS (SELECT 1) DELETE FROM t USING x;
-- not yet printable: explain

-- EXPLAIN (ANALYZE, COSTS off, BUFFERS true, WAL 1, FORMAT JSON) (SELECT 1) UNION SELECT 2;
-- not yet printable: explain

-- EXPLAIN (VERBOSE) CREATE TABLE t (a) AS SELECT 1 WITH NO DATA;
-- not yet printable: explain

-- EXPLAIN (SELECT 1);
-- not yet printable: explain

-- EXPLAIN ANALYSE EXECUTE q (1);
-- not yet printable: explain

-- EXPLAIN DECLARE c NO SCROLL CURSOR WITH HOLD FOR SELECT * FROM t;
-- not yet printable: explain

-- EXPLAIN CREATE MATERIALIZED VIEW mv AS SELECT 1 WITH NO DATA;
-- not yet printable: explain

-- ANALYZE;
-- not yet printable: analyze

-- ANALYZE VERBOSE t (a, b), s.u;
-- not yet printable: analyze

-- ANALYZE (SKIP_LOCKED) t;
-- not yet printable: analyze

-- VACUUM FULL FREEZE VERBOSE ANALYZE t (a);
-- not yet printable: vacuum

-- VACUUM (PARALLEL 4, INDEX_CLEANUP auto) a, b;
-- not yet printable: vacuum

-- CREATE TEMP TABLE t (id int) ON COMMIT DELETE ROWS;
-- not yet printable: createTable

-- CREATE UNLOGGED TABLE IF NOT EXISTS s.t (id int, note text);
-- not yet printable: createTable

-- CREATE GLOBAL TEMPORARY TABLE t (id int);
-- not yet printable: createTable

-- CREATE LOCAL TEMP TABLE snap AS SELECT 1 AS one;
-- not yet printable: createTableAs

-- CREATE ROLE admin WITH LOGIN NOSUPERUSER CREATEDB CONNECTION LIMIT 5 ENCRYPTED PASSWORD 'pw' VALID UNTIL '2030-01-01' IN ROLE staff ADMIN bob;
-- not yet printable: createRole

-- CREATE USER bob PASSWORD NULL NOINHERIT ROLE a, b;
-- not yet printable: createRole

-- CREATE OR REPLACE PROCEDURE p(IN a integer, b text DEFAULT 'x') LANGUAGE plpgsql SECURITY DEFINER AS $$BEGIN NULL; END$$;
-- not yet printable: createProcedure

-- LOCK TABLE ONLY s.t, u *, ONLY (v) IN SHARE ROW EXCLUSIVE MODE NOWAIT;
-- not yet printable: lock

-- LOCK t IN ACCESS SHARE MODE;
-- not yet printable: lock

-- LOCK t;
-- not yet printable: lock

-- CALL s.p(1, 'a', b => 2);
-- not yet printable: callProcedure

-- CALL p();
-- not yet printable: callProcedure

-- CREATE OR REPLACE VIEW v (a, b) WITH (security_barrier, security_invoker = true) AS SELECT a, now()::timestamp FROM t WITH CHECK OPTION;
-- not yet printable: createView

-- CREATE VIEW v AS SELECT a FROM t WITH LOCAL CHECK OPTION;
-- not yet printable: createView

-- CREATE MATERIALIZED VIEW mv WITH (fillfactor = 70) AS SELECT now()::timestamp WITH NO DATA;
-- not yet printable: createView

-- REFRESH MATERIALIZED VIEW CONCURRENTLY s.mv WITH DATA;
-- not yet printable: refreshMaterializedView

-- COPY s.t (a, b) FROM STDIN WITH (FORMAT csv, HEADER MATCH, NULL '', FORCE_NOT_NULL (a, b), FREEZE) WHERE a > 0;
-- not yet printable: copy

-- COPY t TO PROGRAM 'gzip > /tmp/t.gz' (FORMAT csv, FORCE_QUOTE *, DELIMITER ';', ENCODING 'UTF8');
-- not yet printable: copy

-- COPY (WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x RETURNING id) TO STDOUT;
-- not yet printable: copy

-- COPY (SELECT a FROM t UNION SELECT b FROM u) TO '/tmp/out.csv' (HEADER);
-- not yet printable: copy

-- UPDATE t SET (a, b) = (1, DEFAULT), c = 3, (d, e) = ROW(c + 1, DEFAULT) WHERE id = 1;
-- not yet printable: update

-- UPDATE t SET (a, b) = (SELECT x, y FROM u WHERE u.id = t.id), (c) = ROW(2) RETURNING a;
-- not yet printable: update

-- INSERT INTO t VALUES (1, 2) ON CONFLICT (id) DO UPDATE SET (a, b) = (excluded.a, DEFAULT), c = 4;
-- not yet printable: insert

-- MERGE INTO t USING s ON t.id = s.id WHEN MATCHED AND s.gone THEN DELETE WHEN MATCHED THEN UPDATE SET a = s.a WHEN NOT MATCHED THEN INSERT (id, a) VALUES (s.id, DEFAULT) WHEN NOT MATCHED BY SOURCE THEN DO NOTHING;
-- not yet printable: merge

-- WITH q AS (SELECT 1 AS id) MERGE INTO ONLY s.t AS x USING (SELECT * FROM q) AS v (id) ON x.id = v.id WHEN NOT MATCHED BY TARGET AND v.id > 0 THEN INSERT (id) OVERRIDING SYSTEM VALUE VALUES (v.id) WHEN NOT MATCHED BY SOURCE THEN UPDATE SET a = 0 RETURNING x.id, *;
-- not yet printable: merge

-- MERGE INTO t x USING a JOIN b ON a.id = b.id ON x.id = a.id WHEN MATCHED THEN DO NOTHING WHEN NOT MATCHED THEN INSERT DEFAULT VALUES;
-- not yet printable: merge

-- WITH m AS (MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE RETURNING t.id) SELECT * FROM m;
-- not yet printable: merge

-- MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET (a, b) = (s.a, DEFAULT), c = s.c WHEN NOT MATCHED BY SOURCE THEN UPDATE SET (a) = (SELECT 0);
-- not yet printable: merge
