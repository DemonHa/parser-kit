import { describe, expect, it } from "vitest";
import { createInputStream, ParseError, stripSpans } from "../../src/index";
import { type Stmt, sqlLexer, sqlLite } from "./index";

// --- helpers ---

const parse = (text: string) => stripSpans(sqlLite.parse(text)) as Record<string, any>[];
const firstStmt = (text: string) => parse(text)[0]!;

// Expressions are reached through a CHECK constraint, whose parenthesised body
// is a full scalar expression.
const exprOf = (src: string) => {
  const [stmt] = parse(`CREATE TABLE t (c int CHECK (${src}));`);
  return (stmt as any).items[0].constraints[0].expr;
};

const lex = (text: string) => {
  const stream = sqlLexer.tokenize(createInputStream(text));
  const out: { type: string; value: string }[] = [];
  let tok = stream.next();
  while (tok !== null) {
    out.push({ type: tok.type, value: tok.value });
    tok = stream.next();
  }
  return out;
};

const name = (...parts: string[]) => ({ kind: "name", parts });
const num = (value: number) => ({ kind: "number", value });
const str = (value: string) => ({ kind: "string", value });
const bin = (op: string, left: unknown, right: unknown) => ({ kind: "binary", op, left, right });
const star = (table: string[] | null = null) => ({ kind: "star", table });
const col = (expr: unknown, alias: string | null = null) => ({ expr, alias });
// A fully-defaulted SELECT node; spread overrides in for the fields under test.
const sel = (over: Record<string, unknown>) => ({
  kind: "select",
  with_: null,
  recursive: false,
  distinct: false,
  columns: [],
  from: null,
  where: null,
  groupBy: null,
  having: null,
  window: null,
  orderBy: null,
  limit: null,
  offset: null,
  locking: null,
  ...over,
});
const tableFrom = (name: string[], alias: string | null = null) => ({ kind: "table", name, alias });

// --- lexer ---

describe("SQL-lite lexer", () => {
  it("folds unquoted identifiers and preserves quoted ones", () => {
    expect(lex('Select FROM "Users"')).toEqual([
      { type: "ident", value: "select" },
      { type: "ident", value: "from" },
      { type: "qident", value: "Users" },
    ]);
  });

  it("decodes standard, E- and dollar-quoted strings", () => {
    expect(lex("'it''s'")).toEqual([{ type: "string", value: "it's" }]);
    expect(lex("E'a\\nb'")).toEqual([{ type: "string", value: "a\nb" }]);
    expect(lex("$t$raw $x$ text$t$")).toEqual([{ type: "string", value: "raw $x$ text" }]);
  });

  it("falls the E prefix through to an identifier when no quote follows", () => {
    expect(lex("end explain")).toEqual([
      { type: "ident", value: "end" },
      { type: "ident", value: "explain" },
    ]);
  });

  it("reads line comments and nested block comments as one token each", () => {
    expect(lex("-- a comment\nx")).toEqual([
      { type: "comment", value: " a comment" },
      { type: "ident", value: "x" },
    ]);
    const nested = lex("/* a /* b */ c */ x");
    expect(nested).toHaveLength(2);
    expect(nested[0]!.type).toBe("comment");
    expect(nested[1]).toEqual({ type: "ident", value: "x" });
  });

  it("reads PG numbers: exponent, leading dot, hex, separators", () => {
    expect(lex("1e5 .5 0xff 1_000")).toEqual([
      { type: "number", value: "1e5" },
      { type: "number", value: ".5" },
      { type: "number", value: "0xff" },
      { type: "number", value: "1000" },
    ]);
  });

  it("partitions operators from punctuation (:: casts next to || and @>)", () => {
    expect(lex("x::int || tags @> other")).toEqual([
      { type: "ident", value: "x" },
      { type: "punc", value: "::" },
      { type: "ident", value: "int" },
      { type: "op", value: "||" },
      { type: "ident", value: "tags" },
      { type: "op", value: "@>" },
      { type: "ident", value: "other" },
    ]);
  });
});

// --- statements ---

describe("SQL-lite statements", () => {
  it("parses CREATE TABLE with column and table constraints", () => {
    const stmt = firstStmt(
      "CREATE TABLE users (\n" +
        "  id int PRIMARY KEY,\n" +
        "  email text NOT NULL,\n" +
        "  age int DEFAULT 0 CHECK (age >= 0),\n" +
        "  team_id int REFERENCES teams (id) ON DELETE CASCADE,\n" +
        "  UNIQUE (email)\n" +
        ");",
    );
    expect(stmt.kind).toBe("createTable");
    expect(stmt.ifNotExists).toBe(false);
    expect(stmt.name).toEqual(["users"]);

    const items = stmt.items as any[];
    expect(items.map((i) => i.kind)).toEqual(["column", "column", "column", "column", "unique"]);
    expect(items[0]).toMatchObject({ name: "id", dataType: { name: "int", args: [], array: false } });
    expect(items[0].constraints).toEqual([{ kind: "primaryKey" }]);
    expect(items[1].constraints).toEqual([{ kind: "notNull" }]);
    expect(items[2].constraints).toEqual([
      { kind: "default", expr: num(0) },
      { kind: "check", expr: bin(">=", name("age"), num(0)) },
    ]);
    expect(items[3].constraints).toEqual([
      { kind: "references", table: ["teams"], columns: ["id"], onDelete: "cascade" },
    ]);
    expect(items[4]).toEqual({ kind: "unique", name: null, columns: ["email"] });
  });

  it("parses parameterized and array types", () => {
    const stmt = firstStmt("CREATE TABLE t (a varchar(10), b numeric(10, 2), c int[], d text[][]);");
    const types = (stmt.items as any[]).map((i) => i.dataType);
    expect(types).toEqual([
      { name: "varchar", args: [10], array: false },
      { name: "numeric", args: [10, 2], array: false },
      { name: "int", args: [], array: true },
      { name: "text", args: [], array: true },
    ]);
  });

  it("accepts IF NOT EXISTS and named table constraints", () => {
    const stmt = firstStmt("CREATE TABLE IF NOT EXISTS app.users (id int, CONSTRAINT pk PRIMARY KEY (id));");
    expect(stmt.ifNotExists).toBe(true);
    expect(stmt.name).toEqual(["app", "users"]);
    expect((stmt.items as any[])[1]).toEqual({ kind: "primaryKey", name: "pk", columns: ["id"] });
  });

  it("proves the keyword tier: unreserved words as names, reserved only quoted", () => {
    const stmt = firstStmt('CREATE TABLE data ("select" text, type text, role varchar(10), comment text);');
    expect(stmt.name).toEqual(["data"]);
    expect((stmt.items as any[]).map((i) => i.name)).toEqual(["select", "type", "role", "comment"]);
  });

  it("rejects a bare reserved word as a name", () => {
    expect(() => sqlLite.parse("CREATE TABLE t (select int);")).toThrow(/Expected a name but found "select"/);
  });

  it("parses CREATE [UNIQUE] INDEX with expressions and a partial WHERE", () => {
    const plain = firstStmt("CREATE INDEX idx_email ON users (email);");
    expect(plain).toMatchObject({ kind: "createIndex", unique: false, name: "idx_email", table: ["users"] });
    expect((plain as any).columns).toEqual([name("email")]);

    const partial = firstStmt("CREATE UNIQUE INDEX ON users (lower(email)) WHERE active;");
    expect(partial).toMatchObject({ kind: "createIndex", unique: true, name: null });
    expect((partial as any).columns).toEqual([{ kind: "call", name: "lower", args: [name("email")] }]);
    expect((partial as any).where).toEqual(name("active"));
    // The Phase 6 extras default off / absent on a plain index.
    expect(plain).toMatchObject({ concurrently: false, ifNotExists: false, include: null });
  });

  it("parses CREATE INDEX CONCURRENTLY IF NOT EXISTS with INCLUDE", () => {
    const idx = firstStmt("CREATE INDEX CONCURRENTLY IF NOT EXISTS idx ON users (email) INCLUDE (name, id);");
    expect(idx).toMatchObject({
      kind: "createIndex",
      concurrently: true,
      ifNotExists: true,
      name: "idx",
      table: ["users"],
      include: ["name", "id"],
    });
    expect((idx as any).columns).toEqual([name("email")]);
  });

  it("parses CREATE TYPE ... AS ENUM", () => {
    expect(firstStmt("CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy');")).toEqual({
      kind: "createType",
      form: "enum",
      name: ["mood"],
      values: ["sad", "ok", "happy"],
    });
  });

  it("parses DROP TABLE IF EXISTS with several names", () => {
    expect(firstStmt("DROP TABLE IF EXISTS a, public.b;")).toEqual({
      kind: "drop",
      objectType: "table",
      concurrently: false,
      ifExists: true,
      names: [["a"], ["public", "b"]],
      behavior: null,
    });
  });

  it("parses COMMENT ON ... IS with a dollar-quoted body", () => {
    expect(firstStmt("COMMENT ON COLUMN users.email IS $q$primary contact$q$;")).toEqual({
      kind: "comment",
      objectType: "column",
      name: ["users", "email"],
      comment: "primary contact",
    });
    expect((firstStmt("COMMENT ON TABLE users IS NULL;") as any).comment).toBeNull();
  });
});

