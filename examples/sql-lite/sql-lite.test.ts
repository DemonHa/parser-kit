import { createInputStream, ParseError, stripSpans } from "@parser-kit/core";
import { describe, expect, it } from "vitest";
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
    expect((plain as any).columns).toEqual([{ expr: name("email") }]);

    const partial = firstStmt("CREATE UNIQUE INDEX ON users (lower(email)) WHERE active;");
    expect(partial).toMatchObject({ kind: "createIndex", unique: true, name: null });
    expect((partial as any).columns).toEqual([{ expr: { kind: "call", name: "lower", args: [name("email")] } }]);
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
    expect((idx as any).columns).toEqual([{ expr: name("email") }]);
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
  const action = (text: string) => {
    const { actions } = firstStmt(text) as any;
    expect(actions).toHaveLength(1);
    return actions[0];
  };

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
  const action = (text: string) => {
    const { actions } = firstStmt(text) as any;
    expect(actions).toHaveLength(1);
    return actions[0];
  };

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

// --- ALTER TABLE action lists and IF [NOT] EXISTS ---

describe("SQL-lite ALTER TABLE action lists and IF [NOT] EXISTS", () => {
  const alter = (text: string) => firstStmt(text) as any;
  const addColumn = (name: string, ifNotExists = false) => ({
    kind: "addColumn",
    ifNotExists,
    column: { kind: "column", name, dataType: { name: "int", args: [], array: false }, constraints: [] },
  });

  it("parses comma-separated actions in source order", () => {
    expect(alter("ALTER TABLE t ADD a int, DROP COLUMN b, ALTER c SET NOT NULL, OWNER TO bob;")).toEqual({
      kind: "alterTable",
      ifExists: false,
      name: ["t"],
      actions: [
        addColumn("a"),
        { kind: "dropColumn", name: "b" },
        { kind: "setNotNull", column: "c" },
        { kind: "ownerTo", owner: "bob" },
      ],
    });
  });

  it("ends each action at the comma, inside or outside parentheses", () => {
    expect(
      alter("ALTER TABLE t ADD CONSTRAINT k CHECK (f(a, b)), ADD UNIQUE (a, b), ALTER a TYPE numeric(10, 2);").actions,
    ).toMatchObject([
      { kind: "addConstraint", name: "k", constraint: { kind: "check" } },
      { kind: "addConstraint", name: null, constraint: { kind: "unique", columns: ["a", "b"] } },
      { kind: "setDataType", column: "a", dataType: { name: "numeric", args: [10, 2] } },
    ]);
    // A comma straight after an expression or a column constraint's tail.
    expect(alter("ALTER TABLE t ALTER a SET DEFAULT f(1, 2) + 3, DROP b;").actions).toMatchObject([
      { kind: "setDefault", column: "a", expr: { kind: "binary", op: "+" } },
      { kind: "dropColumn", name: "b" },
    ]);
    expect(alter("ALTER TABLE t ADD a int REFERENCES p (id) ON DELETE CASCADE, DROP c;").actions).toMatchObject([
      { kind: "addColumn", column: { name: "a", constraints: [{ kind: "references", onDelete: "cascade" }] } },
      { kind: "dropColumn", name: "c" },
    ]);
  });

  it("records IF EXISTS on the statement", () => {
    expect(alter("ALTER TABLE IF EXISTS s.t ADD a int;")).toMatchObject({ ifExists: true, name: ["s", "t"] });
    expect(alter("ALTER TABLE IF EXISTS t RENAME TO u;")).toMatchObject({
      ifExists: true,
      actions: [{ kind: "renameTable", to: "u" }],
    });
  });

  it("records IF NOT EXISTS on ADD, with or without COLUMN", () => {
    expect(alter("ALTER TABLE t ADD COLUMN IF NOT EXISTS a int, ADD IF NOT EXISTS b int, ADD c int;").actions).toEqual([
      addColumn("a", true),
      addColumn("b", true),
      addColumn("c"),
    ]);
  });

  it("keeps IF / EXISTS usable as table and column names", () => {
    expect(alter("ALTER TABLE if ADD a int;")).toMatchObject({ ifExists: false, name: ["if"] });
    expect(alter("ALTER TABLE IF EXISTS if ADD a int;")).toMatchObject({ ifExists: true, name: ["if"] });
    expect(alter("ALTER TABLE exists ADD a int;")).toMatchObject({ ifExists: false, name: ["exists"] });
    expect(alter("ALTER TABLE t ADD if int;").actions).toEqual([addColumn("if")]);
    expect(alter("ALTER TABLE t ADD COLUMN if int;").actions).toEqual([addColumn("if")]);
    expect(alter("ALTER TABLE t ADD COLUMN IF NOT EXISTS exists int;").actions).toEqual([addColumn("exists", true)]);
    expect(alter("ALTER TABLE t ADD COLUMN IF NOT EXISTS if int;").actions).toEqual([addColumn("if", true)]);
    // A quoted "not" is an ordinary type name, so it does not start IF NOT EXISTS.
    expect(alter('ALTER TABLE t ADD if "not";').actions).toMatchObject([
      { kind: "addColumn", ifNotExists: false, column: { name: "if", dataType: { name: "not" } } },
    ]);
  });

  it("spans the whole statement, from ALTER through the last action", () => {
    const [stmt] = sqlLite.parse("ALTER TABLE t ADD a int, DROP b;") as Record<string, any>[];
    expect(stmt!.span).toEqual({ start: { row: 1, col: 0 }, end: { row: 1, col: 31 } });
  });

  it("rejects RENAME beside any other action, on either side", () => {
    expect(() => sqlLite.parse("ALTER TABLE t RENAME TO u, ADD a int;")).toThrow(
      /RENAME cannot be combined with other ALTER TABLE actions \(1:14\)/,
    );
    expect(() => sqlLite.parse("ALTER TABLE t ADD a int, RENAME COLUMN a TO b;")).toThrow(
      /RENAME cannot be combined with other ALTER TABLE actions \(1:25\)/,
    );
  });

  it("reports a combined RENAME over the whole action and recovers after it", () => {
    const { ast, errors } = sqlLite.diagnose("ALTER TABLE t ADD a int, RENAME a TO b;\nSELECT 1;");
    expect(errors.map((e) => ({ message: e.message, end: e.end }))).toEqual([
      { message: "RENAME cannot be combined with other ALTER TABLE actions (1:25)", end: { row: 1, col: 38 } },
    ]);
    expect((ast as Stmt[]).map((s) => s.kind)).toEqual(["select"]);
  });

  // Only a comma followed by an action's lead word counts as a second action; a
  // stray one after a RENAME fails as a stray comma.
  it("rejects a stray comma after RENAME as a comma, not as a combination", () => {
    for (const text of ["ALTER TABLE t RENAME TO u,;", "ALTER TABLE t RENAME TO u, 42;"]) {
      expect(() => sqlLite.parse(text)).toThrow(/Expected ";" but found "," \(1:25\)/);
    }
  });

  it("rejects a trailing comma, a misspelt IF NOT EXISTS and an unknown ALTER target", () => {
    expect(() => sqlLite.parse("ALTER TABLE t ADD a int,;")).toThrow(/Expected "add", "drop".* but found ";"/);
    expect(() => sqlLite.parse("ALTER TABLE t ADD COLUMN IF NOT EXIST a int;")).toThrow(
      /Expected "exists" but found "exist"/,
    );
    expect(() => sqlLite.parse("ALTER frobnicate t;")).toThrow(
      /Expected "table", "schema", "domain", "type", "index", "function", "aggregate", "view", "materialized" or "sequence" but found "frobnicate"/,
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

// --- DROP: the remaining object types ---

describe("SQL-lite DROP object types", () => {
  const drop = (text: string) => firstStmt(text) as Extract<Stmt, { kind: "drop" }>;
  const arg = (type: string, extra: Record<string, unknown> = {}) => ({
    mode: null,
    name: null,
    type: { name: type, args: [], array: false },
    defaultValue: null,
    ...extra,
  });

  it("drops functions and procedures with optional signatures", () => {
    expect(drop("DROP FUNCTION IF EXISTS f(int, double precision), s.g, h() CASCADE;")).toEqual({
      kind: "drop",
      objectType: "function",
      concurrently: false,
      ifExists: true,
      names: [["f"], ["s", "g"], ["h"]],
      behavior: "cascade",
      signatures: [{ star: false, args: [arg("int"), arg("double precision")] }, null, { star: false, args: [] }],
    });
    expect(drop("DROP PROCEDURE p(IN a int, OUT b text) RESTRICT;")).toMatchObject({
      objectType: "procedure",
      names: [["p"]],
      behavior: "restrict",
      signatures: [
        { star: false, args: [arg("int", { mode: "in", name: "a" }), arg("text", { mode: "out", name: "b" })] },
      ],
    });
  });

  it("drops aggregates by their (*) or typed signature", () => {
    expect(drop("DROP AGGREGATE IF EXISTS myavg(*), s.agg(int);")).toEqual({
      kind: "drop",
      objectType: "aggregate",
      concurrently: false,
      ifExists: true,
      names: [["myavg"], ["s", "agg"]],
      behavior: null,
      signatures: [
        { star: true, args: [] },
        { star: false, args: [arg("int")] },
      ],
    });
  });

  it("drops a trigger from its table", () => {
    expect(drop("DROP TRIGGER IF EXISTS trg ON s.t CASCADE;")).toEqual({
      kind: "drop",
      objectType: "trigger",
      concurrently: false,
      ifExists: true,
      names: [["trg"]],
      behavior: "cascade",
      table: ["s", "t"],
    });
  });

  it("drops a database, with and without FORCE", () => {
    const base = { kind: "drop", objectType: "database", concurrently: false, names: [["db"]], behavior: null };
    expect(drop("DROP DATABASE db;")).toEqual({ ...base, ifExists: false });
    expect(drop("DROP DATABASE IF EXISTS db WITH (FORCE);")).toEqual({ ...base, ifExists: true, force: true });
    expect(drop("DROP DATABASE db (force, FORCE);")).toEqual({ ...base, ifExists: false, force: true });
  });

  it("drops domains, extensions, materialized views, roles and users", () => {
    expect(drop("DROP DOMAIN IF EXISTS s.d, e RESTRICT;")).toEqual({
      kind: "drop",
      objectType: "domain",
      concurrently: false,
      ifExists: true,
      names: [["s", "d"], ["e"]],
      behavior: "restrict",
    });
    expect(drop("DROP EXTENSION hstore, pgcrypto CASCADE;")).toMatchObject({
      objectType: "extension",
      names: [["hstore"], ["pgcrypto"]],
      behavior: "cascade",
    });
    expect(drop("DROP MATERIALIZED VIEW IF EXISTS s.mv;")).toMatchObject({
      objectType: "materialized view",
      ifExists: true,
      names: [["s", "mv"]],
    });
    expect(drop("DROP ROLE a, b;")).toMatchObject({ objectType: "role", names: [["a"], ["b"]], behavior: null });
    expect(drop("DROP USER IF EXISTS u;")).toMatchObject({ objectType: "user", ifExists: true, names: [["u"]] });
  });

  it("omits the per-kind keys on the original object kinds", () => {
    const stmt = drop("DROP VIEW v CASCADE;");
    expect(stmt).not.toHaveProperty("signatures");
    expect(stmt).not.toHaveProperty("table");
    expect(stmt).not.toHaveProperty("force");
  });

  it("keeps the DROP object words unreserved as names", () => {
    expect((firstStmt("SELECT function, procedure, aggregate, trigger, domain FROM t;") as any).columns).toHaveLength(
      5,
    );
    expect((firstStmt("SELECT database, extension, materialized, role, force FROM t;") as any).columns).toHaveLength(5);
    expect(drop("DROP FUNCTION function(procedure int);")).toMatchObject({
      names: [["function"]],
      signatures: [{ star: false, args: [arg("int", { name: "procedure" })] }],
    });
    expect(drop("DROP TRIGGER trigger ON aggregate;")).toMatchObject({ names: [["trigger"]], table: ["aggregate"] });
    expect(drop("DROP DATABASE force;")).toMatchObject({ names: [["force"]] });
    expect(drop("DROP ROLE role;")).toMatchObject({ names: [["role"]] });
    expect(drop("DROP EXTENSION extension;")).toMatchObject({ names: [["extension"]] });
    expect(drop("DROP DOMAIN domain;")).toMatchObject({ names: [["domain"]] });
    expect(drop("DROP TABLE database, materialized;")).toMatchObject({ names: [["database"], ["materialized"]] });
    // `if` is a name wherever `exists` does not follow it.
    expect(drop("DROP DATABASE if;")).toMatchObject({ ifExists: false, names: [["if"]] });
    expect(drop("DROP TRIGGER if ON t;")).toMatchObject({ ifExists: false, names: [["if"]] });
  });

  it("rejects malformed DROP statements", () => {
    const fails = (text: string) => () => sqlLite.parse(text);
    expect(fails("DROP TRIGGER t;")).toThrow(/Expected "on" but found ";"/);
    expect(fails("DROP frobnicate x;")).toThrow(
      /Expected "table", "view", "index", "type", "sequence", "schema", "materialized", "function", "procedure", "aggregate", "trigger", "domain", "extension", "database", "role" or "user" but found "frobnicate"/,
    );
    expect(fails("DROP AGGREGATE a;")).toThrow(/Expected "\(" but found ";"/);
    expect(fails("DROP MATERIALIZED t;")).toThrow(/Expected "view" but found "t"/);
    expect(fails("DROP DATABASE d WITH force;")).toThrow(/Expected "\(" but found "force"/);
    expect(fails("DROP DATABASE d (cascade);")).toThrow(/Expected "force" but found "cascade"/);
    // PG takes no CASCADE / RESTRICT on roles or databases.
    expect(fails("DROP ROLE r CASCADE;")).toThrow(/Expected ";" but found "cascade"/);
    expect(fails("DROP DATABASE a, b;")).toThrow(/Expected ";" but found ","/);
    expect(fails("DROP DATABASE d WITH ();")).toThrow(/Expected "force" but found "\)"/);
    // CONCURRENTLY stays an INDEX-family word; trigger names are unqualified.
    expect(fails("DROP FUNCTION CONCURRENTLY f;")).toThrow(/Expected ";" but found "f"/);
    expect(fails("DROP TRIGGER s.trg ON t;")).toThrow(/Expected "on" but found "\."/);
    // Signatures name types only: no `*` outside aggregates, no defaults, no empty aggregate list.
    expect(fails("DROP FUNCTION f(*);")).toThrow(/Expected a name but found "\*"/);
    expect(fails("DROP FUNCTION f(a int = 2) CASCADE;")).toThrow(/takes no argument defaults, but found "=" \(1:22\)/);
    expect(fails("DROP AGGREGATE a(x int DEFAULT 1);")).toThrow(/takes no argument defaults, but found "default"/);
    expect(fails("DROP AGGREGATE a();")).toThrow(/Expected "\*" or a function argument but found "\)"/);
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
      /Expected "view", "materialized", "function", "procedure", "aggregate" or "trigger"/,
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

// --- arithmetic, bitwise and jsonpath operators ---

describe("SQL-lite arithmetic, bitwise and jsonpath operators", () => {
  const un = (op: string, operand: unknown) => ({ kind: "unary", op, operand });
  const cast = (expr: unknown, type: string) => ({ kind: "cast", expr, type: ct(type) });

  it("lexes the arithmetic, bitwise and jsonpath operators as single op tokens", () => {
    const toks = lex("% ^ & | # << >> @?");
    expect(toks.every((t) => t.type === "op")).toBe(true);
    expect(toks.map((t) => t.value)).toEqual(["%", "^", "&", "|", "#", "<<", ">>", "@?"]);
  });

  it("parses modulo at the multiplicative tier", () => {
    expect(exprOf("a % b")).toEqual(bin("%", name("a"), name("b")));
    // bp 14, same tier as `*` and `/`: left-associative and above `+`.
    expect(exprOf("a % b * c")).toEqual(bin("*", bin("%", name("a"), name("b")), name("c")));
    expect(exprOf("a + b % c")).toEqual(bin("+", name("a"), bin("%", name("b"), name("c"))));
  });

  it("parses unary plus alongside unary minus", () => {
    expect(exprOf("+a")).toEqual(un("+", name("a")));
    // The operator is kept verbatim rather than folded away.
    expect(exprOf("+1")).toEqual(un("+", num(1)));
    // bp 16, above `*`: `(+a) * b`, not `+(a * b)`. (It is *not* above every
    // arithmetic tier — `^` at bp 17 is tighter still; see the next test.)
    expect(exprOf("+a * b")).toEqual(bin("*", un("+", name("a")), name("b")));
    // A sign on the right-hand side of a binary operator still reaches the prefix.
    expect(exprOf("a * +b")).toEqual(bin("*", name("a"), un("+", name("b"))));
    // Unchanged: unary minus keeps its own shape and precedence.
    expect(exprOf("-a * b")).toEqual(bin("*", un("-", name("a")), name("b")));
  });

  it("parses exponentiation tighter than the unary sign, left-associatively", () => {
    expect(exprOf("a ^ b")).toEqual(bin("^", name("a"), name("b")));
    expect(exprOf("a ^ b ^ c")).toEqual(bin("^", bin("^", name("a"), name("b")), name("c")));
    // bp 17 is above the unary sign (16), so the sign wraps the whole power.
    expect(exprOf("-2 ^ 2")).toEqual(un("-", bin("^", num(2), num(2))));
    expect(exprOf("+2 ^ 2")).toEqual(un("+", bin("^", num(2), num(2))));
    // ... and below the bp-18 postfixes. The right operand is what discriminates:
    // a cast there binds to that operand, not to the power. (`a::int ^ 2` is the
    // same tree at any bp, since the postfix loop runs before the infix scan.)
    expect(exprOf("a ^ b::int")).toEqual(bin("^", name("a"), cast(name("b"), "int")));
    expect(exprOf("a::int ^ 2")).toEqual(bin("^", cast(name("a"), "int"), num(2)));
    // ... and above `*`, so the power is the multiplicand.
    expect(exprOf("2 ^ 3 * 4")).toEqual(bin("*", bin("^", num(2), num(3)), num(4)));
  });

  it("nests a signed right operand of ^ under the sign, not the power", () => {
    // The tail of putting `^` above the unary sign: a prefix parses its operand
    // at its own bp (16), which is below `^`'s 17, so the sign on the right
    // swallows the rest of the chain instead of the chain nesting left.
    expect(exprOf("2 ^ -3 ^ 4")).toEqual(bin("^", num(2), un("-", bin("^", num(3), num(4)))));
    // Without a sign the same chain is plain left-associative.
    expect(exprOf("2 ^ 3 ^ 4")).toEqual(bin("^", bin("^", num(2), num(3)), num(4)));
  });

  it("parses the bitwise and shift operators at the bp-12 tier", () => {
    expect(exprOf("a & b")).toEqual(bin("&", name("a"), name("b")));
    expect(exprOf("a | b")).toEqual(bin("|", name("a"), name("b")));
    expect(exprOf("a # b")).toEqual(bin("#", name("a"), name("b")));
    expect(exprOf("a << 2")).toEqual(bin("<<", name("a"), num(2)));
    expect(exprOf("a >> 2")).toEqual(bin(">>", name("a"), num(2)));
    // Left-associative within the tier.
    expect(exprOf("a | b | c")).toEqual(bin("|", bin("|", name("a"), name("b")), name("c")));
    // bp 12 is below `+` (13) and above the bp-9 comparisons.
    expect(exprOf("a | b + c")).toEqual(bin("|", name("a"), bin("+", name("b"), name("c"))));
    expect(exprOf("a & b = c")).toEqual(bin("=", bin("&", name("a"), name("b")), name("c")));
  });

  it("parses the jsonpath existence operator", () => {
    expect(exprOf("data @? '$.x'")).toEqual(bin("@?", name("data"), str("$.x")));
    // Same tier as `@@`, so a comparison still takes the whole match as its LHS.
    expect(exprOf("data @? '$.x' = b")).toEqual(bin("=", bin("@?", name("data"), str("$.x")), name("b")));
  });

  it("keeps the longer operators that share a lead character intact", () => {
    // `#` is bitwise XOR, but `#-` / `#>` / `#>>` are their own tokens: maximal
    // munch in the lexer, so adding `#` cannot split them.
    expect(exprOf("meta #- '{x}'")).toEqual(bin("#-", name("meta"), str("{x}")));
    expect(exprOf("meta #> '{x}'")).toEqual(bin("#>", name("meta"), str("{x}")));
    expect(exprOf("meta #>> '{x}'")).toEqual(bin("#>>", name("meta"), str("{x}")));
    // `|` is bitwise OR, `||` is still concatenation, `?|` still key-existence.
    expect(exprOf("a || b")).toEqual(bin("||", name("a"), name("b")));
    expect(exprOf("tags ?| other")).toEqual(bin("?|", name("tags"), name("other")));
    // `@?` is jsonpath existence, `@>` containment and `@@` full-text match.
    expect(exprOf("a @> b")).toEqual(bin("@>", name("a"), name("b")));
    expect(exprOf("doc @@ 'q'")).toEqual(bin("@@", name("doc"), str("q")));
  });

  it("leaves the lexer's trailing-sign rule to decide where an unspaced sign goes", () => {
    // The operator reader trims a trailing `+`/`-` from a run unless the run
    // holds a "strong" character, so `<<` and `>>` let the sign go while
    // `% & | ^` absorb it into one unknown operator — PG's own rule, now
    // reachable from both sides because the sign is a prefix here.
    expect(exprOf("a << -1")).toEqual(bin("<<", name("a"), un("-", num(1))));
    expect(exprOf("a >> -1")).toEqual(bin(">>", name("a"), un("-", num(1))));
    // Spaced, the sign is its own token and the power parses.
    expect(exprOf("2 ^ -2")).toEqual(bin("^", num(2), un("-", num(2))));
    // Unspaced, `^-` lexes as one operator that no group claims.
    expect(() => sqlLite.parse("SELECT 2^-2 FROM t;")).toThrow(/but found "\^-"/);
    // `++` is trimmed to a single `+`, so a doubled sign reaches the prefix.
    expect(exprOf("a ++ b")).toEqual(bin("+", name("a"), un("+", name("b"))));
  });

  it("shares the new operators with the b-expression", () => {
    // POSITION's first operand is parsed by the b-expression, which reuses
    // `arithInfix` verbatim — so a widened group (`%` joining `*` and `/`) and
    // a brand-new one (`^`) both reach it without a second table.
    const posOf = (src: string) => (firstStmt(`SELECT position(${src}) FROM t;`) as any).columns[0].expr;
    expect(posOf("a % 2 IN s")).toEqual({
      kind: "position",
      substring: bin("%", name("a"), num(2)),
      string: name("s"),
    });
    expect(posOf("a ^ 2 IN s")).toEqual({
      kind: "position",
      substring: bin("^", name("a"), num(2)),
      string: name("s"),
    });
    // The prefix group is shared too, so the widened sign reaches it as well.
    expect(posOf("+a IN s")).toEqual({ kind: "position", substring: un("+", name("a")), string: name("s") });
  });

  it("reports a missing right operand at the token that should have started it", () => {
    expect(() => sqlLite.parse("SELECT a ^ FROM t;")).toThrow(/Expected a name but found "from"/);
  });
});

// --- row constructors, OVERLAPS, BETWEEN SYMMETRIC and IS JSON ---

describe("SQL-lite row constructors, OVERLAPS, BETWEEN SYMMETRIC and IS JSON", () => {
  const colExpr = (src: string) => (firstStmt(`SELECT ${src} FROM t;`) as any).columns[0].expr;
  // The same column without stripSpans, for the span assertions.
  const rawCol = (src: string) => (sqlLite.parse(`SELECT ${src} FROM t;`)[0] as any).columns[0].expr;
  // The implicit `(a, b)` spelling; `explicitRow` is `ROW(a, b)`.
  const row = (...items: unknown[]) => ({ kind: "row", items, implicit: true });
  const explicitRow = (...items: unknown[]) => ({ kind: "row", items });
  const overlaps = (left: unknown, right: unknown) => ({ kind: "overlaps", left, right });
  const ab_cd = overlaps(row(name("a"), name("b")), row(name("c"), name("d")));
  const between = (over: Record<string, unknown>) => ({
    kind: "between",
    expr: name("a"),
    lo: num(1),
    hi: num(2),
    negated: false,
    ...over,
  });
  const isJson = (over: Record<string, unknown> = {}) => ({
    kind: "isJson",
    expr: name("x"),
    itemType: null,
    uniqueKeys: null,
    negated: false,
    ...over,
  });

  it("builds an implicit row from a parenthesised list, and only from one", () => {
    expect(colExpr("(a, b)")).toEqual(row(name("a"), name("b")));
    expect(colExpr("(1, 'x', c + 1)")).toEqual(row(num(1), str("x"), bin("+", name("c"), num(1))));
    // The two spellings share a node; only the implicit one carries the flag.
    expect(colExpr("ROW(a, b)")).toEqual(explicitRow(name("a"), name("b")));
    expect(colExpr("ROW(a, b)")).not.toHaveProperty("implicit");
    // A lone parenthesised expression is still just that expression.
    expect(colExpr("(a)")).toEqual(name("a"));
    expect(colExpr("((a, b))")).toEqual(row(name("a"), name("b")));
    // Rows compose like any other operand.
    expect(colExpr("(a, b) = (1, 2)")).toEqual(bin("=", row(name("a"), name("b")), row(num(1), num(2))));
    expect((firstStmt("SELECT 1 FROM t WHERE (a, b) IN ((1, 2));") as any).where).toEqual({
      kind: "in",
      expr: row(name("a"), name("b")),
      list: [row(num(1), num(2))],
      negated: false,
    });
    // The parentheses of a quantified comparison are its own, not this atom's, so
    // a row needs a second pair there — as in PG.
    expect(colExpr("x = ANY ((a, b))")).toEqual({
      kind: "anyAll",
      op: "=",
      quantifier: "any",
      left: name("x"),
      right: row(name("a"), name("b")),
    });
    expect(() => sqlLite.parse("SELECT x = ANY (a, b) FROM t;")).toThrow(/Expected "\)" but found ","/);
    // The flag is what tells PG's `GROUP BY (a, b)` (grouping by a and by b)
    // from `GROUP BY ROW(a, b)` (grouping by one composite value).
    expect((firstStmt("SELECT a FROM t GROUP BY (a, b);") as any).groupBy).toEqual([row(name("a"), name("b"))]);
    expect((firstStmt("SELECT a FROM t GROUP BY ROW(a, b);") as any).groupBy).toEqual([
      explicitRow(name("a"), name("b")),
    ]);
  });

  it("spans an implicit row over its parentheses but leaves a lone (a) on the inner expression", () => {
    expect(rawCol("(a, b)").span).toEqual({ start: { row: 1, col: 7 }, end: { row: 1, col: 13 } });
    expect(rawCol("(a)").span).toEqual({ start: { row: 1, col: 8 }, end: { row: 1, col: 9 } });
  });

  it("parses OVERLAPS between two periods in either row spelling", () => {
    expect(colExpr("(a, b) OVERLAPS (c, d)")).toEqual(ab_cd);
    const ab = row(name("a"), name("b"));
    const cd = row(name("c"), name("d"));
    const abExplicit = explicitRow(name("a"), name("b"));
    const cdExplicit = explicitRow(name("c"), name("d"));
    expect(colExpr("ROW(a, b) OVERLAPS ROW(c, d)")).toEqual(overlaps(abExplicit, cdExplicit));
    expect(colExpr("(a, b) OVERLAPS ROW(c, d)")).toEqual(overlaps(ab, cdExplicit));
    expect(colExpr("ROW(a, b) OVERLAPS (c, d)")).toEqual(overlaps(abExplicit, cd));
    // The period bounds are full expressions.
    expect(colExpr("(s, s + 1) OVERLAPS (e, e * 2)")).toEqual(
      overlaps(row(name("s"), bin("+", name("s"), num(1))), row(name("e"), bin("*", name("e"), num(2)))),
    );
  });

  it("binds OVERLAPS at the atom: looser operators wrap it, postfixes take the whole predicate", () => {
    expect(exprOf("(a, b) OVERLAPS (c, d) AND x")).toEqual(bin("and", ab_cd, name("x")));
    expect(exprOf("x OR (a, b) OVERLAPS (c, d)")).toEqual(bin("or", name("x"), ab_cd));
    // NOT is a prefix, so the atom has already absorbed the tail.
    expect(exprOf("NOT (a, b) OVERLAPS (c, d)")).toEqual({ kind: "unary", op: "not", operand: ab_cd });
    expect(exprOf("(a, b) OVERLAPS (c, d) IS TRUE")).toEqual({
      kind: "isTest",
      expr: ab_cd,
      test: "true",
      negated: false,
    });
    // A trailing cast binds to the predicate, not to the right-hand row — PG's
    // reading too, since its operands are rows rather than expressions.
    expect(exprOf("(a, b) OVERLAPS (c, d)::text")).toEqual({ kind: "cast", expr: ab_cd, type: ct("text") });
  });

  it("parses BETWEEN SYMMETRIC and ASYMMETRIC, recording only what was written", () => {
    expect(exprOf("a BETWEEN SYMMETRIC 1 AND 2")).toEqual(between({ symmetric: true }));
    expect(exprOf("a BETWEEN ASYMMETRIC 1 AND 2")).toEqual(between({ symmetric: false }));
    expect(exprOf("a NOT BETWEEN SYMMETRIC 1 AND 2")).toEqual(between({ negated: true, symmetric: true }));
    expect(exprOf("a NOT BETWEEN ASYMMETRIC 1 AND 2")).toEqual(between({ negated: true, symmetric: false }));
    // A bare BETWEEN carries no `symmetric` key at all.
    expect(exprOf("a BETWEEN 1 AND 2")).toEqual(between({}));
    expect(exprOf("a BETWEEN 1 AND 2")).not.toHaveProperty("symmetric");
    expect(exprOf("a NOT BETWEEN 1 AND 2")).toEqual(between({ negated: true }));
    // The bounds keep their bp-11 re-entry, so the AND after them is the outer one.
    expect(exprOf("a BETWEEN SYMMETRIC 1 AND 2 AND b")).toEqual(bin("and", between({ symmetric: true }), name("b")));
  });

  it("parses the IS [NOT] JSON predicate family", () => {
    expect(colExpr("x IS JSON")).toEqual(isJson());
    expect(colExpr("x IS NOT JSON")).toEqual(isJson({ negated: true }));
    for (const itemType of ["value", "scalar", "array", "object"]) {
      expect(colExpr(`x IS JSON ${itemType.toUpperCase()}`)).toEqual(isJson({ itemType }));
    }
    expect(colExpr("x IS JSON WITH UNIQUE KEYS")).toEqual(isJson({ uniqueKeys: true }));
    expect(colExpr("x IS JSON WITH UNIQUE")).toEqual(isJson({ uniqueKeys: true }));
    expect(colExpr("x IS JSON WITHOUT UNIQUE KEYS")).toEqual(isJson({ uniqueKeys: false }));
    expect(colExpr("x IS NOT JSON OBJECT WITHOUT UNIQUE")).toEqual(
      isJson({ negated: true, itemType: "object", uniqueKeys: false }),
    );
    // IS binds tighter than AND, as for the other IS forms.
    expect(exprOf("x IS JSON ARRAY AND y")).toEqual(bin("and", isJson({ itemType: "array" }), name("y")));
  });

  it("commits to a uniqueness clause on its lead word, as PG does", () => {
    // PG's grammar takes WITH / WITHOUT after IS JSON unconditionally, so neither
    // a bare-word alias nor a materialized view's data clause can follow it.
    expect(() => sqlLite.parse("SELECT x IS JSON without FROM t;")).toThrow(/Expected "unique" but found "from"/);
    expect(() => sqlLite.parse("CREATE MATERIALIZED VIEW mv AS SELECT x IS JSON WITH NO DATA;")).toThrow(
      /Expected "unique" but found "no"/,
    );
    // Spelled with AS, the alias is unambiguous; and the data clause still
    // follows any other IS form.
    expect((firstStmt("SELECT x IS JSON AS without FROM t;") as any).columns).toEqual([col(isJson(), "without")]);
    expect(firstStmt("CREATE MATERIALIZED VIEW mv AS SELECT x IS NULL WITH NO DATA;")).toMatchObject({
      kind: "createView",
      withData: false,
    });
    // KEYS is optional after UNIQUE, so after a bare IS JSON it is an alias.
    expect((firstStmt("SELECT x IS JSON keys FROM t;") as any).columns).toEqual([col(isJson(), "keys")]);
  });

  it("keeps overlaps and the IS JSON words unreserved as names and aliases", () => {
    // Every word these rules match by value that was not already reserved.
    // (`symmetric`, `asymmetric`, `with`, `array` and `unique` were reserved
    // long before; `json` only means anything straight after IS.)
    const words = ["overlaps", "json", "value", "scalar", "object", "without", "keys"];
    expect((firstStmt(`SELECT ${words.join(", ")} FROM t;`) as any).columns).toEqual(words.map((w) => col(name(w))));
    // …as column names,
    expect((firstStmt("CREATE TABLE t (overlaps int, json jsonb);") as any).items).toEqual([
      { kind: "column", name: "overlaps", dataType: ct("int"), constraints: [] },
      { kind: "column", name: "json", dataType: ct("jsonb"), constraints: [] },
    ]);
    // …and as aliases — including straight after a row, where `overlaps` is
    // claimed only when a row follows it (a `(`, or ROW and then a `(`).
    expect((firstStmt("SELECT a overlaps FROM t;") as any).columns).toEqual([col(name("a"), "overlaps")]);
    expect((firstStmt("SELECT (a, b) overlaps FROM t;") as any).columns).toEqual([
      col(row(name("a"), name("b")), "overlaps"),
    ]);
    expect((firstStmt("SELECT ROW(a, b) overlaps, c AS json FROM t;") as any).columns).toEqual([
      col(explicitRow(name("a"), name("b")), "overlaps"),
      col(name("c"), "json"),
    ]);
    // `overlaps row` without a `(` after it is an alias followed by a stray word.
    expect(() => sqlLite.parse("SELECT (a, b) overlaps row FROM t;")).toThrow(/Expected ";" but found "row"/);
  });

  it("takes the item-type word after IS JSON unconditionally, as PG does", () => {
    // PG's grammar reads `value` here as the VALUE form, not as an alias; so
    // does this one. Spelled with AS, the alias is unambiguous.
    expect((firstStmt("SELECT x IS JSON value FROM t;") as any).columns).toEqual([col(isJson({ itemType: "value" }))]);
    expect((firstStmt("SELECT x IS JSON AS value FROM t;") as any).columns).toEqual([col(isJson(), "value")]);
  });

  it("rejects malformed rows and periods of the wrong arity", () => {
    expect(() => sqlLite.parse("SELECT (a,) FROM t;")).toThrow(/but found "\)" \(1:10\)/);
    expect(() => sqlLite.parse("SELECT (,b) FROM t;")).toThrow(/but found "," \(1:8\)/);
    expect(() => sqlLite.parse("SELECT (a b) FROM t;")).toThrow(/Expected "\)" but found "b"/);
    expect(() => sqlLite.parse("SELECT () FROM t;")).toThrow(/but found "\)" \(1:8\)/);
    // PG checks both arities in its grammar; the error covers the offending row.
    expect(() => sqlLite.parse("SELECT (a, b, c) OVERLAPS (d, e) FROM t;")).toThrow(
      /Expected 2 items on the left of OVERLAPS but found 3 \(1:7\)/,
    );
    expect(() => sqlLite.parse("SELECT (a) OVERLAPS (d, e) FROM t;")).toThrow(
      /Expected 2 items on the left of OVERLAPS but found 1 \(1:7\)/,
    );
    expect(() => sqlLite.parse("SELECT (a, b) OVERLAPS (d) FROM t;")).toThrow(
      /Expected 2 items on the right of OVERLAPS but found 1 \(1:23\)/,
    );
    expect(() => sqlLite.parse("SELECT (a, b) OVERLAPS ROW() FROM t;")).toThrow(
      /Expected 2 items on the right of OVERLAPS but found 0/,
    );
    // A row OVERLAPS row predicate does not chain: the second `overlaps` has no
    // row before it, so it reads as an alias, and the row after it is stranded.
    expect(() => sqlLite.parse("SELECT (a, b) OVERLAPS (c, d) OVERLAPS (e, f) FROM t;")).toThrow(
      /Expected ";" but found "\(" \(1:39\)/,
    );
    // A subquery is not a period.
    expect(() => sqlLite.parse("SELECT (a, b) OVERLAPS (SELECT 1) FROM t;")).toThrow(/but found "select"/);
  });

  it("rejects a dangling BETWEEN modifier or IS JSON clause", () => {
    expect(() => sqlLite.parse("SELECT a BETWEEN SYMMETRIC AND 2 FROM t;")).toThrow(/but found "and"/);
    expect(() => sqlLite.parse("SELECT x IS JSON WITH KEYS FROM t;")).toThrow(/Expected "unique" but found "keys"/);
    expect(() => sqlLite.parse("SELECT x IS JSONB FROM t;")).toThrow(/Expected "null" but found "jsonb"/);
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

// --- aggregate call modifiers ---

describe("SQL-lite aggregate call modifiers", () => {
  const aggExpr = (src: string) => (firstStmt(`SELECT ${src} FROM t;`) as any).columns[0].expr;
  const call = (fnName: string, args: unknown[] = [], mods: Record<string, unknown> = {}) => ({
    kind: "call",
    name: fnName,
    args,
    ...mods,
  });
  const order = (expr: unknown, dir: string | null = null, nulls: string | null = null) => ({ expr, dir, nulls });
  const named = (argName: string, value: unknown) => ({ kind: "namedArg", name: argName, value });

  it("records DISTINCT on the call node, and omits the key on a plain call", () => {
    expect(aggExpr("count(DISTINCT x)")).toEqual(call("count", [name("x")], { distinct: true }));
    // Omit-when-absent, asserted on the keys rather than by equality: an always
    // present `distinct: false` would add a key to every call in the AST golden.
    expect(Object.keys(aggExpr("count(*)"))).toEqual(["kind", "name", "args"]);
  });

  it("parses an aggregate ORDER BY inside the argument list", () => {
    expect(aggExpr("array_agg(a ORDER BY b DESC NULLS LAST)")).toEqual(
      call("array_agg", [name("a")], { orderBy: [order(name("b"), "desc", "last")] }),
    );
    // A multi-argument aggregate: the ORDER BY closes the list, not an argument.
    expect(aggExpr("string_agg(a, ',' ORDER BY b)")).toEqual(
      call("string_agg", [name("a"), str(",")], { orderBy: [order(name("b"))] }),
    );
    // Both modifiers at once, as PG allows.
    expect(aggExpr("array_agg(DISTINCT a ORDER BY a)")).toEqual(
      call("array_agg", [name("a")], { distinct: true, orderBy: [order(name("a"))] }),
    );
  });

  it("parses named arguments, in a call and in a FROM table function", () => {
    expect(aggExpr("f(a => 1, b => 2)")).toEqual(call("f", [named("a", num(1)), named("b", num(2))]));
    // Mixed with positional arguments. PG requires the positional ones first;
    // the grammar accepts either order and leaves that to the planner.
    expect(aggExpr("f(1, tail => 2)")).toEqual(call("f", [num(1), named("tail", num(2))]));
    // `functionArg` is shared, so a FROM table function takes them too, as does
    // SUBSTRING's comma form from its second argument on — its first goes through
    // `expression`, so a named argument there is still rejected.
    expect(aggExpr("substring(s, a => 1)")).toEqual(call("substring", [name("s"), named("a", num(1))]));
    expect(() => sqlLite.parse("SELECT substring(str => 'abc', from => 2) FROM t;")).toThrow(/but found "=>"/);
    expect((firstStmt("SELECT * FROM generate_series(start => 1, stop => 5) g;") as any).from).toEqual([
      { kind: "function", call: call("generate_series", [named("start", num(1)), named("stop", num(5))]), alias: "g" },
    ]);
  });

  it("parses IGNORE / RESPECT NULLS, nesting inside FILTER and OVER", () => {
    expect(aggExpr("lag(x) IGNORE NULLS OVER (ORDER BY id)")).toEqual({
      kind: "window",
      fn: { kind: "nullTreatment", fn: call("lag", [name("x")]), treatment: "ignore" },
      name: null,
      partitionBy: null,
      orderBy: [order(name("id"))],
      frame: null,
    });
    expect(aggExpr("first_value(x) RESPECT NULLS OVER w")).toEqual({
      kind: "window",
      fn: { kind: "nullTreatment", fn: call("first_value", [name("x")]), treatment: "respect" },
      name: "w",
      partitionBy: null,
      orderBy: null,
      frame: null,
    });
    // The SQL-standard order — null treatment binds tightest, then FILTER, then
    // OVER. (PG has no null treatment at all; the other two are its order.)
    expect(aggExpr("count(x) IGNORE NULLS FILTER (WHERE x) OVER ()")).toEqual({
      kind: "window",
      fn: {
        kind: "aggFilter",
        fn: { kind: "nullTreatment", fn: call("count", [name("x")]), treatment: "ignore" },
        where: name("x"),
      },
      name: null,
      partitionBy: null,
      orderBy: null,
      frame: null,
    });
  });

  it("keeps ignore / respect / nulls unreserved as names and aliases", () => {
    expect((firstStmt("SELECT ignore, respect, nulls FROM t;") as any).columns).toEqual([
      col(name("ignore")),
      col(name("respect")),
      col(name("nulls")),
    ]);
    // Not followed by `nulls`, each is an ordinary alias on the call.
    expect((firstStmt("SELECT lag(x) ignore FROM t;") as any).columns).toEqual([
      col(call("lag", [name("x")]), "ignore"),
    ]);
    expect((firstStmt("SELECT lag(x) respect FROM t;") as any).columns).toEqual([
      col(call("lag", [name("x")]), "respect"),
    ]);
    // `nulls` on its own is an alias too — only the two-word pair is a modifier.
    expect((firstStmt("SELECT lag(x) nulls FROM t;") as any).columns).toEqual([col(call("lag", [name("x")]), "nulls")]);
    expect((firstStmt("CREATE TABLE t (ignore int, nulls text);") as any).items.map((i: any) => i.name)).toEqual([
      "ignore",
      "nulls",
    ]);
  });

  it("reports a helpful error on a truncated modifier", () => {
    // Both croak from inside `expression`, so the messages differ only in the
    // position — pin that, or either assertion would pass on the other's error.
    expect(() => sqlLite.parse("SELECT array_agg(a ORDER BY) FROM t;")).toThrow(/but found "\)" \(1:27\)/);
    expect(() => sqlLite.parse("SELECT f(a => ) FROM t;")).toThrow(/but found "\)" \(1:14\)/);
    // A named argument's label is a name, so a reserved word needs quoting.
    expect(() => sqlLite.parse("SELECT f(select => 1) FROM t;")).toThrow(/Expected a name but found "select"/);
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

// --- FROM-item column-alias lists and ONLY ---

describe("SQL-lite FROM-item column-alias lists and ONLY", () => {
  const from = (src: string) => (firstStmt(src) as any).from;
  const call = (fnName: string, args: unknown[] = []) => ({ kind: "call", name: fnName, args });

  it("reads a column-alias list after a table alias, with or without AS", () => {
    expect(from("SELECT * FROM t AS x (a, b);")).toEqual([
      { kind: "table", name: ["t"], alias: "x", columns: ["a", "b"] },
    ]);
    // The alias has been consumed before the `(`, so the AS-less spelling is
    // no harder to read than the AS one.
    expect(from("SELECT * FROM t x (a, b);")).toEqual([
      { kind: "table", name: ["t"], alias: "x", columns: ["a", "b"] },
    ]);
    // A quoted column alias keeps its case, as any quoted name does.
    expect(from('SELECT * FROM s.t AS x ("A", b);')).toEqual([
      { kind: "table", name: ["s", "t"], alias: "x", columns: ["A", "b"] },
    ]);
  });

  it("reads the list on subquery, VALUES and table-function items too", () => {
    expect(from("SELECT * FROM (VALUES (1, 2)) AS v (a, b);")).toEqual([
      {
        kind: "subquery",
        query: { kind: "values", rows: [[num(1), num(2)]], orderBy: null, limit: null, offset: null },
        alias: "v",
        columns: ["a", "b"],
      },
    ]);
    expect(from("SELECT * FROM (SELECT 1) s (a);")).toEqual([
      { kind: "subquery", query: sel({ columns: [col(num(1))] }), alias: "s", columns: ["a"] },
    ]);
    expect(from("SELECT * FROM generate_series(1, 3) AS g (n);")).toEqual([
      { kind: "function", call: call("generate_series", [num(1), num(3)]), alias: "g", columns: ["n"] },
    ]);
    expect(from("SELECT * FROM a, LATERAL unnest(a.tags) u (tag);")).toEqual([
      tableFrom(["a"]),
      { kind: "function", call: call("unnest", [name("a", "tags")]), alias: "u", columns: ["tag"], lateral: true },
    ]);
    expect(from("SELECT * FROM a, LATERAL (SELECT 1) l (one);")[1]).toEqual({
      kind: "subquery",
      query: sel({ columns: [col(num(1))] }),
      alias: "l",
      columns: ["one"],
      lateral: true,
    });
  });

  it("puts the list before TABLESAMPLE and reads it wherever a FROM item appears", () => {
    // PG's order is `relation_expr alias_clause tablesample_clause`.
    expect(from("SELECT * FROM t AS x (a) TABLESAMPLE system (10);")).toEqual([
      {
        kind: "table",
        name: ["t"],
        alias: "x",
        columns: ["a"],
        tablesample: { method: "system", args: [num(10)], repeatable: null },
      },
    ]);
    expect(from("SELECT * FROM a x (p) JOIN b y (q) USING (p);")).toEqual([
      {
        kind: "join",
        joinType: "inner",
        left: { kind: "table", name: ["a"], alias: "x", columns: ["p"] },
        right: { kind: "table", name: ["b"], alias: "y", columns: ["q"] },
        on: null,
        using: ["p"],
      },
    ]);
    // FROM items reach DELETE … USING, CTE bodies and set-op arms through the
    // same rule.
    expect((firstStmt("DELETE FROM t USING u AS x (b) WHERE t.a = x.b;") as any).using).toEqual([
      { kind: "table", name: ["u"], alias: "x", columns: ["b"] },
    ]);
    expect((firstStmt("WITH c AS (SELECT * FROM t x (a)) SELECT 1;") as any).with_[0].query.from).toEqual([
      { kind: "table", name: ["t"], alias: "x", columns: ["a"] },
    ]);
    expect((firstStmt("SELECT 1 UNION SELECT * FROM u y (b);") as any).right.from).toEqual([
      { kind: "table", name: ["u"], alias: "y", columns: ["b"] },
    ]);
  });

  it("parses ONLY on a bare, qualified or parenthesised table name", () => {
    expect(from("SELECT * FROM ONLY t;")).toEqual([{ kind: "table", only: true, name: ["t"], alias: null }]);
    expect(from("SELECT * FROM ONLY s.t AS x (a);")).toEqual([
      { kind: "table", only: true, name: ["s", "t"], alias: "x", columns: ["a"] },
    ]);
    // PG's `relation_expr` also admits `ONLY (name)`; the parentheses are not
    // recorded, as they change nothing.
    expect(from("SELECT * FROM ONLY (t) x;")).toEqual([{ kind: "table", only: true, name: ["t"], alias: "x" }]);
    expect(from("SELECT * FROM a JOIN ONLY b ON true;")[0].right).toEqual({
      kind: "table",
      only: true,
      name: ["b"],
      alias: null,
    });
    expect((firstStmt("UPDATE t SET a = 1 FROM ONLY u WHERE t.a = u.a;") as any).from).toEqual([
      { kind: "table", only: true, name: ["u"], alias: null },
    ]);
  });

  it("omits `columns` and `only` when neither is written", () => {
    // Both are spread in only when present, so every pre-existing FROM item —
    // and its row in the parity golden — keeps its shape.
    for (const item of [
      ...from("SELECT * FROM t x TABLESAMPLE system (1);"),
      ...from("SELECT * FROM (SELECT 1) s;"),
      ...from("SELECT * FROM f(1) g;"),
    ]) {
      expect("columns" in item).toBe(false);
      expect("only" in item).toBe(false);
    }
  });

  it("still reads a bare `t (a, b)` as a table-function call", () => {
    // With no alias ahead of it, the list would be indistinguishable from a
    // call's argument list — and PG resolves it the same way, as a call to `t`.
    expect(from("SELECT * FROM t (a, b);")).toEqual([
      { kind: "function", call: call("t", [name("a"), name("b")]), alias: null },
    ]);
  });

  it("keeps a nested-paren FROM subquery a subquery", () => {
    // A `(` that opens a FROM item stays a query however deeply it nests, and
    // the alias clause — list included — follows the outermost `)`.
    expect(from("SELECT * FROM ((SELECT 1) UNION (SELECT 2)) x;")).toEqual([
      {
        kind: "subquery",
        query: {
          kind: "setOp",
          op: "union",
          left: sel({ columns: [col(num(1))] }),
          right: sel({ columns: [col(num(2))] }),
        },
        alias: "x",
      },
    ]);
    expect(from("SELECT * FROM ((SELECT 1)) x;")).toEqual([
      { kind: "subquery", query: sel({ columns: [col(num(1))] }), alias: "x" },
    ]);
    expect(from("SELECT * FROM ((SELECT 1)) x (a);")).toEqual([
      { kind: "subquery", query: sel({ columns: [col(num(1))] }), alias: "x", columns: ["a"] },
    ]);
  });

  it("takes no name away: `only` was already reserved", () => {
    // ONLY is matched by value, and it was in RESERVED long before this rule
    // existed — so it was never usable as a bare name or alias. Quoted, it is a
    // name exactly as before.
    expect(from('SELECT * FROM "only";')).toEqual([tableFrom(["only"])]);
    expect(from('SELECT * FROM t AS "only" ("only");')).toEqual([
      { kind: "table", name: ["t"], alias: "only", columns: ["only"] },
    ]);
    expect(() => sqlLite.parse("SELECT * FROM t only;")).toThrow(/Expected ";" but found "only"/);
  });

  it("rejects an empty or malformed alias list and a misplaced or malformed ONLY", () => {
    // PG's list names at least one column.
    expect(() => sqlLite.parse("SELECT * FROM t x ();")).toThrow(/Expected a name but found "\)"/);
    expect(() => sqlLite.parse("SELECT * FROM t x (a,);")).toThrow(/Expected a name but found "\)"/);
    expect(() => sqlLite.parse("SELECT * FROM t x (a b);")).toThrow(/Expected "\)" but found "b"/);
    expect(() => sqlLite.parse("SELECT * FROM t x (a) (b);")).toThrow(/but found "\("/);
    // The list needs an alias ahead of it on a subquery too, and comes before
    // TABLESAMPLE, never after it.
    expect(() => sqlLite.parse("SELECT * FROM (SELECT 1) (a);")).toThrow(/but found "\("/);
    expect(() => sqlLite.parse("SELECT * FROM t TABLESAMPLE system (1) x (a);")).toThrow(/but found "x"/);
    // A function's typed column-definition list is out of scope: it is not a
    // name list, so the type word is where it stops.
    expect(() => sqlLite.parse("SELECT * FROM f() AS g (n int);")).toThrow(/Expected "\)" but found "int"/);
    // ONLY takes a table name — not a subquery, a function or nothing at all —
    // and cannot follow LATERAL.
    expect(() => sqlLite.parse("SELECT * FROM ONLY;")).toThrow(/Expected a name but found ";"/);
    expect(() => sqlLite.parse("SELECT * FROM ONLY (SELECT 1) s;")).toThrow(/Expected a name but found "select"/);
    expect(() => sqlLite.parse("SELECT * FROM ONLY f(1);")).toThrow(/but found "\("/);
    expect(() => sqlLite.parse("SELECT * FROM ONLY (t x);")).toThrow(/Expected "\)" but found "x"/);
    expect(() => sqlLite.parse("SELECT * FROM LATERAL ONLY t;")).toThrow(/Expected a name but found "only"/);
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

// --- SELECT INTO & GROUP BY modifiers ---

describe("SQL-lite SELECT INTO and GROUP BY modifiers", () => {
  const stmt = (src: string) => firstStmt(src) as any;
  const groupBy = (src: string) => stmt(`SELECT a FROM t GROUP BY ${src};`).groupBy;
  const into = (src: string) => stmt(src).into;

  it("parses SELECT … INTO, with the optional TABLE noise word and a qualified target", () => {
    expect(stmt("SELECT a INTO newtab FROM t;")).toEqual(
      sel({ columns: [col(name("a"))], into: { name: ["newtab"] }, from: [tableFrom(["t"])] }),
    );
    expect(into("SELECT a INTO TABLE reports.newtab FROM t;")).toEqual({ name: ["reports", "newtab"] });
    // The clause does not require a FROM after it.
    expect(into("SELECT 1 INTO newtab;")).toEqual({ name: ["newtab"] });
  });

  it("parses the storage words PG allows between INTO and the target", () => {
    expect(into("SELECT a INTO TEMP scratch FROM t;")).toEqual({ name: ["scratch"], modifiers: ["temp"] });
    expect(into("SELECT a INTO UNLOGGED TABLE scratch FROM t;")).toEqual({
      name: ["scratch"],
      modifiers: ["unlogged"],
    });
    // `global`/`local` are legal only ahead of a temp word, and are kept in
    // source order alongside it.
    expect(into("SELECT a INTO GLOBAL TEMPORARY scratch FROM t;")).toEqual({
      name: ["scratch"],
      modifiers: ["global", "temporary"],
    });
    expect(into("SELECT a INTO LOCAL TEMP TABLE scratch FROM t;")).toEqual({
      name: ["scratch"],
      modifiers: ["local", "temp"],
    });
    // `modifiers` follows the same omit-when-absent rule as `into` itself.
    expect("modifiers" in into("SELECT a INTO scratch FROM t;")).toBe(false);
  });

  it("keeps the storage words usable as target names", () => {
    // None of them is reserved, so each is a modifier only when a name can
    // still follow it. Here nothing can — a reserved clause word or the
    // terminator follows — and the word is the target itself.
    for (const word of ["temp", "temporary", "unlogged", "global", "local"]) {
      expect(into(`SELECT a INTO ${word} FROM t;`)).toEqual({ name: [word] });
    }
    expect(into("SELECT a INTO temp;")).toEqual({ name: ["temp"] });
    // A schema called `temp` survives too: `.` cannot start a target name.
    expect(into("SELECT a INTO temp.scratch FROM t;")).toEqual({ name: ["temp", "scratch"] });
    // …and all five remain ordinary column names elsewhere.
    expect(stmt("SELECT temp, temporary, unlogged, global, local FROM t;").columns).toEqual([
      col(name("temp")),
      col(name("temporary")),
      col(name("unlogged")),
      col(name("global")),
      col(name("local")),
    ]);
  });

  it("omits `into` entirely when there is no INTO clause", () => {
    // A required `into: null` would add a key to every SELECT node in the
    // parity golden; the field is spread in only when the clause is written.
    expect("into" in stmt("SELECT a FROM t;")).toBe(false);
  });

  it("records GROUP BY DISTINCT and treats an explicit ALL as the default", () => {
    expect(stmt("SELECT a FROM t GROUP BY DISTINCT a, b;")).toEqual(
      sel({
        columns: [col(name("a"))],
        from: [tableFrom(["t"])],
        groupBy: [name("a"), name("b")],
        groupByDistinct: true,
      }),
    );
    // ALL is the no-op spelling of the default, exactly as `SELECT ALL` is, so
    // it records nothing and the key stays off the node.
    const all = stmt("SELECT a FROM t GROUP BY ALL a;");
    expect(all.groupBy).toEqual([name("a")]);
    expect("groupByDistinct" in all).toBe(false);
    // The modifier applies to grouping elements too, not just bare expressions.
    expect(stmt("SELECT a FROM t GROUP BY DISTINCT ROLLUP (a);").groupBy).toEqual([
      { kind: "rollup", args: [[name("a")]] },
    ]);
  });

  it("parses the empty grouping `()` as a GROUP BY item", () => {
    expect(groupBy("()")).toEqual([{ kind: "emptyGrouping" }]);
    expect(groupBy("a, ()")).toEqual([name("a"), { kind: "emptyGrouping" }]);
    // Whitespace between the parens is not a token, so this is the same item.
    expect(groupBy("(  )")).toEqual([{ kind: "emptyGrouping" }]);
    // A parenthesised expression is untouched: only the empty pair is claimed,
    // and an empty pair nested inside one is not an item of its own.
    expect(groupBy("(a)")).toEqual([name("a")]);
    expect(() => sqlLite.parse("SELECT a FROM t GROUP BY (());")).toThrow(ParseError);
    // Inside GROUPING SETS the empty grouping stays an empty element list.
    expect(groupBy("GROUPING SETS (())")).toEqual([{ kind: "groupingSets", sets: [[]] }]);
  });

  it("takes no name away: the clause keywords were already reserved", () => {
    // `into`, `table`, `distinct` and `all` are all matched by value here, and
    // all four were already in RESERVED — so, unlike the storage words above,
    // none of them was usable as a bare name before this clause existed.
    // Quoted, they are names as they always were.
    expect(stmt('SELECT "into", "distinct", "all" FROM t;').columns).toEqual([
      col(name("into")),
      col(name("distinct")),
      col(name("all")),
    ]);
    // A quoted `"table"` lexes as a qident, which the ident-only noise word can
    // never match, so it is the target name rather than a word being skipped.
    expect(into('SELECT 1 INTO "table";')).toEqual({ name: ["table"] });
  });

  it("rejects the storage-word shapes PG's OptTempTableName has no rule for", () => {
    // `global`/`local` alone, a repeated word, and two storage words together
    // are all syntax errors in PG. Each is rejected here because the surplus
    // word has nowhere to go once the shape ahead of it has been consumed — as
    // a target name for the scope-word cases, as modifier-plus-target for the
    // repeated and doubled ones.
    expect(() => sqlLite.parse("SELECT a INTO GLOBAL scratch FROM t;")).toThrow(/but found "scratch"/);
    expect(() => sqlLite.parse("SELECT a INTO LOCAL scratch FROM t;")).toThrow(/but found "scratch"/);
    expect(() => sqlLite.parse("SELECT a INTO GLOBAL TEMP FROM t;")).toThrow(/but found "temp"/);
    expect(() => sqlLite.parse("SELECT a INTO TEMP TEMP scratch FROM t;")).toThrow(/but found "scratch"/);
    expect(() => sqlLite.parse("SELECT a INTO UNLOGGED TEMP scratch FROM t;")).toThrow(/but found "scratch"/);
  });

  it("rejects a missing INTO target, a bare GROUP BY modifier and a malformed grouping", () => {
    expect(() => sqlLite.parse("SELECT a INTO FROM t;")).toThrow(/Expected a name but found "from"/);
    expect(() => sqlLite.parse("SELECT a FROM t GROUP BY DISTINCT;")).toThrow(/but found ";"/);
    expect(() => sqlLite.parse("SELECT a FROM t GROUP BY (,);")).toThrow(ParseError);
  });
});

// --- ORDER BY USING & window frame EXCLUDE ---

describe("SQL-lite ORDER BY USING and window frame EXCLUDE", () => {
  const stmt = (src: string) => firstStmt(src) as any;
  const orderBy = (src: string) => stmt(`SELECT a FROM t ORDER BY ${src};`).orderBy;
  const frame = (src: string) => stmt(`SELECT sum(x) OVER (${src}) FROM t;`).columns[0].expr.frame;
  const order = (expr: unknown, dir: string | null = null, nulls: string | null = null) => ({ expr, dir, nulls });
  const using = (expr: unknown, op: string, nulls: string | null = null) => ({ expr, dir: null, using: op, nulls });

  it("parses ORDER BY … USING op in place of ASC/DESC", () => {
    expect(stmt("SELECT a FROM t ORDER BY a USING <;")).toEqual(
      sel({ columns: [col(name("a"))], from: [tableFrom(["t"])], orderBy: [using(name("a"), "<")] }),
    );
    // NULLS still follows, and a USING item mixes freely with plain ones.
    expect(orderBy("a USING > NULLS FIRST, b DESC")).toEqual([
      using(name("a"), ">", "first"),
      order(name("b"), "desc"),
    ]);
    // Any operator token is a sort operator, not just the comparison ones.
    expect(orderBy("a USING ~<~")).toEqual([using(name("a"), "~<~")]);
  });

  it("takes USING wherever an ORDER BY list is, and omits the key otherwise", () => {
    // Every sort list shares `orderItem`: aggregate, WITHIN GROUP and window.
    expect(stmt("SELECT array_agg(a ORDER BY b USING >) FROM t;").columns[0].expr.orderBy).toEqual([
      using(name("b"), ">"),
    ]);
    expect(stmt("SELECT rank() OVER (ORDER BY b USING <) FROM t;").columns[0].expr.orderBy).toEqual([
      using(name("b"), "<"),
    ]);
    expect(
      stmt("SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY b USING <) FROM t;").columns[0].expr.orderBy,
    ).toEqual([using(name("b"), "<")]);
    // Omit-when-absent: a plain item keeps exactly its three keys, so the AST
    // golden's existing ORDER BY rows do not move.
    expect(Object.keys(orderBy("a DESC")[0])).toEqual(["expr", "dir", "nulls"]);
  });

  it("parses a frame EXCLUDE clause after either frame shape", () => {
    expect(frame("ORDER BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING EXCLUDE CURRENT ROW")).toEqual({
      mode: "rows",
      start: { kind: "preceding", offset: num(1) },
      end: { kind: "following", offset: num(1) },
      exclude: "currentRow",
    });
    // The single-bound shorthand takes it too, and so does every mode.
    expect(frame("GROUPS 1 PRECEDING EXCLUDE GROUP")).toEqual({
      mode: "groups",
      start: { kind: "preceding", offset: num(1) },
      end: null,
      exclude: "group",
    });
    expect(frame("RANGE CURRENT ROW EXCLUDE TIES").exclude).toBe("ties");
    // NO OTHERS is the default spelled out; it is recorded, not dropped, so the
    // AST still tells it apart from a frame with no EXCLUDE at all.
    expect(frame("ROWS UNBOUNDED PRECEDING EXCLUDE NO OTHERS").exclude).toBe("noOthers");
    expect("exclude" in frame("ROWS UNBOUNDED PRECEDING")).toBe(false);
    // `parseFrame` is shared, so a named WINDOW definition takes it too.
    expect(
      stmt("SELECT rank() OVER w FROM t WINDOW w AS (ROWS 1 PRECEDING EXCLUDE TIES);").window[0].spec.frame,
    ).toEqual({
      mode: "rows",
      start: { kind: "preceding", offset: num(1) },
      end: null,
      exclude: "ties",
    });
  });

  it("keeps exclude / ties / others / no unreserved as names and aliases", () => {
    expect(stmt("SELECT exclude, ties, others, no FROM t;").columns).toEqual([
      col(name("exclude")),
      col(name("ties")),
      col(name("others")),
      col(name("no")),
    ]);
    expect(stmt("SELECT a exclude, b ties FROM t;").columns).toEqual([
      col(name("a"), "exclude"),
      col(name("b"), "ties"),
    ]);
    expect(stmt("CREATE TABLE t (exclude int, ties text);").items.map((i: any) => i.name)).toEqual(["exclude", "ties"]);
    // A frame offset is a full expression, so a column named `exclude` still
    // works there: EXCLUDE is only claimed once a bound has been completed.
    expect(frame("ROWS exclude PRECEDING")).toEqual({
      mode: "rows",
      start: { kind: "preceding", offset: name("exclude") },
      end: null,
    });
    // `using` and `group` are reserved — matched by value here, and never
    // usable as bare names — so quoted they stay names, as they always were.
    expect(stmt('SELECT "using", "group" FROM t;').columns).toEqual([col(name("using")), col(name("group"))]);
  });

  it("rejects USING with a direction or a non-operator, and EXCLUDE malformed or outside a frame", () => {
    // PG's sortby takes ASC/DESC *or* USING, never both.
    expect(() => sqlLite.parse("SELECT a FROM t ORDER BY a USING < DESC;")).toThrow(/Expected ";" but found "desc"/);
    expect(() => sqlLite.parse("SELECT a FROM t ORDER BY a USING b;")).toThrow(/Expected an operator but found "b"/);
    // `=>` is PG's named-argument token, not an operator, so it is no sort operator.
    expect(() => sqlLite.parse("SELECT a FROM t ORDER BY a USING =>;")).toThrow(/Expected an operator but found "=>"/);
    // PG's `OPERATOR(schema.op)` spelling is out of scope, as it is everywhere else here.
    expect(() => sqlLite.parse("SELECT a FROM t ORDER BY a USING OPERATOR(pg_catalog.<);")).toThrow(
      /Expected an operator but found "operator"/,
    );
    expect(() => sqlLite.parse("SELECT sum(x) OVER (ROWS 1 PRECEDING EXCLUDE) FROM t;")).toThrow(
      /Expected "current row" or "group" or "ties" or "no others" but found "\)"/,
    );
    expect(() => sqlLite.parse("SELECT sum(x) OVER (ROWS 1 PRECEDING EXCLUDE NO) FROM t;")).toThrow(
      /Expected "others" but found "\)"/,
    );
    // EXCLUDE belongs to the frame clause, so without one it has nowhere to go.
    expect(() => sqlLite.parse("SELECT sum(x) OVER (ORDER BY id EXCLUDE TIES) FROM t;")).toThrow(
      /Expected "\)" but found "exclude"/,
    );
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
    // DISTINCT inside an aggregate is recorded on the call node itself; the
    // modifiers have their own suite below.
    expect(cols("SELECT count(distinct x) FROM t;")).toEqual([
      col({ kind: "call", name: "count", args: [name("x")], distinct: true }),
    ]);
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

// --- CTE materialization, SEARCH and CYCLE ---

describe("SQL-lite CTE materialization, SEARCH and CYCLE", () => {
  const ctes = (src: string) => (firstStmt(src) as any).with_;
  // The CTE node for `WITH RECURSIVE t AS (SELECT 1) <tail> SELECT 1;`.
  const tailed = (tail: string) => ctes(`WITH RECURSIVE t AS (SELECT 1) ${tail} SELECT 1;`)[0];
  const one = sel({ columns: [col(num(1))] });

  it("parses AS MATERIALIZED and AS NOT MATERIALIZED", () => {
    expect(firstStmt("WITH a AS MATERIALIZED (SELECT 1) SELECT * FROM a;")).toEqual(
      sel({
        with_: [{ name: "a", columns: null, materialized: true, query: one }],
        columns: [col(star())],
        from: [tableFrom(["a"])],
      }),
    );
    expect(ctes("WITH a (x) AS NOT MATERIALIZED (SELECT 1) SELECT 1;")).toEqual([
      { name: "a", columns: ["x"], materialized: false, query: one },
    ]);
    // Each CTE in the list carries its own setting.
    expect(
      ctes("WITH a AS MATERIALIZED (SELECT 1), b AS (SELECT 1), c AS NOT MATERIALIZED (SELECT 1) SELECT 1;").map(
        (c: any) => c.materialized,
      ),
    ).toEqual([true, undefined, false]);
    // A data-modifying body takes the setting too.
    expect(ctes("WITH d AS MATERIALIZED (DELETE FROM t RETURNING id) SELECT 1;")[0]).toMatchObject({
      name: "d",
      materialized: true,
      query: { kind: "delete", table: ["t"] },
    });
  });

  it("parses SEARCH DEPTH / BREADTH FIRST", () => {
    expect(tailed("SEARCH DEPTH FIRST BY id SET ord")).toEqual({
      name: "t",
      columns: null,
      query: one,
      search: { order: "depth", by: ["id"], set: "ord" },
    });
    expect(tailed("SEARCH BREADTH FIRST BY a, b SET ord").search).toEqual({
      order: "breadth",
      by: ["a", "b"],
      set: "ord",
    });
  });

  it("parses CYCLE with and without the TO / DEFAULT mark values", () => {
    expect(tailed("CYCLE id SET is_cycle USING path")).toEqual({
      name: "t",
      columns: null,
      query: one,
      cycle: { columns: ["id"], set: "is_cycle", mark: null, using: "path" },
    });
    expect(tailed("CYCLE a, b SET is_cycle TO 'Y' DEFAULT 'N' USING path").cycle).toEqual({
      columns: ["a", "b"],
      set: "is_cycle",
      mark: { to: str("Y"), default: str("N") },
      using: "path",
    });
    // Any literal will do for a mark value: numbers, booleans, NULL.
    expect(tailed("CYCLE a SET c TO 1 DEFAULT 0 USING p").cycle.mark).toEqual({ to: num(1), default: num(0) });
    expect(tailed("CYCLE a SET c TO true DEFAULT null USING p").cycle.mark).toEqual({
      to: { kind: "bool", value: true },
      default: { kind: "null" },
    });
  });

  it("parses all three together, in PG's order, ahead of another CTE", () => {
    const [t, u] = ctes(
      "WITH RECURSIVE t (id) AS NOT MATERIALIZED (SELECT 1) SEARCH DEPTH FIRST BY id SET ord " +
        "CYCLE id SET is_cycle USING path, u AS (SELECT 2) SELECT * FROM t;",
    );
    expect(t).toEqual({
      name: "t",
      columns: ["id"],
      materialized: false,
      query: one,
      search: { order: "depth", by: ["id"], set: "ord" },
      cycle: { columns: ["id"], set: "is_cycle", mark: null, using: "path" },
    });
    expect(u).toEqual({ name: "u", columns: null, query: sel({ columns: [col(num(2))] }) });
    // The clauses ride on a CTE that leads DML just as well.
    expect(firstStmt("WITH RECURSIVE t AS (SELECT 1) CYCLE id SET c USING p DELETE FROM x;").with_[0].cycle).toEqual({
      columns: ["id"],
      set: "c",
      mark: null,
      using: "p",
    });
  });

  it("records SEARCH / CYCLE on a non-recursive CTE, as PG's grammar does", () => {
    // PG rejects the clauses on a CTE that is not actually recursive in parse
    // analysis, not in the grammar, so — like SELECT INTO — they are recorded
    // wherever written. (The fixtures above are grammar-only for the same reason.)
    expect(firstStmt("WITH t AS (SELECT 1) SEARCH DEPTH FIRST BY id SET ord SELECT 1;")).toMatchObject({
      recursive: false,
      with_: [{ name: "t", search: { order: "depth", by: ["id"], set: "ord" } }],
    });
  });

  it("omits all three keys when none of the clauses is written", () => {
    const [plain] = ctes("WITH a AS (SELECT 1) SELECT 1;");
    expect(Object.keys(plain)).toEqual(["name", "columns", "query"]);
  });

  it("keeps every new keyword usable as a name", () => {
    // None of `materialized`, `search`, `cycle`, `depth`, `breadth` or `first`
    // is reserved: inside a CTE each is matched by value only within its own
    // clause (after AS, or after the body's `)` and `search`), where no name
    // could stand before.
    const words = ["materialized", "search", "cycle", "depth", "breadth", "first"];
    expect((firstStmt(`SELECT ${words.join(", ")} FROM t;`) as any).columns).toEqual(words.map((w) => col(name(w))));
    for (const word of words) {
      expect(ctes(`WITH ${word} AS (SELECT 1) SELECT * FROM ${word};`)).toEqual([
        { name: word, columns: null, query: one },
      ]);
    }
    // …including as the column names inside the clauses themselves.
    expect(tailed("SEARCH DEPTH FIRST BY search, first SET depth CYCLE cycle SET breadth USING materialized")).toEqual({
      name: "t",
      columns: null,
      query: one,
      search: { order: "depth", by: ["search", "first"], set: "depth" },
      cycle: { columns: ["cycle"], set: "breadth", mark: null, using: "materialized" },
    });
    // A CTE called `materialized` may itself be materialized.
    expect(ctes("WITH materialized AS MATERIALIZED (SELECT 1) SELECT 1;")[0]).toMatchObject({
      name: "materialized",
      materialized: true,
    });
  });

  it("rejects malformed materialization, SEARCH and CYCLE clauses", () => {
    expect(() => sqlLite.parse("WITH a AS NOT (SELECT 1) SELECT 1;")).toThrow(/Expected "materialized" but found "\("/);
    expect(() => sqlLite.parse("WITH a AS (SELECT 1) SEARCH FIRST BY id SET o SELECT 1;")).toThrow(
      /Expected "depth" or "breadth" but found "first"/,
    );
    expect(() => sqlLite.parse("WITH a AS (SELECT 1) SEARCH DEPTH BY id SET o SELECT 1;")).toThrow(
      /Expected "first by"/,
    );
    expect(() => sqlLite.parse("WITH a AS (SELECT 1) SEARCH DEPTH FIRST BY id SELECT 1;")).toThrow(
      /Expected "set" but found "select"/,
    );
    // TO without DEFAULT, a missing USING, and a non-constant mark value.
    expect(() => sqlLite.parse("WITH a AS (SELECT 1) CYCLE id SET c TO 1 USING p SELECT 1;")).toThrow(
      /Expected "default" but found "using"/,
    );
    expect(() => sqlLite.parse("WITH a AS (SELECT 1) CYCLE id SET c SELECT 1;")).toThrow(
      /Expected "using" but found "select"/,
    );
    expect(() => sqlLite.parse("WITH a AS (SELECT 1) CYCLE id SET c TO x DEFAULT 0 USING p SELECT 1;")).toThrow(
      /Expected a constant but found "x"/,
    );
    // PG's order is SEARCH then CYCLE; the reverse leaves SEARCH where the
    // statement should start.
    expect(() =>
      sqlLite.parse("WITH a AS (SELECT 1) CYCLE id SET c USING p SEARCH DEPTH FIRST BY id SET o SELECT 1;"),
    ).toThrow(ParseError);
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

// --- Phase 9: GRANT / REVOKE ---

describe("SQL-lite GRANT / REVOKE", () => {
  it("parses an object grant with a column-scoped privilege and WITH GRANT OPTION", () => {
    expect(firstStmt("GRANT SELECT, UPDATE (a, b) ON TABLE t1, t2 TO alice, bob WITH GRANT OPTION;")).toEqual({
      kind: "grant",
      privileges: [
        { name: "select", columns: null },
        { name: "update", columns: ["a", "b"] },
      ],
      on: { objectType: "table", names: [["t1"], ["t2"]], inSchema: null },
      grantees: ["alice", "bob"],
      withGrantOption: true,
    });
  });

  it("parses ALL PRIVILEGES and PUBLIC (object type defaulting to table)", () => {
    expect(firstStmt("GRANT ALL PRIVILEGES ON s.t TO PUBLIC;")).toEqual({
      kind: "grant",
      privileges: "all",
      on: { objectType: "table", names: [["s", "t"]], inSchema: null },
      grantees: ["public"],
      withGrantOption: false,
    });
  });

  it("parses a role grant (no ON) with WITH ADMIN OPTION", () => {
    expect(firstStmt("GRANT admin TO joe WITH ADMIN OPTION;")).toEqual({
      kind: "grant",
      privileges: [{ name: "admin", columns: null }],
      on: null,
      grantees: ["joe"],
      withGrantOption: true,
    });
  });

  it("parses ALL SEQUENCES IN SCHEMA and USAGE", () => {
    expect(firstStmt("GRANT USAGE ON ALL SEQUENCES IN SCHEMA s TO r;")).toEqual({
      kind: "grant",
      privileges: [{ name: "usage", columns: null }],
      on: { objectType: "sequence", names: [], inSchema: [["s"]] },
      grantees: ["r"],
      withGrantOption: false,
    });
  });

  it("parses REVOKE GRANT OPTION FOR ... FROM ... CASCADE", () => {
    expect(firstStmt("REVOKE GRANT OPTION FOR SELECT ON t FROM alice CASCADE;")).toEqual({
      kind: "revoke",
      grantOptionFor: true,
      privileges: [{ name: "select", columns: null }],
      on: { objectType: "table", names: [["t"]], inSchema: null },
      grantees: ["alice"],
      behavior: "cascade",
    });
  });

  it("throws a descriptive error when the TO grantee list is missing", () => {
    expect(() => sqlLite.parse("GRANT SELECT ON t;")).toThrow(ParseError);
  });
});

// --- Phase 9: transaction control ---

describe("SQL-lite transaction control", () => {
  it("parses BEGIN (with optional WORK) and its lack of modes", () => {
    expect(firstStmt("BEGIN WORK;")).toEqual({ kind: "begin", start: false, modes: [] });
  });

  it("parses START TRANSACTION with isolation + access modes", () => {
    expect(firstStmt("START TRANSACTION ISOLATION LEVEL SERIALIZABLE, READ WRITE;")).toEqual({
      kind: "begin",
      start: true,
      modes: [
        { kind: "isolation", level: "serializable" },
        { kind: "readWrite", value: true },
      ],
    });
    // Multi-word levels and NOT DEFERRABLE, commas optional between modes.
    expect((firstStmt("START TRANSACTION ISOLATION LEVEL REPEATABLE READ NOT DEFERRABLE;") as any).modes).toEqual([
      { kind: "isolation", level: "repeatableRead" },
      { kind: "deferrable", value: false },
    ]);
  });

  it("parses COMMIT AND CHAIN, ROLLBACK TO SAVEPOINT, SAVEPOINT and RELEASE", () => {
    expect(firstStmt("COMMIT AND CHAIN;")).toEqual({ kind: "commit", chain: true });
    expect(firstStmt("ROLLBACK;")).toEqual({ kind: "rollback", chain: false, savepoint: null });
    expect(firstStmt("ROLLBACK TO SAVEPOINT sp1;")).toEqual({ kind: "rollback", chain: false, savepoint: "sp1" });
    expect(firstStmt("SAVEPOINT sp1;")).toEqual({ kind: "savepoint", name: "sp1" });
    expect(firstStmt("RELEASE sp1;")).toEqual({ kind: "releaseSavepoint", name: "sp1" });
  });
});

// --- Phase 9: SET / SHOW / RESET ---

describe("SQL-lite SET / SHOW / RESET", () => {
  it("parses a generic SET with a value list and TO separator", () => {
    expect(firstStmt("SET search_path TO my_schema, public;")).toEqual({
      kind: "set",
      scope: null,
      name: "search_path",
      values: [name("my_schema"), name("public")],
    });
  });

  it("parses SET x = DEFAULT and the operator-less special forms", () => {
    expect(firstStmt("SET my.guc = DEFAULT;")).toEqual({
      kind: "set",
      scope: null,
      name: "my.guc",
      values: "default",
    });
    expect(firstStmt("SET LOCAL TIME ZONE 'PST8PDT';")).toEqual({
      kind: "set",
      scope: "local",
      name: "time zone",
      values: [str("PST8PDT")],
    });
    expect(firstStmt("SET SESSION ROLE none;")).toEqual({
      kind: "set",
      scope: "session",
      name: "role",
      values: [name("none")],
    });
  });

  it("parses SHOW / RESET including their ALL forms", () => {
    expect(firstStmt("SHOW search_path;")).toEqual({ kind: "show", name: "search_path" });
    expect(firstStmt("SHOW ALL;")).toEqual({ kind: "show", name: "all" });
    expect(firstStmt("RESET ALL;")).toEqual({ kind: "reset", name: "all" });
  });
});

// --- Phase 9: DO / DEALLOCATE ---

describe("SQL-lite DO / DEALLOCATE", () => {
  it("parses a DO block with an opaque dollar-quoted body (LANGUAGE either side)", () => {
    expect(firstStmt("DO LANGUAGE plpgsql $$ BEGIN NULL; END $$;")).toEqual({
      kind: "do",
      language: "plpgsql",
      body: " BEGIN NULL; END ",
    });
    expect(firstStmt("DO $$ SELECT 1 $$ LANGUAGE sql;")).toEqual({
      kind: "do",
      language: "sql",
      body: " SELECT 1 ",
    });
  });

  it("parses DEALLOCATE name and DEALLOCATE ALL", () => {
    expect(firstStmt("DEALLOCATE PREPARE my_stmt;")).toEqual({ kind: "deallocate", name: "my_stmt" });
    expect(firstStmt("DEALLOCATE ALL;")).toEqual({ kind: "deallocate", name: null });
  });
});

// --- Phase 10: bit-string, hex-string and unicode-escape literals ---

describe("SQL-lite bit-string, hex-string and unicode-escape literals", () => {
  const colExpr = (src: string) => (firstStmt(`SELECT ${src} FROM t;`) as any).columns[0].expr;
  const columns = (src: string) => (firstStmt(src) as any).columns;
  const bits = (value: string, hex = false) => ({ kind: "bitString", value, hex });
  const ident = (value: string) => ({ type: "ident", value });

  it("lexes the three prefixed forms in either case", () => {
    expect(lex("B'1011' b'0' X'ff' x'AB'")).toEqual([
      { type: "bitstring", value: "1011" },
      { type: "bitstring", value: "0" },
      { type: "hexstring", value: "ff" },
      { type: "hexstring", value: "AB" },
    ]);
    // `u&` folds like the rest: a dispatch keyed on the uppercase spelling
    // would silently disable the lowercase form.
    expect(lex("u&'\\0041' U&'\\0042'")).toEqual([
      { type: "string", value: "A" },
      { type: "string", value: "B" },
    ]);
  });

  it("parses bit-string constants wherever an expression is accepted", () => {
    expect(colExpr("B'1011'")).toEqual(bits("1011"));
    expect(colExpr("X'ff'")).toEqual(bits("ff", true));
    // A zero-length bit string is legal in PG.
    expect(colExpr("B''")).toEqual(bits(""));
    // Not only the select list: DEFAULT takes the same expression rule.
    expect((firstStmt("CREATE TABLE t (flags bit DEFAULT B'1011');") as any).items[0].constraints).toEqual([
      { kind: "default", expr: bits("1011") },
    ]);
  });

  it("rejects a digit outside the literal's base", () => {
    expect(() => sqlLite.parse("SELECT B'12' FROM t;")).toThrow(/Invalid binary digit "2"/);
    expect(() => sqlLite.parse("SELECT X'gg' FROM t;")).toThrow(/Invalid hexadecimal digit "g"/);
    // A literal that never closed swallowed the rest of the input, so the base
    // check would blame its first stray character for a missing quote. It is
    // left to fail where an unterminated `'…'` fails: at the `;` never reached.
    expect(() => sqlLite.parse("SELECT B'101 FROM t;")).toThrow(/Expected ";"/);
    expect(() => sqlLite.parse("SELECT 'abc FROM t;")).toThrow(/Expected ";"/);
    // Closed by a later quote, though, it is a terminated literal and is checked.
    expect(() => sqlLite.parse("SELECT B'101 FROM t; SELECT 'x';")).toThrow(/Invalid binary digit " "/);
  });

  it("keeps b, x and u usable as names — a prefix only claims a quote right after it", () => {
    expect(lex("b x u")).toEqual([ident("b"), ident("x"), ident("u")]);
    expect(columns("SELECT b, x, u FROM t;")).toEqual([col(name("b")), col(name("x")), col(name("u"))]);
    expect((firstStmt("CREATE TABLE t (b int, x int, u int);") as any).items.map((item: any) => item.name)).toEqual([
      "b",
      "x",
      "u",
    ]);
    // Only `u&'` with nothing between the characters opens a unicode literal;
    // spaced out it is still an operator between a name and a string.
    expect(lex("u & 'x'")).toEqual([ident("u"), { type: "op", value: "&" }, { type: "string", value: "x" }]);
    // `U&"…"` — a unicode-escaped *identifier* — is out of scope and unclaimed.
    expect(lex('U&"MixedCase"')).toEqual([
      ident("u"),
      { type: "op", value: "&" },
      { type: "qident", value: "MixedCase" },
    ]);
  });

  it("decodes U&'…' into an ordinary string token", () => {
    expect(lex("U&'\\0041'")).toEqual([{ type: "string", value: "A" }]);
    expect(colExpr("U&'\\0041'")).toEqual(str("A"));
    // Both escape widths: `\XXXX` and `\+XXXXXX`.
    expect(colExpr("U&'d\\0061t\\+000061'")).toEqual(str("data"));
    // A doubled escape character stands for a literal one, and `''` still
    // doubles the way it does in any other single-quoted literal.
    expect(colExpr("U&'a\\\\b'")).toEqual(str("a\\b"));
    expect(colExpr("U&'it''s'")).toEqual(str("it's"));
    // A surrogate pair composes on its own — JS strings are UTF-16 — and so
    // does the same code point spelled directly.
    expect(colExpr("U&'\\D83D\\DE00'")).toEqual(str("😀"));
    expect(colExpr("U&'\\+01F600'")).toEqual(str("😀"));
    // Decoding in the lexer is what lets one stand anywhere a plain string
    // does — here an enum label, which is a `string` token, not an expression.
    expect(firstStmt("CREATE TYPE m AS ENUM (U&'\\0041');")).toMatchObject({ values: ["A"] });
    expect(firstStmt("COMMENT ON TABLE t IS U&'\\0041';")).toMatchObject({ comment: "A" });
    // The asymmetry is PG's: a bit string is a `bit` constant, not text, so it
    // reaches expression positions only. Widening these would diverge.
    expect(() => sqlLite.parse("CREATE TYPE m AS ENUM (B'1011');")).toThrow(/Expected a string/);
  });

  it("carries bit strings through the rest of the expression grammar", () => {
    // Being an `atom` at all is what does this: `atom` is the pratt operand
    // rule, so a bit string composes with the postfixes, the keyword operators
    // and every argument position for free. (Where it sits among `atom`'s
    // branches is irrelevant — the token types are disjoint.)
    expect(colExpr("B'1011'::bit")).toEqual({
      kind: "cast",
      expr: bits("1011"),
      type: { name: "bit", args: [], array: false },
    });
    expect(colExpr("a IN (B'1', X'f')")).toMatchObject({
      kind: "in",
      list: [bits("1"), bits("f", true)],
    });
    expect(colExpr("count(B'1')")).toMatchObject({ kind: "call", name: "count", args: [bits("1")] });
    // And through a statement that never touches the select list.
    expect((firstStmt("INSERT INTO t (a, b, c) VALUES (B'1011', X'ff', U&'\\0041');") as any).source).toMatchObject({
      rows: [[bits("1011"), bits("ff", true), str("A")]],
    });
  });

  it("honours a UESCAPE clause, which replaces the escape character", () => {
    expect(colExpr("U&'d!0061t!+000061' UESCAPE '!'")).toEqual(str("data"));
    // With one in force a backslash is an ordinary character again.
    expect(colExpr("U&'\\0041' UESCAPE '!'")).toEqual(str("\\0041"));
  });

  it("keeps uescape unreserved as a name and as an alias", () => {
    expect(columns("SELECT uescape FROM t;")).toEqual([col(name("uescape"))]);
    // The tail is a UESCAPE clause only when a quoted character follows it;
    // otherwise the word is an ordinary alias and `\` stays the escape.
    expect(columns("SELECT U&'\\0041' uescape FROM t;")).toEqual([col(str("A"), "uescape")]);
    expect(columns("SELECT U&'\\0041' AS uescape FROM t;")).toEqual([col(str("A"), "uescape")]);
  });

  it("rejects a malformed escape and an invalid escape character", () => {
    expect(() => sqlLite.parse("SELECT U&'\\00' FROM t;")).toThrow(/Invalid Unicode escape value/);
    expect(() => sqlLite.parse("SELECT U&'\\xyzw' FROM t;")).toThrow(/Invalid Unicode escape value/);
    // Past the last code point.
    expect(() => sqlLite.parse("SELECT U&'\\+FFFFFF' FROM t;")).toThrow(/Invalid Unicode escape value/);
    // Zero is not a valid escape value in PG, and an unpaired surrogate would
    // reach the AST as a JS string that is not valid Unicode text.
    expect(() => sqlLite.parse("SELECT U&'\\0000' FROM t;")).toThrow(/Invalid Unicode escape value/);
    expect(() => sqlLite.parse("SELECT U&'\\D83D' FROM t;")).toThrow(/Invalid Unicode surrogate pair/);
    expect(() => sqlLite.parse("SELECT U&'\\DE00' FROM t;")).toThrow(/Invalid Unicode surrogate pair/);
    // Both sides of the pairing test, and both places a pending high surrogate
    // can be interrupted: by a literal character, and by a doubled escape.
    expect(() => sqlLite.parse("SELECT U&'\\D83D\\D83D' FROM t;")).toThrow(/Invalid Unicode surrogate pair/);
    expect(() => sqlLite.parse("SELECT U&'\\D83Dx' FROM t;")).toThrow(/Invalid Unicode surrogate pair/);
    expect(() => sqlLite.parse("SELECT U&'\\D83D\\\\' FROM t;")).toThrow(/Invalid Unicode surrogate pair/);
    // A hex digit or a `+` would be ambiguous with the escape it introduces.
    expect(() => sqlLite.parse("SELECT U&'x' UESCAPE '5' FROM t;")).toThrow(/Invalid Unicode escape character/);
    expect(() => sqlLite.parse("SELECT U&'x' UESCAPE '+' FROM t;")).toThrow(/Invalid Unicode escape character/);
    expect(() => sqlLite.parse("SELECT U&'x' UESCAPE 'ab' FROM t;")).toThrow(/Invalid Unicode escape character/);
    // A truncated tail fails the same test: one legal character is not enough
    // without the quote that closes it, or it would silently re-point the
    // escape character of the literal in front of it.
    expect(() => sqlLite.parse("SELECT U&'\\0041' UESCAPE '!")).toThrow(/Invalid Unicode escape character/);
  });
});

// --- keyword dispatch maps ---
// The CREATE / ALTER / constraint rules derive their "Expected …" strings from
// keyword-keyed dispatch maps rather than restating them. What follows pins the
// parts of that no other test and neither golden covers. The comma-form croaks
// are already pinned — ALTER's action list above, the OR-REPLACE target list in
// the CREATE VIEW block — and stay there, one copy each, so that adding an
// action or a replaceable target is still a one-line test edit.

describe("SQL-lite keyword dispatch maps", () => {
  const rawFirst = (text: string) => sqlLite.parse(text)[0] as Record<string, any>;
  const call = (fnName: string, args: unknown[] = []) => ({ kind: "call", name: fnName, args });

  it("names the keyword-led CREATE targets in the join form", () => {
    expect(() => sqlLite.parse("CREATE frobnicate;")).toThrow(
      /Expected "table" or "unique" or "type" or "sequence" or "domain" or "database" or "schema" or "extension" or "tablespace" or "role" or "user" but found "frobnicate"/,
    );
  });

  it("names the table-item alternatives in the join form", () => {
    expect(() => sqlLite.parse("CREATE TABLE t (42 bad);")).toThrow(
      /Expected "constraint" or "primary key" or "unique" or "check" or "foreign key" or "like" or "exclude" or a name but found "42"/,
    );
  });

  // A record literal inherits `constructor` and `__proto__`, so a lead word
  // spelled like one must still miss the map rather than find a keyless entry.
  it("treats an Object.prototype key as an unknown lead word", () => {
    expect(() => sqlLite.parse("ALTER TABLE t constructor;")).toThrow(ParseError);
    expect(() => sqlLite.parse("ALTER TABLE t __proto__;")).toThrow(/Expected "add", "drop"/);
    expect(() => sqlLite.parse("CREATE constructor;")).toThrow(/Expected "table" or "unique"/);
    expect(() => sqlLite.parse("CREATE OR REPLACE __proto__;")).toThrow(/Expected "view", "materialized"/);
    expect(() => sqlLite.parse("CREATE TABLE t (id int, constructor text);")).not.toThrow();
    expect(() => sqlLite.parse("CREATE TABLE t (id int REFERENCES p ON DELETE constructor);")).toThrow(
      /Expected "no action" or "restrict"/,
    );
    // The same holds for the special-call and GRANT … ALL … IN SCHEMA records:
    // such a callee is an ordinary function, and such a word is not a plural.
    expect((firstStmt("SELECT constructor(1), __proto__(1) FROM t;") as any).columns).toEqual([
      col(call("constructor", [num(1)])),
      col(call("__proto__", [num(1)])),
    ]);
    expect(sqlLite.diagnose("SELECT __proto__(1) FROM t;").errors).toEqual([]);
    // Like the dispatch maps, the plural must also be a bare word: quoted, or a
    // string, it is no keyword.
    for (const plural of ["constructor", '"tables"', "'tables'"]) {
      expect(() => sqlLite.parse(`GRANT SELECT ON ALL ${plural} IN SCHEMA s TO u;`)).toThrow(
        /Expected a name but found "all"/,
      );
    }
    expect((firstStmt("GRANT SELECT ON ALL TABLES IN SCHEMA s TO u;") as any).on).toEqual({
      objectType: "table",
      names: [],
      inSchema: [["s"]],
    });
  });

  // stripSpans hides this everywhere else in the file: the keyword-led targets
  // open their span after CREATE, the OR-REPLACE-able bodies before it.
  it("opens a keyword-led CREATE span on its own keyword and an OR-REPLACE-able one on CREATE", () => {
    expect(rawFirst("CREATE TABLE t (id int);").span.start).toEqual({ row: 1, col: 7 });
    expect(rawFirst("CREATE UNIQUE INDEX i ON t (a);").span.start).toEqual({ row: 1, col: 7 });
    expect(rawFirst("CREATE VIEW v AS SELECT 1;").span.start).toEqual({ row: 1, col: 0 });
    expect(rawFirst("CREATE MATERIALIZED VIEW mv AS SELECT 1;").span.start).toEqual({ row: 1, col: 0 });
  });

  it("omits the CREATE prefix-modifier bag rather than emitting an empty one", () => {
    expect(rawFirst("CREATE TABLE t (id int);")).not.toHaveProperty("modifiers");
    expect(rawFirst("CREATE TABLE snap AS SELECT 1;")).not.toHaveProperty("modifiers");
  });
});

// --- multi-word type names ---

describe("SQL-lite multi-word type names", () => {
  const colType = (type: string) => (firstStmt(`CREATE TABLE t (c ${type});`) as any).items[0].dataType;
  const castType = (src: string) => (firstStmt(`SELECT ${src} FROM t;`) as any).columns[0].expr.type;
  const fnArgs = (signature: string) =>
    (firstStmt(`CREATE FUNCTION f(${signature}) RETURNS int LANGUAGE sql AS $$SELECT 1$$;`) as any).args;

  it("parses the PG types spelled with more than one word", () => {
    expect(colType("double precision")).toEqual(ct("double precision"));
    expect(colType("character varying(10)")).toEqual(ct("character varying", { args: [10] }));
    expect(colType("char varying(10)")).toEqual(ct("char varying", { args: [10] }));
    expect(colType("national character varying(8)")).toEqual(ct("national character varying", { args: [8] }));
    expect(colType("national character(8)")).toEqual(ct("national character", { args: [8] }));
    expect(colType("national char(8)")).toEqual(ct("national char", { args: [8] }));
    // Listed before the bare `national char`, so the greedy match takes the
    // longer spelling rather than choking on the leftover `varying`.
    expect(colType("national char varying(3)")).toEqual(ct("national char varying", { args: [3] }));
    expect(colType("bit varying(4)")).toEqual(ct("bit varying", { args: [4] }));
    expect(colType("timestamp with time zone")).toEqual(ct("timestamp with time zone"));
    expect(colType("timestamp without time zone")).toEqual(ct("timestamp without time zone"));
    expect(colType("time with time zone")).toEqual(ct("time with time zone"));
    expect(colType("interval day to second")).toEqual(ct("interval day to second"));
    expect(colType("interval year to month")).toEqual(ct("interval year to month"));
    expect(colType("interval hour")).toEqual(ct("interval hour"));
  });

  it("hoists a mid-name precision out into args", () => {
    // PG puts the precision inside the name; the node keeps the words together
    // and the args separate, never `{ name: "timestamp(3) with time zone" }`.
    expect(colType("timestamp(3) with time zone")).toEqual(ct("timestamp with time zone", { args: [3] }));
    expect(colType("time(6) without time zone")).toEqual(ct("time without time zone", { args: [6] }));
    expect(colType("interval day to second(3)")).toEqual(ct("interval day to second", { args: [3] }));
  });

  it("leaves the single-word, arg and array spellings alone", () => {
    expect(colType("int")).toEqual(ct("int"));
    expect(colType("numeric(10,2)[]")).toEqual(ct("numeric", { args: [10, 2], array: true }));
    expect(colType("double precision[]")).toEqual(ct("double precision", { array: true }));
    expect(colType("pg_catalog.numeric")).toEqual(ct("pg_catalog.numeric"));
  });

  it("casts to a multi-word type instead of aliasing the second word", () => {
    // `SELECT a::double precision FROM t` used to cast to `double` and read
    // `precision` as the column's alias.
    expect(castType("a::double precision")).toEqual(ct("double precision"));
    expect((firstStmt("SELECT a::double precision FROM t;") as any).columns[0].alias).toBeNull();
    expect(castType("a::timestamp(3) with time zone")).toEqual(ct("timestamp with time zone", { args: [3] }));
    // A trailing INTERVAL field now belongs to the type name, as it does in PG.
    expect(castType("x::interval day")).toEqual(ct("interval day"));
  });

  it("only extends a bare, unqualified lead word", () => {
    // A quoted lead is an ordinary name, so `precision` stays an alias.
    expect(firstStmt('SELECT a::"double" precision FROM t;')).toEqual(
      sel({
        columns: [{ expr: { kind: "cast", expr: name("a"), type: ct("double") }, alias: "precision" }],
        from: [tableFrom(["t"])],
      }),
    );
    // So is a dotted one.
    expect(firstStmt("SELECT x::public.interval day FROM t;")).toEqual(
      sel({
        columns: [{ expr: { kind: "cast", expr: name("x"), type: ct("public.interval") }, alias: "day" }],
        from: [tableFrom(["t"])],
      }),
    );
  });

  it("never half-consumes a tail it cannot complete", () => {
    // The whole continuation is checked by lookahead before a token is taken,
    // so a WITH that is not `WITH TIME ZONE` is left for the enclosing rule.
    const mv = firstStmt("CREATE MATERIALIZED VIEW mv AS SELECT now()::timestamp WITH NO DATA;") as any;
    expect(mv).toMatchObject({ kind: "createView", materialized: true, withData: false });
    // …and the type really stopped at `timestamp`, rather than the clause being
    // re-parsed from a half-consumed tail.
    expect(mv.query.columns[0].expr.type).toEqual(ct("timestamp"));
    expect(() => sqlLite.parse("CREATE TABLE t (c timestamp with zone);")).toThrow(/Expected "," but found "with"/);
    expect(() => sqlLite.parse("CREATE TABLE t (c interval to second);")).toThrow(/Expected "," but found "to"/);
  });

  it("fixes which side of the name the precision sits on", () => {
    // Only the datetime types spell it before the tail, so a mid-name list is
    // the syntax error PG reports rather than a silently accepted spelling.
    expect(() => sqlLite.parse("CREATE TABLE t (c character(10) varying);")).toThrow(
      /Expected "," but found "varying"/,
    );
    expect(() => sqlLite.parse("CREATE TABLE t (c interval(3) day);")).toThrow(/Expected "," but found "day"/);
    // A lead with no tail still takes its ordinary trailing list.
    expect(colType("timestamp(3)")).toEqual(ct("timestamp", { args: [3] }));
    expect(colType("interval(3)")).toEqual(ct("interval", { args: [3] }));
    // What is *not* checked is whether the type takes a precision at all — PG
    // rejects all three of these, and so does no type in this grammar: the
    // single-word `text(5)` is equally lenient, on main and here.
    expect(colType("double precision(10)")).toEqual(ct("double precision", { args: [10] }));
    expect(colType("timestamp with time zone(3)")).toEqual(ct("timestamp with time zone", { args: [3] }));
    expect(colType("text(5)")).toEqual(ct("text", { args: [5] }));
  });

  it("treats a type name that collides with Object.prototype as an ordinary name", () => {
    // Identifiers fold to lowercase, so these reach the tail lookup verbatim. An
    // object literal keyed by lead word would hand back an inherited value here.
    expect(colType("constructor")).toEqual(ct("constructor"));
    expect(colType("__proto__")).toEqual(ct("__proto__"));
    expect(castType("x::constructor")).toEqual(ct("constructor"));
    // And `diagnose` must still collect rather than throw.
    expect(sqlLite.diagnose("CREATE TABLE t (c constructor);").errors).toEqual([]);
  });

  it("rethrows a lex error raised inside the tail lookahead", () => {
    // Filling the lookahead buffer consumes the offending character, so the
    // error cannot simply be discarded with the failed candidate: `interval day`
    // is a complete tail, and the rest of the statement parses, so nothing else
    // would ever report it. Under `parse` there is no collector to report to.
    expect(() => sqlLite.parse("CREATE TABLE t (c interval day é);")).toThrow(/Unexpected character "é"/);
    expect(sqlLite.diagnose("CREATE TABLE t (c interval day é);").errors.map((e) => e.message)).toEqual([
      'Unexpected character "é" (1:31)',
    ]);
  });

  it("names a function argument only when the two words are not a type name", () => {
    const arg = (over: Record<string, unknown>) => ({ mode: null, name: null, defaultValue: null, ...over });
    // Both words are the type: one unnamed argument, not a `double` of type
    // `precision`.
    expect(fnArgs("double precision")).toEqual([arg({ type: ct("double precision") })]);
    expect(fnArgs("timestamp with time zone")).toEqual([arg({ type: ct("timestamp with time zone") })]);
    // A name in front of one still works, and used to fail outright.
    expect(fnArgs("a double precision")).toEqual([arg({ name: "a", type: ct("double precision") })]);
    expect(fnArgs("a timestamp with time zone")).toEqual([arg({ name: "a", type: ct("timestamp with time zone") })]);
    // The ordinary `name type` pair is untouched.
    expect(fnArgs("a integer")).toEqual([arg({ name: "a", type: ct("integer") })]);
    expect(fnArgs("integer")).toEqual([arg({ type: ct("integer") })]);
    // A lead word followed by something that cannot continue it is a name again —
    // including a word that starts a tail but cannot finish one, since the test
    // is the whole tail rather than just the pair.
    expect(fnArgs("interval integer")).toEqual([arg({ name: "interval", type: ct("integer") })]);
    expect(fnArgs("timestamp without")).toEqual([arg({ name: "timestamp", type: ct("without") })]);
    expect(fnArgs("in double precision")).toEqual([arg({ mode: "in", type: ct("double precision") })]);
  });

  it("keeps the type words unreserved as names and aliases", () => {
    // Every word this rule matches by value that was not already reserved stays
    // usable as a bare name. (`with` and `to` are the two it matches that are
    // reserved, and were reserved long before this rule existed.)
    const words = [
      "double",
      "precision",
      "character",
      "char",
      "varying",
      "national",
      "bit",
      "without",
      "zone",
      "time",
      "timestamp",
      "interval",
      "year",
      "month",
      "day",
      "hour",
      "minute",
      "second",
    ];
    expect((firstStmt(`SELECT ${words.join(", ")} FROM t;`) as any).columns).toEqual(words.map((w) => col(name(w))));
    // …as column names, with an ordinary type after them,
    expect((firstStmt("CREATE TABLE t (double int, interval text, zone int);") as any).items).toEqual([
      { kind: "column", name: "double", dataType: ct("int"), constraints: [] },
      { kind: "column", name: "interval", dataType: ct("text"), constraints: [] },
      { kind: "column", name: "zone", dataType: ct("int"), constraints: [] },
    ]);
    // `date` is the neighbouring unreserved type word this rule does *not* match
    // by value; it stays an ordinary column reference.
    expect((firstStmt("SELECT date FROM t;") as any).columns).toEqual([col(name("date"))]);
    // …and as aliases.
    expect((firstStmt("SELECT a AS precision, b AS varying FROM t;") as any).columns).toEqual([
      col(name("a"), "precision"),
      col(name("b"), "varying"),
    ]);
  });
});

// --- niladic keyword functions, typed datetime literals and OVERLAY ---

describe("SQL-lite niladic keyword functions, typed datetime literals and OVERLAY", () => {
  const colExpr = (src: string) => (firstStmt(`SELECT ${src} FROM t;`) as any).columns[0].expr;
  const svf = (name: string, over: Record<string, unknown> = {}) => ({ kind: "sqlValueFunction", name, ...over });
  const typed = (type: unknown, value: string) => ({ kind: "typedLiteral", type, value });

  it("parses the nine niladic keyword functions as expressions", () => {
    const words = [
      "current_date",
      "current_time",
      "current_timestamp",
      "localtime",
      "localtimestamp",
      "current_role",
      "current_user",
      "session_user",
      "user",
    ];
    // All nine are reserved, and until now were usable nowhere as a value.
    expect((firstStmt(`SELECT ${words.join(", ")} FROM t;`) as any).columns).toEqual(words.map((w) => col(svf(w))));
    // They are ordinary operands from there on.
    expect(colExpr("current_date - 1")).toEqual(bin("-", svf("current_date"), num(1)));
    expect(colExpr("current_timestamp AT TIME ZONE 'utc'")).toEqual({
      kind: "atTimeZone",
      expr: svf("current_timestamp"),
      zone: str("utc"),
    });
    expect((firstStmt("CREATE TABLE t (at timestamp DEFAULT current_timestamp);") as any).items[0].constraints).toEqual(
      [{ kind: "default", expr: svf("current_timestamp") }],
    );
  });

  it("names them in the expected-an-expression message", () => {
    expect(() => sqlLite.parse("SELECT 1 + ;")).toThrow(
      /or "array" or a keyword like "current_date" or "\(" or a name but found ";" \(1:11\)/,
    );
  });

  it("records the precision the time-valued ones take, and only theirs", () => {
    expect(colExpr("current_timestamp(3)")).toEqual(svf("current_timestamp", { precision: 3 }));
    expect(colExpr("current_time(6)")).toEqual(svf("current_time", { precision: 6 }));
    expect(colExpr("localtimestamp(2)")).toEqual(svf("localtimestamp", { precision: 2 }));
    // Zero is a precision, not an absent one.
    expect(colExpr("localtime(0)")).toEqual(svf("localtime", { precision: 0 }));
    // Without a list the key is omitted, not null.
    expect(colExpr("current_timestamp")).not.toHaveProperty("precision");
    // PG takes no argument list at all on the others, not even an empty one.
    expect(() => sqlLite.parse("SELECT current_date();")).toThrow(/Expected ";" but found "\(" \(1:19\)/);
    expect(() => sqlLite.parse("SELECT current_user(1);")).toThrow(/Expected ";" but found "\("/);
    // …and nothing but an integer as the precision.
    expect(() => sqlLite.parse("SELECT current_timestamp(1.5);")).toThrow(
      /Expected an integer precision but found "1.5"/,
    );
    // PG's integer constants include hex, and the lexer has already dropped any
    // digit separators; a float spelling of a whole number is still a float.
    expect(colExpr("current_timestamp(0x3)")).toEqual(svf("current_timestamp", { precision: 3 }));
    expect(colExpr("current_time(1_0)")).toEqual(svf("current_time", { precision: 10 }));
    expect(() => sqlLite.parse("SELECT current_timestamp(3e0);")).toThrow(
      /Expected an integer precision but found "3e0"/,
    );
    expect(() => sqlLite.parse("SELECT current_timestamp(2147483648);")).toThrow(
      /Expected an integer precision but found "2147483648"/,
    );
    expect(() => sqlLite.parse("SELECT current_timestamp(x);")).toThrow(/Expected an integer precision but found "x"/);
    expect(() => sqlLite.parse("SELECT current_timestamp(3;")).toThrow(/Expected "\)" but found ";"/);
  });

  it("leaves the grantee spellings of the role words alone", () => {
    // GRANT / REVOKE read `current_user` and friends as grantee keywords, never
    // through the expression grammar, so those nodes keep their string form.
    expect((firstStmt("GRANT SELECT ON t TO current_user, session_user;") as any).grantees).toEqual([
      "current_user",
      "session_user",
    ]);
    expect((firstStmt("REVOKE SELECT ON t FROM current_user, session_user;") as any).grantees).toEqual([
      "current_user",
      "session_user",
    ]);
  });

  it("parses DATE, TIME and TIMESTAMP string literals", () => {
    expect(colExpr("date '2024-01-01'")).toEqual(typed(ct("date"), "2024-01-01"));
    expect(colExpr("time '10:00'")).toEqual(typed(ct("time"), "10:00"));
    expect(colExpr("TIMESTAMP '2024-01-01 00:00'")).toEqual(typed(ct("timestamp"), "2024-01-01 00:00"));
    // The type is a full typeRef: multi-word spellings and the pre-tail
    // precision come out exactly as they do in a cast.
    expect(colExpr("timestamp with time zone '2024-01-01'")).toEqual(
      typed(ct("timestamp with time zone"), "2024-01-01"),
    );
    expect(colExpr("time(3) without time zone '10:00'")).toEqual(
      typed(ct("time without time zone", { args: [3] }), "10:00"),
    );
    expect(colExpr("timestamp(2) 'x'")).toEqual(typed(ct("timestamp", { args: [2] }), "x"));
    // A typed literal is an atom, so the postfixes and operators bind around it.
    expect(colExpr("date '2024-01-01'::text")).toEqual({
      kind: "cast",
      expr: typed(ct("date"), "2024-01-01"),
      type: ct("text"),
    });
    expect(colExpr("extract(epoch FROM timestamp 'x')")).toEqual({
      kind: "extract",
      field: "epoch",
      source: typed(ct("timestamp"), "x"),
    });
  });

  it("spans a typed literal from its type word to its string", () => {
    const expr = (sqlLite.parse("SELECT timestamp(3) with time zone 'x';")[0] as any).columns[0].expr;
    expect(expr.span).toEqual({ start: { row: 1, col: 7 }, end: { row: 1, col: 37 } });
    expect(expr.type.span).toEqual({ start: { row: 1, col: 7 }, end: { row: 1, col: 34 } });
  });

  it("reads a typed literal only when the whole spelling is followed by a string", () => {
    // A quoted lead is an ordinary name, as it is in typeRef. That is a
    // deliberate narrowing: PG's general `type 'string'` form also takes a
    // quoted or qualified type name (`"char" 'a'`), which this grammar does not
    // implement — only the three bare datetime words lead a literal here.
    expect(() => sqlLite.parse(`SELECT "date" 'x';`)).toThrow(/Expected ";" but found "x"/);
    // So is a lead whose tail is not followed by a string — no word is taken.
    expect(() => sqlLite.parse("SELECT timestamp with time zone FROM t;")).toThrow(/Expected ";" but found "with"/);
    // A lex error in the lookahead past the lead word must not cost the syntax
    // error the statement already had.
    expect(sqlLite.diagnose("SELECT time with time zone é;").errors.map((e) => e.message)).toEqual([
      'Unexpected character "é" (1:27)',
      'Expected ";" but found "with" (1:12)',
    ]);
    // The token after a bare lead is read exactly as a name reads it, so a lex
    // error there costs the statement as it always did, for every lead.
    expect(sqlLite.diagnose("SELECT date é FROM;").errors.map((e) => e.message)).toEqual([
      'Unexpected character "é" (1:12)',
    ]);
    expect(sqlLite.diagnose("SELECT a FROM t WHERE date é;\nSELECT 1;").ast).toHaveLength(1);
    // PG writes the precision before the tail, never after it.
    expect(() => sqlLite.parse("SELECT timestamp with time zone(3) 'x';")).toThrow(/Expected ";" but found "with"/);
    // Nor does it take anything but an integer one.
    expect(() => sqlLite.parse("SELECT timestamp(1.5) 'x';")).toThrow(/Expected ";" but found "x"/);
    // DATE takes no precision, so `date(3)` is a call and the string a stray.
    expect(() => sqlLite.parse("SELECT date(3) 'x';")).toThrow(/Expected ";" but found "x"/);
  });

  it("keeps date / time / timestamp unreserved as names, calls and aliases", () => {
    expect((firstStmt("SELECT date, time, timestamp FROM t;") as any).columns).toEqual([
      col(name("date")),
      col(name("time")),
      col(name("timestamp")),
    ]);
    expect((firstStmt("SELECT date(x), timestamp(3), time.x FROM t;") as any).columns).toEqual([
      col({ kind: "call", name: "date", args: [name("x")] }),
      col({ kind: "call", name: "timestamp", args: [num(3)] }),
      col(name("time", "x")),
    ]);
    expect((firstStmt("SELECT a date, b AS time, c timestamp FROM t;") as any).columns).toEqual([
      col(name("a"), "date"),
      col(name("b"), "time"),
      col(name("c"), "timestamp"),
    ]);
    expect((firstStmt("CREATE TABLE t (date date, time time, overlay text);") as any).items).toEqual([
      { kind: "column", name: "date", dataType: ct("date"), constraints: [] },
      { kind: "column", name: "time", dataType: ct("time"), constraints: [] },
      { kind: "column", name: "overlay", dataType: ct("text"), constraints: [] },
    ]);
  });

  it("parses OVERLAY in both the PLACING and the comma form", () => {
    expect(colExpr("OVERLAY(s PLACING 'ab' FROM 2 FOR 3)")).toEqual({
      kind: "overlay",
      value: name("s"),
      placing: str("ab"),
      from: num(2),
      for_: num(3),
    });
    expect(colExpr("overlay(a || b PLACING 'x' FROM n + 1)")).toEqual({
      kind: "overlay",
      value: bin("||", name("a"), name("b")),
      placing: str("x"),
      from: bin("+", name("n"), num(1)),
      for_: null,
    });
    // The comma form is an ordinary call, and parses exactly as it did before
    // the keyword form existed — including the call modifiers, which PG would
    // reject on OVERLAY but which this grammar accepts on any call.
    expect(colExpr("overlay(s, 'x', 1)")).toEqual({
      kind: "call",
      name: "overlay",
      args: [name("s"), str("x"), num(1)],
    });
    expect(colExpr("overlay(DISTINCT s ORDER BY s)")).toMatchObject({ kind: "call", name: "overlay", distinct: true });
    expect(colExpr("overlay(s, 'x', 1) OVER ()")).toMatchObject({ kind: "window", fn: { name: "overlay" } });
    expect(colExpr("overlay()")).toEqual({ kind: "call", name: "overlay", args: [] });
    // A qualified star is an ordinary operand; only a bare `*` is refused.
    expect(colExpr("overlay(t.* PLACING 'x' FROM 1)")).toMatchObject({ kind: "overlay", value: star(["t"]) });
  });

  it("rejects a malformed OVERLAY", () => {
    expect(() => sqlLite.parse("SELECT overlay(s PLACING 'x');")).toThrow(/Expected "from" but found "\)"/);
    expect(() => sqlLite.parse("SELECT overlay(s PLACING 'x' FROM 1 FOR);")).toThrow(/but found "\)" \(1:39\)/);
    // PLACING may follow only the first argument of a bare OVERLAY, and only
    // a plain one.
    expect(() => sqlLite.parse("SELECT overlay(a, b PLACING 'x' FROM 1);")).toThrow(
      /Expected "\)" but found "placing"/,
    );
    expect(() => sqlLite.parse("SELECT overlay(DISTINCT s PLACING 'x' FROM 1);")).toThrow(
      /Expected "\)" but found "placing"/,
    );
    expect(() => sqlLite.parse("SELECT overlay(* PLACING 'x' FROM 1);")).toThrow(/Expected "\)" but found "placing"/);
    expect(() => sqlLite.parse("SELECT overlay(v => s PLACING 'x' FROM 1);")).toThrow(
      /Expected "\)" but found "placing"/,
    );
    expect(() => sqlLite.parse(`SELECT "overlay"(s PLACING 'x' FROM 1);`)).toThrow(/Expected "\)" but found "placing"/);
    expect(() => sqlLite.parse("SELECT pg_catalog.overlay(s PLACING 'x' FROM 1);")).toThrow(
      /Expected "\)" but found "placing"/,
    );
  });

  it("keeps overlay unreserved as a name and an alias", () => {
    expect((firstStmt("SELECT overlay, a overlay FROM t;") as any).columns).toEqual([
      col(name("overlay")),
      col(name("a"), "overlay"),
    ]);
  });
});

// --- CREATE TABLE storage options, LIKE and INHERITS ---

describe("SQL-lite CREATE TABLE storage options, LIKE and INHERITS", () => {
  const stmt = (src: string) => firstStmt(src) as any;
  const items = (body: string) => stmt(`CREATE TABLE t (${body});`).items;
  const options = (list: string) => stmt(`CREATE TABLE t (id int) WITH (${list});`).options;
  const rawFirst = (text: string) => sqlLite.parse(text)[0] as Record<string, any>;
  const idCol = { kind: "column", name: "id", dataType: ct("int"), constraints: [] };

  it("parses LIKE as a table item, with its INCLUDING / EXCLUDING options in source order", () => {
    expect(items("LIKE src INCLUDING DEFAULTS EXCLUDING INDEXES, id int")).toEqual([
      {
        kind: "likeTable",
        table: ["src"],
        options: [
          { mode: "including", property: "defaults" },
          { mode: "excluding", property: "indexes" },
        ],
      },
      idCol,
    ]);
    // The options are optional, and the source may be qualified.
    expect(items("id int, LIKE app.src")).toEqual([idCol, { kind: "likeTable", table: ["app", "src"], options: [] }]);
    expect(items("LIKE src INCLUDING ALL")[0].options).toEqual([{ mode: "including", property: "all" }]);
  });

  it("reserves `like`, so a bare `like` is the LIKE clause and never a name", () => {
    // The one reservation this clause costs. PG makes the same call — `like` is
    // a type_func_name_keyword there — so these are not names in PG either:
    expect(items("like text")).toEqual([{ kind: "likeTable", table: ["text"], options: [] }]);
    expect(() => sqlLite.parse("SELECT like FROM t;")).toThrow(/Expected a name but found "like"/);
    expect(() => sqlLite.parse("SELECT * FROM t like;")).toThrow(/but found "like"/);
    expect(() => sqlLite.parse("CREATE TABLE like (id int);")).toThrow(/Expected a name but found "like"/);
    expect(() => sqlLite.parse("ALTER TABLE t ADD like text;")).toThrow(/Expected a name but found "like"/);
    // …but PG's tier still admits it as an alias after AS, a function name, a
    // type name and the tail of a qualified name. Reserved here, it loses all
    // four, exactly as any other reserved word (`left`, say) already does.
    expect(() => sqlLite.parse("SELECT a AS like FROM t;")).toThrow(/Expected an alias but found "like"/);
    expect(() => sqlLite.parse("SELECT like('abc', 'a%');")).toThrow(/Expected a name but found "like"/);
    expect(() => sqlLite.parse("SELECT a::like FROM t;")).toThrow(/Expected a name but found "like"/);
    expect(() => sqlLite.parse("SELECT t.like FROM t;")).toThrow(/Expected a name but found "like"/);
    // Quoted, it is a name as it always was.
    expect(items('"like" text')).toEqual([{ kind: "column", name: "like", dataType: ct("text"), constraints: [] }]);
    // The LIKE operator never read the word as a name, so it is untouched.
    expect(exprOf("name LIKE 'a%'")).toMatchObject({ kind: "like", negated: false, ci: false });
  });

  it("parses INHERITS, WITH, ON COMMIT and TABLESPACE after the element list", () => {
    expect(
      stmt("CREATE TABLE t (id int) INHERITS (p, app.q) WITH (fillfactor = 70) ON COMMIT DELETE ROWS TABLESPACE fast;"),
    ).toEqual({
      kind: "createTable",
      ifNotExists: false,
      name: ["t"],
      items: [idCol],
      inherits: [["p"], ["app", "q"]],
      options: [{ name: "fillfactor", value: num(70) }],
      onCommit: "deleteRows",
      tablespace: "fast",
    });
    expect(stmt("CREATE TABLE t (id int) ON COMMIT PRESERVE ROWS;").onCommit).toBe("preserveRows");
    expect(stmt("CREATE TABLE t (id int) ON COMMIT DROP;").onCommit).toBe("drop");
    // Any subset may be written, so long as it keeps PG's order.
    expect(stmt("CREATE TABLE t (LIKE src) TABLESPACE ts;")).toMatchObject({ tablespace: "ts" });
    expect(stmt('CREATE TABLE t (id int) INHERITS ("Parent");').inherits).toEqual([["Parent"]]);
  });

  it("omits every clause key from a table that writes none of them", () => {
    // Each key is spread in only when its clause is written, so the AST golden's
    // existing CREATE TABLE rows keep exactly the shape they had.
    const plain = stmt("CREATE TABLE t (id int);");
    for (const key of ["inherits", "options", "onCommit", "tablespace"]) expect(plain).not.toHaveProperty(key);
  });

  it("reads each option as a name with an optional, optionally `=`-led value", () => {
    expect(options("a = 1, b 2, c, d = 'x', e = word, f = true, g false")).toEqual([
      { name: "a", value: num(1) },
      { name: "b", value: num(2) },
      { name: "c", value: null },
      { name: "d", value: str("x") },
      // A bare word and a quoted string are different values, and stay so.
      { name: "e", value: name("word") },
      { name: "f", value: { kind: "bool", value: true } },
      { name: "g", value: { kind: "bool", value: false } },
    ]);
    // A sign belongs to the number it precedes.
    expect(options("x = -1, y +2.5")).toEqual([
      { name: "x", value: num(-1) },
      { name: "y", value: num(2.5) },
    ]);
    // Names (PG's ColLabel) and word values may be reserved words, or quoted.
    expect(options('analyze, null = on, "Mixed" = "Word"')).toEqual([
      { name: "analyze", value: null },
      { name: "null", value: name("on") },
      { name: "Mixed", value: name("Word") },
    ]);
  });

  it("reads a reloption's namespace, and COPY's `*` and list values", () => {
    // `namespace` follows the omit-when-absent rule: only a qualified name has it.
    expect(options("toast.autovacuum_enabled = false, toast.fillfactor 70, toast.x, plain")).toEqual([
      { namespace: "toast", name: "autovacuum_enabled", value: { kind: "bool", value: false } },
      { namespace: "toast", name: "fillfactor", value: num(70) },
      { namespace: "toast", name: "x", value: null },
      { name: "plain", value: null },
    ]);
    expect(options("force_quote *, force_null (a, 'b')")).toEqual([
      { name: "force_quote", value: star() },
      { name: "force_null", value: { kind: "optionList", items: [name("a"), str("b")] } },
    ]);
  });

  it("records spans for LIKE items, options and signed values", () => {
    const node = rawFirst("CREATE TABLE t (LIKE src INCLUDING ALL) WITH (x = -1);");
    expect(node.items[0].span).toEqual({ start: { row: 1, col: 16 }, end: { row: 1, col: 38 } });
    expect(node.options[0].span).toEqual({ start: { row: 1, col: 46 }, end: { row: 1, col: 52 } });
    expect(node.options[0].value.span).toEqual({ start: { row: 1, col: 50 }, end: { row: 1, col: 52 } });
  });

  it("keeps the clause and option words usable as names", () => {
    // Everything here but `fillfactor` — there as a sample option name, which
    // the grammar never matches by value — is matched by value in a position no
    // name could occupy: past a source table's name, or past the element list's
    // `)`, or ahead of a CTAS's AS. So none of it needed reserving. (`with` and
    // `on` were reserved already.)
    const words = [
      "inherits",
      "tablespace",
      "including",
      "excluding",
      "commit",
      "preserve",
      "rows",
      "drop",
      "comments",
      "compression",
      "constraints",
      "defaults",
      "identity",
      "generated",
      "indexes",
      "statistics",
      "storage",
      "fillfactor",
    ];
    expect(stmt(`SELECT ${words.join(", ")} FROM t;`).columns).toEqual(words.map((w) => col(name(w))));
    expect(items(words.map((w) => `${w} int`).join(", ")).map((c: any) => c.name)).toEqual(words);
    expect(stmt("SELECT a AS inherits, b AS tablespace FROM t;").columns).toEqual([
      col(name("a"), "inherits"),
      col(name("b"), "tablespace"),
    ]);
    // …as table names, including in the very clauses that use them as keywords.
    expect(stmt("CREATE TABLE inherits (LIKE including) INHERITS (tablespace) TABLESPACE storage;")).toMatchObject({
      name: ["inherits"],
      items: [{ kind: "likeTable", table: ["including"], options: [] }],
      inherits: [["tablespace"]],
      tablespace: "storage",
    });
  });

  it("takes the storage clauses ahead of a CREATE TABLE AS, apart from its WITH [NO] DATA tail", () => {
    expect(
      stmt("CREATE TABLE t WITH (fillfactor = 70) ON COMMIT DROP TABLESPACE ts AS SELECT 1 WITH NO DATA;"),
    ).toEqual({
      kind: "createTableAs",
      ifNotExists: false,
      name: ["t"],
      columns: null,
      query: sel({ columns: [col(num(1))] }),
      withData: false,
      options: [{ name: "fillfactor", value: num(70) }],
      onCommit: "drop",
      tablespace: "ts",
    });
    // After a column-name list too, which still backtracks to the element-list
    // form when no AS follows.
    expect(stmt("CREATE TABLE t (a, b) WITH (fillfactor = 70) AS SELECT 1, 2;")).toMatchObject({
      kind: "createTableAs",
      columns: ["a", "b"],
      options: [{ name: "fillfactor", value: num(70) }],
    });
    expect(stmt("CREATE TABLE t (id int) WITH (fillfactor = 70);").kind).toBe("createTable");
    // A CTAS with no clause keeps exactly the node it had.
    const plain = stmt("CREATE TABLE snap AS SELECT 1 WITH NO DATA;");
    expect(plain).toMatchObject({ kind: "createTableAs", withData: false });
    for (const key of ["options", "onCommit", "tablespace"]) expect(plain).not.toHaveProperty(key);
    // INHERITS belongs to the element-list form only, as in PG; and once a
    // storage clause follows the name, AS is the only way on.
    expect(() => sqlLite.parse("CREATE TABLE t INHERITS (p) AS SELECT 1;")).toThrow(/but found "inherits"/);
    expect(() => sqlLite.parse("CREATE TABLE t WITH (x = 1) (id int);")).toThrow(/Expected "as" but found "\("/);
  });

  it("rejects malformed clauses, empty lists and out-of-order clauses", () => {
    const bad = (tail: string) => () => sqlLite.parse(`CREATE TABLE t (id int) ${tail};`);
    expect(bad("WITH ()")).toThrow(/Expected an option name but found "\)"/);
    expect(bad("WITH (a =)")).toThrow(/Expected an option value but found "\)"/);
    expect(bad("WITH (a - b)")).toThrow(/Expected an option value but found "-"/);
    expect(bad("WITH (a b c)")).toThrow(/Expected "\)" but found "c"/);
    expect(bad("WITH fillfactor = 70")).toThrow(/Expected "\(" but found "fillfactor"/);
    expect(bad("WITH (a = ())")).toThrow(/Expected an option value but found "\)"/);
    expect(bad("WITH (a = (*))")).toThrow(/Expected an option value but found "\*"/);
    expect(bad("WITH (toast. = 1)")).toThrow(/Expected an option name but found "="/);
    expect(bad("INHERITS ()")).toThrow(/Expected a name but found "\)"/);
    expect(bad("INHERITS p")).toThrow(/Expected "\(" but found "p"/);
    expect(bad("ON COMMIT KEEP ROWS")).toThrow(/Expected "preserve rows" or "delete rows" or "drop" but found "keep"/);
    expect(bad("ON DELETE ROWS")).toThrow(/Expected "commit" but found "delete"/);
    expect(bad("TABLESPACE")).toThrow(/Expected a name but found ";"/);
    // PG fixes the order of the clauses, and so does this.
    expect(bad("TABLESPACE ts WITH (a = 1)")).toThrow(/Expected ";" but found "with"/);
    expect(bad("ON COMMIT DROP INHERITS (p)")).toThrow(/Expected ";" but found "inherits"/);
    expect(() => sqlLite.parse("CREATE TABLE t (LIKE src INCLUDING everything);")).toThrow(
      /Expected "comments", "compression", "constraints", "defaults", "identity", "generated", "indexes", "statistics", "storage" or "all" but found "everything"/,
    );
    expect(() => sqlLite.parse("CREATE TABLE t (LIKE);")).toThrow(/Expected a name but found "\)"/);
  });
});

// --- declarative partitioning ---

describe("SQL-lite declarative partitioning", () => {
  const stmt = (src: string) => firstStmt(src) as any;
  const spec = (keys: string, strategy = "RANGE") =>
    stmt(`CREATE TABLE m (a int) PARTITION BY ${strategy} (${keys});`).partitionBy;
  const bound = (src: string) => stmt(`CREATE TABLE p PARTITION OF m ${src};`).partitionOf.bound;
  const bad = (src: string) => () => sqlLite.parse(src);
  const aCol = { kind: "column", name: "a", dataType: ct("int"), constraints: [] };

  it("parses PARTITION BY after the element list, with each key's collation and operator class", () => {
    expect(stmt("CREATE TABLE m (a int) PARTITION BY LIST (a);")).toEqual({
      kind: "createTable",
      ifNotExists: false,
      name: ["m"],
      items: [aCol],
      partitionBy: { strategy: "list", keys: [{ expr: name("a") }] },
    });
    // A column, a call or a parenthesised expression; COLLATE and the opclass
    // belong to the key, so neither is left on the expression.
    expect(spec('a text_ops, lower(b) COLLATE "C" app.text_pattern_ops, (a + 1) COLLATE x', "HASH")).toEqual({
      strategy: "hash",
      keys: [
        { expr: name("a"), opclass: ["text_ops"] },
        {
          expr: { kind: "call", name: "lower", args: [name("b")] },
          collate: ["C"],
          opclass: ["app", "text_pattern_ops"],
        },
        { expr: bin("+", name("a"), num(1)), collate: ["x"] },
      ],
    });
    // A COLLATE inside the parentheses is the expression's own.
    expect(spec("(a COLLATE x)").keys[0]).toEqual({ expr: { kind: "collate", expr: name("a"), collation: ["x"] } });
    // The strategy is read ignoring case, quoted or not, as PG reads it.
    expect(spec("a", '"Range"').strategy).toBe("range");
    expect(spec("extract(year FROM a)").keys[0].expr).toMatchObject({ kind: "extract", field: "year" });
    // CAST(…) and the niladic keyword functions are calls in PG's grammar too.
    expect(spec("CAST(a AS text), current_date").keys.map((k: any) => k.expr.kind)).toEqual([
      "cast",
      "sqlValueFunction",
    ]);
  });

  it("parses PARTITION OF with no element list, for each kind of bound", () => {
    expect(stmt("CREATE TABLE p PARTITION OF app.m DEFAULT;")).toEqual({
      kind: "createTable",
      ifNotExists: false,
      name: ["p"],
      items: [],
      partitionOf: { parent: ["app", "m"], bound: { kind: "default" } },
    });
    expect(bound("FOR VALUES IN (1, 'x' || 'y')")).toEqual({
      kind: "list",
      values: [num(1), bin("||", str("x"), str("y"))],
    });
    expect(bound("FOR VALUES FROM (1, MINVALUE) TO (10, maxvalue)")).toEqual({
      kind: "range",
      from: [num(1), { kind: "minvalue" }],
      to: [num(10), { kind: "maxvalue" }],
    });
    expect(bound("FOR VALUES WITH (MODULUS 4, REMAINDER 0)")).toEqual({ kind: "hash", modulus: 4, remainder: 0 });
    // Either order, and with the `=` the shared option list allows.
    expect(bound("FOR VALUES WITH (remainder = 3, modulus = 8)")).toEqual({ kind: "hash", modulus: 8, remainder: 3 });
  });

  it("reads MINVALUE / MAXVALUE as PG does: a one-part name, only in a range bound", () => {
    // Quoted, it is still the same column reference PG picks out by name.
    expect(bound('FOR VALUES FROM ("minvalue") TO (maxvalue + 1)')).toEqual({
      kind: "range",
      from: [{ kind: "minvalue" }],
      to: [bin("+", name("maxvalue"), num(1))],
    });
    expect(bound("FOR VALUES IN (minvalue)").values).toEqual([name("minvalue")]);
    // Only MINVALUE may follow MINVALUE, and only MAXVALUE may follow MAXVALUE.
    expect(bound("FOR VALUES FROM (1, MINVALUE, MINVALUE) TO (MAXVALUE, MAXVALUE)").to).toEqual([
      { kind: "maxvalue" },
      { kind: "maxvalue" },
    ]);
    expect(bad("CREATE TABLE p PARTITION OF m FOR VALUES FROM (MINVALUE, 1) TO (2);")).toThrow(
      /every bound following MINVALUE must also be MINVALUE/,
    );
    expect(bad("CREATE TABLE p PARTITION OF m FOR VALUES FROM (1) TO (MAXVALUE, minvalue);")).toThrow(
      /every bound following MAXVALUE must also be MAXVALUE/,
    );
  });

  it("parses a PARTITION OF element list of column options and table constraints", () => {
    expect(
      stmt(
        "CREATE TABLE p PARTITION OF m (a WITH OPTIONS NOT NULL, b DEFAULT 'x', c, CONSTRAINT k CHECK (a > 0), PRIMARY KEY (a)) FOR VALUES IN (1);",
      ).items,
    ).toEqual([
      { kind: "columnOptions", name: "a", withOptions: true, constraints: [{ kind: "notNull" }] },
      { kind: "columnOptions", name: "b", constraints: [{ kind: "default", expr: str("x") }] },
      { kind: "columnOptions", name: "c", constraints: [] },
      { kind: "check", name: "k", expr: bin(">", name("a"), num(0)) },
      { kind: "primaryKey", name: null, columns: ["a"] },
    ]);
  });

  it("composes with INHERITS and the storage clauses in PG's order", () => {
    expect(
      stmt(
        "CREATE TABLE m (a int) INHERITS (p) PARTITION BY RANGE (a) WITH (fillfactor = 70) ON COMMIT DROP TABLESPACE ts;",
      ),
    ).toEqual({
      kind: "createTable",
      ifNotExists: false,
      name: ["m"],
      items: [aCol],
      inherits: [["p"]],
      partitionBy: { strategy: "range", keys: [{ expr: name("a") }] },
      options: [{ name: "fillfactor", value: num(70) }],
      onCommit: "drop",
      tablespace: "ts",
    });
    // A partition may itself be partitioned, and the bound's WITH is its own:
    // a storage WITH can still follow it.
    expect(
      stmt(
        "CREATE TABLE IF NOT EXISTS p PARTITION OF m FOR VALUES WITH (MODULUS 2, REMAINDER 1) PARTITION BY LIST (b) WITH (fillfactor = 70) TABLESPACE ts;",
      ),
    ).toEqual({
      kind: "createTable",
      ifNotExists: true,
      name: ["p"],
      items: [],
      partitionOf: { parent: ["m"], bound: { kind: "hash", modulus: 2, remainder: 1 } },
      partitionBy: { strategy: "list", keys: [{ expr: name("b") }] },
      options: [{ name: "fillfactor", value: num(70) }],
      tablespace: "ts",
    });
  });

  it("omits the partitioning keys from a table that writes neither clause", () => {
    const plain = stmt("CREATE TABLE t (id int);");
    for (const key of ["partitionOf", "partitionBy"]) expect(plain).not.toHaveProperty(key);
    // Nor is `withOptions` written on a column option that has none.
    expect(stmt("CREATE TABLE p PARTITION OF m (a NOT NULL) DEFAULT;").items[0]).not.toHaveProperty("withOptions");
  });

  it("records spans for the partition spec, its keys and the bound", () => {
    const node = sqlLite.parse("CREATE TABLE m (a int) PARTITION BY RANGE (a, (a + 1));")[0] as Record<string, any>;
    expect(node.partitionBy.span).toEqual({ start: { row: 1, col: 23 }, end: { row: 1, col: 54 } });
    expect(node.partitionBy.keys[1].span).toEqual({ start: { row: 1, col: 46 }, end: { row: 1, col: 53 } });
    const part = sqlLite.parse("CREATE TABLE p PARTITION OF m FOR VALUES FROM (MINVALUE) TO (1);")[0] as Record<
      string,
      any
    >;
    expect(part.partitionOf.bound.span).toEqual({ start: { row: 1, col: 30 }, end: { row: 1, col: 63 } });
    expect(part.partitionOf.bound.from[0].span).toEqual({ start: { row: 1, col: 47 }, end: { row: 1, col: 55 } });
  });

  it("keeps every partitioning word usable as a name", () => {
    // Each is matched by value only past a table name, past the element list's
    // `)`, or inside a clause already begun — where no name could stand.
    const words = [
      "partition",
      "of",
      "range",
      "list",
      "hash",
      "modulus",
      "remainder",
      "minvalue",
      "maxvalue",
      "options",
    ];
    expect(stmt(`SELECT ${words.join(", ")} FROM t;`).columns).toEqual(words.map((w) => col(name(w))));
    expect(
      stmt(`CREATE TABLE partition (${words.map((w) => `${w} int`).join(", ")});`).items.map((c: any) => c.name),
    ).toEqual(words);
    // …including in the clauses that use them as keywords.
    expect(stmt("CREATE TABLE range PARTITION OF partition (list NOT NULL) DEFAULT PARTITION BY HASH (hash);")).toEqual(
      {
        kind: "createTable",
        ifNotExists: false,
        name: ["range"],
        items: [{ kind: "columnOptions", name: "list", constraints: [{ kind: "notNull" }] }],
        partitionOf: { parent: ["partition"], bound: { kind: "default" } },
        partitionBy: { strategy: "hash", keys: [{ expr: name("hash") }] },
      },
    );
  });

  it("rejects malformed partition specs, bounds and element lists", () => {
    expect(bad("CREATE TABLE m (a int) PARTITION BY TREE (a);")).toThrow(
      /Expected "range", "list" or "hash" but found "tree"/,
    );
    expect(bad("CREATE TABLE m (a int) PARTITION RANGE (a);")).toThrow(/Expected "by" but found "range"/);
    expect(bad("CREATE TABLE m (a int) PARTITION BY LIST (a, b);")).toThrow(
      /cannot use "list" partition strategy with more than one column/,
    );
    // A reserved word after a key is no operator class.
    expect(bad("CREATE TABLE m (a int) PARTITION BY RANGE (a DESC);")).toThrow(/but found "desc"/);
    expect(bad("CREATE TABLE m (a int) PARTITION BY RANGE (a DESC);")).not.toThrow(/Expected a name/);
    expect(bad("CREATE TABLE m (a int) PARTITION BY RANGE a;")).toThrow(/Expected "\(" but found "a"/);
    // Anything but a column or a call must be parenthesised, as in PG.
    for (const key of ["a + 1", "t.a", "a::int", "CAST(a AS int)::text", "count(a) OVER ()"]) {
      expect(bad(`CREATE TABLE m (a int) PARTITION BY RANGE (${key});`)).toThrow(
        /a partition key expression must be parenthesised/,
      );
    }
    expect(bad("CREATE TABLE p PARTITION m DEFAULT;")).toThrow(/Expected "of" but found "m"/);
    expect(bad("CREATE TABLE p PARTITION OF m;")).toThrow(/Expected "for values" or "default" but found ";"/);
    expect(bad("CREATE TABLE p PARTITION OF m FOR VALUES BETWEEN (1);")).toThrow(
      /Expected "in", "from" or "with" but found "between"/,
    );
    expect(bad("CREATE TABLE p PARTITION OF m FOR VALUES FROM (1);")).toThrow(/Expected "to" but found ";"/);
    // The element list takes no types, may not be empty, and INHERITS has no
    // place in the PARTITION OF form.
    expect(bad("CREATE TABLE p PARTITION OF m (a int) DEFAULT;")).toThrow(/but found "int"/);
    expect(bad("CREATE TABLE p PARTITION OF m () DEFAULT;")).toThrow(/or a name but found "\)"/);
    expect(bad("CREATE TABLE p PARTITION OF m INHERITS (x) DEFAULT;")).toThrow(/but found "inherits"/);
    // PG's order: PARTITION BY after INHERITS, before WITH.
    expect(bad("CREATE TABLE m (a int) WITH (x = 1) PARTITION BY HASH (a);")).toThrow(
      /Expected ";" but found "partition"/,
    );
    expect(bad("CREATE TABLE m (a int) PARTITION BY HASH (a) INHERITS (p);")).toThrow(
      /Expected ";" but found "inherits"/,
    );
  });

  it("holds a hash bound to exactly one MODULUS and one REMAINDER", () => {
    const hash = (opts: string) => bad(`CREATE TABLE p PARTITION OF m FOR VALUES WITH (${opts});`);
    expect(hash("MODULUS 4")).toThrow(/remainder for hash partition must be specified/);
    expect(hash("REMAINDER 0")).toThrow(/modulus for hash partition must be specified/);
    expect(hash("MODULUS 4, modulus 2, REMAINDER 0")).toThrow(/modulus for hash partition provided more than once/);
    expect(hash("MODULUS 4, REMAINDER 0, fillfactor 1")).toThrow(
      /unrecognized hash partition bound specification "fillfactor"/,
    );
    expect(hash("toast.modulus 4, REMAINDER 0")).toThrow(
      /unrecognized hash partition bound specification "toast.modulus"/,
    );
    expect(hash("MODULUS 0, REMAINDER 0")).toThrow(
      /modulus for hash partition must be an integer value greater than zero/,
    );
    expect(hash("MODULUS, REMAINDER 0")).toThrow(
      /modulus for hash partition must be an integer value greater than zero/,
    );
    expect(hash("MODULUS 4, REMAINDER -1")).toThrow(
      /remainder for hash partition must be an integer value greater than or equal to zero/,
    );
    expect(hash("MODULUS 4, REMAINDER 1.5")).toThrow(/remainder for hash partition must be an integer value/);
    expect(hash("MODULUS 2147483648, REMAINDER 0")).toThrow(
      /modulus for hash partition is out of range for type integer/,
    );
    // A zero modulus is PG's analysis-time error, so a missing remainder wins.
    expect(hash("MODULUS 0")).toThrow(/remainder for hash partition must be specified/);
    // `-0` is read as 0.
    expect(Object.is(bound("FOR VALUES WITH (MODULUS 4, REMAINDER -0)").remainder, 0)).toBe(true);
    // PG's analysis-time check, made here for want of an analysis pass.
    expect(hash("MODULUS 4, REMAINDER 4")).toThrow(/remainder for hash partition must be less than modulus/);
    expect(hash("MODULUS 'four', REMAINDER 0")).toThrow(/modulus for hash partition must be an integer value/);
  });
});

// --- foreign-key actions, MATCH and DEFERRABLE constraints ---

describe("SQL-lite foreign-key actions, MATCH and DEFERRABLE constraints", () => {
  const colConstraints = (src: string) =>
    (firstStmt(`CREATE TABLE t (c int ${src});`) as any).items[0].constraints as Record<string, unknown>[];
  const tableItem = (src: string) => (firstStmt(`CREATE TABLE t (c int, ${src});`) as any).items[1];

  it("reads ON DELETE and ON UPDATE in either order", () => {
    expect(colConstraints("REFERENCES p ON UPDATE CASCADE")).toEqual([
      { kind: "references", table: ["p"], columns: null, onDelete: null, onUpdate: "cascade" },
    ]);
    expect(colConstraints("REFERENCES p (id) ON DELETE SET NULL ON UPDATE RESTRICT")).toEqual([
      { kind: "references", table: ["p"], columns: ["id"], onDelete: "set null", onUpdate: "restrict" },
    ]);
    expect(colConstraints("REFERENCES p (id) ON UPDATE RESTRICT ON DELETE SET NULL")).toEqual([
      { kind: "references", table: ["p"], columns: ["id"], onDelete: "set null", onUpdate: "restrict" },
    ]);
    expect(tableItem("FOREIGN KEY (c) REFERENCES p (id) ON UPDATE CASCADE ON DELETE CASCADE")).toEqual({
      kind: "foreignKey",
      name: null,
      columns: ["c"],
      refTable: ["p"],
      refColumns: ["id"],
      onDelete: "cascade",
      onUpdate: "cascade",
    });
  });

  it("parses every referential action", () => {
    const action = (spelled: string) => colConstraints(`REFERENCES p ON DELETE ${spelled}`)[0]!.onDelete;
    expect(action("NO ACTION")).toBe("no action");
    expect(action("RESTRICT")).toBe("restrict");
    expect(action("CASCADE")).toBe("cascade");
    expect(action("SET NULL")).toBe("set null");
    expect(action("SET DEFAULT")).toBe("set default");
    expect(colConstraints("REFERENCES p ON UPDATE SET DEFAULT")[0]!.onUpdate).toBe("set default");
  });

  it("parses MATCH FULL | PARTIAL | SIMPLE ahead of the actions", () => {
    expect(colConstraints("REFERENCES p MATCH FULL")).toEqual([
      { kind: "references", table: ["p"], columns: null, match: "full", onDelete: null },
    ]);
    expect(colConstraints("REFERENCES p (id) MATCH PARTIAL ON DELETE CASCADE")[0]).toMatchObject({
      match: "partial",
      onDelete: "cascade",
    });
    expect(tableItem("FOREIGN KEY (c) REFERENCES p MATCH SIMPLE ON UPDATE NO ACTION")).toMatchObject({
      kind: "foreignKey",
      match: "simple",
      onDelete: null,
      onUpdate: "no action",
    });
    // PG's order is fixed: MATCH comes before the ON clauses, never after.
    expect(() => sqlLite.parse("CREATE TABLE t (c int REFERENCES p ON DELETE CASCADE MATCH FULL);")).toThrow(
      /Expected "," but found "match"/,
    );
  });

  it("attaches DEFERRABLE / INITIALLY to the constraint it follows", () => {
    expect(colConstraints("UNIQUE DEFERRABLE")).toEqual([{ kind: "unique", deferrable: true }]);
    expect(colConstraints("PRIMARY KEY NOT DEFERRABLE INITIALLY IMMEDIATE")).toEqual([
      { kind: "primaryKey", deferrable: false, initially: "immediate" },
    ]);
    // Either order, and INITIALLY alone.
    expect(colConstraints("UNIQUE INITIALLY DEFERRED DEFERRABLE")).toEqual([
      { kind: "unique", deferrable: true, initially: "deferred" },
    ]);
    expect(colConstraints("UNIQUE INITIALLY IMMEDIATE")).toEqual([{ kind: "unique", initially: "immediate" }]);
    // On a REFERENCES column constraint the attributes follow the FK tail.
    expect(colConstraints("REFERENCES p MATCH FULL ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED")).toEqual([
      {
        kind: "references",
        table: ["p"],
        columns: null,
        match: "full",
        onDelete: "cascade",
        deferrable: true,
        initially: "deferred",
      },
    ]);
    // Table level: PRIMARY KEY, UNIQUE and FOREIGN KEY, named or not.
    expect(tableItem("PRIMARY KEY (c) DEFERRABLE")).toEqual({
      kind: "primaryKey",
      name: null,
      columns: ["c"],
      deferrable: true,
    });
    expect(tableItem("CONSTRAINT u UNIQUE (c) NOT DEFERRABLE")).toEqual({
      kind: "unique",
      name: "u",
      columns: ["c"],
      deferrable: false,
    });
    expect(tableItem("FOREIGN KEY (c) REFERENCES p ON DELETE CASCADE INITIALLY DEFERRED DEFERRABLE")).toMatchObject({
      kind: "foreignKey",
      onDelete: "cascade",
      deferrable: true,
      initially: "deferred",
    });
  });

  it("reaches ALTER TABLE ADD [CONSTRAINT] through the shared table-constraint body", () => {
    expect(
      (firstStmt("ALTER TABLE t ADD CONSTRAINT fk FOREIGN KEY (a) REFERENCES p ON UPDATE CASCADE DEFERRABLE;") as any)
        .actions[0],
    ).toEqual({
      kind: "addConstraint",
      name: "fk",
      constraint: {
        kind: "foreignKey",
        name: null,
        columns: ["a"],
        refTable: ["p"],
        refColumns: null,
        onDelete: null,
        onUpdate: "cascade",
        deferrable: true,
      },
    });
    expect((firstStmt("ALTER TABLE t ADD UNIQUE (a) INITIALLY DEFERRED;") as any).actions[0].constraint).toEqual({
      kind: "unique",
      name: null,
      columns: ["a"],
      initially: "deferred",
    });
    // And the column-level form, through ADD COLUMN.
    expect(
      (firstStmt("ALTER TABLE t ADD COLUMN a int REFERENCES p ON UPDATE SET NULL;") as any).actions[0].column
        .constraints,
    ).toEqual([{ kind: "references", table: ["p"], columns: null, onDelete: null, onUpdate: "set null" }]);
  });

  it("leaves a following NOT NULL to the column-constraint list", () => {
    // `not` is shared: the attribute tail takes it only before `deferrable`.
    expect(colConstraints("UNIQUE NOT NULL")).toEqual([{ kind: "unique" }, { kind: "notNull" }]);
    expect(colConstraints("REFERENCES p ON DELETE CASCADE NOT NULL")).toEqual([
      { kind: "references", table: ["p"], columns: null, onDelete: "cascade" },
      { kind: "notNull" },
    ]);
    expect(colConstraints("PRIMARY KEY NOT DEFERRABLE NOT NULL DEFAULT 0")).toEqual([
      { kind: "primaryKey", deferrable: false },
      { kind: "notNull" },
      { kind: "default", expr: num(0) },
    ]);
  });

  it("omits the new keys entirely when their clauses are absent", () => {
    // `toEqual` and the JSON golden both ignore a key whose value is undefined,
    // so neither would notice `onUpdate: undefined` creeping in; this is the
    // check that the keys are genuinely left out.
    const [column, fk, pk] = (
      firstStmt(
        "CREATE TABLE t (c int UNIQUE REFERENCES p, FOREIGN KEY (c) REFERENCES p (id), PRIMARY KEY (c));",
      ) as any
    ).items;
    const [unique, references] = (column as any).constraints;
    for (const node of [unique, references, fk, pk]) {
      expect(node).not.toHaveProperty("match");
      expect(node).not.toHaveProperty("onUpdate");
      expect(node).not.toHaveProperty("deferrable");
      expect(node).not.toHaveProperty("initially");
    }
    // `onDelete` predates them and stays an always-present null.
    expect(references).toHaveProperty("onDelete", null);
    expect(fk).toHaveProperty("onDelete", null);
  });

  it("keeps the FK and attribute words unreserved as names and aliases", () => {
    // Every word these clauses match by value that was not already reserved.
    // (`on`, `set`, `null`, `default`, `full`, `deferrable` and `initially`
    // are the ones that were.)
    const words = [
      "match",
      "partial",
      "simple",
      "delete",
      "update",
      "no",
      "action",
      "restrict",
      "cascade",
      "deferred",
      "immediate",
    ];
    expect((firstStmt(`SELECT ${words.join(", ")} FROM t;`) as any).columns).toEqual(words.map((w) => col(name(w))));
    expect((firstStmt("SELECT a AS match, b simple FROM t;") as any).columns).toEqual([
      col(name("a"), "match"),
      col(name("b"), "simple"),
    ]);
    // …as column names,
    expect(
      (firstStmt(`CREATE TABLE t (a int REFERENCES p, ${words.map((w) => `${w} int`).join(", ")});`) as any).items.map(
        (i: any) => i.name,
      ),
    ).toEqual(["a", ...words]);
    // …and as the referenced table and column, where the FK tail is looking
    // for `match` and reads the one after the column list, not the table name.
    expect(colConstraints("REFERENCES match (simple) MATCH SIMPLE")).toEqual([
      { kind: "references", table: ["match"], columns: ["simple"], match: "simple", onDelete: null },
    ]);
  });

  it("judges a repeated attribute as PG does at each level", () => {
    const column = (src: string) => () => sqlLite.parse(`CREATE TABLE t (c int ${src});`);
    const table = (src: string) => () => sqlLite.parse(`CREATE TABLE t (c int, ${src});`);
    // A column constraint's attributes are separate items, and any repeat is an
    // error — reported on the repeat, rather than misread as a NOT NULL.
    expect(column("UNIQUE DEFERRABLE NOT DEFERRABLE")).toThrow(
      /multiple DEFERRABLE\/NOT DEFERRABLE clauses not allowed \(1:40\)/,
    );
    expect(column("UNIQUE DEFERRABLE DEFERRABLE")).toThrow(/multiple DEFERRABLE\/NOT DEFERRABLE clauses not allowed/);
    expect(column("UNIQUE INITIALLY DEFERRED INITIALLY DEFERRED")).toThrow(
      /multiple INITIALLY IMMEDIATE\/DEFERRED clauses not allowed/,
    );
    // …and the repeat is checked before the never-deferred contradiction.
    expect(column("UNIQUE DEFERRABLE INITIALLY DEFERRED NOT DEFERRABLE")).toThrow(
      /multiple DEFERRABLE\/NOT DEFERRABLE clauses not allowed/,
    );
    // A table constraint's attributes are one spec: an identical repeat is let
    // through, and only a contradiction is an error.
    expect(tableItem("UNIQUE (c) DEFERRABLE DEFERRABLE INITIALLY DEFERRED INITIALLY DEFERRED")).toEqual({
      kind: "unique",
      name: null,
      columns: ["c"],
      deferrable: true,
      initially: "deferred",
    });
    expect(table("UNIQUE (c) DEFERRABLE NOT DEFERRABLE")).toThrow(/conflicting constraint properties \(1:45\)/);
    expect(table("PRIMARY KEY (c) INITIALLY IMMEDIATE INITIALLY DEFERRED")).toThrow(
      /conflicting constraint properties/,
    );
    expect(() => sqlLite.parse("ALTER TABLE t ADD FOREIGN KEY (a) REFERENCES p NOT DEFERRABLE DEFERRABLE;")).toThrow(
      /conflicting constraint properties/,
    );
    // …and there the never-deferred case is checked first.
    expect(table("UNIQUE (c) DEFERRABLE INITIALLY DEFERRED NOT DEFERRABLE")).toThrow(
      /constraint declared INITIALLY DEFERRED must be DEFERRABLE/,
    );
  });

  it("rejects a repeated, unknown or misplaced clause", () => {
    const create = (src: string) => () => sqlLite.parse(`CREATE TABLE t (c int ${src});`);
    // A repeated verb names the one still open; PG takes each at most once.
    expect(create("REFERENCES p ON DELETE CASCADE ON DELETE SET NULL")).toThrow(/Expected "update" but found "delete"/);
    expect(create("REFERENCES p ON UPDATE CASCADE ON UPDATE CASCADE")).toThrow(/Expected "delete" but found "update"/);
    expect(create("REFERENCES p ON INSERT CASCADE")).toThrow(/Expected "delete" or "update" but found "insert"/);
    expect(create("REFERENCES p ON DELETE frob")).toThrow(
      /Expected "no action" or "restrict" or "cascade" or "set null" or "set default" but found "frob"/,
    );
    expect(create("REFERENCES p ON DELETE SET frob")).toThrow(/Expected "null" or "default" but found "frob"/);
    expect(create("REFERENCES p ON DELETE NO frob")).toThrow(/Expected "action" but found "frob"/);
    expect(create("REFERENCES p MATCH frob")).toThrow(/Expected "full" or "partial" or "simple" but found "frob"/);
    expect(create("UNIQUE INITIALLY frob")).toThrow(/Expected "deferred" or "immediate" but found "frob"/);
    // A constraint that can never be deferred cannot start out deferred. The
    // error sits on whichever clause completes the contradiction.
    expect(create("UNIQUE NOT DEFERRABLE INITIALLY DEFERRED")).toThrow(
      /constraint declared INITIALLY DEFERRED must be DEFERRABLE \(1:44\)/,
    );
    expect(create("UNIQUE INITIALLY DEFERRED NOT DEFERRABLE")).toThrow(
      /constraint declared INITIALLY DEFERRED must be DEFERRABLE \(1:48\)/,
    );
    // PG's "misplaced DEFERRABLE clause": only UNIQUE, PRIMARY KEY and foreign
    // keys take the attributes.
    expect(create("NOT NULL DEFERRABLE")).toThrow(/Expected "," but found "deferrable"/);
    expect(create("CHECK (c > 0) DEFERRABLE")).toThrow(/Expected "," but found "deferrable"/);
    expect(() => sqlLite.parse("CREATE TABLE t (c int, CHECK (c > 0) INITIALLY DEFERRED);")).toThrow(
      /Expected "," but found "initially"/,
    );
  });
});

// --- index column options and storage parameters ---

describe("SQL-lite index column options and storage parameters", () => {
  const index = (tail: string) => firstStmt(`CREATE INDEX i ON t ${tail};`) as any;
  const columns = (list: string) => index(`(${list})`).columns;
  const lower = (arg: unknown) => ({ kind: "call", name: "lower", args: [arg] });

  it("parses an operator class, ASC / DESC and NULLS FIRST / LAST per column", () => {
    expect(columns("a text_pattern_ops DESC NULLS LAST, b ASC, c NULLS FIRST, d")).toEqual([
      { expr: name("a"), opclass: ["text_pattern_ops"], dir: "desc", nulls: "last" },
      { expr: name("b"), dir: "asc" },
      { expr: name("c"), nulls: "first" },
      { expr: name("d") },
    ]);
    // An expression column takes them too, and the class may be qualified or quoted.
    expect(columns('lower(a) pg_catalog.text_pattern_ops, b "My Ops" DESC')).toEqual([
      { expr: lower(name("a")), opclass: ["pg_catalog", "text_pattern_ops"] },
      { expr: name("b"), opclass: ["My Ops"], dir: "desc" },
    ]);
  });

  it("keeps COLLATE on the expression and takes operator-class parameters", () => {
    expect(columns('a COLLATE "C" varchar_pattern_ops')).toEqual([
      { expr: { kind: "collate", expr: name("a"), collation: ["C"] }, opclass: ["varchar_pattern_ops"] },
    ]);
    expect(columns("a gist_trgm_ops (siglen = 32) DESC")).toEqual([
      {
        expr: name("a"),
        opclass: ["gist_trgm_ops"],
        opclassOptions: [{ name: "siglen", value: num(32) }],
        dir: "desc",
      },
    ]);
  });

  it("parses WITH (storage parameters) between INCLUDE and WHERE", () => {
    const idx = index("USING gin (a) INCLUDE (b) WITH (fastupdate = off, gin_pending_list_limit = 128) WHERE a > 0");
    expect(idx).toMatchObject({ using: "gin", include: ["b"], where: bin(">", name("a"), num(0)) });
    expect(idx.options).toEqual([
      { name: "fastupdate", value: name("off") },
      { name: "gin_pending_list_limit", value: num(128) },
    ]);
    // Omitted, the key is absent rather than null.
    expect("options" in index("(a)")).toBe(false);
  });

  it("leaves nulls, first and last usable as names", () => {
    // As columns, as an operator class, and `nulls` alone with no FIRST/LAST after it.
    expect(columns("nulls, first, last")).toEqual([
      { expr: name("nulls") },
      { expr: name("first") },
      { expr: name("last") },
    ]);
    expect(columns("first nulls")).toEqual([{ expr: name("first"), opclass: ["nulls"] }]);
    expect(columns("nulls nulls first")).toEqual([{ expr: name("nulls"), nulls: "first" }]);
    expect(columns("a nulls nulls last")).toEqual([{ expr: name("a"), opclass: ["nulls"], nulls: "last" }]);
    expect(columns("a last DESC")).toEqual([{ expr: name("a"), opclass: ["last"], dir: "desc" }]);
    expect(firstStmt("SELECT nulls, first, last FROM t;")).toEqual(
      sel({ columns: [col(name("nulls")), col(name("first")), col(name("last"))], from: [tableFrom(["t"])] }),
    );
  });

  it("rejects a malformed column option or storage parameter list", () => {
    expect(() => sqlLite.parse("CREATE INDEX i ON t (a DESC NULLS);")).toThrow(
      /Expected "first" or "last" but found "\)"/,
    );
    expect(() => sqlLite.parse("CREATE INDEX i ON t (a DESC ASC);")).toThrow(/Expected "," but found "asc"/);
    expect(() => sqlLite.parse("CREATE INDEX i ON t (a) WITH fillfactor = 70;")).toThrow(
      /Expected "\(" but found "fillfactor"/,
    );
  });
});

// --- EXCLUDE table constraints ---

describe("SQL-lite EXCLUDE table constraints", () => {
  const items = (src: string) => (firstStmt(`CREATE TABLE t (${src});`) as any).items as Record<string, unknown>[];
  const addAction = (src: string) => (firstStmt(`ALTER TABLE t ADD ${src};`) as any).actions[0];

  it("parses EXCLUDE [USING method] (element WITH operator, …)", () => {
    expect(items("c int, EXCLUDE USING gist (c WITH =)")[1]).toEqual({
      kind: "exclude",
      name: null,
      using: "gist",
      elements: [{ expr: name("c"), operator: "=" }],
    });
    // No USING is PG's default btree; several elements, any operator.
    expect(items("EXCLUDE (a WITH =, b WITH &&)")).toEqual([
      {
        kind: "exclude",
        name: null,
        using: null,
        elements: [
          { expr: name("a"), operator: "=" },
          { expr: name("b"), operator: "&&" },
        ],
      },
    ]);
    // An element may be a call or a parenthesised expression.
    const [call, paren] = (items("EXCLUDE USING gist (tsrange(s, e) WITH &&, (a + 1) WITH =)")[0] as any).elements;
    expect(call.expr.kind).toBe("call");
    expect(call.operator).toBe("&&");
    expect(paren.expr).toMatchObject({ kind: "binary", op: "+" });
  });

  it("takes INCLUDE, WHERE and the DEFERRABLE / INITIALLY tail", () => {
    expect(
      items("EXCLUDE USING gist (r WITH &&) INCLUDE (a, b) WHERE (active) DEFERRABLE INITIALLY DEFERRED")[0],
    ).toEqual({
      kind: "exclude",
      name: null,
      using: "gist",
      elements: [{ expr: name("r"), operator: "&&" }],
      include: ["a", "b"],
      where: name("active"),
      deferrable: true,
      initially: "deferred",
    });
    expect(items("EXCLUDE (a WITH =) NOT DEFERRABLE")[0]).toMatchObject({ deferrable: false });
    expect(() => sqlLite.parse("CREATE TABLE t (EXCLUDE (a WITH =) NOT DEFERRABLE INITIALLY DEFERRED);")).toThrow(
      /constraint declared INITIALLY DEFERRED must be DEFERRABLE/,
    );
  });

  it("names the constraint with CONSTRAINT n, in CREATE TABLE and ALTER TABLE ADD", () => {
    expect(items("CONSTRAINT no_overlap EXCLUDE USING gist (r WITH &&)")[0]).toMatchObject({
      kind: "exclude",
      name: "no_overlap",
      using: "gist",
    });
    expect(addAction("CONSTRAINT no_overlap EXCLUDE USING gist (r WITH &&)")).toEqual({
      kind: "addConstraint",
      name: "no_overlap",
      constraint: { kind: "exclude", name: null, using: "gist", elements: [{ expr: name("r"), operator: "&&" }] },
    });
    // The keyword-led constraints still reach CONSTRAINT n unchanged.
    expect(addAction("CONSTRAINT u UNIQUE (a)")).toMatchObject({ name: "u", constraint: { kind: "unique" } });
  });

  it("parses a bare ALTER TABLE … ADD EXCLUDE", () => {
    expect(addAction("EXCLUDE USING gist (r WITH &&)")).toMatchObject({
      kind: "addConstraint",
      name: null,
      constraint: { kind: "exclude", using: "gist" },
    });
    expect(addAction("EXCLUDE (a WITH =)")).toMatchObject({
      kind: "addConstraint",
      constraint: { kind: "exclude", using: null },
    });
  });

  it("keeps a column called exclude a column definition", () => {
    const column = (dataType: string, array = false) => ({
      kind: "column",
      name: "exclude",
      dataType: { name: dataType, args: [], array },
      constraints: [],
    });
    expect(items("exclude text")).toEqual([column("text")]);
    expect(items("exclude int[]")).toEqual([column("int", true)]);
    expect(items('exclude "using"')).toEqual([column("using")]);
    expect(items("exclude int, EXCLUDE (exclude WITH =)").map((i) => i.kind)).toEqual(["column", "exclude"]);
    expect(addAction("exclude text")).toEqual({
      kind: "addColumn",
      ifNotExists: false,
      column: column("text"),
    });
    expect(addAction('exclude "using"')).toMatchObject({ kind: "addColumn", column: { name: "exclude" } });
    expect(addAction("COLUMN exclude text")).toMatchObject({ kind: "addColumn", column: { name: "exclude" } });
    expect(
      (firstStmt("ALTER TABLE t ADD EXCLUDE (a WITH =), ADD exclude text;") as any).actions.map((a: any) => a.kind),
    ).toEqual(["addConstraint", "addColumn"]);
    // A quoted "exclude" is a name, never the keyword.
    expect(() => sqlLite.parse('CREATE TABLE t ("exclude" (a WITH =));')).toThrow(/Expected a name but found "\("/);
  });

  it("keeps exclude and include unreserved as names and aliases", () => {
    expect((firstStmt("SELECT exclude, include FROM t;") as any).columns).toEqual([
      col(name("exclude")),
      col(name("include")),
    ]);
    expect((firstStmt("SELECT a AS exclude, b include FROM t;") as any).columns).toEqual([
      col(name("a"), "exclude"),
      col(name("b"), "include"),
    ]);
    expect(items("include int").map((i) => i.name)).toEqual(["include"]);
  });

  it("reports a bad character after exclude as after any column name", () => {
    const { ast, errors } = sqlLite.diagnose("CREATE TABLE t (id int, exclude é, ok text);");
    expect(errors.map((e) => e.message)).toEqual(['Unexpected character "é" (1:32)']);
    expect((stripSpans(ast) as any)[0].items.map((i: any) => i.name)).toEqual(["id", "ok"]);
    expect(sqlLite.diagnose("CREATE TABLE t (EXCLUDE (a WITH é));").errors[0]!.message).toBe(
      'Unexpected character "é" (1:32)',
    );
  });

  it("rejects a malformed EXCLUDE", () => {
    // In a table body the EXCLUDE reports its own error, not a column's.
    expect(() => sqlLite.parse("CREATE TABLE t (EXCLUDE (a));")).toThrow(/Expected "with" but found "\)" \(1:26\)/);
    expect(() => sqlLite.parse("CREATE TABLE t (EXCLUDE USING gist);")).toThrow(/Expected "\(" but found "\)"/);
    expect(() => sqlLite.parse("CREATE TABLE t (EXCLUDE (a WITH =) INCLUDE ());")).toThrow(
      /Expected a name but found "\)"/,
    );
    expect(() => sqlLite.parse("CREATE TABLE t (CONSTRAINT c 42);")).toThrow(
      /Expected "primary key" or "unique" or "check" or "foreign key" or "exclude" but found "42"/,
    );
    expect(() => sqlLite.parse("ALTER TABLE t ADD EXCLUDE (a);")).toThrow(/Expected "with" but found "\)"/);
    expect(() => sqlLite.parse("ALTER TABLE t ADD EXCLUDE USING gist (a WITH b);")).toThrow(
      /Expected an operator but found "b"/,
    );
    expect(() => sqlLite.parse("ALTER TABLE t ADD CONSTRAINT c EXCLUDE (a WITH =) WHERE a;")).toThrow(
      /Expected "\(" but found "a"/,
    );
    // An EXCLUDE with no elements is a syntax error, as in PG.
    expect(() => sqlLite.parse("ALTER TABLE t ADD CONSTRAINT c EXCLUDE ();")).toThrow(
      /Expected a number or .* or a name but found "\)" \(1:40\)/,
    );
  });
});

// --- parenthesised joins, ROWS FROM and WITH ORDINALITY ---

describe("SQL-lite parenthesised joins, ROWS FROM and WITH ORDINALITY", () => {
  const from = (src: string) => (firstStmt(src) as any).from;
  const call = (fnName: string, args: unknown[] = []) => ({ kind: "call", name: fnName, args });
  const bool = (value: boolean) => ({ kind: "bool", value });
  const join = (left: unknown, right: unknown, extra: Record<string, unknown> = {}) => ({
    kind: "join",
    joinType: "inner",
    left,
    right,
    on: bool(true),
    using: null,
    ...extra,
  });

  it("parses a parenthesised join, bare and aliased", () => {
    const ab = join(tableFrom(["a"]), tableFrom(["b"]));
    // The parentheses only group: unaliased, the item is the join node itself.
    expect(from("SELECT * FROM (a JOIN b ON true);")).toEqual([ab]);
    expect(from("SELECT * FROM (a JOIN b ON true) AS x;")).toEqual([{ ...ab, alias: "x" }]);
    expect(from("SELECT * FROM (a JOIN b ON true) x (c, d);")).toEqual([{ ...ab, alias: "x", columns: ["c", "d"] }]);
    // A parenthesised join is an operand of further joins, on either side.
    expect(from("SELECT * FROM (a JOIN b ON true) JOIN c ON true;")).toEqual([join(ab, tableFrom(["c"]))]);
    expect(from("SELECT * FROM c LEFT JOIN (a JOIN b ON true) ON true;")).toEqual([
      join(tableFrom(["c"]), ab, { joinType: "left" }),
    ]);
  });

  it("parses nested parenthesised joins", () => {
    const ab = join(tableFrom(["a"]), tableFrom(["b"]));
    expect(from("SELECT * FROM ((a JOIN b ON true));")).toEqual([ab]);
    expect(from("SELECT * FROM ((a JOIN b ON true) j JOIN c ON true);")).toEqual([
      join({ ...ab, alias: "j" }, tableFrom(["c"])),
    ]);
    // A subquery on the left of a parenthesised join — a run of `(` ahead of a
    // query word that opens a join, however many groups wrap it.
    expect(from("SELECT * FROM ((SELECT 1) s JOIN b ON true);")).toEqual([
      join({ kind: "subquery", query: sel({ columns: [col(num(1))] }), alias: "s" }, tableFrom(["b"])),
    ]);
    expect(from("SELECT * FROM ((VALUES (1)) v JOIN b ON true) j;")[0]).toMatchObject({
      kind: "join",
      left: { kind: "subquery", query: { kind: "values" }, alias: "v" },
      alias: "j",
    });
  });

  it("reads a wrapped join whose left side is a subquery as a join", () => {
    const sb = join({ kind: "subquery", query: sel({ columns: [col(num(1))] }), alias: "s" }, tableFrom(["b"]));
    expect(from("SELECT * FROM (((SELECT 1) s JOIN b ON true));")).toEqual([sb]);
    expect(from("SELECT * FROM ((((SELECT 1)) s JOIN b ON true)) x;")).toEqual([{ ...sb, alias: "x" }]);
    expect(from("SELECT * FROM (((VALUES (1)) v JOIN b ON true));")[0]).toMatchObject({
      kind: "join",
      left: { kind: "subquery", query: { kind: "values" }, alias: "v" },
    });
  });

  it("decides a deep nesting by a scan, without re-reading each level", () => {
    // Each level wraps the last in `((SELECT * FROM …) s JOIN b ON true)`; a
    // backtracking dispatch re-parsed every level on its fallback, doubling the
    // work per level.
    let item = "t";
    for (let i = 0; i < 24; i++) item = `((SELECT * FROM ${item}) s JOIN b ON true)`;
    // An exponential dispatch would run past the test timeout.
    expect(from(`SELECT * FROM ${item};`)[0].kind).toBe("join");
  });

  it("keeps nested-paren FROM subqueries subqueries", () => {
    expect(from("SELECT * FROM ((SELECT 1) UNION (SELECT 2)) x;")).toEqual([
      {
        kind: "subquery",
        query: {
          kind: "setOp",
          op: "union",
          left: sel({ columns: [col(num(1))] }),
          right: sel({ columns: [col(num(2))] }),
        },
        alias: "x",
      },
    ]);
    expect(from("SELECT * FROM ((SELECT 1)) x;")).toEqual([
      { kind: "subquery", query: sel({ columns: [col(num(1))] }), alias: "x" },
    ]);
    expect(from("SELECT * FROM (((VALUES (1)))) v JOIN b ON true;")[0].left).toMatchObject({
      kind: "subquery",
      query: { kind: "values" },
      alias: "v",
    });
  });

  it("parses WITH ORDINALITY on a table function", () => {
    expect(from("SELECT * FROM unnest(a) WITH ORDINALITY;")).toEqual([
      { kind: "function", call: call("unnest", [name("a")]), alias: null, ordinality: true },
    ]);
    expect(from("SELECT * FROM unnest(a) WITH ORDINALITY AS u (x, n);")).toEqual([
      { kind: "function", call: call("unnest", [name("a")]), alias: "u", columns: ["x", "n"], ordinality: true },
    ]);
    expect(from("SELECT * FROM t, LATERAL unnest(t.a) WITH ORDINALITY u;")[1]).toEqual({
      kind: "function",
      call: call("unnest", [name("t", "a")]),
      alias: "u",
      lateral: true,
      ordinality: true,
    });
  });

  it("parses ROWS FROM", () => {
    expect(from("SELECT * FROM ROWS FROM (f(1), g());")).toEqual([
      { kind: "rowsFrom", calls: [call("f", [num(1)]), call("g")], alias: null },
    ]);
    expect(from("SELECT * FROM ROWS FROM (s.f()) WITH ORDINALITY AS r (a, n);")).toEqual([
      { kind: "rowsFrom", calls: [call("s.f")], alias: "r", columns: ["a", "n"], ordinality: true },
    ]);
    expect(from("SELECT * FROM t CROSS JOIN LATERAL ROWS FROM (f(t.a)) r;")[0].right).toEqual({
      kind: "rowsFrom",
      calls: [call("f", [name("t", "a")])],
      alias: "r",
      lateral: true,
    });
  });

  it("leaves a WITH that is not WITH ORDINALITY to the enclosing statement", () => {
    expect(firstStmt("CREATE MATERIALIZED VIEW mv AS SELECT * FROM f() WITH NO DATA;")).toMatchObject({
      withData: false,
    });
    expect(firstStmt("CREATE MATERIALIZED VIEW mv AS SELECT * FROM f() WITH ORDINALITY WITH NO DATA;")).toMatchObject({
      query: { from: [{ kind: "function", ordinality: true }] },
      withData: false,
    });
  });

  it("keeps rows and ordinality unreserved as names and aliases", () => {
    expect(from("SELECT * FROM rows;")).toEqual([tableFrom(["rows"])]);
    expect(from("SELECT * FROM rows ordinality JOIN b ON true;")[0].left).toEqual(tableFrom(["rows"], "ordinality"));
    expect(from("SELECT * FROM rows (1) AS rows (ordinality);")).toEqual([
      { kind: "function", call: call("rows", [num(1)]), alias: "rows", columns: ["ordinality"] },
    ]);
    expect(from("SELECT * FROM f() ordinality;")).toEqual([{ kind: "function", call: call("f"), alias: "ordinality" }]);
    expect(firstStmt("CREATE TABLE rows (ordinality int);")).toMatchObject({
      name: ["rows"],
      items: [{ name: "ordinality" }],
    });
    expect((firstStmt("SELECT ordinality, rows FROM t;") as any).columns).toEqual([
      col(name("ordinality")),
      col(name("rows")),
    ]);
  });

  it("spans each ROWS FROM call from its own name", () => {
    const [stmt] = sqlLite.parse("SELECT * FROM LATERAL ROWS FROM (f(1), s.g()) WITH ORDINALITY;") as any[];
    const spans = stmt.from[0].calls.map((c: any) => [c.span.start.col, c.span.end.col]);
    expect(spans).toEqual([
      [33, 37],
      [39, 44],
    ]);
  });

  it("rejects malformed parenthesised joins and ROWS FROM", () => {
    // PG's parentheses hold a join, and one that is not itself aliased.
    expect(() => sqlLite.parse("SELECT * FROM (a);")).toThrow(/Expected a join but found "\)"/);
    expect(() => sqlLite.parse("SELECT * FROM ((a JOIN b ON true) x);")).toThrow(
      /Expected a join without an alias but found "\)"/,
    );
    expect(() => sqlLite.parse("SELECT * FROM (a JOIN b ON true;")).toThrow(/Expected "\)" but found ";"/);
    expect(() => sqlLite.parse("SELECT * FROM ((SELECT 1);")).toThrow(/Expected "\)" but found ";"/);
    // A `(` ahead of a token that opens neither keeps the query reading's error.
    expect(() => sqlLite.parse("SELECT * FROM (1);")).toThrow(/Expected "select" or "values" or "\(" but found "1"/);
    expect(() => sqlLite.parse("SELECT * FROM (;")).toThrow(/Expected "select" or "values" or "\(" but found ";"/);
    expect(() => sqlLite.parse("SELECT * FROM ((TABLE t)) x;")).toThrow(
      /Expected "select" or "values" or "\(" but found "table"/,
    );
    // A trailing query clause continues a query, which sql-lite reads no ORDER
    // BY after when parenthesised; the run still takes the query reading.
    expect(() => sqlLite.parse("SELECT * FROM ((SELECT 1) ORDER BY 1) x;")).toThrow(/Expected "\)" but found "order"/);
    // LATERAL takes no parenthesised join, as in PG: its `(` is a subquery.
    expect(() => sqlLite.parse("SELECT * FROM LATERAL (a JOIN b ON true);")).toThrow(/Expected "select"/);
    expect(() => sqlLite.parse("SELECT * FROM ROWS FROM ();")).toThrow(/Expected a name but found "\)"/);
    expect(() => sqlLite.parse("SELECT * FROM ROWS FROM (f);")).toThrow(/Expected "\(" but found "\)"/);
    expect(() => sqlLite.parse("SELECT * FROM t WITH ORDINALITY;")).toThrow(/Expected ";" but found "with"/);
  });
});

// --- ALTER SCHEMA, DOMAIN, TYPE and INDEX ---

describe("SQL-lite ALTER SCHEMA, DOMAIN, TYPE and INDEX", () => {
  const alter = (text: string) => firstStmt(text) as any;
  const action = (text: string) => alter(text).action;
  const fails = (text: string) => () => sqlLite.parse(text);

  it("parses ALTER SCHEMA RENAME TO and OWNER TO", () => {
    expect(alter("ALTER SCHEMA s RENAME TO n;")).toEqual({
      kind: "alterSchema",
      name: "s",
      action: { kind: "rename", to: "n" },
    });
    expect(action("ALTER SCHEMA s OWNER TO r;")).toEqual({ kind: "ownerTo", owner: "r" });
  });

  it("parses the ALTER DOMAIN default, NOT NULL and constraint actions", () => {
    const domain = (src: string) => action(`ALTER DOMAIN d ${src};`);
    expect(alter("ALTER DOMAIN s.d SET DEFAULT 1;")).toEqual({
      kind: "alterDomain",
      name: ["s", "d"],
      action: { kind: "setDefault", expr: num(1) },
    });
    expect(domain("DROP DEFAULT")).toEqual({ kind: "dropDefault" });
    expect(domain("SET NOT NULL")).toEqual({ kind: "setNotNull" });
    expect(domain("DROP NOT NULL")).toEqual({ kind: "dropNotNull" });
    expect(domain("ADD CONSTRAINT c CHECK (VALUE > 0) NOT VALID")).toEqual({
      kind: "addConstraint",
      constraint: { kind: "check", name: "c", expr: bin(">", name("value"), num(0)) },
      notValid: true,
    });
    expect(domain("ADD CHECK (VALUE <> '')")).toMatchObject({ constraint: { name: null }, notValid: false });
    const drop = { kind: "dropConstraint", ifExists: true, name: "c", behavior: "cascade" };
    expect(domain("DROP CONSTRAINT IF EXISTS c CASCADE")).toEqual(drop);
    expect(domain("DROP CONSTRAINT c")).toEqual({ ...drop, ifExists: false, behavior: null });
    expect(domain("RENAME CONSTRAINT a TO b")).toEqual({ kind: "renameConstraint", from: "a", to: "b" });
    expect(domain("VALIDATE CONSTRAINT c")).toEqual({ kind: "validateConstraint", name: "c" });
  });

  it("parses RENAME TO, OWNER TO and SET SCHEMA on a domain and a type", () => {
    for (const target of ["DOMAIN", "TYPE"]) {
      expect(action(`ALTER ${target} x RENAME TO y;`)).toEqual({ kind: "rename", to: "y" });
      expect(action(`ALTER ${target} x OWNER TO r;`)).toEqual({ kind: "ownerTo", owner: "r" });
      expect(action(`ALTER ${target} x SET SCHEMA s;`)).toEqual({ kind: "setSchema", schema: "s" });
    }
  });

  it("parses ALTER TYPE ADD VALUE and RENAME VALUE", () => {
    const addValue = { kind: "addValue", ifNotExists: false, value: "meh", position: null };
    expect(alter("ALTER TYPE s.mood ADD VALUE 'meh';")).toEqual({
      kind: "alterType",
      name: ["s", "mood"],
      action: addValue,
    });
    expect(action("ALTER TYPE mood ADD VALUE IF NOT EXISTS 'meh' BEFORE 'sad';")).toEqual({
      ...addValue,
      ifNotExists: true,
      position: { placement: "before", value: "sad" },
    });
    const after = action("ALTER TYPE mood ADD VALUE 'meh' AFTER 'ok';");
    expect(after.position).toEqual({ placement: "after", value: "ok" });
    const rename = action("ALTER TYPE mood RENAME VALUE 'sad' TO 'blue';");
    expect(rename).toEqual({ kind: "renameValue", from: "sad", to: "blue" });
  });

  it("parses ALTER INDEX [IF EXISTS] RENAME, and SET TABLESPACE / SET / RESET as a list", () => {
    expect(alter("ALTER INDEX IF EXISTS s.i RENAME TO j;")).toEqual({
      kind: "alterIndex",
      ifExists: true,
      name: ["s", "i"],
      actions: [{ kind: "rename", to: "j" }],
    });
    const opt = (name: string, value: unknown = null) => ({ name, value });
    expect(
      alter("ALTER INDEX i SET TABLESPACE fast, SET (fillfactor = 70, d = off), RESET (fillfactor);").actions,
    ).toEqual([
      { kind: "setTablespace", tablespace: "fast" },
      { kind: "setOptions", options: [opt("fillfactor", num(70)), opt("d", name("off"))] },
      { kind: "resetOptions", options: [opt("fillfactor")] },
    ]);
  });

  it("spans the whole statement, from ALTER through the action", () => {
    const [stmt] = sqlLite.parse("ALTER DOMAIN d SET SCHEMA archive;") as Record<string, any>[];
    expect(stmt!.span).toEqual({ start: { row: 1, col: 0 }, end: { row: 1, col: 33 } });
  });

  it("keeps the new ALTER words unreserved as names and aliases", () => {
    const words = ["schema", "domain", "value", "before", "after", "owner", "tablespace", "validate", "valid", "reset"];
    expect(firstStmt(`SELECT ${words.join(", ")} FROM t;`).columns.map((c: any) => c.expr)).toEqual(
      words.map((word) => name(word)),
    );
    expect(firstStmt("SELECT 1 AS value, 2 before FROM schema AS domain;")).toMatchObject({
      columns: [{ alias: "value" }, { alias: "before" }],
      from: [{ name: ["schema"], alias: "domain" }],
    });
    // …and as the names of the objects being altered.
    expect(alter("ALTER SCHEMA schema RENAME TO domain;")).toMatchObject({ name: "schema", action: { to: "domain" } });
    expect(alter("ALTER DOMAIN domain DROP CONSTRAINT valid RESTRICT;")).toMatchObject({
      name: ["domain"],
      action: { name: "valid", behavior: "restrict" },
    });
    expect(alter("ALTER TYPE value ADD VALUE 'before' AFTER 'after';")).toMatchObject({ name: ["value"] });
    expect(alter("ALTER INDEX reset SET TABLESPACE tablespace;")).toMatchObject({
      name: ["reset"],
      actions: [{ tablespace: "tablespace" }],
    });
    // IF / EXISTS stay usable as an index or constraint name.
    expect(alter("ALTER INDEX if RENAME TO exists;")).toMatchObject({ ifExists: false, name: ["if"] });
    expect(action("ALTER DOMAIN d DROP CONSTRAINT if;")).toMatchObject({ ifExists: false, name: "if" });
  });

  it("rejects an unknown action, a misplaced word and a valued RESET", () => {
    expect(fails("ALTER SCHEMA s SET SCHEMA t;")).toThrow(/Expected "rename" or "owner" but found "set"/);
    expect(fails("ALTER DOMAIN d frobnicate;")).toThrow(
      /Expected "set", "drop", "add", "rename", "owner" or "validate" but found "frobnicate"/,
    );
    expect(fails("ALTER TYPE t frobnicate;")).toThrow(
      /Expected "add", "rename", "owner" or "set" but found "frobnicate"/,
    );
    expect(fails("ALTER INDEX i frobnicate;")).toThrow(/Expected "rename", "set" or "reset" but found "frobnicate"/);
    expect(fails("ALTER DOMAIN d SET frob;")).toThrow(/Expected "default", "not" or "schema" but found "frob"/);
    expect(fails("ALTER DOMAIN d DROP frob;")).toThrow(/Expected "default", "not" or "constraint" but found "frob"/);
    expect(fails("ALTER DOMAIN d ADD UNIQUE (a);")).toThrow(/Expected "check" but found "unique"/);
    expect(fails("ALTER TYPE t ADD VALUE meh;")).toThrow(/Expected a string but found "meh"/);
    expect(fails("ALTER TYPE t ADD VALUE 'a' BEFORE b;")).toThrow(/Expected a string but found "b"/);
    expect(fails("ALTER INDEX i SET TABLESPACE t, RENAME TO j;")).toThrow(
      /RENAME cannot be combined with other ALTER INDEX actions/,
    );
    expect(fails("ALTER INDEX i SET frob;")).toThrow(/Expected "\(" or "tablespace" but found "frob"/);
    // One action only, and a quoted word is a name, never a keyword.
    expect(fails("ALTER SCHEMA s RENAME TO n, OWNER TO r;")).toThrow(/Expected ";" but found ","/);
    expect(fails('ALTER DOMAIN d RENAME "constraint" a TO b;')).toThrow(
      /Expected "constraint" or "to" but found "constraint"/,
    );
    expect(fails("ALTER TYPE t RENAME \"value\" 'a' TO 'b';")).toThrow(/Expected "value" or "to" but found "value"/);
    expect(fails("ALTER TYPE t RENAME ATTRIBUTE a TO b;")).toThrow(/Expected "value" or "to" but found "attribute"/);
    expect(fails("ALTER TYPE t SET frob;")).toThrow(/Expected "schema" but found "frob"/);
    expect(fails("ALTER DOMAIN d ADD CHECK (VALUE > 0) NOT frob;")).toThrow(/Expected "valid" but found "frob"/);
    expect(fails("ALTER TYPE t ADD VALUE 'a' BEFORE 'b' AFTER 'c';")).toThrow(/Expected ";" but found "after"/);
    expect(fails("ALTER INDEX i RESET (a, fillfactor = 70);")).toThrow(
      /RESET must not include values for parameters \(1:24\)/,
    );
  });
});

// --- ALTER FUNCTION, AGGREGATE, VIEW and SEQUENCE ---

describe("SQL-lite ALTER FUNCTION, AGGREGATE, VIEW and SEQUENCE", () => {
  const alter = (text: string) => firstStmt(text) as any;
  const action = (text: string) => alter(text).action;
  const fails = (text: string) => () => sqlLite.parse(text);
  const arg = (type: string, argName: string | null = null) => ({
    mode: null,
    name: argName,
    type: { name: type, args: [], array: false },
    defaultValue: null,
  });

  it("parses ALTER FUNCTION with and without a signature", () => {
    expect(alter("ALTER FUNCTION s.f(double precision, a int) RENAME TO g;")).toEqual({
      kind: "alterFunction",
      name: ["s", "f"],
      args: [arg("double precision"), arg("int", "a")],
      action: { kind: "rename", to: "g" },
    });
    expect(alter("ALTER FUNCTION f OWNER TO r;")).toMatchObject({
      args: null,
      action: { kind: "ownerTo", owner: "r" },
    });
    expect(alter("ALTER FUNCTION f() SET SCHEMA s;")).toMatchObject({
      args: [],
      action: { kind: "setSchema", schema: "s" },
    });
  });

  it("parses ALTER FUNCTION attributes as one run of CREATE FUNCTION's options", () => {
    expect(action("ALTER FUNCTION f(int) IMMUTABLE NOT LEAKPROOF STRICT SECURITY DEFINER COST 5;")).toEqual({
      kind: "options",
      options: [
        { kind: "volatility", value: "immutable" },
        { kind: "leakproof", value: false },
        { kind: "strictness", value: "strict" },
        { kind: "security", external: false, definer: true },
        { kind: "cost", value: num(5) },
      ],
    });
    // SET is SET SCHEMA only when a name follows `schema`; otherwise it sets a parameter.
    expect(action("ALTER FUNCTION f SET search_path = public;").options).toEqual([
      { kind: "set", parameter: "search_path", value: { kind: "list", values: [name("public")] } },
    ]);
    for (const src of ["= 'x'", "TO 'x'", "FROM CURRENT"]) {
      expect(action(`ALTER FUNCTION f SET schema ${src};`).options).toMatchObject([
        { kind: "set", parameter: "schema" },
      ]);
    }
  });

  it("parses ALTER AGGREGATE with a (*) or a type-list signature", () => {
    expect(alter("ALTER AGGREGATE a(*) RENAME TO b;")).toEqual({
      kind: "alterAggregate",
      name: ["a"],
      star: true,
      args: [],
      action: { kind: "rename", to: "b" },
    });
    expect(alter("ALTER AGGREGATE s.a(int, text) SET SCHEMA t;")).toMatchObject({
      star: false,
      args: [arg("int"), arg("text")],
      action: { kind: "setSchema", schema: "t" },
    });
    expect(action("ALTER AGGREGATE a(int) OWNER TO r;")).toEqual({ kind: "ownerTo", owner: "r" });
  });

  it("parses ALTER [MATERIALIZED] VIEW [IF EXISTS] and its action list", () => {
    expect(alter("ALTER VIEW IF EXISTS s.v RENAME COLUMN a TO b;")).toEqual({
      kind: "alterView",
      materialized: false,
      ifExists: true,
      name: ["s", "v"],
      actions: [{ kind: "renameColumn", from: "a", to: "b" }],
    });
    expect(alter("ALTER VIEW v RENAME a TO b;").actions).toEqual([{ kind: "renameColumn", from: "a", to: "b" }]);
    expect(alter("ALTER VIEW v RENAME TO w;").actions).toEqual([{ kind: "rename", to: "w" }]);
    expect(alter("ALTER VIEW v SET SCHEMA s;").actions).toEqual([{ kind: "setSchema", schema: "s" }]);
    const opt = (optName: string) => ({ name: optName, value: null });
    expect(
      alter("ALTER VIEW v ALTER COLUMN c SET DEFAULT 1, ALTER c DROP DEFAULT, OWNER TO r, SET (a), RESET (b);").actions,
    ).toEqual([
      { kind: "setDefault", column: "c", expr: num(1) },
      { kind: "dropDefault", column: "c" },
      { kind: "ownerTo", owner: "r" },
      { kind: "setOptions", options: [opt("a")] },
      { kind: "resetOptions", options: [opt("b")] },
    ]);
    expect(alter("ALTER MATERIALIZED VIEW IF EXISTS m RENAME TO n;")).toEqual({
      kind: "alterView",
      materialized: true,
      ifExists: true,
      name: ["m"],
      actions: [{ kind: "rename", to: "n" }],
    });
  });

  it("parses ALTER SEQUENCE [IF EXISTS] options, RESTART and the shared actions", () => {
    expect(alter("ALTER SEQUENCE IF EXISTS s.q RESTART WITH 5 INCREMENT BY 2 OWNED BY t.id;")).toEqual({
      kind: "alterSequence",
      ifExists: true,
      name: ["s", "q"],
      action: {
        kind: "options",
        options: [
          { kind: "restart", value: num(5) },
          { kind: "increment", value: num(2) },
          { kind: "ownedBy", owner: ["t", "id"] },
        ],
      },
    });
    expect(action("ALTER SEQUENCE q RESTART;").options).toEqual([{ kind: "restart", value: null }]);
    expect(action("ALTER SEQUENCE q RESTART 7 NO CYCLE;").options).toEqual([
      { kind: "restart", value: num(7) },
      { kind: "cycle", value: false },
    ]);
    expect(action("ALTER SEQUENCE q RENAME TO r;")).toEqual({ kind: "rename", to: "r" });
    expect(action("ALTER SEQUENCE q OWNER TO r;")).toEqual({ kind: "ownerTo", owner: "r" });
    expect(action("ALTER SEQUENCE q SET SCHEMA s;")).toEqual({ kind: "setSchema", schema: "s" });
  });

  it("spans the whole statement, from ALTER through the action", () => {
    const [stmt] = sqlLite.parse("ALTER MATERIALIZED VIEW m OWNER TO r;") as Record<string, any>[];
    expect(stmt!.span).toEqual({ start: { row: 1, col: 0 }, end: { row: 1, col: 36 } });
  });

  it("keeps the new ALTER words unreserved as names and aliases", () => {
    const words = [
      "function",
      "aggregate",
      "view",
      "materialized",
      "sequence",
      "restart",
      "immutable",
      "stable",
      "volatile",
      "leakproof",
      "strict",
      "security",
      "owned",
      "increment",
      "called",
      "returns",
      "external",
      "parallel",
      "cost",
      "rows",
      "minvalue",
      "maxvalue",
      "start",
      "cache",
      "cycle",
      "no",
    ];
    expect(firstStmt(`SELECT ${words.join(", ")} FROM t;`).columns.map((c: any) => c.expr)).toEqual(
      words.map((word) => name(word)),
    );
    expect(firstStmt("SELECT 1 AS function, 2 restart FROM sequence AS view;")).toMatchObject({
      columns: [{ alias: "function" }, { alias: "restart" }],
      from: [{ name: ["sequence"], alias: "view" }],
    });
    // …and as the names of the objects being altered.
    expect(alter("ALTER FUNCTION function(immutable) RENAME TO aggregate;")).toMatchObject({
      name: ["function"],
      args: [arg("immutable")],
      action: { to: "aggregate" },
    });
    expect(alter("ALTER AGGREGATE aggregate(*) OWNER TO stable;")).toMatchObject({ name: ["aggregate"] });
    expect(alter("ALTER VIEW view RENAME materialized TO view;").actions).toEqual([
      { kind: "renameColumn", from: "materialized", to: "view" },
    ]);
    expect(alter("ALTER SEQUENCE restart RESTART;")).toMatchObject({ name: ["restart"] });
    expect(alter("ALTER SEQUENCE if RESTART;")).toMatchObject({ ifExists: false, name: ["if"] });
  });

  it("rejects an unknown action, a misplaced word and a combined RENAME or SET SCHEMA", () => {
    expect(fails("ALTER FUNCTION f frobnicate;")).toThrow(
      /Expected "rename", "owner", "set", "immutable", .*, "cost" or "rows" but found "frobnicate"/,
    );
    expect(fails("ALTER FUNCTION f(int) LANGUAGE sql;")).toThrow(/Expected "rename", .* but found "language"/);
    expect(fails("ALTER FUNCTION f NOT NULL;")).toThrow(/Expected "leakproof" but found "null"/);
    expect(fails("ALTER FUNCTION f IMMUTABLE SET SCHEMA s;")).toThrow(/Expected "to" or "=" but found "s"/);
    expect(fails("ALTER AGGREGATE a RENAME TO b;")).toThrow(/Expected "\(" but found "rename"/);
    expect(fails("ALTER AGGREGATE a(*) IMMUTABLE;")).toThrow(
      /Expected "rename", "owner" or "set" but found "immutable"/,
    );
    expect(fails("ALTER VIEW v frobnicate;")).toThrow(
      /Expected "rename", "owner", "set", "reset" or "alter" but found "frobnicate"/,
    );
    expect(fails("ALTER MATERIALIZED VIEW m ALTER c DROP DEFAULT;")).toThrow(
      /Expected "rename", "owner", "set" or "reset" but found "alter"/,
    );
    expect(fails("ALTER MATERIALIZED m RENAME TO n;")).toThrow(/Expected "view" but found "m"/);
    expect(fails("ALTER VIEW v SET frob;")).toThrow(/Expected "\(" or "schema" but found "frob"/);
    expect(fails("ALTER VIEW v ALTER c SET NOT NULL;")).toThrow(/Expected "default" but found "not"/);
    expect(fails("ALTER VIEW v ALTER c TYPE int;")).toThrow(/Expected "set" or "drop" but found "type"/);
    expect(fails("ALTER VIEW v RESET (a = 1);")).toThrow(/RESET must not include values for parameters/);
    expect(fails("ALTER VIEW v OWNER TO r, SET SCHEMA s;")).toThrow(
      /SET SCHEMA cannot be combined with other ALTER VIEW actions/,
    );
    expect(fails("ALTER MATERIALIZED VIEW m RENAME TO n, OWNER TO r;")).toThrow(
      /RENAME cannot be combined with other ALTER MATERIALIZED VIEW actions/,
    );
    expect(fails("ALTER SEQUENCE s frobnicate;")).toThrow(
      /Expected "rename", "owner", "set", "as", .*, "no" or "owned" but found "frobnicate"/,
    );
    expect(fails("ALTER SEQUENCE s NO frob;")).toThrow(/Expected "minvalue", "maxvalue" or "cycle" but found "frob"/);
    expect(fails("ALTER SEQUENCE s SET frob;")).toThrow(/Expected "schema" but found "frob"/);
    expect(fails("ALTER SEQUENCE s RESTART RENAME TO t;")).toThrow(/Expected ";" but found "rename"/);
  });
});

// --- INSERT DEFAULT VALUES, DEFAULT row items, AS alias, OVERRIDING and ON CONSTRAINT ---

describe("SQL-lite INSERT DEFAULT VALUES, DEFAULT row items, AS alias, OVERRIDING and ON CONSTRAINT", () => {
  const insert = (src: string) => firstStmt(`INSERT INTO ${src};`) as any;
  const rows = (src: string) => insert(src).source.rows;
  const conflict = (src: string) => insert(`t VALUES (1) ON CONFLICT ${src}`).onConflict;
  const DEFAULT = { kind: "default" };

  it("parses DEFAULT VALUES, with an alias and the tail clauses", () => {
    expect(insert("t DEFAULT VALUES")).toEqual({
      kind: "insert",
      table: ["t"],
      columns: null,
      source: { kind: "defaultValues" },
      onConflict: null,
      returning: null,
    });
    expect(insert("s.t AS x DEFAULT VALUES ON CONFLICT DO NOTHING RETURNING x.id")).toEqual({
      kind: "insert",
      table: ["s", "t"],
      alias: "x",
      columns: null,
      source: { kind: "defaultValues" },
      onConflict: { target: null, action: { kind: "nothing" } },
      returning: [col(name("x", "id"))],
    });
  });

  it("takes DEFAULT as a VALUES row item, in any row and position", () => {
    expect(rows("t (a, b) VALUES (DEFAULT, 1), (2, DEFAULT)")).toEqual([
      [DEFAULT, num(1)],
      [num(2), DEFAULT],
    ]);
    expect(rows("t VALUES (default)")).toEqual([[DEFAULT]]);
    // The row item carries its own span.
    const [item] = (sqlLite.parse("INSERT INTO t VALUES (DEFAULT);")[0] as any).source.rows[0];
    expect(item.span).toMatchObject({ start: { row: 1, col: 22 }, end: { row: 1, col: 29 } });
  });

  it("parses INSERT INTO t AS alias ahead of the column list and source", () => {
    expect(insert("t AS x (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET a = x.a")).toEqual({
      kind: "insert",
      table: ["t"],
      alias: "x",
      columns: ["a"],
      source: { kind: "values", rows: [[num(1)]] },
      onConflict: {
        target: ["a"],
        action: { kind: "update", set: [{ column: "a", value: name("x", "a") }], where: null },
      },
      returning: null,
    });
    expect(insert("t AS x SELECT 1")).toMatchObject({ alias: "x", source: { kind: "select" } });
    expect(insert('t AS "Q" (SELECT 1)')).toMatchObject({ alias: "Q", columns: null, source: { kind: "select" } });
  });

  it("parses OVERRIDING SYSTEM | USER VALUE before any source", () => {
    expect(insert("t (a) OVERRIDING SYSTEM VALUE VALUES (1)")).toEqual({
      kind: "insert",
      table: ["t"],
      columns: ["a"],
      overriding: "system",
      source: { kind: "values", rows: [[num(1)]] },
      onConflict: null,
      returning: null,
    });
    expect(insert("t OVERRIDING USER VALUE SELECT * FROM u")).toMatchObject({
      columns: null,
      overriding: "user",
      source: { kind: "select" },
    });
    expect(insert("t AS x OVERRIDING user value (SELECT 1)")).toMatchObject({ alias: "x", overriding: "user" });
  });

  it("parses ON CONFLICT ON CONSTRAINT with either action", () => {
    expect(conflict("ON CONSTRAINT t_pkey DO NOTHING")).toEqual({
      target: null,
      constraint: "t_pkey",
      action: { kind: "nothing" },
    });
    expect(conflict('ON CONSTRAINT "T Key" DO UPDATE SET a = 2 WHERE t.a > 0')).toEqual({
      target: null,
      constraint: "T Key",
      action: { kind: "update", set: [{ column: "a", value: num(2) }], where: bin(">", name("t", "a"), num(0)) },
    });
  });

  it("omits the new keys entirely when their clauses are absent", () => {
    const node = insert("t (a) VALUES (1) ON CONFLICT (a) DO NOTHING");
    expect(node).not.toHaveProperty("alias");
    expect(node).not.toHaveProperty("overriding");
    expect(node.onConflict).not.toHaveProperty("constraint");
    expect(conflict("DO NOTHING")).not.toHaveProperty("constraint");
  });

  it("keeps the OVERRIDING words unreserved as names and aliases", () => {
    // `overriding`, `system` and `value` are matched by value only; `user`,
    // `default`, `on`, `constraint` and `as` were already reserved, and
    // `conflict` was already matched by value before this clause.
    const words = ["overriding", "system", "value", "conflict"];
    expect((firstStmt(`SELECT ${words.join(", ")} FROM t;`) as any).columns).toEqual(words.map((w) => col(name(w))));
    expect((firstStmt("SELECT a AS overriding, b value FROM system;") as any).columns).toEqual([
      col(name("a"), "overriding"),
      col(name("b"), "value"),
    ]);
    // …as the table, its alias, the columns and the constraint name.
    expect(insert("overriding AS system (value, conflict) OVERRIDING SYSTEM VALUE VALUES (1, 2)")).toMatchObject({
      table: ["overriding"],
      alias: "system",
      columns: ["value", "conflict"],
      overriding: "system",
    });
    expect(conflict("ON CONSTRAINT overriding DO NOTHING")).toMatchObject({ constraint: "overriding" });
    expect(conflict("ON CONSTRAINT conflict DO NOTHING")).toMatchObject({ constraint: "conflict" });
  });

  it("rejects the misplaced and malformed forms", () => {
    const parse = (src: string) => () => sqlLite.parse(`INSERT INTO ${src};`);
    // DEFAULT VALUES stands alone, as in PG's insert_rest; the message lists
    // every form still open where the source was expected.
    expect(parse("t (a) DEFAULT VALUES")).toThrow(
      /Expected "overriding" or "values" or a query but found "default" \(1:18\)/,
    );
    expect(parse("t OVERRIDING SYSTEM VALUE DEFAULT VALUES")).toThrow(
      /Expected "values" or a query but found "default" \(1:38\)/,
    );
    expect(parse("t AS x (a) DEFAULT VALUES")).toThrow(/found "default" \(1:23\)/);
    expect(parse("t frob")).toThrow(
      /Expected "default values" or "overriding" or "values" or a query but found "frob"/,
    );
    expect(parse("t DEFAULT")).toThrow(/Expected "values" but found ";"/);
    // DEFAULT is a whole row item, never an operand.
    expect(parse("t VALUES (DEFAULT + 1)")).toThrow(/Expected "," but found "\+"/);
    // …and only in INSERT's own bare VALUES rows. A VALUES query rejects it
    // as PG does; a parenthesised VALUES source and SET's right-hand side are
    // limits of this grammar, which PG would accept.
    expect(() => sqlLite.parse("SELECT * FROM (VALUES (DEFAULT)) v;")).toThrow(/Expected a name but found "default"/);
    expect(() => sqlLite.parse("INSERT INTO t (VALUES (DEFAULT));")).toThrow(/Expected a name but found "default"/);
    expect(() => sqlLite.parse("UPDATE t SET a = DEFAULT;")).toThrow(/Expected a name but found "default"/);
    // The alias needs its AS, and AS needs a name.
    expect(parse("t x VALUES (1)")).toThrow(/found "x" \(1:14\)/);
    // (An empty quoted alias is still an alias, not a missing one.)
    expect(insert('t AS "" VALUES (1)')).toHaveProperty("alias", "");
    expect(parse("t AS VALUES (1)")).toThrow(/Expected a name but found "values"/);
    expect(parse("t OVERRIDING frob VALUE VALUES (1)")).toThrow(/Expected "system" or "user" but found "frob"/);
    expect(parse("t OVERRIDING USER VALUES (1)")).toThrow(/Expected "value" but found "values"/);
    expect(parse("t VALUES (1) ON CONFLICT ON frob DO NOTHING")).toThrow(/Expected "constraint" but found "frob"/);
    expect(parse("t VALUES (1) ON CONFLICT ON CONSTRAINT DO NOTHING")).toThrow(/Expected a name but found "do"/);
    expect(parse("t VALUES (1) ON CONFLICT ON CONSTRAINT c (a) DO NOTHING")).toThrow(/Expected "do" but found "\("/);
  });
});

// --- PREPARE and EXECUTE ---

describe("SQL-lite PREPARE and EXECUTE", () => {
  const param = (n: string) => ({ kind: "param", name: n });
  const bodyOf = (src: string) => firstStmt(`PREPARE p AS ${src};`).query;
  const bad = (src: string) => () => sqlLite.parse(src);

  it("parses PREPARE with and without a type list, multi-word types included", () => {
    expect(firstStmt("PREPARE p AS SELECT 1;")).toEqual({
      kind: "prepare",
      name: "p",
      types: null,
      query: sel({ columns: [col(num(1))] }),
    });
    expect(firstStmt("PREPARE q (int, double precision, timestamp(3) with time zone, text[]) AS SELECT $1;")).toEqual({
      kind: "prepare",
      name: "q",
      types: [
        ct("int"),
        ct("double precision"),
        ct("timestamp with time zone", { args: [3] }),
        ct("text", { array: true }),
      ],
      query: sel({ columns: [col(param("1"))] }),
    });
  });

  it("takes any preparable statement as the body, a WITH prefix included", () => {
    expect(bodyOf("VALUES (1)").kind).toBe("values");
    expect(bodyOf("(SELECT 1) UNION SELECT 2")).toMatchObject({ kind: "setOp", op: "union" });
    expect(bodyOf("INSERT INTO t (a) VALUES ($1)")).toMatchObject({ kind: "insert", table: ["t"], columns: ["a"] });
    expect(bodyOf("UPDATE t SET a = $1 WHERE id = $2")).toMatchObject({ kind: "update", table: ["t"] });
    expect(bodyOf("DELETE FROM t WHERE id = $1 RETURNING id")).toMatchObject({ kind: "delete", table: ["t"] });
    expect(bodyOf("WITH x AS (SELECT 1) DELETE FROM t USING x")).toMatchObject({
      kind: "delete",
      with_: [{ name: "x" }],
    });
    // The body owns no `;` of its own: the statement after it parses separately.
    expect(parse("PREPARE p AS SELECT 1; EXECUTE p;").map((s) => s.kind)).toEqual(["prepare", "execute"]);
  });

  it("parses EXECUTE with and without an argument list", () => {
    expect(firstStmt("EXECUTE p;")).toEqual({ kind: "execute", name: "p", args: null });
    expect(firstStmt("EXECUTE \"Q\" (1, 'a' || b, $1);")).toEqual({
      kind: "execute",
      name: "Q",
      args: [num(1), bin("||", str("a"), name("b")), param("1")],
    });
  });

  it("leaves CREATE TRIGGER's EXECUTE FUNCTION untouched", () => {
    expect(firstStmt("CREATE TRIGGER a AFTER INSERT ON t FOR EACH ROW EXECUTE FUNCTION f(1);").execute).toEqual({
      routine: "function",
      name: ["f"],
      args: [num(1)],
    });
  });

  it("keeps prepare, execute and deallocate unreserved", () => {
    expect(firstStmt("SELECT prepare, execute, deallocate FROM prepare;")).toEqual(
      sel({
        columns: [col(name("prepare")), col(name("execute")), col(name("deallocate"))],
        from: [tableFrom(["prepare"])],
      }),
    );
    expect(firstStmt("CREATE TABLE execute (prepare int, deallocate text);").items.map((i: any) => i.name)).toEqual([
      "prepare",
      "deallocate",
    ]);
    // …and as the statement names the three take.
    expect(firstStmt("PREPARE execute AS SELECT prepare FROM t;")).toMatchObject({ kind: "prepare", name: "execute" });
    expect(firstStmt("EXECUTE prepare;")).toEqual({ kind: "execute", name: "prepare", args: null });
    expect(firstStmt("DEALLOCATE execute;")).toEqual({ kind: "deallocate", name: "execute" });
  });

  it("rejects a non-preparable body, a missing AS and an empty list", () => {
    expect(bad("PREPARE p AS CREATE TABLE t (a int);")).toThrow(
      /Expected a SELECT, VALUES, INSERT, UPDATE or DELETE statement but found "create" \(1:13\)/,
    );
    expect(bad("PREPARE p AS EXECUTE q;")).toThrow(/statement but found "execute"/);
    expect(bad("PREPARE p AS;")).toThrow(/statement but found ";"/);
    expect(bad("PREPARE p SELECT 1;")).toThrow(/Expected "as" but found "select"/);
    expect(bad("PREPARE p (int AS SELECT 1;")).toThrow(/Expected "\)" but found "as"/);
    expect(bad("PREPARE p () AS SELECT 1;")).toThrow(/Expected a name but found "\)"/);
    expect(bad("PREPARE s.p AS SELECT 1;")).toThrow(/Expected "as" but found "\."/);
    expect(bad("EXECUTE p ();")).toThrow(/or a name but found "\)" \(1:11\)/);
    expect(bad("EXECUTE;")).toThrow(/Expected a name but found ";"/);
  });
});

// --- generated identity and stored columns and column collation ---

describe("SQL-lite generated identity and stored columns and column collation", () => {
  const colConstraints = (src: string) =>
    (firstStmt(`CREATE TABLE t (c int ${src});`) as any).items[0].constraints as Record<string, unknown>[];
  const bad = (src: string) => () => sqlLite.parse(`CREATE TABLE t (c int ${src});`);

  it("parses GENERATED ALWAYS and BY DEFAULT AS IDENTITY, with and without options", () => {
    expect(colConstraints("GENERATED ALWAYS AS IDENTITY")).toEqual([{ kind: "identity", generated: "always" }]);
    expect(colConstraints("GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY")).toEqual([
      { kind: "identity", generated: "by default" },
      { kind: "primaryKey" },
    ]);
    // The option list is CREATE SEQUENCE's, order-free.
    expect(colConstraints("GENERATED ALWAYS AS IDENTITY (START WITH 10 INCREMENT BY -1 NO CYCLE CACHE 5)")).toEqual([
      {
        kind: "identity",
        generated: "always",
        options: [
          { kind: "start", value: num(10) },
          { kind: "increment", value: { kind: "unary", op: "-", operand: num(1) } },
          { kind: "cycle", value: false },
          { kind: "cache", value: num(5) },
        ],
      },
    ]);
    expect(colConstraints("NOT NULL GENERATED BY DEFAULT AS IDENTITY (AS bigint MINVALUE 1)")).toEqual([
      { kind: "notNull" },
      {
        kind: "identity",
        generated: "by default",
        options: [
          { kind: "as", type: ct("bigint") },
          { kind: "minValue", value: num(1) },
        ],
      },
    ]);
  });

  it("parses GENERATED ALWAYS AS (expr) STORED", () => {
    expect(colConstraints("GENERATED ALWAYS AS (a * 2) STORED NOT NULL")).toEqual([
      { kind: "generated", expr: bin("*", name("a"), num(2)) },
      { kind: "notNull" },
    ]);
    // The span runs from GENERATED through STORED.
    const [stmt] = sqlLite.parse("CREATE TABLE t (c int GENERATED ALWAYS AS (a) STORED);") as any[];
    expect(stmt.items[0].constraints[0].span).toEqual({ start: { row: 1, col: 22 }, end: { row: 1, col: 52 } });
  });

  it("parses a column-level COLLATE straight after the type", () => {
    expect(colConstraints('COLLATE "C" NOT NULL')).toEqual([
      { kind: "collate", collation: ["C"] },
      { kind: "notNull" },
    ]);
    expect(firstStmt("CREATE TABLE t (c text COLLATE app.german DEFAULT 'a');").items[0].constraints).toEqual([
      { kind: "collate", collation: ["app", "german"] },
      { kind: "default", expr: str("a") },
    ]);
    // After a DEFAULT, the expression's COLLATE postfix takes the clause.
    expect(colConstraints(`DEFAULT 'a' COLLATE "C"`)).toEqual([
      { kind: "default", expr: { kind: "collate", expr: str("a"), collation: ["C"] } },
    ]);
  });

  it("reaches ALTER TABLE ADD and PARTITION OF columns", () => {
    expect(firstStmt("ALTER TABLE t ADD COLUMN id int GENERATED ALWAYS AS IDENTITY;").actions[0]).toMatchObject({
      kind: "addColumn",
      column: { name: "id", constraints: [{ kind: "identity", generated: "always" }] },
    });
    expect(firstStmt('CREATE TABLE p PARTITION OF m (b COLLATE "C") DEFAULT;').items[0]).toMatchObject({
      kind: "columnOptions",
      name: "b",
      constraints: [{ kind: "collate", collation: ["C"] }],
    });
  });

  it("keeps generated, always, identity and stored unreserved", () => {
    expect(
      firstStmt("CREATE TABLE t (generated int, identity text, always int, stored int);").items.map((i: any) => i.name),
    ).toEqual(["generated", "identity", "always", "stored"]);
    // …as type names, ahead of a constraint of the same word…
    expect(
      firstStmt("CREATE TABLE t (a stored, b always, c identity);").items.map((i: any) => i.dataType.name),
    ).toEqual(["stored", "always", "identity"]);
    expect(firstStmt("CREATE TABLE t (a generated GENERATED ALWAYS AS IDENTITY);").items[0]).toMatchObject({
      dataType: { name: "generated" },
      constraints: [{ kind: "identity" }],
    });
    // …and as names everywhere else.
    expect(firstStmt("SELECT generated, always, identity, stored FROM generated;")).toEqual(
      sel({
        columns: [col(name("generated")), col(name("always")), col(name("identity")), col(name("stored"))],
        from: [tableFrom(["generated"])],
      }),
    );
    expect(firstStmt("ALTER TABLE t ADD generated int;").actions[0]).toMatchObject({
      kind: "addColumn",
      column: { name: "generated" },
    });
  });

  it("rejects a malformed GENERATED or COLLATE", () => {
    expect(bad("GENERATED ALWAYS AS (a)")).toThrow(/Expected "stored" but found "\)"/);
    expect(bad("GENERATED SOMETIMES AS IDENTITY")).toThrow(
      /Expected "always" or "by default" but found "sometimes" \(1:32\)/,
    );
    // A malformed clause is a plain syntax error first, as in PG.
    expect(bad("GENERATED BY DEFAULT AS (a)")).toThrow(/Expected "stored" but found "\)"/);
    expect(bad("GENERATED BY DEFAULT AS (a) STORED")).toThrow(
      /for a generated column, GENERATED ALWAYS must be specified \(1:32\)/,
    );
    expect(bad("GENERATED ALWAYS IDENTITY")).toThrow(/Expected "as" but found "identity"/);
    expect(bad("GENERATED ALWAYS AS stored")).toThrow(/Expected "identity" or "\(" but found "stored"/);
    expect(bad("GENERATED ALWAYS AS IDENTITY ()")).toThrow(/Expected a sequence option but found "\)"/);
    expect(bad("GENERATED ALWAYS AS IDENTITY (START 1 frob)")).toThrow(/Expected "\)" but found "frob"/);
    expect(bad("COLLATE")).toThrow(/Expected a name but found "\)"/);
  });
});

// --- CREATE DATABASE, SCHEMA, EXTENSION and TABLESPACE ---

describe("SQL-lite CREATE DATABASE, SCHEMA, EXTENSION and TABLESPACE", () => {
  const opt = (optName: string, value: unknown = null) => ({ name: optName, value });
  const bool = (value: boolean) => ({ kind: "bool", value });
  const bad = (src: string) => () => sqlLite.parse(src);

  it("parses CREATE DATABASE with its space-separated options, CONNECTION LIMIT included", () => {
    expect(firstStmt("CREATE DATABASE d;")).toEqual({ kind: "createDatabase", name: "d", options: [] });
    expect(firstStmt('CREATE DATABASE "D" WITH;')).toEqual({ kind: "createDatabase", name: "D", options: [] });
    expect(
      firstStmt(
        "CREATE DATABASE d WITH OWNER = bob TEMPLATE template0 ENCODING 'UTF8' LOCALE = 'C' " +
          "TABLESPACE fast ALLOW_CONNECTIONS true CONNECTION LIMIT = -1 IS_TEMPLATE false;",
      ).options,
    ).toEqual([
      opt("owner", name("bob")),
      opt("template", name("template0")),
      opt("encoding", str("UTF8")),
      opt("locale", str("C")),
      opt("tablespace", name("fast")),
      opt("allow_connections", bool(true)),
      opt("connection limit", num(-1)),
      opt("is_template", bool(false)),
    ]);
    expect(firstStmt("CREATE DATABASE d LC_COLLATE 'C' LC_CTYPE = 'C' CONNECTION LIMIT 5;").options).toEqual([
      opt("lc_collate", str("C")),
      opt("lc_ctype", str("C")),
      opt("connection limit", num(5)),
    ]);
  });

  it("spans a folded CONNECTION LIMIT from CONNECTION through its value", () => {
    const [stmt] = sqlLite.parse("CREATE DATABASE d CONNECTION LIMIT = -1;") as Record<string, any>[];
    expect(stmt!.options[0].span).toEqual({ start: { row: 1, col: 18 }, end: { row: 1, col: 39 } });
  });

  it("parses CREATE SCHEMA with a name, an AUTHORIZATION role or both, and its elements", () => {
    const schema = { kind: "createSchema", ifNotExists: false, name: "s", authorization: null, elements: [] };
    expect(firstStmt("CREATE SCHEMA s;")).toEqual(schema);
    expect(firstStmt("CREATE SCHEMA IF NOT EXISTS s AUTHORIZATION bob;")).toEqual({
      ...schema,
      ifNotExists: true,
      authorization: "bob",
    });
    expect(firstStmt("CREATE SCHEMA AUTHORIZATION bob;")).toEqual({ ...schema, name: null, authorization: "bob" });
    expect(firstStmt("CREATE SCHEMA IF NOT EXISTS AUTHORIZATION bob;")).toMatchObject({
      ifNotExists: true,
      name: null,
    });
    const nested = firstStmt(
      "CREATE SCHEMA s CREATE TABLE t (id int) CREATE VIEW v AS SELECT id FROM t GRANT SELECT ON v TO bob;",
    );
    expect(nested.elements.map((e: any) => e.kind)).toEqual(["createTable", "createView", "grant"]);
    expect(
      firstStmt("CREATE SCHEMA s CREATE OR REPLACE VIEW v AS SELECT 1 CREATE UNIQUE INDEX i ON t (a);").elements.map(
        (e: any) => e.kind,
      ),
    ).toEqual(["createView", "createIndex"]);
    // Each element spans from its own target keyword, as at the top level.
    const [outer] = sqlLite.parse("CREATE SCHEMA s CREATE TABLE t (id int);") as Record<string, any>[];
    expect(outer!.elements[0].span).toEqual({ start: { row: 1, col: 23 }, end: { row: 1, col: 39 } });
    // …and a VIEW or TRIGGER from its CREATE, again as at the top level.
    const [withTrigger] = sqlLite.parse(
      "CREATE SCHEMA s CREATE OR REPLACE TRIGGER tr AFTER INSERT ON t FOR EACH ROW EXECUTE FUNCTION f();",
    ) as Record<string, any>[];
    expect(withTrigger!.elements[0]).toMatchObject({ kind: "createTrigger", orReplace: true, name: "tr" });
    expect(withTrigger!.elements[0].span).toEqual({ start: { row: 1, col: 16 }, end: { row: 1, col: 96 } });
    // The elements own no `;`: the statement after the schema parses separately.
    expect(parse("CREATE SCHEMA s CREATE SEQUENCE q; SELECT 1;").map((st) => st.kind)).toEqual([
      "createSchema",
      "select",
    ]);
  });

  it("takes CURRENT_USER, CURRENT_ROLE and SESSION_USER as a role", () => {
    expect(firstStmt("CREATE SCHEMA AUTHORIZATION CURRENT_USER;")).toMatchObject({ authorization: "current_user" });
    expect(firstStmt("CREATE SCHEMA s AUTHORIZATION current_role;")).toMatchObject({ authorization: "current_role" });
    expect(firstStmt("CREATE TABLESPACE ts OWNER session_user LOCATION 'x';")).toMatchObject({
      owner: "session_user",
    });
  });

  it("reads `if` as a schema or extension name when NOT does not follow it", () => {
    expect(firstStmt("CREATE SCHEMA if AUTHORIZATION bob;")).toMatchObject({ ifNotExists: false, name: "if" });
    expect(firstStmt("CREATE EXTENSION if CASCADE;")).toMatchObject({ ifNotExists: false, name: "if" });
  });

  it("parses CREATE EXTENSION with its options in any order", () => {
    const ext = { kind: "createExtension", ifNotExists: false, name: "hstore", options: [] };
    expect(firstStmt("CREATE EXTENSION hstore;")).toEqual(ext);
    expect(firstStmt("CREATE EXTENSION IF NOT EXISTS hstore WITH SCHEMA public VERSION '1.4' CASCADE;")).toEqual({
      ...ext,
      ifNotExists: true,
      options: [{ kind: "schema", schema: "public" }, { kind: "version", version: "1.4" }, { kind: "cascade" }],
    });
    expect(firstStmt('CREATE EXTENSION "uuid-ossp" CASCADE VERSION v2;')).toEqual({
      ...ext,
      name: "uuid-ossp",
      options: [{ kind: "cascade" }, { kind: "version", version: "v2" }],
    });
  });

  it("parses CREATE TABLESPACE with its owner, location and option list", () => {
    expect(firstStmt("CREATE TABLESPACE ts LOCATION '/data';")).toEqual({
      kind: "createTablespace",
      name: "ts",
      owner: null,
      location: "/data",
      options: [],
    });
    expect(
      firstStmt("CREATE TABLESPACE ts OWNER bob LOCATION '' WITH (seq_page_cost = 1.5, random_page_cost = 2);"),
    ).toEqual({
      kind: "createTablespace",
      name: "ts",
      owner: "bob",
      location: "",
      options: [opt("seq_page_cost", num(1.5)), opt("random_page_cost", num(2))],
    });
  });

  it("spans each target from its own keyword, as CREATE TABLE's does", () => {
    for (const src of [
      "CREATE TABLE t (id int);",
      "CREATE DATABASE d;",
      "CREATE SCHEMA s;",
      "CREATE EXTENSION e;",
      "CREATE TABLESPACE ts LOCATION 'x' WITH (a = 1);",
    ]) {
      const [stmt] = sqlLite.parse(src) as Record<string, any>[];
      expect(stmt!.span).toEqual({ start: { row: 1, col: 7 }, end: { row: 1, col: src.length - 1 } });
    }
  });

  it("keeps the new CREATE words unreserved as names", () => {
    const words = [
      "database",
      "schema",
      "extension",
      "tablespace",
      "location",
      "encoding",
      "version",
      "owner",
      "authorization",
      "connection",
      "cascade",
    ];
    expect(firstStmt(`SELECT ${words.join(", ")} FROM database;`).columns.map((c: any) => c.expr)).toEqual(
      words.map((word) => name(word)),
    );
    const cols = words.map((word) => `${word} text`).join(", ");
    expect(firstStmt(`CREATE TABLE extension (${cols});`).items.map((i: any) => i.name)).toEqual(words);
    // …and as the names these statements create.
    expect(firstStmt("CREATE DATABASE database OWNER owner;")).toMatchObject({
      name: "database",
      options: [opt("owner", name("owner"))],
    });
    expect(firstStmt("CREATE SCHEMA schema AUTHORIZATION authorization;")).toMatchObject({
      name: "schema",
      authorization: "authorization",
    });
    expect(firstStmt("CREATE EXTENSION version SCHEMA schema VERSION version;")).toMatchObject({
      name: "version",
      options: [
        { kind: "schema", schema: "schema" },
        { kind: "version", version: "version" },
      ],
    });
    expect(firstStmt("CREATE TABLESPACE location OWNER owner LOCATION 'x';")).toMatchObject({
      name: "location",
      owner: "owner",
    });
  });

  it("rejects malformed CREATE DATABASE, SCHEMA, EXTENSION and TABLESPACE", () => {
    expect(bad("CREATE DATABASE;")).toThrow(/Expected a name but found ";"/);
    expect(bad("CREATE DATABASE d OWNER;")).toThrow(/Expected an option value but found ";"/);
    expect(bad("CREATE DATABASE d IS_TEMPLATE;")).toThrow(/Expected an option value but found ";"/);
    expect(bad("CREATE DATABASE d CONNECTION LIMIT;")).toThrow(/Expected an option value but found ";"/);
    expect(bad("CREATE DATABASE d (owner = bob);")).toThrow(/Expected ";" but found "\("/);
    expect(bad("CREATE SCHEMA;")).toThrow(/Expected a name but found ";"/);
    expect(bad("CREATE SCHEMA AUTHORIZATION;")).toThrow(/Expected a name but found ";"/);
    // A schema element is one of the CREATE kinds PG admits there, or GRANT.
    // The croak points at the target word, past CREATE and OR REPLACE.
    expect(bad("CREATE SCHEMA s CREATE frobnicate;")).toThrow(
      /Expected "table", "unique", "index", "sequence", "view" or "trigger" but found "frobnicate" \(1:23\)/,
    );
    expect(bad("CREATE SCHEMA s CREATE SCHEMA t CREATE TABLE u (a int);")).toThrow(/or "trigger" but found "schema"/);
    expect(bad("CREATE SCHEMA s CREATE DATABASE d;")).toThrow(/or "trigger" but found "database"/);
    expect(bad("CREATE SCHEMA s CREATE OR REPLACE TABLE t (a int);")).toThrow(
      /Expected "view" or "trigger" but found "table" \(1:34\)/,
    );
    expect(bad("CREATE SCHEMA s CREATE OR TABLE t (a int);")).toThrow(/Expected "replace" but found "table" \(1:26\)/);
    // These two are only told apart once parsed, so they croak over the element.
    expect(bad("CREATE SCHEMA s CREATE TABLE t AS SELECT 1;")).toThrow(/cannot be CREATE TABLE AS \(1:23\)/);
    expect(bad("CREATE SCHEMA s GRANT admin TO bob CREATE TABLE t (a int);")).toThrow(
      /must grant privileges ON an object, not a role \(1:16\)/,
    );
    expect(bad("CREATE SCHEMA IF NOT EXISTS s CREATE TABLE t (a int);")).toThrow(
      /CREATE SCHEMA IF NOT EXISTS cannot include schema elements \(1:30\)/,
    );
    expect(bad("CREATE SCHEMA IF NOT EXIST s;")).toThrow(/Expected "exists" but found "exist"/);
    expect(bad("CREATE EXTENSION e VERSION;")).toThrow(/Expected a name but found ";"/);
    expect(bad("CREATE EXTENSION e SCHEMA 's';")).toThrow(/Expected a name but found "s" \(1:27\)/);
    expect(bad("CREATE TABLESPACE ts;")).toThrow(/Expected "location" but found ";"/);
    expect(bad("CREATE TABLESPACE ts LOCATION data;")).toThrow(/Expected a string but found "data"/);
    expect(bad("CREATE TABLESPACE ts LOCATION 'x' WITH seq_page_cost = 1;")).toThrow(/Expected "\(" but found/);
    expect(bad("CREATE OR REPLACE SCHEMA s;")).toThrow(/Expected "view", "materialized"/);
  });
});

// --- TEMPORARY, UNLOGGED and scoped CREATE TABLE ---

describe("SQL-lite TEMPORARY, UNLOGGED and scoped CREATE TABLE", () => {
  const rawFirst = (text: string) => sqlLite.parse(text)[0] as Record<string, any>;
  const modifiersOf = (src: string) => firstStmt(src).modifiers;
  const bad = (src: string) => () => sqlLite.parse(src);

  it("keeps the PG prefix words in source order, as written", () => {
    expect(modifiersOf("CREATE TEMP TABLE t (id int);")).toEqual(["temp"]);
    expect(modifiersOf("CREATE TEMPORARY TABLE t (id int);")).toEqual(["temporary"]);
    expect(modifiersOf("CREATE UNLOGGED TABLE t (id int);")).toEqual(["unlogged"]);
    expect(modifiersOf("CREATE GLOBAL TEMPORARY TABLE t (id int);")).toEqual(["global", "temporary"]);
    expect(modifiersOf("create local temp table t (id int);")).toEqual(["local", "temp"]);
  });

  it("carries the prefix through every createTable shape and CREATE TABLE AS", () => {
    expect(firstStmt("CREATE TEMP TABLE IF NOT EXISTS s.t (id int) ON COMMIT DROP;")).toMatchObject({
      kind: "createTable",
      ifNotExists: true,
      name: ["s", "t"],
      onCommit: "drop",
      modifiers: ["temp"],
    });
    expect(firstStmt("CREATE UNLOGGED TABLE p PARTITION OF q DEFAULT;")).toMatchObject({
      partitionOf: { parent: ["q"] },
      modifiers: ["unlogged"],
    });
    expect(firstStmt("CREATE LOCAL TEMPORARY TABLE snap AS SELECT 1;")).toMatchObject({
      kind: "createTableAs",
      modifiers: ["local", "temporary"],
    });
  });

  it("opens the span on the first modifier, and on TABLE without one", () => {
    expect(rawFirst("CREATE TABLE t (id int);").span.start).toEqual({ row: 1, col: 7 });
    expect(rawFirst("CREATE TEMP TABLE t (id int);").span).toEqual({
      start: { row: 1, col: 7 },
      end: { row: 1, col: 28 },
    });
    expect(rawFirst("CREATE GLOBAL TEMP TABLE t AS SELECT 1;").span.start).toEqual({ row: 1, col: 7 });
  });

  it("keeps temp, temporary, unlogged, global and local unreserved", () => {
    const words = ["temp", "temporary", "unlogged", "global", "local"];
    for (const word of words) {
      expect(firstStmt(`CREATE TABLE ${word} (${word} int);`)).toMatchObject({
        name: [word],
        items: [{ kind: "column", name: word }],
      });
      expect(firstStmt(`CREATE TEMP TABLE ${word} (id int);`)).toMatchObject({ name: [word], modifiers: ["temp"] });
    }
    expect(firstStmt(`SELECT ${words.join(", ")} FROM local;`)).toEqual(
      sel({ columns: words.map((w) => col(name(w))), from: [tableFrom(["local"])] }),
    );
    // SELECT … INTO shares the word lists, and still reads these as names.
    expect(firstStmt("SELECT a INTO temp FROM t;").into).toEqual({ name: ["temp"] });
    expect(firstStmt("SELECT a INTO GLOBAL TEMP unlogged FROM t;").into).toEqual({
      name: ["unlogged"],
      modifiers: ["global", "temp"],
    });
  });

  it("rejects a bare scope word, stacked storage words and a non-TABLE target", () => {
    expect(bad("CREATE GLOBAL TABLE t (id int);")).toThrow(/Expected "temp" or "temporary" but found "table" \(1:14\)/);
    expect(bad("CREATE LOCAL UNLOGGED TABLE t (id int);")).toThrow(
      /Expected "temp" or "temporary" but found "unlogged"/,
    );
    expect(bad("CREATE TEMP UNLOGGED TABLE t (id int);")).toThrow(/Expected "table" but found "unlogged" \(1:12\)/);
    expect(bad("CREATE TEMP TEMP TABLE t (id int);")).toThrow(/Expected "table" but found "temp"/);
    expect(bad("CREATE UNLOGGED INDEX i ON t (a);")).toThrow(/Expected "table" but found "index"/);
    expect(bad("CREATE TEMP VIEW v AS SELECT 1;")).toThrow(/Expected "table" but found "view"/);
    expect(bad("CREATE TEMPORARY SEQUENCE s;")).toThrow(/Expected "table" but found "sequence"/);
    expect(bad("CREATE OR REPLACE TEMP VIEW v AS SELECT 1;")).toThrow(/Expected "view", "materialized"/);
    expect(bad("CREATE TEMP;")).toThrow(/Expected "table" but found ";"/);
    expect(bad("CREATE GLOBAL")).toThrow(/Expected "temp" or "temporary" but found end of input/);
  });
});

// --- CREATE ROLE, USER and PROCEDURE ---

describe("SQL-lite CREATE ROLE, USER and PROCEDURE", () => {
  const flag = (flagName: string, value = true) => ({ kind: "flag", name: flagName, value });
  const bad = (src: string) => () => sqlLite.parse(src);

  it("parses CREATE ROLE and CREATE USER with no options", () => {
    expect(firstStmt("CREATE ROLE r;")).toEqual({ kind: "createRole", user: false, name: "r", options: [] });
    expect(firstStmt('CREATE USER "Bob" WITH;')).toEqual({ kind: "createRole", user: true, name: "Bob", options: [] });
  });

  it("parses every role attribute and its NO spelling", () => {
    const words = ["superuser", "createdb", "createrole", "inherit", "login", "replication", "bypassrls"];
    const on = words.join(" ");
    const off = words.map((word) => `no${word}`).join(" ");
    expect(firstStmt(`CREATE ROLE r WITH ${on};`).options).toEqual(words.map((word) => flag(word)));
    expect(firstStmt(`CREATE USER u ${off.toUpperCase()};`).options).toEqual(words.map((word) => flag(word, false)));
  });

  it("parses CONNECTION LIMIT, PASSWORD, VALID UNTIL and the role lists, in written order", () => {
    expect(
      firstStmt(
        "CREATE ROLE r LOGIN CONNECTION LIMIT -1 ENCRYPTED PASSWORD 'pw' VALID UNTIL '2030-01-01' " +
          "IN ROLE a, b ROLE c ADMIN d, CURRENT_USER NOLOGIN;",
      ).options,
    ).toEqual([
      flag("login"),
      { kind: "connectionLimit", limit: -1 },
      { kind: "password", encrypted: true, password: "pw" },
      { kind: "validUntil", timestamp: "2030-01-01" },
      { kind: "inRole", roles: ["a", "b"] },
      { kind: "role", roles: ["c"] },
      { kind: "admin", roles: ["d", "current_user"] },
      flag("login", false),
    ]);
    expect(firstStmt("CREATE USER u PASSWORD NULL CONNECTION LIMIT 10;").options).toEqual([
      { kind: "password", encrypted: false, password: null },
      { kind: "connectionLimit", limit: 10 },
    ]);
    expect(firstStmt("CREATE ROLE r CONNECTION LIMIT +5;").options).toEqual([{ kind: "connectionLimit", limit: 5 }]);
    expect(firstStmt("CREATE USER u PASSWORD 'x';").options).toEqual([
      { kind: "password", encrypted: false, password: "x" },
    ]);
    // PG's legacy IN GROUP and USER spellings fold into IN ROLE and ROLE.
    expect(firstStmt("CREATE ROLE r IN GROUP a USER b, c;").options).toEqual([
      { kind: "inRole", roles: ["a"] },
      { kind: "role", roles: ["b", "c"] },
    ]);
  });

  it("parses CREATE [OR REPLACE] PROCEDURE over CREATE FUNCTION's signature and options", () => {
    expect(
      firstStmt(
        "CREATE OR REPLACE PROCEDURE app.p(IN a integer, INOUT b double precision DEFAULT 1, text) " +
          "LANGUAGE plpgsql SECURITY DEFINER SET search_path = app AS $$BEGIN NULL; END$$;",
      ),
    ).toEqual({
      kind: "createProcedure",
      orReplace: true,
      name: ["app", "p"],
      args: [
        { mode: "in", name: "a", type: ct("integer"), defaultValue: null },
        { mode: "inout", name: "b", type: ct("double precision"), defaultValue: num(1) },
        { mode: null, name: null, type: ct("text"), defaultValue: null },
      ],
      options: [
        { kind: "language", name: "plpgsql" },
        { kind: "security", external: false, definer: true },
        { kind: "set", parameter: "search_path", value: { kind: "list", values: [name("app")] } },
        { kind: "as", parts: ["BEGIN NULL; END"] },
      ],
    });
    expect(firstStmt("CREATE PROCEDURE p() AS 'obj', 'sym' LANGUAGE c EXTERNAL SECURITY INVOKER;")).toEqual({
      kind: "createProcedure",
      orReplace: false,
      name: ["p"],
      args: [],
      options: [
        { kind: "as", parts: ["obj", "sym"] },
        { kind: "language", name: "c" },
        { kind: "security", external: true, definer: false },
      ],
    });
  });

  it("spans ROLE and USER from their keyword and PROCEDURE from CREATE", () => {
    for (const src of ["CREATE TABLE t (id int);", "CREATE ROLE r LOGIN;", "CREATE USER u IN ROLE a, b;"]) {
      const [stmt] = sqlLite.parse(src) as Record<string, any>[];
      expect(stmt!.span).toEqual({ start: { row: 1, col: 7 }, end: { row: 1, col: src.length - 1 } });
    }
    const src = "CREATE OR REPLACE PROCEDURE p() AS 'SELECT 1' LANGUAGE sql;";
    const [stmt] = sqlLite.parse(src) as Record<string, any>[];
    expect(stmt!.span).toEqual({ start: { row: 1, col: 0 }, end: { row: 1, col: src.length - 1 } });
  });

  it("keeps the new CREATE words unreserved as names", () => {
    const words = [
      "role",
      "procedure",
      "superuser",
      "nosuperuser",
      "createdb",
      "createrole",
      "inherit",
      "login",
      "nocreatedb",
      "nocreaterole",
      "noinherit",
      "nologin",
      "replication",
      "noreplication",
      "nobypassrls",
      "bypassrls",
      "encrypted",
      "password",
      "valid",
      "until",
      "admin",
    ];
    expect(firstStmt(`SELECT ${words.join(", ")} FROM role;`).columns.map((c: any) => c.expr)).toEqual(
      words.map((word) => name(word)),
    );
    const cols = words.map((word) => `${word} text`).join(", ");
    expect(firstStmt(`CREATE TABLE procedure (${cols});`).items.map((i: any) => i.name)).toEqual(words);
    // …and as the names these statements create and list.
    expect(firstStmt("CREATE ROLE role ROLE login, admin ADMIN password;")).toMatchObject({
      name: "role",
      options: [
        { kind: "role", roles: ["login", "admin"] },
        { kind: "admin", roles: ["password"] },
      ],
    });
    expect(firstStmt("CREATE USER login LOGIN;")).toMatchObject({ name: "login", options: [flag("login")] });
    expect(firstStmt("CREATE PROCEDURE procedure(role text) LANGUAGE sql AS '';")).toMatchObject({
      name: ["procedure"],
      args: [{ name: "role" }],
    });
  });

  it("rejects malformed CREATE ROLE, USER and PROCEDURE", () => {
    expect(bad("CREATE ROLE;")).toThrow(/Expected a name but found ";"/);
    expect(bad("CREATE USER user;")).toThrow(/Expected a name but found "user"/);
    expect(bad("CREATE ROLE r frobnicate;")).toThrow(/Expected ";" but found "frobnicate"/);
    expect(bad("CREATE ROLE r CONNECTION 5;")).toThrow(/Expected "limit" but found "5"/);
    expect(bad("CREATE ROLE r CONNECTION LIMIT many;")).toThrow(/Expected an integer but found "many"/);
    expect(bad("CREATE ROLE r CONNECTION LIMIT 1.5;")).toThrow(/Expected an integer but found "1.5"/);
    expect(bad("CREATE ROLE r CONNECTION LIMIT - x;")).toThrow(/Expected an integer but found "x"/);
    expect(bad("CREATE ROLE r ENCRYPTED PASSWORD NULL;")).toThrow(/found "null"/);
    expect(bad("CREATE ROLE r PASSWORD pw;")).toThrow(/found "pw"/);
    expect(bad("CREATE ROLE r VALID '2030-01-01';")).toThrow(/Expected "until" but found/);
    expect(bad("CREATE ROLE r IN SCHEMA g;")).toThrow(/Expected "role" or "group" but found "schema"/);
    expect(bad("CREATE ROLE r ADMIN;")).toThrow(/Expected a name but found ";"/);
    expect(bad("CREATE ROLE r ROLE a,;")).toThrow(/Expected a name but found ";"/);
    expect(bad("CREATE OR REPLACE ROLE r;")).toThrow(/Expected "view", "materialized"/);
    expect(bad("CREATE PROCEDURE p;")).toThrow(/Expected "\(" but found ";"/);
    // A procedure returns nothing, and takes none of a function's call traits.
    expect(bad("CREATE PROCEDURE p() RETURNS int LANGUAGE sql AS '';")).toThrow(/Expected ";" but found "returns"/);
    expect(bad("CREATE PROCEDURE p() LANGUAGE sql IMMUTABLE AS '';")).toThrow(/Expected ";" but found "immutable"/);
    expect(bad("CREATE PROCEDURE p() NOT LEAKPROOF;")).toThrow(/Expected ";" but found "not"/);
  });
});
