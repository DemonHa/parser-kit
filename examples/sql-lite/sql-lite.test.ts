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
  });

  it("parses CREATE TYPE ... AS ENUM", () => {
    expect(firstStmt("CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy');")).toEqual({
      kind: "createType",
      name: ["mood"],
      values: ["sad", "ok", "happy"],
    });
  });

  it("parses DROP TABLE IF EXISTS with several names", () => {
    expect(firstStmt("DROP TABLE IF EXISTS a, public.b;")).toEqual({
      kind: "dropTable",
      ifExists: true,
      names: [["a"], ["public", "b"]],
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
    expect(stmts[1]).toMatchObject({ kind: "dropTable", names: [["t"]] });
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