// --- ALTER TABLE (peekAhead / phrase dispatch) ---

describe("SQL-lite ALTER TABLE", () => {
  const action = (text: string) => (firstStmt(text) as any).action;

  it("adds a column, with or without the COLUMN keyword", () => {
    expect(action("ALTER TABLE t ADD COLUMN age int;")).toMatchObject({
      kind: "addColumn",
      column: { name: "age", dataType: { name: "int" } },
    });
    expect(action("ALTER TABLE t ADD email text NOT NULL;")).toMatchObject({
      kind: "addColumn",
      column: { name: "email", constraints: [{ kind: "notNull" }] },
    });
  });

  it("drops a column", () => {
    expect(action("ALTER TABLE t DROP COLUMN age;")).toEqual({ kind: "dropColumn", name: "age" });
    expect(action("ALTER TABLE t DROP legacy;")).toEqual({ kind: "dropColumn", name: "legacy" });
  });

  it("adds named and bare constraints", () => {
    expect(action("ALTER TABLE t ADD CONSTRAINT pk PRIMARY KEY (id);")).toEqual({
      kind: "addConstraint",
      name: "pk",
      constraint: { kind: "primaryKey", name: null, columns: ["id"] },
    });
    expect(action("ALTER TABLE t ADD UNIQUE (email);")).toEqual({
      kind: "addConstraint",
      name: null,
      constraint: { kind: "unique", name: null, columns: ["email"] },
    });
  });

  it("alters a column default (phrase dispatch: SET vs DROP DEFAULT)", () => {
    expect(action("ALTER TABLE t ALTER COLUMN status SET DEFAULT 'active';")).toEqual({
      kind: "setDefault",
      column: "status",
      expr: str("active"),
    });
    expect(action("ALTER TABLE t ALTER COLUMN status DROP DEFAULT;")).toEqual({
      kind: "dropDefault",
      column: "status",
    });
  });
});

// --- Phase 6: richer ALTER TABLE actions ---

describe("SQL-lite ALTER TABLE (Phase 6 actions)", () => {
  const action = (text: string) => (firstStmt(text) as any).action;

  it("sets and drops NOT NULL", () => {
    expect(action("ALTER TABLE t ALTER COLUMN email SET NOT NULL;")).toEqual({ kind: "setNotNull", column: "email" });
    expect(action("ALTER TABLE t ALTER email DROP NOT NULL;")).toEqual({ kind: "dropNotNull", column: "email" });
  });

  it("changes a column type via SET DATA TYPE and the TYPE shorthand", () => {
    expect(action("ALTER TABLE t ALTER COLUMN n SET DATA TYPE bigint;")).toMatchObject({
      kind: "setDataType",
      column: "n",
      dataType: { name: "bigint" },
    });
    expect(action("ALTER TABLE t ALTER n TYPE numeric(10, 2);")).toMatchObject({
      kind: "setDataType",
      column: "n",
      dataType: { name: "numeric", args: [10, 2] },
    });
  });

  it("renames a column, a constraint, and the table", () => {
    expect(action("ALTER TABLE t RENAME COLUMN old TO new;")).toEqual({ kind: "renameColumn", from: "old", to: "new" });
    expect(action("ALTER TABLE t RENAME legacy TO current;")).toEqual({
      kind: "renameColumn",
      from: "legacy",
      to: "current",
    });
    expect(action("ALTER TABLE t RENAME CONSTRAINT pk_old TO pk_new;")).toEqual({
      kind: "renameConstraint",
      from: "pk_old",
      to: "pk_new",
    });
    expect(action("ALTER TABLE t RENAME TO t2;")).toEqual({ kind: "renameTable", to: "t2" });
  });

  it("changes owner and replica identity", () => {
    expect(action("ALTER TABLE t OWNER TO admin;")).toEqual({ kind: "ownerTo", owner: "admin" });
    expect(action("ALTER TABLE t REPLICA IDENTITY FULL;")).toEqual({
      kind: "replicaIdentity",
      mode: "full",
      index: null,
    });
    expect(action("ALTER TABLE t REPLICA IDENTITY USING INDEX t_pkey;")).toEqual({
      kind: "replicaIdentity",
      mode: "usingIndex",
      index: "t_pkey",
    });
    expect(action("ALTER TABLE t REPLICA IDENTITY DEFAULT;")).toMatchObject({
      kind: "replicaIdentity",
      mode: "default",
    });
  });

  it("rejects an unknown ALTER TABLE action", () => {
    expect(() => sqlLite.parse("ALTER TABLE t frobnicate;")).toThrow(
      /Expected "add", "drop", "alter", "rename", "owner" or "replica"/,
    );
  });
});

// --- Phase 6: DROP family & TRUNCATE ---

describe("SQL-lite DROP family & TRUNCATE", () => {
  it("drops non-table objects with CASCADE / RESTRICT", () => {
    expect(firstStmt("DROP VIEW v;")).toEqual({
      kind: "drop",
      objectType: "view",
      concurrently: false,
      ifExists: false,
      names: [["v"]],
      behavior: null,
    });
    expect(firstStmt("DROP SEQUENCE IF EXISTS s CASCADE;")).toEqual({
      kind: "drop",
      objectType: "sequence",
      concurrently: false,
      ifExists: true,
      names: [["s"]],
      behavior: "cascade",
    });
    expect(firstStmt("DROP TYPE mood RESTRICT;")).toMatchObject({ objectType: "type", behavior: "restrict" });
    expect(firstStmt("DROP SCHEMA a, b;")).toMatchObject({ objectType: "schema", names: [["a"], ["b"]] });
  });

  it("drops an index CONCURRENTLY", () => {
    expect(firstStmt("DROP INDEX CONCURRENTLY IF EXISTS idx;")).toEqual({
      kind: "drop",
      objectType: "index",
      concurrently: true,
      ifExists: true,
      names: [["idx"]],
      behavior: null,
    });
  });

  it("truncates one or more tables with identity and behavior", () => {
    expect(firstStmt("TRUNCATE t;")).toEqual({
      kind: "truncate",
      names: [["t"]],
      identity: null,
      behavior: null,
    });
    expect(firstStmt("TRUNCATE TABLE a, b RESTART IDENTITY CASCADE;")).toEqual({
      kind: "truncate",
      names: [["a"], ["b"]],
      identity: "restart",
      behavior: "cascade",
    });
    expect(firstStmt("TRUNCATE public.t CONTINUE IDENTITY;")).toMatchObject({
      names: [["public", "t"]],
      identity: "continue",
    });
  });
});

// --- Phase 7: more CREATE objects ---

describe("SQL-lite CREATE VIEW / MATERIALIZED VIEW", () => {
  it("parses a plain view whose body reuses the query rule", () => {
    expect(firstStmt("CREATE VIEW active AS SELECT id FROM users WHERE active;")).toEqual({
      kind: "createView",
      materialized: false,
      orReplace: false,
      ifNotExists: false,
      name: ["active"],
      columns: null,
      query: sel({ columns: [col(name("id"))], from: [tableFrom(["users"])], where: name("active") }),
      withData: null,
    });
  });

  it("parses OR REPLACE with an output column list", () => {
    expect(firstStmt("CREATE OR REPLACE VIEW v (a, b) AS SELECT 1, 2;")).toMatchObject({
      kind: "createView",
      materialized: false,
      orReplace: true,
      name: ["v"],
      columns: ["a", "b"],
      withData: null,
    });
  });

  it("parses MATERIALIZED VIEW with IF NOT EXISTS and WITH [NO] DATA", () => {
    expect(firstStmt("CREATE MATERIALIZED VIEW IF NOT EXISTS mv AS SELECT * FROM t WITH NO DATA;")).toMatchObject({
      kind: "createView",
      materialized: true,
      ifNotExists: true,
      name: ["mv"],
      withData: false,
    });
    expect(firstStmt("CREATE MATERIALIZED VIEW mv AS SELECT 1 WITH DATA;")).toMatchObject({
      materialized: true,
      withData: true,
    });
  });

  it("rejects OR REPLACE before a non-replaceable object", () => {
    expect(() => sqlLite.parse("CREATE OR REPLACE TABLE t (id int);")).toThrow(
      /Expected "view", "materialized", "function", "aggregate" or "trigger"/,
    );
  });
});

describe("SQL-lite CREATE TABLE AS", () => {
  it("parses CREATE TABLE AS SELECT", () => {
    expect(firstStmt("CREATE TABLE snap AS SELECT id, name FROM users;")).toEqual({
      kind: "createTableAs",
      ifNotExists: false,
      name: ["snap"],
      columns: null,
      query: sel({ columns: [col(name("id")), col(name("name"))], from: [tableFrom(["users"])] }),
      withData: null,
    });
  });

  it("parses a column list, IF NOT EXISTS and WITH NO DATA", () => {
    expect(firstStmt("CREATE TABLE IF NOT EXISTS t (a, b) AS SELECT 1, 2 WITH NO DATA;")).toMatchObject({
      kind: "createTableAs",
      ifNotExists: true,
      name: ["t"],
      columns: ["a", "b"],
      withData: false,
    });
  });

  it("still parses an ordinary CREATE TABLE (the CTAS column list backtracks)", () => {
    expect(firstStmt("CREATE TABLE t (id int, name text);")).toMatchObject({
      kind: "createTable",
      name: ["t"],
    });
  });
});

