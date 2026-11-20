// The query family's printer cases (SELECT, VALUES, TABLE, set operations,
// and the expressions and FROM items they hold), for `stringify.test.ts`:
// each is round-tripped, and its width-80 output pinned in
// `stringify.query.golden.sql`.

// Statements written for the printer: the expression kinds no other suite
// reaches, and the cases its rules exist for — operators that would glue into
// a comment or another operator, forms the grammar accepts and PostgreSQL
// does not (the golden pins the PostgreSQL spelling each prints),
// set-operation arms and WITH placement, and names and strings that need
// quoting.
export const cases = [
  // operators: gluing, signs, OPERATOR(), associativity
  "SELECT - -1, -(-a), - - - b, @ -1, |/ 25, ~ ~a, - +a, -(1)::int;",
  "SELECT x OPERATOR(pg_catalog.+) y, OPERATOR(pg_catalog.-) 1, x OPERATOR(=) ANY (arr), OPERATOR(-) a * b;",
  "SELECT 2 ^ -3 ^ 4, -2 ^ 2, (a + b) * c, a - (b - c), a || b || c, a && b && c, (a && b) || c, a & (b | c);",
  "SELECT NOT (a AND b) OR c, NOT a = b, (NOT a) = b, a AND (b OR c), NOT NOT a;",
  "SELECT CAST(a + b AS int), (a)::int, -x::int, (-x)::int, a::int[]::text;",
  "SELECT a COLLATE \"C\" < b, x AT TIME ZONE 'UTC' AT TIME ZONE 'x', x AT LOCAL, (a || b) COLLATE \"C\";",
  "SELECT a = ANY (b), a < ALL (SELECT 1), a + ANY (b) + c, a LIKE ANY (b), a NOT ILIKE ALL (b), a = ANY ((1, 2));",
  // non-associative tiers: PostgreSQL rejects the bare chains
  "SELECT (a = b) = c, (a < b) IS NULL, (a IS NULL) IS NULL, (a LIKE b) LIKE c, (a IN (1)) IN (true);",
  "SELECT (a BETWEEN 1 AND 2) BETWEEN true AND false, (a IS TRUE) IS NOT FALSE, a NOT IN (1) IS NULL;",
  'SELECT a BETWEEN b COLLATE "C" AND c, a BETWEEN SYMMETRIC 1 AND 2, a NOT BETWEEN ASYMMETRIC b + 1 AND c;',
  "SELECT a LIKE 'x!%' ESCAPE '!', a NOT SIMILAR TO 'b' ESCAPE '#', a ILIKE b || c;",
  // indirection: PostgreSQL takes it only after a column, a parameter or parentheses
  "SELECT (f(x))[1], (a).b, (a).*, a[1].b, $1[1], (ARRAY[1, 2])[1], (t.c)[1:2], a[:2], a[1:], a[:], (row(1, 2)).f1;",
  "SELECT ((SELECT a FROM t)).x, (SELECT a FROM t)[1];",
  // literals and strings
  "SELECT 'it''s', E'a\\nb', 'tab\there', '', N'x', B'101', X'ff', 1.50, 5., 1e2, 0x1F, .5;",
  "SELECT 'a'\n'b', 'c';",
  "SELECT INTERVAL '1' DAY, INTERVAL(3) '1 s', INTERVAL '1' DAY TO SECOND(3), INTERVAL '1-2' YEAR TO MONTH;",
  "SELECT TIMESTAMP(3) WITH TIME ZONE '2024-01-01', DOUBLE PRECISION '1', \"char\" 'a', varchar(3) 'abc', s.t 'x';",
  "SELECT a::double precision, a::timestamp(3) without time zone, a::interval day to second(3), a::bit varying(4);",
  'SELECT a::character varying(10)[], a::"int", a::pg_catalog.int4, a::"MyType", a::"double precision", a::int ARRAY;',
  // names
  'SELECT 1 AS "select", a AS "Mixed", "from".x, "a""b" FROM "from" AS "user";',
  'SELECT t.*, s.t.* FROM s.t, "T";',
  // calls
  "SELECT count(DISTINCT a), count(ALL a), f(VARIADIC arr), f(a, VARIADIC b), f(a => 1, b := 2), count(*);",
  "SELECT string_agg(a, ',' ORDER BY a DESC), array_agg(DISTINCT a ORDER BY a), pg_catalog.substring(a, 1);",
  'SELECT "normalize"(a, b), normalize(a), normalize(a, nfkd), "xmlelement"(a), "json"(a), json_object(\'{a,1}\');',
  "SELECT substring(a, 1, 2), substring(a FROM 2), substring(a FOR 2), substring(a FROM 1 FOR 2), substring(a SIMILAR b ESCAPE c);",
  "SELECT trim(a), trim(BOTH FROM a), trim(LEADING 'x' FROM a), trim('x' FROM a), position(a || b IN c), position((a IN (1)) IN c);",
  "SELECT extract(epoch FROM x), extract('Day' FROM x), overlay(a PLACING b FROM 1 FOR 2), overlay(a PLACING b FROM 1), COLLATION FOR (a);",
  "SELECT CURRENT_DATE, CURRENT_TIMESTAMP(3), LOCALTIME, USER, SESSION_USER, CURRENT_ROLE;",
  // windows and aggregate modifiers
  "SELECT sum(a) OVER (w ROWS BETWEEN 1 PRECEDING AND UNBOUNDED FOLLOWING EXCLUDE NO OTHERS) FROM t;",
  "SELECT count(*) FILTER (WHERE a) OVER (), lag(a) IGNORE NULLS OVER w, first_value(a) RESPECT NULLS OVER (w) FROM t WINDOW w AS (ORDER BY a USING <);",
  "SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY a DESC NULLS FIRST), rank() OVER (PARTITION BY a, b RANGE CURRENT ROW EXCLUDE TIES) FROM t;",
  "SELECT sum(a) OVER (GROUPS BETWEEN UNBOUNDED PRECEDING AND 2 FOLLOWING EXCLUDE GROUP), sum(a) OVER (ROWS 3 PRECEDING EXCLUDE CURRENT ROW) FROM t;",
  // constructors and predicates
  "SELECT ROW(), ROW(1), (1, 2), ARRAY[[1, 2], [3, 4]], ARRAY[]::int[], ARRAY(SELECT 1), ARRAY[ARRAY[1]];",
  "SELECT (a, b) OVERLAPS ROW(c, d), EXISTS (SELECT 1), NOT EXISTS (SELECT 1), a IN ((SELECT 1)), a NOT IN (SELECT 1);",
  "SELECT a IS DISTINCT FROM b + 1, a IS NOT DISTINCT FROM b, a ISNULL, a NOTNULL, a IS UNKNOWN, a IS NOT NFKC NORMALIZED, a IS NORMALIZED;",
  "SELECT x IS DOCUMENT, x IS NOT DOCUMENT, x IS JSON, x IS NOT JSON OBJECT WITH UNIQUE KEYS, x IS JSON ARRAY WITHOUT UNIQUE;",
  "SELECT CASE WHEN a THEN 1 WHEN b THEN 2 ELSE 3 END, CASE a WHEN 1 THEN 'x' END, CASE WHEN a THEN b END IS NULL;",
  // SQL/JSON
  "SELECT JSON_OBJECT(), JSON_OBJECT(RETURNING jsonb), JSON_OBJECT('a' VALUE 1, (k || 'x') VALUE v FORMAT JSON NULL ON NULL WITH UNIQUE KEYS RETURNING json);",
  "SELECT JSON_OBJECT(k : v ABSENT ON NULL), JSON_ARRAY(), JSON_ARRAY(1, 'a' FORMAT JSON ENCODING utf8 ABSENT ON NULL RETURNING jsonb FORMAT JSON);",
  "SELECT JSON_ARRAY(SELECT a FROM t FORMAT JSON RETURNING jsonb), JSON_ARRAY(SELECT 1);",
  "SELECT JSON_OBJECTAGG(k VALUE v ABSENT ON NULL WITH UNIQUE KEYS RETURNING jsonb) FILTER (WHERE k IS NOT NULL) OVER (PARTITION BY g) FROM t;",
  "SELECT JSON_ARRAYAGG(a ORDER BY b NULL ON NULL RETURNING jsonb), JSON_ARRAYAGG(a FORMAT JSON) OVER () FROM t;",
  "SELECT JSON('{\"a\": 1}' FORMAT JSON WITH UNIQUE KEYS), JSON(a WITHOUT UNIQUE), JSON_SCALAR(1 + 1), JSON_SERIALIZE(a FORMAT JSON RETURNING bytea);",
  "SELECT JSON_VALUE(js, '$.a' PASSING 1 AS x, 'y' AS \"Y\" RETURNING int DEFAULT 0 ON EMPTY ERROR ON ERROR) FROM t;",
  "SELECT JSON_QUERY(js FORMAT JSON, '$.a' RETURNING jsonb WITH CONDITIONAL WRAPPER OMIT QUOTES EMPTY ARRAY ON EMPTY EMPTY OBJECT ON ERROR) FROM t;",
  "SELECT JSON_QUERY(js, '$' WITHOUT WRAPPER KEEP QUOTES ON SCALAR STRING), JSON_QUERY(js, '$' WITH WRAPPER NULL ON ERROR), JSON_EXISTS(js, '$.a' PASSING 1 AS n UNKNOWN ON ERROR), JSON_EXISTS(js, '$' TRUE ON ERROR) FROM t;",
  "SELECT * FROM JSON_TABLE(js, '$' AS root PASSING 1 AS n COLUMNS (id FOR ORDINALITY, a int PATH '$.a' NULL ON EMPTY, b text FORMAT JSON PATH '$.b' WITH WRAPPER KEEP QUOTES, e bool EXISTS PATH '$.e' FALSE ON ERROR, NESTED PATH '$.c[*]' AS c COLUMNS (x int)) ERROR ON ERROR) AS jt;",
  "SELECT * FROM t, LATERAL JSON_TABLE(t.js, '$[*]' COLUMNS (a text, NESTED '$.b' COLUMNS (b int DEFAULT 1 ON ERROR))) AS j (x, y);",
  // XML
  "SELECT XMLELEMENT(NAME a), XMLELEMENT(NAME \"select\", XMLATTRIBUTES(1 AS x, b), 'c', d), XMLELEMENT(NAME e, 'f');",
  "SELECT XMLFOREST(a, b AS \"B\"), XMLPI(NAME php), XMLPI(NAME php, 'echo'), XMLCONCAT(a, b), XMLCONCAT(a);",
  "SELECT XMLROOT(x, VERSION '1.0', STANDALONE YES), XMLROOT(x, VERSION NO VALUE, STANDALONE NO VALUE), XMLROOT(x, VERSION v, STANDALONE NO);",
  "SELECT XMLPARSE(DOCUMENT a PRESERVE WHITESPACE), XMLPARSE(CONTENT a STRIP WHITESPACE), XMLPARSE(CONTENT a);",
  "SELECT XMLSERIALIZE(DOCUMENT a AS text INDENT), XMLSERIALIZE(CONTENT a AS varchar(10) NO INDENT), XMLSERIALIZE(CONTENT a AS text);",
  "SELECT XMLEXISTS('//a' PASSING BY REF doc), XMLEXISTS(p PASSING doc BY VALUE), XMLEXISTS(('/' || p) PASSING (d || e));",
  "SELECT * FROM XMLTABLE(XMLNAMESPACES('http://x' AS x, DEFAULT 'http://d'), '//row' PASSING BY VALUE doc COLUMNS id int PATH '@id' NOT NULL, name text DEFAULT 'n' || 'm' NULL, ord FOR ORDINALITY) AS x;",
  "SELECT * FROM XMLTABLE('/r' PASSING d COLUMNS a int) x (b), LATERAL XMLTABLE(('/' || p) PASSING (d) COLUMNS a text PATH 'x' DEFAULT 'y');",
  "SELECT * FROM ROWS FROM (XMLELEMENT(NAME a), f(1) AS (a int)) WITH ORDINALITY;",
  // set operations and WITH placement
  "(SELECT 1 ORDER BY 1) UNION SELECT 2;",
  "SELECT 1 UNION (SELECT 2 UNION SELECT 3);",
  "SELECT 1 INTERSECT (SELECT 2 UNION SELECT 3);",
  "(SELECT 1 UNION SELECT 2) INTERSECT SELECT 3;",
  "SELECT 1 UNION SELECT 2 INTERSECT SELECT 3 EXCEPT ALL SELECT 4 INTERSECT ALL SELECT 5;",
  "WITH a AS (SELECT 1) SELECT * FROM a UNION SELECT 2 ORDER BY 1 LIMIT 3;",
  "WITH a AS (SELECT 1) (WITH b AS (SELECT 2) SELECT 3) UNION SELECT 4;",
  "SELECT 1 UNION (WITH b AS (SELECT 2) SELECT * FROM b);",
  "WITH a AS (SELECT 1) (SELECT 1 UNION SELECT 2 ORDER BY 1) UNION SELECT 3;",
  "(WITH a AS (SELECT 1) SELECT 2 ORDER BY 1) UNION SELECT 3;",
  "(SELECT 1 LIMIT 1) UNION ALL (VALUES (2) OFFSET 1) ORDER BY 1 FETCH FIRST 5 ROWS ONLY;",
  "WITH x AS (VALUES (1)) VALUES (2) UNION TABLE x;",
  "WITH RECURSIVE t (n) AS NOT MATERIALIZED (SELECT 1 UNION ALL SELECT n + 1 FROM t) SEARCH DEPTH FIRST BY n SET ord CYCLE n SET is_cycle TO true DEFAULT false USING path SELECT * FROM t;",
  "WITH a AS MATERIALIZED (SELECT 1), b (x, y) AS (SELECT 1, 2) SEARCH BREADTH FIRST BY x, y SET o CYCLE x, y SET c USING p TABLE b;",
  // query clauses
  "SELECT a INTO TEMP TABLE b FROM t; SELECT a INTO GLOBAL TEMPORARY b FROM t; SELECT INTO UNLOGGED x FROM t;",
  "TABLE ONLY t; TABLE s.t ORDER BY 1 LIMIT 1; VALUES (1, 'a') ORDER BY 1 LIMIT 1 OFFSET 1; SELECT FROM t; SELECT;",
  "SELECT * FROM t ORDER BY a FETCH FIRST ROW WITH TIES; SELECT * FROM t ORDER BY a FETCH FIRST (1 + 1) ROWS WITH TIES;",
  "SELECT * FROM t FETCH NEXT ROW ONLY; SELECT * FROM t LIMIT $1 OFFSET $2 ROWS FOR NO KEY UPDATE OF t SKIP LOCKED FOR KEY SHARE;",
  "SELECT a FROM t GROUP BY ROLLUP (a, (b, c)), CUBE ((a)), GROUPING SETS ((), (a), ((a, b)), ((SELECT 1))), (), (rollup(a));",
  "SELECT a FROM t GROUP BY DISTINCT a, (a, b), ROW(a, b) HAVING count(*) > 1 WINDOW w1 AS (PARTITION BY a), w2 AS (w1 ORDER BY b);",
  // FROM items
  "SELECT * FROM a JOIN (b JOIN c ON p) ON q, d CROSS JOIN (e NATURAL JOIN f), g FULL JOIN h USING (x) AS u;",
  "SELECT * FROM (a JOIN b USING (x) AS j) AS k (y, z), (a LEFT JOIN b ON true) RIGHT JOIN c ON true;",
  "SELECT * FROM a NATURAL LEFT JOIN b, LATERAL (SELECT 1) AS s, ROWS FROM (f(1) AS (a int), g()) WITH ORDINALITY AS r (x, y, z);",
  'SELECT * FROM f() AS (a int, b text COLLATE "C"), g() AS x (a int), h(1) WITH ORDINALITY AS y, LATERAL k(VARIADIC a) z;',
  "SELECT * FROM ONLY t AS x (a) TABLESAMPLE system (10), u TABLESAMPLE bernoulli (5, 6) REPEATABLE (1 + 1), (SELECT 1);",
  'SELECT * FROM "xmltable"(a), "json_table"(b), "rows"(c);',
  // names shaped like keywords where they stand
  'SELECT JSON_OBJECT((a, b) OVERLAPS (c, d) : 1), "exists", "exists".x, "exists"(1) FROM "exists";',
  "SELECT SUBSTRING(a SIMILAR (b LIKE c) ESCAPE d), SUBSTRING(a SIMILAR (NOT b SIMILAR TO c) ESCAPE d), SUBSTRING((a = b) SIMILAR c ESCAPE d);",
  'SELECT sum(a) OVER (ORDER BY a ROWS "unbounded" PRECEDING), sum(a) OVER (ROWS BETWEEN "current" + 1 PRECEDING AND CURRENT ROW) FROM t;',
  'SELECT sum(a) OVER ("rows" ORDER BY a) FROM t WINDOW "rows" AS (), w AS ("partition");',
  'SELECT 1 FROM t ORDER BY a FETCH FIRST "rows" ROWS WITH TIES;',
  'WITH "recursive" AS (SELECT 1) SELECT 1;',
  `SELECT "interval" '1', a::"interval", a::"between", "row" 'x';`,
  'SELECT "system_user", "current_catalog", "current_schema", "collation", "isnull" FROM "similar" AS "full";',
  "SELECT JSON_OBJECT('a' VALUE (x IS JSON) WITH UNIQUE KEYS), JSON((x IS JSON OBJECT) WITHOUT UNIQUE KEYS), JSON_OBJECTAGG(k VALUE (v IS JSON) WITH UNIQUE KEYS) FROM t;",
  "SELECT 1 FROM t GROUP BY (rollup(a)) + 1, (cube(a))::int, (rollup(a)) IS NULL, rollup, cube + 1;",
  `SELECT "national" 'x', 1::"national", "nullif"(1), nullif(1, 2), "operator"(1), EXTRACT("value" FROM a) FROM JSON_TABLE(js, '$' COLUMNS ("nested" path, "nested" "path" PATH '$')) AS j;`,
  `SELECT JSON_QUERY(j, (p IS JSON) WITH WRAPPER), JSON_QUERY(j, (p IS JSON ARRAY) WITHOUT WRAPPER), "collation".foo '1', 'x'::"collation".foo;`,
  "SELECT * FROM orders WHERE status = 'paid' AND created_at >= '2024-01-01' AND customer_id = 42 AND total > 100 OR a * b + c * d - e > f;",
  "SELECT * FROM events WHERE NOT (kind = 'aaaaaaaaaa' OR kind = 'bbbbbbbbbb' OR kind = 'cccccccccc' OR kind = 'dddddddddd');",
  "SELECT * FROM orders AS o WHERE (o.status = 'shipped' OR o.status = 'delivered' OR o.status = 'returned_to_sender') AND o.created_at > now() - INTERVAL '30 days';",
  "SELECT * FROM t WHERE (((s = 'active' OR s = 'trialing_customer') AND r = 'eu-west-1') OR p > 5) AND c > '2024-01-01';",
];

// Variants of the nested unions the printer reads (beyond expressions, FROM
// items and statements), so P4 reports one the cases never reach.
export const kinds = [
  "rollup",
  "cube",
  "groupingSets",
  "emptyGrouping",
  "unboundedPreceding",
  "preceding",
  "currentRow",
  "following",
  "unboundedFollowing",
  "ordinality",
  "value",
  "nested",
  "error",
  "true",
  "false",
  "unknown",
  "emptyArray",
  "emptyObject",
  "default",
];