describe("SQL-lite CREATE TYPE composite / range", () => {
  it("parses a composite type", () => {
    expect(firstStmt("CREATE TYPE point AS (x float8, y float8);")).toEqual({
      kind: "createType",
      form: "composite",
      name: ["point"],
      attributes: [
        { name: "x", type: { name: "float8", args: [], array: false } },
        { name: "y", type: { name: "float8", args: [], array: false } },
      ],
    });
  });

  it("parses a range type option list", () => {
    expect(firstStmt("CREATE TYPE floatrange AS RANGE (SUBTYPE = float8, SUBTYPE_OPCLASS = float8_ops);")).toEqual({
      kind: "createType",
      form: "range",
      name: ["floatrange"],
      options: [
        { name: "subtype", value: "float8" },
        { name: "subtype_opclass", value: "float8_ops" },
      ],
    });
  });
});

describe("SQL-lite CREATE SEQUENCE", () => {
  it("parses a sequence with a full option list", () => {
    const stmt = firstStmt(
      "CREATE SEQUENCE IF NOT EXISTS s AS bigint INCREMENT BY 2 MINVALUE 1 NO MAXVALUE START WITH 10 CACHE 5 CYCLE OWNED BY t.id;",
    );
    expect(stmt).toMatchObject({ kind: "createSequence", ifNotExists: true, name: ["s"] });
    expect((stmt as any).options).toEqual([
      { kind: "as", type: { name: "bigint", args: [], array: false } },
      { kind: "increment", value: num(2) },
      { kind: "minValue", value: num(1) },
      { kind: "maxValue", value: null },
      { kind: "start", value: num(10) },
      { kind: "cache", value: num(5) },
      { kind: "cycle", value: true },
      { kind: "ownedBy", owner: ["t", "id"] },
    ]);
  });

  it("parses NO CYCLE, OWNED BY NONE and a signed MINVALUE", () => {
    const stmt = firstStmt("CREATE SEQUENCE s MINVALUE -100 NO CYCLE OWNED BY NONE;");
    expect((stmt as any).options).toEqual([
      { kind: "minValue", value: { kind: "unary", op: "-", operand: num(100) } },
      { kind: "cycle", value: false },
      { kind: "ownedBy", owner: null },
    ]);
  });
});

describe("SQL-lite CREATE DOMAIN", () => {
  it("parses a domain with DEFAULT and a named CHECK", () => {
    const stmt = firstStmt(
      "CREATE DOMAIN us_postal AS text NOT NULL DEFAULT '00000' CONSTRAINT fmt CHECK (VALUE ~ '^[0-9]{5}$');",
    );
    expect(stmt).toMatchObject({ kind: "createDomain", name: ["us_postal"], dataType: { name: "text" } });
    expect((stmt as any).constraints).toEqual([
      { kind: "notNull", name: null },
      { kind: "default", expr: str("00000") },
      { kind: "check", name: "fmt", expr: bin("~", name("value"), str("^[0-9]{5}$")) },
    ]);
  });

  it("parses a domain without the optional AS", () => {
    expect(firstStmt("CREATE DOMAIN positive int CHECK (VALUE > 0);")).toMatchObject({
      kind: "createDomain",
      name: ["positive"],
      dataType: { name: "int" },
    });
  });
});

// --- Phase 8: functions / aggregates / triggers ---

// A ColType literal (the shape typeRef yields once spans are stripped).
const ct = (name: string, over: Record<string, unknown> = {}) => ({ name, args: [], array: false, ...over });

describe("SQL-lite CREATE FUNCTION", () => {
  it("parses OR REPLACE, arg defaults, RETURNS and an opaque dollar body", () => {
    const stmt = firstStmt(
      "CREATE OR REPLACE FUNCTION add(a integer, b integer DEFAULT 0) RETURNS integer LANGUAGE sql IMMUTABLE STRICT AS $$SELECT a + b$$;",
    );
    expect(stmt).toEqual({
      kind: "createFunction",
      orReplace: true,
      name: ["add"],
      args: [
        { mode: null, name: "a", type: ct("integer"), defaultValue: null },
        { mode: null, name: "b", type: ct("integer"), defaultValue: num(0) },
      ],
      returns: { kind: "type", setof: false, type: ct("integer") },
      options: [
        { kind: "language", name: "sql" },
        { kind: "volatility", value: "immutable" },
        { kind: "strictness", value: "strict" },
        // The body is one opaque string token — `a + b` is NOT parsed.
        { kind: "as", parts: ["SELECT a + b"] },
      ],
    });
  });

  it("parses argument modes and an array type", () => {
    const stmt = firstStmt(
      "CREATE FUNCTION f(IN x integer, OUT y text, VARIADIC vals integer[]) RETURNS void LANGUAGE plpgsql AS $body$BEGIN END$body$;",
    );
    expect((stmt as any).args).toEqual([
      { mode: "in", name: "x", type: ct("integer"), defaultValue: null },
      { mode: "out", name: "y", type: ct("text"), defaultValue: null },
      { mode: "variadic", name: "vals", type: ct("integer", { array: true }), defaultValue: null },
    ]);
    expect((stmt as any).options).toEqual([
      { kind: "language", name: "plpgsql" },
      { kind: "as", parts: ["BEGIN END"] },
    ]);
  });

  it("parses RETURNS TABLE and an unnamed-argument type", () => {
    const stmt = firstStmt(
      "CREATE FUNCTION top_users(numeric(10, 2)) RETURNS TABLE(id integer, label text) LANGUAGE sql AS $$SELECT 1$$;",
    );
    expect((stmt as any).args).toEqual([
      { mode: null, name: null, type: ct("numeric", { args: [10, 2] }), defaultValue: null },
    ]);
    expect((stmt as any).returns).toEqual({
      kind: "table",
      columns: [
        { name: "id", type: ct("integer") },
        { name: "label", type: ct("text") },
      ],
    });
  });

  it("parses SECURITY / SET / COST / PARALLEL characteristics", () => {
    const stmt = firstStmt(
      "CREATE FUNCTION g() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public COST 100 PARALLEL SAFE AS $$SELECT 1$$;",
    );
    expect((stmt as any).options).toEqual([
      { kind: "language", name: "sql" },
      { kind: "security", external: false, definer: true },
      { kind: "set", parameter: "search_path", value: { kind: "list", values: [name("pg_catalog"), name("public")] } },
      { kind: "cost", value: num(100) },
      { kind: "parallel", value: "safe" },
      { kind: "as", parts: ["SELECT 1"] },
    ]);
  });

  it("parses a C-language two-part AS body and RETURNS NULL ON NULL INPUT", () => {
    const stmt = firstStmt(
      "CREATE FUNCTION c_fn() RETURNS int LANGUAGE c RETURNS NULL ON NULL INPUT AS 'obj_file', 'link_sym';",
    );
    expect((stmt as any).options).toEqual([
      { kind: "language", name: "c" },
      { kind: "strictness", value: "returnsNullOnNullInput" },
      { kind: "as", parts: ["obj_file", "link_sym"] },
    ]);
  });
});

describe("SQL-lite CREATE AGGREGATE", () => {
  it("parses the modern signature + definition-list form", () => {
    const stmt = firstStmt("CREATE AGGREGATE sum_agg(numeric) (SFUNC = numeric_add, STYPE = numeric, INITCOND = '0');");
    expect(stmt).toEqual({
      kind: "createAggregate",
      orReplace: false,
      name: ["sum_agg"],
      star: false,
      args: [{ mode: null, name: null, type: ct("numeric"), defaultValue: null }],
      options: [
        { name: "sfunc", value: { kind: "type", type: ct("numeric_add") } },
        { name: "stype", value: { kind: "type", type: ct("numeric") } },
        { name: "initcond", value: { kind: "literal", expr: str("0") } },
      ],
    });
  });

  it("parses the legacy single-paren form", () => {
    const stmt = firstStmt("CREATE AGGREGATE avg_legacy (BASETYPE = numeric, SFUNC = avg_acc, STYPE = internal);");
    expect(stmt).toMatchObject({ kind: "createAggregate", star: false, args: [] });
    expect((stmt as any).options).toEqual([
      { name: "basetype", value: { kind: "type", type: ct("numeric") } },
      { name: "sfunc", value: { kind: "type", type: ct("avg_acc") } },
      { name: "stype", value: { kind: "type", type: ct("internal") } },
    ]);
  });

  it("parses a (*) signature", () => {
    const stmt = firstStmt("CREATE AGGREGATE my_count(*) (SFUNC = int8inc, STYPE = int8);");
    expect(stmt).toMatchObject({ kind: "createAggregate", name: ["my_count"], star: true, args: [] });
  });
});

describe("SQL-lite CREATE TRIGGER", () => {
  it("parses timing, OR-joined events, UPDATE OF cols, WHEN and EXECUTE FUNCTION", () => {
    const stmt = firstStmt(
      "CREATE TRIGGER audit AFTER INSERT OR UPDATE OF a, b ON accounts FOR EACH ROW WHEN (new.active) EXECUTE FUNCTION log_change(1, 'x');",
    );
    expect(stmt).toEqual({
      kind: "createTrigger",
      orReplace: false,
      name: "audit",
      timing: "after",
      events: [
        { event: "insert", columns: null },
        { event: "update", columns: ["a", "b"] },
      ],
      table: ["accounts"],
      forEach: "row",
      when: name("new", "active"),
      execute: { routine: "function", name: ["log_change"], args: [num(1), str("x")] },
    });
  });

  it("parses OR REPLACE, INSTEAD OF and EXECUTE PROCEDURE with no args", () => {
    const stmt = firstStmt(
      "CREATE OR REPLACE TRIGGER v_ins INSTEAD OF DELETE ON myview FOR EACH ROW EXECUTE PROCEDURE do_delete();",
    );
    expect(stmt).toEqual({
      kind: "createTrigger",
      orReplace: true,
      name: "v_ins",
      timing: "insteadOf",
      events: [{ event: "delete", columns: null }],
      table: ["myview"],
      forEach: "row",
      when: null,
      execute: { routine: "procedure", name: ["do_delete"], args: [] },
    });
  });

  it("rejects a trigger without a timing keyword", () => {
    expect(() => sqlLite.parse("CREATE TRIGGER t INSERT ON x EXECUTE FUNCTION f();")).toThrow(
      /Expected "before", "after" or "instead"/,
    );
  });
});

// --- expressions ---

describe("SQL-lite expressions", () => {
  it("applies arithmetic precedence and concatenation", () => {
    expect(exprOf("1 + 2 * 3")).toEqual(bin("+", num(1), bin("*", num(2), num(3))));
    expect(exprOf("(1 + 2) * 3")).toEqual(bin("*", bin("+", num(1), num(2)), num(3)));
    expect(exprOf("a || b || c")).toEqual(bin("||", bin("||", name("a"), name("b")), name("c")));
  });

  it("parses the containment operator and casts", () => {
    expect(exprOf("tags @> other")).toEqual(bin("@>", name("tags"), name("other")));
    expect(exprOf("x::int")).toEqual({ kind: "cast", expr: name("x"), type: { name: "int", args: [], array: false } });
    expect(exprOf("'123'::int::text")).toMatchObject({ kind: "cast", type: { name: "text" }, expr: { kind: "cast" } });
  });

  it("binds unary minus and NOT", () => {
    expect(exprOf("-a * b")).toEqual(bin("*", { kind: "unary", op: "-", operand: name("a") }, name("b")));
    expect(exprOf("NOT a")).toEqual({ kind: "unary", op: "not", operand: name("a") });
  });

  it("orders keyword logical operators below comparisons", () => {
    expect(exprOf("a = 1 AND b = 2 OR c = 3")).toEqual(
      bin("or", bin("and", bin("=", name("a"), num(1)), bin("=", name("b"), num(2))), bin("=", name("c"), num(3))),
    );
  });

  it("rejects chained non-associative comparisons", () => {
    expect(() => sqlLite.parse("CREATE TABLE t (c int CHECK (a < b < c));")).toThrow(/non-associative/);
    // The parenthesised form re-enters at bp 0 and parses.
    expect(exprOf("(a < b) = c")).toEqual(bin("=", bin("<", name("a"), name("b")), name("c")));
  });

  it("parses IS [NOT] NULL, [NOT] LIKE/ILIKE, BETWEEN and IN", () => {
    expect(exprOf("a IS NULL")).toEqual({ kind: "is", expr: name("a"), negated: false });
    expect(exprOf("a IS NOT NULL")).toEqual({ kind: "is", expr: name("a"), negated: true });
    expect(exprOf("name LIKE 'a%'")).toEqual({
      kind: "like",
      expr: name("name"),
      pattern: str("a%"),
      negated: false,
      ci: false,
    });
    expect(exprOf("name NOT ILIKE 'a%'")).toEqual({
      kind: "like",
      expr: name("name"),
      pattern: str("a%"),
      negated: true,
      ci: true,
    });
    expect(exprOf("age BETWEEN 1 AND 10")).toEqual({
      kind: "between",
      expr: name("age"),
      lo: num(1),
      hi: num(10),
      negated: false,
    });
    expect(exprOf("age NOT BETWEEN 1 AND 10")).toMatchObject({ kind: "between", negated: true });
    expect(exprOf("id IN (1, 2, 3)")).toEqual({
      kind: "in",
      expr: name("id"),
      list: [num(1), num(2), num(3)],
      negated: false,
    });
    expect(exprOf("id NOT IN (1, 2)")).toMatchObject({ kind: "in", negated: true });
  });

  it("parses qualified names and function calls", () => {
    expect(exprOf("schema.tbl.col")).toEqual(name("schema", "tbl", "col"));
    expect(exprOf("coalesce(a, 0)")).toEqual({ kind: "call", name: "coalesce", args: [name("a"), num(0)] });
    expect(exprOf("now()")).toEqual({ kind: "call", name: "now", args: [] });
  });
});

// --- expression operators (Phase 1) ---

describe("SQL-lite expression operators", () => {
  it("lexes JSON / regex / full-text operators as single op tokens", () => {
    const toks = lex("~* !~* #- ->> #>> ?| ?& <@ @@ -> #>");
    expect(toks.every((t) => t.type === "op")).toBe(true);
    expect(toks.map((t) => t.value)).toEqual(["~*", "!~*", "#-", "->>", "#>>", "?|", "?&", "<@", "@@", "->", "#>"]);
  });

  it("parses JSON / regex / full-text operators at the bp-12 tier", () => {
    expect(exprOf("data -> 'k'")).toEqual(bin("->", name("data"), str("k")));
    // Chained JSON accessors nest left-associatively.
    expect(exprOf("a -> 'k' ->> 'j'")).toEqual(bin("->>", bin("->", name("a"), str("k")), str("j")));
    expect(exprOf("meta #- '{x}'")).toEqual(bin("#-", name("meta"), str("{x}")));
    expect(exprOf("col ~ 'a.*'")).toEqual(bin("~", name("col"), str("a.*")));
    expect(exprOf("col !~* 'a'")).toEqual(bin("!~*", name("col"), str("a")));
    expect(exprOf("doc @@ 'query'")).toEqual(bin("@@", name("doc"), str("query")));
    expect(exprOf("tags ?& other")).toEqual(bin("?&", name("tags"), name("other")));
    // bp-12 binds tighter than a comparison (bp 9): (a -> 'k') = 'v'.
    expect(exprOf("a -> 'k' = 'v'")).toEqual(bin("=", bin("->", name("a"), str("k")), str("v")));
  });

  it("parses IS [NOT] DISTINCT FROM and IS [NOT] TRUE/FALSE/UNKNOWN", () => {
    expect(exprOf("a IS DISTINCT FROM b")).toEqual({
      kind: "isDistinct",
      expr: name("a"),
      from: name("b"),
      negated: false,
    });
    expect(exprOf("a IS NOT DISTINCT FROM b")).toMatchObject({ kind: "isDistinct", negated: true });
    expect(exprOf("a IS TRUE")).toEqual({ kind: "isTest", expr: name("a"), test: "true", negated: false });
    expect(exprOf("a IS NOT FALSE")).toEqual({ kind: "isTest", expr: name("a"), test: "false", negated: true });
    expect(exprOf("a IS UNKNOWN")).toEqual({ kind: "isTest", expr: name("a"), test: "unknown", negated: false });
    // The plain IS [NOT] NULL node is untouched.
    expect(exprOf("a IS NULL")).toEqual({ kind: "is", expr: name("a"), negated: false });
    // IS binds tighter than AND: (a IS DISTINCT FROM b) AND c.
    expect(exprOf("a IS DISTINCT FROM b AND c")).toEqual(
      bin("and", { kind: "isDistinct", expr: name("a"), from: name("b"), negated: false }, name("c")),
    );
  });

  it("parses LIKE ... ESCAPE and [NOT] SIMILAR TO", () => {
    expect(exprOf("name LIKE 'a%' ESCAPE '!'")).toEqual({
      kind: "like",
      expr: name("name"),
      pattern: str("a%"),
      negated: false,
      ci: false,
      escape: str("!"),
    });
    // No ESCAPE → the key is absent (existing LIKE shape is preserved).
    expect(exprOf("name LIKE 'a%'")).toEqual({
      kind: "like",
      expr: name("name"),
      pattern: str("a%"),
      negated: false,
      ci: false,
    });
    expect(exprOf("name SIMILAR TO 'a%'")).toEqual({
      kind: "similarTo",
      expr: name("name"),
      pattern: str("a%"),
      negated: false,
    });
    expect(exprOf("name NOT SIMILAR TO 'a%' ESCAPE '/'")).toEqual({
      kind: "similarTo",
      expr: name("name"),
      pattern: str("a%"),
      negated: true,
      escape: str("/"),
    });
  });

  it("parses <cmp> ANY / ALL / SOME over an array or subquery", () => {
    expect(exprOf("x = ANY (arr)")).toEqual({
      kind: "anyAll",
      op: "=",
      quantifier: "any",
      left: name("x"),
      right: name("arr"),
    });
    expect(exprOf("x < ALL (arr)")).toMatchObject({ kind: "anyAll", op: "<", quantifier: "all" });
    expect(exprOf("x = SOME (arr)")).toMatchObject({ kind: "anyAll", quantifier: "some" });
    // A subquery RHS produces the scalar-subquery node.
    const w = (firstStmt("SELECT 1 FROM t WHERE x = ANY (SELECT id FROM u);") as any).where;
    expect(w).toEqual({
      kind: "anyAll",
      op: "=",
      quantifier: "any",
      left: name("x"),
      right: { kind: "subquery", query: sel({ columns: [col(name("id"))], from: [tableFrom(["u"])] }) },
    });
  });

  it("reports the NOT dispatcher's extended keyword set", () => {
    expect(() => sqlLite.parse("CREATE TABLE t (c int CHECK (a NOT frobnicate b));")).toThrow(
      /Expected "like", "ilike", "similar", "between" or "in"/,
    );
  });
});

// --- expression special forms (Phase 2) ---

describe("SQL-lite expression special forms", () => {
  const colExpr = (src: string) => (firstStmt(`SELECT ${src} FROM t;`) as any).columns[0].expr;

  it("lexes positional / named parameters as a dedicated token, distinct from dollar strings", () => {
    expect(lex("$1 $foo $bar123")).toEqual([
      { type: "param", value: "1" },
      { type: "param", value: "foo" },
      { type: "param", value: "bar123" },
    ]);
    // A `$tag$…$tag$` dollar string is still a string — the param reader falls
    // through to nothing there because the dollar-string reader claims it first.
    expect(lex("$t$raw$t$")).toEqual([{ type: "string", value: "raw" }]);
  });

  it("parses parameters in expression position", () => {
    expect(colExpr("$1")).toEqual({ kind: "param", name: "1" });
    expect((firstStmt("SELECT 1 FROM t WHERE a = $1;") as any).where).toEqual(
      bin("=", name("a"), { kind: "param", name: "1" }),
    );
  });

  it("parses CAST(expr AS type) into the same node as the :: cast", () => {
    expect(colExpr("CAST(x AS int)")).toEqual({
      kind: "cast",
      expr: name("x"),
      type: { name: "int", args: [], array: false },
    });
    expect(colExpr("CAST(n AS numeric(10, 2))")).toMatchObject({
      kind: "cast",
      type: { name: "numeric", args: [10, 2] },
    });
  });

  it("parses ARRAY[…] constructors, including the empty one", () => {
    expect(colExpr("ARRAY[1, 2, 3]")).toEqual({ kind: "array", elements: [num(1), num(2), num(3)] });
    expect(colExpr("ARRAY[]")).toEqual({ kind: "array", elements: [] });
  });

  it("parses ROW(…) constructors", () => {
    expect(colExpr("ROW(1, 'a', b)")).toEqual({ kind: "row", items: [num(1), str("a"), name("b")] });
    expect(colExpr("ROW()")).toEqual({ kind: "row", items: [] });
  });

  it("parses [i] subscripts and [lo:hi] slices as postfixes", () => {
    expect(colExpr("a[1]")).toEqual({ kind: "subscript", base: name("a"), index: num(1) });
    // A slice carries `upper`; a bare subscript omits the key.
    expect(colExpr("a[1:3]")).toEqual({ kind: "subscript", base: name("a"), index: num(1), upper: num(3) });
    expect(colExpr("a[:3]")).toEqual({ kind: "subscript", base: name("a"), index: null, upper: num(3) });
    expect(colExpr("a[1:]")).toEqual({ kind: "subscript", base: name("a"), index: num(1), upper: null });
    // Subscript binds tighter than the `::` cast and chains left.
    expect(colExpr("m['k']['j']")).toEqual({
      kind: "subscript",
      base: { kind: "subscript", base: name("m"), index: str("k") },
      index: str("j"),
    });
    expect(colExpr("a[1]::int")).toEqual({
      kind: "cast",
      expr: { kind: "subscript", base: name("a"), index: num(1) },
      type: { name: "int", args: [], array: false },
    });
  });

  it("parses INTERVAL literals with an optional field spec, and interval-as-name", () => {
    expect(colExpr("INTERVAL '1 day'")).toEqual({ kind: "interval", value: "1 day" });
    expect(colExpr("INTERVAL '1' DAY")).toEqual({ kind: "interval", value: "1", fields: "day" });
    expect(colExpr("INTERVAL '1:00' HOUR TO MINUTE")).toEqual({
      kind: "interval",
      value: "1:00",
      fields: "hour to minute",
    });
    // `interval` is unreserved: without a string literal it is an ordinary name,
    // and the field scan never swallows a following clause keyword like FROM.
    expect(colExpr("interval")).toEqual(name("interval"));
    expect((firstStmt("SELECT INTERVAL '1 day' FROM t;") as any).columns[0].expr).toEqual({
      kind: "interval",
      value: "1 day",
    });
  });

  it("parses EXTRACT(field FROM source)", () => {
    expect(colExpr("EXTRACT(year FROM ts)")).toEqual({ kind: "extract", field: "year", source: name("ts") });
    expect(colExpr("EXTRACT(month FROM now())")).toMatchObject({ kind: "extract", field: "month" });
  });

  it("parses SUBSTRING in both the FROM/FOR and the comma form", () => {
    expect(colExpr("SUBSTRING(s FROM 1 FOR 3)")).toEqual({
      kind: "substring",
      value: name("s"),
      from: num(1),
      for_: num(3),
    });
    expect(colExpr("SUBSTRING(s FROM 2)")).toEqual({
      kind: "substring",
      value: name("s"),
      from: num(2),
      for_: null,
    });
    // The ordinary comma form falls through to a plain call node.
    expect(colExpr("SUBSTRING(s, 1, 3)")).toEqual({
      kind: "call",
      name: "substring",
      args: [name("s"), num(1), num(3)],
    });
  });

  it("parses POSITION(substring IN string), reading the first operand as a b-expression", () => {
    expect(colExpr("POSITION(sub IN str)")).toEqual({
      kind: "position",
      substring: name("sub"),
      string: name("str"),
    });
    // The `IN` separator is not consumed by the `in` postfix: the first operand
    // still parses tight operators like `::` and `||`.
    expect(colExpr("POSITION('a'::text IN str)")).toEqual({
      kind: "position",
      substring: { kind: "cast", expr: str("a"), type: { name: "text", args: [], array: false } },
      string: name("str"),
    });
  });

  it("parses TRIM with an optional side, characters, and FROM source", () => {
    expect(colExpr("TRIM(BOTH ' ' FROM s)")).toEqual({
      kind: "trim",
      side: "both",
      characters: str(" "),
      source: name("s"),
    });
    expect(colExpr("TRIM(LEADING FROM s)")).toEqual({
      kind: "trim",
      side: "leading",
      characters: null,
      source: name("s"),
    });
    expect(colExpr("TRIM('x' FROM s)")).toEqual({
      kind: "trim",
      side: null,
      characters: str("x"),
      source: name("s"),
    });
    expect(colExpr("TRIM(s)")).toEqual({ kind: "trim", side: null, characters: null, source: name("s") });
  });

  it("parses COLLATE and AT TIME ZONE postfixes", () => {
    expect(colExpr('name COLLATE "en_US"')).toEqual({
      kind: "collate",
      expr: name("name"),
      collation: ["en_US"],
    });
    expect(colExpr("ts AT TIME ZONE 'utc'")).toEqual({
      kind: "atTimeZone",
      expr: name("ts"),
      zone: str("utc"),
    });
  });

  it("reports a helpful error when a special form is malformed", () => {
    // POSITION requires its IN separator.
    expect(() => sqlLite.parse("SELECT POSITION(a b) FROM t;")).toThrow(/Expected .*"in"/i);
    // A bare `$` is not a parameter and has no reader — a lex-level error.
    expect(() => sqlLite.parse("SELECT $ FROM t;")).toThrow(ParseError);
  });
});

// --- window functions (Phase 3) ---

describe("SQL-lite window functions", () => {
  const winExpr = (src: string) => (firstStmt(`SELECT ${src} FROM t;`) as any).columns[0].expr;
  const call = (fnName: string, args: unknown[] = []) => ({ kind: "call", name: fnName, args });
  const order = (expr: unknown, dir: string | null = null, nulls: string | null = null) => ({ expr, dir, nulls });

  it("parses an empty OVER () and a partition/order spec", () => {
    expect(winExpr("rank() OVER ()")).toEqual({
      kind: "window",
      fn: call("rank"),
      name: null,
      partitionBy: null,
      orderBy: null,
      frame: null,
    });
    expect(winExpr("row_number() OVER (PARTITION BY dept ORDER BY salary DESC)")).toEqual({
      kind: "window",
      fn: call("row_number"),
      name: null,
      partitionBy: [name("dept")],
      orderBy: [order(name("salary"), "desc")],
      frame: null,
    });
  });

  it("parses BETWEEN and single-bound frame clauses", () => {
    expect(winExpr("sum(x) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)")).toEqual({
      kind: "window",
      fn: call("sum", [name("x")]),
      name: null,
      partitionBy: null,
      orderBy: [order(name("id"))],
      frame: { mode: "rows", start: { kind: "unboundedPreceding" }, end: { kind: "currentRow" } },
    });
    // Single-bound shorthand: `end` is null; `offset PRECEDING/FOLLOWING` carries an expr.
    expect(winExpr("sum(x) OVER (RANGE 1 PRECEDING)")).toMatchObject({
      frame: { mode: "range", start: { kind: "preceding", offset: num(1) }, end: null },
    });
    expect(winExpr("sum(x) OVER (GROUPS BETWEEN CURRENT ROW AND 2 FOLLOWING)")).toMatchObject({
      frame: {
        mode: "groups",
        start: { kind: "currentRow" },
        end: { kind: "following", offset: num(2) },
      },
    });
  });

  it("parses a bare `OVER name` reference and an inline base-window name", () => {
    expect(winExpr("rank() OVER w")).toEqual({
      kind: "window",
      fn: call("rank"),
      name: "w",
      partitionBy: null,
      orderBy: null,
      frame: null,
    });
    // A leading name inside the parens is the referenced base window.
    expect(winExpr("rank() OVER (w ORDER BY x)")).toEqual({
      kind: "window",
      fn: call("rank"),
      name: "w",
      partitionBy: null,
      orderBy: [order(name("x"))],
      frame: null,
    });
  });

  it("parses FILTER (WHERE …) and WITHIN GROUP (ORDER BY …)", () => {
    expect(winExpr("count(*) FILTER (WHERE x > 0)")).toEqual({
      kind: "aggFilter",
      fn: call("count", [star()]),
      where: bin(">", name("x"), num(0)),
    });
    expect(winExpr("percentile_cont(0.5) WITHIN GROUP (ORDER BY x)")).toEqual({
      kind: "withinGroup",
      fn: call("percentile_cont", [num(0.5)]),
      orderBy: [order(name("x"))],
    });
  });

  it("nests WITHIN GROUP inside FILTER inside OVER when combined", () => {
    expect(winExpr("count(*) FILTER (WHERE active) OVER (PARTITION BY y)")).toEqual({
      kind: "window",
      fn: { kind: "aggFilter", fn: call("count", [star()]), where: name("active") },
      name: null,
      partitionBy: [name("y")],
      orderBy: null,
      frame: null,
    });
  });

  it("parses a SELECT-level WINDOW clause and an `OVER w` reference to it", () => {
    expect(firstStmt("SELECT rank() OVER w AS r FROM t WINDOW w AS (PARTITION BY a ORDER BY b);")).toEqual(
      sel({
        columns: [
          col(
            {
              kind: "window",
              fn: { kind: "call", name: "rank", args: [] },
              name: "w",
              partitionBy: null,
              orderBy: null,
              frame: null,
            },
            "r",
          ),
        ],
        from: [tableFrom(["t"])],
        window: [
          {
            name: "w",
            spec: { name: null, partitionBy: [name("a")], orderBy: [order(name("b"))], frame: null },
          },
        ],
      }),
    );
  });

  it("keeps the window keywords unreserved as names and aliases", () => {
    // `over`, `filter`, `partition` are ordinary unreserved names here.
    expect((firstStmt("SELECT over, filter, partition FROM t;") as any).columns).toEqual([
      col(name("over")),
      col(name("filter")),
      col(name("partition")),
    ]);
    // `filter` not followed by `(` is an alias, not a modifier.
    expect((firstStmt("SELECT count(*) filter FROM t;") as any).columns).toEqual([
      col(call("count", [star()]), "filter"),
    ]);
  });

  it("reports a helpful error on a malformed frame bound", () => {
    expect(() => sqlLite.parse("SELECT sum(x) OVER (ORDER BY id ROWS UNBOUNDED) FROM t;")).toThrow(/following/);
  });
});

// --- remaining SELECT clauses (Phase 4) ---

describe("SQL-lite FROM items: LATERAL, table functions, TABLESAMPLE", () => {
  const from = (src: string) => (firstStmt(src) as any).from;
  const call = (fnName: string, args: unknown[] = []) => ({ kind: "call", name: fnName, args });

  it("parses a table function in FROM and a schema-qualified one", () => {
    expect(from("SELECT * FROM generate_series(1, 10) g;")).toEqual([
      { kind: "function", call: call("generate_series", [num(1), num(10)]), alias: "g" },
    ]);
    // Dotted callee, no alias, and an empty arg list.
    expect(from("SELECT * FROM pg_catalog.generate_series(1, 5);")).toEqual([
      { kind: "function", call: call("pg_catalog.generate_series", [num(1), num(5)]), alias: null },
    ]);
  });

  it("parses LATERAL subqueries and LATERAL functions", () => {
    expect(from("SELECT * FROM a, LATERAL (SELECT 1) b;")).toEqual([
      tableFrom(["a"]),
      { kind: "subquery", query: sel({ columns: [col(num(1))] }), alias: "b", lateral: true },
    ]);
    expect(from("SELECT * FROM a CROSS JOIN LATERAL unnest(a.tags) t;")).toEqual([
      {
        kind: "join",
        joinType: "cross",
        left: tableFrom(["a"]),
        right: { kind: "function", call: call("unnest", [name("a", "tags")]), alias: "t", lateral: true },
        on: null,
        using: null,
      },
    ]);
  });

  it("parses TABLESAMPLE with and without REPEATABLE", () => {
    expect(from("SELECT * FROM t TABLESAMPLE SYSTEM (10);")).toEqual([
      { kind: "table", name: ["t"], alias: null, tablesample: { method: "system", args: [num(10)], repeatable: null } },
    ]);
    expect(from("SELECT * FROM t AS x TABLESAMPLE bernoulli (10) REPEATABLE (5);")).toEqual([
      {
        kind: "table",
        name: ["t"],
        alias: "x",
        tablesample: { method: "bernoulli", args: [num(10)], repeatable: num(5) },
      },
    ]);
  });

  it("omits lateral/tablesample keys on ordinary items and rejects a bare LATERAL name", () => {
    // A plain table item is byte-identical to the pre-Phase-4 shape.
    expect(from("SELECT * FROM t;")).toEqual([{ kind: "table", name: ["t"], alias: null }]);
    // LATERAL must be followed by a subquery or a function call.
    expect(() => sqlLite.parse("SELECT * FROM LATERAL t;")).toThrow(/subquery or function/);
  });
});

describe("SQL-lite VALUES query", () => {
  it("parses a standalone VALUES statement", () => {
    expect(firstStmt("VALUES (1, 2), (3, 4);")).toEqual({
      kind: "values",
      rows: [
        [num(1), num(2)],
        [num(3), num(4)],
      ],
      orderBy: null,
      limit: null,
      offset: null,
    });
  });

  it("carries an ORDER BY / LIMIT tail and composes in a set-op", () => {
    expect(firstStmt("VALUES (3), (1), (2) ORDER BY 1 LIMIT 2;")).toMatchObject({
      kind: "values",
      orderBy: [{ expr: num(1), dir: null, nulls: null }],
      limit: num(2),
    });
    expect(firstStmt("SELECT 1 UNION VALUES (2);")).toMatchObject({
      kind: "setOp",
      op: "union",
      right: { kind: "values", rows: [[num(2)]] },
    });
  });

  it("is usable as a FROM table source", () => {
    expect((firstStmt("SELECT * FROM (VALUES (1), (2)) t;") as any).from).toEqual([
      {
        kind: "subquery",
        query: { kind: "values", rows: [[num(1)], [num(2)]], orderBy: null, limit: null, offset: null },
        alias: "t",
      },
    ]);
  });
});

describe("SQL-lite FETCH / OFFSET row words", () => {
  it("maps FETCH FIRST … ROWS ONLY onto limit", () => {
    expect(firstStmt("SELECT 1 FETCH FIRST 10 ROWS ONLY;")).toMatchObject({ limit: num(10), offset: null });
    // OFFSET … ROWS then FETCH NEXT … ROWS WITH TIES, standard-SQL spelling.
    expect(firstStmt("SELECT 1 OFFSET 5 ROWS FETCH NEXT 3 ROWS WITH TIES;")).toMatchObject({
      limit: num(3),
      offset: num(5),
    });
  });

  it("accepts FETCH with an omitted count", () => {
    expect(firstStmt("SELECT 1 FETCH FIRST ROW ONLY;")).toMatchObject({ limit: null });
  });
});

describe("SQL-lite FOR UPDATE / SHARE locking", () => {
  it("parses a single locking clause with OF and a wait policy", () => {
    expect((firstStmt("SELECT * FROM t FOR UPDATE OF t, u NOWAIT;") as any).locking).toEqual([
      { strength: "update", of: [["t"], ["u"]], wait: "nowait" },
    ]);
  });

  it("parses NO KEY UPDATE / KEY SHARE and stacked clauses", () => {
    expect((firstStmt("SELECT * FROM t FOR NO KEY UPDATE FOR KEY SHARE SKIP LOCKED;") as any).locking).toEqual([
      { strength: "noKeyUpdate", of: [], wait: null },
      { strength: "keyShare", of: [], wait: "skipLocked" },
    ]);
    expect((firstStmt("SELECT * FROM t FOR SHARE;") as any).locking).toEqual([
      { strength: "share", of: [], wait: null },
    ]);
  });
});

describe("SQL-lite GROUP BY ROLLUP / CUBE / GROUPING SETS", () => {
  const groupBy = (src: string) => (firstStmt(`SELECT a FROM t GROUP BY ${src};`) as any).groupBy;

  it("parses ROLLUP and CUBE, keeping plain exprs as bare expressions", () => {
    expect(groupBy("ROLLUP (a, b)")).toEqual([{ kind: "rollup", args: [[name("a")], [name("b")]] }]);
    // A parenthesised column group inside the construct becomes a multi-expr grouping.
    expect(groupBy("CUBE ((a, b), c), d")).toEqual([
      { kind: "cube", args: [[name("a"), name("b")], [name("c")]] },
      name("d"),
    ]);
  });

  it("parses GROUPING SETS with an empty grouping", () => {
    expect(groupBy("GROUPING SETS ((a), (b), ())")).toEqual([
      { kind: "groupingSets", sets: [[name("a")], [name("b")], []] },
    ]);
  });

  it("keeps rollup/cube/grouping unreserved as names and functions", () => {
    // `cube` with no following `(` is an ordinary column; `grouping(a)` is a call.
    expect(groupBy("cube")).toEqual([name("cube")]);
    expect(groupBy("grouping(a)")).toEqual([{ kind: "call", name: "grouping", args: [name("a")] }]);
  });
});

// --- robustness ---

describe("SQL-lite robustness", () => {
  it("diagnose() recovers to the next comma inside a bad column, keeping siblings and later statements", () => {
    const { ast, errors } = sqlLite.diagnose("CREATE TABLE t (id int, 42 bad, ok text);\nDROP TABLE t;");
    expect(errors.length).toBeGreaterThanOrEqual(1);

    const stmts = stripSpans(ast) as any[];
    expect(stmts[0].kind).toBe("createTable");
    // The malformed `42 bad` item is dropped; the siblings around it survive.
    expect(stmts[0].items.map((i: any) => i.name)).toEqual(["id", "ok"]);
    // The statement after the recovered one still parses.
    expect(stmts[1]).toMatchObject({ kind: "drop", objectType: "table", names: [["t"]] });
  });

  it("strict parse() throws on a malformed column with no recovery", () => {
    expect(() => sqlLite.parse("CREATE TABLE t (id int, oops);")).toThrow(ParseError);
  });

  it("reports the farthest failure across a backtracked branch", () => {
    // `IF NOT EXIST` is a typo: the IF-NOT-EXISTS attempt backtracks after
    // consuming `if not`, and the shallow error that surfaces ("expected `(`")
    // is replaced by the deeper one preferFarthest kept.
    expect(() => sqlLite.parse("CREATE TABLE IF NOT EXIST foo (id int);")).toThrow(/exists/);
  });

  it("labels a non-statement start with the statement description", () => {
    expect(() => sqlLite.parse("CREATE TABLE t (id int); frobnicate;")).toThrow(/Expected a statement/);
  });

  it("parses a realistic multi-statement DDL file", () => {
    const ddl = [
      "-- schema bootstrap",
      "CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy');",
      "CREATE TABLE IF NOT EXISTS person (",
      "  id int PRIMARY KEY,",
      "  name text NOT NULL,",
      "  current_mood mood DEFAULT 'ok',",
      "  score numeric(5, 2) CHECK (score >= 0 AND score <= 100)",
      ");",
      "CREATE UNIQUE INDEX person_name_idx ON person (lower(name)) WHERE name IS NOT NULL;",
      "ALTER TABLE person ADD COLUMN team_id int REFERENCES team (id) ON DELETE CASCADE;",
      "COMMENT ON TABLE person IS $doc$people we know$doc$;",
    ].join("\n");
    const { ast, errors } = sqlLite.diagnose(ddl);
    expect(errors).toEqual([]);
    expect((ast as Stmt[]).map((s) => s.kind)).toEqual([
      "createType",
      "createTable",
      "createIndex",
      "alterTable",
      "comment",
    ]);
  });
});

// --- SELECT ---

describe("SQL-lite SELECT", () => {
  it("parses SELECT * FROM with a table alias", () => {
    expect(firstStmt("SELECT * FROM users u;")).toEqual(
      sel({ columns: [col(star())], from: [tableFrom(["users"], "u")] }),
    );
  });

  it("parses a column list with [AS] aliases", () => {
    expect(firstStmt("SELECT id, name AS n, u.age full_age FROM users u;")).toEqual(
      sel({
        columns: [col(name("id")), col(name("name"), "n"), col(name("u", "age"), "full_age")],
        from: [tableFrom(["users"], "u")],
      }),
    );
  });

  it("does not swallow a following clause keyword as an alias", () => {
    // `from`/`where` are reserved, so the alias detector stops before them.
    expect(firstStmt("SELECT a FROM t WHERE a;")).toEqual(
      sel({ columns: [col(name("a"))], from: [tableFrom(["t"])], where: name("a") }),
    );
  });

  it("parses every trailing clause", () => {
    expect(
      firstStmt(
        "SELECT id FROM users WHERE age >= 18 GROUP BY id HAVING count(*) > 1 " +
          "ORDER BY id DESC NULLS LAST, name ASC LIMIT 10 OFFSET 5;",
      ),
    ).toEqual(
      sel({
        columns: [col(name("id"))],
        from: [tableFrom(["users"])],
        where: bin(">=", name("age"), num(18)),
        groupBy: [name("id")],
        having: bin(">", { kind: "call", name: "count", args: [star()] }, num(1)),
        orderBy: [
          { expr: name("id"), dir: "desc", nulls: "last" },
          { expr: name("name"), dir: "asc", nulls: null },
        ],
        limit: num(10),
        offset: num(5),
      }),
    );
  });

  it("accepts OFFSET before LIMIT and LIMIT ALL", () => {
    expect(firstStmt("SELECT 1 OFFSET 5 LIMIT 10;")).toMatchObject({ limit: num(10), offset: num(5) });
    expect(firstStmt("SELECT 1 LIMIT ALL;")).toMatchObject({ limit: null });
  });

  it("parses DISTINCT and DISTINCT ON (...)", () => {
    expect(firstStmt("SELECT DISTINCT a FROM t;")).toMatchObject({ distinct: true });
    expect(firstStmt("SELECT DISTINCT ON (a, b) a FROM t;")).toMatchObject({ distinct: [name("a"), name("b")] });
  });

  it("parses * / t.* / count(*) / count(distinct x)", () => {
    const cols = (src: string) => (firstStmt(src) as any).columns;
    expect(cols("SELECT t.* FROM t;")).toEqual([col(star(["t"]))]);
    expect(cols("SELECT count(*) FROM t;")).toEqual([col({ kind: "call", name: "count", args: [star()] })]);
    // DISTINCT inside an aggregate is accepted; the call AST stays unchanged.
    expect(cols("SELECT count(distinct x) FROM t;")).toEqual([col({ kind: "call", name: "count", args: [name("x")] })]);
  });
});

// --- joins & subqueries ---

describe("SQL-lite joins & subqueries", () => {
  const from = (src: string) => (firstStmt(src) as any).from;

  it("parses INNER JOIN ... ON", () => {
    expect(from("SELECT 1 FROM users u JOIN teams t ON u.team_id = t.id;")).toEqual([
      {
        kind: "join",
        joinType: "inner",
        left: tableFrom(["users"], "u"),
        right: tableFrom(["teams"], "t"),
        on: bin("=", name("u", "team_id"), name("t", "id")),
        using: null,
      },
    ]);
  });

  it("parses LEFT JOIN ... USING and CROSS JOIN (left-assoc chain)", () => {
    expect(from("SELECT 1 FROM a LEFT JOIN b USING (id) CROSS JOIN c;")).toEqual([
      {
        kind: "join",
        joinType: "cross",
        left: {
          kind: "join",
          joinType: "left",
          left: tableFrom(["a"]),
          right: tableFrom(["b"]),
          on: null,
          using: ["id"],
        },
        right: tableFrom(["c"]),
        on: null,
        using: null,
      },
    ]);
  });

  it("parses a comma-separated FROM and a subquery FROM item", () => {
    expect(from("SELECT 1 FROM a, b;")).toEqual([tableFrom(["a"]), tableFrom(["b"])]);
    expect(from("SELECT 1 FROM (SELECT 1) sub;")).toEqual([
      { kind: "subquery", query: sel({ columns: [col(num(1))] }), alias: "sub" },
    ]);
  });

  it("parses a scalar subquery, EXISTS / NOT EXISTS, and IN / NOT IN (SELECT ...)", () => {
    const where = (src: string) => (firstStmt(`SELECT 1 FROM t WHERE ${src};`) as any).where;
    expect((firstStmt("SELECT (SELECT max(x) FROM u) m FROM t;") as any).columns).toEqual([
      col(
        {
          kind: "subquery",
          query: sel({ columns: [col({ kind: "call", name: "max", args: [name("x")] })], from: [tableFrom(["u"])] }),
        },
        "m",
      ),
    ]);
    expect(where("EXISTS (SELECT 1)")).toEqual({
      kind: "exists",
      query: sel({ columns: [col(num(1))] }),
      negated: false,
    });
    expect(where("NOT EXISTS (SELECT 1)")).toMatchObject({ kind: "exists", negated: true });
    expect(where("id IN (SELECT id FROM u)")).toEqual({
      kind: "inSubquery",
      expr: name("id"),
      query: sel({ columns: [col(name("id"))], from: [tableFrom(["u"])] }),
      negated: false,
    });
    expect(where("id NOT IN (SELECT id FROM u)")).toMatchObject({ kind: "inSubquery", negated: true });
    // The list-valued IN is unaffected by the subquery branch.
    expect(where("id IN (1, 2, 3)")).toEqual({
      kind: "in",
      expr: name("id"),
      list: [num(1), num(2), num(3)],
      negated: false,
    });
  });
});

// --- CASE ---

describe("SQL-lite CASE", () => {
  const caseOf = (src: string) => (firstStmt(`SELECT ${src} FROM t;`) as any).columns[0].expr;

  it("parses a searched CASE with ELSE", () => {
    expect(caseOf("CASE WHEN a THEN 1 WHEN b THEN 2 ELSE 3 END")).toEqual({
      kind: "case",
      operand: null,
      whens: [
        { when: name("a"), then_: num(1) },
        { when: name("b"), then_: num(2) },
      ],
      else_: num(3),
    });
  });

  it("parses a simple CASE with an operand and no ELSE", () => {
    expect(caseOf("CASE x WHEN 1 THEN 'a' END")).toEqual({
      kind: "case",
      operand: name("x"),
      whens: [{ when: num(1), then_: str("a") }],
      else_: null,
    });
  });
});

// --- set-ops & CTEs ---

describe("SQL-lite set-ops & CTEs", () => {
  it("parses left-associative UNION / EXCEPT ALL", () => {
    expect(firstStmt("SELECT a FROM t UNION SELECT a FROM u EXCEPT ALL SELECT a FROM v;")).toEqual({
      kind: "setOp",
      op: "exceptAll",
      left: {
        kind: "setOp",
        op: "union",
        left: sel({ columns: [col(name("a"))], from: [tableFrom(["t"])] }),
        right: sel({ columns: [col(name("a"))], from: [tableFrom(["u"])] }),
      },
      right: sel({ columns: [col(name("a"))], from: [tableFrom(["v"])] }),
    });
  });

  it("parses parenthesised set-op terms", () => {
    expect(firstStmt("(SELECT 1) UNION (SELECT 2);")).toMatchObject({ kind: "setOp", op: "union" });
  });

  it("attaches a WITH prefix to the leading SELECT", () => {
    expect(firstStmt("WITH cte AS (SELECT 1 AS x) SELECT x FROM cte;")).toEqual(
      sel({
        with_: [{ name: "cte", columns: null, query: sel({ columns: [col(num(1), "x")] }) }],
        columns: [col(name("x"))],
        from: [tableFrom(["cte"])],
      }),
    );
    expect(firstStmt("WITH RECURSIVE r (n) AS (SELECT 1) SELECT * FROM r;")).toMatchObject({
      recursive: true,
      with_: [{ name: "r", columns: ["n"] }],
    });
  });
});

// --- data-modifying CTEs (WITH before DML, DML CTE bodies) ---

describe("SQL-lite data-modifying CTEs", () => {
  it("attaches a WITH prefix to INSERT / UPDATE / DELETE", () => {
    expect(firstStmt("WITH c AS (SELECT 1 AS x) INSERT INTO t SELECT * FROM c;")).toMatchObject({
      kind: "insert",
      recursive: false,
      with_: [{ name: "c", columns: null, query: sel({ columns: [col(num(1), "x")] }) }],
      table: ["t"],
      source: { kind: "select", query: sel({ columns: [col(star())], from: [tableFrom(["c"])] }) },
    });
    expect(firstStmt("WITH c AS (SELECT 1) UPDATE t SET a = 1 WHERE a > 0;")).toMatchObject({
      kind: "update",
      recursive: false,
      with_: [{ name: "c", query: sel({ columns: [col(num(1))] }) }],
      set: [{ column: "a", value: num(1) }],
    });
    expect(firstStmt("WITH RECURSIVE c AS (SELECT 1) DELETE FROM t WHERE a > 0;")).toMatchObject({
      kind: "delete",
      recursive: true,
      with_: [{ name: "c" }],
      table: ["t"],
    });
  });

  it("leaves WITH-less DML AST unchanged (no with_ / recursive keys)", () => {
    // stripSpans → the exact shape the pre-Phase-5 tests asserted; the optional
    // WITH fields must not surface when no WITH prefix is present.
    expect(firstStmt("INSERT INTO t (a) VALUES (1);")).toEqual({
      kind: "insert",
      table: ["t"],
      columns: ["a"],
      source: { kind: "values", rows: [[num(1)]] },
      onConflict: null,
      returning: null,
    });
  });

  it("parses a data-modifying CTE body (DELETE ... RETURNING)", () => {
    expect(firstStmt("WITH moved AS (DELETE FROM src WHERE done RETURNING id) SELECT * FROM moved;")).toMatchObject({
      kind: "select",
      with_: [
        {
          name: "moved",
          query: {
            kind: "delete",
            table: ["src"],
            where: name("done"),
            returning: [col(name("id"))],
          },
        },
      ],
      from: [tableFrom(["moved"])],
    });
  });

  it("parses an INSERT ... RETURNING CTE feeding another INSERT", () => {
    expect(
      firstStmt("WITH ins AS (INSERT INTO a VALUES (1) RETURNING id) INSERT INTO b SELECT id FROM ins;"),
    ).toMatchObject({
      kind: "insert",
      table: ["b"],
      with_: [
        {
          name: "ins",
          query: { kind: "insert", table: ["a"], source: { kind: "values", rows: [[num(1)]] } },
        },
      ],
    });
  });

  it("croaks when a WITH prefix leads a bare VALUES query", () => {
    expect(() => sqlLite.parse("WITH c AS (SELECT 1) VALUES (1);")).toThrow(
      /WITH must attach to a SELECT, INSERT, UPDATE or DELETE/,
    );
  });
});

// --- INSERT / UPDATE / DELETE ---

describe("SQL-lite INSERT / UPDATE / DELETE", () => {
  it("parses INSERT ... VALUES with a column list and RETURNING *", () => {
    expect(firstStmt("INSERT INTO t (a, b) VALUES (1, 2), (3, 4) RETURNING *;")).toEqual({
      kind: "insert",
      table: ["t"],
      columns: ["a", "b"],
      source: {
        kind: "values",
        rows: [
          [num(1), num(2)],
          [num(3), num(4)],
        ],
      },
      onConflict: null,
      returning: [col(star())],
    });
  });

  it("parses INSERT ... SELECT (parenthesised query source too)", () => {
    expect(firstStmt("INSERT INTO t SELECT * FROM u;")).toMatchObject({
      kind: "insert",
      columns: null,
      source: { kind: "select", query: sel({ columns: [col(star())], from: [tableFrom(["u"])] }) },
    });
    // A leading `(` that opens a query, not a column list.
    expect(firstStmt("INSERT INTO t (SELECT 1);")).toMatchObject({
      kind: "insert",
      columns: null,
      source: { kind: "select", query: sel({ columns: [col(num(1))] }) },
    });
  });

  it("parses ON CONFLICT DO NOTHING and DO UPDATE SET ... WHERE", () => {
    expect((firstStmt("INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO NOTHING;") as any).onConflict).toEqual({
      target: ["a"],
      action: { kind: "nothing" },
    });
    expect(
      (firstStmt("INSERT INTO t (a) VALUES (1) ON CONFLICT DO UPDATE SET a = 2 WHERE t.a > 0;") as any).onConflict,
    ).toEqual({
      target: null,
      action: { kind: "update", set: [{ column: "a", value: num(2) }], where: bin(">", name("t", "a"), num(0)) },
    });
  });

  it("parses UPDATE ... SET ... FROM ... WHERE ... RETURNING", () => {
    expect(firstStmt("UPDATE t AS x SET a = 1, b = 2 FROM u WHERE x.id = u.id RETURNING a;")).toEqual({
      kind: "update",
      table: ["t"],
      alias: "x",
      set: [
        { column: "a", value: num(1) },
        { column: "b", value: num(2) },
      ],
      from: [tableFrom(["u"])],
      where: bin("=", name("x", "id"), name("u", "id")),
      returning: [col(name("a"))],
    });
  });

  it("parses DELETE ... USING ... WHERE ... RETURNING", () => {
    expect(firstStmt("DELETE FROM t x USING u WHERE x.id = u.id RETURNING *;")).toEqual({
      kind: "delete",
      table: ["t"],
      alias: "x",
      using: [tableFrom(["u"])],
      where: bin("=", name("x", "id"), name("u", "id")),
      returning: [col(star())],
    });
  });
});

// --- DML robustness ---

describe("SQL-lite DML robustness", () => {
  it("throws a descriptive error on a FROM with no table", () => {
    expect(() => sqlLite.parse("SELECT * FROM;")).toThrow(ParseError);
  });

  it("recovers at the statement terminator and keeps later statements", () => {
    const { ast, errors } = sqlLite.diagnose("SELECT * FRUM t;\nSELECT 1;");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    const stmts = stripSpans(ast) as any[];
    // The malformed first statement is dropped; the following one survives.
    expect(stmts[stmts.length - 1]).toMatchObject({ kind: "select", columns: [col(num(1))] });
  });
});
