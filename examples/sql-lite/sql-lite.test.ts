import { createInputStream, ParseError, stripSpans } from "@parser-kit/core";
import { describe, expect, it } from "vitest";
import {
  type Stmt,
  sqlLexer,
  sqlLite,
  sqlLiteScript,
  sqlParseLexer,
  sqlScriptLexer,
  sqlScriptParseLexer,
} from "./index";

// --- helpers ---

const parse = (text: string) => stripSpans(sqlLite.parse(text)) as Record<string, any>[];
const firstStmt = (text: string) => parse(text)[0]!;

// Expressions are reached through a CHECK constraint, whose parenthesised body
// is a full scalar expression.
const exprOf = (src: string) => {
  const [stmt] = parse(`CREATE TABLE t (c int CHECK (${src}));`);
  return (stmt as any).items[0].constraints[0].expr;
};

const lex = (text: string, lexer = sqlLexer) => {
  const stream = lexer.tokenize(createInputStream(text));
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

// Matches an "Expected …" message naming each of `keys` among its
// alternatives, in any order and alongside others, and (when given) followed
// by `but found <found>`. Keyword dispatch lists grow as statements are added,
// so these tests pin the alternatives that matter, not the full ordered list.
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const expectsKeys = (keys: string[], found?: string) => {
  const tail = found === undefined ? "" : `[^\\n]*but found ${escapeRe(found)}`;
  return new RegExp(keys.map((key) => `(?=[^\\n]*Expected [^\\n]*"${escapeRe(key)}"${tail})`).join(""));
};
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

// --- comments inside statements ---

describe("SQL-lite comments inside statements", () => {
  // Each input must parse to exactly the tree of the same text with its
  // comments removed: the grammar never sees them.
  const sameAs = (withComments: string, without: string) => expect(parse(withComments)).toEqual(parse(without));

  it("drops comments from the parser's token stream but not from sqlLexer's", () => {
    const text = "a /* b /* nested */ c */ -- d\n e";
    expect(lex(text, sqlParseLexer)).toEqual([
      { type: "ident", value: "a" },
      { type: "ident", value: "e" },
    ]);
    expect(lex(text).map((t) => t.type)).toEqual(["ident", "comment", "comment", "ident"]);
  });

  it("parses a comment between keywords, inside an expression and before the ;", () => {
    expect(firstStmt("SELECT /* x */ 1;")).toEqual(sel({ columns: [col(num(1))] }));
    expect(firstStmt("SELECT a + -- plus\n b FROM t /* c */ ;")).toEqual(
      sel({ columns: [col(bin("+", name("a"), name("b")))], from: [tableFrom(["t"])] }),
    );
    sameAs("SELECT id, -- primary key\n name FROM users;", "SELECT id, name FROM users;");
    sameAs("SELECT a /* /* nested */ still */ FROM t WHERE /**/ a = 1 -- trailing\n;", "SELECT a FROM t WHERE a = 1;");
  });

  it("parses comments inside ARRAY[, between a function name and (, and after ::", () => {
    sameAs("SELECT ARRAY[ /* c */ 1, -- c\n 2 /* c */];", "SELECT ARRAY[1, 2];");
    sameAs("SELECT count /* c */ (/* c */ *) FROM t;", "SELECT count(*) FROM t;");
    sameAs("SELECT lower -- c\n (name) FROM t;", "SELECT lower(name) FROM t;");
    sameAs("SELECT x:: /* c */ int, y -- c\n :: text FROM t;", "SELECT x::int, y::text FROM t;");
  });

  it("parses comments inside multi-word type names", () => {
    sameAs(
      "SELECT x::double /* c */ precision, CAST(y AS timestamp -- c\n with /* c */ time zone) FROM t;",
      "SELECT x::double precision, CAST(y AS timestamp with time zone) FROM t;",
    );
    sameAs("CREATE TABLE t (c character /* c */ varying(10));", "CREATE TABLE t (c character varying(10));");
  });

  it("parses comments where the grammar looks ahead before committing", () => {
    sameAs("CREATE TABLE IF /* c */ NOT -- c\n EXISTS t (id int);", "CREATE TABLE IF NOT EXISTS t (id int);");
    sameAs("CREATE TABLE t (id int NOT /* c */ NULL);", "CREATE TABLE t (id int NOT NULL);");
    sameAs(
      "SELECT a FROM t WHERE a IS /* c */ NOT /* c */ DISTINCT FROM b;",
      "SELECT a FROM t WHERE a IS NOT DISTINCT FROM b;",
    );
    sameAs("SELECT a FROM t ORDER BY a /* c */ DESC NULLS -- c\n LAST;", "SELECT a FROM t ORDER BY a DESC NULLS LAST;");
    sameAs(
      "SELECT ( /* c */ SELECT 1), ( -- c\n WITH q AS (SELECT 1) SELECT * FROM q);",
      "SELECT (SELECT 1), (WITH q AS (SELECT 1) SELECT * FROM q);",
    );
    sameAs(
      "SELECT count(*) FILTER /* c */ (WHERE x) OVER /* c */ () FROM t;",
      "SELECT count(*) FILTER (WHERE x) OVER () FROM t;",
    );
    sameAs("ALTER TABLE t /* c */ ADD /* c */ COLUMN c int;", "ALTER TABLE t ADD COLUMN c int;");
  });

  it("parses comments at the start and end of input, and input that is only comments", () => {
    sameAs("-- lead\n/* lead */ SELECT 1; -- tail", "SELECT 1;");
    sameAs("SELECT 1; /* tail */", "SELECT 1;");
    expect(parse("-- nothing here\n/* or here */")).toEqual([]);
  });

  it("keeps comment-like text inside strings and still splits -- off an operator", () => {
    expect(firstStmt("SELECT '/* not */ -- a comment';")).toEqual(
      sel({ columns: [col(str("/* not */ -- a comment"))] }),
    );
    sameAs("SELECT 1-- c\n- 2;", "SELECT 1 - 2;");
    // The operator scan that starts at `+` must stop at `--`.
    sameAs("SELECT 1 +-- c\n 2;", "SELECT 1 + 2;");
  });

  it("ends spans at the last real token, not at a following comment", () => {
    const [stmt] = sqlLite.parse("SELECT a /* c */ FROM t WHERE b /* tail */;") as any[];
    expect(stmt.span).toEqual({ start: { row: 1, col: 0 }, end: { row: 1, col: 31 } });
    expect(stmt.columns[0].expr.span).toEqual({ start: { row: 1, col: 7 }, end: { row: 1, col: 8 } });
    expect(stmt.where.span).toEqual({ start: { row: 1, col: 30 }, end: { row: 1, col: 31 } });
    // A list-shaped tail (the action list) ends at its last action too.
    const [alter] = sqlLite.parse("ALTER TABLE t DROP COLUMN a, DROP COLUMN b /* c */ -- c\n;") as any[];
    expect(alter.span).toEqual({ start: { row: 1, col: 0 }, end: { row: 1, col: 42 } });
    const [lead] = sqlLite.parse("/* lead */ SELECT 1 -- tail\n;") as any[];
    expect(lead.span).toEqual({ start: { row: 1, col: 11 }, end: { row: 1, col: 19 } });
  });

  it("points errors at the token after a comment", () => {
    expect(() => sqlLite.parse("SELECT /* c */ ,;")).toThrow(/but found "," \(1:15\)/);
    expect(() => sqlLite.parse("SELECT 1 /* c */ 2;")).toThrow(/Expected ";" but found "2"/);
    expect(() => sqlLite.parse("SELECT 1 -- tail\n2")).toThrow(/Expected ";" but found "2" \(2:0\)/);
    // An unclosed block comment is a lexer error, as in PG.
    expect(() => sqlLite.parse("SELECT /* unclosed 1;")).toThrow(/Unterminated \/\* comment \(1:7\)/);
  });

  it("resumes after a lexer error hit while skipping comments", () => {
    const stream = sqlParseLexer.tokenize(createInputStream("a /* c */ $ b -- t"));
    expect(stream.next()?.value).toBe("a");
    expect(() => stream.peek()).toThrow(/Unexpected character "\$" \(1:10\)/);
    expect(stream.peek()?.value).toBe("b");
    expect(stream.next()?.value).toBe("b");
    expect(stream.eof()).toBe(true);
    const { ast, errors } = sqlLite.diagnose("SELECT /* a */ $ /* b */ $ ; SELECT 2;");
    expect(errors.map((e) => e.message)).toEqual([
      'Unexpected character "$" (1:15)',
      'Unexpected character "$" (1:25)',
    ]);
    expect(stripSpans(ast)).toEqual([sel({ columns: [col(num(2))] })]);
  });

  it("diagnose() recovers past a bad statement that contains comments", () => {
    const { ast, errors } = sqlLite.diagnose("SELECT /* c */ FROM; -- next\nSELECT /* ok */ 1;");
    expect(errors).toHaveLength(1);
    expect(stripSpans(ast)).toEqual([sel({ columns: [col(num(1))] })]);
  });
});

// --- statement separators ---

describe("SQL-lite statement separators", () => {
  const one = sel({ columns: [col(num(1))] });
  const two = sel({ columns: [col(num(2))] });

  it("parses a single statement without a trailing ;", () => {
    expect(parse("SELECT 1")).toEqual([one]);
    expect(parse("SELECT 1")).toEqual(parse("SELECT 1;"));
    expect(firstStmt("CREATE TABLE t (id int)")).toMatchObject({ kind: "createTable", name: ["t"] });
    expect(firstStmt("DROP TABLE t")).toMatchObject({ kind: "drop", names: [["t"]] });
  });

  it("lets only the last of several statements omit its ;", () => {
    expect(parse("SELECT 1; SELECT 2")).toEqual([one, two]);
    expect(parse("SELECT 1;\nSELECT 2;\n")).toEqual([one, two]);
  });

  it("allows a comment after the last statement without a ;", () => {
    expect(parse("SELECT 1 -- tail")).toEqual([one]);
    expect(parse("SELECT 1; SELECT 2 /* tail */\n")).toEqual([one, two]);
  });

  it("produces no node for empty statements", () => {
    expect(parse("SELECT 1;; SELECT 2;")).toEqual([one, two]);
    expect(parse("; SELECT 1")).toEqual([one]);
    expect(parse("SELECT 1;;")).toEqual([one]);
    expect(parse(";")).toEqual([]);
    expect(parse(" ; ;\n; -- c\n/* c */ ;")).toEqual([]);
    expect(parse("-- only a comment")).toEqual([]);
    expect(parse("")).toEqual([]);
    expect(parse("  \n\t")).toEqual([]);
  });

  it("still requires ; between statements", () => {
    expect(() => sqlLite.parse("SELECT 1 SELECT 2")).toThrow(/Expected ";" but found "select" \(1:9\)/);
    expect(() => sqlLite.parse("SELECT 1 SELECT 2;")).toThrow(/Expected ";" but found "select" \(1:9\)/);
    expect(() => sqlLite.parse("SELECT 1; SELECT 2 SELECT 3")).toThrow(/Expected ";" but found "select" \(1:19\)/);
    // An incomplete last statement still fails on its own terms at end of input.
    expect(() => sqlLite.parse("SELECT 1 +")).toThrow(/but found end of input/);
    expect(() => sqlLite.parse("SELECT 1; SELECT 'abc FROM t")).toThrow(/Unterminated/);
  });

  it("rejects a list still open at the end of the input", () => {
    const open = /Expected "\)" but found end of input/;
    expect(() => sqlLite.parse("INSERT INTO t (a, b) VALUES (1")).toThrow(
      /Expected "\)" but found end of input \(1:30\)/,
    );
    expect(() => sqlLite.parse("CREATE TABLE t (id int")).toThrow(open);
    expect(() => sqlLite.parse("CREATE TABLE t (")).toThrow(open);
    expect(() => sqlLite.parse("CREATE INDEX i ON t (a")).toThrow(open);
    expect(() => sqlLite.parse("SELECT * FROM t WHERE a IN (1, 2")).toThrow(open);
    expect(() => sqlLite.parse("DROP FUNCTION f(")).toThrow(open);
    expect(() => sqlLite.parse("SELECT x::numeric(10")).toThrow(open);
    expect(() => sqlLite.parse("SELECT ARRAY[1, 2")).toThrow(/Expected "]" but found end of input/);
    expect(() => sqlLite.parse("SELECT f(1")).toThrow(open);
    // Closed, the same statements need no `;`.
    expect(firstStmt("CREATE TABLE t (id int)")).toMatchObject({ kind: "createTable" });
    expect(firstStmt("SELECT * FROM t WHERE a IN (1, 2)")).toMatchObject({ kind: "select" });
  });

  it("parses statements whose lookahead stops at the ; when it is missing", () => {
    expect(firstStmt("FETCH next")).toEqual({ kind: "fetch", direction: null, cursor: "next" });
    expect(firstStmt("VACUUM")).toEqual({ kind: "vacuum", options: [], tables: [] });
    expect(firstStmt("ANALYZE")).toEqual({ kind: "analyze", options: [], tables: [] });
  });

  it("keeps spans unchanged whether or not the ; is there", () => {
    const span = (row: number, col: number, endRow: number, endCol: number) => ({
      start: { row, col },
      end: { row: endRow, col: endCol },
    });
    const [bare] = sqlLite.parse("SELECT 1") as any[];
    const [ended] = sqlLite.parse("SELECT 1;") as any[];
    expect(bare.span).toEqual(span(1, 0, 1, 8));
    expect(ended.span).toEqual(bare.span);
    const stmts = sqlLite.parse(";;\n  SELECT a FROM t;;\nSELECT 2 -- tail") as any[];
    expect(stmts.map((s) => s.span)).toEqual([span(2, 2, 2, 17), span(3, 0, 3, 8)]);
  });

  it("diagnose() resyncs on ; and keeps the statements around a bad one", () => {
    const { ast, errors } = sqlLite.diagnose("SELECT 1;; SELECT 1 +; SELECT 2");
    expect(errors.map((e) => e.message)).toEqual([expect.stringMatching(/but found ";" \(1:21\)/)]);
    expect(stripSpans(ast)).toEqual([one, two]);
  });

  it("diagnose() reports a bad last statement without a ;", () => {
    const { ast, errors } = sqlLite.diagnose("SELECT 1;\nSELECT 2 +");
    expect(errors.map((e) => e.message)).toEqual([expect.stringMatching(/but found end of input/)]);
    expect(stripSpans(ast)).toEqual([one]);
  });

  it("diagnose() records a lexer error on the first token instead of throwing", () => {
    const bare = sqlLite.diagnose("'abc");
    expect(bare.errors.map((e) => e.message)).toEqual(["Unterminated quoted string (1:0)"]);
    expect(bare.ast).toEqual([]);
    const { ast, errors } = sqlLite.diagnose("X'G1'; SELECT 1");
    expect(errors.map((e) => e.message)).toEqual(['Invalid hexadecimal digit "G" (1:0)']);
    expect(stripSpans(ast)).toEqual([one]);
  });

  it("diagnose() reports the unclosed list when a bad table element's recovery runs past the ;", () => {
    // The element's skip stops only at `,` or `)`, so it consumes the `;`.
    const { ast, errors } = sqlLite.diagnose("CREATE TABLE t (id;");
    expect(errors.map((e) => e.message)).toEqual([
      expect.stringMatching(/but found ";" \(1:18\)/),
      'Expected ")" but found end of input (1:19)',
    ]);
    expect(ast).toEqual([]);
  });

  it("diagnose() reports a missing ; between statements and resumes after the next ;", () => {
    const { ast, errors } = sqlLite.diagnose("SELECT 1 SELECT 2; SELECT 3");
    expect(errors.map((e) => e.message)).toEqual(['Expected ";" but found "select" (1:9)']);
    expect(stripSpans(ast)).toEqual([sel({ columns: [col(num(3))] })]);
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
      expectsKeys(
        [
          "add",
          "drop",
          "alter",
          "rename",
          "owner",
          "replica",
          "set",
          "reset",
          "validate",
          "enable",
          "disable",
          "cluster",
          "attach",
          "detach",
        ],
        '"frobnicate"',
      ),
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
      expectsKeys(
        ["table", "schema", "domain", "type", "index", "function", "aggregate", "view", "materialized", "sequence"],
        '"frobnicate"',
      ),
    );
  });
});

// --- ONLY on ALTER TABLE and CREATE INDEX ---

describe("SQL-lite ONLY on ALTER TABLE and CREATE INDEX", () => {
  const addA = {
    kind: "addColumn",
    ifNotExists: false,
    column: { kind: "column", name: "a", dataType: { name: "int", args: [], array: false }, constraints: [] },
  };
  const index = (over: Record<string, unknown>) => ({
    kind: "createIndex",
    unique: false,
    concurrently: false,
    ifNotExists: false,
    name: "i",
    table: ["t"],
    using: null,
    columns: [{ expr: name("a") }],
    include: null,
    where: null,
    ...over,
  });

  it("records ONLY on ALTER TABLE, after IF EXISTS and around a parenthesised name", () => {
    expect(firstStmt("ALTER TABLE ONLY t ADD a int;")).toEqual({
      kind: "alterTable",
      ifExists: false,
      name: ["t"],
      only: true,
      actions: [addA],
    });
    expect(firstStmt("ALTER TABLE IF EXISTS ONLY s.t ADD a int;")).toEqual({
      kind: "alterTable",
      ifExists: true,
      name: ["s", "t"],
      only: true,
      actions: [addA],
    });
    expect(firstStmt("ALTER TABLE ONLY (s.t) ADD a int;")).toEqual(firstStmt("ALTER TABLE ONLY s.t ADD a int;"));
  });

  it("takes ONLY before every ALTER TABLE action pg_dump writes it with", () => {
    expect(firstStmt("ALTER TABLE ONLY public.t ADD CONSTRAINT t_pkey PRIMARY KEY (id);")).toMatchObject({
      name: ["public", "t"],
      only: true,
      actions: [{ kind: "addConstraint", name: "t_pkey", constraint: { kind: "primaryKey", columns: ["id"] } }],
    });
    expect(
      firstStmt("ALTER TABLE ONLY public.t ALTER COLUMN id SET DEFAULT nextval('public.t_id_seq'::regclass);"),
    ).toMatchObject({ only: true, actions: [{ kind: "setDefault", column: "id" }] });
    expect(firstStmt("ALTER TABLE ONLY public.p ATTACH PARTITION public.c FOR VALUES IN (1);")).toMatchObject({
      only: true,
      actions: [{ kind: "attachPartition", partition: ["public", "c"] }],
    });
    expect(firstStmt("ALTER TABLE ONLY t RENAME TO u;")).toMatchObject({
      only: true,
      actions: [{ kind: "renameTable", to: "u" }],
    });
    expect(firstStmt("ALTER TABLE IF EXISTS ONLY (s.t) RENAME TO u;")).toMatchObject({
      ifExists: true,
      name: ["s", "t"],
      only: true,
      actions: [{ kind: "renameTable", to: "u" }],
    });
    expect(firstStmt("ALTER TABLE ONLY t ADD a int, DROP b;")).toEqual({
      kind: "alterTable",
      ifExists: false,
      name: ["t"],
      only: true,
      actions: [addA, { kind: "dropColumn", name: "b" }],
    });
  });

  it("accepts the inheritance star, which is the default and not recorded", () => {
    expect(firstStmt("ALTER TABLE t * ADD a int;")).toEqual(firstStmt("ALTER TABLE t ADD a int;"));
    expect(firstStmt("ALTER TABLE IF EXISTS t * ADD a int;")).toEqual(firstStmt("ALTER TABLE IF EXISTS t ADD a int;"));
  });

  it("records ON ONLY on CREATE INDEX, bare or parenthesised, and omits it otherwise", () => {
    expect(firstStmt("CREATE INDEX i ON ONLY t (a);")).toEqual(index({ only: true }));
    expect(firstStmt("CREATE INDEX ON ONLY (s.t) USING btree (a);")).toEqual(
      index({ name: null, table: ["s", "t"], only: true, using: "btree" }),
    );
    expect(firstStmt("CREATE INDEX i ON t * (a);")).toEqual(index({}));
    expect(
      firstStmt(
        "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS i ON ONLY t (a) INCLUDE (b) WITH (fillfactor = 70) WHERE a > 0;",
      ),
    ).toMatchObject({
      unique: true,
      concurrently: true,
      ifNotExists: true,
      table: ["t"],
      only: true,
      include: ["b"],
      options: [{ name: "fillfactor" }],
      where: { kind: "binary", op: ">" },
    });
    expect(firstStmt("CREATE INDEX i ON t (a);")).not.toHaveProperty("only");
    expect(firstStmt("ALTER TABLE t ADD a int;")).not.toHaveProperty("only");
  });

  it("keeps a quoted only usable as a table name", () => {
    expect(firstStmt('ALTER TABLE "only" ADD a int;')).toEqual({
      kind: "alterTable",
      ifExists: false,
      name: ["only"],
      actions: [addA],
    });
    expect(firstStmt('CREATE INDEX i ON "only" (a);')).toEqual(index({ table: ["only"] }));
  });

  it("spans ALTER TABLE ONLY from ALTER and CREATE INDEX ON ONLY from after CREATE", () => {
    const [alter] = sqlLite.parse("ALTER TABLE ONLY (t) ADD a int;") as Record<string, any>[];
    expect(alter!.span).toEqual({ start: { row: 1, col: 0 }, end: { row: 1, col: 30 } });
    const [star] = sqlLite.parse("ALTER TABLE t * ADD a int;") as Record<string, any>[];
    expect(star!.span).toEqual({ start: { row: 1, col: 0 }, end: { row: 1, col: 25 } });
    const [idx] = sqlLite.parse("CREATE INDEX i ON ONLY t (a);") as Record<string, any>[];
    expect(idx!.span).toEqual({ start: { row: 1, col: 7 }, end: { row: 1, col: 28 } });
  });

  it("rejects ONLY with a star, IF EXISTS after ONLY, and an unclosed parenthesis", () => {
    expect(() => sqlLite.parse("ALTER TABLE ONLY t * ADD a int;")).toThrow(
      /Expected "add", .* but found "\*" \(1:19\)/,
    );
    expect(() => sqlLite.parse("ALTER TABLE ONLY (t) * ADD a int;")).toThrow(/but found "\*" \(1:21\)/);
    expect(() => sqlLite.parse("ALTER TABLE ONLY IF EXISTS t ADD a int;")).toThrow(/but found "exists" \(1:20\)/);
    expect(() => sqlLite.parse("ALTER TABLE ONLY (t ADD a int;")).toThrow(/Expected "\)" but found "add" \(1:20\)/);
    expect(() => sqlLite.parse("ALTER TABLE ONLY;")).toThrow(/Expected a name but found ";" \(1:16\)/);
    expect(() => sqlLite.parse("CREATE INDEX i ON ONLY t * (a);")).toThrow(/Expected "\(" but found "\*" \(1:25\)/);
    // ALTER INDEX, VIEW and SEQUENCE take a plain name in PG, without ONLY or `*`.
    expect(() => sqlLite.parse("ALTER INDEX ONLY i RENAME TO j;")).toThrow(/Expected a name but found "only" \(1:12\)/);
    expect(() => sqlLite.parse("ALTER VIEW v * RENAME TO w;")).toThrow(/but found "\*" \(1:13\)/);
    expect(() => sqlLite.parse("ALTER SEQUENCE ONLY s RESTART;")).toThrow(/Expected a name but found "only" \(1:15\)/);
    expect(() => sqlLite.parse("CREATE INDEX i ON ONLY (t (a);")).toThrow(/Expected "\)" but found "\(" \(1:26\)/);
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
      expectsKeys(
        [
          "table",
          "view",
          "index",
          "type",
          "sequence",
          "schema",
          "materialized",
          "function",
          "procedure",
          "aggregate",
          "trigger",
          "domain",
          "extension",
          "database",
          "role",
          "user",
        ],
        '"frobnicate"',
      ),
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
      expectsKeys(["view", "materialized", "function", "procedure", "aggregate", "trigger"], '"table"'),
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
    // bp 18, above every arithmetic tier: `(+a) * b`, not `+(a * b)`.
    expect(exprOf("+a * b")).toEqual(bin("*", un("+", name("a")), name("b")));
    // A sign on the right-hand side of a binary operator still reaches the prefix.
    expect(exprOf("a * +b")).toEqual(bin("*", name("a"), un("+", name("b"))));
    // Unchanged: unary minus keeps its own shape and precedence.
    expect(exprOf("-a * b")).toEqual(bin("*", un("-", name("a")), name("b")));
  });

  it("parses exponentiation looser than the unary sign, left-associatively", () => {
    expect(exprOf("a ^ b")).toEqual(bin("^", name("a"), name("b")));
    expect(exprOf("a ^ b ^ c")).toEqual(bin("^", bin("^", name("a"), name("b")), name("c")));
    // bp 15 is below the unary sign (18), so the sign binds to the base alone.
    expect(exprOf("-2 ^ 2")).toEqual(bin("^", un("-", num(2)), num(2)));
    expect(exprOf("+2 ^ 2")).toEqual(bin("^", un("+", num(2)), num(2)));
    // ... and below the bp-19 postfixes. The right operand is what discriminates:
    // a cast there binds to that operand, not to the power. (`a::int ^ 2` is the
    // same tree at any bp, since the postfix loop runs before the infix scan.)
    expect(exprOf("a ^ b::int")).toEqual(bin("^", name("a"), cast(name("b"), "int")));
    expect(exprOf("a::int ^ 2")).toEqual(bin("^", cast(name("a"), "int"), num(2)));
    // ... and above `*`, so the power is the multiplicand.
    expect(exprOf("2 ^ 3 * 4")).toEqual(bin("*", bin("^", num(2), num(3)), num(4)));
  });

  it("binds a signed right operand of ^ to its own operand only", () => {
    // A prefix parses its operand at its own bp (18), above `^`'s 15, so the
    // sign on the right takes `3` alone and the chain still nests left.
    expect(exprOf("2 ^ -3 ^ 4")).toEqual(bin("^", bin("^", num(2), un("-", num(3))), num(4)));
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
    // Unspaced, `^-` lexes as one operator, as in PG, where it is the generic
    // operator `^-` (which no catalog defines, so PG fails only at analysis).
    expect(exprOf("2^-2")).toEqual(bin("^-", num(2), num(2)));
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
    // The prefix group is shared too, so the widened sign reaches it as well,
    // binding tighter than `^` there too.
    expect(posOf("+a IN s")).toEqual({ kind: "position", substring: un("+", name("a")), string: name("s") });
    expect(posOf("-a ^ 2 IN s")).toEqual({
      kind: "position",
      substring: bin("^", un("-", name("a")), num(2)),
      string: name("s"),
    });
  });

  it("reports a missing right operand at the token that should have started it", () => {
    expect(() => sqlLite.parse("SELECT a ^ FROM t;")).toThrow(/Expected a name but found "from"/);
  });
});

// --- operator precedence among the tight tiers ---

// PostgreSQL's gram.y orders these, loosest first: `^` < AT < COLLATE < unary
// sign < `[ ]` < `::`, all left-associative except the right-associative sign.
describe("SQL-lite precedence of ^, AT TIME ZONE, COLLATE, the sign, subscripts and casts", () => {
  const un = (op: string, operand: unknown) => ({ kind: "unary", op, operand });
  const cast = (expr: unknown, type: string) => ({ kind: "cast", expr, type: ct(type) });
  const at = (expr: unknown, zone: unknown) => ({ kind: "atTimeZone", expr, zone });
  const coll = (expr: unknown, ...collation: string[]) => ({ kind: "collate", expr, collation });
  const sub = (base: unknown, index: unknown) => ({ kind: "subscript", base, index });

  it("binds the unary sign tighter than ^, as PostgreSQL does", () => {
    expect(exprOf("-2 ^ 2")).toEqual(bin("^", un("-", num(2)), num(2)));
    expect(exprOf("-a ^ -b")).toEqual(bin("^", un("-", name("a")), un("-", name("b"))));
    expect(exprOf("2 ^ -3 ^ 4")).toEqual(bin("^", bin("^", num(2), un("-", num(3))), num(4)));
    // Parentheses still give the other reading.
    expect(exprOf("-(2 ^ 2)")).toEqual(un("-", bin("^", num(2), num(2))));
  });

  it("binds AT TIME ZONE tighter than ^ and looser than the sign", () => {
    expect(exprOf("a ^ b AT TIME ZONE 'z'")).toEqual(bin("^", name("a"), at(name("b"), str("z"))));
    expect(exprOf("a AT TIME ZONE 'z' ^ 2")).toEqual(bin("^", at(name("a"), str("z")), num(2)));
    expect(exprOf("-a AT TIME ZONE z")).toEqual(at(un("-", name("a")), name("z")));
    // A sign opening the zone is still the zone's own.
    expect(exprOf("a AT TIME ZONE -z")).toEqual(at(name("a"), un("-", name("z"))));
    // The arithmetic tiers below `^` take the conversion as their operand too.
    expect(exprOf("a + b AT TIME ZONE 'z'")).toEqual(bin("+", name("a"), at(name("b"), str("z"))));
  });

  it("chains AT TIME ZONE to the left", () => {
    expect(exprOf("a AT TIME ZONE 'z' AT TIME ZONE 'y'")).toEqual(at(at(name("a"), str("z")), str("y")));
  });

  it("binds COLLATE tighter than AT TIME ZONE and ^, and looser than the sign", () => {
    expect(exprOf('-x COLLATE "C"')).toEqual(coll(un("-", name("x")), "C"));
    expect(exprOf('a ^ b COLLATE "C"')).toEqual(bin("^", name("a"), coll(name("b"), "C")));
    expect(exprOf('a COLLATE "C" ^ 2')).toEqual(bin("^", coll(name("a"), "C"), num(2)));
    // A signed right operand of `^` takes the COLLATE before the power does.
    expect(exprOf('x ^ -a COLLATE "C"')).toEqual(bin("^", name("x"), coll(un("-", name("a")), "C")));
    // The zone takes a COLLATE; a COLLATE before AT applies to the timestamp.
    expect(exprOf('a AT TIME ZONE z COLLATE "C"')).toEqual(at(name("a"), coll(name("z"), "C")));
    expect(exprOf('a COLLATE "C" AT TIME ZONE z')).toEqual(at(coll(name("a"), "C"), name("z")));
  });

  it("binds casts and subscripts tighter than the sign", () => {
    expect(exprOf("-x::int")).toEqual(un("-", cast(name("x"), "int")));
    expect(exprOf("-a[1]")).toEqual(un("-", sub(name("a"), num(1))));
    expect(exprOf("-a[1] ^ 2")).toEqual(bin("^", un("-", sub(name("a"), num(1))), num(2)));
    expect(exprOf("a[1]::int")).toEqual(cast(sub(name("a"), num(1)), "int"));
    expect(exprOf('x::text COLLATE "C"')).toEqual(coll(cast(name("x"), "text"), "C"));
    expect(exprOf('x COLLATE "C"::text')).toEqual(cast(coll(name("x"), "C"), "text"));
    expect(exprOf("a AT TIME ZONE z::text")).toEqual(at(name("a"), cast(name("z"), "text")));
    expect(exprOf("a AT TIME ZONE z[1]")).toEqual(at(name("a"), sub(name("z"), num(1))));
  });

  it("rejects an AT with no TIME ZONE or no zone after it", () => {
    // `at` with neither TIME ZONE nor LOCAL after it is a bare alias, as in PG,
    // so the error falls on the zone that follows it.
    expect(() => sqlLite.parse("SELECT -a AT 'z' FROM t;")).toThrow(/Expected ";" but found "z"/);
    expect(() => sqlLite.parse("SELECT a AT TIME ZONE FROM t;")).toThrow(/Expected a name but found "from"/);
  });
});

// --- generic operators, OPERATOR(…), quantified operators, ISNULL / NOTNULL ---

// PG's scanner reads any run of operator characters as one operator, and its
// grammar gives every operator outside the named tiers one precedence, `Op`.
describe("SQL-lite generic operators", () => {
  const un = (op: string, operand: unknown) => ({ kind: "unary", op, operand });
  const colExpr = (src: string) => (firstStmt(`SELECT ${src} FROM t;`) as any).columns[0].expr;

  it("parses any operator outside the fixed table as a binary node", () => {
    for (const op of ["&&", "<->", "-|-", "^@", "~~", "!~~", "~~*", "!~~*", "<<|", "&<", "@@@", "<^", "?#"]) {
      expect(exprOf(`a ${op} b`)).toEqual(bin(op, name("a"), name("b")));
    }
    // The `~~` pg_dump writes for LIKE in CHECK constraints and views.
    expect(exprOf("(email ~~ '%@gmail.com'::text)")).toEqual(
      bin("~~", name("email"), { kind: "cast", expr: str("%@gmail.com"), type: ct("text") }),
    );
  });

  it("keeps every fixed-table operator in its own group", () => {
    const fixed = ["^", "*", "/", "%", "+", "-", "||", "@>", "&", "|", "#", "<<", ">>", "->", "->>", "#>", "#>>"];
    const more = ["#-", "?", "?|", "?&", "<@", "~", "!~", "~*", "!~*", "@?", "@@", "<", ">", "<=", ">=", "=", "<>"];
    for (const op of [...fixed, ...more, "!="]) {
      expect(exprOf(`a ${op} b`)).toEqual(bin(op, name("a"), name("b")));
    }
    // Each still binds at its own bp, not the catch-all's: the comparisons
    // below a generic operator, the arithmetic above it.
    expect(exprOf("a <-> b = c")).toEqual(bin("=", bin("<->", name("a"), name("b")), name("c")));
    expect(exprOf("a = b <-> c")).toEqual(bin("=", name("a"), bin("<->", name("b"), name("c"))));
    expect(exprOf("a <-> b + c")).toEqual(bin("<->", name("a"), bin("+", name("b"), name("c"))));
    expect(exprOf("a * b <-> c")).toEqual(bin("<->", bin("*", name("a"), name("b")), name("c")));
    expect(exprOf("a ^ b && c")).toEqual(bin("&&", bin("^", name("a"), name("b")), name("c")));
  });

  it("shares the bp-12 tier left-associatively and ranks it above LIKE, IS and AND", () => {
    expect(exprOf("a || b <-> c")).toEqual(bin("<->", bin("||", name("a"), name("b")), name("c")));
    expect(exprOf("a <-> b || c")).toEqual(bin("||", bin("<->", name("a"), name("b")), name("c")));
    expect(exprOf("a ~~ b ~~ c")).toEqual(bin("~~", bin("~~", name("a"), name("b")), name("c")));
    expect(exprOf("a LIKE b <-> c")).toMatchObject({ kind: "like", pattern: bin("<->", name("b"), name("c")) });
    expect(exprOf("a && b IS NULL")).toEqual({ kind: "is", expr: bin("&&", name("a"), name("b")), negated: false });
    expect(exprOf("a ~~ b AND c")).toEqual(bin("and", bin("~~", name("a"), name("b")), name("c")));
    expect(exprOf("NOT a ~~ b")).toEqual(un("not", bin("~~", name("a"), name("b"))));
    expect(exprOf("-a ~~ b")).toEqual(bin("~~", un("-", name("a")), name("b")));
    expect(exprOf("a BETWEEN b AND c && d")).toMatchObject({ kind: "between", hi: bin("&&", name("c"), name("d")) });
  });

  it("stops before the clause words and operators that follow an expression", () => {
    const order = (firstStmt("SELECT x FROM t ORDER BY a <-> b USING <;") as any).orderBy;
    expect(order).toEqual([{ expr: bin("<->", name("a"), name("b")), dir: null, using: "<", nulls: null }]);
    const exclude = (firstStmt("CREATE TABLE t (c int, EXCLUDE USING gist ((c <-> d) WITH &&));") as any).items[1];
    expect(exclude.elements).toEqual([{ expr: bin("<->", name("c"), name("d")), operator: "&&" }]);
  });

  it("reaches the b-expression, so a column DEFAULT takes a generic operator", () => {
    const cols = (firstStmt("CREATE TABLE t (a int DEFAULT 1 <-> 2 NOT NULL, b int DEFAULT @ -1);") as any).items;
    expect(cols[0].constraints).toEqual([{ kind: "default", expr: bin("<->", num(1), num(2)) }, { kind: "notNull" }]);
    expect(cols[1].constraints).toEqual([{ kind: "default", expr: un("@", un("-", num(1))) }]);
    // POSITION's first operand is a b-expression too.
    expect(colExpr("position(a <-> b IN c)")).toEqual({
      kind: "position",
      substring: bin("<->", name("a"), name("b")),
      string: name("c"),
    });
  });

  it("leaves `=>` to named arguments", () => {
    expect(colExpr("f(a => 1)")).toEqual({
      kind: "call",
      name: "f",
      args: [{ kind: "namedArg", name: "a", value: num(1) }],
    });
    expect(() => sqlLite.parse("SELECT a => 1 FROM t;")).toThrow(/Expected ";" but found "=>" \(1:9\)/);
    expect(() => sqlLite.parse("SELECT a => ANY (b) FROM t;")).toThrow(/Expected ";" but found "=>"/);
  });

  it("parses PostgreSQL's built-in prefix operators", () => {
    for (const op of ["~", "@", "|/", "||/", "!!", "@-@", "@@", "#", "?-", "?|"]) {
      expect(exprOf(`${op} a`)).toEqual(un(op, name("a")));
    }
    expect(exprOf("|/ 25 + ||/ 27")).toEqual(un("|/", bin("+", num(25), un("||/", num(27)))));
    // The prefix binds at `Op`: its operand runs through `+` and tighter, and
    // stops at another bp-12 operator, which then takes the prefix as its left.
    expect(exprOf("@ a + b")).toEqual(un("@", bin("+", name("a"), name("b"))));
    expect(exprOf("@ a <-> b")).toEqual(bin("<->", un("@", name("a")), name("b")));
    expect(exprOf("~ a::int")).toEqual(un("~", { kind: "cast", expr: name("a"), type: ct("int") }));
    expect(exprOf("a = ~ b")).toEqual(bin("=", name("a"), un("~", name("b"))));
  });

  it("rejects an operator with no operand", () => {
    expect(() => sqlLite.parse("SELECT a <-> FROM t;")).toThrow(/Expected a name but found "from" \(1:13\)/);
    expect(() => sqlLite.parse("SELECT @ FROM t;")).toThrow(/Expected a name but found "from" \(1:9\)/);
    // `!` is no prefix operator, so it cannot open an expression.
    expect(() => sqlLite.parse("SELECT ! a FROM t;")).toThrow(/but found "!" \(1:7\)/);
  });

  it("lexes an unspaced trailing sign into the operator when PG does", () => {
    expect(exprOf("2^-2")).toEqual(bin("^-", num(2), num(2)));
    expect(exprOf("a@-b")).toEqual(bin("@-", name("a"), name("b")));
    // Without a "strong" character the sign is trimmed off and stays a prefix.
    expect(exprOf("a<->-b")).toEqual(bin("<->", name("a"), un("-", name("b"))));
  });

  // PG's explicit `OPERATOR(schema.op)` spelling, which always binds at `Op`.
  describe("OPERATOR(…)", () => {
    const opBin = (op: string, opSchema: string[], left: unknown, right: unknown) => ({
      ...bin(op, left, right),
      opSchema,
    });

    it("parses it infix, with or without a schema", () => {
      expect(exprOf("a OPERATOR(pg_catalog.+) b")).toEqual(opBin("+", ["pg_catalog"], name("a"), name("b")));
      expect(exprOf("a OPERATOR(+) b")).toEqual(opBin("+", [], name("a"), name("b")));
      expect(exprOf('a operator("S".x.~~) b')).toEqual(opBin("~~", ["S", "x"], name("a"), name("b")));
      // At `Op`, whatever the operator: `*` no longer outranks `+`, and `=`
      // outranks a following comparison.
      expect(exprOf("a OPERATOR(pg_catalog.*) b + c")).toEqual(
        opBin("*", ["pg_catalog"], name("a"), bin("+", name("b"), name("c"))),
      );
      expect(exprOf("a OPERATOR(pg_catalog.=) b = c")).toEqual(
        bin("=", opBin("=", ["pg_catalog"], name("a"), name("b")), name("c")),
      );
      expect(exprOf("a + b OPERATOR(pg_catalog.~~) c")).toEqual(
        opBin("~~", ["pg_catalog"], bin("+", name("a"), name("b")), name("c")),
      );
    });

    it("parses it prefix, binding at `Op`", () => {
      const opUn = (op: string, operand: unknown) => ({ ...un(op, operand), opSchema: ["pg_catalog"] });
      expect(exprOf("OPERATOR(pg_catalog.-) a + b")).toEqual(opUn("-", bin("+", name("a"), name("b"))));
      expect(exprOf("OPERATOR(pg_catalog.@) a <-> b")).toEqual(bin("<->", opUn("@", name("a")), name("b")));
      expect(exprOf("x AND OPERATOR(pg_catalog.-) a")).toEqual(bin("and", name("x"), opUn("-", name("a"))));
      expect(exprOf('OPERATOR(pg_catalog.-) a COLLATE "C"')).toEqual(
        opUn("-", { kind: "collate", expr: name("a"), collation: ["C"] }),
      );
      // A NOT in the operand runs on through the comparisons, as NOT's does.
      expect(exprOf("OPERATOR(pg_catalog.-) NOT a = b AND c")).toEqual(
        bin("and", opUn("-", un("not", bin("=", name("a"), name("b")))), name("c")),
      );
      expect(exprOf("OPERATOR(pg_catalog.-) - NOT a = b")).toEqual(
        opUn("-", un("-", un("not", bin("=", name("a"), name("b"))))),
      );
      expect(exprOf("OPERATOR(pg_catalog.-) a * NOT b")).toEqual(opUn("-", bin("*", name("a"), un("not", name("b")))));
      expect(exprOf("OPERATOR(pg_catalog.-) NOT EXISTS (SELECT 1)")).toMatchObject({
        op: "-",
        operand: { kind: "exists", negated: true },
      });
      // In a b-expression as well.
      const def = (firstStmt("CREATE TABLE t (a int DEFAULT OPERATOR(pg_catalog.-) 1);") as any).items[0];
      expect(def.constraints).toEqual([{ kind: "default", expr: opUn("-", num(1)) }]);
    });

    it("rejects an incomplete spelling", () => {
      // Only a complete `( [name .]… op )` is the operator; anything else
      // leaves `operator` an alias, with the `(` stranded after it.
      expect(() => sqlLite.parse("SELECT a OPERATOR(pg_catalog.+ b FROM t;")).toThrow(
        /Expected ";" but found "\(" \(1:17\)/,
      );
      expect(() => sqlLite.parse("SELECT a OPERATOR(=>) b FROM t;")).toThrow(/Expected ";" but found "\("/);
      expect(() => sqlLite.parse("SELECT a OPERATOR(select.+) b FROM t;")).toThrow(/Expected ";" but found "\("/);
      expect(() => sqlLite.parse("SELECT a OPERATOR(pg_catalog.+) FROM t;")).toThrow(
        /Expected a name but found "from" \(1:32\)/,
      );
    });

    it("keeps operator unreserved as names and aliases", () => {
      expect((firstStmt("SELECT operator, a operator, b AS operator FROM operator;") as any).columns).toEqual([
        col(name("operator")),
        col(name("a"), "operator"),
        col(name("b"), "operator"),
      ]);
      expect((firstStmt("SELECT a FROM t operator;") as any).from).toEqual([
        { kind: "table", name: ["t"], alias: "operator" },
      ]);
      expect((firstStmt("CREATE TABLE operator (operator int);") as any).items).toEqual([
        { kind: "column", name: "operator", dataType: ct("int"), constraints: [] },
      ]);
      // A call named `operator` stays a call unless its argument is exactly an
      // operator reference — leniently in a select list, where PG rejects it,
      // and as PG reads it in an index, exclusion or partition element.
      const call = (args: unknown[]) => ({ kind: "call", name: "operator", args });
      expect(colExpr("operator(1)")).toEqual(call([num(1)]));
      expect(colExpr("operator(-1)")).toEqual(call([un("-", num(1))]));
      expect(colExpr("operator(a.b)")).toEqual(call([name("a", "b")]));
      expect(colExpr("s.operator(1)")).toEqual({ kind: "call", name: "s.operator", args: [num(1)] });
      expect((firstStmt("CREATE INDEX ON t (operator(a));") as any).columns[0].expr).toEqual(call([name("a")]));
      expect((firstStmt("CREATE TABLE t (a int) PARTITION BY RANGE (operator(a));") as any).partitionBy).toMatchObject({
        keys: [{ expr: call([name("a")]) }],
      });
      // `( * )` is an operator reference, so `operator(*)` opens a prefix — in an
      // index element too, where PG would read it as a call.
      expect(() => sqlLite.parse("SELECT operator(*) FROM t;")).toThrow(/Expected a name but found "from"/);
      expect(() => sqlLite.parse("CREATE INDEX ON t (operator(*));")).toThrow(/but found "\)" \(1:30\)/);
    });
  });
});

// `a_expr subquery_Op sub_type (…)`: ANY / SOME / ALL after any operator.
describe("SQL-lite quantified operators", () => {
  const anyAll = (op: string, quantifier: string, left: unknown, right: unknown, extra = {}) => ({
    kind: "anyAll",
    op,
    quantifier,
    left,
    right,
    ...extra,
  });

  it("quantifies LIKE and ILIKE, negated or not", () => {
    expect(exprOf("p LIKE ANY (a)")).toEqual(anyAll("like", "any", name("p"), name("a")));
    expect(exprOf("p ILIKE ALL (a)")).toEqual(anyAll("ilike", "all", name("p"), name("a")));
    expect(exprOf("p NOT LIKE SOME (a)")).toEqual(anyAll("not like", "some", name("p"), name("a")));
    expect(exprOf("p NOT ILIKE ANY (a)")).toEqual(anyAll("not ilike", "any", name("p"), name("a")));
    const where = (firstStmt("SELECT * FROM f WHERE path LIKE ANY (ARRAY['%.csv', '%.tsv']);") as any).where;
    expect(where).toEqual(
      anyAll("like", "any", name("path"), { kind: "array", elements: [str("%.csv"), str("%.tsv")] }),
    );
  });

  it("quantifies arithmetic, fixed-table and generic operators at their own precedence", () => {
    expect(exprOf("x ~ ANY (a)")).toEqual(anyAll("~", "any", name("x"), name("a")));
    expect(exprOf("x || ALL (a)")).toEqual(anyAll("||", "all", name("x"), name("a")));
    expect(exprOf("x + ANY (a)")).toEqual(anyAll("+", "any", name("x"), name("a")));
    expect(exprOf("x ^ SOME (a)")).toEqual(anyAll("^", "some", name("x"), name("a")));
    expect(exprOf("x <-> ANY (a)")).toEqual(anyAll("<->", "any", name("x"), name("a")));
    expect(exprOf("x OPERATOR(pg_catalog.~~) ALL (a)")).toEqual(
      anyAll("~~", "all", name("x"), name("a"), { opSchema: ["pg_catalog"] }),
    );
    // The operator's own bp decides how much of the left it takes.
    expect(exprOf("a * b + ANY (c)")).toEqual(anyAll("+", "any", bin("*", name("a"), name("b")), name("c")));
    expect(exprOf("a || b + ANY (c)")).toEqual(bin("||", name("a"), anyAll("+", "any", name("b"), name("c"))));
    expect(exprOf("a + b || ANY (c)")).toEqual(anyAll("||", "any", bin("+", name("a"), name("b")), name("c")));
    expect(exprOf("a = b || ANY (c)")).toEqual(bin("=", name("a"), anyAll("||", "any", name("b"), name("c"))));
    // A subquery operand, as for a comparison.
    expect(exprOf("x ~~ ANY (SELECT p FROM u)")).toEqual(
      anyAll("~~", "any", name("x"), {
        kind: "subquery",
        query: sel({ columns: [col(name("p"))], from: [{ kind: "table", name: ["u"], alias: null }] }),
      }),
    );
  });

  it("lets a quantified comparison be compared again", () => {
    // The quantified form ends in its `)`, so PG reads on: `(x = ANY (a)) = y`.
    expect(exprOf("x = ANY (a) = y")).toEqual(bin("=", anyAll("=", "any", name("x"), name("a")), name("y")));
    expect(exprOf("x LIKE ANY (a) LIKE 'b'")).toMatchObject({
      kind: "like",
      expr: anyAll("like", "any", name("x"), name("a")),
      pattern: str("b"),
    });
    expect(exprOf("x = ANY (a) <> ALL (b)")).toEqual(
      anyAll("<>", "all", anyAll("=", "any", name("x"), name("a")), name("b")),
    );
    // A plain comparison still does not chain.
    expect(() => sqlLite.parse("SELECT x = y = z FROM t;")).toThrow(/Operator "=" is non-associative \(1:13\)/);
    expect(() => sqlLite.parse("SELECT x = ANY (a) = y = z FROM t;")).toThrow(
      /Operator "=" is non-associative \(1:23\)/,
    );
    expect(() => sqlLite.parse("SELECT x < y >= ANY (a) FROM t;")).toThrow(/Operator ">=" is non-associative/);
  });

  it("rejects a quantifier without a parenthesised operand, or with ESCAPE", () => {
    expect(() => sqlLite.parse("SELECT x LIKE ANY (a, b) FROM t;")).toThrow(/Expected "\)" but found "," \(1:20\)/);
    expect(() => sqlLite.parse("SELECT x ~ ANY y FROM t;")).toThrow(/Expected "\(" but found "y" \(1:15\)/);
    // SIMILAR TO has no quantified form in PG.
    expect(() => sqlLite.parse("SELECT x SIMILAR TO ANY (a) FROM t;")).toThrow(/Expected a name but found "any"/);
    // PG's quantified LIKE takes no ESCAPE clause.
    expect(() => sqlLite.parse("SELECT * FROM t WHERE x LIKE ANY (a) ESCAPE '!';")).toThrow(
      /Expected ";" but found "escape"/,
    );
    // The b-expression has no quantified form, as in PG.
    expect(() => sqlLite.parse("CREATE TABLE t (a int DEFAULT 1 + ANY (b));")).toThrow(
      /Expected a name but found "any"/,
    );
    expect(() => sqlLite.parse("CREATE TABLE t (a int DEFAULT 1 OPERATOR(+) ANY (b));")).toThrow(
      /Expected a name but found "any" \(1:44\)/,
    );
  });
});

// PG's postfix ISNULL / NOTNULL, spellings of IS [NOT] NULL.
describe("SQL-lite ISNULL and NOTNULL", () => {
  const isNull = (expr: unknown, negated = false) => ({ kind: "is", expr, negated });

  it("parses both in WHERE and in the select list", () => {
    const stmt = firstStmt("SELECT a ISNULL, b NOTNULL, c isnull x FROM t WHERE a ISNULL OR b NOTNULL;") as any;
    expect(stmt.columns).toEqual([col(isNull(name("a"))), col(isNull(name("b"), true)), col(isNull(name("c")), "x")]);
    expect(stmt.where).toEqual(bin("or", isNull(name("a")), isNull(name("b"), true)));
    // Identical to the IS spelling.
    expect(exprOf("a NOTNULL")).toEqual(exprOf("a IS NOT NULL"));
  });

  it("binds at IS's precedence", () => {
    expect(exprOf("a + b ISNULL")).toEqual(isNull(bin("+", name("a"), name("b"))));
    expect(exprOf("a = b NOTNULL")).toEqual(isNull(bin("=", name("a"), name("b")), true));
    expect(exprOf("NOT a ISNULL")).toEqual({ kind: "unary", op: "not", operand: isNull(name("a")) });
    expect(exprOf("a ISNULL AND b")).toEqual(bin("and", isNull(name("a")), name("b")));
    expect(exprOf("a ISNULL::int")).toEqual({ kind: "cast", expr: isNull(name("a")), type: ct("int") });
  });

  it("rejects them where PG's grammar does", () => {
    // A b-expression has no NULL test, so a DEFAULT stops before it.
    expect(() => sqlLite.parse("CREATE TABLE t (a int DEFAULT 1 ISNULL);")).toThrow(
      /Expected "," but found "isnull" \(1:32\)/,
    );
    // Both are AS_LABEL keywords in PG: a bare alias never. (PG refuses them as
    // a table alias even after AS, which this grammar does not check.)
    expect(() => sqlLite.parse("SELECT * FROM t isnull;")).toThrow(/Expected ";" but found "isnull" \(1:16\)/);
    expect(() => sqlLite.parse("SELECT * FROM t notnull;")).toThrow(/Expected ";" but found "notnull"/);
  });

  it("keeps isnull and notnull unreserved as names, and as aliases after AS", () => {
    expect((firstStmt("CREATE TABLE isnull (isnull int, notnull int);") as any).items).toEqual([
      { kind: "column", name: "isnull", dataType: ct("int"), constraints: [] },
      { kind: "column", name: "notnull", dataType: ct("int"), constraints: [] },
    ]);
    const stmt = firstStmt("SELECT t.isnull, isnull(a), b AS isnull, c AS notnull FROM t AS notnull;") as any;
    expect(stmt.columns).toEqual([
      col(name("t", "isnull")),
      col({ kind: "call", name: "isnull", args: [name("a")] }),
      col(name("b"), "isnull"),
      col(name("c"), "notnull"),
    ]);
    expect(stmt.from).toEqual([{ kind: "table", name: ["t"], alias: "notnull" }]);
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

  it("keeps overlaps and the IS JSON words unreserved as names, and overlaps an AS-only alias", () => {
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
    // …and as aliases. `overlaps` is an AS_LABEL keyword in PG, so it is an
    // alias only after AS — including straight after a row, where it is
    // claimed as the operator only when a row follows it (a `(`, or ROW and
    // then a `(`). Bare, PG rejects it, and so does this grammar.
    expect((firstStmt("SELECT a AS overlaps FROM t;") as any).columns).toEqual([col(name("a"), "overlaps")]);
    expect((firstStmt("SELECT (a, b) AS overlaps FROM t;") as any).columns).toEqual([
      col(row(name("a"), name("b")), "overlaps"),
    ]);
    expect((firstStmt("SELECT ROW(a, b) AS overlaps, c AS json FROM t;") as any).columns).toEqual([
      col(explicitRow(name("a"), name("b")), "overlaps"),
      col(name("c"), "json"),
    ]);
    expect((firstStmt("SELECT c json FROM t;") as any).columns).toEqual([col(name("c"), "json")]);
    expect(() => sqlLite.parse("SELECT a overlaps FROM t;")).toThrow(/Expected ";" but found "overlaps" \(1:9\)/);
    expect(() => sqlLite.parse("SELECT (a, b) overlaps FROM t;")).toThrow(/Expected ";" but found "overlaps"/);
    expect(() => sqlLite.parse("SELECT (a, b) overlaps row FROM t;")).toThrow(/Expected ";" but found "overlaps"/);
    expect(() => sqlLite.parse("SELECT * FROM t overlaps;")).toThrow(/Expected ";" but found "overlaps"/);
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
    // row before it, and as an AS_LABEL keyword it cannot be a bare alias.
    expect(() => sqlLite.parse("SELECT (a, b) OVERLAPS (c, d) OVERLAPS (e, f) FROM t;")).toThrow(
      /Expected ";" but found "overlaps" \(1:30\)/,
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
    // Only a function takes a typed column-definition list; on a table the
    // list is a name list, so the type word is where it stops.
    expect(() => sqlLite.parse("SELECT * FROM t AS g (n int);")).toThrow(/Expected "\)" but found "int"/);
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
    expect(firstStmt("SELECT 1 ORDER BY 1 OFFSET 5 ROWS FETCH NEXT 3 ROWS WITH TIES;")).toMatchObject({
      limit: num(3),
      withTies: true,
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

// --- set-operation precedence and query-level tails ---

describe("SQL-lite set-operation precedence and query-level tails", () => {
  const one = sel({ columns: [col(num(1))] });
  const two = sel({ columns: [col(num(2))] });
  const three = sel({ columns: [col(num(3))] });
  const setOp = (op: string, left: unknown, right: unknown, tail: Record<string, unknown> = {}) => ({
    kind: "setOp",
    op,
    left,
    right,
    ...tail,
  });
  const values1 = { kind: "values", rows: [[num(1)]], orderBy: null, limit: null, offset: null };
  const ord = (expr: unknown) => ({ expr, dir: null, nulls: null });
  const forUpdate = { strength: "update", of: [], wait: null };
  const forShare = { strength: "share", of: [], wait: null };

  it("binds INTERSECT tighter than UNION and EXCEPT", () => {
    expect(firstStmt("SELECT 1 UNION SELECT 2 INTERSECT SELECT 3;")).toEqual(
      setOp("union", one, setOp("intersect", two, three)),
    );
    expect(firstStmt("SELECT 1 EXCEPT ALL SELECT 2 INTERSECT ALL SELECT 3;")).toEqual(
      setOp("exceptAll", one, setOp("intersectAll", two, three)),
    );
    expect(firstStmt("SELECT 1 INTERSECT SELECT 2 UNION SELECT 3;")).toEqual(
      setOp("union", setOp("intersect", one, two), three),
    );
    // UNION and EXCEPT share a level and associate to the left, as does INTERSECT.
    expect(firstStmt("SELECT 1 EXCEPT SELECT 2 UNION SELECT 3;")).toEqual(
      setOp("union", setOp("except", one, two), three),
    );
    expect(firstStmt("SELECT 1 INTERSECT SELECT 2 INTERSECT SELECT 3;")).toEqual(
      setOp("intersect", setOp("intersect", one, two), three),
    );
    // Parentheses override the precedence.
    expect(firstStmt("(SELECT 1 UNION SELECT 2) INTERSECT SELECT 3;")).toEqual(
      setOp("intersect", setOp("union", one, two), three),
    );
  });

  it("accepts the DISTINCT quantifier, which records nothing", () => {
    expect(
      firstStmt("SELECT 1 UNION DISTINCT SELECT 2 INTERSECT DISTINCT SELECT 3 EXCEPT DISTINCT VALUES (1);"),
    ).toEqual(setOp("except", setOp("union", one, setOp("intersect", two, three)), values1));
  });

  // Each tail as written, and the fields it sets. A SELECT or VALUES carries
  // them in its own (null-defaulted) fields; a set operation only when written.
  const TAILS: [string, Record<string, unknown>][] = [
    ["ORDER BY 1", { orderBy: [ord(num(1))] }],
    ["LIMIT 2", { limit: num(2) }],
    ["LIMIT ALL", {}],
    ["OFFSET 3", { offset: num(3) }],
    ["OFFSET 3 ROWS", { offset: num(3) }],
    ["LIMIT 2 OFFSET 3", { limit: num(2), offset: num(3) }],
    ["OFFSET 3 LIMIT 2", { limit: num(2), offset: num(3) }],
    ["FETCH FIRST 2 ROWS ONLY", { limit: num(2) }],
    ["OFFSET 3 ROW FETCH NEXT 2 ROW ONLY", { limit: num(2), offset: num(3) }],
    ["ORDER BY 1 FETCH FIRST 2 ROWS WITH TIES", { orderBy: [ord(num(1))], limit: num(2), withTies: true }],
    [
      "ORDER BY 1 OFFSET 3 FETCH FIRST 2 ROWS WITH TIES",
      { orderBy: [ord(num(1))], limit: num(2), withTies: true, offset: num(3) },
    ],
    ["FOR UPDATE", { locking: [forUpdate] }],
    ["FOR UPDATE FOR SHARE", { locking: [forUpdate, forShare] }],
    ["FOR UPDATE LIMIT 2", { limit: num(2), locking: [forUpdate] }],
    ["LIMIT 2 FOR UPDATE", { limit: num(2), locking: [forUpdate] }],
    ["FOR UPDATE OFFSET 3 LIMIT 2", { limit: num(2), offset: num(3), locking: [forUpdate] }],
    [
      "ORDER BY 1 LIMIT 2 OFFSET 3 FOR UPDATE",
      { orderBy: [ord(num(1))], limit: num(2), offset: num(3), locking: [forUpdate] },
    ],
    [
      "ORDER BY 1 FOR UPDATE FETCH FIRST 2 ROWS WITH TIES",
      { orderBy: [ord(num(1))], limit: num(2), withTies: true, locking: [forUpdate] },
    ],
    ["FOR READ ONLY", {}],
    ["FOR READ ONLY LIMIT 2", { limit: num(2) }],
    ["ORDER BY 1 LIMIT 2 FOR READ ONLY", { orderBy: [ord(num(1))], limit: num(2) }],
  ];
  // The bodies a tail can follow, and the node each one gives untailed.
  const BODIES: [string, Record<string, unknown>][] = [
    ["SELECT 1", one],
    ["VALUES (1)", values1],
    ["(SELECT 1)", one],
    ["((SELECT 1))", one],
    ["SELECT 1 UNION SELECT 2", setOp("union", one, two)],
    ["(SELECT 1) UNION (SELECT 2)", setOp("union", one, two)],
    ["(SELECT 1 UNION SELECT 2)", setOp("union", one, two)],
    ["((SELECT 1) UNION (SELECT 2))", setOp("union", one, two)],
    ["SELECT 1 UNION SELECT 2 INTERSECT SELECT 3", setOp("union", one, setOp("intersect", two, three))],
  ];

  it("attaches every tail to the query it follows, never to a set-op arm", () => {
    for (const [body, node] of BODIES) {
      for (const [tail, fields] of TAILS) {
        expect(firstStmt(`${body} ${tail};`), `${body} ${tail}`).toEqual({ ...node, ...fields });
      }
    }
  });

  it("omits withTies unless WITH TIES is written, and the set-op tail fields unless they are", () => {
    expect("withTies" in firstStmt("SELECT 1 FETCH FIRST 2 ROWS ONLY;")).toBe(false);
    expect("withTies" in firstStmt("SELECT 1 ORDER BY 1 LIMIT 2;")).toBe(false);
    expect("withTies" in firstStmt("VALUES (1) ORDER BY 1 FETCH NEXT 2 ROWS ONLY;")).toBe(false);
    expect(Object.keys(firstStmt("SELECT 1 UNION SELECT 2 FOR READ ONLY;"))).toEqual(["kind", "op", "left", "right"]);
    expect("locking" in firstStmt("VALUES (1) LIMIT 1;")).toBe(false);
  });

  it("merges a tail written after the parentheses into the one inside them", () => {
    // PG's insertSelectOptions: each clause may come from either side, once.
    expect(firstStmt("(SELECT 1 ORDER BY 1) LIMIT 2;")).toEqual({ ...one, orderBy: [ord(num(1))], limit: num(2) });
    expect(firstStmt("(SELECT 1 LIMIT 2) ORDER BY 1;")).toEqual({ ...one, orderBy: [ord(num(1))], limit: num(2) });
    expect(firstStmt("(SELECT 1 OFFSET 3) FETCH FIRST 2 ROWS ONLY;")).toEqual({
      ...one,
      limit: num(2),
      offset: num(3),
    });
    expect(firstStmt("(SELECT 1 ORDER BY 1) FETCH FIRST 2 ROWS WITH TIES;")).toEqual({
      ...one,
      orderBy: [ord(num(1))],
      limit: num(2),
      withTies: true,
    });
    expect(firstStmt("((SELECT 1 FOR UPDATE) FOR SHARE) LIMIT 2;")).toEqual({
      ...one,
      limit: num(2),
      locking: [forUpdate, forShare],
    });
    expect(firstStmt("((SELECT 1) UNION (SELECT 2) ORDER BY 1) LIMIT 2;")).toEqual(
      setOp("union", one, two, { orderBy: [ord(num(1))], limit: num(2) }),
    );
    expect(firstStmt("(VALUES (1) ORDER BY 1) LIMIT 2;")).toEqual({
      ...values1,
      orderBy: [ord(num(1))],
      limit: num(2),
    });
    // A tail inside an arm's parentheses stays on that arm.
    expect(firstStmt("(SELECT 1 LIMIT 1) UNION (SELECT 2 LIMIT 2) LIMIT 3;")).toEqual(
      setOp("union", { ...one, limit: num(1) }, { ...two, limit: num(2) }, { limit: num(3) }),
    );
  });

  it("attaches the tail the same way inside CTEs, subqueries and INSERT … SELECT", () => {
    const tailed = setOp("union", one, two, { orderBy: [ord(num(1))], limit: num(1) });
    const q = "SELECT 1 UNION SELECT 2 ORDER BY 1 LIMIT 1";
    expect(firstStmt(`WITH c AS (${q}) SELECT * FROM c;`).with_[0].query).toEqual(tailed);
    expect(firstStmt(`SELECT * FROM (${q}) s;`).from[0].query).toEqual(tailed);
    expect(firstStmt(`SELECT * FROM t WHERE a IN (${q});`).where.query).toEqual(tailed);
    expect(firstStmt(`SELECT (${q});`).columns[0].expr.query).toEqual(tailed);
    expect(firstStmt(`INSERT INTO t ${q};`).source).toEqual({ kind: "select", query: tailed });
    expect(firstStmt(`INSERT INTO t (a) (SELECT 1) UNION (SELECT 2) ORDER BY 1 LIMIT 1;`).source).toEqual({
      kind: "select",
      query: tailed,
    });
    // A WITH prefix still binds to the leftmost SELECT, and the tail to the set operation.
    const withTail = firstStmt(`WITH c AS (SELECT 1) ${q};`);
    expect(withTail).toMatchObject({ kind: "setOp", orderBy: [ord(num(1))], limit: num(1) });
    expect(withTail.left.with_).toHaveLength(1);
  });

  it("ends a SELECT's span at its tail, and a set operation's at the tail after it", () => {
    const [plain] = sqlLite.parse("SELECT a FROM t ORDER BY a LIMIT 1 FOR UPDATE;");
    expect(plain!.span).toEqual({ start: { row: 1, col: 0 }, end: { row: 1, col: 45 } });
    const [union] = sqlLite.parse("SELECT 1 UNION SELECT 2 ORDER BY 1 LIMIT 1;") as any[];
    expect(union.span).toEqual({ start: { row: 1, col: 0 }, end: { row: 1, col: 42 } });
    // The right-hand arm ends at its own last token, before the tail.
    expect(union.right.span).toEqual({ start: { row: 1, col: 15 }, end: { row: 1, col: 23 } });
    // A parenthesised query keeps its start and stretches to the tail written after it.
    const [paren] = sqlLite.parse("(SELECT 1) ORDER BY 1;");
    expect(paren!.span).toEqual({ start: { row: 1, col: 1 }, end: { row: 1, col: 21 } });
  });

  it("rejects a repeated LIMIT, OFFSET or ORDER BY, within one tail or across parentheses", () => {
    const bad = (sql: string) => () => sqlLite.parse(sql);
    expect(bad("SELECT 1 LIMIT 1 LIMIT 2;")).toThrow(/multiple LIMIT clauses not allowed \(1:17\)/);
    expect(bad("SELECT 1 LIMIT 1 FETCH FIRST 2 ROWS ONLY;")).toThrow(/multiple LIMIT clauses not allowed \(1:17\)/);
    expect(bad("SELECT 1 FETCH FIRST 2 ROWS ONLY LIMIT 1;")).toThrow(/multiple LIMIT clauses not allowed/);
    expect(bad("SELECT 1 LIMIT 1 OFFSET 2 LIMIT 3;")).toThrow(/multiple LIMIT clauses not allowed/);
    expect(bad("SELECT 1 OFFSET 1 OFFSET 2;")).toThrow(/multiple OFFSET clauses not allowed \(1:18\)/);
    expect(bad("SELECT 1 UNION SELECT 2 LIMIT 1 LIMIT 2;")).toThrow(/multiple LIMIT clauses not allowed/);
    expect(bad("(SELECT 1 LIMIT 1) LIMIT 2;")).toThrow(/multiple LIMIT clauses not allowed \(1:19\)/);
    // LIMIT ALL and a count-less FETCH record no value, but are still a LIMIT.
    expect(bad("(SELECT 1 LIMIT ALL) LIMIT 2;")).toThrow(/multiple LIMIT clauses not allowed/);
    expect(bad("(SELECT 1 FETCH FIRST ROW ONLY) LIMIT 2;")).toThrow(/multiple LIMIT clauses not allowed/);
    expect(bad("((SELECT 1 LIMIT 1)) LIMIT 2;")).toThrow(/multiple LIMIT clauses not allowed/);
    expect(bad("(SELECT 1 OFFSET 1) OFFSET 2;")).toThrow(/multiple OFFSET clauses not allowed/);
    expect(bad("(SELECT 1 ORDER BY 1) ORDER BY 1;")).toThrow(/multiple ORDER BY clauses not allowed \(1:22\)/);
    expect(bad("(SELECT 1 UNION SELECT 2 ORDER BY 1) ORDER BY 1;")).toThrow(/multiple ORDER BY clauses not allowed/);
    expect(bad("(VALUES (1) LIMIT 1) LIMIT 2;")).toThrow(/multiple LIMIT clauses not allowed/);
  });

  it("rejects WITH TIES without an ORDER BY", () => {
    const bad = (sql: string) => () => sqlLite.parse(sql);
    expect(bad("SELECT 1 FETCH FIRST 2 ROWS WITH TIES;")).toThrow(
      /WITH TIES cannot be specified without ORDER BY clause \(1:9\)/,
    );
    expect(bad("SELECT 1 UNION SELECT 2 FETCH FIRST 2 ROWS WITH TIES;")).toThrow(/WITH TIES cannot be specified/);
    expect(bad("VALUES (1) FETCH FIRST 2 ROWS WITH TIES;")).toThrow(/WITH TIES cannot be specified/);
    // The ORDER BY must be there when WITH TIES is applied: a later one is too late.
    expect(bad("(SELECT 1 FETCH FIRST 2 ROWS WITH TIES) ORDER BY 1;")).toThrow(/WITH TIES cannot be specified/);
    // An ORDER BY on an arm doesn't order the set operation.
    expect(bad("(SELECT 1 ORDER BY 1) UNION SELECT 2 FETCH FIRST 2 ROWS WITH TIES;")).toThrow(
      /WITH TIES cannot be specified/,
    );
  });

  it("rejects WITH TIES together with SKIP LOCKED", () => {
    const bad = (sql: string) => () => sqlLite.parse(sql);
    expect(bad("SELECT 1 ORDER BY 1 FETCH FIRST 2 ROWS WITH TIES FOR UPDATE SKIP LOCKED;")).toThrow(
      /SKIP LOCKED and WITH TIES options cannot be used together \(1:20\)/,
    );
    expect(bad("SELECT 1 ORDER BY 1 FOR SHARE SKIP LOCKED FETCH FIRST 2 ROWS WITH TIES;")).toThrow(
      /SKIP LOCKED and WITH TIES options cannot be used together/,
    );
    expect(bad("(SELECT 1 ORDER BY 1 FOR UPDATE SKIP LOCKED) FETCH FIRST 2 ROWS WITH TIES;")).toThrow(
      /SKIP LOCKED and WITH TIES options cannot be used together/,
    );
    // PG checks only when the WITH TIES is applied, so SKIP LOCKED added after
    // the parentheses, or NOWAIT anywhere, is accepted.
    expect(firstStmt("(SELECT 1 ORDER BY 1 FETCH FIRST 2 ROWS WITH TIES) FOR UPDATE SKIP LOCKED;")).toMatchObject({
      withTies: true,
      locking: [{ strength: "update", of: [], wait: "skipLocked" }],
    });
    expect(firstStmt("SELECT 1 ORDER BY 1 FETCH FIRST 2 ROWS WITH TIES FOR UPDATE NOWAIT;")).toMatchObject({
      withTies: true,
      locking: [{ strength: "update", of: [], wait: "nowait" }],
    });
  });

  it("rejects a misplaced or malformed tail clause", () => {
    const bad = (sql: string) => () => sqlLite.parse(sql);
    // An arm takes no tail of its own: only parentheses give it one.
    expect(bad("SELECT 1 ORDER BY 1 UNION SELECT 2;")).toThrow(/Expected ";" but found "union"/);
    expect(bad("SELECT 1 LIMIT 1 UNION SELECT 2;")).toThrow(/Expected ";" but found "union"/);
    expect(bad("SELECT 1 FOR UPDATE UNION SELECT 2;")).toThrow(/Expected ";" but found "union"/);
    // Locking goes on one side of the LIMIT / OFFSET pair, and ORDER BY first.
    expect(bad("SELECT 1 FOR UPDATE LIMIT 1 FOR UPDATE;")).toThrow(/Expected ";" but found "for"/);
    expect(bad("SELECT 1 LIMIT 1 FOR UPDATE OFFSET 1;")).toThrow(/Expected ";" but found "offset"/);
    expect(bad("SELECT 1 LIMIT 1 ORDER BY 1;")).toThrow(/Expected ";" but found "order"/);
    // FOR READ ONLY stands alone.
    expect(bad("SELECT 1 FOR READ ONLY FOR UPDATE;")).toThrow(/Expected ";" but found "for"/);
    expect(bad("SELECT 1 FOR UPDATE FOR READ ONLY;")).toThrow(
      /Expected "update", "share", "no" or "key" but found "read"/,
    );
    expect(bad("SELECT 1 FOR READ;")).toThrow(/Expected "only" but found ";"/);
    // FETCH spells out FIRST | NEXT, ROW | ROWS and ONLY | WITH TIES.
    expect(bad("SELECT 1 FETCH 2 ROWS ONLY;")).toThrow(/Expected "first" or "next" but found "2"/);
    expect(bad("SELECT 1 FETCH FIRST 2 ONLY;")).toThrow(/Expected "row" or "rows" but found "only"/);
    expect(bad("SELECT 1 FETCH FIRST 2 ROWS;")).toThrow(/Expected "only" or "with ties" but found ";"/);
    expect(bad("SELECT 1 ORDER BY 1 FETCH FIRST 2 ROWS WITH;")).toThrow(/Expected "ties" but found ";"/);
    expect(bad("SELECT 1 UNION ALL DISTINCT SELECT 2;")).toThrow(/but found "distinct"/);
  });

  it("keeps the new tail words unreserved as names and aliases", () => {
    // `read` is matched only after the reserved `for`, the FETCH words only after
    // `fetch`, so all of them stay ordinary names.
    const words = ["read", "ties", "first", "next", "row", "rows"];
    expect(firstStmt(`SELECT ${words.join(", ")} FROM read;`)).toEqual(
      sel({ columns: words.map((w) => col(name(w))), from: [tableFrom(["read"])] }),
    );
    expect(firstStmt(`SELECT ${words.map((w) => `a ${w}`).join(", ")} FROM t read;`)).toEqual(
      sel({ columns: words.map((w) => col(name("a"), w)), from: [tableFrom(["t"], "read")] }),
    );
    expect(firstStmt("CREATE TABLE read (ties int, first int);").name).toEqual(["read"]);
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

// --- lexer errors inside backtracking ---

describe("SQL-lite lexer errors inside backtracking", () => {
  // The INSERT column list is tried with backtracking. The lexer consumes
  // `X'G1` before croaking, so a rollback used to resurface as a parser error
  // on the `)` that followed. sql-lite opts into lexer error propagation.
  it("reports a bad literal in an attempted branch as the lexer error", () => {
    expect(() => sqlLite.parse("INSERT INTO t (a, X'G1') VALUES (1);")).toThrow(
      /^Invalid hexadecimal digit "G" \(1:18\)$/,
    );
  });

  it("diagnose() records the lexer error once and resumes at the next statement", () => {
    const { ast, errors } = sqlLite.diagnose("SELECT 1;\nINSERT INTO t (a, X'G1') VALUES (1);\nSELECT 2;");
    expect(errors.map((error) => error.message)).toEqual(['Invalid hexadecimal digit "G" (2:18)']);
    expect((ast as Stmt[]).map((stmt) => stmt.kind)).toEqual(["select", "select"]);
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

// --- TABLE name, empty select lists, WITH … VALUES and parenthesised query starts ---

describe("SQL-lite TABLE name", () => {
  const tableCmd = (name: string[], over: Record<string, unknown> = {}) => ({ kind: "tableCmd", name, ...over });
  const one = sel({ columns: [col(num(1))] });

  it("parses TABLE as a statement, with ONLY and the inheritance star", () => {
    expect(parse("TABLE t; TABLE s.t *; TABLE ONLY t; TABLE ONLY (s.t);")).toEqual([
      tableCmd(["t"]),
      tableCmd(["s", "t"]),
      tableCmd(["t"], { only: true }),
      tableCmd(["s", "t"], { only: true }),
    ]);
  });

  it("takes a query-level tail and a WITH prefix", () => {
    expect(firstStmt("TABLE t ORDER BY 1 LIMIT 2 OFFSET 3 FOR UPDATE;")).toEqual(
      tableCmd(["t"], {
        orderBy: [{ expr: num(1), dir: null, nulls: null }],
        limit: num(2),
        offset: num(3),
        locking: [{ strength: "update", of: [], wait: null }],
      }),
    );
    expect(firstStmt("WITH c AS (SELECT 1) TABLE c;")).toEqual(
      tableCmd(["c"], { with_: [{ name: "c", columns: null, query: one }], recursive: false }),
    );
    // A parenthesised TABLE keeps its WITH when a tail follows the `)`.
    expect(firstStmt("(WITH RECURSIVE c AS (SELECT 1) TABLE c) LIMIT 1;")).toEqual(
      tableCmd(["c"], { limit: num(1), with_: [{ name: "c", columns: null, query: one }], recursive: true }),
    );
  });

  it("is a set-operation arm, a subquery, a CTE body and an INSERT source", () => {
    expect(firstStmt("TABLE t UNION ALL (TABLE u) EXCEPT SELECT 1;")).toEqual({
      kind: "setOp",
      op: "except",
      left: { kind: "setOp", op: "unionAll", left: tableCmd(["t"]), right: tableCmd(["u"]) },
      right: one,
    });
    expect(firstStmt("SELECT * FROM (TABLE t) x;")).toEqual(
      sel({ columns: [col(star())], from: [{ kind: "subquery", query: tableCmd(["t"]), alias: "x" }] }),
    );
    expect(firstStmt("SELECT 1 WHERE a IN (TABLE t) AND EXISTS (TABLE u);").where).toEqual({
      kind: "binary",
      op: "and",
      left: { kind: "inSubquery", expr: name("a"), query: tableCmd(["t"]), negated: false },
      right: { kind: "exists", query: tableCmd(["u"]), negated: false },
    });
    expect(firstStmt("SELECT (TABLE t);").columns).toEqual([col({ kind: "subquery", query: tableCmd(["t"]) })]);
    expect(firstStmt("WITH c AS (TABLE t) SELECT 1;").with_).toEqual([
      { name: "c", columns: null, query: tableCmd(["t"]) },
    ]);
    expect(firstStmt("INSERT INTO t TABLE u;").source).toEqual({ kind: "select", query: tableCmd(["u"]) });
  });

  it("is the body of every statement that takes a query", () => {
    expect(firstStmt("CREATE TABLE x AS TABLE t WITH NO DATA;")).toMatchObject({
      kind: "createTableAs",
      query: tableCmd(["t"]),
      withData: false,
    });
    expect(firstStmt("CREATE VIEW v AS TABLE t;").query).toEqual(tableCmd(["t"]));
    expect(firstStmt("PREPARE p AS TABLE t;").query).toEqual(tableCmd(["t"]));
    expect(firstStmt("EXPLAIN TABLE t;").statement).toEqual(tableCmd(["t"]));
    expect(firstStmt("EXPLAIN (TABLE t);").statement).toEqual(tableCmd(["t"]));
    expect(firstStmt("COPY (TABLE t) TO STDOUT;").query).toEqual(tableCmd(["t"]));
    expect(firstStmt("DECLARE c CURSOR FOR TABLE t;").query).toEqual(tableCmd(["t"]));
  });

  it("leaves the statements that read TABLE as a noise word alone", () => {
    expect(parse("CREATE TABLE t (a int); LOCK TABLE t; TRUNCATE TABLE t;").map((s) => s.kind)).toEqual([
      "createTable",
      "lock",
      "truncate",
    ]);
    expect(firstStmt("GRANT SELECT ON TABLE t TO r;").on).toMatchObject({ objectType: "table", names: [["t"]] });
    expect(firstStmt("SELECT a INTO TABLE x FROM t;").into).toEqual({ name: ["x"] });
  });

  it("keeps ONLY across a parenthesised tail and takes a set operation's tail as an arm", () => {
    expect(firstStmt("(TABLE ONLY t ORDER BY 1) LIMIT 2;")).toEqual(
      tableCmd(["t"], { only: true, orderBy: [{ expr: num(1), dir: null, nulls: null }], limit: num(2) }),
    );
    expect(firstStmt("TABLE t * UNION TABLE u ORDER BY 1;")).toEqual({
      kind: "setOp",
      op: "union",
      left: tableCmd(["t"]),
      right: tableCmd(["u"]),
      orderBy: [{ expr: num(1), dir: null, nulls: null }],
    });
    expect(() => sqlLite.parse("TABLE t FETCH FIRST 1 ROW WITH TIES;")).toThrow(
      /WITH TIES cannot be specified without ORDER BY clause/,
    );
  });

  it("spans from TABLE to the end of its tail", () => {
    const [stmt] = sqlLite.parse("TABLE ONLY (t) LIMIT 1;");
    expect(stmt!.span).toEqual({ start: { row: 1, col: 0 }, end: { row: 1, col: 22 } });
    expect(sqlLite.parse("TABLE t *;")[0]!.span).toEqual({ start: { row: 1, col: 0 }, end: { row: 1, col: 9 } });
  });

  it("rejects a missing name and anything PG's relation_expr doesn't take", () => {
    expect(() => sqlLite.parse("TABLE;")).toThrow(/Expected a name but found ";"/);
    expect(() => sqlLite.parse("TABLE ONLY;")).toThrow(/Expected a name but found ";"/);
    expect(() => sqlLite.parse("TABLE ONLY t *;")).toThrow(/Expected ";" but found "\*"/);
    expect(() => sqlLite.parse("TABLE ONLY (t;")).toThrow(/Expected "\)" but found ";"/);
    // No alias, column list or WHERE: it is `SELECT * FROM name`, not a FROM item.
    expect(() => sqlLite.parse("TABLE t x;")).toThrow(/Expected ";" but found "x"/);
    expect(() => sqlLite.parse("TABLE t WHERE a;")).toThrow(/Expected ";" but found "where"/);
    expect(() => sqlLite.parse("TABLE f(1);")).toThrow(/Expected ";" but found "\("/);
  });
});

describe("SQL-lite empty select list", () => {
  it("parses SELECT with no target list, as a statement and before each clause", () => {
    expect(firstStmt("SELECT;")).toEqual(sel({ columns: [] }));
    expect(firstStmt("SELECT ALL FROM t;")).toEqual(sel({ columns: [], from: [tableFrom(["t"])] }));
    expect(firstStmt("SELECT ALL;")).toEqual(sel({ columns: [] }));
    expect(firstStmt("SELECT INTO x FROM t WHERE true;")).toEqual(
      sel({ columns: [], into: { name: ["x"] }, from: [tableFrom(["t"])], where: { kind: "bool", value: true } }),
    );
    expect(firstStmt("SELECT GROUP BY a HAVING true WINDOW w AS ();")).toMatchObject({
      columns: [],
      groupBy: [name("a")],
      window: [{ name: "w" }],
    });
    expect(firstStmt("SELECT ORDER BY 1;")).toMatchObject({ columns: [], orderBy: [{ expr: num(1) }] });
    expect(firstStmt("SELECT LIMIT 1;")).toMatchObject({ columns: [], limit: num(1) });
    expect(firstStmt("SELECT OFFSET 1;")).toMatchObject({ columns: [], offset: num(1) });
    expect(firstStmt("SELECT FETCH FIRST 1 ROW ONLY;")).toMatchObject({ columns: [], limit: num(1) });
    expect(firstStmt("SELECT FOR UPDATE;")).toMatchObject({ columns: [], locking: [{ strength: "update" }] });
  });

  it("is empty as a set-operation arm, a subquery, a CTE body and an INSERT source", () => {
    expect(firstStmt("SELECT UNION (SELECT) INTERSECT SELECT;")).toEqual({
      kind: "setOp",
      op: "union",
      left: sel({}),
      right: { kind: "setOp", op: "intersect", left: sel({}), right: sel({}) },
    });
    expect(firstStmt("SELECT * FROM (SELECT) s;").from).toEqual([{ kind: "subquery", query: sel({}), alias: "s" }]);
    expect(firstStmt("SELECT EXISTS (SELECT);").columns).toEqual([
      col({ kind: "exists", query: sel({}), negated: false }),
    ]);
    expect(firstStmt("WITH c AS (SELECT) SELECT;")).toEqual(
      sel({ with_: [{ name: "c", columns: null, query: sel({}) }] }),
    );
    expect(firstStmt("INSERT INTO t SELECT ON CONFLICT DO NOTHING RETURNING *;")).toMatchObject({
      source: { kind: "select", query: sel({}) },
      onConflict: { target: null, action: { kind: "nothing" } },
      returning: [col(star())],
    });
    expect(firstStmt("CREATE TABLE x AS SELECT WITH NO DATA;")).toMatchObject({ query: sel({}), withData: false });
    // The bare SELECT spans its keyword alone.
    expect(sqlLite.parse("SELECT ;")[0]!.span).toEqual({ start: { row: 1, col: 0 }, end: { row: 1, col: 6 } });
  });

  it("still requires a list after DISTINCT and an item after every comma", () => {
    // PG's DISTINCT form takes `target_list`, not `opt_target_list`.
    expect(() => sqlLite.parse("SELECT DISTINCT FROM t;")).toThrow(/Expected a name but found "from"/);
    expect(() => sqlLite.parse("SELECT DISTINCT ON (a) FROM t;")).toThrow(/Expected a name but found "from"/);
    expect(() => sqlLite.parse("SELECT , FROM t;")).toThrow(/but found "," \(1:7\)/);
    expect(() => sqlLite.parse("SELECT a, FROM t;")).toThrow(/Expected a name but found "from"/);
    expect(() => sqlLite.parse("SELECT FROM;")).toThrow(/Expected a name but found ";"/);
  });
});

describe("SQL-lite WITH … VALUES", () => {
  const one = sel({ columns: [col(num(1))] });
  const values = (rows: unknown[][], over: Record<string, unknown> = {}) => ({
    kind: "values",
    rows,
    orderBy: null,
    limit: null,
    offset: null,
    ...over,
  });

  it("attaches the WITH prefix to the VALUES query, or to a set operation's leftmost VALUES", () => {
    expect(firstStmt("WITH RECURSIVE c AS (SELECT 1) VALUES (1), (2);")).toEqual(
      values([[num(1)], [num(2)]], { with_: [{ name: "c", columns: null, query: one }], recursive: true }),
    );
    expect(firstStmt("WITH c AS (SELECT 1) VALUES (1) UNION SELECT 1;")).toEqual({
      kind: "setOp",
      op: "union",
      left: values([[num(1)]], { with_: [{ name: "c", columns: null, query: one }], recursive: false }),
      right: one,
    });
  });

  it("keeps the WITH prefix under a query-level tail", () => {
    const withC = { with_: [{ name: "c", columns: null, query: one }], recursive: false };
    expect(firstStmt("WITH c AS (SELECT 1) VALUES (1) ORDER BY 1;")).toEqual(
      values([[num(1)]], { orderBy: [{ expr: num(1), dir: null, nulls: null }], ...withC }),
    );
    expect(firstStmt("(WITH c AS (SELECT 1) VALUES (1)) LIMIT 1;")).toEqual(
      values([[num(1)]], { limit: num(1), ...withC }),
    );
  });

  it("is a subquery, a CTE body and an INSERT source", () => {
    const withValues = { kind: "values", with_: [{ name: "c" }] };
    const body = "WITH c AS (SELECT 1) VALUES (1)";
    expect(firstStmt(`SELECT (${body});`).columns[0].expr.query).toMatchObject(withValues);
    expect(firstStmt(`WITH d AS (${body}) SELECT 1;`).with_[0].query).toMatchObject(withValues);
    expect(firstStmt(`INSERT INTO t ${body};`).source.query).toMatchObject(withValues);
  });

  it("rejects a second WITH on a parenthesised query, as PG does, at the outer WITH", () => {
    expect(() => sqlLite.parse("WITH a AS (SELECT 1) (WITH b AS (SELECT 2) VALUES (1));")).toThrow(
      /multiple WITH clauses not allowed \(1:0\)/,
    );
    expect(() => sqlLite.parse("WITH a AS (SELECT 1) ((WITH b AS (SELECT 2) TABLE t)) LIMIT 1;")).toThrow(
      /multiple WITH clauses not allowed/,
    );
    // The inner WITH heads a whole set operation, which lands on its first arm.
    expect(() => sqlLite.parse("WITH a AS (SELECT 1) (WITH b AS (SELECT 2) SELECT 1 UNION SELECT 2);")).toThrow(
      /multiple WITH clauses not allowed/,
    );
    expect(() => sqlLite.parse("SELECT (WITH a AS (SELECT 1) (WITH b AS (SELECT 2) SELECT 3) LIMIT 1);")).toThrow(
      /multiple WITH clauses not allowed/,
    );
  });

  it("puts a WITH over a set operation on the set-op node when its first arm has its own", () => {
    const cteOf = (name: string, n: number) => ({ name, columns: null, query: sel({ columns: [col(num(n))] }) });
    // One WITH over a parenthesised arm without its own goes on the arm, as before.
    expect(firstStmt("WITH a AS (SELECT 1) (SELECT 3);")).toEqual(
      sel({ with_: [cteOf("a", 1)], columns: [col(num(3))] }),
    );
    expect(firstStmt("WITH a AS (SELECT 1) (WITH b AS (SELECT 2) VALUES (3)) UNION SELECT 4 LIMIT 1;")).toEqual({
      kind: "setOp",
      op: "union",
      left: {
        kind: "values",
        rows: [[num(3)]],
        orderBy: null,
        limit: null,
        offset: null,
        with_: [cteOf("b", 2)],
        recursive: false,
      },
      right: sel({ columns: [col(num(4))] }),
      limit: num(1),
      with_: [cteOf("a", 1)],
      recursive: false,
    });
    // The same through a nested set operation, with the WITH inside parentheses.
    expect(
      firstStmt("SELECT (WITH a AS (SELECT 1) (WITH b AS (SELECT 2) SELECT 1 UNION SELECT 2) EXCEPT SELECT 3);")
        .columns[0].expr.query,
    ).toMatchObject({
      kind: "setOp",
      op: "except",
      left: { kind: "setOp", op: "union", left: { with_: [{ name: "b" }] } },
      with_: [{ name: "a" }],
    });
  });
});

describe("SQL-lite parenthesised VALUES and set operations as subqueries", () => {
  const values = (...rows: unknown[][]) => ({ kind: "values", rows, orderBy: null, limit: null, offset: null });
  const one = sel({ columns: [col(num(1))] });
  const two = sel({ columns: [col(num(2))] });

  it("reads (VALUES …) as a subquery in every expression position", () => {
    expect(firstStmt("SELECT (VALUES (1));").columns).toEqual([col({ kind: "subquery", query: values([num(1)]) })]);
    expect(firstStmt("SELECT 1 WHERE (a, b) IN (VALUES (1, 2), (3, 4));").where).toEqual({
      kind: "inSubquery",
      expr: { kind: "row", items: [name("a"), name("b")], implicit: true },
      query: values([num(1), num(2)], [num(3), num(4)]),
      negated: false,
    });
    expect(firstStmt("SELECT 1 WHERE a = ANY (VALUES (1));").where).toEqual({
      kind: "anyAll",
      op: "=",
      quantifier: "any",
      left: name("a"),
      right: { kind: "subquery", query: values([num(1)]) },
    });
    expect(firstStmt("UPDATE t SET (a, b) = (VALUES (1, 2));").set).toEqual([
      { columns: ["a", "b"], value: { kind: "subquery", query: values([num(1), num(2)]) } },
    ]);
  });

  it("reads a parenthesised set operation or tail as a subquery", () => {
    const union = { kind: "setOp", op: "union", left: one, right: two };
    expect(firstStmt("SELECT ((SELECT 1) UNION (SELECT 2));").columns).toEqual([
      col({ kind: "subquery", query: union }),
    ]);
    expect(firstStmt("SELECT 1 WHERE a IN ((SELECT 1) UNION SELECT 2);").where).toEqual({
      kind: "inSubquery",
      expr: name("a"),
      query: union,
      negated: false,
    });
    expect(firstStmt("SELECT 1 WHERE a IN (((SELECT 1)) UNION ((SELECT 2)));").where.query).toEqual(union);
    expect(firstStmt("SELECT EXISTS ((VALUES (1)) EXCEPT (VALUES (2)));").columns[0].expr.query).toEqual({
      kind: "setOp",
      op: "except",
      left: values([num(1)]),
      right: values([num(2)]),
    });
    expect(firstStmt("SELECT ((VALUES (2), (1)) ORDER BY 1 LIMIT 1);").columns[0].expr.query).toEqual({
      ...values([num(2)], [num(1)]),
      orderBy: [{ expr: num(1), dir: null, nulls: null }],
      limit: num(1),
    });
  });

  it("reads them as FROM items", () => {
    expect(firstStmt("SELECT * FROM (VALUES (1), (2)) AS v (a);").from).toEqual([
      { kind: "subquery", query: values([num(1)], [num(2)]), alias: "v", columns: ["a"] },
    ]);
    expect(firstStmt("SELECT * FROM ((VALUES (1)) UNION (TABLE t)) x;").from).toEqual([
      {
        kind: "subquery",
        query: { kind: "setOp", op: "union", left: values([num(1)]), right: { kind: "tableCmd", name: ["t"] } },
        alias: "x",
      },
    ]);
  });

  it("keeps a redundantly parenthesised subquery or an expression around one as before", () => {
    const sub = { kind: "subquery", query: one };
    expect(firstStmt("SELECT ((SELECT 1));").columns).toEqual([col(sub)]);
    expect(firstStmt("SELECT ((SELECT 1) + 1);").columns).toEqual([col(bin("+", sub, num(1)))]);
    expect(firstStmt("SELECT ((SELECT 1), 2);").columns).toEqual([
      col({ kind: "row", items: [sub, num(2)], implicit: true }),
    ]);
    // The inner subquery's span, not the outer parentheses'.
    const [stmt] = sqlLite.parse("SELECT ((SELECT 1));") as any[];
    expect(stmt.columns[0].expr.span).toEqual({ start: { row: 1, col: 8 }, end: { row: 1, col: 18 } });
  });

  it("spans a parenthesised set operation from its outer parenthesis", () => {
    const [stmt] = sqlLite.parse("SELECT ((SELECT 1) UNION (SELECT 2));") as any[];
    expect(stmt.columns[0].expr.span).toEqual({ start: { row: 1, col: 7 }, end: { row: 1, col: 36 } });
  });

  it("rejects malformed parenthesised queries", () => {
    expect(() => sqlLite.parse("SELECT (VALUES);")).toThrow(/Expected "\(" but found "\)"/);
    expect(() => sqlLite.parse("SELECT ((SELECT 1) UNION SELECT 2;")).toThrow(/Expected "\)" but found ";"/);
    expect(() => sqlLite.parse("SELECT ((SELECT 1) UNION);")).toThrow(/but found "\)"/);
    expect(() => sqlLite.parse("SELECT 1 WHERE a IN (VALUES (1)) x;")).toThrow(/Expected ";" but found "x"/);
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

  it("attaches a WITH prefix to a bare VALUES query", () => {
    expect(parse("WITH c AS (SELECT 1) VALUES (1);")[0]).toMatchObject({
      kind: "values",
      with_: [{ name: "c" }],
      recursive: false,
    });
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

// --- GRANT / REVOKE: object kinds, role grant options, GRANTED BY ---

describe("SQL-lite GRANT / REVOKE object kinds and options", () => {
  const type = (n: string) => ({ name: n, args: [], array: false });
  const arg = (typeName: string, argName: string | null = null, mode: string | null = null) => ({
    mode,
    name: argName,
    type: type(typeName),
    defaultValue: null,
  });
  const grant = (over: Record<string, unknown>) => ({ kind: "grant", withGrantOption: false, ...over });
  const usage = [{ name: "usage", columns: null }];

  it("names routines with their argument types, the way pg_dump writes them", () => {
    expect(firstStmt("GRANT ALL ON PROCEDURE app.archive(IN p_id integer), cleanup TO u;")).toEqual(
      grant({
        privileges: "all",
        on: {
          objectType: "procedure",
          names: [["app", "archive"], ["cleanup"]],
          inSchema: null,
          signatures: [{ star: false, args: [arg("integer", "p_id", "in")] }, null],
        },
        grantees: ["u"],
      }),
    );
    expect(firstStmt("REVOKE EXECUTE ON FUNCTION f(), g(text, int) FROM PUBLIC;")).toEqual({
      kind: "revoke",
      grantOptionFor: false,
      privileges: [{ name: "execute", columns: null }],
      on: {
        objectType: "function",
        names: [["f"], ["g"]],
        inSchema: null,
        signatures: [
          { star: false, args: [] },
          { star: false, args: [arg("text"), arg("int")] },
        ],
      },
      grantees: ["public"],
      behavior: null,
    });
    // With no argument list anywhere, the object keeps its plain shape.
    expect((firstStmt("GRANT EXECUTE ON ROUTINE r, s TO u;") as any).on).toEqual({
      objectType: "routine",
      names: [["r"], ["s"]],
      inSchema: null,
    });
    // A routine reference takes no argument defaults, as on DROP.
    expect(() => sqlLite.parse("GRANT EXECUTE ON FUNCTION f(a int = 1) TO u;")).toThrow(/takes no argument defaults/);
  });

  it("parses ALL … IN SCHEMA for every plural PG allows", () => {
    expect(firstStmt("GRANT EXECUTE ON ALL ROUTINES IN SCHEMA a, b TO u;")).toEqual(
      grant({
        privileges: [{ name: "execute", columns: null }],
        on: { objectType: "routine", names: [], inSchema: [["a"], ["b"]] },
        grantees: ["u"],
      }),
    );
    for (const [plural, objectType] of [
      ["TABLES", "table"],
      ["SEQUENCES", "sequence"],
      ["FUNCTIONS", "function"],
      ["PROCEDURES", "procedure"],
    ]) {
      expect((firstStmt(`GRANT ALL ON ALL ${plural} IN SCHEMA s TO u;`) as any).on).toEqual({
        objectType,
        names: [],
        inSchema: [["s"]],
      });
    }
    // A schema name has one part.
    expect(() => sqlLite.parse("GRANT ALL ON ALL TABLES IN SCHEMA a.b TO u;")).toThrow(/Expected "to" but found "\."/);
  });

  it("parses the foreign-data, large-object and parameter kinds", () => {
    const on = (sql: string) => (firstStmt(sql) as any).on;
    expect(on("GRANT USAGE ON FOREIGN DATA WRAPPER postgres_fdw, w2 TO u;")).toEqual({
      objectType: "foreign data wrapper",
      names: [["postgres_fdw"], ["w2"]],
      inSchema: null,
    });
    expect(on("GRANT USAGE ON FOREIGN SERVER remote TO u;")).toEqual({
      objectType: "foreign server",
      names: [["remote"]],
      inSchema: null,
    });
    expect(firstStmt("GRANT SELECT, UPDATE ON LARGE OBJECT 16401, -5 TO u;")).toEqual(
      grant({
        privileges: [
          { name: "select", columns: null },
          { name: "update", columns: null },
        ],
        on: { objectType: "large object", names: [], inSchema: null, oids: [16401, -5] },
        grantees: ["u"],
      }),
    );
    expect(firstStmt("GRANT SET, ALTER SYSTEM ON PARAMETER work_mem, plpgsql.extra_warnings TO u;")).toEqual(
      grant({
        privileges: [
          { name: "set", columns: null },
          { name: "alter system", columns: null },
        ],
        on: { objectType: "parameter", names: [["work_mem"], ["plpgsql", "extra_warnings"]], inSchema: null },
        grantees: ["u"],
      }),
    );
    expect(firstStmt("GRANT SELECT ON LARGE OBJECT +7 TO u;")).toEqual(
      grant({
        privileges: [{ name: "select", columns: null }],
        on: { objectType: "large object", names: [], inSchema: null, oids: [7] },
        grantees: ["u"],
      }),
    );
    expect(() => sqlLite.parse("GRANT SELECT ON LARGE OBJECT lo TO u;")).toThrow(/Expected a number but found "lo"/);
    expect(() => sqlLite.parse("GRANT USAGE ON FOREIGN TABLE t TO u;")).toThrow(
      /Expected "data" or "server" but found "table"/,
    );
  });

  it("parses the remaining named kinds, single-part where PG takes a plain name", () => {
    const kinds: [string, string, string[]][] = [
      ["SEQUENCE s.q", "sequence", ["s", "q"]],
      ["DATABASE appdb", "database", ["appdb"]],
      ["DOMAIN s.d", "domain", ["s", "d"]],
      ["LANGUAGE plpgsql", "language", ["plpgsql"]],
      ["SCHEMA app", "schema", ["app"]],
      ["TABLESPACE fast", "tablespace", ["fast"]],
      ["TYPE s.mood", "type", ["s", "mood"]],
    ];
    for (const [target, objectType, name] of kinds) {
      expect((firstStmt(`GRANT USAGE ON ${target} TO u;`) as any).on).toEqual({
        objectType,
        names: [name],
        inSchema: null,
      });
    }
    for (const target of ["SCHEMA a.b", "DATABASE a.b", "LANGUAGE a.b", "TABLESPACE a.b"]) {
      expect(() => sqlLite.parse(`GRANT USAGE ON ${target} TO u;`)).toThrow(/Expected "to" but found "\."/);
    }
  });

  it("reads a kind word with no name after it as a table's name", () => {
    expect((firstStmt("GRANT SELECT ON function, parameter, type.t TO u;") as any).on).toEqual({
      objectType: "table",
      names: [["function"], ["parameter"], ["type", "t"]],
      inSchema: null,
    });
    expect((firstStmt("GRANT SELECT ON large TO u;") as any).on).toEqual({
      objectType: "table",
      names: [["large"]],
      inSchema: null,
    });
  });

  it("parses ALL with a column list", () => {
    expect(firstStmt("GRANT ALL PRIVILEGES (a, b) ON t TO u;")).toEqual(
      grant({
        privileges: "all",
        allColumns: ["a", "b"],
        on: { objectType: "table", names: [["t"]], inSchema: null },
        grantees: ["u"],
      }),
    );
    expect(firstStmt("REVOKE ALL (a) ON t FROM u;")).toEqual({
      kind: "revoke",
      grantOptionFor: false,
      privileges: "all",
      allColumns: ["a"],
      on: { objectType: "table", names: [["t"]], inSchema: null },
      grantees: ["u"],
      behavior: null,
    });
  });

  it("parses GRANTED BY on object grants and revokes", () => {
    expect(
      firstStmt("GRANT USAGE ON SCHEMA s TO GROUP g, CURRENT_ROLE WITH GRANT OPTION GRANTED BY SESSION_USER;"),
    ).toEqual(
      grant({
        privileges: usage,
        on: { objectType: "schema", names: [["s"]], inSchema: null },
        grantees: ["g", "current_role"],
        withGrantOption: true,
        grantedBy: "session_user",
      }),
    );
    expect(firstStmt("REVOKE GRANT OPTION FOR USAGE ON SCHEMA s FROM u GRANTED BY CURRENT_USER RESTRICT;")).toEqual({
      kind: "revoke",
      grantOptionFor: true,
      privileges: usage,
      on: { objectType: "schema", names: [["s"]], inSchema: null },
      grantees: ["u"],
      grantedBy: "current_user",
      behavior: "restrict",
    });
  });

  it("takes the new object forms as CREATE SCHEMA elements", () => {
    const stmt = firstStmt(
      "CREATE SCHEMA s GRANT EXECUTE ON FUNCTION f(int) TO u GRANTED BY x CREATE TABLE t (a int);",
    ) as any;
    expect(stmt.elements.map((e: any) => e.kind)).toEqual(["grant", "createTable"]);
    expect(stmt.elements[0]).toEqual(
      grant({
        privileges: [{ name: "execute", columns: null }],
        on: {
          objectType: "function",
          names: [["f"]],
          inSchema: null,
          signatures: [{ star: false, args: [arg("int")] }],
        },
        grantees: ["u"],
        grantedBy: "x",
      }),
    );
  });

  it("parses a role grant's WITH options and GRANTED BY", () => {
    expect(firstStmt("GRANT app_reader TO app_owner WITH INHERIT TRUE GRANTED BY postgres;")).toEqual(
      grant({
        privileges: [{ name: "app_reader", columns: null }],
        on: null,
        grantees: ["app_owner"],
        options: [{ name: "inherit", value: true }],
        grantedBy: "postgres",
      }),
    );
    expect(firstStmt("GRANT a, b TO c, CURRENT_USER WITH ADMIN OPTION, INHERIT FALSE, SET TRUE;")).toEqual(
      grant({
        privileges: [
          { name: "a", columns: null },
          { name: "b", columns: null },
        ],
        on: null,
        grantees: ["c", "current_user"],
        withGrantOption: true,
        options: [
          { name: "admin", value: true },
          { name: "inherit", value: false },
          { name: "set", value: true },
        ],
      }),
    );
    // `withGrantOption` follows ADMIN; the lone ADMIN grant needs no options.
    expect(firstStmt('GRANT r TO u WITH ADMIN FALSE, "set" OPTION;')).toEqual(
      grant({
        privileges: [{ name: "r", columns: null }],
        on: null,
        grantees: ["u"],
        options: [
          { name: "admin", value: false },
          { name: "set", value: true },
        ],
      }),
    );
    expect(firstStmt("GRANT r TO u WITH ADMIN TRUE;")).toEqual(
      grant({ privileges: [{ name: "r", columns: null }], on: null, grantees: ["u"], withGrantOption: true }),
    );
  });

  it("parses REVOKE {ADMIN | INHERIT | SET} OPTION FOR on a role", () => {
    expect(firstStmt("REVOKE INHERIT OPTION FOR r FROM u GRANTED BY x CASCADE;")).toEqual({
      kind: "revoke",
      grantOptionFor: false,
      option: "inherit",
      privileges: [{ name: "r", columns: null }],
      on: null,
      grantees: ["u"],
      grantedBy: "x",
      behavior: "cascade",
    });
    expect(firstStmt("REVOKE SET OPTION FOR r FROM u;")).toEqual({
      kind: "revoke",
      grantOptionFor: false,
      option: "set",
      privileges: [{ name: "r", columns: null }],
      on: null,
      grantees: ["u"],
      behavior: null,
    });
    // The option's name may be quoted, as any name may.
    expect(firstStmt('REVOKE "set" OPTION FOR r FROM u;')).toEqual({
      kind: "revoke",
      grantOptionFor: false,
      option: "set",
      privileges: [{ name: "r", columns: null }],
      on: null,
      grantees: ["u"],
      behavior: null,
    });
    expect(firstStmt("REVOKE ADMIN OPTION FOR r FROM u;")).toEqual({
      kind: "revoke",
      grantOptionFor: true,
      privileges: [{ name: "r", columns: null }],
      on: null,
      grantees: ["u"],
      behavior: null,
    });
  });

  it("rejects what PG's grammar refuses", () => {
    const fails = (text: string) => () => sqlLite.parse(text);
    // ALL is an object's; a role grant names roles, and its grantees take no GROUP.
    expect(fails("GRANT ALL TO u;")).toThrow(/Expected "on" but found "to"/);
    expect(fails("GRANT r TO GROUP u;")).toThrow(/Expected a name but found "group"/);
    expect(fails("REVOKE r FROM GROUP u;")).toThrow(/Expected a name but found "group"/);
    // Each kind of grant has its own WITH.
    expect(fails("GRANT SELECT ON t TO u WITH ADMIN OPTION;")).toThrow(/Expected "grant option" but found "admin"/);
    expect(fails("GRANT r TO u WITH GRANT OPTION;")).toThrow(/Expected "admin", "inherit" or "set" but found "grant"/);
    expect(fails("GRANT r TO u WITH INHERIT;")).toThrow(/Expected "option", "true" or "false" but found ";"/);
    expect(fails("GRANT r TO u WITH ADMIN OPTION, ;")).toThrow(/Expected "admin", "inherit" or "set" but found ";"/);
    // GRANT OPTION FOR revokes an object's privileges, the others a role's.
    expect(fails("REVOKE GRANT OPTION FOR r FROM u;")).toThrow(/Expected "on" but found "from"/);
    expect(fails("REVOKE ADMIN OPTION FOR SELECT ON t FROM u;")).toThrow(/Expected "from" but found "on"/);
    expect(fails("REVOKE ADMIN OPTION FOR ALL ON t FROM u;")).toThrow(/Expected a name but found "all"/);
    expect(fails("REVOKE SELECT ON t FROM u CASCADE GRANTED BY x;")).toThrow(ParseError);
    expect(fails("GRANT SELECT ON t TO u GRANTED x;")).toThrow(/Expected "by" but found "x"/);
  });
});

// --- ALTER DEFAULT PRIVILEGES ---

describe("SQL-lite ALTER DEFAULT PRIVILEGES", () => {
  it("parses FOR ROLE / IN SCHEMA options and a GRANT", () => {
    expect(
      firstStmt("ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA app GRANT SELECT ON TABLES TO app_reader;"),
    ).toEqual({
      kind: "alterDefaultPrivileges",
      options: [
        { kind: "forRole", roles: ["app_owner"] },
        { kind: "inSchema", schemas: ["app"] },
      ],
      action: {
        kind: "grant",
        privileges: [{ name: "select", columns: null }],
        objectType: "table",
        grantees: ["app_reader"],
        withGrantOption: false,
      },
    });
  });

  it("parses a REVOKE, repeated options and every object plural", () => {
    expect(
      firstStmt(
        "ALTER DEFAULT PRIVILEGES IN SCHEMA a, b FOR USER x, CURRENT_USER IN SCHEMA c REVOKE GRANT OPTION FOR ALL PRIVILEGES ON FUNCTIONS FROM PUBLIC, GROUP g CASCADE;",
      ),
    ).toEqual({
      kind: "alterDefaultPrivileges",
      options: [
        { kind: "inSchema", schemas: ["a", "b"] },
        { kind: "forRole", roles: ["x", "current_user"] },
        { kind: "inSchema", schemas: ["c"] },
      ],
      action: {
        kind: "revoke",
        grantOptionFor: true,
        privileges: "all",
        objectType: "function",
        grantees: ["public", "g"],
        behavior: "cascade",
      },
    });
    for (const [plural, objectType] of [
      ["TABLES", "table"],
      ["FUNCTIONS", "function"],
      ["ROUTINES", "routine"],
      ["SEQUENCES", "sequence"],
      ["TYPES", "type"],
      ["SCHEMAS", "schema"],
    ]) {
      const stmt = firstStmt(`ALTER DEFAULT PRIVILEGES GRANT ALL ON ${plural} TO u WITH GRANT OPTION;`) as any;
      expect(stmt.options).toEqual([]);
      expect(stmt.action).toEqual({
        kind: "grant",
        privileges: "all",
        objectType,
        grantees: ["u"],
        withGrantOption: true,
      });
    }
  });

  it("parses ALL with a column list", () => {
    expect(firstStmt("ALTER DEFAULT PRIVILEGES GRANT ALL (c) ON TABLES TO u;")).toEqual({
      kind: "alterDefaultPrivileges",
      options: [],
      action: {
        kind: "grant",
        privileges: "all",
        allColumns: ["c"],
        objectType: "table",
        grantees: ["u"],
        withGrantOption: false,
      },
    });
  });

  it("rejects malformed ALTER DEFAULT PRIVILEGES", () => {
    const fails = (text: string) => () => sqlLite.parse(text);
    expect(fails("ALTER DEFAULT PRIVILEGES GRANT SELECT ON PROCEDURES TO u;")).toThrow(
      /Expected "tables", "functions", "routines", "sequences", "types" or "schemas" but found "procedures"/,
    );
    expect(fails("ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLE t TO u;")).toThrow(/but found "table"/);
    expect(fails("ALTER DEFAULT PRIVILEGES SET x;")).toThrow(
      /Expected "for", "in", "grant" or "revoke" but found "set"/,
    );
    expect(fails("ALTER DEFAULT PRIVILEGES FOR GROUP g GRANT ALL ON TABLES TO u;")).toThrow(
      /Expected "role" or "user" but found "group"/,
    );
    expect(fails("ALTER DEFAULT PRIVILEGES IN SCHEMA a.b GRANT ALL ON TABLES TO u;")).toThrow(ParseError);
    // PG takes no GRANTED BY here.
    expect(fails("ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO u GRANTED BY x;")).toThrow(ParseError);
    expect(fails("ALTER DEFAULT PRIVILEGES REVOKE ALL ON TABLES FROM u GRANTED BY x;")).toThrow(ParseError);
    expect(fails("ALTER DEFAULT GRANT ALL ON TABLES TO u;")).toThrow(/Expected "privileges" but found "grant"/);
  });
});

// --- DROP OWNED / REASSIGN OWNED / CREATE GROUP ---

describe("SQL-lite DROP OWNED", () => {
  it("parses DROP OWNED BY with an optional behavior", () => {
    expect(firstStmt("DROP OWNED BY old_role, CURRENT_USER CASCADE;")).toEqual({
      kind: "dropOwned",
      roles: ["old_role", "current_user"],
      behavior: "cascade",
    });
    expect(firstStmt("DROP OWNED BY r;")).toEqual({ kind: "dropOwned", roles: ["r"], behavior: null });
    expect(firstStmt("DROP OWNED BY r RESTRICT;")).toEqual({ kind: "dropOwned", roles: ["r"], behavior: "restrict" });
    expect(() => sqlLite.parse("DROP OWNED r;")).toThrow(/Expected "by" but found "r"/);
  });
});

describe("SQL-lite REASSIGN OWNED", () => {
  it("parses REASSIGN OWNED BY … TO", () => {
    expect(firstStmt("REASSIGN OWNED BY a, SESSION_USER TO CURRENT_ROLE;")).toEqual({
      kind: "reassignOwned",
      roles: ["a", "session_user"],
      newRole: "current_role",
    });
    expect(() => sqlLite.parse("REASSIGN OWNED BY a;")).toThrow(/Expected "to" but found ";"/);
    expect(() => sqlLite.parse("REASSIGN OWNED BY a TO b, c;")).toThrow(ParseError);
  });
});

describe("SQL-lite CREATE GROUP", () => {
  it("parses CREATE GROUP with the role options", () => {
    expect(firstStmt("CREATE GROUP devs;")).toEqual({
      kind: "createRole",
      user: false,
      group: true,
      name: "devs",
      options: [],
    });
    expect(firstStmt("CREATE GROUP g WITH USER a, b IN ROLE parent;")).toEqual({
      kind: "createRole",
      user: false,
      group: true,
      name: "g",
      options: [
        { kind: "role", roles: ["a", "b"] },
        { kind: "inRole", roles: ["parent"] },
      ],
    });
    expect(firstStmt("CREATE ROLE r;")).not.toHaveProperty("group");
    expect(() => sqlLite.parse("CREATE GROUP;")).toThrow(/Expected a name but found ";"/);
  });
});

describe("SQL-lite privilege words", () => {
  it("keeps the privilege words unreserved as names and aliases", () => {
    const words = [
      ...["owned", "reassign", "privileges", "admin", "inherit", "granted", "parameter", "wrapper"],
      ...["server", "large", "object", "system", "types", "schemas", "tables", "routines"],
    ];
    expect((firstStmt(`SELECT ${words.join(", ")} FROM t;`) as any).columns).toEqual(words.map((w) => col(name(w))));
    expect(firstStmt("CREATE TABLE types (schemas int);")).toMatchObject({ name: ["types"] });
    expect(
      (firstStmt("SELECT 1 AS owned, 2 granted, 3 reassign FROM reassign AS privileges;") as any).columns,
    ).toHaveLength(3);
    expect(firstStmt("CREATE TABLE reassign (owned int, granted int, parameter int);")).toMatchObject({
      name: ["reassign"],
    });
    expect(firstStmt("DROP OWNED BY owned;")).toMatchObject({ roles: ["owned"] });
    expect(firstStmt("REASSIGN OWNED BY reassign TO granted;")).toMatchObject({
      roles: ["reassign"],
      newRole: "granted",
    });
    expect(firstStmt("GRANT admin, inherit TO granted WITH INHERIT OPTION;")).toMatchObject({
      privileges: [
        { name: "admin", columns: null },
        { name: "inherit", columns: null },
      ],
      grantees: ["granted"],
    });
    expect(firstStmt("GRANT SELECT (owned, granted) ON privileges TO admin GRANTED BY inherit;")).toMatchObject({
      privileges: [{ name: "select", columns: ["owned", "granted"] }],
      on: { names: [["privileges"]] },
      grantees: ["admin"],
      grantedBy: "inherit",
    });
    expect(
      firstStmt("ALTER DEFAULT PRIVILEGES FOR ROLE owned IN SCHEMA granted GRANT ALL ON TABLES TO admin;"),
    ).toMatchObject({
      options: [
        { kind: "forRole", roles: ["owned"] },
        { kind: "inSchema", schemas: ["granted"] },
      ],
    });
    expect(firstStmt("DROP TABLE owned;")).toMatchObject({ kind: "drop", names: [["owned"]] });
  });
});

// --- Phase 9: transaction control ---

describe("SQL-lite transaction control", () => {
  const bad = (src: string) => () => sqlLite.parse(src);

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

  it("parses END as COMMIT and ABORT as ROLLBACK", () => {
    expect(firstStmt("END;")).toEqual({ kind: "commit", chain: false });
    expect(firstStmt("END WORK;")).toEqual({ kind: "commit", chain: false });
    expect(firstStmt("END TRANSACTION AND CHAIN;")).toEqual({ kind: "commit", chain: true });
    expect(firstStmt("END AND NO CHAIN;")).toEqual({ kind: "commit", chain: false });
    expect(firstStmt("ABORT;")).toEqual({ kind: "rollback", chain: false, savepoint: null });
    expect(firstStmt("ABORT WORK AND CHAIN;")).toEqual({ kind: "rollback", chain: true, savepoint: null });
    expect(firstStmt("ABORT TRANSACTION AND NO CHAIN;")).toEqual({ kind: "rollback", chain: false, savepoint: null });
  });

  it("rejects the forms END and ABORT do not share with COMMIT and ROLLBACK", () => {
    expect(bad("ABORT TO SAVEPOINT sp1;")).toThrow(/Expected ";" but found "to"/);
    expect(bad("ABORT PREPARED 'tx1';")).toThrow(/Expected ";" but found "prepared"/);
    expect(bad("END PREPARED 'tx1';")).toThrow(/Expected ";" but found "prepared"/);
    expect(bad("END AND;")).toThrow(/Expected "chain" but found ";"/);
  });

  it("parses PREPARE TRANSACTION, COMMIT PREPARED and ROLLBACK PREPARED", () => {
    expect(firstStmt("PREPARE TRANSACTION 'tx1';")).toEqual({ kind: "prepareTransaction", gid: "tx1" });
    expect(firstStmt("COMMIT PREPARED 'tx1';")).toEqual({ kind: "commitPrepared", gid: "tx1" });
    expect(firstStmt("ROLLBACK PREPARED $$tx1$$;")).toEqual({ kind: "rollbackPrepared", gid: "tx1" });
  });

  it("still reads PREPARE transaction AS … as a statement named transaction", () => {
    expect(firstStmt("PREPARE transaction AS SELECT 1;")).toMatchObject({ kind: "prepare", name: "transaction" });
    expect(firstStmt("PREPARE transaction (int) AS SELECT $1;")).toMatchObject({
      kind: "prepare",
      name: "transaction",
      types: [{ name: "int" }],
    });
  });

  it("rejects a two-phase statement without its identifier string", () => {
    expect(bad("COMMIT PREPARED;")).toThrow(/Expected a string but found ";"/);
    expect(bad("ROLLBACK PREPARED tx1;")).toThrow(/Expected a string but found "tx1"/);
    expect(bad("COMMIT WORK PREPARED 'tx1';")).toThrow(/Expected ";" but found "prepared"/);
    // Without a string, TRANSACTION is a statement name that needs AS.
    expect(bad("PREPARE TRANSACTION tx1;")).toThrow(/Expected "as" but found "tx1"/);
  });

  it("keeps abort, prepared and chain unreserved as names and aliases", () => {
    for (const word of ["abort", "prepared", "chain"]) {
      expect(firstStmt(`SELECT ${word} FROM ${word};`)).toMatchObject({
        columns: [{ expr: name(word), alias: null }],
        from: [tableFrom([word])],
      });
      expect(firstStmt(`SELECT a ${word} FROM t;`).columns[0]).toEqual({ expr: name("a"), alias: word });
      expect(firstStmt(`CREATE TABLE t (${word} int);`).items[0]).toMatchObject({ name: word });
    }
    expect(firstStmt("PREPARE prepared AS SELECT 1;")).toMatchObject({ kind: "prepare", name: "prepared" });
  });

  it("leaves a CASE's END to the expression", () => {
    const [query, end] = parse("SELECT CASE WHEN a THEN 1 END FROM t; END;");
    expect(query).toMatchObject({ kind: "select", columns: [{ expr: { kind: "case" } }] });
    expect(end).toEqual({ kind: "commit", chain: false });
    expect(() => sqlLite.parse("SELECT 1 END;")).toThrow(/Expected ";" but found "end"/);
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

// --- SET values, as PostgreSQL's var_value ---

describe("SQL-lite SET values", () => {
  const values = (src: string) => (firstStmt(`SET x = ${src};`) as any).values;

  it("parses the pg_dump header settings, ON included", () => {
    expect(firstStmt("SET standard_conforming_strings = on;")).toEqual({
      kind: "set",
      scope: null,
      name: "standard_conforming_strings",
      values: [name("on")],
    });
    expect(values("off")).toEqual([name("off")]);
    expect(values("false")).toEqual([{ kind: "bool", value: false }]);
    expect(firstStmt("SELECT pg_catalog.set_config('search_path', '', false);").columns[0].expr).toEqual({
      kind: "call",
      name: "pg_catalog.set_config",
      args: [str("search_path"), str(""), { kind: "bool", value: false }],
    });
  });

  it("admits the words sql-lite reserves but PostgreSQL does not", () => {
    expect(values("left, set, values")).toEqual([name("left"), name("set"), name("values")]);
    expect(() => sqlLite.parse("SET x = system_user;")).toThrow(/Expected a parameter value but found "system_user"/);
  });

  it("parses lists of words, strings, quoted names and signed numbers", () => {
    expect(firstStmt("SET x=-1;").values).toEqual([{ kind: "unary", op: "-", operand: num(1) }]);
    expect(values(`"$user", public, 'a b', 1.5, -1, +2`)).toEqual([
      name("$user"),
      name("public"),
      str("a b"),
      num(1.5),
      { kind: "unary", op: "-", operand: num(1) },
      { kind: "unary", op: "+", operand: num(2) },
    ]);
  });

  it("parses SET … FROM CURRENT", () => {
    expect(firstStmt("SET LOCAL search_path FROM CURRENT;")).toEqual({
      kind: "set",
      scope: "local",
      name: "search_path",
      values: "fromCurrent",
    });
  });

  it("shares the value rule with a routine's SET option", () => {
    const options = (src: string) =>
      (firstStmt(`CREATE FUNCTION f() RETURNS int LANGUAGE sql ${src} AS 'SELECT 1';`) as any).options.slice(1, -1);
    expect(options("SET x = on SET y TO DEFAULT SET TIME ZONE 'UTC' SET z FROM CURRENT")).toEqual([
      { kind: "set", parameter: "x", value: { kind: "list", values: [name("on")] } },
      { kind: "set", parameter: "y", value: { kind: "default" } },
      { kind: "set", parameter: "time zone", value: { kind: "list", values: [str("UTC")] } },
      { kind: "set", parameter: "z", value: { kind: "fromCurrent" } },
    ]);
    expect(() => sqlLite.parse("CREATE FUNCTION f() RETURNS int SET x = 1 + 2 AS 'SELECT 1';")).toThrow(
      /Expected ";" but found "\+"/,
    );
  });

  it("rejects an expression where PostgreSQL takes a single value", () => {
    expect(() => sqlLite.parse("SET x = 1 + 2;")).toThrow(/Expected ";" but found "\+" \(1:10\)/);
    expect(() => sqlLite.parse("SET x = a.b;")).toThrow(/Expected ";" but found "\."/);
    expect(() => sqlLite.parse("SET x = lower('A');")).toThrow(/Expected ";" but found "\("/);
    expect(() => sqlLite.parse("SET x = null;")).toThrow(/Expected a parameter value but found "null"/);
    expect(() => sqlLite.parse("SET x TO DEFAULT, 1;")).toThrow(/Expected ";" but found ","/);
    expect(() => sqlLite.parse("SET x;")).toThrow(/Expected "to" or "=" but found ";"/);
  });
});

// --- The special SET forms ---

describe("SQL-lite SET special forms", () => {
  it("parses SET TRANSACTION and SET SESSION CHARACTERISTICS", () => {
    expect(firstStmt("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE, READ ONLY NOT DEFERRABLE;")).toEqual({
      kind: "setTransaction",
      scope: null,
      characteristics: false,
      modes: [
        { kind: "isolation", level: "serializable" },
        { kind: "readWrite", value: false },
        { kind: "deferrable", value: false },
      ],
    });
    expect(firstStmt("SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE;")).toEqual({
      kind: "setTransaction",
      scope: null,
      characteristics: true,
      modes: [{ kind: "readWrite", value: true }],
    });
    expect(firstStmt("SET LOCAL TRANSACTION DEFERRABLE;")).toMatchObject({ scope: "local", characteristics: false });
    expect(firstStmt("SET SESSION SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;")).toMatchObject({
      scope: "session",
      characteristics: true,
    });
    expect(firstStmt("SET TRANSACTION SNAPSHOT '00000003-1';")).toEqual({
      kind: "set",
      scope: null,
      name: "transaction snapshot",
      values: [str("00000003-1")],
    });
    expect(() => sqlLite.parse("SET TRANSACTION;")).toThrow(/Expected "isolation", .* but found ";"/);
    expect(() => sqlLite.parse("SET TRANSACTION READ ONLY,;")).toThrow(/Expected "isolation", .* but found ";"/);
    expect(() => sqlLite.parse("BEGIN ISOLATION LEVEL SERIALIZABLE,;")).toThrow(
      /Expected "isolation", .* but found ";"/,
    );
  });

  it("parses SET CONSTRAINTS", () => {
    expect(firstStmt("SET CONSTRAINTS ALL DEFERRED;")).toEqual({
      kind: "setConstraints",
      constraints: "all",
      mode: "deferred",
    });
    expect(firstStmt("SET CONSTRAINTS s.fk_a, fk_b IMMEDIATE;")).toEqual({
      kind: "setConstraints",
      constraints: [["s", "fk_a"], ["fk_b"]],
      mode: "immediate",
    });
    expect(() => sqlLite.parse("SET CONSTRAINTS ALL;")).toThrow(/Expected "deferred" or "immediate" but found ";"/);
    expect(() => sqlLite.parse("SET LOCAL CONSTRAINTS ALL DEFERRED;")).toThrow(/Expected "to" or "=" but found "all"/);
  });

  it("parses SET [SESSION | LOCAL] SESSION AUTHORIZATION and SET ROLE", () => {
    const auth = (scope: string | null, values: unknown) => ({
      kind: "set",
      scope,
      name: "session authorization",
      values,
    });
    expect(firstStmt("SET SESSION AUTHORIZATION 'bob';")).toEqual(auth(null, [str("bob")]));
    expect(firstStmt("SET SESSION SESSION AUTHORIZATION DEFAULT;")).toEqual(auth("session", "default"));
    expect(firstStmt("SET LOCAL SESSION AUTHORIZATION bob;")).toEqual(auth("local", [name("bob")]));
    expect(firstStmt("SET ROLE 'admin';")).toEqual({ kind: "set", scope: null, name: "role", values: [str("admin")] });
    expect(() => sqlLite.parse("SET SESSION AUTHORIZATION 1;")).toThrow(/Expected a name or a string but found "1"/);
    expect(() => sqlLite.parse("SET ROLE DEFAULT;")).toThrow(/Expected a name or a string but found "default"/);
  });

  it("reads TIME ZONE LOCAL as DEFAULT, and parses the other zone values", () => {
    const zone = (src: string) => (firstStmt(`SET TIME ZONE ${src};`) as any).values;
    expect(zone("LOCAL")).toBe("default");
    expect(zone("DEFAULT")).toBe("default");
    expect(zone("-8")).toEqual([{ kind: "unary", op: "-", operand: num(8) }]);
    expect(zone('"America/New_York"')).toEqual([name("America/New_York")]);
    expect(zone("INTERVAL '+00:00'")).toEqual([{ kind: "interval", value: "+00:00" }]);
    expect(zone("INTERVAL '+00:00' HOUR TO MINUTE")).toEqual([
      { kind: "interval", value: "+00:00", fields: "hour to minute" },
    ]);
    expect(() => sqlLite.parse("SET TIME ZONE true;")).toThrow(/Expected a time zone but found "true"/);
    expect(() => sqlLite.parse("SET TIME ZONE left;")).toThrow(/Expected a time zone but found "left"/);
    expect(() => sqlLite.parse("SET TIME ZONE INTERVAL '1' DAY;")).toThrow(
      /A time zone interval must be HOUR or HOUR TO MINUTE, but found DAY \(1:14\)/,
    );
  });

  it("parses SCHEMA, NAMES and XML OPTION, whose values PostgreSQL restricts", () => {
    const set = (src: string) => firstStmt(`SET ${src};`) as any;
    expect(set("SCHEMA 'app'")).toMatchObject({ name: "schema", values: [str("app")] });
    expect(set("NAMES 'UTF8'")).toMatchObject({ name: "names", values: [str("UTF8")] });
    expect(set("NAMES")).toMatchObject({ name: "names", values: "default" });
    expect(set("XML OPTION CONTENT")).toMatchObject({ name: "xml option", values: [name("content")] });
    expect(() => sqlLite.parse("SET SCHEMA app;")).toThrow(/Expected a string but found "app"/);
  });

  it("reads a form word followed by = or TO as a parameter name", () => {
    const words = ["role", "schema", "names", "constraints", "transaction", "session", "local", "time"];
    for (const word of words) {
      expect(firstStmt(`SET ${word} TO 1;`)).toEqual({ kind: "set", scope: null, name: word, values: [num(1)] });
      expect(firstStmt(`SET ${word}.x = 1;`)).toMatchObject({ scope: null, name: `${word}.x` });
    }
    expect(firstStmt("SET session FROM CURRENT;")).toMatchObject({ scope: null, name: "session" });
    expect(firstStmt("SET SESSION session = 1;")).toMatchObject({ scope: "session", name: "session" });
  });
});

// --- Multi-word SHOW / RESET targets ---

describe("SQL-lite SHOW / RESET targets", () => {
  it("parses TIME ZONE, TRANSACTION ISOLATION LEVEL and SESSION AUTHORIZATION", () => {
    expect(firstStmt("SHOW TRANSACTION ISOLATION LEVEL;")).toEqual({
      kind: "show",
      name: "transaction isolation level",
    });
    expect(firstStmt("SHOW TIME ZONE;")).toEqual({ kind: "show", name: "time zone" });
    expect(firstStmt("SHOW SESSION AUTHORIZATION;")).toEqual({ kind: "show", name: "session authorization" });
    expect(firstStmt("RESET SESSION AUTHORIZATION;")).toEqual({ kind: "reset", name: "session authorization" });
    expect(firstStmt("RESET TIME ZONE;")).toEqual({ kind: "reset", name: "time zone" });
    expect(firstStmt("RESET TRANSACTION ISOLATION LEVEL;")).toEqual({
      kind: "reset",
      name: "transaction isolation level",
    });
  });

  it("reads a lone lead word as a parameter name", () => {
    expect(firstStmt("SHOW time;")).toEqual({ kind: "show", name: "time" });
    expect(firstStmt("SHOW transaction;")).toEqual({ kind: "show", name: "transaction" });
    expect(firstStmt("RESET session;")).toEqual({ kind: "reset", name: "session" });
    expect(() => sqlLite.parse("SHOW TRANSACTION ISOLATION;")).toThrow(/Expected "level" but found ";"/);
  });

  it("keeps the form words unreserved as names and aliases", () => {
    const words = [
      ...["session", "authorization", "characteristics", "transaction", "constraints", "snapshot", "zone"],
      ...["xml", "option", "document", "content", "deferred", "immediate", "isolation", "level"],
    ];
    for (const word of words) {
      expect(firstStmt(`SELECT ${word} FROM ${word};`)).toMatchObject({
        columns: [{ expr: name(word), alias: null }],
        from: [tableFrom([word])],
      });
      expect(firstStmt(`SELECT a ${word} FROM t;`).columns[0]).toEqual({ expr: name("a"), alias: word });
      expect(firstStmt(`SET ${word} = 1;`)).toMatchObject({ name: word });
    }
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

// --- LISTEN / NOTIFY / UNLISTEN, LOAD and DISCARD ---

describe("SQL-lite LISTEN, NOTIFY, UNLISTEN, LOAD and DISCARD", () => {
  const bad = (src: string) => () => sqlLite.parse(src);

  it("parses LISTEN, NOTIFY with and without a payload, and UNLISTEN", () => {
    expect(firstStmt("LISTEN channel_a;")).toEqual({ kind: "listen", channel: "channel_a" });
    expect(firstStmt('LISTEN "Chan";')).toEqual({ kind: "listen", channel: "Chan" });
    expect(firstStmt("NOTIFY channel_a;")).toEqual({ kind: "notify", channel: "channel_a" });
    expect(firstStmt("NOTIFY channel_a, 'payload text';")).toEqual({
      kind: "notify",
      channel: "channel_a",
      payload: "payload text",
    });
    expect(firstStmt("UNLISTEN channel_a;")).toEqual({ kind: "unlisten", channel: "channel_a" });
    expect(firstStmt("UNLISTEN *;")).toEqual({ kind: "unlisten", channel: null });
  });

  it("rejects malformed LISTEN, NOTIFY and UNLISTEN statements", () => {
    expect(bad("LISTEN;")).toThrow(/Expected a name but found ";"/);
    expect(bad("LISTEN *;")).toThrow(/Expected a name but found "\*"/);
    expect(bad("LISTEN a.b;")).toThrow(/Expected ";" but found "."/);
    expect(bad("NOTIFY c,;")).toThrow(/Expected a payload string but found ";"/);
    expect(bad("NOTIFY c, 42;")).toThrow(/Expected a payload string but found "42"/);
    expect(bad("NOTIFY c 'x';")).toThrow(/Expected ";" but found "x"/);
    expect(bad("UNLISTEN;")).toThrow(/Expected a name but found ";"/);
  });

  it("parses LOAD and every DISCARD target", () => {
    expect(firstStmt("LOAD 'auto_explain';")).toEqual({ kind: "load", file: "auto_explain" });
    expect(firstStmt("DISCARD ALL;")).toEqual({ kind: "discard", target: "all" });
    expect(firstStmt("DISCARD PLANS;")).toEqual({ kind: "discard", target: "plans" });
    expect(firstStmt("DISCARD SEQUENCES;")).toEqual({ kind: "discard", target: "sequences" });
    expect(firstStmt("DISCARD TEMP;")).toEqual({ kind: "discard", target: "temp" });
    expect(firstStmt("DISCARD TEMPORARY;")).toEqual({ kind: "discard", target: "temp" });
  });

  it("rejects malformed LOAD and DISCARD statements", () => {
    expect(bad("LOAD auto_explain;")).toThrow(/Expected a file name but found "auto_explain"/);
    expect(bad("DISCARD;")).toThrow(/Expected "all", "plans", "sequences", "temp" or "temporary" but found ";"/);
    expect(bad("DISCARD cache;")).toThrow(/but found "cache"/);
  });

  it("keeps listen, notify, unlisten, load and discard unreserved as names and aliases", () => {
    for (const word of ["listen", "notify", "unlisten", "load", "discard", "temporary"]) {
      expect(firstStmt(`SELECT ${word} FROM ${word};`)).toMatchObject({
        columns: [{ expr: name(word), alias: null }],
        from: [tableFrom([word])],
      });
      expect(firstStmt(`SELECT a ${word} FROM t;`).columns[0]).toEqual({ expr: name("a"), alias: word });
      expect(firstStmt(`CREATE TABLE t (${word} int);`).items[0]).toMatchObject({ name: word });
    }
    expect(firstStmt("LISTEN listen;")).toEqual({ kind: "listen", channel: "listen" });
    expect(firstStmt("NOTIFY notify;")).toEqual({ kind: "notify", channel: "notify" });
    expect(firstStmt("UNLISTEN unlisten;")).toEqual({ kind: "unlisten", channel: "unlisten" });
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
    // A literal that never closed is reported as unterminated, not blamed on
    // its first stray character.
    expect(() => sqlLite.parse("SELECT B'101 FROM t;")).toThrow(/Unterminated bit string literal/);
    expect(() => sqlLite.parse("SELECT 'abc FROM t;")).toThrow(/Unterminated quoted string/);
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
    // `u&` with no quote after it is `u` and `&`, as in PG.
    expect(lex("u&x")).toEqual([ident("u"), { type: "op", value: "&" }, ident("x")]);
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

// --- quoted literals ---
// Every quoted form croaks when the input ends inside it, `E'…'` decodes the
// full escape set, constants separated by a newline continue one another, and
// `U&"…"` is a quoted identifier.

describe("SQL-lite quoted literals", () => {
  const colExpr = (src: string) => (firstStmt(`SELECT ${src} FROM t;`) as any).columns[0].expr;
  const strTok = (value: string) => ({ type: "string", value });
  const fails = (src: string) => () => sqlLite.parse(src);

  it("croaks on every quoted form the input ends inside", () => {
    expect(fails("SELECT 'abc")).toThrow(/Unterminated quoted string \(1:7\)/);
    expect(fails("SELECT E'abc")).toThrow(/Unterminated quoted string \(1:7\)/);
    // An escaped quote doesn't close the literal, and a final backslash
    // escapes nothing.
    expect(fails("SELECT E'abc\\'")).toThrow(/Unterminated quoted string/);
    expect(fails("SELECT E'abc\\")).toThrow(/Unterminated quoted string/);
    expect(fails('SELECT "abc')).toThrow(/Unterminated quoted identifier \(1:7\)/);
    expect(fails("SELECT B'101")).toThrow(/Unterminated bit string literal \(1:7\)/);
    expect(fails("SELECT X'ff")).toThrow(/Unterminated hexadecimal string literal \(1:7\)/);
    expect(fails("SELECT U&'abc")).toThrow(/Unterminated quoted string \(1:7\)/);
    expect(fails('SELECT U&"abc')).toThrow(/Unterminated quoted identifier \(1:7\)/);
    expect(fails("SELECT 1; /* note")).toThrow(/Unterminated \/\* comment \(1:10\)/);
    // Nesting counts: one close for two opens is still open.
    expect(fails("SELECT 1; /* a /* b */")).toThrow(/Unterminated \/\* comment/);
  });

  it("still reads the closed forms and the nested comment", () => {
    expect(lex("'' E'' B'' X'' U&''")).toEqual([
      strTok(""),
      strTok(""),
      { type: "bitstring", value: "" },
      { type: "hexstring", value: "" },
      strTok(""),
    ]);
    expect(lex("/* a /* b */ c */ x")).toEqual([
      { type: "comment", value: " a /* b */ c " },
      { type: "ident", value: "x" },
    ]);
  });

  it("rejects the zero-length quoted identifier", () => {
    expect(fails('SELECT "" FROM t;')).toThrow(/Zero-length delimited identifier \(1:7\)/);
    expect(fails('SELECT U&"" FROM t;')).toThrow(/Zero-length delimited identifier/);
    // A doubled quote is a one-character name, not an empty one.
    expect(lex('""""')).toEqual([{ type: "qident", value: '"' }]);
  });

  it("decodes every E'…' escape", () => {
    expect(lex("E'\\b\\f\\n\\r\\t\\v'")).toEqual([strTok("\b\f\n\r\t\v")]);
    // Any other escaped character stands for itself, quotes and backslash too.
    expect(lex("E'\\q\\\\\\''''")).toEqual([strTok("q\\''")]);
    // Hex, octal and both unicode widths.
    expect(colExpr("E'\\x41\\101\\u0041\\U00000041'")).toEqual(str("AAAA"));
    // One or two hex digits, one to three octal digits; `\x` with no hex digit
    // is just `x`.
    expect(lex("E'\\x4g\\1011\\xg'")).toEqual([strTok("\x04gA1xg")]);
    // In a standard string a backslash is an ordinary character.
    expect(lex("'a\\nb'")).toEqual([strTok("a\\nb")]);
  });

  it("assembles octal and hex escapes into UTF-8", () => {
    expect(lex("E'\\303\\251'")).toEqual([strTok("é")]);
    expect(lex("E'\\xe2\\x82\\xac \\xC3\\xA9'")).toEqual([strTok("€ é")]);
    expect(lex("E'\\xF0\\x9F\\x98\\x80'")).toEqual([strTok("😀")]);
    // U+FEFF is an ordinary character here, never a byte-order mark to drop.
    expect(lex("E'\\xEF\\xBB\\xBF' E'a\\357\\273\\277b'")).toEqual([strTok("\uFEFF"), strTok("a\uFEFFb")]);
    // A byte run that isn't UTF-8 is rejected, as PG's encoding check does:
    // a lone lead byte, a lone continuation byte, a run cut short by a
    // character, and `\777` (whose low byte is 0xFF).
    expect(fails("SELECT E'\\xC3';")).toThrow(/Invalid byte sequence for encoding "UTF8"/);
    expect(fails("SELECT E'\\251';")).toThrow(/Invalid byte sequence for encoding "UTF8"/);
    expect(fails("SELECT E'\\xC3A';")).toThrow(/Invalid byte sequence for encoding "UTF8"/);
    expect(fails("SELECT E'\\777';")).toThrow(/Invalid byte sequence for encoding "UTF8"/);
  });

  it("rejects NUL however it is spelled", () => {
    expect(fails("SELECT E'a\\0b';")).toThrow(/Invalid byte sequence for encoding "UTF8": 0x00/);
    expect(fails("SELECT E'\\x00';")).toThrow(/Invalid byte sequence for encoding "UTF8": 0x00/);
    expect(fails("SELECT E'\\u0000';")).toThrow(/Invalid Unicode escape value/);
  });

  it("pairs UTF-16 surrogates in \\u escapes and rejects the unpaired ones", () => {
    expect(colExpr("E'\\uD83D\\uDE00'")).toEqual(str("😀"));
    expect(colExpr("E'\\U0001F600'")).toEqual(str("😀"));
    expect(fails("SELECT E'\\uD83D';")).toThrow(/Invalid Unicode surrogate pair/);
    expect(fails("SELECT E'\\uDE00';")).toThrow(/Invalid Unicode surrogate pair/);
    expect(fails("SELECT E'\\uD83Dx';")).toThrow(/Invalid Unicode surrogate pair/);
    expect(fails("SELECT E'\\uD83D\\x41';")).toThrow(/Invalid Unicode surrogate pair/);
    // A pair never spans two continued constants.
    expect(fails("SELECT E'\\uD83D'\n'\\uDE00';")).toThrow(/Invalid Unicode surrogate pair/);
    // A short escape is an error, not a pass-through, and so is one past the
    // last code point.
    expect(fails("SELECT E'\\u12';")).toThrow(/Invalid Unicode escape: use \\uXXXX or \\UXXXXXXXX/);
    expect(fails("SELECT E'\\U0041';")).toThrow(/Invalid Unicode escape: use/);
    expect(fails("SELECT E'\\U00110000';")).toThrow(/Invalid Unicode escape value/);
  });

  it("joins string constants separated by a newline", () => {
    expect(colExpr("'foo'\n'bar'")).toEqual(str("foobar"));
    expect(colExpr("'foo'  \r\n\t 'bar'\n\n'baz'")).toEqual(str("foobarbaz"));
    // A `--` comment counts as whitespace on either side of the newline.
    expect(colExpr("'foo' -- one\n-- two\n'bar'")).toEqual(str("foobar"));
    // Every quoted string form continues, each under its own escape rules.
    expect(colExpr("E'a\\t'\n'\\x41'")).toEqual(str("a\tA"));
    expect(colExpr("B'10'\n'01'")).toEqual({ kind: "bitString", value: "1001", hex: false });
    expect(colExpr("U&'\\0041'\n'\\0042'")).toEqual(str("AB"));
    // A byte run may span the constants, and so may a U& escape (PG joins
    // those before decoding); form feed and vertical tab count as whitespace.
    expect(colExpr("E'\\303'\n'\\251'")).toEqual(str("é"));
    expect(colExpr("U&'\\00'\n'41'")).toEqual(str("A"));
    expect(colExpr("'a' \f\n\v'b'")).toEqual(str("ab"));
    // The span runs from the first body to the end of the last.
    const token = sqlLexer.tokenize(createInputStream("'ab'\n'cd'")).next()!;
    expect(token.position).toEqual({ start: { row: 1, col: 1 }, end: { row: 2, col: 3 } });
  });

  it("keeps constants apart without a newline, or across a block comment or operator", () => {
    expect(lex("'foo' 'bar'")).toEqual([strTok("foo"), strTok("bar")]);
    expect(fails("SELECT 'foo' 'bar';")).toThrow(/found "bar"/);
    expect(lex("'a'\n/* c */'b'")).toEqual([strTok("a"), { type: "comment", value: " c " }, strTok("b")]);
    expect(lex("'a'\n-'b'")).toEqual([strTok("a"), { type: "op", value: "-" }, strTok("b")]);
    // Identifiers never continue.
    expect(lex('"a"\n"b"')).toEqual([
      { type: "qident", value: "a" },
      { type: "qident", value: "b" },
    ]);
  });

  it('reads U&"…" as a quoted identifier', () => {
    expect(lex('U&"d\\0061t\\+000061" u&"x"')).toEqual([
      { type: "qident", value: "data" },
      { type: "qident", value: "x" },
    ]);
    expect(colExpr('U&"d\\0061t"')).toEqual(name("dat"));
    expect((firstStmt('CREATE TABLE U&"T\\0061b" (U&"\\0063ol" int);') as any).name).toEqual(["Tab"]);
    expect(colExpr("U&\"d!0061t\" UESCAPE '!'")).toEqual(name("dat"));
    expect(fails('SELECT U&"\\00" FROM t;')).toThrow(/Invalid Unicode escape value/);
    expect(fails("SELECT U&\"x\" UESCAPE '+' FROM t;")).toThrow(/Invalid Unicode escape character/);
    // One character, but not one byte.
    expect(fails("SELECT U&'x' UESCAPE 'é' FROM t;")).toThrow(/Invalid Unicode escape character/);
  });

  it("reads a UESCAPE clause across comments", () => {
    expect(colExpr("U&'d!0061t' /* why */ UESCAPE '!'")).toEqual(str("dat"));
    expect(colExpr("U&'d!0061t' -- why\n UESCAPE -- and\n '!'")).toEqual(str("dat"));
    expect(colExpr("U&\"d!0061t\" /* a /* b */ */ UESCAPE /**/ '!'")).toEqual(name("dat"));
    // A comment that never closes declines the tail, and then croaks itself.
    expect(fails("SELECT U&'x' /* open")).toThrow(/Unterminated \/\* comment/);
    // A lone `-` or `/` is an operator, so the clause isn't there.
    expect(lex("U&'x' / uescape")).toEqual([
      strTok("x"),
      { type: "op", value: "/" },
      { type: "ident", value: "uescape" },
    ]);
  });

  it("treats form feed and vertical tab as whitespace", () => {
    expect(lex("a\fb\vc")).toEqual([
      { type: "ident", value: "a" },
      { type: "ident", value: "b" },
      { type: "ident", value: "c" },
    ]);
    expect(firstStmt("SELECT\f1\v;")).toMatchObject({ kind: "select", columns: [col(num(1))] });
  });

  it("keeps e usable as a name and alias — the prefix only claims a quote right after it", () => {
    expect(lex("e E e.x")).toEqual([
      { type: "ident", value: "e" },
      { type: "ident", value: "e" },
      { type: "ident", value: "e" },
      { type: "punc", value: "." },
      { type: "ident", value: "x" },
    ]);
    expect((firstStmt("SELECT e FROM e;") as any).columns).toEqual([col(name("e"))]);
    expect((firstStmt("SELECT 1 e FROM t e;") as any).columns).toEqual([col(num(1), "e")]);
  });

  it("diagnose() resumes after a literal error, keeping later statements", () => {
    for (const bad of ["SELECT E'\\xC3';", 'SELECT "" FROM t;', "SELECT U&'x' UESCAPE '!!';", "SELECT B'12';"]) {
      const { ast, errors } = sqlLite.diagnose(`${bad}\nSELECT 1;`);
      expect(errors).toHaveLength(1);
      expect(stripSpans(ast).at(-1)).toMatchObject({ kind: "select", columns: [col(num(1))] });
    }
  });

  it("surfaces the lexer's own error from inside a backtracking position", () => {
    // The INSERT target's column list and alias are parsed speculatively; a
    // literal error inside them must not turn into a parser error about
    // whatever comes next.
    expect(fails('INSERT INTO t (a, "") VALUES (1);')).toThrow(/Zero-length delimited identifier/);
    expect(fails('INSERT INTO t (a, "b) VALUES (1);')).toThrow(/Unterminated quoted identifier/);
    expect(fails('INSERT INTO t AS "" VALUES (1);')).toThrow(/Zero-length delimited identifier/);
    expect(fails('INSERT INTO t AS U&"\\00" VALUES (1);')).toThrow(/Invalid Unicode escape value/);
  });
});

// --- numeric literals and parameters ---
// PG 17's scan.l: trailing-dot numbers, `0o`/`0b` radix forms, `_` only
// between digits, junk glued to a number or a positional parameter rejected
// (PG 15+), and the `:=` token. A number whose value a JS number can't hold
// keeps its text in `raw`.

describe("SQL-lite numeric literals and parameters", () => {
  const colExpr = (src: string) => (firstStmt(`SELECT ${src} FROM t;`) as any).columns[0].expr;
  const options = (list: string) => (firstStmt(`CREATE TABLE t (id int) WITH (${list});`) as any).options;

  it("reads trailing-dot numbers as one token", () => {
    expect(lex("5. 1.e3 1.E-3 .5e1")).toEqual([
      { type: "number", value: "5." },
      { type: "number", value: "1.e3" },
      { type: "number", value: "1.E-3" },
      { type: "number", value: ".5e1" },
    ]);
    expect(firstStmt("SELECT 5., 1.e3;").columns).toEqual([col(num(5)), col(num(1000))]);
    // `1..` is PG's `{numericfail}`: the integer, with both dots left behind.
    expect(lex("1..")).toEqual([
      { type: "number", value: "1" },
      { type: "punc", value: "." },
      { type: "punc", value: "." },
    ]);
    // A dot after a number still separates two numbers, and starts none on its own.
    expect(lex("1.5.6 t.5")).toEqual([
      { type: "number", value: "1.5" },
      { type: "number", value: ".6" },
      { type: "ident", value: "t" },
      { type: "number", value: ".5" },
    ]);
  });

  it("reads hex, octal and binary integers, with `_` between digits", () => {
    expect(firstStmt("SELECT 0o17, 0O17, 0b101, 0B1, 0x_ff, 0X1F, 1_000.000_1, 1_0e1_0;").columns).toEqual(
      [15, 15, 5, 1, 255, 31, 1000.0001, 1e11].map((value) => col(num(value))),
    );
    // A radix integer runs into a following `.5`, as in PG: two numbers.
    expect(lex("0x1.5")).toEqual([
      { type: "number", value: "0x1" },
      { type: "number", value: ".5" },
    ]);
    // Octal and binary are integer constants wherever PG wants one.
    expect(colExpr("current_timestamp(0o3)")).toEqual({
      kind: "sqlValueFunction",
      name: "current_timestamp",
      precision: 3,
    });
    expect(colExpr("current_time(0b11)")).toEqual({ kind: "sqlValueFunction", name: "current_time", precision: 3 });
  });

  it("rejects junk after a number, as PostgreSQL 15+ does", () => {
    const cases: [string, RegExp][] = [
      ["123abc", /Trailing junk after numeric literal \(1:7\)/],
      ["1.5x", /Trailing junk after numeric literal/],
      ["5.e", /Trailing junk after numeric literal/],
      ["1e", /Trailing junk after numeric literal/],
      ["1e+", /Trailing junk after numeric literal/],
      ["1e5x", /Trailing junk after numeric literal/],
      ["1e5_", /Trailing junk after numeric literal/],
      // PG counts every non-ASCII character as an identifier character.
      ["1é", /Trailing junk after numeric literal/],
      ["1_", /Trailing junk after numeric literal/],
      ["1__2", /Trailing junk after numeric literal/],
      ["1._5", /Trailing junk after numeric literal/],
      ["00x1", /Trailing junk after numeric literal/],
      ["0xg", /Trailing junk after numeric literal/],
      ["0x1g", /Trailing junk after numeric literal/],
      ["0b102", /Trailing junk after numeric literal/],
      ["0o8", /Trailing junk after numeric literal/],
      ["0x_g", /Trailing junk after numeric literal/],
      ["0x__ff", /Trailing junk after numeric literal/],
      ["0x1_", /Trailing junk after numeric literal/],
      ["0x1$", /Trailing junk after numeric literal/],
      ["0x", /Invalid hexadecimal integer/],
      ["0x_", /Invalid hexadecimal integer/],
      ["0o", /Invalid octal integer/],
      ["0b", /Invalid binary integer/],
    ];
    for (const [src, error] of cases) expect(() => sqlLite.parse(`SELECT ${src};`), src).toThrow(error);
    // The error spans the whole word.
    const error = (() => {
      try {
        sqlLite.parse("SELECT 123abc FROM t;");
      } catch (caught) {
        return caught as ParseError;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(ParseError);
    expect([error!.start, error!.end]).toEqual([
      { row: 1, col: 7 },
      { row: 1, col: 13 },
    ]);
  });

  it("rejects junk after a positional parameter, keeping `$name`", () => {
    expect(lex("$1 $12 $foo")).toEqual([
      { type: "param", value: "1" },
      { type: "param", value: "12" },
      { type: "param", value: "foo" },
    ]);
    expect(() => sqlLite.parse("SELECT $1abc;")).toThrow(/Trailing junk after parameter \(1:7\)/);
    // A positional parameter takes no `_` separators.
    expect(() => sqlLite.parse("SELECT $1_000;")).toThrow(/Trailing junk after parameter/);
    expect(() => sqlLite.parse("SELECT $1é;")).toThrow(/Trailing junk after parameter/);
  });

  it("reports junk inside a backtracking position as the lexer error", () => {
    // INSERT's column list is read under attempt(), which rolls a failed read
    // back; the lexer's own error must surface rather than a parser one.
    const cases: [string, RegExp][] = [
      ["123abc", /Trailing junk after numeric literal \(1:18\)/],
      ["0x", /Invalid hexadecimal integer \(1:18\)/],
      ["$1abc", /Trailing junk after parameter \(1:18\)/],
      ["1e+", /Trailing junk after numeric literal \(1:18\)/],
    ];
    for (const [src, error] of cases) {
      expect(() => sqlLite.parse(`INSERT INTO t (a, ${src}) VALUES (1);`), src).toThrow(error);
    }
  });

  it("lexes `:=` as one token, and only when written together", () => {
    expect(lex("a:=1")).toEqual([
      { type: "ident", value: "a" },
      { type: "punc", value: ":=" },
      { type: "number", value: "1" },
    ]);
    expect(lex("a : = 1")).toEqual([
      { type: "ident", value: "a" },
      { type: "punc", value: ":" },
      { type: "op", value: "=" },
      { type: "number", value: "1" },
    ]);
    // `:=` names an argument, and the spaced spelling is no named argument.
    expect(colExpr("f(a := 1)")).toEqual({
      kind: "call",
      name: "f",
      args: [{ kind: "namedArg", name: "a", value: num(1) }],
    });
    expect(() => sqlLite.parse("SELECT f(a : = 1);")).toThrow(/found ":"/);
    // `:` and `::` lex as before.
    expect(colExpr("a[1:2]")).toMatchObject({ kind: "subscript" });
    expect(colExpr("a::int")).toMatchObject({ kind: "cast" });
  });

  it("keeps the text of a number its value can't hold in `raw`", () => {
    expect(colExpr("9007199254740993")).toEqual({ kind: "number", value: 9007199254740992, raw: "9007199254740993" });
    expect(colExpr("9_007_199_254_740_993")).toEqual({
      kind: "number",
      value: 9007199254740992,
      raw: "9007199254740993",
    });
    expect(colExpr("0xFFFFFFFFFFFFFFFF")).toEqual({
      kind: "number",
      value: 18446744073709552000,
      raw: "0xFFFFFFFFFFFFFFFF",
    });
    // The test is on the value: every double from 2^53 up is a whole number.
    expect(colExpr("1.5e300")).toEqual({ kind: "number", value: 1.5e300, raw: "1.5e300" });
    expect(colExpr("1e400")).toEqual({ kind: "number", value: Number.POSITIVE_INFINITY, raw: "1e400" });
    // JSON writes Infinity as null; `raw` survives it.
    expect(JSON.parse(JSON.stringify(colExpr("1e400")))).toEqual({ kind: "number", value: null, raw: "1e400" });
    // A sign in an expression is a unary operator, so `raw` is the literal's own.
    expect(colExpr("-12345678901234567890")).toEqual({
      kind: "unary",
      op: "-",
      operand: { kind: "number", value: 12345678901234567000, raw: "12345678901234567890" },
    });
  });

  it("leaves `raw` off every number its value holds exactly", () => {
    for (const src of ["0", "42", "9007199254740991", "3.14", ".5", "5.", "1e10", "0.1", "0x1F", "1_000"]) {
      expect(colExpr(src), src).not.toHaveProperty("raw");
    }
  });

  it("folds an option value's sign into `raw` and the value alike", () => {
    expect(options("a = -99999999999999999999, b = +99999999999999999999, c = -1e400, d = -0x10, e = -5")).toEqual([
      { name: "a", value: { kind: "number", value: -100000000000000000000, raw: "-99999999999999999999" } },
      { name: "b", value: { kind: "number", value: 100000000000000000000, raw: "+99999999999999999999" } },
      { name: "c", value: { kind: "number", value: Number.NEGATIVE_INFINITY, raw: "-1e400" } },
      // The sign applies after decoding: `Number("-0x10")` alone is NaN.
      { name: "d", value: num(-16) },
      { name: "e", value: num(-5) },
    ]);
  });
});

// --- non-ASCII identifiers and national strings ---
// PG's scanner takes every character from U+0080 up as an identifier character
// and folds only ASCII letters; `N'…'` is a `bpchar`-typed string constant.

describe("SQL-lite non-ASCII identifiers and national strings", () => {
  const colExpr = (src: string) => (firstStmt(`SELECT ${src} FROM t;`) as any).columns[0].expr;
  const bpchar = (value: string) => ({
    kind: "typedLiteral",
    type: { name: "bpchar", args: [], array: false },
    value,
  });

  it("reads non-ASCII identifiers as columns, tables, aliases and functions", () => {
    expect(firstStmt("SELECT café, ñ.größe AS über, naïve(ß) résumé FROM schéma.tàble ŧ;")).toEqual(
      sel({
        columns: [
          col(name("café")),
          col(name("ñ", "größe"), "über"),
          col({ kind: "call", name: "naïve", args: [name("ß")] }, "résumé"),
        ],
        from: [tableFrom(["schéma", "tàble"], "ŧ")],
      }),
    );
    expect(firstStmt("CREATE TABLE données (clé int, 名前 text);")).toMatchObject({
      name: ["données"],
      items: [{ name: "clé" }, { name: "名前" }],
    });
  });

  it("continues an identifier with digits, $ and characters outside the BMP", () => {
    expect(lex("é1$ a€ 🐘x _é")).toEqual([
      { type: "ident", value: "é1$" },
      { type: "ident", value: "a€" },
      { type: "ident", value: "🐘x" },
      { type: "ident", value: "_é" },
    ]);
    // Non-ASCII whitespace is an identifier character to PG too, so a
    // no-break space joins the words around it.
    expect(lex("a b")).toEqual([{ type: "ident", value: "a b" }]);
    // A keyword with a non-ASCII letter glued on is one word, not the keyword.
    expect(lex("fromé")).toEqual([{ type: "ident", value: "fromé" }]);
  });

  it("folds only the ASCII letters of an unquoted identifier", () => {
    expect(lex("CAFÉ Straße ΣΑΣ İD Kelvin")).toEqual([
      { type: "ident", value: "cafÉ" },
      { type: "ident", value: "straße" },
      { type: "ident", value: "ΣΑΣ" },
      { type: "ident", value: "İd" },
      // The Kelvin sign lowercases to an ASCII `k` under Unicode rules.
      { type: "ident", value: "Kelvin" },
    ]);
    // So `CAFÉ` names `"cafÉ"`, not `"café"`.
    expect(colExpr("CAFÉ")).toEqual(colExpr('"cafÉ"'));
    expect(colExpr("CAFÉ")).not.toEqual(colExpr('"café"'));
    // Keywords are ASCII, so they still match in any case next to non-ASCII names.
    expect(firstStmt("SeLeCt Ä FrOm Ö WhErE Ü;")).toEqual(
      sel({ columns: [col(name("Ä"))], from: [tableFrom(["Ö"])], where: name("Ü") }),
    );
  });

  it("reads non-ASCII dollar-quote tags, as PG does", () => {
    expect(lex("$é$a;b$é$ $tag_ü1$x$tag_ü1$")).toEqual([
      { type: "string", value: "a;b" },
      { type: "string", value: "x" },
    ]);
    // Only the exact closer ends it; `$É$` is a different tag.
    expect(lex("$é$a$É$b$é$")).toEqual([{ type: "string", value: "a$É$b" }]);
    // A tag outside the BMP closes too.
    expect(lex("$🐘$x$🐘$ $a🐘$y$a🐘$")).toEqual([
      { type: "string", value: "x" },
      { type: "string", value: "y" },
    ]);
    expect(() => sqlLite.parse("SELECT $é$abc;")).toThrow(/Unterminated dollar-quoted string/);
    // A `$` with no tag-closing `$` is not a dollar quote.
    expect(lex("$1")).toEqual([{ type: "param", value: "1" }]);
    // A named parameter takes the same characters, so none is split off as an alias.
    expect(lex("$café")).toEqual([{ type: "param", value: "café" }]);
  });

  it("keeps quoted non-ASCII identifiers exactly as written", () => {
    expect(lex('"Café" "ÉTÉ" U&"caf\\00E9"')).toEqual([
      { type: "qident", value: "Café" },
      { type: "qident", value: "ÉTÉ" },
      { type: "qident", value: "café" },
    ]);
  });

  it("reads N'…' as a bpchar-typed literal", () => {
    expect(colExpr("N'abc'")).toEqual(bpchar("abc"));
    expect(colExpr("n'it''s'")).toEqual(bpchar("it's"));
    expect(colExpr("N''")).toEqual(bpchar(""));
    // The body is a standard string: backslash is ordinary, and a newline
    // continues it.
    expect(colExpr("N'a\\b'")).toEqual(bpchar("a\\b"));
    expect(colExpr("N'foo'\n'bar'")).toEqual(bpchar("foobar"));
    expect(colExpr("N'a'::text")).toEqual({
      kind: "cast",
      expr: bpchar("a"),
      type: { name: "text", args: [], array: false },
    });
    expect(firstStmt("CREATE TABLE t (c char(3) DEFAULT N'x');")).toMatchObject({
      items: [{ constraints: [{ kind: "default", expr: bpchar("x") }] }],
    });
  });

  it("spans N'…' from the N, with the N as its type", () => {
    const [stmt] = sqlLite.parse("SELECT N'abc';") as any[];
    const literal = stmt.columns[0].expr;
    expect(literal.span).toEqual({ start: { row: 1, col: 7 }, end: { row: 1, col: 12 } });
    expect(literal.type.span).toEqual({ start: { row: 1, col: 7 }, end: { row: 1, col: 8 } });
    // A continued literal ends where its last constant's body does.
    const [continued] = sqlLite.parse("SELECT N'foo'\n  'bar';") as any[];
    expect(continued.columns[0].expr.span).toEqual({ start: { row: 1, col: 7 }, end: { row: 2, col: 6 } });
  });

  it("keeps n and the words it starts usable as names", () => {
    expect(firstStmt("SELECT n, name, nulls n FROM n;")).toEqual(
      sel({ columns: [col(name("n")), col(name("name")), col(name("nulls"), "n")], from: [tableFrom(["n"])] }),
    );
    // A space between the N and the quote leaves a name followed by a string:
    // a typed literal of a type named `n`, as PG reads it too.
    expect((firstStmt("SELECT N 'abc';") as any).columns[0].expr).toEqual({
      kind: "typedLiteral",
      type: ct("n"),
      value: "abc",
    });
  });

  it("accepts N'…' only where an expression goes, as PG does", () => {
    expect(() => sqlLite.parse("COMMENT ON TABLE t IS N'x';")).toThrow(/Expected a string or "null" but found "x"/);
    expect(() => sqlLite.parse("SELECT * FROM f() AS N'x';")).toThrow(/Expected an alias but found "x"/);
    // Nor does it follow a type word as a typed literal's string.
    expect(() => sqlLite.parse("SELECT date N'2024-01-01';")).toThrow(/Expected ";" but found "2024-01-01"/);
  });

  it("croaks on an unterminated N'…', also inside a backtracking position", () => {
    expect(() => sqlLite.parse("SELECT N'abc")).toThrow(/Unterminated quoted string \(1:7\)/);
    expect(() => sqlLite.parse("INSERT INTO t (a, N'x) VALUES (1);")).toThrow(/Unterminated quoted string \(1:18\)/);
    expect(() => sqlLite.parse("SELECT * FROM f() x (a N'abc);")).toThrow(/Unterminated quoted string \(1:23\)/);
  });

  it("still rejects characters that start no token", () => {
    expect(() => sqlLite.parse("SELECT \\ FROM t;")).toThrow(/Unexpected character "\\" \(1:7\)/);
    expect(() => sqlLite.parse("SELECT { FROM t;")).toThrow(/Unexpected character "\{" \(1:7\)/);
    expect(() => sqlLite.parse("SELECT café\\ FROM t;")).toThrow(/Unexpected character "\\" \(1:11\)/);
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
      expectsKeys(
        [
          "table",
          "unique",
          "type",
          "sequence",
          "domain",
          "database",
          "schema",
          "extension",
          "tablespace",
          "role",
          "user",
        ],
        '"frobnicate"',
      ),
    );
    expect(() => sqlLite.parse("CREATE frobnicate;")).toThrow(
      /Expected ("[a-z ]+" or )+"[a-z ]+" but found "frobnicate"/,
    );
  });

  it("names the table-item alternatives in the join form", () => {
    expect(() => sqlLite.parse("CREATE TABLE t (42 bad);")).toThrow(
      expectsKeys(["constraint", "primary key", "unique", "check", "foreign key", "like", "exclude"], '"42"'),
    );
    expect(() => sqlLite.parse("CREATE TABLE t (42 bad);")).toThrow(/Expected ("[a-z ]+" or )+a name but found "42"/);
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
    expect(() => sqlLite.parse("CREATE TABLE t (c interval day \\);")).toThrow(/Unexpected character "\\"/);
    expect(sqlLite.diagnose("CREATE TABLE t (c interval day \\);").errors.map((e) => e.message)).toEqual([
      'Unexpected character "\\" (1:31)',
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
    // A quoted lead is a type name like any other, and leads a literal as PG's
    // general `type 'string'` form has it.
    expect(colExpr(`"date" 'x'`)).toEqual(typed(ct("date"), "x"));
    // A lead whose tail is not followed by a string is a name — no word is taken.
    expect(() => sqlLite.parse("SELECT timestamp with time zone FROM t;")).toThrow(/Expected ";" but found "with"/);
    // A lex error in the lookahead past the lead word must not cost the syntax
    // error the statement already had.
    expect(sqlLite.diagnose("SELECT time with time zone \\;").errors.map((e) => e.message)).toEqual([
      'Unexpected character "\\" (1:27)',
      'Expected ";" but found "with" (1:12)',
    ]);
    // The token after a bare lead is read exactly as a name reads it, so a lex
    // error there costs the statement as it always did, for every lead.
    expect(sqlLite.diagnose("SELECT date \\ FROM;").errors.map((e) => e.message)).toEqual([
      'Unexpected character "\\" (1:12)',
    ]);
    expect(sqlLite.diagnose("SELECT a FROM t WHERE date \\;\nSELECT 1;").ast).toHaveLength(1);
    // PG writes the precision before the tail, never after it.
    expect(() => sqlLite.parse("SELECT timestamp with time zone(3) 'x';")).toThrow(/Expected ";" but found "with"/);
    // Nor does it take anything but an integer one.
    expect(() => sqlLite.parse("SELECT timestamp(1.5) 'x';")).toThrow(/Expected ";" but found "x"/);
    // `date` is no keyword to PG, so `date(3) 'x'` is its generic
    // `name(typmod) 'string'` form, as `varchar(3) 'abc'` is.
    expect(colExpr("date(3) 'x'")).toEqual(typed(ct("date", { args: [3] }), "x"));
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

// --- typed literals for any type, ARRAY type spelling and interval precision ---

describe("SQL-lite typed literals, ARRAY type spelling and interval precision", () => {
  const colExpr = (src: string) => (firstStmt(`SELECT ${src} FROM t;`) as any).columns[0].expr;
  const colType = (type: string) => (firstStmt(`CREATE TABLE t (c ${type});`) as any).items[0].dataType;
  const castType = (src: string) => (firstStmt(`SELECT ${src} FROM t;`) as any).columns[0].expr.type;
  const typed = (type: unknown, value: string) => ({ kind: "typedLiteral", type, value });
  const interval = (value: string, over: Record<string, unknown> = {}) => ({ kind: "interval", value, ...over });

  it("reads a string after any type name as a typed literal", () => {
    expect(colExpr("jsonb '{}'")).toEqual(typed(ct("jsonb"), "{}"));
    expect(colExpr("timestamptz '2024-01-01'")).toEqual(typed(ct("timestamptz"), "2024-01-01"));
    expect(colExpr("int4 '42'")).toEqual(typed(ct("int4"), "42"));
    // Qualified and quoted names, as PG's `func_name 'string'` takes them.
    expect(colExpr("s.t 'x'")).toEqual(typed(ct("s.t"), "x"));
    expect(colExpr("pg_catalog.int4 '1'")).toEqual(typed(ct("pg_catalog.int4"), "1"));
    expect(colExpr(`"MyType" 'x'`)).toEqual(typed(ct("MyType"), "x"));
    expect(colExpr(`"char" 'a'`)).toEqual(typed(ct("char", { quoted: true }), "a"));
    // A typmod of integer constants, on a generic or a multi-word name.
    expect(colExpr("varchar(3) 'abc'")).toEqual(typed(ct("varchar", { args: [3] }), "abc"));
    expect(colExpr("numeric(10, 2) '1.5'")).toEqual(typed(ct("numeric", { args: [10, 2] }), "1.5"));
    expect(colExpr("character varying(3) 'abc'")).toEqual(typed(ct("character varying", { args: [3] }), "abc"));
    expect(colExpr("double precision '1'")).toEqual(typed(ct("double precision"), "1"));
    // It is an atom, so operators bind around it.
    expect(colExpr("jsonb '{}' || x")).toEqual(bin("||", typed(ct("jsonb"), "{}"), name("x")));
    expect((firstStmt("SELECT a FROM t WHERE ts > timestamptz '2024-01-01';") as any).where).toEqual(
      bin(">", name("ts"), typed(ct("timestamptz"), "2024-01-01")),
    );
  });

  it("spans a qualified typed literal from its first name to its string", () => {
    const expr = (sqlLite.parse("SELECT s.t(3) 'x';")[0] as any).columns[0].expr;
    expect(expr.span).toEqual({ start: { row: 1, col: 7 }, end: { row: 1, col: 16 } });
    expect(expr.type.span).toEqual({ start: { row: 1, col: 7 }, end: { row: 1, col: 13 } });
  });

  it("rejects the spellings PG's typed-literal forms do not take", () => {
    // No array type, either spelling, and no SETOF.
    expect(() => sqlLite.parse("SELECT jsonb[] '{}';")).toThrow(/Expected an expression or ":" but found "\]"/);
    expect(() => sqlLite.parse("SELECT int ARRAY '{}';")).toThrow(/Expected ";" but found "array"/);
    expect(() => sqlLite.parse("SELECT setof int '1';")).toThrow(/Expected ";" but found "1"/);
    // Nothing after a `.*`, and no call that is not a typmod.
    expect(() => sqlLite.parse("SELECT t.* 'x';")).toThrow(/Expected ";" but found "x"/);
    expect(() => sqlLite.parse("SELECT foo() 'x';")).toThrow(/Expected ";" but found "x"/);
    expect(() => sqlLite.parse("SELECT foo(DISTINCT 1) 'x';")).toThrow(/Expected ";" but found "x"/);
    // A column-name keyword that is no type on its own is no `func_name`
    // either, though it may be part of a dotted one.
    for (const word of [
      "coalesce",
      "setof",
      "national",
      "precision",
      "trim",
      "between",
      "system_user",
      "current_catalog",
    ]) {
      expect(() => sqlLite.parse(`SELECT ${word} 'x';`)).toThrow(/Expected ";" but found "x"/);
    }
    expect(colExpr("trim.x 'y'")).toEqual(typed(ct("trim.x"), "y"));
    expect(() => sqlLite.parse("SELECT system_user.x 'y';")).toThrow(/Expected ";" but found "y"/);
    expect(colExpr("national character 'x'")).toEqual(typed(ct("national character"), "x"));
  });

  it("narrows the typmod to integer constants", () => {
    // PG's `func_name (args) 'string'` takes any expression list; this
    // grammar's type node holds integers only, so anything else stays a call.
    expect(() => sqlLite.parse("SELECT varchar(x) 'abc';")).toThrow(/Expected ";" but found "abc"/);
    expect(() => sqlLite.parse("SELECT varchar(1.5) 'abc';")).toThrow(/Expected ";" but found "abc"/);
    // An integer constant as PG lexes one: no float spelling of a whole number,
    // nothing past int4, and no expression that merely starts with one.
    expect(() => sqlLite.parse("SELECT varchar(10.) 'abc';")).toThrow(/Expected ";" but found "abc"/);
    expect(() => sqlLite.parse("SELECT varchar(4294967296) 'abc';")).toThrow(/Expected ";" but found "abc"/);
    expect(() => sqlLite.parse("SELECT varchar(1 + 2) 'abc';")).toThrow(/Expected ";" but found "abc"/);
    expect(() => sqlLite.parse("SELECT interval(3.0) '1';")).toThrow(/Expected ";" but found "1"/);
    expect(() => sqlLite.parse("SELECT interval(1e0) '1';")).toThrow(/Expected ";" but found "1"/);
    // A call that is not followed by a string is still a call.
    expect(colExpr("foo(1, 2)")).toEqual({ kind: "call", name: "foo", args: [num(1), num(2)] });
    // The TIME / TIMESTAMP precision is read by the type spelling, which takes
    // an integer only; a dotted name is an ordinary one.
    expect(() => sqlLite.parse("SELECT timestamp(1.5) 'x';")).toThrow(/Expected ";" but found "x"/);
    expect(colExpr("timestamp.x(3) 'y'")).toEqual(typed(ct("timestamp.x", { args: [3] }), "y"));
    expect(colExpr("interval.x 'y'")).toEqual(typed(ct("interval.x"), "y"));
    // A quoted or qualified `interval` is an ordinary type name with a typmod,
    // not the INTERVAL precision form.
    expect(colExpr(`"interval"(3) '1'`)).toEqual(typed(ct("interval", { args: [3] }), "1"));
    expect(colExpr("pg_catalog.interval(3) '1'")).toEqual(typed(ct("pg_catalog.interval", { args: [3] }), "1"));
  });

  it("keeps N'…' the national-character literal, not a type named n", () => {
    // `N'abc'` is its own token and stays PG's bpchar literal; a spaced
    // `n 'x'` is an ordinary typed literal, to PG as well. A type name before
    // an `N'…'` is no typed literal.
    expect(colExpr("N'abc'")).toEqual(typed(ct("bpchar"), "abc"));
    expect(colExpr("n 'abc'")).toEqual(typed(ct("n"), "abc"));
    expect(() => sqlLite.parse("SELECT jsonb N'{}';")).toThrow(/Expected ";" but found/);
  });

  it("decides a one-word typed literal without lookahead past the name or call", () => {
    // A lex error inside a call's arguments is reported from where the call
    // reads it, so recovery and the errors after it are unchanged.
    const errors = (src: string) => sqlLite.diagnose(src).errors.map((e) => e.message);
    expect(errors("CREATE TABLE t (c int DEFAULT foo(1, \\), d int); SELECT 2;")).toEqual([
      'Unexpected character "\\" (1:37)',
      'Expected ";" but found "," (1:39)',
    ]);
    expect(errors("CREATE TABLE t (c int DEFAULT interval(\\), d int); SELECT 2;")).toEqual([
      'Unexpected character "\\" (1:39)',
      'Expected ";" but found "," (1:41)',
    ]);
    // Nor does a multi-word lead's tail lookahead swallow a lex error straight
    // after the lead: the statement is lost to it, as before. (One past a
    // complete tail, `double precision \`, is reported from the lookahead, and
    // the statement is kept without it — as for `c interval day \` in a type.)
    for (const src of ["SELECT double \\ FROM t; SELECT 2;", "SELECT char \\; SELECT 2;"]) {
      expect(sqlLite.diagnose(src).ast).toHaveLength(1);
    }
    // And a reserved word, which no type spelling starts, is croaked before
    // anything past it is read.
    expect(errors("SELECT like \\ FROM t; SELECT 2;")).toEqual([
      'Expected a name but found "like" (1:7)',
      'Unexpected character "\\" (1:12)',
    ]);
  });

  it("parses the INTERVAL precision forms", () => {
    expect(colExpr("interval(3) '1 s'")).toEqual(interval("1 s", { precision: 3 }));
    expect(colExpr("INTERVAL '1' SECOND(3)")).toEqual(interval("1", { fields: "second", precision: 3 }));
    expect(colExpr("INTERVAL '1' DAY TO SECOND(3)")).toEqual(interval("1", { fields: "day to second", precision: 3 }));
    // Without one the key is omitted, not null.
    expect(colExpr("INTERVAL '1' MINUTE TO SECOND")).toEqual(interval("1", { fields: "minute to second" }));
    // PG takes a leading precision or a field spec, not both: after
    // `INTERVAL(3) '…'` a unit word is no field. This grammar reads it as the
    // alias, as it does after `x::interval(3)`; PG rejects both.
    expect((firstStmt("SELECT interval(3) '1' day FROM t;") as any).columns).toEqual([
      col(interval("1", { precision: 3 }), "day"),
    ]);
    // Without a string, `interval(3)` is still an ordinary call.
    expect(colExpr("interval(3)")).toEqual({ kind: "call", name: "interval", args: [num(3)] });
  });

  it("rejects the INTERVAL field specs PG does not list", () => {
    expect(() => sqlLite.parse("SELECT INTERVAL '1' DAY TO YEAR;")).toThrow(
      /Expected an interval field spec like "day to second" but found "day to year" \(1:20\)/,
    );
    expect(() => sqlLite.parse("SELECT INTERVAL '1' MONTH TO DAY;")).toThrow(/but found "month to day"/);
    expect(() => sqlLite.parse("SELECT INTERVAL '1' TO SECOND;")).toThrow(/but found "to second"/);
    // Two fields in a row are no spec either (they used to give `"day hour"`).
    expect(() => sqlLite.parse("SELECT INTERVAL '1' DAY HOUR;")).toThrow(/but found "day hour"/);
    expect(() => sqlLite.parse("SELECT INTERVAL '1' SECOND SECOND;")).toThrow(/but found "second second"/);
    // Only SECOND takes a precision, and only an integer one.
    expect(() => sqlLite.parse("SELECT INTERVAL '1' DAY(3);")).toThrow(/Expected ";" but found "\("/);
    expect(() => sqlLite.parse("SELECT INTERVAL '1' SECOND(x);")).toThrow(
      /Expected an integer precision but found "x"/,
    );
    // The type spelling was already limited to the same thirteen specs.
    expect(() => sqlLite.parse("SELECT x::interval day to year;")).toThrow(/Expected ";" but found "to"/);
  });

  it("parses the SQL-standard ARRAY type spelling", () => {
    expect(colType("int ARRAY")).toEqual(ct("int", { array: true }));
    expect(colType("integer ARRAY[3]")).toEqual(ct("integer", { array: true }));
    expect(colType("varchar(10) ARRAY")).toEqual(ct("varchar", { args: [10], array: true }));
    expect(castType("'{}'::int ARRAY")).toEqual(ct("int", { array: true }));
    expect(castType("CAST(x AS text ARRAY)")).toEqual(ct("text", { array: true }));
    // Column constraints follow it as they follow any type.
    expect((firstStmt("CREATE TABLE t (a int ARRAY NOT NULL, b text ARRAY[2] DEFAULT '{}');") as any).items).toEqual([
      { kind: "column", name: "a", dataType: ct("int", { array: true }), constraints: [{ kind: "notNull" }] },
      {
        kind: "column",
        name: "b",
        dataType: ct("text", { array: true }),
        constraints: [{ kind: "default", expr: str("{}") }],
      },
    ]);
  });

  it("rejects the ARRAY spellings PG does not take", () => {
    // ARRAY's bound is required when brackets follow, and there is one at most.
    expect(() => sqlLite.parse("CREATE TABLE t (a int ARRAY[]);")).toThrow(
      /Expected an integer array bound but found "\]"/,
    );
    expect(() => sqlLite.parse("CREATE TABLE t (a int ARRAY[3][4]);")).toThrow(
      /Expected one array bound after ARRAY but found "\["/,
    );
    expect(() => sqlLite.parse("SELECT x::int ARRAY[3][4];")).toThrow(/Expected one array bound after ARRAY/);
    // The two spellings do not combine.
    expect(() => sqlLite.parse("CREATE TABLE t (a int[] ARRAY);")).toThrow(/Expected "," but found "array"/);
    // An ARRAY constructor is no bound.
    expect(() => sqlLite.parse("SELECT x::int ARRAY[1, 2];")).toThrow(/Expected "\]" but found ","/);
  });

  it("records SETOF on the type instead of reading the type as an alias", () => {
    // `x::setof int` used to cast to a type named `setof`, aliased `int`.
    expect(firstStmt("SELECT x::setof int FROM t;")).toEqual(
      sel({
        columns: [col({ kind: "cast", expr: name("x"), type: ct("int", { setof: true }) })],
        from: [tableFrom(["t"])],
      }),
    );
    expect(castType("x::setof int[]")).toEqual(ct("int", { array: true, setof: true }));
    // PG's Typename takes SETOF wherever a type is written; whether it means
    // anything there is decided after parsing.
    expect(colType("setof int")).toEqual(ct("int", { setof: true }));
    // Without a type name after it, `setof` is read as the type name, as it
    // was before SETOF was recognised — PG rejects that.
    expect(castType("x::setof")).toEqual(ct("setof"));
    expect((firstStmt("SELECT x::setof FROM t;") as any).columns).toEqual([
      col({ kind: "cast", expr: name("x"), type: ct("setof") }),
    ]);
    // RETURNS SETOF keeps its own flag, and PG's Typename takes one SETOF only.
    expect(() => sqlLite.parse("CREATE FUNCTION f() RETURNS SETOF SETOF int LANGUAGE sql AS $$SELECT 1$$;")).toThrow(
      /Expected a type name but found "setof"/,
    );
    // A routine argument too: SETOF is no argument name to PG.
    expect((firstStmt("CREATE FUNCTION f(setof int) RETURNS int LANGUAGE sql AS $$SELECT 1$$;") as any).args).toEqual([
      { mode: null, name: null, type: ct("int", { setof: true }), defaultValue: null },
    ]);
  });

  it("keeps a quoted keyword type name apart from the keyword", () => {
    // `"char"` is PG's one-byte internal type; a bare `char` is bpchar.
    expect(castType(`1::"char"`)).toEqual(ct("char", { quoted: true }));
    expect(castType("1::char")).toEqual(ct("char"));
    expect(castType(`1::"int"`)).toEqual(ct("int", { quoted: true }));
    // Quoting that changes nothing carries no flag: an ordinary name, or a
    // qualified one, which PG never reads as a keyword spelling.
    expect(castType(`1::"MyType"`)).toEqual(ct("MyType"));
    expect(castType(`1::"double"`)).toEqual(ct("double"));
    expect(castType(`1::"numeric"`)).toEqual(ct("numeric"));
    expect(castType(`1::"timestamp"`)).toEqual(ct("timestamp"));
    expect(castType(`1::pg_catalog."char"`)).toEqual(ct("pg_catalog.char"));
  });

  it("keeps type names and setof unreserved as names, calls and aliases", () => {
    expect((firstStmt("SELECT jsonb, int4, timestamptz, setof, s.t FROM s;") as any).columns).toEqual([
      col(name("jsonb")),
      col(name("int4")),
      col(name("timestamptz")),
      col(name("setof")),
      col(name("s", "t")),
    ]);
    expect((firstStmt("SELECT int4(x), jsonb(y), a jsonb, b AS setof FROM t;") as any).columns).toEqual([
      col({ kind: "call", name: "int4", args: [name("x")] }),
      col({ kind: "call", name: "jsonb", args: [name("y")] }),
      col(name("a"), "jsonb"),
      col(name("b"), "setof"),
    ]);
    expect((firstStmt("CREATE TABLE jsonb (int4 int, setof setof);") as any).items).toEqual([
      { kind: "column", name: "int4", dataType: ct("int"), constraints: [] },
      { kind: "column", name: "setof", dataType: ct("setof"), constraints: [] },
    ]);
    // A string after a name that does not start an operand is not a literal's.
    expect((firstStmt("SELECT a FROM t WHERE a LIKE b ESCAPE '!';") as any).where).toEqual({
      kind: "like",
      expr: name("a"),
      pattern: name("b"),
      negated: false,
      ci: false,
      escape: str("!"),
    });
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

  it("takes a bare EXCLUDE constraint in a PARTITION OF element list", () => {
    expect(
      stmt("CREATE TABLE p PARTITION OF m (a NOT NULL, EXCLUDE USING gist (a WITH &&)) FOR VALUES IN (1);").items,
    ).toEqual([
      { kind: "columnOptions", name: "a", constraints: [{ kind: "notNull" }] },
      { kind: "exclude", name: null, using: "gist", elements: [{ expr: name("a"), operator: "&&" }] },
    ]);
    // Without the lookahead, `exclude` is still a column the parent types.
    expect(stmt("CREATE TABLE p PARTITION OF m (exclude WITH OPTIONS NOT NULL) DEFAULT;").items).toEqual([
      { kind: "columnOptions", name: "exclude", withOptions: true, constraints: [{ kind: "notNull" }] },
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
    // A table-level CHECK reads the attributes and refuses the deferring ones,
    // as PG's grammar does.
    expect(() => sqlLite.parse("CREATE TABLE t (c int, CHECK (c > 0) INITIALLY DEFERRED);")).toThrow(
      /CHECK constraints cannot be marked DEFERRABLE \(1:37\)/,
    );
  });
});

// --- named column constraints ---

// Shared by the constraint describes below.
const constraintsOf = (src: string) =>
  (firstStmt(`CREATE TABLE t (c int ${src});`) as any).items[0].constraints as Record<string, unknown>[];
const tableItemOf = (src: string) => (firstStmt(`CREATE TABLE t (c int, ${src});`) as any).items[1];
const failsToParse = (sql: string) => () => sqlLite.parse(sql);
const cGt0 = bin(">", name("c"), num(0));

describe("SQL-lite named column constraints", () => {
  it("names every column constraint but COLLATE", () => {
    expect(constraintsOf("CONSTRAINT nn NOT NULL CONSTRAINT n NULL CONSTRAINT d DEFAULT 0")).toEqual([
      { kind: "notNull", name: "nn" },
      { kind: "nullable", name: "n" },
      { kind: "default", name: "d", expr: num(0) },
    ]);
    expect(constraintsOf("CONSTRAINT pk PRIMARY KEY CONSTRAINT u UNIQUE CONSTRAINT ck CHECK (c > 0)")).toEqual([
      { kind: "primaryKey", name: "pk" },
      { kind: "unique", name: "u" },
      { kind: "check", name: "ck", expr: cGt0 },
    ]);
    expect(constraintsOf("CONSTRAINT fk REFERENCES p (id) ON DELETE CASCADE DEFERRABLE")).toEqual([
      { kind: "references", name: "fk", table: ["p"], columns: ["id"], onDelete: "cascade", deferrable: true },
    ]);
    expect(constraintsOf("CONSTRAINT g GENERATED ALWAYS AS (c * 2) STORED")).toEqual([
      { kind: "generated", name: "g", expr: bin("*", name("c"), num(2)) },
    ]);
    expect(constraintsOf("CONSTRAINT i GENERATED BY DEFAULT AS IDENTITY")).toEqual([
      { kind: "identity", name: "i", generated: "by default" },
    ]);
    // A quoted name, and named and unnamed constraints mixed.
    expect(constraintsOf('NOT NULL CONSTRAINT "Pos" CHECK (c > 0) COLLATE "C"')).toEqual([
      { kind: "notNull" },
      { kind: "check", name: "Pos", expr: cGt0 },
      { kind: "collate", collation: ["C"] },
    ]);
  });

  it("names constraints in PARTITION OF column options and ALTER TABLE ADD COLUMN", () => {
    expect(
      (firstStmt("CREATE TABLE p PARTITION OF m (c WITH OPTIONS CONSTRAINT nn NOT NULL) DEFAULT;") as any).items,
    ).toEqual([
      { kind: "columnOptions", name: "c", withOptions: true, constraints: [{ kind: "notNull", name: "nn" }] },
    ]);
    expect(
      (firstStmt("ALTER TABLE t ADD COLUMN c int CONSTRAINT u UNIQUE;") as any).actions[0].column.constraints,
    ).toEqual([{ kind: "unique", name: "u" }]);
  });

  it("spans a named column constraint from CONSTRAINT", () => {
    const [stmt] = sqlLite.parse("CREATE TABLE t (c int CONSTRAINT nn NOT NULL);") as any[];
    expect(stmt.items[0].constraints[0].span).toEqual({ start: { row: 1, col: 22 }, end: { row: 1, col: 44 } });
  });

  it("rejects CONSTRAINT before COLLATE, an attribute, or nothing", () => {
    expect(failsToParse('CREATE TABLE t (c int CONSTRAINT x COLLATE "C");')).toThrow(
      expectsKeys(["not null", "check"], '"collate"'),
    );
    expect(failsToParse("CREATE TABLE t (c int CONSTRAINT x DEFERRABLE);")).toThrow(
      expectsKeys(["unique"], '"deferrable"'),
    );
    expect(failsToParse("CREATE TABLE t (c int CONSTRAINT x);")).toThrow(expectsKeys(["not null"], '")"'));
    expect(failsToParse("CREATE TABLE t (c int CONSTRAINT);")).toThrow(/Expected a name but found "\)"/);
  });
});

// --- NOT VALID and NO INHERIT ---

describe("SQL-lite NOT VALID and NO INHERIT constraint attributes", () => {
  it("reads NOT VALID and NO INHERIT on a table-level CHECK", () => {
    expect(tableItemOf("CHECK (c > 0) NOT VALID")).toEqual({ kind: "check", name: null, expr: cGt0, notValid: true });
    expect(tableItemOf("CONSTRAINT ck CHECK (c > 0) NO INHERIT")).toEqual({
      kind: "check",
      name: "ck",
      expr: cGt0,
      noInherit: true,
    });
    // Any order, alongside the non-deferring attributes PG lets through; a
    // repeat is allowed, as in PG.
    expect(tableItemOf("CHECK (c > 0) NO INHERIT NOT DEFERRABLE NOT VALID INITIALLY IMMEDIATE NOT VALID")).toEqual({
      kind: "check",
      name: null,
      expr: cGt0,
      deferrable: false,
      initially: "immediate",
      notValid: true,
      noInherit: true,
    });
  });

  it("reads NO INHERIT on a column-level CHECK", () => {
    expect(constraintsOf("CHECK (c > 0) NO INHERIT NOT NULL")).toEqual([
      { kind: "check", expr: cGt0, noInherit: true },
      { kind: "notNull" },
    ]);
  });

  it("reads NOT VALID on foreign keys, in CREATE TABLE and ALTER TABLE ADD CONSTRAINT", () => {
    expect(tableItemOf("FOREIGN KEY (c) REFERENCES p ON DELETE CASCADE NOT VALID DEFERRABLE")).toEqual({
      kind: "foreignKey",
      name: null,
      columns: ["c"],
      refTable: ["p"],
      refColumns: null,
      onDelete: "cascade",
      deferrable: true,
      notValid: true,
    });
    const alter = firstStmt(
      "ALTER TABLE ONLY t ADD CONSTRAINT fk FOREIGN KEY (c) REFERENCES p (id) NOT VALID, ADD CHECK (c > 0) NOT VALID NO INHERIT;",
    );
    expect(alter.actions).toEqual([
      {
        kind: "addConstraint",
        name: "fk",
        constraint: {
          kind: "foreignKey",
          name: null,
          columns: ["c"],
          refTable: ["p"],
          refColumns: ["id"],
          onDelete: null,
          notValid: true,
        },
      },
      {
        kind: "addConstraint",
        name: null,
        constraint: { kind: "check", name: null, expr: cGt0, notValid: true, noInherit: true },
      },
    ]);
  });

  it("keeps valid and inherit unreserved", () => {
    expect(
      firstStmt("CREATE TABLE t (valid int, inherit valid);").items.map((i: any) => [i.name, i.dataType.name]),
    ).toEqual([
      ["valid", "int"],
      ["inherit", "valid"],
    ]);
    expect(firstStmt("SELECT valid, inherit AS valid FROM inherit;")).toEqual(
      sel({
        columns: [col(name("valid")), col(name("inherit"), "valid")],
        from: [{ kind: "table", name: ["inherit"], alias: null }],
      }),
    );
    expect(constraintsOf("CONSTRAINT valid CHECK (c > 0)")).toEqual([{ kind: "check", name: "valid", expr: cGt0 }]);
    expect(tableItemOf("CONSTRAINT inherit CHECK (c > 0) NO INHERIT")).toMatchObject({
      name: "inherit",
      noInherit: true,
    });
  });

  it("keeps a table whose CHECK tail is malformed in diagnose()", () => {
    const { ast, errors } = sqlLite.diagnose("CREATE TABLE t (c int, CHECK (c > 0) NO $, e int);");
    expect(errors).toHaveLength(1);
    expect((stripSpans(ast) as any[])[0].items.map((i: any) => i.name)).toEqual(["c", "e"]);
  });

  it("rejects the attributes a constraint cannot carry, as PG's grammar does", () => {
    // NOT VALID is table-level only, and NOT NULL takes no NO INHERIT in PG 17.
    expect(failsToParse("CREATE TABLE t (c int CHECK (c > 0) NOT VALID);")).toThrow(
      /Expected "null" but found "valid"/,
    );
    expect(failsToParse("CREATE TABLE t (c int NOT NULL NO INHERIT);")).toThrow(/Expected "," but found "no"/);
    expect(failsToParse("CREATE TABLE t (c int, CHECK (c > 0) NO frob);")).toThrow(
      /Expected "inherit" but found "frob"/,
    );
    // Each constraint type refuses the attributes it cannot carry.
    expect(failsToParse("CREATE TABLE t (c int, PRIMARY KEY (c) NOT VALID);")).toThrow(
      /PRIMARY KEY constraints cannot be marked NOT VALID \(1:39\)/,
    );
    expect(failsToParse("CREATE TABLE t (c int, UNIQUE (c) NO INHERIT);")).toThrow(
      /UNIQUE constraints cannot be marked NO INHERIT \(1:34\)/,
    );
    expect(failsToParse("CREATE TABLE t (c int, EXCLUDE (c WITH =) NOT VALID);")).toThrow(
      /EXCLUDE constraints cannot be marked NOT VALID/,
    );
    expect(failsToParse("CREATE TABLE t (c int, EXCLUDE (c WITH =) NO INHERIT);")).toThrow(
      /EXCLUDE constraints cannot be marked NO INHERIT/,
    );
    expect(failsToParse("ALTER TABLE t ADD FOREIGN KEY (c) REFERENCES p NO INHERIT;")).toThrow(
      /FOREIGN KEY constraints cannot be marked NO INHERIT/,
    );
    expect(failsToParse("CREATE TABLE t (c int, CHECK (c > 0) NOT VALID DEFERRABLE);")).toThrow(
      /CHECK constraints cannot be marked DEFERRABLE \(1:47\)/,
    );
    expect(failsToParse("CREATE TABLE t (c int, CHECK (c > 0) INITIALLY DEFERRED DEFERRABLE);")).toThrow(
      /CHECK constraints cannot be marked DEFERRABLE \(1:37\)/,
    );
    // A contradiction within the list is reported before the type's refusal.
    expect(failsToParse("CREATE TABLE t (c int, CHECK (c > 0) DEFERRABLE NOT DEFERRABLE);")).toThrow(
      /conflicting constraint properties/,
    );
  });
});

// --- PRIMARY KEY / UNIQUE / EXCLUDE index parameters ---

describe("SQL-lite constraint index parameters and NULLS [NOT] DISTINCT", () => {
  it("reads NULLS [NOT] DISTINCT and the index parameters on table-level UNIQUE and PRIMARY KEY", () => {
    expect(tableItemOf("UNIQUE NULLS NOT DISTINCT (c)")).toEqual({
      kind: "unique",
      name: null,
      nulls: "not distinct",
      columns: ["c"],
    });
    expect(
      tableItemOf(
        "CONSTRAINT u UNIQUE NULLS DISTINCT (c) INCLUDE (d, e) WITH (fillfactor = 90) USING INDEX TABLESPACE ts",
      ),
    ).toEqual({
      kind: "unique",
      name: "u",
      nulls: "distinct",
      columns: ["c"],
      include: ["d", "e"],
      options: [{ name: "fillfactor", value: num(90) }],
      indexTablespace: "ts",
    });
    expect(tableItemOf("PRIMARY KEY (c) WITH (fillfactor = 70)")).toEqual({
      kind: "primaryKey",
      name: null,
      columns: ["c"],
      options: [{ name: "fillfactor", value: num(70) }],
    });
    expect(tableItemOf("PRIMARY KEY (c) INCLUDE (d) USING INDEX TABLESPACE ts DEFERRABLE")).toEqual({
      kind: "primaryKey",
      name: null,
      columns: ["c"],
      include: ["d"],
      indexTablespace: "ts",
      deferrable: true,
    });
    expect(firstStmt("ALTER TABLE t ADD CONSTRAINT u UNIQUE NULLS NOT DISTINCT (a) INCLUDE (b);").actions[0]).toEqual({
      kind: "addConstraint",
      name: "u",
      constraint: { kind: "unique", name: null, nulls: "not distinct", columns: ["a"], include: ["b"] },
    });
  });

  it("reads them on column-level UNIQUE and PRIMARY KEY, without INCLUDE", () => {
    expect(constraintsOf("UNIQUE NULLS NOT DISTINCT WITH (fillfactor = 70) USING INDEX TABLESPACE ts")).toEqual([
      {
        kind: "unique",
        nulls: "not distinct",
        options: [{ name: "fillfactor", value: num(70) }],
        indexTablespace: "ts",
      },
    ]);
    expect(constraintsOf("PRIMARY KEY WITH (fillfactor = 70)")).toEqual([
      { kind: "primaryKey", options: [{ name: "fillfactor", value: num(70) }] },
    ]);
    expect(constraintsOf("PRIMARY KEY USING INDEX TABLESPACE ts NOT DEFERRABLE")).toEqual([
      { kind: "primaryKey", indexTablespace: "ts", deferrable: false },
    ]);
  });

  it("reads them on EXCLUDE, ahead of its WHERE", () => {
    expect(
      tableItemOf(
        "EXCLUDE USING gist (c WITH &&) INCLUDE (d) WITH (fillfactor = 50) USING INDEX TABLESPACE ts WHERE (c > 0)",
      ),
    ).toEqual({
      kind: "exclude",
      name: null,
      using: "gist",
      elements: [{ expr: name("c"), operator: "&&" }],
      include: ["d"],
      options: [{ name: "fillfactor", value: num(50) }],
      indexTablespace: "ts",
      where: cGt0,
    });
  });

  it("keeps include, nulls, tablespace and index unreserved", () => {
    const words = ["include", "nulls", "tablespace", "index"];
    expect(
      firstStmt(`CREATE TABLE t (${words.map((w) => `${w} int`).join(", ")});`).items.map((i: any) => i.name),
    ).toEqual(words);
    expect(
      firstStmt(`CREATE TABLE t (${words.map((w, i) => `c${i} ${w}`).join(", ")});`).items.map(
        (i: any) => i.dataType.name,
      ),
    ).toEqual(words);
    expect(firstStmt("SELECT include, nulls AS tablespace FROM index;")).toEqual(
      sel({
        columns: [col(name("include")), col(name("nulls"), "tablespace")],
        from: [{ kind: "table", name: ["index"], alias: null }],
      }),
    );
  });

  it("rejects misplaced or malformed index parameters", () => {
    expect(failsToParse("CREATE TABLE t (c int UNIQUE INCLUDE (c));")).toThrow(/Expected "," but found "include"/);
    expect(failsToParse("CREATE TABLE t (c int, UNIQUE (c) INCLUDE ());")).toThrow(/Expected a name but found "\)"/);
    expect(failsToParse("CREATE TABLE t (c int, UNIQUE (c) USING INDEX TABLESPACE ts INCLUDE (c));")).toThrow(
      /Expected "," but found "include"/,
    );
    expect(failsToParse("CREATE TABLE t (c int UNIQUE USING INDEX ts);")).toThrow(
      /Expected "tablespace" but found "ts"/,
    );
    expect(failsToParse("CREATE TABLE t (c int, UNIQUE NULLS (c));")).toThrow(/Expected "distinct" but found "\("/);
    expect(failsToParse("CREATE TABLE t (c int, UNIQUE (c) NULLS NOT DISTINCT);")).toThrow(
      /Expected "," but found "nulls"/,
    );
    expect(failsToParse("CREATE TABLE t (c int PRIMARY KEY NULLS NOT DISTINCT);")).toThrow(
      /Expected "," but found "nulls"/,
    );
    // PG reads a definition list here, not reloptions: no namespace.
    expect(failsToParse("CREATE TABLE t (c int, UNIQUE (c) WITH (toast.x = 1));")).toThrow(
      /a constraint's index parameters take no namespace, but found "toast.x"/,
    );
    expect(failsToParse("CREATE TABLE t (c int UNIQUE WITH (a.b = 1));")).toThrow(
      /a constraint's index parameters take no namespace, but found "a.b"/,
    );
  });
});

// --- ON DELETE SET NULL / SET DEFAULT (cols) ---

describe("SQL-lite ON DELETE SET NULL / SET DEFAULT column lists", () => {
  it("reads a column list on ON DELETE SET NULL / SET DEFAULT", () => {
    expect(tableItemOf("FOREIGN KEY (c, d) REFERENCES p ON DELETE SET NULL (d) ON UPDATE CASCADE")).toEqual({
      kind: "foreignKey",
      name: null,
      columns: ["c", "d"],
      refTable: ["p"],
      refColumns: null,
      onDelete: "set null",
      onDeleteColumns: ["d"],
      onUpdate: "cascade",
    });
    expect(constraintsOf("REFERENCES p ON UPDATE RESTRICT ON DELETE SET DEFAULT (c)")).toEqual([
      {
        kind: "references",
        table: ["p"],
        columns: null,
        onDelete: "set default",
        onDeleteColumns: ["c"],
        onUpdate: "restrict",
      },
    ]);
  });

  it("rejects a column list on ON UPDATE, after another action, or empty", () => {
    expect(failsToParse("CREATE TABLE t (c int REFERENCES p ON UPDATE SET NULL (c));")).toThrow(
      /a column list with SET NULL is only supported for ON DELETE actions \(1:35\)/,
    );
    expect(failsToParse("CREATE TABLE t (c int REFERENCES p ON UPDATE SET DEFAULT (c));")).toThrow(
      /a column list with SET DEFAULT is only supported for ON DELETE actions/,
    );
    expect(failsToParse("CREATE TABLE t (c int REFERENCES p ON DELETE CASCADE (c));")).toThrow(
      /Expected "," but found "\("/,
    );
    expect(failsToParse("CREATE TABLE t (c int, FOREIGN KEY (c) REFERENCES p ON DELETE SET DEFAULT ());")).toThrow(
      /Expected a name but found "\)"/,
    );
  });
});

// --- CREATE INDEX NULLS [NOT] DISTINCT and TABLESPACE ---

describe("SQL-lite CREATE INDEX NULLS [NOT] DISTINCT and TABLESPACE", () => {
  it("reads NULLS [NOT] DISTINCT and TABLESPACE in PG's clause order", () => {
    expect(firstStmt("CREATE UNIQUE INDEX i ON t (a) INCLUDE (b) NULLS NOT DISTINCT TABLESPACE ts;")).toEqual({
      kind: "createIndex",
      unique: true,
      concurrently: false,
      ifNotExists: false,
      name: "i",
      table: ["t"],
      using: null,
      columns: [{ expr: name("a") }],
      include: ["b"],
      nulls: "not distinct",
      tablespace: "ts",
      where: null,
    });
    expect(
      firstStmt("CREATE INDEX ON ONLY t (a) NULLS DISTINCT WITH (fillfactor = 70) TABLESPACE ts WHERE a > 0;"),
    ).toMatchObject({
      only: true,
      nulls: "distinct",
      options: [{ name: "fillfactor", value: num(70) }],
      tablespace: "ts",
      where: bin(">", name("a"), num(0)),
    });
  });

  it("rejects a malformed or misplaced NULLS or TABLESPACE", () => {
    expect(failsToParse("CREATE INDEX i ON t (a) NULLS FIRST;")).toThrow(/Expected "distinct" but found "first"/);
    expect(failsToParse("CREATE INDEX i ON t (a) TABLESPACE ts WITH (fillfactor = 1);")).toThrow(/but found "with"/);
    expect(failsToParse("CREATE INDEX i ON t (a) TABLESPACE;")).toThrow(/Expected a name but found ";"/);
  });
});

// --- GENERATED ... VIRTUAL ---

describe("SQL-lite GENERATED ALWAYS AS (expr) VIRTUAL", () => {
  it("reads VIRTUAL alongside STORED", () => {
    expect(constraintsOf("GENERATED ALWAYS AS (c + 1) VIRTUAL NOT NULL")).toEqual([
      { kind: "generated", expr: bin("+", name("c"), num(1)), virtual: true },
      { kind: "notNull" },
    ]);
  });

  it("keeps virtual unreserved", () => {
    expect(firstStmt("CREATE TABLE t (virtual virtual);").items[0]).toMatchObject({
      name: "virtual",
      dataType: { name: "virtual" },
    });
    expect(firstStmt("SELECT virtual AS virtual FROM virtual;")).toEqual(
      sel({ columns: [col(name("virtual"), "virtual")], from: [{ kind: "table", name: ["virtual"], alias: null }] }),
    );
  });

  it("still needs STORED or VIRTUAL, and ALWAYS", () => {
    expect(failsToParse("CREATE TABLE t (c int GENERATED ALWAYS AS (1));")).toThrow(
      expectsKeys(["stored", "virtual"], '")"'),
    );
    expect(failsToParse("CREATE TABLE t (c int GENERATED BY DEFAULT AS (1) VIRTUAL);")).toThrow(
      /for a generated column, GENERATED ALWAYS must be specified/,
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
    const { ast, errors } = sqlLite.diagnose("CREATE TABLE t (id int, exclude \\, ok text);");
    expect(errors.map((e) => e.message)).toEqual(['Unexpected character "\\" (1:32)']);
    expect((stripSpans(ast) as any)[0].items.map((i: any) => i.name)).toEqual(["id", "ok"]);
    expect(sqlLite.diagnose("CREATE TABLE t (EXCLUDE (a WITH \\));").errors[0]!.message).toBe(
      'Unexpected character "\\" (1:32)',
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
      expectsKeys(["primary key", "unique", "check", "foreign key", "exclude"], '"42"'),
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
    expect(() => sqlLite.parse("SELECT * FROM (1);")).toThrow(
      /Expected "select" or "values" or "table" or "\(" but found "1"/,
    );
    expect(() => sqlLite.parse("SELECT * FROM (;")).toThrow(
      /Expected "select" or "values" or "table" or "\(" but found ";"/,
    );
    expect(() => sqlLite.parse("SELECT * FROM ((NULL)) x;")).toThrow(
      /Expected "select" or "values" or "table" or "\(" but found "null"/,
    );
    // A trailing query clause continues a query, so the run still takes the
    // query reading — and a parenthesised query takes an ORDER BY after its `)`.
    expect(from("SELECT * FROM ((SELECT 1) ORDER BY 1) x;")).toEqual([
      {
        kind: "subquery",
        query: sel({ columns: [col(num(1))], orderBy: [{ expr: num(1), dir: null, nulls: null }] }),
        alias: "x",
      },
    ]);
    // LATERAL takes no parenthesised join, as in PG: its `(` is a subquery.
    expect(() => sqlLite.parse("SELECT * FROM LATERAL (a JOIN b ON true);")).toThrow(/Expected "select"/);
    expect(() => sqlLite.parse("SELECT * FROM ROWS FROM ();")).toThrow(/Expected a name but found "\)"/);
    expect(() => sqlLite.parse("SELECT * FROM ROWS FROM (f);")).toThrow(/Expected "\(" but found "\)"/);
    expect(() => sqlLite.parse("SELECT * FROM t WITH ORDINALITY;")).toThrow(/Expected ";" but found "with"/);
  });
});

// --- NATURAL joins, join qualifiers and FROM-item extras ---

describe("SQL-lite NATURAL joins, join qualifiers and FROM-item extras", () => {
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
  const [a, b, c, d] = ["a", "b", "c", "d"].map((t) => tableFrom([t]));
  const def = (colName: string, type: string, over: Record<string, unknown> = {}) => ({
    name: colName,
    type: ct(type),
    ...over,
  });

  it("records NATURAL on the join node", () => {
    expect(from("SELECT * FROM a NATURAL JOIN b;")).toEqual([join(a, b, { natural: true, on: null })]);
    expect(from("SELECT * FROM a NATURAL LEFT OUTER JOIN b;")).toEqual([
      join(a, b, { joinType: "left", natural: true, on: null }),
    ]);
    expect(from("SELECT * FROM a NATURAL FULL JOIN b NATURAL INNER JOIN c;")).toEqual([
      join(join(a, b, { joinType: "full", natural: true, on: null }), c, { natural: true, on: null }),
    ]);
    // A qualified join carries no `natural` key.
    expect(from("SELECT * FROM a JOIN b ON true;")).toEqual([join(a, b)]);
  });

  it("nests a join met before the qualifier on the right, as PG does", () => {
    // The inner join takes the first qualifier, the outer one the next.
    expect(from("SELECT * FROM a JOIN b JOIN c ON true ON false;")).toEqual([join(a, join(b, c), { on: bool(false) })]);
    expect(from("SELECT * FROM a LEFT JOIN b JOIN c USING (x) JOIN d ON true ON false;")).toEqual([
      join(a, join(join(b, c, { on: null, using: ["x"] }), d), { joinType: "left", on: bool(false) }),
    ]);
    // A CROSS or NATURAL join needs no qualifier, so it completes on the
    // right of a pending join, and folds to the left otherwise.
    expect(from("SELECT * FROM a JOIN b CROSS JOIN c ON true;")).toEqual([
      join(a, join(b, c, { joinType: "cross", on: null })),
    ]);
    expect(from("SELECT * FROM a JOIN b NATURAL JOIN c USING (x);")).toEqual([
      join(a, join(b, c, { natural: true, on: null }), { on: null, using: ["x"] }),
    ]);
    expect(from("SELECT * FROM a CROSS JOIN b JOIN c ON true;")).toEqual([
      join(join(a, b, { joinType: "cross", on: null }), c),
    ]);
    expect(from("SELECT * FROM a JOIN b ON true JOIN c ON false;")).toEqual([join(join(a, b), c, { on: bool(false) })]);
  });

  it("parses USING (…) AS alias", () => {
    expect(from("SELECT * FROM a JOIN b USING (id) AS j;")).toEqual([
      join(a, b, { on: null, using: ["id"], usingAlias: "j" }),
    ]);
    expect(from('SELECT * FROM a LEFT JOIN b USING (x, y) AS "J" JOIN c ON true, d;')).toEqual([
      join(join(a, b, { joinType: "left", on: null, using: ["x", "y"], usingAlias: "J" }), c),
      d,
    ]);
    // The alias also names the USING of a join nested on the right.
    expect(from("SELECT * FROM a JOIN b JOIN c USING (x) AS j ON true;")).toEqual([
      join(a, join(b, c, { on: null, using: ["x"], usingAlias: "j" })),
    ]);
  });

  it("parses the inheritance star after a table name", () => {
    // `t *` means what a bare `t` means, so it records nothing.
    expect(from("SELECT * FROM parent_table * WHERE x > 1;")).toEqual([tableFrom(["parent_table"])]);
    expect(from("SELECT * FROM s.t * AS x (a) TABLESAMPLE system (1);")).toEqual([
      {
        ...tableFrom(["s", "t"], "x"),
        columns: ["a"],
        tablesample: { method: "system", args: [num(1)], repeatable: null },
      },
    ]);
    expect(from("SELECT * FROM a * JOIN b * ON true;")).toEqual([join(a, b)]);
  });

  it("parses column definition lists on table functions", () => {
    const rec = call("json_to_record", [str("{}")]);
    expect(from("SELECT * FROM json_to_record('{}') AS x(a int, b text);")).toEqual([
      { kind: "function", call: rec, alias: "x", columnDefinitions: [def("a", "int"), def("b", "text")] },
    ]);
    // The alias is optional after AS, and so is the AS before an alias.
    expect(from("SELECT * FROM json_to_record('{}') AS (a int);")).toEqual([
      { kind: "function", call: rec, alias: null, columnDefinitions: [def("a", "int")] },
    ]);
    expect(from('SELECT * FROM f() x (a numeric(10, 2)[], "B" double precision COLLATE "C", c s.t);')).toEqual([
      {
        kind: "function",
        call: call("f"),
        alias: "x",
        columnDefinitions: [
          def("a", "numeric", { type: ct("numeric", { args: [10, 2], array: true }) }),
          def("B", "double precision", { collate: ["C"] }),
          def("c", "s.t"),
        ],
      },
    ]);
    expect(from("SELECT * FROM t, LATERAL f(t.a) WITH ORDINALITY AS (a int, n bigint);")[1]).toEqual({
      kind: "function",
      call: call("f", [name("t", "a")]),
      alias: null,
      columnDefinitions: [def("a", "int"), def("n", "bigint")],
      lateral: true,
      ordinality: true,
    });
    // A list of bare names is still an alias column list.
    expect(from("SELECT * FROM f() AS x (a, b);")).toEqual([
      { kind: "function", call: call("f"), alias: "x", columns: ["a", "b"] },
    ]);
  });

  it("parses column definition lists in ROWS FROM", () => {
    expect(from("SELECT * FROM ROWS FROM (f() AS (a int), g(1)) AS r (x, y);")).toEqual([
      {
        kind: "rowsFrom",
        calls: [call("f"), call("g", [num(1)])],
        callColumnDefinitions: [[def("a", "int")], null],
        alias: "r",
        columns: ["x", "y"],
      },
    ]);
    expect(from("SELECT * FROM ROWS FROM (f(), g() AS (a int));")[0].callColumnDefinitions).toEqual([
      null,
      [def("a", "int")],
    ]);
    // A list after the whole item is the function item's func_alias_clause.
    expect(from("SELECT * FROM ROWS FROM (f()) AS r (a text);")).toEqual([
      { kind: "rowsFrom", calls: [call("f")], alias: "r", columnDefinitions: [def("a", "text")] },
    ]);
  });

  it("keeps unreserved words usable as column definition and alias column names", () => {
    expect(from("SELECT * FROM f() AS x (ordinality int, rows text);")[0].columnDefinitions).toEqual([
      def("ordinality", "int"),
      def("rows", "text"),
    ]);
    expect(from("SELECT * FROM f() AS rows (ordinality, rows);")).toEqual([
      { kind: "function", call: call("f"), alias: "rows", columns: ["ordinality", "rows"] },
    ]);
  });

  it("applies the join rules wherever a FROM item is read", () => {
    const merge = firstStmt(
      "MERGE INTO t USING s JOIN u JOIN v ON true ON false ON t.id = s.id WHEN MATCHED THEN DELETE;",
    );
    expect(merge.source).toEqual(join(tableFrom(["s"]), join(tableFrom(["u"]), tableFrom(["v"])), { on: bool(false) }));
    // MERGE's own ON is not a join qualifier.
    expect(() => sqlLite.parse("MERGE INTO t USING s JOIN u ON true WHEN MATCHED THEN DELETE;")).toThrow(
      /Expected "on" but found "when"/,
    );
    expect(() => sqlLite.parse("SELECT * FROM (a JOIN b);")).toThrow(/Expected "on" or "using" but found "\)"/);
    expect(() => sqlLite.parse("UPDATE t SET x = 1 FROM a JOIN b WHERE true;")).toThrow(
      /Expected "on" or "using" but found "where"/,
    );
    expect(() => sqlLite.parse("DELETE FROM t USING a JOIN b;")).toThrow(/Expected "on" or "using" but found ";"/);
  });

  it("rejects a join without a qualifier and NATURAL CROSS JOIN", () => {
    expect(() => sqlLite.parse("SELECT * FROM a JOIN b;")).toThrow(/Expected "on" or "using" but found ";"/);
    expect(() => sqlLite.parse("SELECT * FROM a LEFT JOIN b WHERE true;")).toThrow(
      /Expected "on" or "using" but found "where"/,
    );
    expect(() => sqlLite.parse("SELECT * FROM a, b FULL JOIN c, d;")).toThrow(/Expected "on" or "using" but found ","/);
    // The only ON goes to the inner join, leaving the outer one without one.
    expect(() => sqlLite.parse("SELECT * FROM a JOIN b JOIN c ON true;")).toThrow(
      /Expected "on" or "using" but found ";"/,
    );
    expect(() => sqlLite.parse("SELECT * FROM a NATURAL CROSS JOIN b;")).toThrow(
      /Expected "join", "inner", "left", "right" or "full" but found "cross"/,
    );
    // CROSS and NATURAL joins take no qualifier.
    expect(() => sqlLite.parse("SELECT * FROM a CROSS JOIN b ON true;")).toThrow(/Expected ";" but found "on"/);
    expect(() => sqlLite.parse("SELECT * FROM a NATURAL JOIN b USING (x);")).toThrow(/Expected ";" but found "using"/);
    expect(() => sqlLite.parse("SELECT * FROM a JOIN b ON true ON false;")).toThrow(/Expected ";" but found "on"/);
  });

  it("rejects malformed USING aliases, stars and column definition lists", () => {
    // PG's join_using_alias requires the AS.
    expect(() => sqlLite.parse("SELECT * FROM a JOIN b USING (id) j;")).toThrow(/Expected ";" but found "j"/);
    expect(() => sqlLite.parse("SELECT * FROM a JOIN b USING (id) AS;")).toThrow(/Expected an alias but found ";"/);
    // The star follows a plain name only: not ONLY, and not twice.
    expect(() => sqlLite.parse("SELECT * FROM ONLY t *;")).toThrow(/Expected ";" but found "\*"/);
    expect(() => sqlLite.parse("SELECT * FROM t * *;")).toThrow(/Expected ";" but found "\*"/);
    // A definition list names at least one column, each with a type, and
    // mixes with no bare names.
    expect(() => sqlLite.parse("SELECT * FROM f() AS ();")).toThrow(/Expected a name but found "\)"/);
    expect(() => sqlLite.parse("SELECT * FROM f() AS (a);")).toThrow(/Expected a name but found "\)"/);
    expect(() => sqlLite.parse("SELECT * FROM f() AS x (a int, b);")).toThrow(/Expected a name but found "\)"/);
    expect(() => sqlLite.parse("SELECT * FROM f() AS x (a, b int);")).toThrow(/Expected "\)" but found "int"/);
    // Inside ROWS FROM, a call takes only the alias-less `AS (…)` spelling.
    expect(() => sqlLite.parse("SELECT * FROM ROWS FROM (f() AS x (a int));")).toThrow(/Expected "\(" but found "x"/);
    // Subqueries take no definition list, and functions no TABLESAMPLE.
    expect(() => sqlLite.parse("SELECT * FROM (SELECT 1) AS x (a int);")).toThrow(/Expected "\)" but found "int"/);
    expect(() => sqlLite.parse("SELECT * FROM f() x (a int) TABLESAMPLE system (1);")).toThrow(
      /Expected ";" but found "tablesample"/,
    );
  });

  it("reports a lex error met by the column definition lookahead", () => {
    expect(() => sqlLite.parse("SELECT * FROM f() x (a \\);")).toThrow(/Unexpected character "\\"/);
    const { ast, errors } = sqlLite.diagnose("SELECT * FROM f() x (a \\);\nSELECT 1;");
    expect(errors.map((e) => e.message)).toEqual(['Unexpected character "\\" (1:23)']);
    expect(ast).toHaveLength(2);
    // The other two lookahead points report it too: past a bare AS, where the
    // alias is then missing, and on the first name inside the parenthesis.
    expect(() => sqlLite.parse("SELECT * FROM f() AS \\;")).toThrow(/Unexpected character "\\"/);
    expect(sqlLite.diagnose("SELECT * FROM f() AS \\;").errors.map((e) => e.message)).toEqual([
      'Unexpected character "\\" (1:21)',
      'Expected an alias but found ";" (1:22)',
    ]);
    expect(() => sqlLite.parse("SELECT * FROM f() x (\\ int);")).toThrow(/Unexpected character "\\"/);
    expect(sqlLite.diagnose("SELECT * FROM f() x (\\ int);").errors.map((e) => e.message)).toEqual([
      'Unexpected character "\\" (1:21)',
    ]);
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

  it("takes a CURRENT_ / SESSION_ pseudo-role as the new owner, as CREATE does", () => {
    for (const role of ["current_user", "current_role", "session_user"]) {
      const owner = { kind: "ownerTo", owner: role };
      for (const target of ["SCHEMA s", "DOMAIN d", "TYPE x", "FUNCTION f", "AGGREGATE a(*)", "SEQUENCE q"]) {
        expect(action(`ALTER ${target} OWNER TO ${role};`)).toEqual(owner);
      }
      for (const target of ["TABLE t", "VIEW v", "MATERIALIZED VIEW m"]) {
        expect(alter(`ALTER ${target} OWNER TO ${role};`).actions).toEqual([owner]);
      }
    }
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
      expectsKeys(["set", "drop", "add", "rename", "owner", "validate"], '"frobnicate"'),
    );
    expect(fails("ALTER TYPE t frobnicate;")).toThrow(expectsKeys(["add", "rename", "owner", "set"], '"frobnicate"'));
    expect(fails("ALTER INDEX i frobnicate;")).toThrow(expectsKeys(["rename", "set", "reset"], '"frobnicate"'));
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
      expectsKeys(["rename", "owner", "set", "immutable", "cost", "rows"], '"frobnicate"'),
    );
    expect(fails("ALTER FUNCTION f(int) LANGUAGE sql;")).toThrow(/Expected "rename", .* but found "language"/);
    expect(fails("ALTER FUNCTION f NOT NULL;")).toThrow(/Expected "leakproof" but found "null"/);
    expect(fails("ALTER FUNCTION f IMMUTABLE SET SCHEMA s;")).toThrow(/Expected a string but found "s"/);
    expect(fails("ALTER AGGREGATE a RENAME TO b;")).toThrow(/Expected "\(" but found "rename"/);
    // A signature names an existing routine, as DROP's does: no argument
    // defaults, and no empty aggregate list (a zero-argument one is `(*)`).
    expect(fails("ALTER FUNCTION f(a int = 1) RENAME TO g;")).toThrow(
      /takes no argument defaults, but found "=" \(1:23\)/,
    );
    expect(fails("ALTER AGGREGATE a(x int DEFAULT 1) OWNER TO r;")).toThrow(/takes no argument defaults/);
    expect(fails("ALTER AGGREGATE a() OWNER TO r;")).toThrow(/Expected "\*" or a function argument but found "\)"/);
    expect(fails("ALTER AGGREGATE a(*) IMMUTABLE;")).toThrow(
      /Expected "rename", "owner" or "set" but found "immutable"/,
    );
    expect(fails("ALTER VIEW v frobnicate;")).toThrow(
      expectsKeys(["rename", "owner", "set", "reset", "alter"], '"frobnicate"'),
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
      expectsKeys(["rename", "owner", "set", "as", "no", "owned"], '"frobnicate"'),
    );
    expect(fails("ALTER SEQUENCE s NO frob;")).toThrow(/Expected "minvalue", "maxvalue" or "cycle" but found "frob"/);
    expect(fails("ALTER SEQUENCE s SET frob;")).toThrow(/Expected "schema" but found "frob"/);
    expect(fails("ALTER SEQUENCE s RESTART RENAME TO t;")).toThrow(/Expected ";" but found "rename"/);
  });
});

// --- object references: COMMENT ON, SECURITY LABEL, ALTER EXTENSION, generic ALTER ---

describe("SQL-lite object references", () => {
  const ty = (typeName: string) => ({ name: typeName, args: [], array: false });
  const arg = (typeName: string, mode: string | null = null) => ({
    mode,
    name: null,
    type: ty(typeName),
    defaultValue: null,
  });
  const comment = (sql: string) => firstStmt(`COMMENT ON ${sql} IS 'c';`);
  const fails = (text: string) => () => sqlLite.parse(text);

  it("reads each reference shape after COMMENT ON", () => {
    const node = (ref: Record<string, unknown>) => ({ kind: "comment", ...ref, comment: "c" });
    expect(comment("EXTENSION pgcrypto")).toEqual(node({ objectType: "extension", name: ["pgcrypto"] }));
    expect(comment("TEXT SEARCH CONFIGURATION s.cfg")).toEqual(
      node({ objectType: "text search configuration", name: ["s", "cfg"] }),
    );
    expect(comment("PROCEDURAL LANGUAGE plpgsql")).toEqual(node({ objectType: "language", name: ["plpgsql"] }));
    // A routine's argument list is optional and omitted when absent; an
    // aggregate's is not.
    expect(comment("FUNCTION f")).toEqual(node({ objectType: "function", name: ["f"] }));
    expect(comment("PROCEDURE s.p(IN integer, text)")).toEqual(
      node({
        objectType: "procedure",
        name: ["s", "p"],
        signature: { star: false, args: [arg("integer", "in"), arg("text")] },
      }),
    );
    expect(comment("AGGREGATE a(*)")).toEqual(
      node({ objectType: "aggregate", name: ["a"], signature: { star: true, args: [] } }),
    );
    expect(comment("OPERATOR pg_catalog.+ (int4, int4)")).toEqual(
      node({ objectType: "operator", name: ["pg_catalog", "+"], operands: [ty("int4"), ty("int4")] }),
    );
    expect(comment("OPERATOR ~~ (NONE, text)")).toEqual(
      node({ objectType: "operator", name: ["~~"], operands: [null, ty("text")] }),
    );
    expect(comment("CAST (bigint AS text)")).toEqual(
      node({ objectType: "cast", source: ty("bigint"), target: ty("text") }),
    );
    expect(comment("TRANSFORM FOR hstore LANGUAGE plpython3u")).toEqual(
      node({ objectType: "transform", type: ty("hstore"), language: "plpython3u" }),
    );
    expect(comment("OPERATOR CLASS s.ops USING btree")).toEqual(
      node({ objectType: "operator class", name: ["s", "ops"], using: "btree" }),
    );
    expect(comment("LARGE OBJECT 16401")).toEqual(node({ objectType: "large object", oid: 16401 }));
    expect(comment("CONSTRAINT qty_pos ON app.items")).toEqual(
      node({ objectType: "constraint", name: ["qty_pos"], table: ["app", "items"] }),
    );
    expect(comment("CONSTRAINT positive ON DOMAIN app.qty")).toEqual(
      node({ objectType: "constraint", name: ["positive"], domain: ["app", "qty"] }),
    );
    expect(comment("POLICY own_rows ON docs")).toEqual(
      node({ objectType: "policy", name: ["own_rows"], table: ["docs"] }),
    );
  });

  it("tells a kind word from a name the way PostgreSQL does", () => {
    // OPERATOR CLASS needs a name after CLASS; `class.+` is a qualified operator.
    expect(comment("OPERATOR class.+ (int, int)")).toMatchObject({ objectType: "operator", name: ["class", "+"] });
    // DOMAIN needs a name after it; alone, it is the table's name.
    expect(comment("CONSTRAINT c ON domain")).toMatchObject({ table: ["domain"] });
    expect(comment("TRIGGER trigger ON rule")).toMatchObject({ name: ["trigger"], table: ["rule"] });
  });

  it("parses SECURITY LABEL with and without a provider", () => {
    expect(firstStmt("SECURITY LABEL FOR selinux ON TABLE s.t IS 'system_u';")).toEqual({
      kind: "securityLabel",
      provider: "selinux",
      objectType: "table",
      name: ["s", "t"],
      label: "system_u",
    });
    expect(firstStmt("SECURITY LABEL FOR 'dummy' ON ROUTINE r(int) IS NULL;")).toEqual({
      kind: "securityLabel",
      provider: "dummy",
      objectType: "routine",
      name: ["r"],
      signature: { star: false, args: [arg("int")] },
      label: null,
    });
    expect(firstStmt("SECURITY LABEL ON LARGE OBJECT 7 IS 'x';")).not.toHaveProperty("provider");
    expect(firstStmt("SECURITY LABEL ON LARGE OBJECT -7 IS 'x';")).toMatchObject({ oid: -7 });
    expect(comment("LARGE OBJECT +7")).toMatchObject({ oid: 7 });
  });

  it("parses ALTER EXTENSION ADD / DROP, SET SCHEMA and UPDATE", () => {
    const ext = (action: Record<string, unknown>) => ({ kind: "alterExtension", name: "e", action });
    expect(firstStmt("ALTER EXTENSION e ADD FUNCTION f(int);")).toEqual(
      ext({
        kind: "add",
        object: { objectType: "function", name: ["f"], signature: { star: false, args: [arg("int")] } },
      }),
    );
    expect(firstStmt("ALTER EXTENSION e DROP OPERATOR FAMILY f USING gin;")).toEqual(
      ext({ kind: "drop", object: { objectType: "operator family", name: ["f"], using: "gin" } }),
    );
    expect(firstStmt("ALTER EXTENSION e SET SCHEMA s;")).toEqual(ext({ kind: "setSchema", schema: "s" }));
    expect(firstStmt("ALTER EXTENSION e UPDATE TO '3.4.0';")).toEqual(ext({ kind: "update", version: "3.4.0" }));
    expect(firstStmt("ALTER EXTENSION e UPDATE;")).toEqual(ext({ kind: "update" }));
  });

  it("parses RENAME TO, OWNER TO and SET SCHEMA on the kinds with no ALTER target of their own", () => {
    const alter = (sql: string) => firstStmt(sql) as any;
    expect(alter("ALTER PROCEDURE app.archive(IN integer) OWNER TO app_owner;")).toEqual({
      kind: "alterObject",
      object: {
        objectType: "procedure",
        name: ["app", "archive"],
        signature: { star: false, args: [arg("integer", "in")] },
      },
      action: { kind: "ownerTo", owner: "app_owner" },
    });
    expect(alter("ALTER PUBLICATION pub OWNER TO CURRENT_USER;")).toEqual({
      kind: "alterObject",
      object: { objectType: "publication", name: ["pub"] },
      action: { kind: "ownerTo", owner: "current_user" },
    });
    expect(alter("ALTER TRIGGER audit ON users RENAME TO users_audit;")).toEqual({
      kind: "alterObject",
      object: { objectType: "trigger", name: ["audit"], table: ["users"] },
      action: { kind: "rename", to: "users_audit" },
    });
    expect(alter("ALTER TEXT SEARCH DICTIONARY d SET SCHEMA s;").action).toEqual({ kind: "setSchema", schema: "s" });
    expect(alter("ALTER OPERATOR - (NONE, int) SET SCHEMA s;").object).toMatchObject({ operands: [null, ty("int")] });
    expect(alter("ALTER LARGE OBJECT 5 OWNER TO r;").object).toEqual({ objectType: "large object", oid: 5 });
    expect(alter("ALTER DATABASE appdb OWNER TO app_owner;").object).toEqual({
      objectType: "database",
      name: ["appdb"],
    });
  });

  it("rejects unknown kinds, kinds a statement does not take and malformed references", () => {
    expect(fails("COMMENT ON frob x IS 'c';")).toThrow(expectsKeys(["table", "extension", "cast", "large"], '"frob"'));
    expect(fails("COMMENT ON TEXT x IS 'c';")).toThrow(/Expected "search" but found "x"/);
    expect(fails("COMMENT ON LARGE x IS 'c';")).toThrow(/Expected "object" but found "x"/);
    expect(fails("COMMENT ON SCHEMA a.b IS 'c';")).toThrow(/Expected "is" but found "\."/);
    expect(fails("COMMENT ON OPERATOR + (int) IS 'c';")).toThrow(/Expected "," but found "\)"/);
    expect(fails("COMMENT ON OPERATOR + (NONE, NONE) IS 'c';")).toThrow(/not NONE twice/);
    expect(fails("COMMENT ON OPERATOR (int, int) IS 'c';")).toThrow(/Expected an operator but found "\("/);
    expect(fails("COMMENT ON OPERATOR => (int, int) IS 'c';")).toThrow(/Expected an operator but found "=>"/);
    expect(fails("COMMENT ON CAST (int, text) IS 'c';")).toThrow(/Expected "as" but found ","/);
    expect(fails("COMMENT ON OPERATOR CLASS c IS 'c';")).toThrow(/Expected "using" but found "is"/);
    expect(fails("COMMENT ON LARGE OBJECT x IS 'c';")).toThrow(/Expected a number but found "x"/);
    expect(fails("COMMENT ON TRIGGER t IS 'c';")).toThrow(/Expected "on" but found "is"/);
    expect(fails("COMMENT ON AGGREGATE a IS 'c';")).toThrow(/Expected "\(" but found "is"/);
    expect(fails("COMMENT ON FUNCTION f(a int = 1) IS 'c';")).toThrow(/takes no argument defaults/);
    expect(fails("COMMENT ON TABLE t IS 42;")).toThrow(/Expected a string or "null" but found "42"/);
    expect(fails("SECURITY LABEL ON CAST (int AS text) IS 'l';")).toThrow(/but found "cast"/);
    expect(fails("SECURITY LABEL ON CONSTRAINT c ON t IS 'l';")).toThrow(/but found "constraint"/);
    expect(fails("SECURITY LABEL FOR ON TABLE t IS 'l';")).toThrow(/Expected a name but found "on"/);
    expect(fails("ALTER EXTENSION e ADD COLUMN t.c;")).toThrow(/but found "column"/);
    expect(fails("ALTER EXTENSION e RENAME TO f;")).toThrow(
      /Expected "add", "drop", "set" or "update" but found "rename"/,
    );
    expect(fails("ALTER OPERATOR + (int, int) RENAME TO x;")).toThrow(/Expected "owner" or "set" but found "rename"/);
    expect(fails("ALTER TEXT SEARCH PARSER p OWNER TO r;")).toThrow(/Expected "rename" or "set" but found "owner"/);
    expect(fails("ALTER LARGE OBJECT 5 SET SCHEMA s;")).toThrow(/Expected "owner" but found "set"/);
    expect(fails("ALTER CAST (int AS text) OWNER TO r;")).toThrow(
      expectsKeys(["table", "procedure", "large"], '"cast"'),
    );
  });

  it("keeps the object kind words unreserved as names and aliases", () => {
    const words = [
      "security label extension routine procedure transform procedural language large object operator class family",
      "access method event data wrapper text search parser dictionary template configuration collation conversion",
      "statistics publication subscription server policy rule none add update",
    ]
      .join(" ")
      .split(" ");
    expect(firstStmt(`SELECT ${words.join(", ")} FROM t;`).columns.map((c: any) => c.expr)).toEqual(
      words.map((word) => name(word)),
    );
    expect(firstStmt("SELECT 1 AS security, 2 label FROM extension AS routine;")).toMatchObject({
      columns: [{ alias: "security" }, { alias: "label" }],
      from: [{ name: ["extension"], alias: "routine" }],
    });
    expect(firstStmt("CREATE TABLE security (label text, transform int, routine int);")).toMatchObject({
      name: ["security"],
    });
    // …and as the names of the objects referred to.
    expect(comment("EXTENSION extension")).toMatchObject({ name: ["extension"] });
    expect(firstStmt("SECURITY LABEL FOR label ON ROUTINE routine IS 'l';")).toMatchObject({
      provider: "label",
      name: ["routine"],
    });
    expect(firstStmt("ALTER ROUTINE transform RENAME TO security;")).toMatchObject({
      object: { name: ["transform"] },
      action: { to: "security" },
    });
  });
});

// --- policies, publications and subscriptions ---

describe("SQL-lite policies, publications and subscriptions", () => {
  const bad = (src: string) => () => sqlLite.parse(src);
  const opt = (optionName: string, value: unknown) => ({ name: optionName, value });

  it("parses CREATE POLICY with every clause, and with none", () => {
    expect(
      firstStmt(
        "CREATE POLICY own_rows ON app.docs AS RESTRICTIVE FOR UPDATE TO app_user, CURRENT_USER, public " +
          "USING (owner = current_user) WITH CHECK (owner = current_user);",
      ),
    ).toEqual({
      kind: "createPolicy",
      name: "own_rows",
      table: ["app", "docs"],
      as: "restrictive",
      command: "update",
      roles: ["app_user", "current_user", "public"],
      using: exprOf("owner = current_user"),
      withCheck: exprOf("owner = current_user"),
    });
    expect(firstStmt("CREATE POLICY p ON t;")).toEqual({ kind: "createPolicy", name: "p", table: ["t"] });
    expect(firstStmt("CREATE POLICY p ON t AS PERMISSIVE FOR ALL;")).toEqual({
      kind: "createPolicy",
      name: "p",
      table: ["t"],
      as: "permissive",
      command: "all",
    });
    // PG compares AS's identifier by its text, so a quoted one counts.
    expect(firstStmt('CREATE POLICY p ON t AS "permissive";')).toMatchObject({ as: "permissive" });
    for (const command of ["select", "insert", "delete"]) {
      expect(firstStmt(`CREATE POLICY p ON t FOR ${command.toUpperCase()} USING (true);`)).toMatchObject({ command });
    }
    expect(firstStmt("CREATE POLICY p ON t WITH CHECK (a > 0);")).toEqual({
      kind: "createPolicy",
      name: "p",
      table: ["t"],
      withCheck: exprOf("a > 0"),
    });
  });

  it("parses ALTER POLICY's clauses and RENAME TO, and DROP POLICY", () => {
    expect(firstStmt("ALTER POLICY p ON s.t TO a, b USING (x) WITH CHECK (y);")).toEqual({
      kind: "alterPolicy",
      name: "p",
      table: ["s", "t"],
      roles: ["a", "b"],
      using: name("x"),
      withCheck: name("y"),
    });
    expect(firstStmt("ALTER POLICY p ON t WITH CHECK (y);")).toEqual({
      kind: "alterPolicy",
      name: "p",
      table: ["t"],
      withCheck: name("y"),
    });
    // PG's grammar takes every clause as optional.
    expect(firstStmt("ALTER POLICY p ON t;")).toEqual({ kind: "alterPolicy", name: "p", table: ["t"] });
    expect(firstStmt("ALTER POLICY p ON t RENAME TO q;")).toEqual({
      kind: "alterObject",
      object: { objectType: "policy", name: ["p"], table: ["t"] },
      action: { kind: "rename", to: "q" },
    });
    expect(firstStmt("ALTER POLICY IF EXISTS p ON t RENAME TO q;")).toEqual({
      kind: "alterObject",
      ifExists: true,
      object: { objectType: "policy", name: ["p"], table: ["t"] },
      action: { kind: "rename", to: "q" },
    });
    expect(firstStmt("DROP POLICY IF EXISTS p ON s.t CASCADE;")).toEqual({
      kind: "drop",
      objectType: "policy",
      concurrently: false,
      ifExists: true,
      names: [["p"]],
      behavior: "cascade",
      table: ["s", "t"],
    });
    expect(firstStmt("DROP POLICY p ON t;")).toMatchObject({ ifExists: false, behavior: null, table: ["t"] });
  });

  it("parses CREATE PUBLICATION's object lists and options", () => {
    expect(firstStmt("CREATE PUBLICATION p;")).toEqual({ kind: "createPublication", name: "p" });
    expect(
      firstStmt("CREATE PUBLICATION p FOR ALL TABLES WITH (publish = 'insert', publish_via_partition_root);"),
    ).toEqual({
      kind: "createPublication",
      name: "p",
      allTables: true,
      options: [opt("publish", str("insert")), opt("publish_via_partition_root", null)],
    });
    expect(
      firstStmt(
        "CREATE PUBLICATION p FOR TABLE ONLY s.a (id, email) WHERE (id > 0), b *, TABLES IN SCHEMA s, CURRENT_SCHEMA, TABLE c;",
      ),
    ).toEqual({
      kind: "createPublication",
      name: "p",
      objects: [
        { kind: "table", name: ["s", "a"], only: true, columns: ["id", "email"], where: exprOf("id > 0") },
        { kind: "table", name: ["b"] },
        { kind: "tablesInSchema", schema: "s" },
        { kind: "tablesInSchema", schema: null },
        { kind: "table", name: ["c"] },
      ],
    });
    // `tables` is a table's name unless IN follows it.
    expect(firstStmt("CREATE PUBLICATION p FOR TABLE a, tables;").objects).toEqual([
      { kind: "table", name: ["a"] },
      { kind: "table", name: ["tables"] },
    ]);
    expect(firstStmt("CREATE PUBLICATION p FOR TABLE ONLY (a);").objects).toEqual([
      { kind: "table", name: ["a"], only: true },
    ]);
    // An entry with no lead words may still say ONLY; `tables` is a schema's
    // name when it continues a schema list.
    expect(firstStmt("CREATE PUBLICATION p FOR TABLE a, ONLY b, ONLY (c);").objects).toEqual([
      { kind: "table", name: ["a"] },
      { kind: "table", name: ["b"], only: true },
      { kind: "table", name: ["c"], only: true },
    ]);
    expect(firstStmt("CREATE PUBLICATION p FOR TABLES IN SCHEMA s, tables;").objects).toEqual([
      { kind: "tablesInSchema", schema: "s" },
      { kind: "tablesInSchema", schema: "tables" },
    ]);
    // Quoted lead words are names.
    expect(firstStmt('CREATE PUBLICATION p FOR TABLE a, "table", "tables";').objects).toEqual([
      { kind: "table", name: ["a"] },
      { kind: "table", name: ["table"] },
      { kind: "table", name: ["tables"] },
    ]);
    expect(firstStmt('CREATE PUBLICATION p FOR TABLES IN SCHEMA "current_schema";').objects).toEqual([
      { kind: "tablesInSchema", schema: "current_schema" },
    ]);
  });

  it("parses ALTER PUBLICATION's actions, RENAME TO and OWNER TO", () => {
    const alter = (action: unknown) => ({ kind: "alterPublication", name: "p", action });
    expect(firstStmt("ALTER PUBLICATION p ADD TABLE ONLY app.customers (id, email) WHERE ((id > 0));")).toEqual(
      alter({
        kind: "add",
        objects: [
          {
            kind: "table",
            name: ["app", "customers"],
            only: true,
            columns: ["id", "email"],
            where: exprOf("(id > 0)"),
          },
        ],
      }),
    );
    expect(firstStmt("ALTER PUBLICATION p SET TABLES IN SCHEMA a, b;")).toEqual(
      alter({
        kind: "set",
        objects: [
          { kind: "tablesInSchema", schema: "a" },
          { kind: "tablesInSchema", schema: "b" },
        ],
      }),
    );
    expect(firstStmt("ALTER PUBLICATION p DROP TABLE t, u;")).toEqual(
      alter({
        kind: "drop",
        objects: [
          { kind: "table", name: ["t"] },
          { kind: "table", name: ["u"] },
        ],
      }),
    );
    expect(firstStmt("ALTER PUBLICATION p SET TABLE t (a);")).toEqual(
      alter({ kind: "set", objects: [{ kind: "table", name: ["t"], columns: ["a"] }] }),
    );
    expect(firstStmt("ALTER PUBLICATION p DROP TABLES IN SCHEMA CURRENT_SCHEMA;")).toEqual(
      alter({ kind: "drop", objects: [{ kind: "tablesInSchema", schema: null }] }),
    );
    expect(firstStmt("ALTER PUBLICATION p SET (publish = 'insert, update');")).toEqual(
      alter({ kind: "setOptions", options: [opt("publish", str("insert, update"))] }),
    );
    expect(firstStmt("ALTER PUBLICATION p RENAME TO q;")).toEqual({
      kind: "alterObject",
      object: { objectType: "publication", name: ["p"] },
      action: { kind: "rename", to: "q" },
    });
    expect(firstStmt("ALTER PUBLICATION p OWNER TO app_owner;")).toEqual({
      kind: "alterObject",
      object: { objectType: "publication", name: ["p"] },
      action: { kind: "ownerTo", owner: "app_owner" },
    });
  });

  it("parses CREATE and ALTER SUBSCRIPTION", () => {
    expect(
      firstStmt("CREATE SUBSCRIPTION s CONNECTION 'host=primary dbname=app' PUBLICATION a, b WITH (enabled = false);"),
    ).toEqual({
      kind: "createSubscription",
      name: "s",
      connection: "host=primary dbname=app",
      publications: ["a", "b"],
      options: [opt("enabled", { kind: "bool", value: false })],
    });
    expect(firstStmt("CREATE SUBSCRIPTION s CONNECTION $$host=a$$ PUBLICATION a;")).toMatchObject({
      connection: "host=a",
    });
    expect(firstStmt("CREATE SUBSCRIPTION s CONNECTION E'host=\\x61' PUBLICATION a;")).toMatchObject({
      connection: "host=a",
    });
    expect(firstStmt("CREATE SUBSCRIPTION s CONNECTION '' PUBLICATION a;")).toEqual({
      kind: "createSubscription",
      name: "s",
      connection: "",
      publications: ["a"],
    });
    const alter = (sql: string) => (firstStmt(`ALTER SUBSCRIPTION s ${sql};`) as any).action;
    expect(firstStmt("ALTER SUBSCRIPTION s ENABLE;")).toEqual({
      kind: "alterSubscription",
      name: "s",
      action: { kind: "enable" },
    });
    expect(alter("DISABLE")).toEqual({ kind: "disable" });
    expect(alter("CONNECTION 'host=b'")).toEqual({ kind: "connection", connection: "host=b" });
    expect(alter("SET PUBLICATION a, b WITH (refresh = false)")).toEqual({
      kind: "setPublication",
      publications: ["a", "b"],
      options: [opt("refresh", { kind: "bool", value: false })],
    });
    expect(alter("ADD PUBLICATION a")).toEqual({ kind: "addPublication", publications: ["a"] });
    expect(alter("ADD PUBLICATION a WITH (refresh = true)")).toEqual({
      kind: "addPublication",
      publications: ["a"],
      options: [opt("refresh", { kind: "bool", value: true })],
    });
    expect(alter("SET PUBLICATION a")).toEqual({ kind: "setPublication", publications: ["a"] });
    expect(alter("DROP PUBLICATION a, b")).toEqual({ kind: "dropPublication", publications: ["a", "b"] });
    expect(alter("REFRESH PUBLICATION")).toEqual({ kind: "refreshPublication" });
    expect(alter("REFRESH PUBLICATION WITH (copy_data = false)")).toEqual({
      kind: "refreshPublication",
      options: [opt("copy_data", { kind: "bool", value: false })],
    });
    expect(alter("SET (slot_name = NONE, synchronous_commit = off)")).toEqual({
      kind: "setOptions",
      options: [
        opt("slot_name", { kind: "name", parts: ["none"] }),
        opt("synchronous_commit", { kind: "name", parts: ["off"] }),
      ],
    });
    expect(alter("SKIP (lsn = '0/14C0378')")).toEqual({ kind: "skip", options: [opt("lsn", str("0/14C0378"))] });
    expect(firstStmt("ALTER SUBSCRIPTION s RENAME TO t;")).toEqual({
      kind: "alterObject",
      object: { objectType: "subscription", name: ["s"] },
      action: { kind: "rename", to: "t" },
    });
    expect(firstStmt("ALTER SUBSCRIPTION s OWNER TO SESSION_USER;")).toEqual({
      kind: "alterObject",
      object: { objectType: "subscription", name: ["s"] },
      action: { kind: "ownerTo", owner: "session_user" },
    });
  });

  it("parses DROP PUBLICATION and DROP SUBSCRIPTION", () => {
    expect(firstStmt("DROP SUBSCRIPTION s;")).toMatchObject({ ifExists: false, names: [["s"]], behavior: null });
    expect(firstStmt("DROP PUBLICATION IF EXISTS a, b RESTRICT;")).toEqual({
      kind: "drop",
      objectType: "publication",
      concurrently: false,
      ifExists: true,
      names: [["a"], ["b"]],
      behavior: "restrict",
    });
    expect(firstStmt("DROP SUBSCRIPTION IF EXISTS s CASCADE;")).toEqual({
      kind: "drop",
      objectType: "subscription",
      concurrently: false,
      ifExists: true,
      names: [["s"]],
      behavior: "cascade",
    });
  });

  it("still parses COMMENT ON, SECURITY LABEL and ALTER EXTENSION members for the three kinds", () => {
    expect(firstStmt("ALTER EXTENSION e ADD PUBLICATION p;")).toEqual({
      kind: "alterExtension",
      name: "e",
      action: { kind: "add", object: { objectType: "publication", name: ["p"] } },
    });
    expect(firstStmt("ALTER EXTENSION e DROP SUBSCRIPTION s;")).toEqual({
      kind: "alterExtension",
      name: "e",
      action: { kind: "drop", object: { objectType: "subscription", name: ["s"] } },
    });
    expect(firstStmt("COMMENT ON POLICY p ON s.t IS 'c';")).toEqual({
      kind: "comment",
      objectType: "policy",
      name: ["p"],
      table: ["s", "t"],
      comment: "c",
    });
    for (const kind of ["publication", "subscription"]) {
      expect(firstStmt(`COMMENT ON ${kind.toUpperCase()} x IS 'c';`)).toEqual({
        kind: "comment",
        objectType: kind,
        name: ["x"],
        comment: "c",
      });
      expect(firstStmt(`SECURITY LABEL ON ${kind.toUpperCase()} x IS 'l';`)).toMatchObject({ objectType: kind });
    }
  });

  it("rejects what PostgreSQL's grammar rejects", () => {
    expect(bad("CREATE POLICY p ON t AS OTHER;")).toThrow(/Expected "permissive" or "restrictive" but found "other"/);
    expect(bad("CREATE POLICY p ON t FOR TRUNCATE;")).toThrow(
      /Expected "all", "select", "insert", "update" or "delete" but found "truncate"/,
    );
    expect(bad("CREATE POLICY p ON t USING x;")).toThrow(/Expected "\(" but found "x"/);
    expect(bad("CREATE POLICY p ON t WITH (x);")).toThrow(/Expected "check" but found "\("/);
    // The clauses come in PG's fixed order.
    expect(bad("CREATE POLICY p ON t USING (x) TO r;")).toThrow(/Expected ";" but found "to"/);
    expect(bad("CREATE POLICY p ON t FOR ALL AS PERMISSIVE;")).toThrow(/Expected ";" but found "as"/);
    expect(bad("CREATE POLICY p;")).toThrow(/Expected "on" but found ";"/);
    expect(bad("ALTER POLICY p ON t AS RESTRICTIVE;")).toThrow(/Expected ";" but found "as"/);
    expect(bad("ALTER POLICY p ON t RENAME q;")).toThrow(/Expected "to" but found "q"/);
    expect(bad("ALTER POLICY IF EXISTS p ON t TO r;")).toThrow(/Expected "rename" but found "to"/);
    expect(bad("ALTER POLICY p ON t OWNER TO r;")).toThrow(/Expected ";" but found "owner"/);
    expect(bad("ALTER POLICY p ON t SET SCHEMA s;")).toThrow(/Expected ";" but found "set"/);
    expect(bad('CREATE POLICY p ON t AS "PERMISSIVE";')).toThrow(/Expected "permissive" or "restrictive"/);
    expect(bad('CREATE POLICY p ON t FOR "select";')).toThrow(/Expected "all", "select"/);
    expect(bad("DROP POLICY p;")).toThrow(/Expected "on" but found ";"/);
    // The first object must say TABLE or TABLES IN SCHEMA.
    expect(bad("CREATE PUBLICATION p FOR t;")).toThrow(/Expected "all", "table" or "tables" but found "t"/);
    expect(bad("CREATE PUBLICATION p FOR ALL t;")).toThrow(/Expected "tables" but found "t"/);
    expect(bad("CREATE PUBLICATION p FOR TABLES s;")).toThrow(/Expected "in" but found "s"/);
    expect(bad("CREATE PUBLICATION p FOR TABLE t WHERE id > 0;")).toThrow(/Expected "\(" but found "id"/);
    expect(bad("CREATE PUBLICATION p FOR TABLE CURRENT_SCHEMA;")).toThrow(/Expected a name but found "current_schema"/);
    expect(bad("CREATE PUBLICATION p FOR TABLE t ();")).toThrow(/Expected a name but found "\)" \(1:34\)/);
    expect(bad("ALTER PUBLICATION p ADD TABLE t ();")).toThrow(/Expected a name but found "\)"/);
    expect(bad("CREATE PUBLICATION p FOR ALL TABLES, TABLE t;")).toThrow(/Expected ";" but found ","/);
    expect(bad("CREATE PUBLICATION p FOR TABLE ONLY current_schema;")).toThrow(/found "current_schema" \(1:36\)/);
    expect(bad("CREATE PUBLICATION p FOR TABLE a, ONLY (current_schema);")).toThrow(/found "current_schema"/);
    expect(bad("CREATE PUBLICATION p FOR TABLES IN SCHEMA s WHERE (x);")).toThrow(/Expected ";" but found "where"/);
    expect(bad("CREATE PUBLICATION p FOR TABLE a, CURRENT_SCHEMA;")).toThrow(
      /Expected a name but found "current_schema"/,
    );
    // A schema takes no column list, no WHERE and no qualifier.
    expect(bad("CREATE PUBLICATION p FOR TABLES IN SCHEMA s (a);")).toThrow(/Expected ";" but found "\("/);
    expect(bad("CREATE PUBLICATION p FOR TABLES IN SCHEMA s, x.y;")).toThrow(/Expected ";" but found "\."/);
    expect(bad("ALTER PUBLICATION p ADD t;")).toThrow(/Expected "table" or "tables" but found "t"/);
    expect(bad("ALTER PUBLICATION p SET t;")).toThrow(/Expected "\(", "table" or "tables" but found "t"/);
    expect(bad("ALTER PUBLICATION p ENABLE;")).toThrow(
      /Expected "add", "set", "drop", "rename" or "owner" but found "enable"/,
    );
    expect(bad("ALTER PUBLICATION p SET SCHEMA s;")).toThrow(/Expected "\(", "table" or "tables" but found "schema"/);
    expect(bad("CREATE SUBSCRIPTION s PUBLICATION a;")).toThrow(/Expected "connection" but found "publication"/);
    expect(bad("CREATE SUBSCRIPTION s CONNECTION conn PUBLICATION a;")).toThrow(/Expected a string but found "conn"/);
    expect(bad("CREATE SUBSCRIPTION s CONNECTION 'c';")).toThrow(/Expected "publication" but found ";"/);
    expect(bad("ALTER SUBSCRIPTION s SET a;")).toThrow(/Expected "\(" or "publication" but found "a"/);
    expect(bad("ALTER SUBSCRIPTION s ADD a;")).toThrow(/Expected "publication" but found "a"/);
    expect(bad("ALTER SUBSCRIPTION s REFRESH;")).toThrow(/Expected "publication" but found ";"/);
    expect(bad("ALTER SUBSCRIPTION s SKIP lsn;")).toThrow(/Expected "\(" but found "lsn"/);
    expect(bad("ALTER SUBSCRIPTION s SET SCHEMA x;")).toThrow(/Expected "\(" or "publication" but found "schema"/);
    expect(bad("ALTER SUBSCRIPTION s;")).toThrow(/Expected "connection", "set", [^\n]*"owner" but found ";"/);
    expect(bad("DROP SUBSCRIPTION a, b;")).toThrow(/Expected ";" but found ","/);
  });

  it("keeps the policy, publication and subscription words unreserved as names and aliases", () => {
    const words = [
      "policy permissive restrictive publication subscription connection refresh skip enable disable tables",
      "current_schema",
    ]
      .join(" ")
      .split(" ");
    expect(firstStmt(`SELECT ${words.join(", ")} FROM t;`).columns.map((c: any) => c.expr)).toEqual(
      words.map((word) => name(word)),
    );
    expect(firstStmt("SELECT 1 AS policy, 2 publication FROM subscription AS refresh;")).toMatchObject({
      columns: [{ alias: "policy" }, { alias: "publication" }],
      from: [{ name: ["subscription"], alias: "refresh" }],
    });
    expect(firstStmt("CREATE TABLE policy (permissive int, restrictive int, skip int, tables int);")).toMatchObject({
      name: ["policy"],
    });
    // …and as the names of the objects themselves.
    expect(firstStmt("CREATE POLICY policy ON restrictive TO permissive;")).toMatchObject({
      name: "policy",
      table: ["restrictive"],
      roles: ["permissive"],
    });
    expect(firstStmt("CREATE PUBLICATION publication FOR TABLE subscription, tables;")).toMatchObject({
      name: "publication",
      objects: [{ name: ["subscription"] }, { name: ["tables"] }],
    });
    expect(firstStmt("CREATE SUBSCRIPTION connection CONNECTION 'c' PUBLICATION publication, refresh;")).toMatchObject({
      name: "connection",
      publications: ["publication", "refresh"],
    });
    expect(firstStmt("ALTER SUBSCRIPTION enable DISABLE;")).toMatchObject({ name: "enable" });
    // A policy called `if` is no IF EXISTS.
    expect(firstStmt("ALTER POLICY if ON t RENAME TO x;")).toMatchObject({ object: { name: ["if"] } });
    expect(firstStmt("ALTER POLICY if ON t TO r;")).toMatchObject({ name: "if", roles: ["r"] });
    expect(firstStmt("DROP POLICY if ON t;")).toMatchObject({ ifExists: false, names: [["if"]] });
    expect(firstStmt("DROP PUBLICATION skip;")).toMatchObject({ names: [["skip"]] });
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
    // …and only in INSERT's own bare VALUES rows (and SET's right-hand side).
    // A VALUES query rejects it as PG does; a parenthesised VALUES source is a
    // limit of this grammar, which PG would accept.
    expect(() => sqlLite.parse("SELECT * FROM (VALUES (DEFAULT)) v;")).toThrow(/Expected a name but found "default"/);
    expect(() => sqlLite.parse("INSERT INTO t (VALUES (DEFAULT));")).toThrow(/Expected a name but found "default"/);
    // The alias needs its AS, and AS needs a name.
    expect(parse("t x VALUES (1)")).toThrow(/found "x" \(1:14\)/);
    // An empty quoted alias is no name at all: PG's scanner rejects `""`.
    expect(parse('t AS "" VALUES (1)')).toThrow(/Zero-length delimited identifier/);
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
      /Expected a SELECT, VALUES, INSERT, UPDATE, DELETE or MERGE statement but found "create" \(1:13\)/,
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

// --- column and domain DEFAULT as a b-expression ---

describe("SQL-lite column and domain DEFAULT as a b-expression", () => {
  const colConstraints = (type: string, src: string) =>
    (firstStmt(`CREATE TABLE t (c ${type} ${src});`) as any).items[0].constraints as Record<string, unknown>[];
  const domainConstraints = (src: string) =>
    (firstStmt(`CREATE DOMAIN d AS int ${src};`) as any).constraints as Record<string, unknown>[];
  const bad = (src: string) => () => sqlLite.parse(`CREATE TABLE t (c int ${src});`);
  const NOT_NULL = { kind: "notNull" };
  const typ = (n: string, over: Record<string, unknown> = {}) => ({ name: n, args: [], array: false, ...over });

  it("ends the default before NOT NULL, as pg_dump writes it", () => {
    expect(colConstraints("integer", "DEFAULT nextval('public.t_id_seq'::regclass) NOT NULL")).toEqual([
      {
        kind: "default",
        expr: {
          kind: "call",
          name: "nextval",
          args: [{ kind: "cast", expr: str("public.t_id_seq"), type: typ("regclass") }],
        },
      },
      NOT_NULL,
    ]);
    expect(colConstraints("int", "DEFAULT 0 NOT NULL")).toEqual([{ kind: "default", expr: num(0) }, NOT_NULL]);
    expect(colConstraints("int", "DEFAULT -1 NOT NULL")).toEqual([
      { kind: "default", expr: { kind: "unary", op: "-", operand: num(1) } },
      NOT_NULL,
    ]);
    expect(colConstraints("int[]", "DEFAULT ARRAY[]::integer[] NOT NULL")).toEqual([
      {
        kind: "default",
        expr: { kind: "cast", expr: { kind: "array", elements: [] }, type: typ("integer", { array: true }) },
      },
      NOT_NULL,
    ]);
    expect(colConstraints("text", "DEFAULT 'a'::text || 'b' NOT NULL")).toEqual([
      { kind: "default", expr: bin("||", { kind: "cast", expr: str("a"), type: typ("text") }, str("b")) },
      NOT_NULL,
    ]);
    // The span of the DEFAULT constraint stops at its operand.
    const [stmt] = sqlLite.parse("CREATE TABLE t (c int DEFAULT 0 NOT NULL);") as any[];
    expect(stmt.items[0].constraints[0].span).toEqual({ start: { row: 1, col: 22 }, end: { row: 1, col: 31 } });
  });

  it("takes comparisons, IS [NOT] DISTINCT FROM and casts, as PG's b_expr does", () => {
    expect(colConstraints("boolean", "DEFAULT 1 + 1 = 2 NOT NULL")).toEqual([
      { kind: "default", expr: bin("=", bin("+", num(1), num(1)), num(2)) },
      NOT_NULL,
    ]);
    expect(colConstraints("boolean", "DEFAULT a IS NOT DISTINCT FROM b NOT NULL")).toEqual([
      { kind: "default", expr: { kind: "isDistinct", expr: name("a"), from: name("b"), negated: true } },
      NOT_NULL,
    ]);
    expect(colConstraints("boolean", "DEFAULT a IS DISTINCT FROM b = c")).toEqual([
      {
        kind: "default",
        expr: { kind: "isDistinct", expr: name("a"), from: bin("=", name("b"), name("c")), negated: false },
      },
    ]);
    expect(colConstraints("text", "DEFAULT (a + 1)::text CHECK (c <> '')")).toEqual([
      { kind: "default", expr: { kind: "cast", expr: bin("+", name("a"), num(1)), type: typ("text") } },
      { kind: "check", expr: bin("<>", name("c"), str("")) },
    ]);
  });

  it("takes any expression inside parentheses", () => {
    expect(colConstraints("text", `DEFAULT ('x' COLLATE "C")`)).toEqual([
      { kind: "default", expr: { kind: "collate", expr: str("x"), collation: ["C"] } },
    ]);
    expect(colConstraints("timestamp", "DEFAULT (now() AT TIME ZONE 'utc') NOT NULL")).toEqual([
      {
        kind: "default",
        expr: { kind: "atTimeZone", expr: { kind: "call", name: "now", args: [] }, zone: str("utc") },
      },
      NOT_NULL,
    ]);
  });

  it("applies to domains, where a COLLATE after the default is the domain's", () => {
    expect(domainConstraints("DEFAULT 0 NOT NULL CHECK (VALUE >= 0)")).toEqual([
      { kind: "default", expr: num(0) },
      { kind: "notNull", name: null },
      { kind: "check", name: null, expr: bin(">=", name("value"), num(0)) },
    ]);
    expect(domainConstraints(`DEFAULT 'x' COLLATE "C"`)).toEqual([
      { kind: "default", expr: str("x") },
      { kind: "collate", collation: ["C"] },
    ]);
  });

  it("leaves SET DEFAULT and argument defaults a full expression", () => {
    // PG's ALTER COLUMN / ALTER DOMAIN SET DEFAULT and a routine argument's
    // DEFAULT take a_expr, unlike the column and domain constraint.
    expect(firstStmt("ALTER TABLE t ALTER c SET DEFAULT now() AT TIME ZONE 'utc';").actions[0]).toMatchObject({
      kind: "setDefault",
      expr: { kind: "atTimeZone" },
    });
    expect(firstStmt("ALTER DOMAIN d SET DEFAULT 5 IS NULL;")).toMatchObject({
      action: { kind: "setDefault", expr: { kind: "is" } },
    });
    expect(
      firstStmt("CREATE FUNCTION f(a boolean DEFAULT 1 IS NULL) RETURNS int LANGUAGE sql AS 'SELECT 1';").args[0],
    ).toMatchObject({ defaultValue: { kind: "is" } });
  });

  it("reads POSITION's first operand as the same b-expression", () => {
    expect(exprOf("POSITION(a = b IN c)")).toEqual({
      kind: "position",
      substring: bin("=", name("a"), name("b")),
      string: name("c"),
    });
  });

  it("rejects what PG's DEFAULT b_expr rejects", () => {
    expect(bad("DEFAULT 5 IS NULL")).toThrow(/Expected "distinct from" but found "null" \(1:35\)/);
    expect(() => sqlLite.parse("CREATE DOMAIN d AS int DEFAULT 5 IS NULL;")).toThrow(
      /Expected "distinct from" but found "null"/,
    );
    expect(bad("DEFAULT now() AT TIME ZONE 'utc'")).toThrow(/but found "at" \(1:36\)/);
    expect(bad("DEFAULT NOT true")).toThrow(/but found "not" \(1:30\)/);
    expect(bad("DEFAULT a AND b")).toThrow(/but found "and"/);
    expect(bad("DEFAULT a LIKE 'x'")).toThrow(/but found "like"/);
    expect(bad("DEFAULT a IN (1)")).toThrow(/but found "in"/);
    expect(bad("DEFAULT a BETWEEN 1 AND 2")).toThrow(/but found "between"/);
    expect(bad("DEFAULT a = ANY (b)")).toThrow(/but found "any"/);
    expect(bad("DEFAULT 1 < 2 < 3")).toThrow(/Operator "<" is non-associative/);
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
    // After a DEFAULT too: its operand has no COLLATE, so the clause is the column's.
    expect(colConstraints(`DEFAULT 'a' COLLATE "C"`)).toEqual([
      { kind: "default", expr: str("a") },
      { kind: "collate", collation: ["C"] },
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
    expect(bad("GENERATED ALWAYS AS (a)")).toThrow(expectsKeys(["stored"], '")"'));
    expect(bad("GENERATED SOMETIMES AS IDENTITY")).toThrow(
      /Expected "always" or "by default" but found "sometimes" \(1:32\)/,
    );
    // A malformed clause is a plain syntax error first, as in PG.
    expect(bad("GENERATED BY DEFAULT AS (a)")).toThrow(expectsKeys(["stored"], '")"'));
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
      expectsKeys(["table", "unique", "index", "sequence", "view", "trigger"], '"frobnicate" (1:23)'),
    );
    expect(bad("CREATE SCHEMA s CREATE SCHEMA t CREATE TABLE u (a int);")).toThrow(
      expectsKeys(["table", "trigger", "recursive"], '"schema"'),
    );
    expect(bad("CREATE SCHEMA s CREATE DATABASE d;")).toThrow(
      expectsKeys(["table", "trigger", "recursive"], '"database"'),
    );
    expect(bad("CREATE SCHEMA s CREATE OR REPLACE TABLE t (a int);")).toThrow(
      /Expected "view", "trigger", "recursive", "temp", "temporary", "local" or "global" but found "table" \(1:34\)/,
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

// --- EXPLAIN, ANALYZE and VACUUM ---

describe("SQL-lite EXPLAIN, ANALYZE and VACUUM", () => {
  const opt = (optName: string, value: unknown = null) => ({ name: optName, value });
  const word = (w: string) => ({ kind: "name", parts: [w] });
  const bool = (value: boolean) => ({ kind: "bool", value });
  const target = (tableName: string[], columns: string[] | null = null) => ({ name: tableName, columns });
  const explained = (src: string) => firstStmt(`EXPLAIN ${src};`).statement;
  const bad = (src: string) => () => sqlLite.parse(src);

  it("parses EXPLAIN with no options, the legacy flags and the option list", () => {
    expect(firstStmt("EXPLAIN SELECT 1;")).toEqual({
      kind: "explain",
      options: [],
      statement: sel({ columns: [col(num(1))] }),
    });
    expect(firstStmt("EXPLAIN ANALYZE VERBOSE SELECT 1;").options).toEqual([opt("analyze"), opt("verbose")]);
    expect(firstStmt("EXPLAIN ANALYSE SELECT 1;").options).toEqual([opt("analyse")]);
    expect(firstStmt("EXPLAIN VERBOSE SELECT 1;").options).toEqual([opt("verbose")]);
    expect(
      firstStmt(
        "EXPLAIN (ANALYZE, VERBOSE false, COSTS off, SETTINGS on, BUFFERS true, WAL 1, TIMING, SUMMARY 'on', FORMAT JSON) SELECT 1;",
      ).options,
    ).toEqual([
      opt("analyze"),
      opt("verbose", bool(false)),
      opt("costs", word("off")),
      opt("settings", word("on")),
      opt("buffers", bool(true)),
      opt("wal", num(1)),
      opt("timing"),
      opt("summary", str("on")),
      opt("format", word("json")),
    ]);
    // A legacy flag spans its own word.
    const [stmt] = sqlLite.parse("EXPLAIN  VERBOSE SELECT 1;") as any[];
    expect(stmt.options[0].span).toEqual({ start: { row: 1, col: 9 }, end: { row: 1, col: 16 } });
  });

  it("explains a query, DML, CREATE TABLE AS, CREATE MATERIALIZED VIEW, DECLARE or EXECUTE", () => {
    expect(explained("VALUES (1)").kind).toBe("values");
    expect(explained("WITH x AS (SELECT 1) SELECT * FROM x")).toMatchObject({ kind: "select", with_: [{ name: "x" }] });
    expect(explained("INSERT INTO t VALUES (1)")).toMatchObject({ kind: "insert", table: ["t"] });
    expect(explained("UPDATE t SET a = 1")).toMatchObject({ kind: "update", table: ["t"] });
    expect(explained("DELETE FROM t")).toMatchObject({ kind: "delete", table: ["t"] });
    expect(explained("CREATE TABLE t (a) AS SELECT 1")).toMatchObject({ kind: "createTableAs", columns: ["a"] });
    expect(explained("CREATE MATERIALIZED VIEW mv AS SELECT 1")).toMatchObject({
      kind: "createView",
      materialized: true,
    });
    expect(explained("DECLARE c SCROLL CURSOR FOR SELECT 1")).toMatchObject({
      kind: "declare",
      name: "c",
      scroll: true,
    });
    expect(explained("EXECUTE p (1)")).toEqual({ kind: "execute", name: "p", args: [num(1)] });
    // A `(` opening a query is the query, not an option list.
    expect(firstStmt("EXPLAIN (SELECT 1);")).toMatchObject({ options: [], statement: { kind: "select" } });
    expect(firstStmt("EXPLAIN ((SELECT 1) UNION SELECT 2);").statement).toMatchObject({ kind: "setOp" });
    expect(firstStmt("EXPLAIN (VALUES (1));").statement.kind).toBe("values");
    expect(firstStmt("EXPLAIN (ANALYZE) (SELECT 1);")).toMatchObject({ options: [opt("analyze")] });
  });

  it("parses ANALYZE and VACUUM with and without targets", () => {
    expect(firstStmt("ANALYZE;")).toEqual({ kind: "analyze", options: [], tables: [] });
    expect(firstStmt("ANALYSE VERBOSE t (a, b), s.u;")).toEqual({
      kind: "analyze",
      options: [opt("verbose")],
      tables: [target(["t"], ["a", "b"]), target(["s", "u"])],
    });
    expect(firstStmt("ANALYZE (VERBOSE, SKIP_LOCKED true) t;")).toEqual({
      kind: "analyze",
      options: [opt("verbose"), opt("skip_locked", bool(true))],
      tables: [target(["t"])],
    });
    expect(firstStmt("VACUUM;")).toEqual({ kind: "vacuum", options: [], tables: [] });
    expect(firstStmt("VACUUM FULL FREEZE VERBOSE ANALYZE t (a);")).toEqual({
      kind: "vacuum",
      options: [opt("full"), opt("freeze"), opt("verbose"), opt("analyze")],
      tables: [target(["t"], ["a"])],
    });
    expect(firstStmt("VACUUM FREEZE ANALYSE;").options).toEqual([opt("freeze"), opt("analyse")]);
    expect(firstStmt("VACUUM (FULL, PARALLEL 4, INDEX_CLEANUP auto) a, b;")).toEqual({
      kind: "vacuum",
      options: [opt("full"), opt("parallel", num(4)), opt("index_cleanup", word("auto"))],
      tables: [target(["a"]), target(["b"])],
    });
  });

  // `analyze`, `analyse` and `full` were reserved already; the option names
  // (`costs`, `format`, …) are read by relationOptions, which matches none by value.
  it("keeps the new words unreserved", () => {
    const words = ["explain", "vacuum", "verbose", "freeze"];
    expect(firstStmt(`SELECT ${words.join(", ")} FROM explain;`)).toEqual(
      sel({ columns: words.map((w) => col(name(w))), from: [tableFrom(["explain"])] }),
    );
    const cols = words.map((w) => `${w} text`).join(", ");
    expect(firstStmt(`CREATE TABLE vacuum (${cols});`).items.map((i: any) => i.name)).toEqual(words);
    // …and as the targets these statements take, past any flag.
    expect(firstStmt("VACUUM VERBOSE explain (vacuum, freeze);").tables).toEqual([
      target(["explain"], ["vacuum", "freeze"]),
    ]);
    expect(firstStmt("ANALYZE vacuum;").tables).toEqual([target(["vacuum"])]);
    // A flag word is a target when quoted, or past the first target.
    expect(firstStmt('VACUUM VERBOSE "freeze", verbose;').tables).toEqual([target(["freeze"]), target(["verbose"])]);
  });

  it("rejects malformed EXPLAIN, ANALYZE and VACUUM", () => {
    expect(bad("EXPLAIN;")).toThrow(
      /Expected a SELECT, VALUES, INSERT, UPDATE, DELETE, MERGE, CREATE TABLE AS, CREATE MATERIALIZED VIEW, DECLARE or EXECUTE/,
    );
    expect(bad("EXPLAIN DROP TABLE t;")).toThrow(/or EXECUTE statement but found "drop" \(1:8\)/);
    expect(bad("EXPLAIN EXPLAIN SELECT 1;")).toThrow(/statement but found "explain"/);
    expect(bad("EXPLAIN CREATE TABLE t (a int);")).toThrow(
      /EXPLAIN takes CREATE TABLE AS or CREATE MATERIALIZED VIEW but no other CREATE \(1:8\)/,
    );
    expect(bad("EXPLAIN CREATE VIEW v AS SELECT 1;")).toThrow(/but no other CREATE \(1:8\)/);
    // The flags come in PG's order, and either form excludes the other.
    expect(bad("EXPLAIN VERBOSE ANALYZE SELECT 1;")).toThrow(/statement but found "analyze"/);
    expect(bad("EXPLAIN (ANALYZE) VERBOSE SELECT 1;")).toThrow(/statement but found "verbose"/);
    expect(bad("EXPLAIN () SELECT 1;")).toThrow(/Expected an option name but found "\)"/);
    expect(bad("EXPLAIN (ANALYZE SELECT 1;")).toThrow(/Expected "\)" but found "1"/);
    expect(bad("VACUUM ANALYZE FULL t;")).toThrow(/Expected a name but found "full"/);
    expect(bad("VACUUM 1;")).toThrow(/Expected a name but found "1" \(1:7\)/);
    expect(bad("VACUUM t,;")).toThrow(/Expected a name but found ";"/);
    expect(bad("ANALYZE t ();")).toThrow(/Expected a name but found "\)"/);
    expect(bad("ANALYZE FULL t;")).toThrow(/Expected a name but found "full"/);
    // A flag out of order, or repeated, is not taken for a table name.
    expect(bad("VACUUM VERBOSE FREEZE;")).toThrow(/Expected a name but found "freeze" \(1:15\)/);
    expect(bad("VACUUM ANALYZE VERBOSE t;")).toThrow(/Expected a name but found "verbose"/);
    expect(bad("ANALYZE VERBOSE VERBOSE;")).toThrow(/Expected a name but found "verbose"/);
  });
});

// --- CHECKPOINT, CLUSTER and REINDEX ---

describe("SQL-lite CHECKPOINT, CLUSTER and REINDEX", () => {
  const verbose = { name: "verbose", value: null };
  const bad = (src: string) => () => sqlLite.parse(src);

  it("parses CHECKPOINT", () => {
    expect(firstStmt("CHECKPOINT;")).toEqual({ kind: "checkpoint" });
    expect(bad("CHECKPOINT now;")).toThrow(/Expected ";" but found "now"/);
  });

  it("parses CLUSTER with and without a table, index and options", () => {
    expect(firstStmt("CLUSTER;")).toEqual({ kind: "cluster", options: [] });
    expect(firstStmt("CLUSTER VERBOSE;")).toEqual({ kind: "cluster", options: [verbose] });
    expect(firstStmt("CLUSTER VERBOSE users;")).toEqual({ kind: "cluster", options: [verbose], table: ["users"] });
    expect(firstStmt("CLUSTER s.users USING users_pkey;")).toEqual({
      kind: "cluster",
      options: [],
      table: ["s", "users"],
      index: "users_pkey",
    });
    // The PG 17 option list, with or without a table.
    expect(firstStmt("CLUSTER (VERBOSE);")).toEqual({ kind: "cluster", options: [verbose] });
    expect(firstStmt("CLUSTER (VERBOSE) users USING users_pkey;")).toEqual({
      kind: "cluster",
      options: [verbose],
      table: ["users"],
      index: "users_pkey",
    });
    // The pre-8.3 `index ON table` form.
    expect(firstStmt("CLUSTER VERBOSE users_pkey ON s.users;")).toEqual({
      kind: "cluster",
      options: [verbose],
      table: ["s", "users"],
      index: "users_pkey",
    });
  });

  it("rejects malformed CLUSTER statements", () => {
    expect(bad("CLUSTER users USING;")).toThrow(/Expected a name but found ";"/);
    expect(bad("CLUSTER VERBOSE VERBOSE;")).toThrow(/Expected a name but found "verbose"/);
    expect(bad("CLUSTER (VERBOSE) verbose;")).toThrow(/Expected a name but found "verbose"/);
    expect(bad("CLUSTER VERBOSE concurrently;")).toThrow(/Expected a name but found "concurrently"/);
    expect(bad("CLUSTER users USING verbose;")).toThrow(/Expected a name but found "verbose"/);
    expect(bad("CLUSTER users_pkey ON verbose;")).toThrow(/Expected a name but found "verbose"/);
    // The old ON form takes neither the option list nor a qualified index.
    expect(bad("CLUSTER (VERBOSE) users_pkey ON users;")).toThrow(/Expected ";" but found "on"/);
    expect(bad("CLUSTER s.users_pkey ON users;")).toThrow(/Expected ";" but found "on"/);
    expect(bad("CLUSTER a, b;")).toThrow(/Expected ";" but found ","/);
  });

  it("parses REINDEX on every target, with options and CONCURRENTLY", () => {
    expect(firstStmt("REINDEX TABLE users;")).toEqual({
      kind: "reindex",
      options: [],
      target: "table",
      name: ["users"],
    });
    expect(firstStmt("REINDEX INDEX CONCURRENTLY s.users_email_idx;")).toEqual({
      kind: "reindex",
      options: [],
      target: "index",
      concurrently: true,
      name: ["s", "users_email_idx"],
    });
    expect(firstStmt("REINDEX (VERBOSE, TABLESPACE fast) SCHEMA public;")).toEqual({
      kind: "reindex",
      options: [verbose, { name: "tablespace", value: name("fast") }],
      target: "schema",
      name: ["public"],
    });
    expect(firstStmt("REINDEX (VERBOSE) DATABASE mydb;")).toEqual({
      kind: "reindex",
      options: [verbose],
      target: "database",
      name: ["mydb"],
    });
    // Quoted, a flag word is a name.
    expect(firstStmt('REINDEX INDEX CONCURRENTLY "concurrently";')).toMatchObject({ name: ["concurrently"] });
    // DATABASE and SYSTEM may leave the (current) database's name off.
    expect(firstStmt("REINDEX SYSTEM;")).toEqual({ kind: "reindex", options: [], target: "system" });
    expect(firstStmt("REINDEX DATABASE CONCURRENTLY;")).toEqual({
      kind: "reindex",
      options: [],
      target: "database",
      concurrently: true,
    });
  });

  it("rejects malformed REINDEX statements", () => {
    expect(bad("REINDEX users;")).toThrow(
      /Expected "index", "table", "schema", "database" or "system" but found "users"/,
    );
    expect(bad("REINDEX SCHEMA;")).toThrow(/Expected a name but found ";"/);
    expect(bad("REINDEX TABLE;")).toThrow(/Expected a name but found ";"/);
    expect(bad("REINDEX INDEX CONCURRENTLY;")).toThrow(/Expected a name but found ";"/);
    expect(bad("REINDEX TABLE CONCURRENTLY concurrently;")).toThrow(/Expected a name but found "concurrently"/);
    expect(bad("REINDEX DATABASE CONCURRENTLY concurrently;")).toThrow(/Expected a name but found "concurrently"/);
    expect(bad("REINDEX INDEX CONCURRENTLY verbose;")).toThrow(/Expected a name but found "verbose"/);
    expect(bad("REINDEX SCHEMA s.t;")).toThrow(/Expected ";" but found "."/);
    expect(bad("REINDEX DATABASE a b;")).toThrow(/Expected ";" but found "b"/);
  });

  it("keeps checkpoint, cluster, reindex and the target words unreserved as names and aliases", () => {
    for (const word of ["checkpoint", "cluster", "reindex", "system", "plans", "sequences"]) {
      expect(firstStmt(`SELECT ${word} FROM ${word};`)).toMatchObject({
        columns: [{ expr: name(word), alias: null }],
        from: [tableFrom([word])],
      });
      expect(firstStmt(`SELECT a ${word} FROM t;`).columns[0]).toEqual({ expr: name("a"), alias: word });
      expect(firstStmt(`CREATE TABLE t (${word} int);`).items[0]).toMatchObject({ name: word });
    }
    expect(firstStmt("CLUSTER cluster USING reindex;")).toMatchObject({ table: ["cluster"], index: "reindex" });
    expect(firstStmt("REINDEX TABLE reindex;")).toMatchObject({ name: ["reindex"] });
  });
});

// --- cursors: DECLARE, FETCH, MOVE and CLOSE ---

describe("SQL-lite cursors", () => {
  const declare = (over: Record<string, unknown>) => ({
    kind: "declare",
    name: "c",
    binary: false,
    sensitivity: null,
    scroll: null,
    hold: null,
    query: sel({ columns: [col(num(1))] }),
    ...over,
  });
  const directionOf = (src: string) => firstStmt(`FETCH ${src};`).direction;
  const bad = (src: string) => () => sqlLite.parse(src);

  it("parses a bare DECLARE … CURSOR FOR query", () => {
    expect(firstStmt("DECLARE c CURSOR FOR SELECT 1;")).toEqual(declare({}));
  });

  it("parses every cursor option, in any order, and WITH / WITHOUT HOLD", () => {
    expect(firstStmt("DECLARE c BINARY INSENSITIVE NO SCROLL CURSOR WITH HOLD FOR SELECT 1;")).toEqual(
      declare({ binary: true, sensitivity: "insensitive", scroll: false, hold: true }),
    );
    expect(firstStmt("DECLARE c SCROLL ASENSITIVE BINARY CURSOR WITHOUT HOLD FOR SELECT 1;")).toEqual(
      declare({ binary: true, sensitivity: "asensitive", scroll: true, hold: false }),
    );
    // A repeated option is accepted, as PG's grammar does.
    expect(firstStmt("DECLARE c SCROLL SCROLL BINARY BINARY CURSOR FOR SELECT 1;")).toEqual(
      declare({ binary: true, scroll: true }),
    );
  });

  it("takes a full query as the body, FETCH FIRST and a WITH prefix included", () => {
    expect(firstStmt("DECLARE c CURSOR FOR SELECT 1 FETCH FIRST 2 ROWS ONLY;").query).toEqual(
      sel({ columns: [col(num(1))], limit: num(2) }),
    );
    expect(firstStmt("DECLARE c CURSOR FOR VALUES (1);").query.kind).toBe("values");
    expect(firstStmt("DECLARE c CURSOR FOR (SELECT 1) UNION SELECT 2;").query).toMatchObject({ kind: "setOp" });
    expect(firstStmt("DECLARE c CURSOR FOR WITH x AS (SELECT 1) SELECT * FROM x;").query).toMatchObject({
      kind: "select",
      with_: [{ name: "x" }],
    });
    // The body owns no `;` of its own: the statement after it parses separately.
    expect(parse("DECLARE c CURSOR FOR SELECT 1; FETCH c; CLOSE c;").map((s) => s.kind)).toEqual([
      "declare",
      "fetch",
      "close",
    ]);
  });

  it("parses every FETCH direction, signed counts included", () => {
    expect(directionOf("c")).toBeNull();
    for (const word of ["next", "prior", "first", "last"])
      expect(directionOf(`${word} FROM c`)).toEqual({ kind: word });
    expect(directionOf("ALL IN c")).toEqual({ kind: "all" });
    expect(directionOf("ABSOLUTE -1 FROM c")).toEqual({ kind: "absolute", count: -1 });
    expect(directionOf("RELATIVE +2 c")).toEqual({ kind: "relative", count: 2 });
    expect(directionOf("5 FROM c")).toEqual({ kind: "count", count: 5 });
    expect(directionOf("-5 c")).toEqual({ kind: "count", count: -5 });
    expect(directionOf("FORWARD 5 FROM c")).toEqual({ kind: "forward", count: 5 });
    expect(directionOf("FORWARD FROM c")).toEqual({ kind: "forward", count: null });
    expect(directionOf("FORWARD c")).toEqual({ kind: "forward", count: null });
    expect(directionOf("BACKWARD ALL IN c")).toEqual({ kind: "backward", count: "all" });
    expect(directionOf("BACKWARD -3 c")).toEqual({ kind: "backward", count: -3 });
    // FROM / IN is optional and dropped.
    expect(firstStmt("FETCH IN c;")).toEqual({ kind: "fetch", direction: null, cursor: "c" });
  });

  it("reads a lone direction word as the cursor name", () => {
    expect(firstStmt("FETCH next;")).toEqual({ kind: "fetch", direction: null, cursor: "next" });
    expect(firstStmt("FETCH forward;")).toEqual({ kind: "fetch", direction: null, cursor: "forward" });
    expect(firstStmt("MOVE absolute;")).toEqual({ kind: "move", direction: null, cursor: "absolute" });
    expect(firstStmt("FETCH next next;")).toEqual({ kind: "fetch", direction: { kind: "next" }, cursor: "next" });
    expect(firstStmt("FETCH forward FROM forward;")).toEqual({
      kind: "fetch",
      direction: { kind: "forward", count: null },
      cursor: "forward",
    });
  });

  it("parses MOVE with the same directions, and CLOSE", () => {
    expect(firstStmt("MOVE c;")).toEqual({ kind: "move", direction: null, cursor: "c" });
    expect(firstStmt("MOVE LAST IN c;")).toEqual({ kind: "move", direction: { kind: "last" }, cursor: "c" });
    expect(firstStmt("MOVE BACKWARD 2 FROM c;")).toEqual({
      kind: "move",
      direction: { kind: "backward", count: 2 },
      cursor: "c",
    });
    expect(firstStmt("CLOSE c;")).toEqual({ kind: "close", name: "c" });
    expect(firstStmt('CLOSE "C";')).toEqual({ kind: "close", name: "C" });
    expect(firstStmt("CLOSE ALL;")).toEqual({ kind: "close", name: null });
    // A quoted word is always a name.
    expect(firstStmt('CLOSE "all";')).toEqual({ kind: "close", name: "all" });
  });

  it("leaves SELECT's FETCH FIRST / NEXT clause untouched", () => {
    expect(firstStmt("SELECT a FROM t FETCH FIRST 3 ROWS ONLY;")).toEqual(
      sel({ columns: [col(name("a"))], from: [tableFrom(["t"])], limit: num(3) }),
    );
    expect(firstStmt("SELECT a FROM t ORDER BY a OFFSET 1 ROWS FETCH NEXT ROW WITH TIES;").offset).toEqual(num(1));
  });

  it("keeps the cursor words unreserved", () => {
    const words = [
      "declare",
      "move",
      "close",
      "cursor",
      "scroll",
      "hold",
      "binary",
      "insensitive",
      "asensitive",
      "without",
      "prior",
      "next",
      "absolute",
      "relative",
      "forward",
      "backward",
    ];
    expect(firstStmt(`SELECT ${words.join(", ")} FROM cursor;`)).toEqual(
      sel({ columns: words.map((w) => col(name(w))), from: [tableFrom(["cursor"])] }),
    );
    expect(firstStmt(`CREATE TABLE close (${words.map((w) => `${w} int`).join(", ")});`).items.length).toBe(
      words.length,
    );
    // …and as the cursor names the statements take.
    expect(firstStmt("DECLARE scroll SCROLL CURSOR FOR SELECT 1;")).toMatchObject({ name: "scroll", scroll: true });
    expect(firstStmt("CLOSE cursor;")).toEqual({ kind: "close", name: "cursor" });
    // `fetch` was already reserved for SELECT's clause, as in PG, and stays so:
    // after an empty select list it opens that clause.
    expect(bad("SELECT fetch FROM t;")).toThrow(/Expected "first" or "next" but found "from"/);
  });

  it("rejects contradictory options, a non-query body and malformed directions", () => {
    expect(bad("DECLARE c SCROLL NO SCROLL CURSOR FOR SELECT 1;")).toThrow(
      /cannot specify both SCROLL and NO SCROLL \(1:17\)/,
    );
    expect(bad("DECLARE c INSENSITIVE ASENSITIVE CURSOR FOR SELECT 1;")).toThrow(
      /cannot specify both ASENSITIVE and INSENSITIVE \(1:22\)/,
    );
    expect(bad("DECLARE c NO CURSOR FOR SELECT 1;")).toThrow(/Expected "scroll" but found "cursor"/);
    expect(bad("DECLARE c FOR SELECT 1;")).toThrow(/Expected "cursor" but found "for"/);
    expect(bad("DECLARE c CURSOR WITH FOR SELECT 1;")).toThrow(/Expected "hold" but found "for"/);
    expect(bad("DECLARE c CURSOR SELECT 1;")).toThrow(/Expected "for" but found "select"/);
    expect(bad("DECLARE c CURSOR FOR CREATE TABLE t (a int);")).toThrow(/Expected a query but found "create" \(1:21\)/);
    expect(bad("DECLARE c CURSOR FOR INSERT INTO t VALUES (1);")).toThrow(/Expected a query but found "insert"/);
    expect(bad("FETCH RELATIVE c;")).toThrow(/Expected an integer count but found "c"/);
    expect(bad("FETCH 1.5 c;")).toThrow(/Expected an integer count but found "1.5"/);
    expect(bad("FETCH 99999999999 c;")).toThrow(/Expected an integer count but found "99999999999"/);
    expect(bad('FETCH "next" FROM c;')).toThrow(/Expected ";" but found "from" \(1:13\)/);
    expect(bad("MOVE ABSOLUTE FROM c;")).toThrow(/Expected an integer count but found "from"/);
    expect(bad("MOVE;")).toThrow(/Expected a name but found ";"/);
    expect(bad("FETCH FORWARD 5;")).toThrow(/Expected a name but found ";"/);
    expect(bad("FETCH ALL;")).toThrow(/Expected a name but found ";"/);
    expect(bad("FETCH s.c;")).toThrow(/Expected ";" but found "\."/);
    expect(bad("CLOSE;")).toThrow(/Expected a name but found ";"/);
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
    const tempTargets = '"table", "recursive" or "view"';
    expect(bad("CREATE TEMP UNLOGGED TABLE t (id int);")).toThrow(
      `Expected ${tempTargets} but found "unlogged" (1:12)`,
    );
    expect(bad("CREATE TEMP TEMP TABLE t (id int);")).toThrow(`Expected ${tempTargets} but found "temp"`);
    expect(bad("CREATE UNLOGGED INDEX i ON t (a);")).toThrow(/Expected "table" or "materialized" but found "index"/);
    expect(bad("CREATE TEMP INDEX i ON t (a);")).toThrow(`Expected ${tempTargets} but found "index"`);
    expect(bad("CREATE TEMPORARY SEQUENCE s;")).toThrow(`Expected ${tempTargets} but found "sequence"`);
    expect(bad("CREATE OR REPLACE TEMP TABLE t (id int);")).toThrow(/Expected "recursive" or "view" but found "table"/);
    expect(bad("CREATE TEMP;")).toThrow(`Expected ${tempTargets} but found ";"`);
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
    expect(bad("CREATE ROLE r CONNECTION LIMIT - x;")).toThrow(/Expected an integer but found "x" \(1:33\)/);
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

// --- ALTER ROLE, USER, DATABASE and TABLESPACE ---

describe("SQL-lite ALTER ROLE, USER, DATABASE and TABLESPACE", () => {
  const flag = (flagName: string, value = true) => ({ kind: "flag", name: flagName, value });
  const bad = (src: string) => () => sqlLite.parse(src);
  const role = (over: Record<string, unknown>) => ({ kind: "alterRole", user: false, name: "r", ...over });
  const db = (action: unknown) => ({ kind: "alterDatabase", name: "d", action });
  const generic = (objectType: string, objectName: string, action: unknown) => ({
    kind: "alterObject",
    object: { objectType, name: [objectName] },
    action,
  });

  it("parses ALTER ROLE and ALTER USER options, as pg_dumpall writes them", () => {
    expect(
      firstStmt(
        "ALTER ROLE app_owner WITH NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB LOGIN NOREPLICATION NOBYPASSRLS " +
          "CONNECTION LIMIT -1 ENCRYPTED PASSWORD 'SCRAM-SHA-256$4096:x' VALID UNTIL 'infinity';",
      ),
    ).toEqual(
      role({
        name: "app_owner",
        action: {
          kind: "options",
          options: [
            flag("superuser", false),
            flag("inherit"),
            flag("createrole", false),
            flag("createdb", false),
            flag("login"),
            flag("replication", false),
            flag("bypassrls", false),
            { kind: "connectionLimit", limit: -1 },
            { kind: "password", encrypted: true, password: "SCRAM-SHA-256$4096:x" },
            { kind: "validUntil", timestamp: "infinity" },
          ],
        },
      }),
    );
    expect(firstStmt("ALTER USER CURRENT_USER PASSWORD NULL;")).toEqual(
      role({
        user: true,
        name: "current_user",
        action: { kind: "options", options: [{ kind: "password", encrypted: false, password: null }] },
      }),
    );
    expect(firstStmt("ALTER ROLE SESSION_USER WITH SUPERUSER;")).toEqual(
      role({ name: "session_user", action: { kind: "options", options: [flag("superuser")] } }),
    );
    // PG lets the option run be empty, with or without WITH.
    expect(firstStmt("ALTER ROLE r;")).toEqual(role({ action: { kind: "options", options: [] } }));
    expect(firstStmt('ALTER USER "Bob" WITH;')).toEqual(
      role({ user: true, name: "Bob", action: { kind: "options", options: [] } }),
    );
  });

  it("parses ALTER ROLE and ALTER USER RENAME TO", () => {
    expect(firstStmt("ALTER ROLE r RENAME TO s;")).toEqual(role({ action: { kind: "rename", to: "s" } }));
    expect(firstStmt('ALTER USER "current_user" RENAME TO u;')).toEqual(
      role({ user: true, name: "current_user", action: { kind: "rename", to: "u" } }),
    );
  });

  it("parses ALTER ROLE [IN DATABASE] SET and RESET, for a role or ALL", () => {
    expect(firstStmt("ALTER ROLE r SET search_path TO 'app', 'public';")).toEqual(
      role({ action: { kind: "set", name: "search_path", values: [str("app"), str("public")] } }),
    );
    expect(firstStmt("ALTER ROLE r SET statement_timeout = '5s';")).toEqual(
      role({ action: { kind: "set", name: "statement_timeout", values: [str("5s")] } }),
    );
    expect(firstStmt("ALTER USER CURRENT_ROLE IN DATABASE appdb SET work_mem FROM CURRENT;")).toEqual(
      role({
        user: true,
        name: "current_role",
        database: "appdb",
        action: { kind: "set", name: "work_mem", values: "fromCurrent" },
      }),
    );
    expect(firstStmt("ALTER ROLE ALL SET jit = off;")).toEqual(
      role({ name: null, action: { kind: "set", name: "jit", values: [name("off")] } }),
    );
    expect(firstStmt("ALTER ROLE r SET TIME ZONE 'UTC';")).toEqual(
      role({ action: { kind: "set", name: "time zone", values: [str("UTC")] } }),
    );
    expect(firstStmt("ALTER ROLE r SET x.y TO DEFAULT;")).toEqual(
      role({ action: { kind: "set", name: "x.y", values: "default" } }),
    );
    expect(firstStmt("ALTER ROLE r IN DATABASE appdb RESET ALL;")).toEqual(
      role({ database: "appdb", action: { kind: "reset", name: "all" } }),
    );
    expect(firstStmt("ALTER USER ALL IN DATABASE appdb RESET search_path;")).toEqual(
      role({ user: true, name: null, database: "appdb", action: { kind: "reset", name: "search_path" } }),
    );
    expect(firstStmt("ALTER ROLE r RESET TIME ZONE;")).toEqual(role({ action: { kind: "reset", name: "time zone" } }));
    expect(firstStmt("ALTER ROLE r SET x = 1;")).not.toHaveProperty("database");
  });

  it("parses every ALTER DATABASE form", () => {
    expect(firstStmt("ALTER DATABASE d WITH ALLOW_CONNECTIONS false CONNECTION LIMIT 5 IS_TEMPLATE true;")).toEqual(
      db({
        kind: "options",
        options: [
          { name: "allow_connections", value: { kind: "bool", value: false } },
          { name: "connection limit", value: num(5) },
          { name: "is_template", value: { kind: "bool", value: true } },
        ],
      }),
    );
    expect(firstStmt("ALTER DATABASE d CONNECTION LIMIT = -1;")).toEqual(
      db({ kind: "options", options: [{ name: "connection limit", value: num(-1) }] }),
    );
    expect(firstStmt("ALTER DATABASE d;")).toEqual(db({ kind: "options", options: [] }));
    expect(firstStmt("ALTER DATABASE d SET TABLESPACE fast;")).toEqual(
      db({ kind: "setTablespace", tablespace: "fast" }),
    );
    expect(firstStmt("ALTER DATABASE d REFRESH COLLATION VERSION;")).toEqual(db({ kind: "refreshCollationVersion" }));
    expect(firstStmt("ALTER DATABASE d SET search_path TO app, public;")).toEqual(
      db({ kind: "set", name: "search_path", values: [name("app"), name("public")] }),
    );
    expect(firstStmt("ALTER DATABASE d SET search_path FROM CURRENT;")).toEqual(
      db({ kind: "set", name: "search_path", values: "fromCurrent" }),
    );
    expect(firstStmt("ALTER DATABASE d RESET ALL;")).toEqual(db({ kind: "reset", name: "all" }));
    expect(firstStmt("ALTER DATABASE d RESET search_path;")).toEqual(db({ kind: "reset", name: "search_path" }));
    // A parameter called `tablespace` is set as any other is.
    expect(firstStmt("ALTER DATABASE d SET tablespace TO x;")).toEqual(
      db({ kind: "set", name: "tablespace", values: [name("x")] }),
    );
    // …as is one called `tablespace` written with `=`, and so is a quoted SET.
    expect(firstStmt("ALTER DATABASE d SET TABLESPACE = x;")).toEqual(
      db({ kind: "set", name: "tablespace", values: [name("x")] }),
    );
    expect(firstStmt("ALTER DATABASE d WITH TABLESPACE x;")).toEqual(
      db({ kind: "options", options: [{ name: "tablespace", value: name("x") }] }),
    );
    expect(firstStmt('CREATE DATABASE d "set" = 1;').options).toEqual([{ name: "set", value: num(1) }]);
    // OWNER is a database option too; it leads OWNER TO only before TO.
    expect(firstStmt("ALTER DATABASE d OWNER = bob;")).toEqual(
      db({ kind: "options", options: [{ name: "owner", value: name("bob") }] }),
    );
  });

  it("keeps RENAME TO and OWNER TO on DATABASE and TABLESPACE the generic alterObject node", () => {
    expect(firstStmt("ALTER DATABASE d RENAME TO e;")).toEqual(generic("database", "d", { kind: "rename", to: "e" }));
    expect(firstStmt("ALTER DATABASE appdb OWNER TO CURRENT_ROLE;")).toEqual(
      generic("database", "appdb", { kind: "ownerTo", owner: "current_role" }),
    );
    expect(firstStmt("ALTER TABLESPACE t RENAME TO u;")).toEqual(
      generic("tablespace", "t", { kind: "rename", to: "u" }),
    );
    expect(firstStmt("ALTER TABLESPACE t OWNER TO app_owner;")).toEqual(
      generic("tablespace", "t", { kind: "ownerTo", owner: "app_owner" }),
    );
  });

  it("parses ALTER TABLESPACE SET and RESET, and DROP TABLESPACE", () => {
    expect(firstStmt("ALTER TABLESPACE t SET (random_page_cost = 1.1, seq_page_cost = 2);")).toEqual({
      kind: "alterTablespace",
      name: "t",
      action: {
        kind: "setOptions",
        options: [
          { name: "random_page_cost", value: num(1.1) },
          { name: "seq_page_cost", value: num(2) },
        ],
      },
    });
    expect(firstStmt("ALTER TABLESPACE t RESET (random_page_cost);")).toEqual({
      kind: "alterTablespace",
      name: "t",
      action: { kind: "resetOptions", options: [{ name: "random_page_cost", value: null }] },
    });
    const drop = (ifExists: boolean) => ({
      kind: "drop",
      objectType: "tablespace",
      concurrently: false,
      ifExists,
      names: [["t"]],
      behavior: null,
    });
    expect(firstStmt("DROP TABLESPACE t;")).toEqual(drop(false));
    expect(firstStmt("DROP TABLESPACE IF EXISTS t;")).toEqual(drop(true));
  });

  it("still parses COMMENT ON and SECURITY LABEL ON DATABASE and TABLESPACE", () => {
    expect(firstStmt("COMMENT ON DATABASE d IS 'x';")).toEqual({
      kind: "comment",
      objectType: "database",
      name: ["d"],
      comment: "x",
    });
    expect(firstStmt("COMMENT ON TABLESPACE t IS NULL;")).toEqual({
      kind: "comment",
      objectType: "tablespace",
      name: ["t"],
      comment: null,
    });
    expect(firstStmt("SECURITY LABEL ON TABLESPACE t IS 'l';")).toEqual({
      kind: "securityLabel",
      objectType: "tablespace",
      name: ["t"],
      label: "l",
    });
  });

  it("spans each statement from ALTER or DROP", () => {
    for (const src of [
      "ALTER ROLE r WITH LOGIN;",
      "ALTER USER ALL IN DATABASE d RESET ALL;",
      "ALTER DATABASE d REFRESH COLLATION VERSION;",
      "ALTER DATABASE d OWNER TO r;",
      "ALTER TABLESPACE t RESET (x);",
      "DROP TABLESPACE t;",
    ]) {
      const [stmt] = sqlLite.parse(src) as Record<string, any>[];
      expect(stmt!.span).toEqual({ start: { row: 1, col: 0 }, end: { row: 1, col: src.length - 1 } });
    }
  });

  it("keeps the new words unreserved as names and aliases", () => {
    const words = [
      "role",
      "database",
      "tablespace",
      "rename",
      "owner",
      "reset",
      "refresh",
      "collation",
      "version",
      "connection",
      "allow_connections",
      "is_template",
      "template",
      "password",
      "encrypted",
      "valid",
      "until",
      "admin",
    ];
    expect(firstStmt(`SELECT ${words.join(", ")} FROM role;`).columns.map((c: any) => c.expr)).toEqual(
      words.map((word) => name(word)),
    );
    const cols = words.map((word) => `${word} text`).join(", ");
    expect(firstStmt(`CREATE TABLE tablespace (${cols});`).items.map((i: any) => i.name)).toEqual(words);
    expect(firstStmt("SELECT 1 AS refresh, 2 version FROM database AS collation;")).toMatchObject({
      columns: [{ alias: "refresh" }, { alias: "version" }],
      from: [{ name: ["database"], alias: "collation" }],
    });
    // …and as the names these statements alter.
    expect(firstStmt("ALTER ROLE rename RENAME TO password;")).toEqual(
      role({ name: "rename", action: { kind: "rename", to: "password" } }),
    );
    expect(firstStmt("ALTER ROLE role IN DATABASE database SET reset = 1;")).toEqual(
      role({ name: "role", database: "database", action: { kind: "set", name: "reset", values: [num(1)] } }),
    );
    expect(firstStmt("ALTER DATABASE refresh SET TABLESPACE version;")).toEqual({
      kind: "alterDatabase",
      name: "refresh",
      action: { kind: "setTablespace", tablespace: "version" },
    });
    expect(firstStmt("ALTER TABLESPACE reset SET (reset = 1);")).toMatchObject({
      kind: "alterTablespace",
      name: "reset",
    });
    expect(firstStmt("DROP TABLESPACE tablespace;")).toMatchObject({ names: [["tablespace"]] });
  });

  it("rejects malformed ALTER ROLE, USER, DATABASE and TABLESPACE", () => {
    expect(bad("ALTER ROLE;")).toThrow(/Expected a name but found ";"/);
    expect(bad("ALTER USER user;")).toThrow(/Expected a name but found "user"/);
    expect(bad("ALTER ROLE r frobnicate;")).toThrow(/Expected ";" but found "frobnicate"/);
    // ALTER takes none of CREATE ROLE's membership options.
    expect(bad("ALTER ROLE r IN ROLE a;")).toThrow(/Expected "database" but found "role"/);
    expect(bad("ALTER ROLE r WITH ROLE a;")).toThrow(/Expected ";" but found "role"/);
    expect(bad("ALTER ROLE r ADMIN a;")).toThrow(/Expected ";" but found "admin"/);
    expect(bad("ALTER ROLE r ENCRYPTED PASSWORD NULL;")).toThrow(/found "null"/);
    expect(bad("ALTER ROLE r CONNECTION LIMIT many;")).toThrow(/Expected an integer but found "many"/);
    // ALL and IN DATABASE take only SET and RESET.
    expect(bad("ALTER ROLE ALL WITH LOGIN;")).toThrow(/Expected "in", "set" or "reset" but found "with"/);
    expect(bad("ALTER ROLE ALL RENAME TO x;")).toThrow(/Expected "in", "set" or "reset" but found "rename"/);
    expect(bad("ALTER ROLE r IN DATABASE d LOGIN;")).toThrow(/Expected "set" or "reset" but found "login"/);
    expect(bad("ALTER ROLE r IN d SET x = 1;")).toThrow(/Expected "database" but found "d"/);
    // RENAME names a role, never a pseudo-role.
    expect(bad("ALTER ROLE CURRENT_USER RENAME TO x;")).toThrow(
      /CURRENT_USER cannot be used as a role name here \(1:11\)/,
    );
    expect(bad("ALTER ROLE r RENAME TO session_user;")).toThrow(/Expected a name but found "session_user"/);
    expect(bad("ALTER ROLE r RENAME x;")).toThrow(/Expected "to" but found "x"/);
    expect(bad("ALTER ROLE public RENAME TO x;")).toThrow(/Role name "public" is reserved \(1:11\)/);
    expect(bad("ALTER USER r RENAME TO none;")).toThrow(/Role name "none" is reserved \(1:23\)/);
    expect(bad('ALTER ROLE "public" RENAME TO x;')).toThrow(/Role name "public" is reserved \(1:12\)/);
    expect(bad('ALTER ROLE r RENAME TO "none";')).toThrow(/Role name "none" is reserved \(1:24\)/);
    expect(firstStmt('ALTER ROLE "PUBLIC" RENAME TO x;')).toMatchObject({ name: "PUBLIC" });
    // SET takes a parameter value, never an expression.
    expect(bad("ALTER ROLE r SET x = 1 + 2;")).toThrow(/Expected ";" but found "\+"/);
    expect(bad("ALTER ROLE r SET x;")).toThrow(/Expected "to" or "=" but found ";"/);
    expect(bad("ALTER ROLE r RESET;")).toThrow(/found ";"/);
    expect(bad("ALTER DATABASE;")).toThrow(/Expected a name but found ";"/);
    expect(bad("ALTER DATABASE d REFRESH COLLATION;")).toThrow(/Expected "version" but found ";"/);
    expect(bad("ALTER DATABASE d SET TABLESPACE;")).toThrow(/Expected a name but found ";"/);
    expect(bad("ALTER DATABASE d OWNER TO;")).toThrow(/Expected a name but found ";"/);
    expect(bad("ALTER DATABASE d WITH is_template;")).toThrow(/Expected an option value but found ";"/);
    expect(bad("ALTER DATABASE a.b RENAME TO c;")).toThrow(/Expected ";" but found "\."/);
    // The other actions' words name no option, and OWNER TO only leads.
    expect(bad("ALTER DATABASE d WITH RESET x;")).toThrow(/Expected ";" but found "reset"/);
    expect(bad("ALTER DATABASE d IS_TEMPLATE true REFRESH COLLATION VERSION;")).toThrow(
      /Expected ";" but found "refresh"/,
    );
    expect(bad("ALTER DATABASE d WITH OWNER TO r;")).toThrow(/Expected an option value but found "to"/);
    expect(bad("CREATE DATABASE d OWNER TO;")).toThrow(/Expected an option value but found "to"/);
    expect(bad("CREATE DATABASE d SET = 1;")).toThrow(/Expected ";" but found "set"/);
    expect(bad("ALTER DATABASE d SET TABLESPACE x.y;")).toThrow(/Expected ";" but found "\."/);
    expect(bad("ALTER TABLESPACE t;")).toThrow(/Expected "rename", "owner", "set" or "reset" but found ";"/);
    expect(bad("ALTER TABLESPACE t SET random_page_cost = 1;")).toThrow(/Expected "\(" but found "random_page_cost"/);
    expect(bad("ALTER TABLESPACE t RESET (x = 1);")).toThrow(/RESET must not include values for parameters/);
    expect(bad("ALTER TABLESPACE t OWNER r;")).toThrow(/Expected "to" but found "r"/);
    expect(bad("DROP TABLESPACE a, b;")).toThrow(/Expected ";" but found ","/);
    expect(bad("DROP TABLESPACE t CASCADE;")).toThrow(/Expected ";" but found "cascade"/);
  });
});

// --- LOCK and CALL ---

describe("SQL-lite LOCK and CALL", () => {
  const target = (parts: string[], only = false) => ({ name: parts, only });
  const modeOf = (mode: string) => firstStmt(`LOCK t IN ${mode} MODE;`).mode;
  const bad = (src: string) => () => sqlLite.parse(src);

  it("parses LOCK with and without TABLE, ONLY, `*`, a mode and NOWAIT", () => {
    expect(firstStmt("LOCK t;")).toEqual({ kind: "lock", tables: [target(["t"])], mode: null, nowait: false });
    expect(firstStmt("LOCK TABLE ONLY s.t, u *, ONLY (v) IN EXCLUSIVE MODE NOWAIT;")).toEqual({
      kind: "lock",
      tables: [target(["s", "t"], true), target(["u"]), target(["v"], true)],
      mode: "exclusive",
      nowait: true,
    });
    expect(firstStmt("LOCK TABLE t NOWAIT;")).toMatchObject({ mode: null, nowait: true });
  });

  it("parses all eight lock modes, the ones sharing a lead word included", () => {
    expect(modeOf("ACCESS SHARE")).toBe("accessShare");
    expect(modeOf("ROW SHARE")).toBe("rowShare");
    expect(modeOf("ROW EXCLUSIVE")).toBe("rowExclusive");
    expect(modeOf("SHARE UPDATE EXCLUSIVE")).toBe("shareUpdateExclusive");
    expect(modeOf("SHARE")).toBe("share");
    expect(modeOf("SHARE ROW EXCLUSIVE")).toBe("shareRowExclusive");
    expect(modeOf("EXCLUSIVE")).toBe("exclusive");
    expect(modeOf("ACCESS EXCLUSIVE")).toBe("accessExclusive");
  });

  it("parses CALL with an empty, positional or named argument list", () => {
    expect(firstStmt("CALL p();")).toEqual({ kind: "callProcedure", name: ["p"], args: [] });
    expect(firstStmt("CALL s.p(1, 'a' || b, c => 2);")).toEqual({
      kind: "callProcedure",
      name: ["s", "p"],
      args: [num(1), bin("||", str("a"), name("b")), { kind: "namedArg", name: "c", value: num(2) }],
    });
  });

  it("leaves SELECT's FOR SHARE / FOR UPDATE NOWAIT locking clauses untouched", () => {
    expect(firstStmt("SELECT * FROM t FOR SHARE FOR UPDATE NOWAIT;").locking).toEqual([
      { strength: "share", of: [], wait: null },
      { strength: "update", of: [], wait: "nowait" },
    ]);
  });

  it("keeps lock, call and the lock-mode words unreserved", () => {
    const words = ["lock", "call", "access", "row", "share", "update", "exclusive", "mode", "nowait"];
    expect(firstStmt(`SELECT ${words.join(", ")} FROM lock;`)).toEqual(
      sel({ columns: words.map((w) => col(name(w))), from: [tableFrom(["lock"])] }),
    );
    expect(firstStmt("CREATE TABLE call (share int, mode text);").items.map((i: any) => i.name)).toEqual([
      "share",
      "mode",
    ]);
    // …and as the names the two statements take.
    expect(firstStmt("LOCK nowait, mode NOWAIT;")).toEqual({
      kind: "lock",
      tables: [target(["nowait"]), target(["mode"])],
      mode: null,
      nowait: true,
    });
    expect(firstStmt("CALL lock(share => 1);")).toMatchObject({ kind: "callProcedure", name: ["lock"] });
  });

  it("rejects a half-written lock mode, a missing MODE and a CALL without parentheses", () => {
    expect(bad("LOCK t IN SHARE ROW MODE;")).toThrow(/Expected "exclusive" but found "mode" \(1:20\)/);
    expect(bad("LOCK t IN ROW MODE;")).toThrow(/Expected "share" or "exclusive" but found "mode"/);
    expect(bad("LOCK t IN SHARE UPDATE MODE;")).toThrow(/Expected "exclusive" but found "mode"/);
    expect(bad("LOCK t IN UPDATE MODE;")).toThrow(
      /Expected "access", "row", "share" or "exclusive" but found "update"/,
    );
    expect(bad("LOCK t IN SHARE;")).toThrow(/Expected "update", "row" or "mode" but found ";"/);
    expect(bad("LOCK t IN EXCLUSIVE;")).toThrow(/Expected "mode" but found ";"/);
    expect(bad("LOCK ONLY t *;")).toThrow(/Expected ";" but found "\*" \(1:12\)/);
    expect(bad("LOCK ONLY (t;")).toThrow(/Expected "\)" but found ";" \(1:12\)/);
    expect(bad("LOCK;")).toThrow(/Expected a name but found ";"/);
    expect(bad("CALL p;")).toThrow(/Expected "\(" but found ";" \(1:6\)/);
    expect(bad("CALL p(1;")).toThrow(/Expected "\)" but found ";" \(1:8\)/);
  });
});

// --- view options and REFRESH MATERIALIZED VIEW ---

describe("SQL-lite view options and REFRESH MATERIALIZED VIEW", () => {
  const opt = (optName: string, value: unknown = null) => ({ name: optName, value });
  const bad = (src: string) => () => sqlLite.parse(src);

  it("parses a view's WITH (option, …) list before AS", () => {
    expect(
      firstStmt("CREATE OR REPLACE VIEW v (a) WITH (security_barrier, check_option = local) AS SELECT 1;"),
    ).toMatchObject({
      kind: "createView",
      orReplace: true,
      columns: ["a"],
      options: [opt("security_barrier"), opt("check_option", name("local"))],
    });
    // A materialized view's storage parameters sit in the same place.
    expect(firstStmt("CREATE MATERIALIZED VIEW mv WITH (fillfactor = 70) AS SELECT 1 WITH NO DATA;")).toMatchObject({
      materialized: true,
      options: [opt("fillfactor", num(70))],
      withData: false,
    });
  });

  it("parses WITH [CASCADED | LOCAL] CHECK OPTION after a view's query", () => {
    const check = (src: string) => firstStmt(src).checkOption;
    // A bare WITH CHECK OPTION is CASCADED, as in PG.
    expect(check("CREATE VIEW v AS SELECT a FROM t WITH CHECK OPTION;")).toBe("cascaded");
    expect(check("CREATE VIEW v AS SELECT a FROM t WITH CASCADED CHECK OPTION;")).toBe("cascaded");
    expect(check("CREATE VIEW v AS SELECT a FROM t WITH LOCAL CHECK OPTION;")).toBe("local");
    expect(check("CREATE VIEW v WITH (security_barrier) AS SELECT 1 WITH LOCAL CHECK OPTION;")).toBe("local");
  });

  it("keeps a trailing WITH apart from a type's WITH TIME ZONE", () => {
    for (const [clause, level] of [
      ["WITH CHECK OPTION", "cascaded"],
      ["WITH LOCAL CHECK OPTION", "local"],
      ["WITH CASCADED CHECK OPTION", "cascaded"],
    ]) {
      const v = firstStmt(`CREATE VIEW v AS SELECT now()::timestamp ${clause};`);
      expect(v.checkOption).toBe(level);
      expect(v.query.columns[0].expr.type).toMatchObject({ name: "timestamp" });
    }
    expect(firstStmt("CREATE VIEW v AS SELECT now()::timestamp WITH TIME ZONE WITH CHECK OPTION;")).toMatchObject({
      query: { columns: [{ expr: { type: { name: "timestamp with time zone" } } }] },
      checkOption: "cascaded",
    });
    expect(firstStmt("CREATE MATERIALIZED VIEW mv AS SELECT now()::timestamp WITH NO DATA;")).toMatchObject({
      withData: false,
    });
    // A FETCH clause's WITH TIES is taken first, and the check option follows it.
    expect(
      firstStmt("CREATE VIEW v AS SELECT a FROM t ORDER BY a FETCH FIRST 1 ROW WITH TIES WITH CHECK OPTION;"),
    ).toMatchObject({ query: { limit: num(1) }, checkOption: "cascaded" });
    // A trailing IS JSON takes a following WITH as its uniqueness clause, as in PG.
    expect(bad("CREATE VIEW v AS SELECT a IS JSON WITH CHECK OPTION;")).toThrow(/Expected "unique" but found "check"/);
  });

  it("ends a schema element view at its check option", () => {
    const schema = firstStmt(
      "CREATE SCHEMA s CREATE VIEW v AS SELECT 1 WITH LOCAL CHECK OPTION CREATE TABLE t (a int);",
    );
    expect(schema.elements.map((e: any) => [e.kind, e.checkOption])).toEqual([
      ["createView", "local"],
      ["createTable", undefined],
    ]);
  });

  it("omits the new keys when their clauses are absent", () => {
    for (const src of ["CREATE VIEW v AS SELECT 1;", "CREATE MATERIALIZED VIEW mv AS SELECT 1 WITH DATA;"]) {
      const v = firstStmt(src);
      expect(v).not.toHaveProperty("options");
      expect(v).not.toHaveProperty("checkOption");
    }
  });

  it("parses REFRESH MATERIALIZED VIEW [CONCURRENTLY] name [WITH [NO] DATA]", () => {
    expect(firstStmt("REFRESH MATERIALIZED VIEW mv;")).toEqual({
      kind: "refreshMaterializedView",
      concurrently: false,
      name: ["mv"],
      withData: null,
    });
    expect(firstStmt("REFRESH MATERIALIZED VIEW CONCURRENTLY s.mv WITH DATA;")).toMatchObject({
      concurrently: true,
      name: ["s", "mv"],
      withData: true,
    });
    expect(firstStmt("REFRESH MATERIALIZED VIEW mv WITH NO DATA;")).toMatchObject({ withData: false });
    expect(sqlLite.parse("REFRESH MATERIALIZED VIEW mv;")[0]!.span).toEqual({
      start: { row: 1, col: 0 },
      end: { row: 1, col: 28 },
    });
  });

  it("keeps the new words unreserved as names", () => {
    const words = ["refresh", "materialized", "concurrently", "cascaded", "local", "option", "security_barrier"];
    expect(firstStmt(`SELECT ${words.join(", ")} FROM refresh;`).columns.map((c: any) => c.expr)).toEqual(
      words.map((word) => name(word)),
    );
    const cols = words.map((word) => `${word} text`).join(", ");
    expect(firstStmt(`CREATE TABLE option (${cols});`).items.map((i: any) => i.name)).toEqual(words);
    // …and as the views these statements name.
    expect(firstStmt("CREATE VIEW cascaded AS SELECT local FROM option WITH LOCAL CHECK OPTION;")).toMatchObject({
      name: ["cascaded"],
      checkOption: "local",
    });
    expect(firstStmt("REFRESH MATERIALIZED VIEW refresh;")).toMatchObject({ name: ["refresh"] });
    // `check` is reserved, so only a quoted one is a name.
    expect(bad("SELECT check FROM t;")).toThrow(/Expected a name but found "check"/);
    expect(firstStmt('CREATE VIEW "check" AS SELECT 1;')).toMatchObject({ name: ["check"] });
  });

  it("rejects malformed view options, check options and REFRESH", () => {
    expect(bad("CREATE MATERIALIZED VIEW mv AS SELECT 1 WITH CHECK OPTION;")).toThrow(
      /Expected "data" but found "check"/,
    );
    expect(bad("CREATE VIEW v AS SELECT 1 WITH DATA;")).toThrow(
      /Expected "cascaded", "local" or "check" but found "data" \(1:31\)/,
    );
    expect(bad("CREATE VIEW v AS SELECT 1 WITH;")).toThrow(/Expected "cascaded", "local" or "check" but found ";"/);
    expect(bad("CREATE VIEW v AS SELECT 1 WITH LOCAL OPTION;")).toThrow(/Expected "check" but found "option"/);
    expect(bad("CREATE VIEW v AS SELECT 1 WITH CHECK;")).toThrow(/Expected "option" but found ";"/);
    expect(bad("CREATE VIEW v WITH security_barrier AS SELECT 1;")).toThrow(/Expected "\(" but found/);
    expect(bad("CREATE VIEW v WITH () AS SELECT 1;")).toThrow(/Expected an option name but found "\)"/);
    expect(bad("REFRESH VIEW v;")).toThrow(/Expected "materialized" but found "view"/);
    expect(bad("REFRESH MATERIALIZED VIEW;")).toThrow(/Expected a name but found ";"/);
    expect(bad("REFRESH MATERIALIZED VIEW CONCURRENTLY;")).toThrow(/Expected a name but found ";"/);
    expect(bad("REFRESH MATERIALIZED VIEW mv WITH CHECK OPTION;")).toThrow(/Expected "data" but found "check"/);
  });
});

// --- COPY ---

describe("SQL-lite COPY", () => {
  const opt = (optName: string, value: unknown = null) => ({ name: optName, value });
  const word = (w: string) => ({ kind: "name", parts: [w] });
  const copy = (over: Record<string, unknown>) => ({
    kind: "copy",
    table: null,
    columns: null,
    query: null,
    direction: "from",
    location: { kind: "stdin" },
    options: null,
    where: null,
    ...over,
  });
  const bad = (src: string) => () => sqlLite.parse(src);

  it("parses COPY FROM each location, with a column list and WHERE", () => {
    expect(firstStmt("COPY t FROM STDIN;")).toEqual(copy({ table: ["t"] }));
    expect(firstStmt("COPY s.t (a, b) FROM '/data/t.csv' WHERE a > 1;")).toEqual(
      copy({
        table: ["s", "t"],
        columns: ["a", "b"],
        location: { kind: "file", path: "/data/t.csv" },
        where: bin(">", name("a"), num(1)),
      }),
    );
    expect(firstStmt("COPY t FROM PROGRAM 'zcat t.gz';").location).toEqual({ kind: "program", command: "zcat t.gz" });
  });

  it("parses COPY TO from a table or any preparable query", () => {
    expect(firstStmt("COPY t (a) TO STDOUT;")).toEqual(
      copy({ table: ["t"], columns: ["a"], direction: "to", location: { kind: "stdout" } }),
    );
    expect(firstStmt("COPY (SELECT 1) TO '/tmp/x';")).toEqual(
      copy({
        query: sel({ columns: [col(num(1))] }),
        direction: "to",
        location: { kind: "file", path: "/tmp/x" },
      }),
    );
    const queryOf = (src: string) => firstStmt(`COPY (${src}) TO STDOUT;`).query;
    expect(queryOf("VALUES (1)").kind).toBe("values");
    expect(queryOf("(SELECT 1) UNION SELECT 2")).toMatchObject({ kind: "setOp", op: "union" });
    expect(queryOf("WITH x AS (SELECT 1) SELECT * FROM x")).toMatchObject({ kind: "select", with_: [{ name: "x" }] });
    expect(queryOf("INSERT INTO t VALUES (1) RETURNING id")).toMatchObject({ kind: "insert", returning: [{}] });
    expect(queryOf("UPDATE t SET a = 1 RETURNING *")).toMatchObject({ kind: "update" });
    expect(queryOf("DELETE FROM t RETURNING id")).toMatchObject({ kind: "delete" });
  });

  it("reads the option list, with or without WITH, in every value shape", () => {
    const optionsOf = (src: string) => firstStmt(`COPY t FROM STDIN ${src};`).options;
    expect(
      optionsOf(
        "WITH (FORMAT csv, FREEZE, DELIMITER ',', NULL '', DEFAULT '\\D', HEADER MATCH, QUOTE '\"', ESCAPE '\\', ENCODING 'UTF8')",
      ),
    ).toEqual([
      opt("format", word("csv")),
      opt("freeze"),
      opt("delimiter", str(",")),
      opt("null", str("")),
      opt("default", str("\\D")),
      opt("header", word("match")),
      opt("quote", str('"')),
      opt("escape", str("\\")),
      opt("encoding", str("UTF8")),
    ]);
    expect(optionsOf("(HEADER true, FORCE_NOT_NULL (a, b), FORCE_NULL (c))")).toEqual([
      opt("header", { kind: "bool", value: true }),
      opt("force_not_null", { kind: "optionList", items: [word("a"), word("b")] }),
      opt("force_null", { kind: "optionList", items: [word("c")] }),
    ]);
    expect(firstStmt("COPY t TO STDOUT (FORCE_QUOTE *);").options).toEqual([opt("force_quote", star())]);
    // Options come before WHERE.
    expect(firstStmt("COPY t FROM STDIN (FREEZE) WHERE a;")).toMatchObject({
      options: [opt("freeze")],
      where: name("a"),
    });
  });

  it("keeps copy, program, stdin, stdout and the option words unreserved", () => {
    const words = [
      "copy",
      "program",
      "stdin",
      "stdout",
      "delimiter",
      "header",
      "format",
      "quote",
      "escape",
      "encoding",
    ];
    expect(firstStmt(`SELECT ${words.join(", ")} FROM copy;`)).toEqual(
      sel({ columns: words.map((w) => col(name(w))), from: [tableFrom(["copy"])] }),
    );
    expect(
      firstStmt(`CREATE TABLE stdin (${words.map((w) => `${w} int`).join(", ")});`).items.map((i: any) => i.name),
    ).toEqual(words);
    // …and as the names COPY itself takes.
    expect(firstStmt("COPY copy (program, stdout) FROM stdin;")).toEqual(
      copy({ table: ["copy"], columns: ["program", "stdout"] }),
    );
    expect(firstStmt("COPY stdout TO stdout;")).toMatchObject({ table: ["stdout"], location: { kind: "stdout" } });
  });

  it("rejects a mismatched direction, a bad location and a malformed tail", () => {
    expect(bad("COPY t TO STDIN;")).toThrow(/Expected a file name, "program" or "stdout" but found "stdin" \(1:10\)/);
    expect(bad("COPY t FROM STDOUT;")).toThrow(/Expected a file name, "program" or "stdin" but found "stdout"/);
    expect(bad("COPY (SELECT 1) FROM 'f';")).toThrow(/Expected "to" but found "from" \(1:16\)/);
    expect(bad("COPY t 'f';")).toThrow(/Expected "from" or "to" but found "f"/);
    expect(bad("COPY (CREATE TABLE t (a int)) TO STDOUT;")).toThrow(
      /Expected a SELECT, VALUES, INSERT, UPDATE, DELETE or MERGE statement but found "create"/,
    );
    expect(bad("COPY (SELECT 1) (a) TO STDOUT;")).toThrow(/Expected "to" but found "\("/);
    expect(bad("COPY t FROM PROGRAM gzip;")).toThrow(/Expected a string but found "gzip"/);
    expect(bad("COPY t TO STDOUT WHERE a;")).toThrow(/Expected ";" but found "where"/);
    expect(bad("COPY t () FROM STDIN;")).toThrow(/Expected a name but found "\)"/);
    expect(bad("COPY t FROM STDIN ();")).toThrow(/Expected an option name but found "\)"/);
  });
});

// --- COPY: PG's pre-9.0 options ---

describe("SQL-lite COPY legacy options", () => {
  const opt = (optName: string, value: unknown = null) => ({ name: optName, value });
  const word = (w: string) => ({ kind: "name", parts: [w] });
  const list = (...names: string[]) => ({ kind: "optionList", items: names.map(word) });
  const bad = (src: string) => () => sqlLite.parse(src);
  const optionsOf = (src: string) => firstStmt(`COPY t FROM STDIN ${src};`).options;

  it("maps each bare-word option onto the parenthesised list's name", () => {
    expect(
      optionsOf(
        "BINARY FREEZE DELIMITER '|' NULL '' CSV HEADER QUOTE '\"' ESCAPE '\\' FORCE NOT NULL a, b FORCE NULL c ENCODING 'UTF8'",
      ),
    ).toEqual([
      opt("format", word("binary")),
      opt("freeze"),
      opt("delimiter", str("|")),
      opt("null", str("")),
      opt("format", word("csv")),
      opt("header"),
      opt("quote", str('"')),
      opt("escape", str("\\")),
      opt("force_not_null", list("a", "b")),
      opt("force_null", list("c")),
      opt("encoding", str("UTF8")),
    ]);
    expect(firstStmt("COPY t TO STDOUT CSV FORCE QUOTE a, b;").options).toEqual([
      opt("format", word("csv")),
      opt("force_quote", list("a", "b")),
    ]);
    expect(firstStmt("COPY t TO STDOUT CSV FORCE QUOTE *;").options).toEqual([
      opt("format", word("csv")),
      opt("force_quote", star()),
    ]);
    expect(firstStmt('COPY t TO STDOUT CSV FORCE QUOTE "A", b;').options).toEqual([
      opt("format", word("csv")),
      opt("force_quote", list("A", "b")),
    ]);
    expect(optionsOf("CSV FORCE NOT NULL * FORCE NULL *")).toEqual([
      opt("format", word("csv")),
      opt("force_not_null", star()),
      opt("force_null", star()),
    ]);
  });

  it("reads the optional AS, the optional WITH and a bare WITH", () => {
    expect(optionsOf("WITH DELIMITER AS ',' NULL AS 'x' QUOTE AS '\"' ESCAPE AS 'e'")).toEqual([
      opt("delimiter", str(",")),
      opt("null", str("x")),
      opt("quote", str('"')),
      opt("escape", str("e")),
    ]);
    expect(firstStmt("COPY users FROM '/tmp/u.txt' DELIMITER '|' CSV HEADER;")).toEqual({
      kind: "copy",
      table: ["users"],
      columns: null,
      query: null,
      direction: "from",
      location: { kind: "file", path: "/tmp/u.txt" },
      options: [opt("delimiter", str("|")), opt("format", word("csv")), opt("header")],
      where: null,
      legacy: true,
    });
    // An empty bare-word list: the options are absent, the spelling is not.
    expect(firstStmt("COPY t TO STDOUT WITH;")).toMatchObject({ options: null, legacy: true });
    expect(firstStmt("COPY t FROM STDIN WITH WHERE a;")).toMatchObject({
      options: null,
      where: name("a"),
      legacy: true,
    });
    // The options come before WHERE, and a query may take them too.
    expect(firstStmt("COPY t FROM STDIN WITH CSV WHERE a;")).toMatchObject({
      options: [opt("format", word("csv"))],
      where: name("a"),
      legacy: true,
    });
    expect(firstStmt("COPY (SELECT 1) TO STDOUT WITH CSV HEADER;")).toMatchObject({
      options: [opt("format", word("csv")), opt("header")],
      legacy: true,
    });
  });

  it("reads COPY BINARY and USING DELIMITERS, alongside either option form", () => {
    expect(firstStmt("COPY BINARY s.t (a) TO STDOUT;")).toMatchObject({
      table: ["s", "t"],
      columns: ["a"],
      options: [opt("format", word("binary"))],
      legacy: true,
    });
    expect(firstStmt('COPY BINARY "t" FROM STDIN;')).toMatchObject({ table: ["t"], legacy: true });
    expect(firstStmt("COPY t FROM STDIN USING DELIMITERS '|';")).toMatchObject({
      options: [opt("delimiter", str("|"))],
      legacy: true,
    });
    expect(firstStmt("COPY t TO STDOUT DELIMITERS '|' CSV;").options).toEqual([
      opt("delimiter", str("|")),
      opt("format", word("csv")),
    ]);
    expect(firstStmt("COPY BINARY t FROM STDIN WITH CSV;")).toMatchObject({
      options: [opt("format", word("binary")), opt("format", word("csv"))],
      legacy: true,
    });
    // PG collects the prefix, then DELIMITERS, then the list.
    expect(firstStmt("COPY BINARY t FROM STDIN USING DELIMITERS ',' WITH (HEADER);")).toMatchObject({
      options: [opt("format", word("binary")), opt("delimiter", str(",")), opt("header")],
      legacy: true,
    });
  });

  it("leaves the parenthesised form unmarked", () => {
    const stmt = firstStmt("COPY t FROM STDIN WITH (FORMAT csv, HEADER);");
    expect(stmt.options).toEqual([opt("format", word("csv")), opt("header")]);
    expect(stmt).not.toHaveProperty("legacy");
    expect(firstStmt("COPY t FROM STDIN;")).not.toHaveProperty("legacy");
  });

  it("keeps the legacy option words unreserved", () => {
    const words = [
      "binary",
      "csv",
      "header",
      "delimiter",
      "quote",
      "escape",
      "force",
      "freeze",
      "encoding",
      "delimiters",
    ];
    expect(firstStmt(`SELECT ${words.join(", ")} FROM binary;`)).toEqual(
      sel({ columns: words.map((w) => col(name(w))), from: [tableFrom(["binary"])] }),
    );
    expect(firstStmt(`SELECT 1 AS csv, 2 freeze FROM t force;`)).toMatchObject({
      columns: [{ alias: "csv" }, { alias: "freeze" }],
    });
    expect(
      firstStmt(`CREATE TABLE csv (${words.map((w) => `${w} int`).join(", ")});`).items.map((i: any) => i.name),
    ).toEqual(words);
    // …and as the names COPY itself takes: `binary` is the prefix only before
    // another name.
    expect(firstStmt("COPY binary (csv, header) FROM STDIN;")).toMatchObject({
      table: ["binary"],
      columns: ["csv", "header"],
      options: null,
    });
    expect(firstStmt("COPY binary TO STDOUT;")).not.toHaveProperty("legacy");
    expect(firstStmt("COPY binary.force FROM STDIN;")).toMatchObject({ table: ["binary", "force"] });
    expect(firstStmt("COPY BINARY binary FROM STDIN;")).toMatchObject({ table: ["binary"], legacy: true });
    expect(firstStmt("COPY t TO STDOUT FORCE QUOTE delimiter, force;").options).toEqual([
      opt("force_quote", list("delimiter", "force")),
    ]);
  });

  it("rejects what PG's grammar rejects", () => {
    // One statement takes one option form.
    expect(bad("COPY t FROM STDIN WITH CSV (HEADER);")).toThrow(/Expected ";" but found "\("/);
    expect(bad("COPY t FROM STDIN (HEADER) CSV;")).toThrow(/Expected ";" but found "csv"/);
    expect(bad("COPY t FROM STDIN FORCE;")).toThrow(/Expected "quote", "not" or "null" but found ";"/);
    expect(bad("COPY t FROM STDIN FORCE NOT a;")).toThrow(/Expected "null" but found "a"/);
    expect(bad("COPY t FROM STDIN CSV FORCE NOT NULL *, a;")).toThrow(/Expected ";" but found ","/);
    expect(bad("COPY t TO STDOUT WITH WHERE a;")).toThrow(/Expected ";" but found "where"/);
    expect(bad("COPY t FROM STDIN WITH FORMAT csv;")).toThrow(
      /Expected "\(" or a COPY option but found "format" \(1:23\)/,
    );
    expect(bad("COPY t TO STDOUT FORCE QUOTE select;")).toThrow(/Expected "\*" or a name but found "select"/);
    expect(bad("COPY t TO STDOUT FORCE QUOTE a, select;")).toThrow(/Expected a name but found "select"/);
    expect(bad("COPY t FROM STDIN WITH DELIMITERS ',';")).toThrow(
      /Expected "\(" or a COPY option but found "delimiters"/,
    );
    expect(bad("COPY t FROM STDIN WITH USING DELIMITERS ',';")).toThrow(
      /Expected "\(" or a COPY option but found "using"/,
    );
    expect(bad("COPY t TO STDOUT FORCE QUOTE;")).toThrow(/Expected "\*" or a name but found ";"/);
    expect(bad("COPY binary select FROM STDIN;")).toThrow(/Expected "from" or "to" but found "select"/);
    expect(bad("COPY t FROM STDIN WITH 1;")).toThrow(/Expected "\(" or a COPY option but found "1"/);
    // The BINARY lookahead reports what does not lex rather than dropping it.
    expect(sqlLite.diagnose("COPY binary 'x").errors[0]?.message).toMatch(/Unterminated/);
    expect(bad("COPY t TO STDOUT FORCE QUOTE (a);")).toThrow(/Expected "\*" or a name but found "\("/);
    expect(bad("COPY t FROM STDIN DELIMITER ,;")).toThrow(/Expected a string but found ","/);
    expect(bad("COPY t FROM STDIN ENCODING AS 'UTF8';")).toThrow(/Expected a string but found "as"/);
    expect(bad("COPY t FROM STDIN HEADER true;")).toThrow(/Expected ";" but found "true"/);
    // DELIMITERS comes before the options, and only after a table.
    expect(bad("COPY t FROM STDIN CSV DELIMITERS ',';")).toThrow(/Expected ";" but found "delimiters"/);
    expect(bad("COPY (SELECT 1) TO STDOUT USING DELIMITERS ',';")).toThrow(/Expected ";" but found "using"/);
    expect(bad("COPY BINARY (SELECT 1) TO STDOUT;")).toThrow(/Expected a name but found "select"/);
  });
});

// --- the remaining ALTER TABLE actions ---

describe("SQL-lite remaining ALTER TABLE actions", () => {
  const alter = (text: string) => firstStmt(text) as any;
  const action = (src: string) => {
    const { actions } = alter(`ALTER TABLE t ${src};`);
    expect(actions).toHaveLength(1);
    return actions[0];
  };
  const fails = (text: string) => () => sqlLite.parse(text);
  const opt = (name: string, value: unknown = null) => ({ name, value });

  it("parses SET SCHEMA, SET TABLESPACE and SET WITHOUT CLUSTER", () => {
    expect(alter("ALTER TABLE IF EXISTS s.t SET SCHEMA archive;")).toEqual({
      kind: "alterTable",
      ifExists: true,
      name: ["s", "t"],
      actions: [{ kind: "setSchema", schema: "archive" }],
    });
    expect(action("SET TABLESPACE fast")).toEqual({ kind: "setTablespace", tablespace: "fast" });
    expect(action("SET WITHOUT CLUSTER")).toEqual({ kind: "setWithoutCluster" });
  });

  it("parses SET (…) and RESET (…) through the storage-parameter list", () => {
    expect(action("SET (fillfactor = 70, toast.autovacuum_enabled = false, x)")).toEqual({
      kind: "setOptions",
      options: [
        opt("fillfactor", num(70)),
        { namespace: "toast", ...opt("autovacuum_enabled", { kind: "bool", value: false }) },
        opt("x"),
      ],
    });
    expect(action("RESET (fillfactor, toast.autovacuum_enabled)")).toEqual({
      kind: "resetOptions",
      options: [opt("fillfactor"), { namespace: "toast", ...opt("autovacuum_enabled") }],
    });
  });

  it("parses DROP CONSTRAINT and VALIDATE CONSTRAINT", () => {
    const drop = { kind: "dropConstraint", ifExists: true, name: "c", behavior: "cascade" };
    expect(action("DROP CONSTRAINT IF EXISTS c CASCADE")).toEqual(drop);
    expect(action("DROP CONSTRAINT c RESTRICT")).toEqual({ ...drop, ifExists: false, behavior: "restrict" });
    expect(action("DROP CONSTRAINT c")).toEqual({ ...drop, ifExists: false, behavior: null });
    // IF stays usable as a constraint name, and a quoted "constraint" as a column.
    expect(action("DROP CONSTRAINT if")).toEqual({ ...drop, ifExists: false, name: "if", behavior: null });
    expect(action('DROP "constraint"')).toEqual({ kind: "dropColumn", name: "constraint" });
    expect(action("VALIDATE CONSTRAINT c")).toEqual({ kind: "validateConstraint", name: "c" });
  });

  it("parses ENABLE / DISABLE TRIGGER with a name, ALL or USER", () => {
    expect(action("ENABLE TRIGGER audit")).toEqual({
      kind: "enableTrigger",
      mode: null,
      trigger: { kind: "name", name: "audit" },
    });
    const enable = (mode: string | null, trigger: unknown) => ({ kind: "enableTrigger", mode, trigger });
    expect(action("ENABLE TRIGGER ALL")).toEqual(enable(null, { kind: "all" }));
    expect(action("ENABLE TRIGGER USER")).toEqual(enable(null, { kind: "user" }));
    expect(action("ENABLE REPLICA TRIGGER r")).toEqual(enable("replica", { kind: "name", name: "r" }));
    expect(action("ENABLE ALWAYS TRIGGER g")).toEqual(enable("always", { kind: "name", name: "g" }));
    expect(action("DISABLE TRIGGER ALL")).toEqual({ kind: "disableTrigger", trigger: { kind: "all" } });
    // A quoted "all" is a trigger's name.
    expect(action('DISABLE TRIGGER "all"')).toEqual({ kind: "disableTrigger", trigger: { kind: "name", name: "all" } });
  });

  it("parses CLUSTER ON", () => {
    expect(action("CLUSTER ON t_pkey")).toEqual({ kind: "clusterOn", index: "t_pkey" });
  });

  it("parses ATTACH PARTITION with each bound and DETACH PARTITION with each mode", () => {
    expect(action("ATTACH PARTITION s.p FOR VALUES FROM (1) TO (10)")).toEqual({
      kind: "attachPartition",
      partition: ["s", "p"],
      bound: { kind: "range", from: [num(1)], to: [num(10)] },
    });
    expect(action("ATTACH PARTITION p FOR VALUES IN ('a', 'b')").bound).toEqual({
      kind: "list",
      values: [str("a"), str("b")],
    });
    expect(action("ATTACH PARTITION p FOR VALUES WITH (MODULUS 4, REMAINDER 1)").bound).toEqual({
      kind: "hash",
      modulus: 4,
      remainder: 1,
    });
    expect(action("ATTACH PARTITION p DEFAULT").bound).toEqual({ kind: "default" });
    expect(action("DETACH PARTITION s.p")).toEqual({ kind: "detachPartition", partition: ["s", "p"], mode: null });
    expect(action("DETACH PARTITION p CONCURRENTLY").mode).toBe("concurrently");
    expect(action("DETACH PARTITION p FINALIZE").mode).toBe("finalize");
  });

  it("composes with the other actions in one comma-separated list", () => {
    const { actions } = alter(
      "ALTER TABLE t SET TABLESPACE fast, DROP CONSTRAINT c, ADD a int, DISABLE TRIGGER ALL, CLUSTER ON i, " +
        "SET (fillfactor = 70), RESET (x), VALIDATE CONSTRAINT k, ENABLE ALWAYS TRIGGER g, SET WITHOUT CLUSTER;",
    );
    expect(actions.map((a: any) => a.kind)).toEqual([
      "setTablespace",
      "dropConstraint",
      "addColumn",
      "disableTrigger",
      "clusterOn",
      "setOptions",
      "resetOptions",
      "validateConstraint",
      "enableTrigger",
      "setWithoutCluster",
    ]);
  });

  it("spans the whole statement", () => {
    const [stmt] = sqlLite.parse("ALTER TABLE t ATTACH PARTITION p DEFAULT;") as Record<string, any>[];
    expect(stmt!.span).toEqual({ start: { row: 1, col: 0 }, end: { row: 1, col: 40 } });
  });

  it("keeps the new ALTER TABLE words unreserved as names", () => {
    const words = [
      "attach",
      "detach",
      "partition",
      "concurrently",
      "finalize",
      "cluster",
      "validate",
      "enable",
      "disable",
      "replica",
      "always",
      "trigger",
      "tablespace",
      "schema",
      "without",
      "reset",
    ];
    const columns = words.map((w) => `${w} int`).join(", ");
    expect(firstStmt(`CREATE TABLE t (${columns});`).items.map((i: any) => i.name)).toEqual(words);
    expect(firstStmt(`SELECT ${words.join(", ")} FROM t;`).columns.map((c: any) => c.expr)).toEqual(
      words.map((word) => name(word)),
    );
    // …as the columns ADD and DROP take, and as the names the actions take.
    const added = alter(`ALTER TABLE t ${words.map((w) => `ADD ${w} int`).join(", ")};`).actions;
    expect(added.map((a: any) => a.column.name)).toEqual(words);
    const dropped = alter(`ALTER TABLE t ${words.map((w) => `DROP ${w}`).join(", ")};`).actions;
    expect(dropped.map((a: any) => a.name)).toEqual(words);
    expect(alter("ALTER TABLE attach DETACH PARTITION finalize;")).toMatchObject({
      name: ["attach"],
      actions: [{ partition: ["finalize"], mode: null }],
    });
    expect(
      alter("ALTER TABLE cluster CLUSTER ON validate, ENABLE TRIGGER always, DISABLE TRIGGER replica;"),
    ).toMatchObject({
      name: ["cluster"],
      actions: [{ index: "validate" }, { mode: null, trigger: { name: "always" } }, { trigger: { name: "replica" } }],
    });
    expect(action("SET TABLESPACE tablespace")).toEqual({ kind: "setTablespace", tablespace: "tablespace" });
    expect(action("SET SCHEMA schema")).toEqual({ kind: "setSchema", schema: "schema" });
    expect(action("ATTACH PARTITION detach DEFAULT").partition).toEqual(["detach"]);
  });

  it("rejects a malformed action and the standalone ones beside another", () => {
    expect(fails("ALTER TABLE t SET frob;")).toThrow(
      /Expected "\(", "schema", "tablespace", "logged", "unlogged", "access" or "without" but found "frob" \(1:18\)/,
    );
    expect(fails("ALTER TABLE t SET WITHOUT frob;")).toThrow(/Expected "cluster" or "oids" but found "frob"/);
    expect(fails("ALTER TABLE t ENABLE frob;")).toThrow(
      expectsKeys(["replica", "always", "trigger", "rule", "row"], '"frob"'),
    );
    expect(fails("ALTER TABLE t DISABLE TRIGGER;")).toThrow(/Expected "all", "user" or a name but found ";"/);
    expect(fails("ALTER TABLE t ENABLE TRIGGER select;")).toThrow(
      /Expected "all", "user" or a name but found "select"/,
    );
    expect(fails("ALTER TABLE t ENABLE REPLICA IDENTITY;")).toThrow(
      /Expected "trigger" or "rule" but found "identity"/,
    );
    // REPLICA and ALWAYS take a trigger's name only, as in PG.
    expect(fails("ALTER TABLE t ENABLE REPLICA TRIGGER ALL;")).toThrow(/Expected a name but found "all"/);
    expect(fails("ALTER TABLE t ENABLE ALWAYS TRIGGER USER;")).toThrow(/Expected a name but found "user"/);
    expect(fails("ALTER TABLE t DISABLE REPLICA TRIGGER x;")).toThrow(expectsKeys(["trigger"], '"replica"'));
    expect(fails("ALTER TABLE t DROP CONSTRAINT;")).toThrow(/Expected a name but found ";"/);
    expect(fails("ALTER TABLE t VALIDATE c;")).toThrow(/Expected "constraint" but found "c"/);
    expect(fails("ALTER TABLE t CLUSTER i;")).toThrow(/Expected "on" but found "i"/);
    expect(fails("ALTER TABLE t ATTACH PARTITION p;")).toThrow(/Expected "for values" or "default" but found ";"/);
    expect(fails("ALTER TABLE t DETACH PARTITION p FORCE;")).toThrow(/Expected ";" but found "force"/);
    expect(fails("ALTER TABLE t RESET (fillfactor = 70);")).toThrow(/RESET must not include values for parameters/);
    expect(fails("ALTER TABLE t SET ();")).toThrow(/Expected an option name but found "\)"/);
    expect(fails("ALTER TABLE t ADD a int, SET SCHEMA s;")).toThrow(
      /SET SCHEMA cannot be combined with other ALTER TABLE actions \(1:25\)/,
    );
    expect(fails("ALTER TABLE t ATTACH PARTITION p DEFAULT, OWNER TO r;")).toThrow(
      /ATTACH PARTITION cannot be combined with other ALTER TABLE actions \(1:14\)/,
    );
    expect(fails("ALTER TABLE t DETACH PARTITION p, DETACH PARTITION q;")).toThrow(
      /DETACH PARTITION cannot be combined with other ALTER TABLE actions \(1:14\)/,
    );
  });
});

// --- ALTER TABLE column actions: identity, type, storage and statistics ---

describe("SQL-lite ALTER TABLE column actions", () => {
  const alter = (text: string) => firstStmt(text) as any;
  const action = (src: string) => {
    const { actions } = alter(`ALTER TABLE t ${src};`);
    expect(actions).toHaveLength(1);
    return actions[0];
  };
  const fails = (text: string) => () => sqlLite.parse(text);

  it("parses ADD GENERATED … AS IDENTITY, with pg_dump's SEQUENCE NAME", () => {
    expect(action("ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY")).toEqual({
      kind: "addIdentity",
      column: "id",
      generated: "always",
    });
    expect(
      action(
        "ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (SEQUENCE NAME s.t_id_seq START WITH 1 " +
          "INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1)",
      ),
    ).toEqual({
      kind: "addIdentity",
      column: "id",
      generated: "by default",
      options: [
        { kind: "sequenceName", name: ["s", "t_id_seq"] },
        { kind: "start", value: num(1) },
        { kind: "increment", value: num(1) },
        { kind: "minValue", value: null },
        { kind: "maxValue", value: null },
        { kind: "cache", value: num(1) },
      ],
    });
    // A column's own identity clause takes SEQUENCE NAME too.
    expect(firstStmt("CREATE TABLE t (id int GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME q));").items[0]).toEqual({
      kind: "column",
      name: "id",
      dataType: ct("int"),
      constraints: [{ kind: "identity", generated: "always", options: [{ kind: "sequenceName", name: ["q"] }] }],
    });
  });

  it("parses an identity column's SET and RESTART run, and DROP IDENTITY", () => {
    expect(action("ALTER COLUMN id SET GENERATED BY DEFAULT RESTART WITH 1000 SET INCREMENT BY 2")).toEqual({
      kind: "alterIdentity",
      column: "id",
      options: [
        { kind: "generated", generated: "by default" },
        { kind: "restart", value: num(1000) },
        { kind: "increment", value: num(2) },
      ],
    });
    expect(action("ALTER id RESTART")).toEqual({
      kind: "alterIdentity",
      column: "id",
      options: [{ kind: "restart", value: null }],
    });
    expect(action("ALTER id SET NO CYCLE SET MAXVALUE 9 RESTART 3").options).toEqual([
      { kind: "cycle", value: false },
      { kind: "maxValue", value: num(9) },
      { kind: "restart", value: num(3) },
    ]);
    expect(action("ALTER id DROP IDENTITY")).toEqual({ kind: "dropIdentity", column: "id" });
    expect(action("ALTER COLUMN id DROP IDENTITY IF EXISTS")).toEqual({
      kind: "dropIdentity",
      column: "id",
      ifExists: true,
    });
    // The run ends at a comma, like any action.
    expect(alter("ALTER TABLE t ALTER a RESTART, ALTER b SET GENERATED ALWAYS;").actions).toEqual([
      { kind: "alterIdentity", column: "a", options: [{ kind: "restart", value: null }] },
      { kind: "alterIdentity", column: "b", options: [{ kind: "generated", generated: "always" }] },
    ]);
  });

  it("parses TYPE … COLLATE … USING and SET EXPRESSION / DROP EXPRESSION", () => {
    expect(action("ALTER COLUMN email TYPE varchar(320) USING lower(email)")).toEqual({
      kind: "setDataType",
      column: "email",
      dataType: ct("varchar", { args: [320] }),
      using: { kind: "call", name: "lower", args: [name("email")] },
    });
    expect(action('ALTER c SET DATA TYPE text COLLATE "C"')).toEqual({
      kind: "setDataType",
      column: "c",
      dataType: ct("text"),
      collate: ["C"],
    });
    expect(action("ALTER c SET EXPRESSION AS (a + 1)")).toEqual({
      kind: "setExpression",
      column: "c",
      expr: bin("+", name("a"), num(1)),
    });
    expect(action("ALTER COLUMN c DROP EXPRESSION")).toEqual({ kind: "dropExpression", column: "c" });
    expect(action("ALTER c DROP EXPRESSION IF EXISTS")).toEqual({
      kind: "dropExpression",
      column: "c",
      ifExists: true,
    });
  });

  it("parses SET STATISTICS, STORAGE, COMPRESSION and per-column options", () => {
    expect(action("ALTER COLUMN c SET STATISTICS 500")).toEqual({ kind: "setStatistics", column: "c", value: 500 });
    expect(action("ALTER c SET STATISTICS -1").value).toBe(-1);
    expect(action("ALTER c SET STATISTICS DEFAULT").value).toBeNull();
    for (const mode of ["plain", "external", "extended", "main"]) {
      expect(action(`ALTER c SET STORAGE ${mode.toUpperCase()}`)).toEqual({
        kind: "setStorage",
        column: "c",
        storage: mode,
      });
    }
    expect(action("ALTER c SET STORAGE DEFAULT").storage).toBeNull();
    expect(action('ALTER c SET STORAGE "MAIN"').storage).toBe("main");
    expect(action('ALTER c SET STORAGE "Default"').storage).toBeNull();
    expect(action("ALTER c SET COMPRESSION lz4")).toEqual({ kind: "setCompression", column: "c", method: "lz4" });
    expect(action("ALTER c SET COMPRESSION DEFAULT").method).toBeNull();
    expect(action('ALTER c SET COMPRESSION "default"').method).toBeNull();
    expect(action('ALTER c SET COMPRESSION "DEFAULT"').method).toBe("DEFAULT");
    expect(action("ALTER c SET (n_distinct = -1)")).toEqual({
      kind: "setColumnOptions",
      column: "c",
      options: [{ name: "n_distinct", value: num(-1) }],
    });
    expect(action("ALTER c RESET (n_distinct)")).toEqual({
      kind: "resetColumnOptions",
      column: "c",
      options: [{ name: "n_distinct", value: null }],
    });
  });

  it("parses DROP COLUMN with IF EXISTS and a drop behavior", () => {
    expect(action("DROP COLUMN IF EXISTS legacy CASCADE")).toEqual({
      kind: "dropColumn",
      name: "legacy",
      ifExists: true,
      behavior: "cascade",
    });
    expect(action("DROP legacy RESTRICT")).toEqual({ kind: "dropColumn", name: "legacy", behavior: "restrict" });
    // `if` is still a column name when no EXISTS follows it.
    expect(action("DROP if")).toEqual({ kind: "dropColumn", name: "if" });
  });

  it("rejects what PG rejects", () => {
    expect(fails("ALTER TABLE t ALTER id SET RESTART 5;")).toThrow(
      /sequence option "restart" not supported here \(1:27\)/,
    );
    expect(fails("ALTER TABLE t ALTER id SET OWNED BY NONE;")).toThrow(/sequence option "owned_by" not supported here/);
    expect(fails("ALTER TABLE t ALTER id SET AS bigint;")).toThrow(/sequence option "as" not supported here/);
    expect(fails("ALTER TABLE t ALTER id SET SEQUENCE NAME q;")).toThrow(
      /sequence option "sequence_name" not supported here/,
    );
    // SET takes one option; a second needs its own SET.
    expect(fails("ALTER TABLE t ALTER id SET INCREMENT 2 START 1;")).toThrow(/Expected ";" but found "start"/);
    expect(fails("ALTER TABLE t ALTER c SET GENERATED ALWAYS SET DEFAULT 1;")).toThrow(
      /Expected "generated" or a sequence option but found "default" \(1:47\)/,
    );
    expect(fails("ALTER TABLE t ALTER c RESTART SET NOT NULL;")).toThrow(
      /Expected "generated" or a sequence option but found "not"/,
    );
    expect(fails("ALTER TABLE t ALTER id SET NO frob;")).toThrow(
      /Expected "minvalue", "maxvalue" or "cycle" but found "frob"/,
    );
    expect(fails("ALTER TABLE t ALTER id ADD GENERATED AS IDENTITY;")).toThrow(
      /Expected "always" or "by default" but found "as"/,
    );
    expect(fails("ALTER TABLE t ALTER id ADD GENERATED ALWAYS AS IDENTITY ();")).toThrow(
      /Expected a sequence option but found "\)"/,
    );
    // SEQUENCE NAME names an identity column's sequence only.
    expect(fails("CREATE SEQUENCE s SEQUENCE NAME q;")).toThrow(/Expected ";" but found "sequence"/);
    expect(fails("ALTER SEQUENCE s SEQUENCE NAME q;")).toThrow(/but found "sequence"/);
    expect(fails("ALTER TABLE t ALTER c SET STORAGE frob;")).toThrow(/invalid storage type "frob" \(1:34\)/);
    expect(fails('ALTER TABLE t ALTER c SET STORAGE "MAINX";')).toThrow(/invalid storage type "MAINX"/);
    expect(fails("ALTER TABLE t ALTER c SET STATISTICS x;")).toThrow(/Expected an integer but found "x"/);
    expect(fails("ALTER TABLE t ALTER c SET frob;")).toThrow(
      /Expected "\(", "default", "not", "data", "expression", "statistics", "storage", "compression", "generated" or a sequence option but found "frob" \(1:26\)/,
    );
    expect(fails("ALTER TABLE t ALTER c frob;")).toThrow(
      expectsKeys(["type", "set", "reset", "drop", "add", "restart"], '"frob"'),
    );
    expect(fails("ALTER TABLE t ALTER c DROP frob;")).toThrow(
      /Expected "default", "not", "expression" or "identity" but found "frob"/,
    );
    expect(fails("ALTER TABLE t ALTER c DROP IDENTITY IF;")).toThrow(/Expected "exists" but found ";"/);
    expect(fails("ALTER TABLE t ALTER c SET EXPRESSION (a);")).toThrow(/Expected "as" but found "\("/);
    expect(fails("ALTER TABLE t ALTER c TYPE int USING;")).toThrow(/but found ";"/);
    expect(fails("ALTER TABLE t ALTER c RESET (a = 1);")).toThrow(/RESET must not include values for parameters/);
  });

  it("keeps the column-action words unreserved as names and aliases", () => {
    const words = [
      "statistics",
      "storage",
      "compression",
      "identity",
      "expression",
      "generated",
      "restart",
      "plain",
      "external",
      "extended",
      "main",
      "data",
      "sequence",
    ];
    const columns = words.map((w) => `${w} int`).join(", ");
    expect(firstStmt(`CREATE TABLE t (${columns});`).items.map((i: any) => i.name)).toEqual(words);
    expect(firstStmt(`SELECT 1 AS ${words.join(", 1 AS ")} FROM t;`).columns.map((c: any) => c.alias)).toEqual(words);
    expect(firstStmt(`SELECT ${words.join(", ")} FROM storage;`).from).toEqual([
      { kind: "table", name: ["storage"], alias: null },
    ]);
    // …and as the columns these actions name.
    const altered = alter(`ALTER TABLE t ${words.map((w) => `ALTER ${w} SET STATISTICS 1`).join(", ")};`).actions;
    expect(altered.map((a: any) => a.column)).toEqual(words);
    expect(action("ALTER storage SET STORAGE plain")).toEqual({
      kind: "setStorage",
      column: "storage",
      storage: "plain",
    });
    expect(action("ALTER restart RESTART")).toMatchObject({ kind: "alterIdentity", column: "restart" });
    expect(action("ALTER identity DROP IDENTITY")).toEqual({ kind: "dropIdentity", column: "identity" });
    expect(action("ALTER c SET COMPRESSION compression").method).toBe("compression");
  });
});

// --- ALTER TABLE table-level actions: RLS, rules, inheritance, persistence ---

describe("SQL-lite ALTER TABLE table-level actions", () => {
  const alter = (text: string) => firstStmt(text) as any;
  const action = (src: string) => {
    const { actions } = alter(`ALTER TABLE t ${src};`);
    expect(actions).toHaveLength(1);
    return actions[0];
  };
  const fails = (text: string) => () => sqlLite.parse(text);

  it("parses the four row-level security switches", () => {
    expect(alter("ALTER TABLE app.orders ENABLE ROW LEVEL SECURITY;")).toEqual({
      kind: "alterTable",
      ifExists: false,
      name: ["app", "orders"],
      actions: [{ kind: "rowSecurity", action: "enable" }],
    });
    expect(action("DISABLE ROW LEVEL SECURITY")).toEqual({ kind: "rowSecurity", action: "disable" });
    expect(action("FORCE ROW LEVEL SECURITY")).toEqual({ kind: "rowSecurity", action: "force" });
    expect(action("NO FORCE ROW LEVEL SECURITY")).toEqual({ kind: "rowSecurity", action: "noForce" });
  });

  it("parses ENABLE / DISABLE RULE", () => {
    expect(action("ENABLE RULE r")).toEqual({ kind: "enableRule", rule: "r" });
    expect(action("ENABLE REPLICA RULE r")).toEqual({ kind: "enableRule", mode: "replica", rule: "r" });
    expect(action("ENABLE ALWAYS RULE r")).toEqual({ kind: "enableRule", mode: "always", rule: "r" });
    expect(action("DISABLE RULE r")).toEqual({ kind: "disableRule", rule: "r" });
  });

  it("parses [NO] INHERIT, OF and NOT OF", () => {
    expect(action("INHERIT base_users")).toEqual({ kind: "inherit", parent: ["base_users"] });
    expect(action("NO INHERIT s.base")).toEqual({ kind: "noInherit", parent: ["s", "base"] });
    expect(action("OF s.person")).toEqual({ kind: "of", type: ["s", "person"] });
    expect(action("NOT OF")).toEqual({ kind: "notOf" });
  });

  it("parses SET LOGGED / UNLOGGED, SET ACCESS METHOD and SET WITHOUT OIDS", () => {
    expect(action("SET LOGGED")).toEqual({ kind: "setLogged" });
    expect(action("SET UNLOGGED")).toEqual({ kind: "setUnlogged" });
    expect(action("SET ACCESS METHOD heap2")).toEqual({ kind: "setAccessMethod", method: "heap2" });
    expect(action("SET ACCESS METHOD DEFAULT")).toEqual({ kind: "setAccessMethod", method: null });
    expect(action("SET WITHOUT OIDS")).toEqual({ kind: "setWithoutOids" });
  });

  it("parses ALTER CONSTRAINT's deferral attributes", () => {
    expect(action("ALTER CONSTRAINT orders_user_fk DEFERRABLE INITIALLY DEFERRED")).toEqual({
      kind: "alterConstraint",
      name: "orders_user_fk",
      attrs: { deferrable: true, initially: "deferred" },
    });
    expect(action("ALTER CONSTRAINT k NOT DEFERRABLE")).toEqual({
      kind: "alterConstraint",
      name: "k",
      attrs: { deferrable: false },
    });
    expect(action("ALTER CONSTRAINT k")).toEqual({ kind: "alterConstraint", name: "k", attrs: {} });
  });

  it("composes the new actions in one list", () => {
    const { actions } = alter(
      "ALTER TABLE t ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY, DISABLE RULE r, INHERIT p, " +
        "NOT OF, SET UNLOGGED, ALTER CONSTRAINT k DEFERRABLE, VALIDATE CONSTRAINT k, ALTER c SET STATISTICS 5, " +
        "DROP COLUMN IF EXISTS d;",
    );
    expect(actions.map((a: any) => a.kind)).toEqual([
      "rowSecurity",
      "rowSecurity",
      "disableRule",
      "inherit",
      "notOf",
      "setUnlogged",
      "alterConstraint",
      "validateConstraint",
      "setStatistics",
      "dropColumn",
    ]);
  });

  it("rejects malformed table-level actions", () => {
    expect(fails("ALTER TABLE t ENABLE ROW SECURITY;")).toThrow(/Expected "level" but found "security"/);
    expect(fails("ALTER TABLE t FORCE TRIGGER x;")).toThrow(/Expected "row level security" but found "trigger"/);
    expect(fails("ALTER TABLE t NO frob;")).toThrow(/Expected "force" or "inherit" but found "frob"/);
    expect(fails("ALTER TABLE t NOT NULL;")).toThrow(/Expected "of" but found "null"/);
    expect(fails("ALTER TABLE t DISABLE ALWAYS RULE r;")).toThrow(
      /Expected "trigger", "rule" or "row" but found "always"/,
    );
    expect(fails("ALTER TABLE t ENABLE RULE;")).toThrow(/Expected a name but found ";"/);
    expect(fails("ALTER TABLE t SET ACCESS heap;")).toThrow(/Expected "method" but found "heap"/);
    // PG reads only the deferral attributes on ALTER CONSTRAINT.
    expect(fails("ALTER TABLE t ALTER CONSTRAINT k NOT VALID;")).toThrow(
      /ALTER CONSTRAINT statement constraints cannot be marked NOT VALID \(1:33\)/,
    );
    expect(fails("ALTER TABLE t ALTER CONSTRAINT k NO INHERIT;")).toThrow(
      /ALTER CONSTRAINT statement constraints cannot be marked NO INHERIT/,
    );
    expect(fails("ALTER TABLE t ALTER CONSTRAINT k NOT DEFERRABLE INITIALLY DEFERRED;")).toThrow(
      /constraint declared INITIALLY DEFERRED must be DEFERRABLE/,
    );
  });

  it("keeps the table-level action words unreserved as names and aliases", () => {
    const words = [
      "row",
      "level",
      "security",
      "force",
      "rule",
      "inherit",
      "logged",
      "unlogged",
      "access",
      "method",
      "oids",
      "of",
      "no",
    ];
    const columns = words.map((w) => `${w} int`).join(", ");
    expect(firstStmt(`CREATE TABLE t (${columns});`).items.map((i: any) => i.name)).toEqual(words);
    expect(firstStmt(`SELECT 1 AS ${words.join(", 1 AS ")} FROM t;`).columns.map((c: any) => c.alias)).toEqual(words);
    // …as the columns ADD and DROP take, and as the names the actions take.
    const added = alter(`ALTER TABLE t ${words.map((w) => `ADD ${w} int`).join(", ")};`).actions;
    expect(added.map((a: any) => a.column.name)).toEqual(words);
    const dropped = alter(`ALTER TABLE t ${words.map((w) => `DROP ${w}`).join(", ")};`).actions;
    expect(dropped.map((a: any) => a.name)).toEqual(words);
    expect(action("ENABLE RULE rule")).toEqual({ kind: "enableRule", rule: "rule" });
    expect(action("INHERIT inherit")).toEqual({ kind: "inherit", parent: ["inherit"] });
    expect(action("SET ACCESS METHOD method")).toEqual({ kind: "setAccessMethod", method: "method" });
    expect(alter("ALTER TABLE security FORCE ROW LEVEL SECURITY;").name).toEqual(["security"]);
  });
});

// --- ALTER INDEX / MATERIALIZED VIEW additions and ALL IN TABLESPACE ---

describe("SQL-lite ALTER INDEX ATTACH PARTITION, ALL IN TABLESPACE and matview SET TABLESPACE", () => {
  const stmt = (text: string) => firstStmt(text) as any;
  const fails = (text: string) => () => sqlLite.parse(text);

  it("parses ALTER INDEX … ATTACH PARTITION and ALTER [COLUMN] n SET STATISTICS", () => {
    expect(stmt("ALTER INDEX app.events_idx ATTACH PARTITION app.events_2025_idx;")).toEqual({
      kind: "alterIndex",
      ifExists: false,
      name: ["app", "events_idx"],
      actions: [{ kind: "attachPartition", partition: ["app", "events_2025_idx"] }],
    });
    expect(stmt("ALTER INDEX i ALTER COLUMN 2 SET STATISTICS 100, ALTER 1 SET STATISTICS DEFAULT;").actions).toEqual([
      { kind: "setStatistics", column: 2, value: 100 },
      { kind: "setStatistics", column: 1, value: null },
    ]);
  });

  it("parses ALL IN TABLESPACE for tables, indexes and materialized views", () => {
    expect(stmt("ALTER TABLE ALL IN TABLESPACE old_space OWNED BY app SET TABLESPACE new_space;")).toEqual({
      kind: "alterAllInTablespace",
      objectType: "table",
      tablespace: "old_space",
      ownedBy: ["app"],
      newTablespace: "new_space",
    });
    expect(stmt("ALTER INDEX ALL IN TABLESPACE a OWNED BY r, CURRENT_USER SET TABLESPACE b NOWAIT;")).toEqual({
      kind: "alterAllInTablespace",
      objectType: "index",
      tablespace: "a",
      ownedBy: ["r", "current_user"],
      newTablespace: "b",
      nowait: true,
    });
    expect(stmt("ALTER MATERIALIZED VIEW ALL IN TABLESPACE a SET TABLESPACE b;")).toEqual({
      kind: "alterAllInTablespace",
      objectType: "materialized view",
      tablespace: "a",
      newTablespace: "b",
    });
  });

  it("parses ALTER MATERIALIZED VIEW … SET TABLESPACE", () => {
    expect(stmt("ALTER MATERIALIZED VIEW order_stats SET TABLESPACE fastspace;")).toEqual({
      kind: "alterView",
      materialized: true,
      ifExists: false,
      name: ["order_stats"],
      actions: [{ kind: "setTablespace", tablespace: "fastspace" }],
    });
  });

  it("spans the whole statement", () => {
    const [node] = sqlLite.parse("ALTER TABLE ALL IN TABLESPACE a SET TABLESPACE b;") as Record<string, any>[];
    expect(node!.span).toEqual({ start: { row: 1, col: 0 }, end: { row: 1, col: 48 } });
  });

  it("rejects malformed forms, and ATTACH PARTITION beside another action", () => {
    expect(fails("ALTER INDEX i ATTACH PARTITION j, RENAME TO k;")).toThrow(
      /ATTACH PARTITION cannot be combined with other ALTER INDEX actions \(1:14\)/,
    );
    expect(fails("ALTER INDEX i ALTER COLUMN c SET STATISTICS 1;")).toThrow(/Expected a column number but found "c"/);
    expect(fails("ALTER INDEX i ALTER 1 SET STATISTICS 2, ATTACH PARTITION j;")).toThrow(
      /ATTACH PARTITION cannot be combined with other ALTER INDEX actions/,
    );
    expect(fails("ALTER INDEX i ATTACH j;")).toThrow(/Expected "partition" but found "j"/);
    expect(fails("ALTER INDEX IF EXISTS i ATTACH PARTITION j;")).toThrow(
      /ALTER INDEX IF EXISTS cannot ATTACH PARTITION \(1:24\)/,
    );
    expect(fails("ALTER TABLE ALL IN TABLESPACE a SET TABLESPACE;")).toThrow(/Expected a name but found ";"/);
    expect(fails("ALTER TABLE ALL IN TABLESPACE a RENAME TO b;")).toThrow(
      /Expected "set tablespace" but found "rename"/,
    );
    expect(fails("ALTER TABLE ALL IN SCHEMA a SET TABLESPACE b;")).toThrow(/Expected "tablespace" but found "schema"/);
    // SET TABLESPACE is a materialized view's, not a plain view's.
    expect(fails("ALTER VIEW v SET TABLESPACE x;")).toThrow(/Expected "\(" or "schema" but found "tablespace"/);
    expect(fails("ALTER MATERIALIZED VIEW v SET frob;")).toThrow(
      /Expected "\(", "schema" or "tablespace" but found "frob"/,
    );
  });

  it("keeps the new words unreserved as names and aliases", () => {
    const words = ["attach", "partition", "nowait", "owned", "tablespace", "statistics"];
    const columns = words.map((w) => `${w} int`).join(", ");
    expect(firstStmt(`CREATE TABLE t (${columns});`).items.map((i: any) => i.name)).toEqual(words);
    expect(firstStmt(`SELECT 1 AS ${words.join(", 1 AS ")} FROM t;`).columns.map((c: any) => c.alias)).toEqual(words);
    expect(stmt("ALTER INDEX attach ATTACH PARTITION partition;")).toMatchObject({
      name: ["attach"],
      actions: [{ partition: ["partition"] }],
    });
    expect(stmt("ALTER TABLE ALL IN TABLESPACE tablespace OWNED BY owned SET TABLESPACE nowait;")).toMatchObject({
      tablespace: "tablespace",
      ownedBy: ["owned"],
      newTablespace: "nowait",
    });
  });
});

// --- multi-column UPDATE assignments ---

describe("SQL-lite multi-column UPDATE assignments", () => {
  const setOf = (src: string) => firstStmt(`UPDATE t SET ${src};`).set;
  const conflictSetOf = (src: string) =>
    firstStmt(`INSERT INTO t VALUES (1) ON CONFLICT (a) DO UPDATE SET ${src};`).onConflict.action.set;
  const row = (items: unknown[], implicit = true) => ({ kind: "row", items, ...(implicit && { implicit }) });
  const DEFAULT = { kind: "default" };
  const bad = (src: string) => () => sqlLite.parse(src);

  it("parses a parenthesised row, ROW() and a subquery as the source", () => {
    expect(setOf("(a, b) = (1, 2)")).toEqual([{ columns: ["a", "b"], value: row([num(1), num(2)]) }]);
    expect(setOf("(a, b) = ROW(1, 2)")).toEqual([{ columns: ["a", "b"], value: row([num(1), num(2)], false) }]);
    expect(setOf("(a) = ROW(1)")).toEqual([{ columns: ["a"], value: row([num(1)], false) }]);
    expect(setOf("(a, b) = (SELECT x, y FROM u)")).toEqual([
      {
        columns: ["a", "b"],
        value: { kind: "subquery", query: firstStmt("SELECT x, y FROM u;") },
      },
    ]);
    expect(setOf("(a, b) = (WITH w AS (SELECT 1, 2) SELECT * FROM w)")[0].value.kind).toBe("subquery");
    expect(setOf("(a, b) = ((SELECT 1), 2)")).toEqual([
      { columns: ["a", "b"], value: row([{ kind: "subquery", query: firstStmt("SELECT 1;") }, num(2)]) },
    ]);
    // Extra parentheses around a row or a subquery are transparent.
    expect(setOf("(a, b) = ((1, 2))")).toEqual(setOf("(a, b) = (1, 2)"));
    expect(setOf("(a, b) = ((SELECT x, y FROM u))")).toEqual(setOf("(a, b) = (SELECT x, y FROM u)"));
  });

  it("takes DEFAULT as a row item and mixes with single-column items", () => {
    expect(setOf("(a, b) = (DEFAULT, 1), c = 3, (d, e) = ROW(DEFAULT, DEFAULT)")).toEqual([
      { columns: ["a", "b"], value: row([DEFAULT, num(1)]) },
      { column: "c", value: num(3) },
      { columns: ["d", "e"], value: row([DEFAULT, DEFAULT], false) },
    ]);
  });

  it("leaves single-column assignments unchanged", () => {
    expect(setOf("a = 1, b = (1, 2)")).toEqual([
      { column: "a", value: num(1) },
      { column: "b", value: row([num(1), num(2)]) },
    ]);
    expect(conflictSetOf("a = 2")).toEqual([{ column: "a", value: num(2) }]);
  });

  it("spans an implicit row from its paren and a ROW() from the keyword", () => {
    const [explicit, implicit] = (sqlLite.parse("UPDATE t SET (a) = ROW(1), (b, c) = (2, 3);")[0] as any).set;
    expect(explicit.value.span).toEqual({ start: { row: 1, col: 19 }, end: { row: 1, col: 25 } });
    expect(implicit.value.span).toEqual({ start: { row: 1, col: 36 }, end: { row: 1, col: 42 } });
  });

  it("parses the same forms under ON CONFLICT DO UPDATE", () => {
    expect(conflictSetOf("(a, b) = (excluded.a, DEFAULT), c = 4")).toEqual([
      { columns: ["a", "b"], value: row([name("excluded", "a"), DEFAULT]) },
      { column: "c", value: num(4) },
    ]);
    expect(conflictSetOf("(a) = ROW(DEFAULT)")).toEqual([{ columns: ["a"], value: row([DEFAULT], false) }]);
    expect(conflictSetOf("(a, b) = (SELECT 1, 2)")[0].value.kind).toBe("subquery");
  });

  it("keeps row unreserved", () => {
    expect(setOf("row = 1, (row, a) = (row, ROW(1))")).toEqual([
      { column: "row", value: num(1) },
      { columns: ["row", "a"], value: row([name("row"), row([num(1)], false)]) },
    ]);
  });

  it("rejects a non-row source, an empty target list and a count mismatch", () => {
    expect(bad("UPDATE t SET (a) = row;")).toThrow(/but found "row" \(1:19\)/);
    expect(bad("UPDATE t SET (a, b) = 1;")).toThrow(/Expected a row constructor or a subquery but found "1" \(1:22\)/);
    expect(bad("UPDATE t SET () = ();")).toThrow(/Expected a name but found "\)" \(1:14\)/);
    expect(bad("UPDATE t SET (a) = (1);")).toThrow(/a subquery as a multi-column assignment source \(1:19\)/);
    expect(bad("UPDATE t SET (a, b) = (1, 2, 3);")).toThrow(
      /Expected 2 values for 2 assigned columns but found 3 \(1:22\)/,
    );
    expect(bad("UPDATE t SET (a, b) = ROW();")).toThrow(/Expected 2 values for 2 assigned columns but found 0/);
    expect(bad("UPDATE t SET (a, b) = ((1, 2, 3));")).toThrow(/assigned columns but found 3 \(1:23\)/);
    expect(bad("UPDATE t SET (a) = (DEFAULT), b = 1;")).toThrow(/assignment source \(1:19\)/);
    expect(bad("INSERT INTO t VALUES (1) ON CONFLICT (a) DO UPDATE SET (a, b) = 1;")).toThrow(
      /Expected a row constructor or a subquery but found "1"/,
    );
    expect(bad("UPDATE t SET (a, b) = (1, 2) OVERLAPS (3, 4);")).toThrow(/Expected ";" but found "overlaps"/);
    expect(bad("UPDATE t SET (a, b) = (SELECT 1, 2) + 1;")).toThrow(/Expected ";" but found "\+"/);
    expect(bad("UPDATE t SET = 1;")).toThrow(/Expected "\(" or a name but found "="/);
  });
});

// --- ONLY targets, WHERE CURRENT OF and SET col = DEFAULT ---

describe("SQL-lite ONLY targets, WHERE CURRENT OF and SET col = DEFAULT", () => {
  const update = (over: Record<string, unknown>) => ({
    kind: "update",
    table: ["t"],
    alias: null,
    set: [{ column: "a", value: num(1) }],
    from: null,
    where: null,
    returning: null,
    ...over,
  });
  const del = (over: Record<string, unknown>) => ({
    kind: "delete",
    table: ["t"],
    alias: null,
    using: null,
    where: null,
    returning: null,
    ...over,
  });
  const truncate = (names: string[][], over: Record<string, unknown> = {}) => ({
    kind: "truncate",
    names,
    identity: null,
    behavior: null,
    ...over,
  });
  const DEFAULT = { kind: "default" };
  const bad = (src: string) => () => sqlLite.parse(src);

  it("records ONLY on an UPDATE target and drops the * suffix", () => {
    expect(firstStmt("UPDATE ONLY t SET a = 1;")).toEqual(update({ only: true }));
    expect(firstStmt("UPDATE ONLY (s.t) AS x SET a = 1;")).toEqual(
      update({ table: ["s", "t"], only: true, alias: "x" }),
    );
    expect(firstStmt("UPDATE t * x SET a = 1;")).toEqual(update({ alias: "x" }));
    expect(firstStmt("UPDATE t * SET a = 1;")).toEqual(firstStmt("UPDATE t SET a = 1;"));
  });

  it("records ONLY on a DELETE target and drops the * suffix", () => {
    expect(firstStmt("DELETE FROM ONLY t;")).toEqual(del({ only: true }));
    expect(firstStmt("DELETE FROM ONLY (t) x WHERE x.a = 1;")).toEqual(
      del({ only: true, alias: "x", where: bin("=", name("x", "a"), num(1)) }),
    );
    expect(firstStmt("DELETE FROM s.t * AS x;")).toEqual(del({ table: ["s", "t"], alias: "x" }));
  });

  it("records ONLY per TRUNCATE table, only when some table has it", () => {
    expect(firstStmt("TRUNCATE ONLY a;")).toEqual(truncate([["a"]], { only: [true] }));
    expect(firstStmt("TRUNCATE TABLE ONLY a, b *, ONLY (s.c) RESTART IDENTITY CASCADE;")).toEqual(
      truncate([["a"], ["b"], ["s", "c"]], { only: [true, false, true], identity: "restart", behavior: "cascade" }),
    );
    expect(firstStmt("TRUNCATE a *, b;")).toEqual(truncate([["a"], ["b"]]));
  });

  it("reads WHERE CURRENT OF on UPDATE and DELETE", () => {
    expect(firstStmt("UPDATE ONLY t AS x SET a = 1 FROM u WHERE CURRENT OF c RETURNING a;")).toEqual(
      update({
        only: true,
        alias: "x",
        from: [tableFrom(["u"])],
        currentOf: "c",
        returning: [col(name("a"))],
      }),
    );
    expect(firstStmt('DELETE FROM t USING u WHERE CURRENT OF "Cur" RETURNING *;')).toEqual(
      del({ using: [tableFrom(["u"])], currentOf: "Cur", returning: [col(star())] }),
    );
  });

  it("omits only and currentOf when absent", () => {
    for (const src of ["UPDATE t SET a = 1 WHERE a;", "DELETE FROM t WHERE a;"]) {
      expect(firstStmt(src)).not.toHaveProperty("only");
      expect(firstStmt(src)).not.toHaveProperty("currentOf");
    }
    expect(firstStmt("TRUNCATE a, b;")).not.toHaveProperty("only");
  });

  it("reports a bad character after WHERE current", () => {
    expect(() => sqlLite.parse("DELETE FROM t WHERE current \\;")).toThrow(/Unexpected character "\\"/);
    expect(sqlLite.diagnose("DELETE FROM t WHERE current \\;").errors.map((e) => e.message)).toEqual([
      'Unexpected character "\\" (1:28)',
    ]);
  });

  it("takes a bare DEFAULT as a single-column value, in UPDATE, ON CONFLICT and MERGE", () => {
    expect(firstStmt("UPDATE t SET a = DEFAULT, b = 2, (c, d) = (DEFAULT, 3);").set).toEqual([
      { column: "a", value: DEFAULT },
      { column: "b", value: num(2) },
      { columns: ["c", "d"], value: { kind: "row", items: [DEFAULT, num(3)], implicit: true } },
    ]);
    expect(
      firstStmt("INSERT INTO t VALUES (1) ON CONFLICT (a) DO UPDATE SET a = DEFAULT;").onConflict.action.set,
    ).toEqual([{ column: "a", value: DEFAULT }]);
    expect(
      firstStmt("MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET a = DEFAULT, b = s.b;").when[0]
        .action,
    ).toEqual({
      kind: "update",
      set: [
        { column: "a", value: DEFAULT },
        { column: "b", value: name("s", "b") },
      ],
    });
  });

  it("keeps current and of unreserved as names and aliases", () => {
    expect(firstStmt("UPDATE current SET current = current WHERE current;")).toEqual(
      update({ table: ["current"], set: [{ column: "current", value: name("current") }], where: name("current") }),
    );
    expect(firstStmt("UPDATE t AS current SET of = 1 WHERE current.of = of;")).toEqual(
      update({
        alias: "current",
        set: [{ column: "of", value: num(1) }],
        where: bin("=", name("current", "of"), name("of")),
      }),
    );
    expect(firstStmt("DELETE FROM of AS current WHERE current OR of;")).toEqual(
      del({ table: ["of"], alias: "current", where: bin("or", name("current"), name("of")) }),
    );
    expect(firstStmt("DELETE FROM t WHERE CURRENT OF of;")).toEqual(del({ currentOf: "of" }));
    expect(firstStmt("UPDATE t SET a = 1 WHERE CURRENT OF current;")).toEqual(update({ currentOf: "current" }));
    expect(firstStmt("SELECT current, of FROM current AS of;").columns).toEqual([
      col(name("current")),
      col(name("of")),
    ]);
  });

  it("rejects the malformed forms", () => {
    // `*` cannot follow ONLY, and ONLY needs a name.
    expect(bad("UPDATE ONLY t * SET a = 1;")).toThrow(/Expected "set" but found "\*" \(1:14\)/);
    expect(bad("DELETE FROM ONLY t *;")).toThrow(/found "\*" \(1:19\)/);
    expect(bad("UPDATE ONLY SET a = 1;")).toThrow(/Expected a name but found "set" \(1:12\)/);
    expect(bad("UPDATE ONLY (t) * SET a = 1;")).toThrow(/Expected "set" but found "\*"/);
    expect(bad("TRUNCATE ONLY a *;")).toThrow(/found "\*" \(1:16\)/);
    expect(bad("TRUNCATE ONLY (a, b);")).toThrow(/Expected "\)" but found ","/);
    // Quoted spellings are names, not the keyword pair.
    expect(bad('DELETE FROM t WHERE "current" OF c;')).toThrow(/Expected ";" but found "of"/);
    expect(bad('DELETE FROM t WHERE CURRENT "of" c;')).toThrow(/Expected ";" but found "of"/);
    // CURRENT OF needs one cursor name and ends the WHERE clause.
    expect(bad("DELETE FROM t WHERE CURRENT OF c.d;")).toThrow(/Expected ";" but found "\." \(1:32\)/);
    expect(bad("DELETE FROM t WHERE CURRENT OF;")).toThrow(/Expected a name but found ";"/);
    expect(bad("DELETE FROM t WHERE CURRENT OF c AND x;")).toThrow(/Expected ";" but found "and"/);
    expect(bad("UPDATE t SET a = 1 WHERE CURRENT OF c FROM u;")).toThrow(/Expected ";" but found "from"/);
    // ON CONFLICT's WHERE is a plain condition.
    expect(bad("INSERT INTO t VALUES (1) ON CONFLICT (a) DO UPDATE SET a = 1 WHERE CURRENT OF c;")).toThrow(
      /Expected ";" but found "of"/,
    );
    // DEFAULT is a whole value, never an operand (PG rejects these in analysis).
    expect(bad("UPDATE t SET a = DEFAULT + 1;")).toThrow(/Expected ";" but found "\+"/);
    expect(bad("UPDATE t SET a = 1 WHERE a = DEFAULT;")).toThrow(/Expected a name but found "default"/);
    // A parenthesised DEFAULT is a limit of this grammar, which PG would accept.
    expect(bad("UPDATE t SET a = (DEFAULT);")).toThrow(/Expected a name but found "default"/);
  });
});

// --- assignment indirection and ON CONFLICT inference ---

describe("SQL-lite assignment indirection and ON CONFLICT inference", () => {
  const sub = (index: unknown, upper?: unknown) => ({
    kind: "subscript",
    index,
    ...(upper !== undefined && { upper }),
  });
  const fld = (n: string) => ({ kind: "field", name: n });
  const row = (...items: unknown[]) => ({ kind: "row", items, implicit: true });
  const values = (...items: unknown[]) => ({ kind: "values", rows: [items] });
  const conflict = (src: string) => firstStmt(`INSERT INTO t VALUES (1) ON CONFLICT ${src};`).onConflict;
  const key = (expr: unknown, over: Record<string, unknown> = {}) => ({ expr, ...over });
  const lower = { kind: "call", name: "lower", args: [name("email")] };
  const bad = (src: string) => () => sqlLite.parse(src);

  it("reads subscript and field steps on a single UPDATE target", () => {
    expect(firstStmt("UPDATE t SET a[1] = 1, c.f = 2, a[i + 1] = 3;").set).toEqual([
      { column: "a", indirection: [sub(num(1))], value: num(1) },
      { column: "c", indirection: [fld("f")], value: num(2) },
      { column: "a", indirection: [sub(bin("+", name("i"), num(1)))], value: num(3) },
    ]);
  });

  it("reads slices and chained steps", () => {
    expect(firstStmt('UPDATE t SET a[1:2] = x, a[:3] = y, a[2:] = z, a[:] = w, m[1][2].f."G" = 0;').set).toEqual([
      { column: "a", indirection: [sub(num(1), num(2))], value: name("x") },
      { column: "a", indirection: [sub(null, num(3))], value: name("y") },
      { column: "a", indirection: [sub(num(2), null)], value: name("z") },
      { column: "a", indirection: [sub(null, null)], value: name("w") },
      { column: "m", indirection: [sub(num(1)), sub(num(2)), fld("f"), fld("G")], value: num(0) },
    ]);
  });

  it("runs multi-column steps parallel to the columns", () => {
    expect(firstStmt("UPDATE t SET (a[1], b.f, c) = (1, 2, DEFAULT), (d, e) = (SELECT 1, 2);").set).toEqual([
      {
        columns: ["a", "b", "c"],
        indirection: [[sub(num(1))], [fld("f")], []],
        value: row(num(1), num(2), { kind: "default" }),
      },
      { columns: ["d", "e"], value: expect.objectContaining({ kind: "subquery" }) },
    ]);
  });

  it("reads steps under ON CONFLICT DO UPDATE and MERGE's UPDATE SET", () => {
    expect(conflict("(a) DO UPDATE SET a[1] = 1, (b.f) = ROW(2)").action.set).toEqual([
      { column: "a", indirection: [sub(num(1))], value: num(1) },
      { columns: ["b"], indirection: [[fld("f")]], value: { kind: "row", items: [num(2)] } },
    ]);
    expect(
      firstStmt("MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET a[1] = s.a, (b.f, c) = (1, 2);")
        .when[0].action,
    ).toEqual({
      kind: "update",
      set: [
        { column: "a", indirection: [sub(num(1))], value: name("s", "a") },
        { columns: ["b", "c"], indirection: [[fld("f")], []], value: row(num(1), num(2)) },
      ],
    });
  });

  it("reads steps in INSERT's and MERGE's INSERT column lists", () => {
    expect(firstStmt("INSERT INTO t (a[1], b, c.f) OVERRIDING USER VALUE VALUES (1, 2, 3);")).toEqual({
      kind: "insert",
      table: ["t"],
      columns: ["a", "b", "c"],
      indirection: [[sub(num(1))], [], [fld("f")]],
      overriding: "user",
      source: values(num(1), num(2), num(3)),
      onConflict: null,
      returning: null,
    });
    expect(firstStmt("INSERT INTO t (a[1:2]) SELECT x FROM u;")).toMatchObject({
      columns: ["a"],
      indirection: [[sub(num(1), num(2))]],
      source: { kind: "select" },
    });
    expect(
      firstStmt("MERGE INTO t USING s ON t.id = s.id WHEN NOT MATCHED THEN INSERT (a[1], c.f) VALUES (1, 2);").when[0]
        .action,
    ).toEqual({
      kind: "insert",
      columns: ["a", "c"],
      indirection: [[sub(num(1))], [fld("f")]],
      source: values(num(1), num(2)),
    });
  });

  it("omits indirection when no target has steps", () => {
    expect(firstStmt("UPDATE t SET a = 1, (b, c) = (1, 2);").set).toEqual([
      { column: "a", value: num(1) },
      { columns: ["b", "c"], value: row(num(1), num(2)) },
    ]);
    expect(firstStmt("INSERT INTO t (a, b) VALUES (1, 2);")).not.toHaveProperty("indirection");
    const merge = firstStmt("MERGE INTO t USING s ON true WHEN NOT MATCHED THEN INSERT (a) VALUES (1);");
    expect(merge.when[0].action).not.toHaveProperty("indirection");
    // A parenthesised query is still INSERT's source, not a column list.
    expect(firstStmt("INSERT INTO t ((SELECT 1));")).toMatchObject({ columns: null, source: { kind: "select" } });
  });

  it("reads ON CONFLICT index expressions, COLLATE and operator classes", () => {
    expect(conflict("((lower(email))) DO NOTHING")).toEqual({
      target: null,
      inference: { elements: [key(lower)] },
      action: { kind: "nothing" },
    });
    expect(
      conflict('(lower(email) COLLATE "C" text_pattern_ops, (a + b), c s.ops, d COLLATE "de_DE") DO NOTHING'),
    ).toEqual({
      target: null,
      inference: {
        elements: [
          key(lower, { collate: ["C"], opclass: ["text_pattern_ops"] }),
          key(bin("+", name("a"), name("b"))),
          key(name("c"), { opclass: ["s", "ops"] }),
          key(name("d"), { collate: ["de_DE"] }),
        ],
      },
      action: { kind: "nothing" },
    });
  });

  it("reads a WHERE predicate after the ON CONFLICT list", () => {
    expect(conflict("(a, b) WHERE c > 0 DO UPDATE SET a = 1 WHERE d")).toEqual({
      target: null,
      inference: { elements: [key(name("a")), key(name("b"))], where: bin(">", name("c"), num(0)) },
      action: { kind: "update", set: [{ column: "a", value: num(1) }], where: name("d") },
    });
    expect(conflict("((lower(email))) WHERE deleted_at IS NULL DO NOTHING").inference).toEqual({
      elements: [key(lower)],
      where: { kind: "is", expr: name("deleted_at"), negated: false },
    });
  });

  it("keeps a plain ON CONFLICT column list as target", () => {
    expect(conflict('(a, "B") DO NOTHING')).toEqual({ target: ["a", "B"], action: { kind: "nothing" } });
    // A parenthesised column is still the column, as in PG's arbiter inference.
    expect(conflict("((a), b) DO NOTHING")).toEqual({ target: ["a", "b"], action: { kind: "nothing" } });
    // Keyword-like column names stay plain columns through the element reader.
    expect(conflict("(time, year, filter) DO NOTHING").target).toEqual(["time", "year", "filter"]);
    // A WHERE predicate moves even a plain list into inference.
    expect(conflict("(a) WHERE b DO NOTHING")).toEqual({
      target: null,
      inference: { elements: [key(name("a"))], where: name("b") },
      action: { kind: "nothing" },
    });
    expect(conflict("DO NOTHING")).toEqual({ target: null, action: { kind: "nothing" } });
    expect(conflict("ON CONSTRAINT c DO NOTHING")).toEqual({
      target: null,
      constraint: "c",
      action: { kind: "nothing" },
    });
  });

  it("rejects the malformed forms", () => {
    // A target step is `.name` or a bracketed subscript; PG rejects `.*` in analysis.
    expect(bad("UPDATE t SET c.* = 1;")).toThrow(/Expected a field name but found "\*"/);
    expect(bad("INSERT INTO t (c.*) VALUES (1);")).toThrow(/Expected a field name but found "\*"/);
    expect(bad("UPDATE t SET a. = 1;")).toThrow(/Expected a name but found "="/);
    expect(bad("UPDATE t SET a[1 = 1;")).toThrow(/Expected "\]" but found ";"/);
    expect(bad("UPDATE t SET (a[1) = (1);")).toThrow(/Expected "\]" but found "\)"/);
    // Column lists may not be empty.
    expect(bad("INSERT INTO t () VALUES (1);")).toThrow(/Expected a name but found "\)" \(1:15\)/);
    expect(bad("INSERT INTO t () SELECT 1;")).toThrow(/Expected a name but found "\)" \(1:15\)/);
    // A subscript names an index or a slice.
    expect(bad("UPDATE t SET a[] = 1;")).toThrow(/Expected an expression or ":" but found "\]" \(1:15\)/);
    expect(bad("SELECT a[] FROM t;")).toThrow(/Expected an expression or ":" but found "\]"/);
    expect(bad("MERGE INTO t USING s ON true WHEN NOT MATCHED THEN INSERT () VALUES (1);")).toThrow(
      /Expected a name but found "\)"/,
    );
    expect(bad("INSERT INTO t VALUES (1) ON CONFLICT () DO NOTHING;")).toThrow(/but found "\)" \(1:38\)/);
    // An element other than a column or call must be parenthesised.
    expect(bad("INSERT INTO t VALUES (1) ON CONFLICT (a + b) DO NOTHING;")).toThrow(
      /an ON CONFLICT index expression must be parenthesised/,
    );
    expect(bad("INSERT INTO t VALUES (1) ON CONFLICT (t.a) DO NOTHING;")).toThrow(
      /an ON CONFLICT index expression must be parenthesised/,
    );
    // Sort options, which PG's analysis rejects in an arbiter.
    expect(bad("INSERT INTO t VALUES (1) ON CONFLICT (a DESC) DO NOTHING;")).toThrow(/Expected "\)" but found "desc"/);
    expect(bad("INSERT INTO t VALUES (1) ON CONFLICT (a ASC) DO NOTHING;")).toThrow(/Expected "\)" but found "asc"/);
    // WHERE follows a list only, and needs a predicate.
    expect(bad("INSERT INTO t VALUES (1) ON CONFLICT ON CONSTRAINT c WHERE x DO NOTHING;")).toThrow(
      /Expected "do" but found "where"/,
    );
    expect(bad("INSERT INTO t VALUES (1) ON CONFLICT WHERE x DO NOTHING;")).toThrow(/found "where"/);
    expect(bad("INSERT INTO t VALUES (1) ON CONFLICT (a) WHERE DO NOTHING;")).toThrow(/found "do"/);
  });
});

// --- MERGE ---

describe("SQL-lite MERGE", () => {
  const merge = (over: Record<string, unknown>) => ({
    kind: "merge",
    table: ["t"],
    alias: null,
    source: tableFrom(["s"]),
    on: bin("=", name("t", "id"), name("s", "id")),
    when: [],
    returning: null,
    ...over,
  });
  const when = (match: string, action: unknown, condition: unknown = null) => ({ match, condition, action });
  const nothing = { kind: "nothing" };
  const head = "MERGE INTO t USING s ON t.id = s.id";
  const whenOf = (src: string) => firstStmt(`${head} ${src};`).when;
  const bad = (src: string) => () => sqlLite.parse(src);

  it("parses each WHEN form with each of its actions", () => {
    expect(
      firstStmt(
        `${head} WHEN MATCHED AND s.gone THEN DELETE WHEN MATCHED THEN UPDATE SET a = s.a, b = 2 ` +
          "WHEN NOT MATCHED THEN INSERT (id, a) VALUES (s.id, DEFAULT) WHEN NOT MATCHED BY SOURCE THEN DO NOTHING;",
      ),
    ).toEqual(
      merge({
        when: [
          when("matched", { kind: "delete" }, name("s", "gone")),
          when("matched", {
            kind: "update",
            set: [
              { column: "a", value: name("s", "a") },
              { column: "b", value: num(2) },
            ],
          }),
          when("notMatched", {
            kind: "insert",
            columns: ["id", "a"],
            source: { kind: "values", rows: [[name("s", "id"), { kind: "default" }]] },
          }),
          when("notMatchedBySource", nothing),
        ],
      }),
    );
    expect(whenOf("WHEN MATCHED THEN DO NOTHING WHEN NOT MATCHED BY TARGET AND s.a > 0 THEN DO NOTHING")).toEqual([
      when("matched", nothing),
      when("notMatched", nothing, bin(">", name("s", "a"), num(0))),
    ]);
    expect(
      whenOf("WHEN NOT MATCHED BY SOURCE AND t.a THEN UPDATE SET a = 0 WHEN NOT MATCHED BY SOURCE THEN DELETE"),
    ).toEqual([
      when("notMatchedBySource", { kind: "update", set: [{ column: "a", value: num(0) }] }, name("t", "a")),
      when("notMatchedBySource", { kind: "delete" }),
    ]);
  });

  it("takes UPDATE's multi-column assignments, under either UPDATE form", () => {
    const row = (items: unknown[]) => ({ kind: "row", items, implicit: true });
    expect(whenOf("WHEN MATCHED THEN UPDATE SET (a, b) = (s.a, DEFAULT), c = 1")[0].action).toEqual({
      kind: "update",
      set: [
        { columns: ["a", "b"], value: row([name("s", "a"), { kind: "default" }]) },
        { column: "c", value: num(1) },
      ],
    });
    expect(whenOf("WHEN NOT MATCHED BY SOURCE THEN UPDATE SET (a) = ROW(0)")[0].action.set).toEqual([
      { columns: ["a"], value: { kind: "row", items: [num(0)] } },
    ]);
  });

  it("parses INSERT's DEFAULT VALUES, OVERRIDING and bare VALUES forms", () => {
    const actionOf = (src: string) => whenOf(`WHEN NOT MATCHED THEN INSERT ${src}`)[0].action;
    expect(actionOf("DEFAULT VALUES")).toEqual({ kind: "insert", columns: null, source: { kind: "defaultValues" } });
    expect(actionOf("(id) OVERRIDING SYSTEM VALUE VALUES (s.id)")).toEqual({
      kind: "insert",
      columns: ["id"],
      overriding: "system",
      source: { kind: "values", rows: [[name("s", "id")]] },
    });
    expect(actionOf("OVERRIDING USER VALUE VALUES (1, 2)")).toMatchObject({ columns: null, overriding: "user" });
    expect(actionOf("VALUES (DEFAULT)")).toEqual({
      kind: "insert",
      columns: null,
      source: { kind: "values", rows: [[{ kind: "default" }]] },
    });
  });

  it("reads ONLY, aliases, any FROM item as the source, a WITH prefix and RETURNING", () => {
    expect(
      firstStmt(
        "WITH q AS (SELECT 1) MERGE INTO ONLY s.t AS x USING (SELECT * FROM u) AS v (id) ON x.id = v.id " +
          "WHEN MATCHED THEN DELETE RETURNING x.id, *;",
      ),
    ).toEqual(
      merge({
        table: ["s", "t"],
        only: true,
        alias: "x",
        source: {
          kind: "subquery",
          query: sel({ columns: [col(star())], from: [tableFrom(["u"])] }),
          alias: "v",
          columns: ["id"],
        },
        on: bin("=", name("x", "id"), name("v", "id")),
        when: [when("matched", { kind: "delete" })],
        returning: [col(name("x", "id")), col(star())],
        with_: [{ name: "q", columns: null, query: sel({ columns: [col(num(1))] }) }],
        recursive: false,
      }),
    );
    const mergeOf = (src: string) => firstStmt(`MERGE INTO ${src} WHEN MATCHED THEN DELETE;`);
    expect(mergeOf("ONLY (t) x USING s y ON true")).toMatchObject({ only: true, alias: "x", source: { alias: "y" } });
    expect(mergeOf("t * USING s ON true")).not.toHaveProperty("only");
    // The source's own joins take their ON first; the MERGE's ON follows.
    expect(mergeOf("t USING a JOIN b ON a.id = b.id ON t.id = a.id")).toMatchObject({
      source: {
        kind: "join",
        left: tableFrom(["a"]),
        right: tableFrom(["b"]),
        on: bin("=", name("a", "id"), name("b", "id")),
      },
      on: bin("=", name("t", "id"), name("a", "id")),
    });
    expect(mergeOf("t USING generate_series(1, 3) AS g (id) ON t.id = g.id").source).toMatchObject({
      kind: "function",
      alias: "g",
      columns: ["id"],
    });
    expect(mergeOf("t USING (VALUES (1)) AS v (id) ON t.id = v.id").source).toMatchObject({
      kind: "subquery",
      query: { kind: "values" },
    });
  });

  it("is a preparable statement: PREPARE, EXPLAIN and COPY take it", () => {
    const body = `${head} WHEN MATCHED THEN DO NOTHING`;
    expect(firstStmt(`PREPARE p AS ${body};`).query).toMatchObject({ kind: "merge" });
    expect(firstStmt(`EXPLAIN ${body};`).statement).toMatchObject({ kind: "merge" });
    expect(firstStmt(`COPY (${body} RETURNING *) TO STDOUT;`).query).toMatchObject({ kind: "merge" });
  });

  it("is a data-modifying CTE body", () => {
    expect(firstStmt(`WITH x AS (${head} WHEN MATCHED THEN DELETE RETURNING t.id) SELECT * FROM x;`)).toMatchObject({
      kind: "select",
      with_: [{ name: "x", query: { kind: "merge", returning: [col(name("t", "id"))] } }],
    });
  });

  it("keeps merge, matched, by, source, target and nothing unreserved", () => {
    const words = ["merge", "matched", "by", "source", "target", "nothing"];
    expect(firstStmt(`SELECT ${words.join(", ")} FROM merge;`)).toEqual(
      sel({ columns: words.map((w) => col(name(w))), from: [tableFrom(["merge"])] }),
    );
    expect(
      firstStmt(`CREATE TABLE target (${words.map((w) => `${w} int`).join(", ")});`).items.map((i: any) => i.name),
    ).toEqual(words);
    // …and as the names MERGE itself takes.
    expect(
      firstStmt(
        "MERGE INTO merge matched USING source target ON matched.by = target.by " +
          "WHEN NOT MATCHED THEN INSERT (nothing, source) VALUES (target.nothing, target.source);",
      ),
    ).toEqual(
      merge({
        table: ["merge"],
        alias: "matched",
        source: tableFrom(["source"], "target"),
        on: bin("=", name("matched", "by"), name("target", "by")),
        when: [
          when("notMatched", {
            kind: "insert",
            columns: ["nothing", "source"],
            source: { kind: "values", rows: [[name("target", "nothing"), name("target", "source")]] },
          }),
        ],
      }),
    );
  });

  it("rejects an action its WHEN form does not take, and a malformed head or tail", () => {
    expect(bad(`${head} WHEN MATCHED THEN INSERT VALUES (1);`)).toThrow(
      /Expected "update" or "delete" or "do nothing" but found "insert" \(1:54\)/,
    );
    expect(bad(`${head} WHEN NOT MATCHED BY SOURCE THEN INSERT DEFAULT VALUES;`)).toThrow(
      /Expected "update" or "delete" or "do nothing" but found "insert"/,
    );
    expect(bad(`${head} WHEN NOT MATCHED THEN UPDATE SET a = 1;`)).toThrow(
      /Expected "insert" or "do nothing" but found "update"/,
    );
    expect(bad(`${head} WHEN NOT MATCHED BY TARGET THEN DELETE;`)).toThrow(
      /Expected "insert" or "do nothing" but found "delete"/,
    );
    expect(bad("MERGE INTO t USING s WHEN MATCHED THEN DELETE;")).toThrow(/Expected "on" but found "when" \(1:21\)/);
    expect(bad("MERGE t USING s ON true WHEN MATCHED THEN DELETE;")).toThrow(/Expected "into" but found "t"/);
    expect(bad(`${head};`)).toThrow(/Expected "when" but found ";"/);
    expect(bad(`${head} WHEN THEN DELETE;`)).toThrow(/Expected "matched" or "not" but found "then"/);
    expect(bad(`${head} WHEN NOT MATCHED BY x THEN DO NOTHING;`)).toThrow(
      /Expected "source" or "target" but found "x"/,
    );
    expect(bad(`${head} WHEN MATCHED DELETE;`)).toThrow(/Expected "then" but found "delete"/);
    expect(bad(`${head} WHEN MATCHED THEN DO;`)).toThrow(/Expected "nothing" but found ";"/);
    // MERGE's UPDATE takes no WHERE; its INSERT one VALUES row, and no query.
    expect(bad(`${head} WHEN MATCHED THEN UPDATE SET a = 1 WHERE b;`)).toThrow(/Expected ";" but found "where"/);
    expect(bad(`${head} WHEN NOT MATCHED THEN INSERT VALUES (1), (2);`)).toThrow(/Expected ";" but found ","/);
    expect(bad(`${head} WHEN NOT MATCHED THEN INSERT SELECT 1;`)).toThrow(
      /Expected "default values" or "overriding" or "values" but found "select"/,
    );
    expect(bad(`${head} WHEN NOT MATCHED THEN INSERT (a) DEFAULT VALUES;`)).toThrow(
      /Expected "overriding" or "values" but found "default"/,
    );
    expect(bad(`${head} WHEN NOT MATCHED THEN INSERT OVERRIDING SYSTEM VALUE DEFAULT VALUES;`)).toThrow(
      /Expected "values" but found "default"/,
    );
    expect(bad(`${head} WHEN NOT MATCHED THEN INSERT;`)).toThrow(
      /Expected "default values" or "overriding" or "values" but found ";"/,
    );
    expect(bad("MERGE INTO t AS USING s ON true WHEN MATCHED THEN DELETE;")).toThrow(
      /Expected an alias but found "using"/,
    );
    // A malformed MERGE fails inside the statement that holds it.
    expect(bad("COPY (MERGE INTO t USING s WHEN MATCHED THEN DELETE) TO STDOUT;")).toThrow(
      /Expected "on" but found "when" \(1:27\)/,
    );
  });
});

// --- composite and array access, and call-argument forms ---

describe("SQL-lite composite and array access, and call-argument forms", () => {
  const colExpr = (src: string) => (firstStmt(`SELECT ${src} FROM t;`) as any).columns[0].expr;
  const fieldOf = (expr: unknown, field: string | null) => ({ kind: "fieldSelect", expr, field });
  const sub = (base: unknown, index: unknown) => ({ kind: "subscript", base, index });
  const call = (fnName: string, args: unknown[] = [], mods: Record<string, unknown> = {}) => ({
    kind: "call",
    name: fnName,
    args,
    ...mods,
  });
  const arr = (...elements: unknown[]) => ({ kind: "array", elements });
  const row = (...elements: unknown[]) => ({ kind: "array", elements, implicit: true });
  const named = (argName: string, value: unknown) => ({ kind: "namedArg", name: argName, value });
  const bad = (src: string) => () => sqlLite.parse(src);
  const select1 = sel({ columns: [col(num(1))] });

  it("selects a field, or every field, of a parenthesised expression", () => {
    expect(colExpr("(t.composite_col).field")).toEqual(fieldOf(name("t", "composite_col"), "field"));
    expect(colExpr("(compute_row()).*")).toEqual(fieldOf(call("compute_row"), null));
    expect(colExpr("(t.c).a.b")).toEqual(fieldOf(fieldOf(name("t", "c"), "a"), "b"));
    expect(colExpr('(r)."Mixed"')).toEqual(fieldOf(name("r"), "Mixed"));
    // PG's ColLabel would take a reserved word here; like a dotted name's
    // parts, this grammar wants it quoted.
    expect(colExpr('(r)."from"')).toEqual(fieldOf(name("r"), "from"));
    expect(bad("SELECT (r).from FROM t;")).toThrow(/Expected a name but found "from"/);
  });

  it("selects a field of a subquery and of a call", () => {
    expect(colExpr("(SELECT 1).f")).toEqual(fieldOf({ kind: "subquery", query: select1 }, "f"));
    expect(colExpr("(SELECT 1).*")).toEqual(fieldOf({ kind: "subquery", query: select1 }, null));
    expect(colExpr("(s.f(1, 2)).x")).toEqual(fieldOf(call("s.f", [num(1), num(2)]), "x"));
  });

  it("mixes subscripts and field selections in any order", () => {
    expect(colExpr("(arr)[1]")).toEqual(sub(name("arr"), num(1)));
    expect(colExpr("(arr)[1].f")).toEqual(fieldOf(sub(name("arr"), num(1)), "f"));
    expect(colExpr("(r).f[2]")).toEqual(sub(fieldOf(name("r"), "f"), num(2)));
    expect(colExpr("(r).a[1][2].b.*")).toEqual(
      fieldOf(fieldOf(sub(sub(fieldOf(name("r"), "a"), num(1)), num(2)), "b"), null),
    );
    // A column reference takes the same chain once a subscript opens it.
    expect(colExpr("a[1].f")).toEqual(fieldOf(sub(name("a"), num(1)), "f"));
    expect(colExpr("t.a[1].f.*")).toEqual(fieldOf(fieldOf(sub(name("t", "a"), num(1)), "f"), null));
    expect(colExpr("(SELECT a)[1:2]")).toEqual({
      kind: "subscript",
      base: { kind: "subquery", query: sel({ columns: [col(name("a"))] }) },
      index: num(1),
      upper: num(2),
    });
  });

  it("binds the chain tighter than any operator", () => {
    expect(colExpr("-(r).f")).toEqual({ kind: "unary", op: "-", operand: fieldOf(name("r"), "f") });
    expect(colExpr("(r).f::int")).toEqual({ kind: "cast", expr: fieldOf(name("r"), "f"), type: ct("int") });
    expect(colExpr("(r).f + (s).g")).toEqual(bin("+", fieldOf(name("r"), "f"), fieldOf(name("s"), "g")));
    expect(exprOf("(r).f > 0")).toEqual(bin(">", fieldOf(name("r"), "f"), num(0)));
    expect(firstStmt("SELECT (r).f AS x FROM t;").columns).toEqual([col(fieldOf(name("r"), "f"), "x")]);
  });

  it("spans a field selection from its opening parenthesis", () => {
    const [stmt] = sqlLite.parse("SELECT (r).f[1].g FROM t;") as any[];
    const g = stmt.columns[0].expr;
    expect(g.span).toEqual({ start: { row: 1, col: 7 }, end: { row: 1, col: 17 } });
    // The subscript keeps the span the postfix gives it, from its base.
    expect(g.expr.span).toEqual({ start: { row: 1, col: 7 }, end: { row: 1, col: 15 } });
    expect(g.expr.base.span).toEqual({ start: { row: 1, col: 7 }, end: { row: 1, col: 12 } });
    const [chained] = sqlLite.parse("SELECT a[1].f FROM t;") as any[];
    expect(chained.columns[0].expr.span).toEqual({ start: { row: 1, col: 7 }, end: { row: 1, col: 13 } });
  });

  it("takes no indirection where PG takes none", () => {
    // A row constructor, and a field after a bare `.` of nothing.
    expect(bad("SELECT (a, b).f FROM t;")).toThrow(/Expected ";" but found "\."/);
    expect(bad("SELECT (r). FROM t;")).toThrow(/Expected a name but found "from"/);
    expect(bad("SELECT (r).1 FROM t;")).toThrow(/Expected ";" but found "\.1"/);
  });

  it("builds an array from a subquery", () => {
    expect(colExpr("ARRAY(SELECT 1)")).toEqual({ kind: "arraySubquery", query: select1 });
    expect(colExpr("ARRAY(SELECT id FROM users ORDER BY id)").query).toMatchObject({ kind: "select" });
    expect(bad("SELECT ARRAY() FROM t;")).toThrow(/but found "\)"/);
    expect(bad("SELECT ARRAY(1) FROM t;")).toThrow(/but found "1"/);
    expect(bad("SELECT ARRAY x FROM t;")).toThrow(/Expected "\[" but found "x"/);
  });

  it("reads bare inner rows of a multidimensional array", () => {
    expect(colExpr("ARRAY[[1, 2], [3, 4]]")).toEqual(arr(row(num(1), num(2)), row(num(3), num(4))));
    expect(colExpr("ARRAY[[[1]], [[]]]")).toEqual(arr(row(row(num(1))), row(row())));
    expect(colExpr("ARRAY[[]]")).toEqual(arr(row()));
    // Only the inner rows carry `implicit`.
    expect(Object.keys(colExpr("ARRAY[[1]]"))).toEqual(["kind", "elements"]);
    // An ARRAY-spelled inner array stays an ordinary element.
    expect(colExpr("ARRAY[ARRAY[1], ARRAY[2]]")).toEqual(arr(arr(num(1)), arr(num(2))));
    // Rows and expressions don't mix.
    expect(bad("SELECT ARRAY[[1], 2] FROM t;")).toThrow(/Expected "\[" but found "2"/);
    expect(bad("SELECT ARRAY[1, [2]] FROM t;")).toThrow(/but found "\["/);
    expect(bad("SELECT ARRAY[[1],] FROM t;")).toThrow(/Expected "\[" but found "\]"/);
    expect(bad("SELECT ARRAY[[1] FROM t;")).toThrow(/Expected "\]" but found "from"/);
  });

  it("spans an inner row over its brackets", () => {
    const [stmt] = sqlLite.parse("SELECT ARRAY[[1], [2, 3]];") as any[];
    const outer = stmt.columns[0].expr;
    expect(outer.span).toEqual({ start: { row: 1, col: 7 }, end: { row: 1, col: 25 } });
    expect(outer.elements[1].span).toEqual({ start: { row: 1, col: 18 }, end: { row: 1, col: 24 } });
  });

  it("names an argument with := as with =>", () => {
    expect(colExpr("make_interval(days := 10)")).toEqual(call("make_interval", [named("days", num(10))]));
    expect(colExpr('f(1, "B" := 2, c => 3)')).toEqual(call("f", [num(1), named("B", num(2)), named("c", num(3))]));
    expect(firstStmt("CALL p(a := 1);")).toEqual({ kind: "callProcedure", name: ["p"], args: [named("a", num(1))] });
    expect(bad("SELECT f(a : = 1) FROM t;")).toThrow(/Expected "\)" but found ":"/);
    expect(bad("SELECT f(a :=) FROM t;")).toThrow(/but found "\)"/);
  });

  it("passes a last argument as VARIADIC", () => {
    expect(colExpr("concat_ws(',', VARIADIC ARRAY['a', 'b'])")).toEqual(
      call("concat_ws", [str(","), arr(str("a"), str("b"))], { variadic: true }),
    );
    expect(colExpr("f(VARIADIC arr)")).toEqual(call("f", [name("arr")], { variadic: true }));
    expect(colExpr("f(VARIADIC a := arr)")).toEqual(call("f", [named("a", name("arr"))], { variadic: true }));
    expect(colExpr("array_agg(VARIADIC a ORDER BY b)")).toEqual(
      call("array_agg", [name("a")], { variadic: true, orderBy: [{ expr: name("b"), dir: null, nulls: null }] }),
    );
    expect(firstStmt("SELECT * FROM f(1, VARIADIC a);").from[0].call).toEqual(
      call("f", [num(1), name("a")], { variadic: true }),
    );
    expect(firstStmt("CALL p(VARIADIC a);")).toEqual({
      kind: "callProcedure",
      name: ["p"],
      args: [name("a")],
      variadic: true,
    });
    // Omitted when absent, on all three.
    expect(Object.keys(colExpr("f(a)"))).toEqual(["kind", "name", "args"]);
    expect(Object.keys(firstStmt("SELECT * FROM f(a);").from[0].call)).toEqual(["kind", "name", "args"]);
    expect(Object.keys(firstStmt("CALL p(a);"))).toEqual(["kind", "name", "args"]);
  });

  it("rejects a VARIADIC argument that is not last, or not an expression", () => {
    expect(bad("SELECT f(VARIADIC a, b) FROM t;")).toThrow(/Expected "\)" but found ","/);
    expect(bad("SELECT * FROM f(VARIADIC a, b);")).toThrow(/Expected "\)" but found ","/);
    expect(bad("CALL p(VARIADIC a, b);")).toThrow(/Expected "\)" but found ","/);
    expect(bad("SELECT f(VARIADIC *) FROM t;")).toThrow(/but found "\*"/);
    expect(bad("SELECT f(VARIADIC) FROM t;")).toThrow(/but found "\)"/);
    // PG's grammar takes VARIADIC after neither DISTINCT nor ALL.
    expect(bad("SELECT f(DISTINCT VARIADIC a) FROM t;")).toThrow(/Expected a name but found "variadic"/);
    expect(bad("SELECT f(ALL a, VARIADIC b) FROM t;")).toThrow(/Expected a name but found "variadic"/);
    // Nor is a VARIADIC typmod a typed literal's.
    expect(bad("SELECT varchar(VARIADIC 3) 'x' FROM t;")).toThrow(/Expected ";" but found "x"/);
  });

  it("records ALL ahead of an aggregate's arguments", () => {
    expect(colExpr("count(ALL x)")).toEqual(call("count", [name("x")], { all: true }));
    expect(colExpr("string_agg(ALL a, ',' ORDER BY a)")).toEqual(
      call("string_agg", [name("a"), str(",")], { all: true, orderBy: [{ expr: name("a"), dir: null, nulls: null }] }),
    );
    // DISTINCT and ALL each want an argument after them.
    expect(bad("SELECT count(ALL) FROM t;")).toThrow(/but found "\)"/);
    expect(bad("SELECT count(DISTINCT) FROM t;")).toThrow(/but found "\)"/);
    expect(bad("SELECT count(ALL DISTINCT x) FROM t;")).toThrow(/but found "distinct"/);
    // Nor does either take a bare `*`, which stands only on its own.
    expect(bad("SELECT count(ALL *) FROM t;")).toThrow(/but found "\*"/);
    expect(bad("SELECT count(DISTINCT *) FROM t;")).toThrow(/but found "\*"/);
    // A FROM call and CALL read neither (see parseCallArgs).
    expect(bad("SELECT * FROM f(ALL x);")).toThrow(/but found "all"/);
    expect(bad("CALL p(DISTINCT x);")).toThrow(/but found "distinct"/);
  });

  it("keeps the OVERLAY keyword form to plain first arguments", () => {
    expect(bad("SELECT overlay(VARIADIC a PLACING b FROM 1) FROM t;")).toThrow(/Expected "\)" but found "placing"/);
    expect(bad("SELECT overlay(ALL a PLACING b FROM 1) FROM t;")).toThrow(/Expected "\)" but found "placing"/);
    expect(colExpr("overlay(a PLACING b FROM 1)")).toMatchObject({ kind: "overlay" });
  });
});

// --- special predicates and calls, and non-empty lists ---

describe("SQL-lite special predicates and calls", () => {
  const colExpr = (src: string) => (firstStmt(`SELECT ${src} FROM t;`) as any).columns[0].expr;
  const bad = (src: string) => () => sqlLite.parse(src);
  const x = name("x");

  it("parses IS [NOT] [form] NORMALIZED", () => {
    const isNorm = (form: string | null, negated: boolean) => ({ kind: "isNormalized", expr: x, form, negated });
    expect(colExpr("x IS NORMALIZED")).toEqual(isNorm(null, false));
    expect(colExpr("x IS NOT NORMALIZED")).toEqual(isNorm(null, true));
    expect(colExpr("x IS NFC NORMALIZED")).toEqual(isNorm("nfc", false));
    expect(colExpr("x IS NOT NFD NORMALIZED")).toEqual(isNorm("nfd", true));
    expect(colExpr("x IS NFKC NORMALIZED")).toEqual(isNorm("nfkc", false));
    expect(colExpr("x IS NOT NFKD NORMALIZED")).toEqual(isNorm("nfkd", true));
    // At IS's precedence: below the concatenation, above AND.
    expect(exprOf("a || b IS NORMALIZED AND c")).toEqual({
      kind: "binary",
      op: "and",
      left: { kind: "isNormalized", expr: bin("||", name("a"), name("b")), form: null, negated: false },
      right: name("c"),
    });
    expect(bad("SELECT x IS NFC FROM t;")).toThrow(/Expected "normalized" but found "from"/);
    expect(bad("SELECT x IS NFC NFD NORMALIZED FROM t;")).toThrow(/Expected "normalized" but found "nfd"/);
    // Anything else after IS still reports the NULL it most likely meant.
    expect(bad("SELECT x IS foo FROM t;")).toThrow(/Expected "null" but found "foo"/);
  });

  it("parses IS [NOT] DOCUMENT", () => {
    expect(colExpr("x IS DOCUMENT")).toEqual({ kind: "isDocument", expr: x, negated: false });
    // PG's b_expr takes it too, so a DEFAULT may end in it.
    expect(firstStmt("CREATE TABLE t (c bool DEFAULT x IS NOT DOCUMENT NOT NULL);").items[0].constraints).toEqual([
      { kind: "default", expr: { kind: "isDocument", expr: x, negated: true } },
      { kind: "notNull" },
    ]);
    expect(exprOf("x IS NOT DOCUMENT OR y")).toEqual({
      kind: "binary",
      op: "or",
      left: { kind: "isDocument", expr: x, negated: true },
      right: name("y"),
    });
  });

  it("parses NORMALIZE with and without a normal form", () => {
    expect(colExpr("normalize(x, NFC)")).toEqual({ kind: "normalize", value: x, form: "nfc" });
    expect(colExpr("normalize(x || 'a', nfkd)")).toEqual({
      kind: "normalize",
      value: bin("||", x, str("a")),
      form: "nfkd",
    });
    expect(colExpr("normalize(x)")).toEqual({ kind: "call", name: "normalize", args: [x] });
    // The form is a keyword: no string, column or expression takes its place.
    expect(bad("SELECT normalize(x, 'NFC') FROM t;")).toThrow(
      /Expected "nfc", "nfd", "nfkc" or "nfkd" but found "NFC"/,
    );
    expect(bad("SELECT normalize(x, y) FROM t;")).toThrow(/Expected "nfc", "nfd", "nfkc" or "nfkd" but found "y"/);
    expect(bad("SELECT normalize(x, NFC, NFD) FROM t;")).toThrow(/Expected "\)" but found ","/);
    expect(bad("SELECT normalize() FROM t;")).toThrow(/but found "\)"/);
    // A col_name_keyword in PG, so no call modifiers either.
    expect(bad("SELECT normalize(x) OVER () FROM t;")).toThrow(/Expected ";" but found "\("/);
    expect(bad("SELECT normalize(VARIADIC x) FROM t;")).toThrow(/but found "variadic"/);
    // Quoted or qualified, it is an ordinary function.
    expect(colExpr("\"normalize\"(x, 'NFC')")).toEqual({ kind: "call", name: "normalize", args: [x, str("NFC")] });
    expect(colExpr("pg_catalog.normalize(x, 'NFC')")).toEqual({
      kind: "call",
      name: "pg_catalog.normalize",
      args: [x, str("NFC")],
    });
  });

  it("parses COLLATION FOR in a select list and a WHERE", () => {
    const collationFor = (expr: unknown) => ({ kind: "collationFor", expr });
    expect(colExpr("COLLATION FOR (x)")).toEqual(collationFor(x));
    expect(firstStmt("SELECT collation for ('a' COLLATE \"C\") AS c;").columns).toEqual([
      col(collationFor({ kind: "collate", expr: str("a"), collation: ["C"] }), "c"),
    ]);
    expect(firstStmt("SELECT a FROM t WHERE COLLATION FOR (b) = '\"default\"';").where).toEqual(
      bin("=", collationFor(name("b")), str('"default"')),
    );
    // Without a `(` after FOR, `collation` is a column and FOR a locking clause.
    // (PG makes `collation` a type_func_name keyword and no column name; this
    // grammar is looser there.)
    expect(firstStmt("SELECT collation FROM t FOR UPDATE;")).toMatchObject({
      columns: [col(name("collation"))],
      locking: [{ strength: "update" }],
    });
    expect(bad("SELECT COLLATION FOR x FROM t;")).toThrow(/Expected "update", "share", "no" or "key" but found "x"/);
    expect(bad("SELECT COLLATION FOR () FROM t;")).toThrow(/but found "\)"/);
  });

  it("parses SUBSTRING's SIMILAR form beside its FROM / FOR form", () => {
    expect(colExpr("substring(x SIMILAR '%#\"o_b#\"%' ESCAPE '#')")).toEqual({
      kind: "substringSimilar",
      value: x,
      pattern: str('%#"o_b#"%'),
      escape: str("#"),
    });
    expect(colExpr("substring(x FROM 2 FOR 3)")).toEqual({ kind: "substring", value: x, from: num(2), for_: num(3) });
    // SIMILAR TO inside the value is still the operator.
    expect(colExpr("substring(x SIMILAR TO 'a' FROM 2)")).toEqual({
      kind: "substring",
      value: { kind: "similarTo", expr: x, pattern: str("a"), negated: false },
      from: num(2),
      for_: null,
    });
    // PG requires the ESCAPE.
    expect(bad("SELECT substring(x SIMILAR 'a') FROM t;")).toThrow(/Expected "escape" but found "\)"/);
    // Outside SUBSTRING, a SIMILAR with no TO is a bare alias, as in PG.
    expect(bad("SELECT x SIMILAR 'a' FROM t;")).toThrow(/Expected ";" but found "a"/);
  });

  it("parses AT LOCAL next to AT TIME ZONE", () => {
    const atLocal = (expr: unknown) => ({ kind: "atLocal", expr });
    expect(colExpr("x AT LOCAL")).toEqual(atLocal(x));
    // Below the sign and COLLATE, like AT TIME ZONE, and chaining to the left.
    expect(colExpr("-x AT LOCAL")).toEqual(atLocal({ kind: "unary", op: "-", operand: x }));
    expect(colExpr("x AT TIME ZONE 'UTC' AT LOCAL")).toEqual(
      atLocal({ kind: "atTimeZone", expr: x, zone: str("UTC") }),
    );
    expect(colExpr("x AT LOCAL AT TIME ZONE 'UTC'")).toEqual({
      kind: "atTimeZone",
      expr: atLocal(x),
      zone: str("UTC"),
    });
    expect(colExpr("x AT LOCAL + y")).toEqual(bin("+", atLocal(x), name("y")));
    expect(firstStmt("SELECT x AT LOCAL AS l FROM t;").columns).toEqual([col(atLocal(x), "l")]);
    // Not a b_expr form, like AT TIME ZONE: a DEFAULT does not take it.
    expect(bad("CREATE TABLE t (c timestamp DEFAULT x AT LOCAL);")).toThrow(/but found "at"/);
  });

  it("keeps a bare AT, SIMILAR, NORMALIZED and DOCUMENT as aliases", () => {
    // PG's BARE_LABEL words: AT without TIME ZONE or LOCAL after it, and
    // SIMILAR without TO, are no operators.
    expect(firstStmt("SELECT x at FROM t;").columns).toEqual([col(x, "at")]);
    expect(firstStmt("SELECT x at, y similar FROM t;").columns).toEqual([col(x, "at"), col(name("y"), "similar")]);
    expect(firstStmt("SELECT x normalized, y document, z local FROM t;").columns).toEqual([
      col(x, "normalized"),
      col(name("y"), "document"),
      col(name("z"), "local"),
    ]);
    expect(bad("SELECT x AT TIME FROM t;")).toThrow(/Expected "zone" but found "from"/);
  });

  it("keeps the new keywords unreserved as names and aliases", () => {
    // All but `collation` and `normalize` are unreserved in PG too; those two
    // are its type_func_name / col_name keywords, which this grammar does not
    // reserve.
    for (const word of [
      "normalized",
      "document",
      "nfc",
      "nfd",
      "nfkc",
      "nfkd",
      "local",
      "at",
      "collation",
      "normalize",
    ]) {
      expect(firstStmt(`SELECT ${word} FROM ${word};`)).toMatchObject({
        columns: [col(name(word))],
        from: [{ kind: "table", name: [word], alias: null }],
      });
      expect(firstStmt(`SELECT a AS ${word} FROM t ${word};`)).toMatchObject({
        columns: [col(name("a"), word)],
        from: [{ kind: "table", name: ["t"], alias: word }],
      });
      expect(firstStmt(`CREATE TABLE t (${word} int);`)).toMatchObject({ items: [{ name: word }] });
    }
    // A column named like a normal form is an operand, not the form, before IS.
    expect(colExpr("nfc IS NORMALIZED")).toEqual({
      kind: "isNormalized",
      expr: name("nfc"),
      form: null,
      negated: false,
    });
  });
});

describe("SQL-lite rejects empty parenthesised lists", () => {
  const bad = (src: string) => () => sqlLite.parse(src);
  const emptyList = /but found "\)"/;

  it("rejects the empty forms PG rejects", () => {
    expect(bad("SELECT x IN () FROM t;")).toThrow(emptyList);
    expect(bad("SELECT x NOT IN () FROM t;")).toThrow(emptyList);
    expect(bad("VALUES ();")).toThrow(emptyList);
    expect(bad("VALUES (1), ();")).toThrow(emptyList);
    expect(bad("INSERT INTO t VALUES ();")).toThrow(emptyList);
    expect(bad("INSERT INTO t VALUES (1), ();")).toThrow(emptyList);
    expect(bad("MERGE INTO t USING s ON t.a = s.a WHEN NOT MATCHED THEN INSERT VALUES ();")).toThrow(emptyList);
    expect(bad("SELECT DISTINCT ON () a FROM t;")).toThrow(emptyList);
    expect(bad("EXECUTE p();")).toThrow(emptyList);
  });

  it("still reads non-empty lists", () => {
    expect(firstStmt("SELECT x IN (1) FROM t;").columns[0].expr).toEqual({
      kind: "in",
      expr: name("x"),
      list: [num(1)],
      negated: false,
    });
    expect(firstStmt("VALUES (1, 2), (3, 4);")).toMatchObject({
      rows: [
        [num(1), num(2)],
        [num(3), num(4)],
      ],
    });
    expect(firstStmt("SELECT DISTINCT ON (a, b) a FROM t;").distinct).toEqual([name("a"), name("b")]);
    expect(firstStmt("EXECUTE p(1);")).toMatchObject({ args: [num(1)] });
  });

  it("keeps the empty lists PG allows", () => {
    // A call, a ROW constructor and a trigger's function arguments may be empty.
    expect(firstStmt("SELECT now() FROM t;").columns[0].expr).toEqual({ kind: "call", name: "now", args: [] });
    expect(firstStmt("SELECT ROW() FROM t;").columns[0].expr).toEqual({ kind: "row", items: [] });
    expect(firstStmt("EXECUTE p;")).toMatchObject({ args: null });
    const trigger = (args: string) =>
      firstStmt(`CREATE TRIGGER tr BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION f(${args});`).execute;
    expect(trigger("")).toEqual({ routine: "function", name: ["f"], args: [] });
    expect(trigger("1, 'a'")).toEqual({ routine: "function", name: ["f"], args: [num(1), str("a")] });
    const trig = "CREATE TRIGGER tr BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION f";
    expect(bad(`${trig}(1,);`)).toThrow(emptyList);
    expect(bad(`${trig}(1 2);`)).toThrow(/Expected "," but found "2"/);
    expect(bad(`${trig}(`)).toThrow(/Expected "\)" but found end of input/);
  });
});

// --- long-tail objects: definition lists, casts, collations, operators, … ---

describe("SQL-lite long-tail objects with definition lists", () => {
  const ty = (typeName: string, array = false) => ({ name: typeName, args: [], array });
  const arg = (typeName: string) => ({ mode: null, name: null, type: ty(typeName), defaultValue: null });
  const typeArg = (typeName: string) => ({ kind: "type", type: ty(typeName) });
  const fails = (text: string) => () => sqlLite.parse(text);

  it("reads every kind of definition value", () => {
    expect(
      firstStmt(
        "CREATE TYPE s.c (INPUT = c_in, LIKE = pg_catalog.int4, ELEMENT = float4[], DEFAULT = -1.5, " +
          "INTERNALLENGTH = 99999999999999999999, DELIMITER = ',', CATEGORY = NULL, PASSEDBYVALUE, " +
          'STORAGE = NONE, "Align" = double precision, SEND = +2);',
      ),
    ).toEqual({
      kind: "createType",
      form: "base",
      name: ["s", "c"],
      definition: [
        { name: "input", value: typeArg("c_in") },
        { name: "like", value: typeArg("pg_catalog.int4") },
        { name: "element", value: { kind: "type", type: ty("float4", true) } },
        { name: "default", value: { kind: "number", value: -1.5 } },
        {
          name: "internallength",
          value: { kind: "number", value: 1e20, raw: "99999999999999999999" },
        },
        { name: "delimiter", value: { kind: "string", value: "," } },
        { name: "category", value: { kind: "keyword", value: "null" } },
        { name: "passedbyvalue" },
        { name: "storage", value: { kind: "none" } },
        { name: "Align", value: typeArg("double precision") },
        { name: "send", value: { kind: "number", value: 2 } },
      ],
    });
  });

  it("parses CREATE OPERATOR with operator-valued definitions", () => {
    expect(
      firstStmt(
        "CREATE OPERATOR s.=== (LEFTARG = box, RIGHTARG = box, FUNCTION = box_eq, COMMUTATOR = ===, " +
          "NEGATOR = OPERATOR(pg_catalog.<>), HASHES);",
      ),
    ).toEqual({
      kind: "createOperator",
      name: ["s", "==="],
      definition: [
        { name: "leftarg", value: typeArg("box") },
        { name: "rightarg", value: typeArg("box") },
        { name: "function", value: typeArg("box_eq") },
        { name: "commutator", value: { kind: "operator", name: ["==="] } },
        { name: "negator", value: { kind: "operator", name: ["pg_catalog", "<>"] } },
        { name: "hashes" },
      ],
    });
    // A prefix operator, and an operator in a schema called `class`.
    expect(firstStmt("CREATE OPERATOR - (RIGHTARG = int);")).toMatchObject({ kind: "createOperator", name: ["-"] });
    expect(firstStmt("CREATE OPERATOR class.+ (LEFTARG = int, RIGHTARG = int);")).toMatchObject({
      kind: "createOperator",
      name: ["class", "+"],
    });
  });

  it("parses CREATE TYPE base and shell forms beside the AS forms", () => {
    expect(firstStmt("CREATE TYPE box3d;")).toEqual({ kind: "createType", form: "shell", name: ["box3d"] });
    expect(firstStmt("CREATE TYPE s.box3d")).toEqual({ kind: "createType", form: "shell", name: ["s", "box3d"] });
    expect(firstStmt("CREATE TYPE t (INPUT = t_in, OUTPUT = t_out);")).toEqual({
      kind: "createType",
      form: "base",
      name: ["t"],
      definition: [
        { name: "input", value: typeArg("t_in") },
        { name: "output", value: typeArg("t_out") },
      ],
    });
    expect(firstStmt("CREATE TYPE mood AS ENUM ('sad');")).toEqual({
      kind: "createType",
      form: "enum",
      name: ["mood"],
      values: ["sad"],
    });
    expect(firstStmt("CREATE TYPE p AS (x int);")).toMatchObject({ form: "composite" });
    expect(firstStmt("CREATE TYPE r AS RANGE (SUBTYPE = int4);")).toMatchObject({ form: "range" });
    expect(parse("CREATE TYPE a; CREATE TYPE b AS ENUM ();").map((s) => s.form)).toEqual(["shell", "enum"]);
  });

  it("parses CREATE CAST in each of its forms", () => {
    expect(firstStmt("CREATE CAST (bigint AS int4) WITH FUNCTION s.int4(bigint) AS ASSIGNMENT;")).toEqual({
      kind: "createCast",
      source: ty("bigint"),
      target: ty("int4"),
      method: "function",
      function: { name: ["s", "int4"], signature: { star: false, args: [arg("bigint")] } },
      context: "assignment",
    });
    expect(firstStmt("CREATE CAST (a AS b) WITH FUNCTION f;")).toEqual({
      kind: "createCast",
      source: ty("a"),
      target: ty("b"),
      method: "function",
      function: { name: ["f"] },
    });
    expect(firstStmt("CREATE CAST (a AS b) WITHOUT FUNCTION AS IMPLICIT;")).toEqual({
      kind: "createCast",
      source: ty("a"),
      target: ty("b"),
      method: "withoutFunction",
      context: "implicit",
    });
    expect(firstStmt("CREATE CAST (int[] AS text) WITH INOUT;")).toEqual({
      kind: "createCast",
      source: ty("int", true),
      target: ty("text"),
      method: "inout",
    });
  });

  it("parses CREATE COLLATION, CONVERSION and ACCESS METHOD", () => {
    expect(firstStmt("CREATE COLLATION german (provider = icu, locale = 'de-DE');")).toEqual({
      kind: "createCollation",
      ifNotExists: false,
      name: ["german"],
      definition: [
        { name: "provider", value: typeArg("icu") },
        { name: "locale", value: { kind: "string", value: "de-DE" } },
      ],
    });
    expect(firstStmt('CREATE COLLATION IF NOT EXISTS s.c FROM "C";')).toEqual({
      kind: "createCollation",
      ifNotExists: true,
      name: ["s", "c"],
      from: ["C"],
    });
    expect(firstStmt("CREATE CONVERSION s.myconv FOR 'UTF8' TO 'LATIN1' FROM myfunc;")).toEqual({
      kind: "createConversion",
      name: ["s", "myconv"],
      source: "UTF8",
      target: "LATIN1",
      function: ["myfunc"],
    });
    expect(firstStmt("CREATE DEFAULT CONVERSION c FOR 'UTF8' TO 'LATIN1' FROM s.f;")).toEqual({
      kind: "createConversion",
      default: true,
      name: ["c"],
      source: "UTF8",
      target: "LATIN1",
      function: ["s", "f"],
    });
    expect(firstStmt("CREATE ACCESS METHOD heap2 TYPE TABLE HANDLER heap_tableam_handler;")).toEqual({
      kind: "createAccessMethod",
      name: "heap2",
      type: "table",
      handler: ["heap_tableam_handler"],
    });
    expect(firstStmt("CREATE ACCESS METHOD b TYPE INDEX HANDLER s.h;")).toMatchObject({
      type: "index",
      handler: ["s", "h"],
    });
  });

  it("parses CREATE STATISTICS with and without a name and kinds", () => {
    expect(firstStmt("CREATE STATISTICS s1 (dependencies, ndistinct) ON a, b FROM t;")).toEqual({
      kind: "createStatistics",
      ifNotExists: false,
      name: ["s1"],
      kinds: ["dependencies", "ndistinct"],
      on: [name("a"), name("b")],
      from: [["t"]],
    });
    expect(firstStmt("CREATE STATISTICS ON (a + b), lower(c) FROM s.t;")).toEqual({
      kind: "createStatistics",
      ifNotExists: false,
      on: [bin("+", name("a"), name("b")), { kind: "call", name: "lower", args: [name("c")] }],
      from: [["s", "t"]],
    });
    // The special-syntax calls are function calls too; `::` is not.
    expect(
      firstStmt("CREATE STATISTICS s ON CAST(a AS int), extract(year FROM d), current_date FROM t;").on.map(
        (e: any) => e.kind,
      ),
    ).toEqual(["cast", "extract", "sqlValueFunction"]);
    expect(firstStmt("CREATE STATISTICS IF NOT EXISTS s.st ON a, b FROM t;")).toMatchObject({
      ifNotExists: true,
      name: ["s", "st"],
    });
  });

  it("parses CREATE EVENT TRIGGER with and without WHEN", () => {
    expect(
      firstStmt(
        "CREATE EVENT TRIGGER no_ddl ON ddl_command_start WHEN TAG IN ('DROP TABLE', 'ALTER TABLE') AND tag IN ('x') EXECUTE FUNCTION s.abort_ddl();",
      ),
    ).toEqual({
      kind: "createEventTrigger",
      name: "no_ddl",
      event: "ddl_command_start",
      when: [
        { variable: "tag", values: ["DROP TABLE", "ALTER TABLE"] },
        { variable: "tag", values: ["x"] },
      ],
      execute: { routine: "function", name: ["s", "abort_ddl"] },
    });
    expect(firstStmt("CREATE EVENT TRIGGER e ON sql_drop EXECUTE PROCEDURE p();")).toEqual({
      kind: "createEventTrigger",
      name: "e",
      event: "sql_drop",
      execute: { routine: "procedure", name: ["p"] },
    });
  });

  it("parses CREATE LANGUAGE with its prefixes and handlers", () => {
    expect(firstStmt("CREATE LANGUAGE plperl;")).toEqual({ kind: "createLanguage", orReplace: false, name: "plperl" });
    expect(firstStmt("CREATE OR REPLACE TRUSTED PROCEDURAL LANGUAGE plx HANDLER s.h INLINE i VALIDATOR v;")).toEqual({
      kind: "createLanguage",
      orReplace: true,
      trusted: true,
      procedural: true,
      name: "plx",
      handler: ["s", "h"],
      inline: ["i"],
      validator: ["v"],
    });
    expect(firstStmt("CREATE PROCEDURAL LANGUAGE plx HANDLER h NO VALIDATOR;")).toEqual({
      kind: "createLanguage",
      orReplace: false,
      procedural: true,
      name: "plx",
      handler: ["h"],
      validator: null,
    });
    expect(firstStmt("CREATE TRUSTED LANGUAGE plx;")).toEqual({
      kind: "createLanguage",
      orReplace: false,
      trusted: true,
      name: "plx",
    });
  });

  it("parses CREATE TEXT SEARCH for each of its four kinds", () => {
    expect(firstStmt("CREATE TEXT SEARCH CONFIGURATION s.my_cfg (COPY = english);")).toEqual({
      kind: "createTextSearch",
      objectType: "configuration",
      name: ["s", "my_cfg"],
      definition: [{ name: "copy", value: typeArg("english") }],
    });
    expect(
      firstStmt("CREATE TEXT SEARCH DICTIONARY d (TEMPLATE = simple, STOPWORDS = english, ACCEPT = false);"),
    ).toMatchObject({
      objectType: "dictionary",
      definition: [
        { name: "template" },
        { name: "stopwords" },
        { name: "accept", value: { kind: "keyword", value: "false" } },
      ],
    });
    expect(firstStmt("CREATE TEXT SEARCH PARSER p (START = s, GETTOKEN = g, END = e, LEXTYPES = l);")).toMatchObject({
      objectType: "parser",
    });
    expect(firstStmt("CREATE TEXT SEARCH TEMPLATE t (LEXIZE = l);")).toMatchObject({ objectType: "template" });
  });

  it("parses CREATE OPERATOR CLASS and FAMILY", () => {
    expect(
      firstStmt(
        "CREATE OPERATOR CLASS my_ops FOR TYPE int4 USING btree AS OPERATOR 1 <, FUNCTION 1 btint4cmp(int4, int4);",
      ),
    ).toEqual({
      kind: "createOperatorClass",
      name: ["my_ops"],
      type: ty("int4"),
      using: "btree",
      items: [
        { kind: "operator", strategy: 1, operator: ["<"] },
        {
          kind: "function",
          support: 1,
          name: ["btint4cmp"],
          signature: { star: false, args: [arg("int4"), arg("int4")] },
        },
      ],
    });
    expect(
      firstStmt(
        "CREATE OPERATOR CLASS s.gist_ops DEFAULT FOR TYPE point USING gist FAMILY s.f AS " +
          "OPERATOR 15 pg_catalog.<-> (point, point) FOR ORDER BY float_ops, OPERATOR 3 && FOR SEARCH, " +
          "FUNCTION 1 (point, point) f, STORAGE box;",
      ),
    ).toEqual({
      kind: "createOperatorClass",
      name: ["s", "gist_ops"],
      default: true,
      type: ty("point"),
      using: "gist",
      family: ["s", "f"],
      items: [
        {
          kind: "operator",
          strategy: 15,
          operator: ["pg_catalog", "<->"],
          operands: [ty("point"), ty("point")],
          purpose: { kind: "orderBy", family: ["float_ops"] },
        },
        { kind: "operator", strategy: 3, operator: ["&&"], purpose: { kind: "search" } },
        { kind: "function", support: 1, types: [ty("point"), ty("point")], name: ["f"] },
        { kind: "storage", type: ty("box") },
      ],
    });
    expect(firstStmt("CREATE OPERATOR FAMILY s.f USING btree;")).toEqual({
      kind: "createOperatorFamily",
      name: ["s", "f"],
      using: "btree",
    });
  });

  it("parses the matching DROP forms", () => {
    const drop = (fields: Record<string, unknown>) => ({
      kind: "drop",
      concurrently: false,
      ifExists: false,
      behavior: null,
      ...fields,
    });
    expect(firstStmt("DROP CAST IF EXISTS (a AS b) CASCADE;")).toEqual(
      drop({ objectType: "cast", ifExists: true, names: [], behavior: "cascade", source: ty("a"), target: ty("b") }),
    );
    expect(firstStmt("DROP OPERATOR IF EXISTS ^ (int, int), s.~ (NONE, bit);")).toEqual(
      drop({
        objectType: "operator",
        ifExists: true,
        names: [["^"], ["s", "~"]],
        operands: [
          [ty("int"), ty("int")],
          [null, ty("bit")],
        ],
      }),
    );
    expect(firstStmt("DROP OPERATOR CLASS IF EXISTS c USING btree;")).toEqual(
      drop({ objectType: "operator class", ifExists: true, names: [["c"]], using: "btree" }),
    );
    expect(firstStmt("DROP OPERATOR FAMILY s.f USING gin RESTRICT;")).toEqual(
      drop({ objectType: "operator family", names: [["s", "f"]], using: "gin", behavior: "restrict" }),
    );
    expect(firstStmt("DROP TEXT SEARCH DICTIONARY d1, s.d2;")).toEqual(
      drop({ objectType: "text search dictionary", names: [["d1"], ["s", "d2"]] }),
    );
    expect(firstStmt("DROP PROCEDURAL LANGUAGE IF EXISTS plx;")).toEqual(
      drop({ objectType: "language", ifExists: true, names: [["plx"]] }),
    );
    const kinds: [string, string, string[]][] = [
      ["COLLATION s.c", "collation", ["s", "c"]],
      ["CONVERSION s.c", "conversion", ["s", "c"]],
      ["STATISTICS s.st", "statistics", ["s", "st"]],
      ["EVENT TRIGGER e", "event trigger", ["e"]],
      ["LANGUAGE l", "language", ["l"]],
      ["ACCESS METHOD a", "access method", ["a"]],
      ["TEXT SEARCH PARSER p", "text search parser", ["p"]],
      ["TEXT SEARCH TEMPLATE p", "text search template", ["p"]],
      ["TEXT SEARCH CONFIGURATION p", "text search configuration", ["p"]],
      ["TYPE box3d", "type", ["box3d"]],
    ];
    for (const [sql, objectType, objectName] of kinds) {
      expect(firstStmt(`DROP ${sql} CASCADE;`)).toEqual(drop({ objectType, names: [objectName], behavior: "cascade" }));
    }
  });

  it("rejects malformed definitions and statements", () => {
    expect(fails("CREATE COLLATION c;")).toThrow(/Expected "\(" or "from" but found ";"/);
    expect(fails("CREATE COLLATION c ();")).toThrow(/Expected an option name but found "\)"/);
    expect(fails("CREATE COLLATION c (locale = );")).toThrow(
      /Expected a name, a number, a string or an operator but found "\)"/,
    );
    expect(fails("CREATE COLLATION c (locale 'x');")).toThrow(/Expected "\)" but found "x"/);
    expect(fails("CREATE TYPE t foo;")).toThrow(/Expected "as" but found "foo"/);
    expect(fails("CREATE OPERATOR => (LEFTARG = int);")).toThrow(/Expected an operator but found "=>"/);
    expect(fails("CREATE OPERATOR + ;")).toThrow(/Expected "\(" but found ";"/);
    expect(fails("CREATE CAST (a AS b);")).toThrow(/Expected "with" or "without" but found ";"/);
    expect(fails("CREATE CAST (a, b) WITH INOUT;")).toThrow(/Expected "as" but found ","/);
    expect(fails("CREATE CAST (a AS b) WITH f;")).toThrow(/Expected "function" or "inout" but found "f"/);
    expect(fails("CREATE CAST (a AS b) WITH INOUT AS frob;")).toThrow(/Expected "assignment" or "implicit"/);
    expect(fails("CREATE CONVERSION c FOR utf8 TO 'x' FROM f;")).toThrow(/Expected a string but found "utf8"/);
    expect(fails("CREATE DEFAULT x;")).toThrow(/Expected "conversion" but found "x"/);
    expect(fails("CREATE STATISTICS s ON x, a + b FROM t;")).toThrow(/must be parenthesised \(1:26\)/);
    expect(fails("CREATE STATISTICS s ON t.a FROM t;")).toThrow(/must be parenthesised/);
    expect(fails("CREATE STATISTICS s ON a::int FROM t;")).toThrow(/must be parenthesised/);
    expect(fails("CREATE STATISTICS s ON CAST(a AS int)::text FROM t;")).toThrow(/must be parenthesised/);
    expect(fails("CREATE STATISTICS IF NOT EXISTS ON a FROM t;")).toThrow(/Expected a name but found "on"/);
    expect(fails("CREATE STATISTICS s ON a;")).toThrow(/Expected "from" but found ";"/);
    expect(fails("CREATE EVENT TRIGGER e ON x EXECUTE FUNCTION f(1);")).toThrow(/Expected "\)" but found "1"/);
    expect(fails("CREATE EVENT TRIGGER e ON x WHEN tag IN (1) EXECUTE FUNCTION f();")).toThrow(
      /Expected a string but found "1"/,
    );
    expect(fails("CREATE EVENT TRIGGER e ON x EXECUTE f();")).toThrow(/Expected "function" or "procedure"/);
    expect(fails("CREATE TRUSTED x;")).toThrow(/Expected "procedural" or "language" but found "x"/);
    expect(fails("CREATE PROCEDURAL x;")).toThrow(/Expected "language" but found "x"/);
    expect(fails("CREATE LANGUAGE l HANDLER h NO frob;")).toThrow(/Expected "validator" but found "frob"/);
    expect(fails("CREATE OR REPLACE ACCESS METHOD a TYPE TABLE HANDLER h;")).toThrow(
      expectsKeys(["view", "language", "trusted", "procedural"], '"access"'),
    );
    expect(fails("CREATE ACCESS METHOD a TYPE view HANDLER h;")).toThrow(
      /Expected "table" or "index" but found "view"/,
    );
    expect(fails("CREATE TEXT SEARCH frob x (a = b);")).toThrow(
      /Expected "parser", "dictionary", "template" or "configuration" but found "frob"/,
    );
    expect(fails("CREATE TEXT SEARCH PARSER p;")).toThrow(/Expected "\(" but found ";"/);
    const opclass = (items: string) => fails(`CREATE OPERATOR CLASS c FOR TYPE int USING btree AS ${items};`);
    expect(opclass("OPERATOR x <")).toThrow(/Expected an integer but found "x"/);
    expect(opclass("OPERATOR 1.5 <")).toThrow(/Expected an integer but found "1.5"/);
    expect(opclass("FROB 1")).toThrow(/Expected "operator", "function" or "storage" but found "frob"/);
    expect(opclass("OPERATOR 1 < (int)")).toThrow(/Expected "," but found "\)"/);
    expect(opclass("OPERATOR 1 < FOR frob")).toThrow(/Expected "search" or "order" but found "frob"/);
    expect(fails("CREATE OPERATOR CLASS c FOR TYPE int USING btree OPERATOR 1 <;")).toThrow(
      /Expected "as" but found "operator"/,
    );
    expect(fails("CREATE OPERATOR FAMILY f;")).toThrow(/Expected "using" but found ";"/);
    expect(fails("DROP CAST (a, b);")).toThrow(/Expected "as" but found ","/);
    expect(fails("DROP OPERATOR +;")).toThrow(/Expected "\(" but found ";"/);
    expect(fails("DROP OPERATOR + (NONE, NONE);")).toThrow(/not NONE twice/);
    expect(fails("DROP OPERATOR CLASS c;")).toThrow(/Expected "using" but found ";"/);
    // CAST, OPERATOR CLASS and OPERATOR FAMILY drop one object at a time.
    expect(fails("DROP CAST (a AS b), (c AS d);")).toThrow(/Expected ";" but found ","/);
    expect(fails("DROP OPERATOR CLASS c USING btree, d USING btree;")).toThrow(/Expected ";" but found ","/);
    expect(fails("DROP TEXT SEARCH x y;")).toThrow(/Expected "parser", "dictionary", "template" or "configuration"/);
    expect(fails("DROP EVENT e;")).toThrow(/Expected "trigger" but found "e"/);
    expect(fails("DROP frobnicate x;")).toThrow(
      expectsKeys(["cast", "collation", "operator", "text", "event", "access", "procedural"], '"frobnicate"'),
    );
  });

  it("keeps the new words unreserved as names and aliases", () => {
    const words = [
      "collation conversion statistics event trigger language trusted procedural handler inline validator",
      "access method text search parser dictionary template configuration operator class family storage",
      "without inout implicit assignment tag none dependencies ndistinct provider locale",
    ]
      .join(" ")
      .split(" ");
    expect(firstStmt(`SELECT ${words.join(", ")} FROM t;`).columns.map((c: any) => c.expr)).toEqual(
      words.map((word) => name(word)),
    );
    expect(firstStmt("SELECT 1 AS handler, 2 storage FROM statistics AS collation;")).toMatchObject({
      columns: [{ alias: "handler" }, { alias: "storage" }],
      from: [{ name: ["statistics"], alias: "collation" }],
    });
    expect(firstStmt("CREATE TABLE operator (class int, family text, inout int, validator int);")).toMatchObject({
      name: ["operator"],
    });
    // …and as the names of the objects being created.
    expect(firstStmt('CREATE COLLATION collation FROM "C";')).toMatchObject({ name: ["collation"] });
    expect(firstStmt("CREATE STATISTICS statistics ON storage FROM text;")).toMatchObject({
      name: ["statistics"],
      on: [name("storage")],
      from: [["text"]],
    });
    expect(firstStmt("CREATE LANGUAGE language HANDLER handler INLINE inline VALIDATOR validator;")).toMatchObject({
      name: "language",
      handler: ["handler"],
      inline: ["inline"],
      validator: ["validator"],
    });
    expect(firstStmt("CREATE OPERATOR CLASS class FOR TYPE storage USING family AS STORAGE storage;")).toMatchObject({
      name: ["class"],
      type: ty("storage"),
      using: "family",
    });
    expect(firstStmt("CREATE OPERATOR FAMILY family USING method;")).toMatchObject({ name: ["family"] });
    expect(firstStmt("CREATE TYPE type;")).toEqual({ kind: "createType", form: "shell", name: ["type"] });
    expect(firstStmt("DROP OPERATOR family.+ (int, int);")).toMatchObject({
      objectType: "operator",
      names: [["family", "+"]],
    });
  });
});

// --- typed tables, storage clauses, CTAS forms, column storage, constraint
// triggers, transition tables and temp / recursive views ---

const plainType = (typeName: string) => ({ name: typeName, args: [], array: false });
const plainColumn = (colName: string, typeName: string, extra: Record<string, unknown> = {}) => ({
  kind: "column",
  name: colName,
  dataType: plainType(typeName),
  ...extra,
  constraints: [],
});
const selectOne = sel({ columns: [col(num(1))] });
const parseFails = (src: string) => () => sqlLite.parse(src);

describe("SQL-lite typed tables (OF type)", () => {
  it("parses a typed table, its column options and its trailing clauses", () => {
    expect(firstStmt("CREATE TABLE t OF typ;")).toEqual({
      kind: "createTable",
      ifNotExists: false,
      name: ["t"],
      items: [],
      ofType: ["typ"],
    });
    expect(
      firstStmt(
        "CREATE TABLE IF NOT EXISTS s.t OF s.typ (a WITH OPTIONS NOT NULL, b DEFAULT 1, PRIMARY KEY (a)) PARTITION BY RANGE (a) USING heap WITH (fillfactor = 70) TABLESPACE ts;",
      ),
    ).toEqual({
      kind: "createTable",
      ifNotExists: true,
      name: ["s", "t"],
      items: [
        { kind: "columnOptions", name: "a", withOptions: true, constraints: [{ kind: "notNull" }] },
        { kind: "columnOptions", name: "b", constraints: [{ kind: "default", expr: num(1) }] },
        { kind: "primaryKey", name: null, columns: ["a"] },
      ],
      ofType: ["s", "typ"],
      partitionBy: { strategy: "range", keys: [{ expr: name("a") }] },
      accessMethod: "heap",
      options: [{ name: "fillfactor", value: num(70) }],
      tablespace: "ts",
    });
    expect(firstStmt("CREATE TEMP TABLE t OF typ ON COMMIT DROP;")).toEqual({
      kind: "createTable",
      ifNotExists: false,
      name: ["t"],
      items: [],
      ofType: ["typ"],
      onCommit: "drop",
      modifiers: ["temp"],
    });
  });

  it("rejects an empty list, typed columns, LIKE and INHERITS", () => {
    expect(parseFails("CREATE TABLE t OF typ ();")).toThrow(/Expected .* but found "\)"/);
    expect(parseFails("CREATE TABLE t OF typ (a int);")).toThrow(/but found "int"/);
    expect(parseFails("CREATE TABLE t OF typ (LIKE x);")).toThrow(/but found "like"/);
    expect(parseFails("CREATE TABLE t OF typ INHERITS (p);")).toThrow(/Expected ";" but found "inherits"/);
  });

  it("keeps of unreserved as names", () => {
    expect(firstStmt("CREATE TABLE of OF of;")).toEqual({
      kind: "createTable",
      ifNotExists: false,
      name: ["of"],
      items: [],
      ofType: ["of"],
    });
    expect(firstStmt("CREATE TABLE of (of int);").items).toEqual([plainColumn("of", "int")]);
  });
});

describe("SQL-lite USING method and WITHOUT OIDS table clauses", () => {
  it("parses them among a table's storage clauses, in PG's order", () => {
    expect(
      firstStmt("CREATE TABLE t (a int) INHERITS (p) USING heap WITHOUT OIDS ON COMMIT PRESERVE ROWS TABLESPACE ts;"),
    ).toEqual({
      kind: "createTable",
      ifNotExists: false,
      name: ["t"],
      items: [plainColumn("a", "int")],
      inherits: [["p"]],
      accessMethod: "heap",
      withoutOids: true,
      onCommit: "preserveRows",
      tablespace: "ts",
    });
    expect(firstStmt("CREATE TABLE p1 PARTITION OF p FOR VALUES IN (1) USING heap;")).toEqual({
      kind: "createTable",
      ifNotExists: false,
      name: ["p1"],
      items: [],
      partitionOf: { parent: ["p"], bound: { kind: "list", values: [num(1)] } },
      accessMethod: "heap",
    });
  });

  it("rejects them out of order, together with WITH, or incomplete", () => {
    expect(parseFails("CREATE TABLE t (a int) WITH (x = 1) WITHOUT OIDS;")).toThrow(/Expected ";" but found "without"/);
    expect(parseFails("CREATE TABLE t (a int) TABLESPACE ts USING heap;")).toThrow(/Expected ";" but found "using"/);
    expect(parseFails("CREATE TABLE t (a int) WITHOUT;")).toThrow(/Expected "oids" but found ";"/);
  });

  it("keeps without, oids and heap unreserved", () => {
    expect(firstStmt("CREATE TABLE heap (without int, oids int) USING heap;")).toEqual({
      kind: "createTable",
      ifNotExists: false,
      name: ["heap"],
      items: [plainColumn("without", "int"), plainColumn("oids", "int")],
      accessMethod: "heap",
    });
    expect(firstStmt("SELECT without, oids, heap AS oids FROM heap AS without;")).toEqual(
      sel({
        columns: [col(name("without")), col(name("oids")), col(name("heap"), "oids")],
        from: [tableFrom(["heap"], "without")],
      }),
    );
  });
});

describe("SQL-lite CREATE TABLE AS TABLE and AS EXECUTE", () => {
  it("parses both, with their storage clauses and WITH [NO] DATA", () => {
    expect(firstStmt("CREATE TABLE x (a, b) USING heap WITHOUT OIDS TABLESPACE ts AS TABLE t WITH NO DATA;")).toEqual({
      kind: "createTableAs",
      ifNotExists: false,
      name: ["x"],
      columns: ["a", "b"],
      query: { kind: "tableCmd", name: ["t"] },
      withData: false,
      accessMethod: "heap",
      withoutOids: true,
      tablespace: "ts",
    });
    expect(firstStmt("CREATE TABLE x USING heap AS EXECUTE p(1, 'a') WITH DATA;")).toEqual({
      kind: "createTableAs",
      ifNotExists: false,
      name: ["x"],
      columns: null,
      query: { kind: "execute", name: "p", args: [num(1), str("a")] },
      withData: true,
      accessMethod: "heap",
    });
    expect(firstStmt("CREATE TEMP TABLE IF NOT EXISTS x (a) AS EXECUTE p;")).toEqual({
      kind: "createTableAs",
      ifNotExists: true,
      name: ["x"],
      columns: ["a"],
      query: { kind: "execute", name: "p", args: null },
      withData: null,
      modifiers: ["temp"],
    });
    // EXPLAIN takes the EXECUTE form too, as PG's ExplainableStmt does.
    expect(firstStmt("EXPLAIN CREATE TABLE x AS EXECUTE p;").statement).toEqual({
      kind: "createTableAs",
      ifNotExists: false,
      name: ["x"],
      columns: null,
      query: { kind: "execute", name: "p", args: null },
      withData: null,
    });
  });

  it("rejects an empty argument list and clauses out of order", () => {
    expect(parseFails("CREATE TABLE x AS EXECUTE p();")).toThrow(/but found "\)"/);
    expect(parseFails("CREATE TABLE x AS frob;")).toThrow(/Expected a query or "execute" but found "frob"/);
    expect(parseFails("CREATE TABLE x (a, b) WITH (x = 1) WITHOUT OIDS AS SELECT 1;")).toThrow(
      /Expected "as" but found "without"/,
    );
    expect(parseFails("CREATE SCHEMA s CREATE TABLE x AS EXECUTE p;")).toThrow(/cannot be CREATE TABLE AS/);
  });

  it("keeps execute unreserved as a table name", () => {
    expect(firstStmt("CREATE TABLE execute AS EXECUTE execute;")).toEqual({
      kind: "createTableAs",
      ifNotExists: false,
      name: ["execute"],
      columns: null,
      query: { kind: "execute", name: "execute", args: null },
      withData: null,
    });
  });
});

describe("SQL-lite column STORAGE and COMPRESSION", () => {
  it("parses both ahead of a column's constraints", () => {
    expect(
      firstStmt(
        'CREATE TABLE t (a text STORAGE external COMPRESSION lz4 NOT NULL, b text STORAGE DEFAULT, c text COMPRESSION default, d text STORAGE "MAIN", e text COMPRESSION "DEFAULT");',
      ).items,
    ).toEqual([
      { ...plainColumn("a", "text", { storage: "external", compression: "lz4" }), constraints: [{ kind: "notNull" }] },
      plainColumn("b", "text", { storage: "default" }),
      plainColumn("c", "text", { compression: "default" }),
      plainColumn("d", "text", { storage: "main" }),
      plainColumn("e", "text", { compression: "DEFAULT" }),
    ]);
    expect(firstStmt("ALTER TABLE t ADD COLUMN a text STORAGE plain, ADD b int COMPRESSION lz4;").actions).toEqual([
      { kind: "addColumn", ifNotExists: false, column: plainColumn("a", "text", { storage: "plain" }) },
      { kind: "addColumn", ifNotExists: false, column: plainColumn("b", "int", { compression: "lz4" }) },
    ]);
    // SET STORAGE and SET COMPRESSION share the readers, and keep their nulls.
    expect(firstStmt('ALTER TABLE t ALTER a SET STORAGE "DEFAULT", ALTER b SET COMPRESSION default;').actions).toEqual([
      { kind: "setStorage", column: "a", storage: null },
      { kind: "setCompression", column: "b", method: null },
    ]);
  });

  it("reads them ahead of a column's OPTIONS, foreign tables included", () => {
    expect(
      firstStmt("CREATE FOREIGN TABLE ft (a int STORAGE plain COMPRESSION lz4 OPTIONS (x 'y') NOT NULL) SERVER s;")
        .items,
    ).toEqual([
      {
        ...plainColumn("a", "int", { storage: "plain", compression: "lz4", options: [{ name: "x", value: "y" }] }),
        constraints: [{ kind: "notNull" }],
      },
    ]);
    expect(parseFails("CREATE TABLE t (a int OPTIONS (x 'y') STORAGE plain);")).toThrow(
      /Expected "," but found "storage"/,
    );
  });

  it("rejects them out of order or with an unknown storage mode", () => {
    expect(parseFails("CREATE TABLE t (a text COMPRESSION lz4 STORAGE main);")).toThrow(
      /Expected "," but found "storage"/,
    );
    expect(parseFails('CREATE TABLE t (a text COLLATE "C" STORAGE main);')).toThrow(/Expected "," but found "storage"/);
    expect(parseFails("CREATE TABLE t (a text STORAGE bogus);")).toThrow(/invalid storage type "bogus"/);
  });

  it("keeps storage and compression unreserved", () => {
    expect(
      firstStmt("CREATE TABLE storage (storage text STORAGE main COMPRESSION compression, compression int);"),
    ).toEqual({
      kind: "createTable",
      ifNotExists: false,
      name: ["storage"],
      items: [
        plainColumn("storage", "text", { storage: "main", compression: "compression" }),
        plainColumn("compression", "int"),
      ],
    });
    expect(firstStmt("SELECT storage, compression AS storage FROM compression storage;")).toEqual(
      sel({
        columns: [col(name("storage")), col(name("compression"), "storage")],
        from: [tableFrom(["compression"], "storage")],
      }),
    );
  });
});

describe("SQL-lite CREATE CONSTRAINT TRIGGER", () => {
  it("parses FROM and the deferral attributes", () => {
    expect(
      firstStmt(
        "CREATE CONSTRAINT TRIGGER c AFTER INSERT OR UPDATE ON t FROM s.r DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.a > 0) EXECUTE FUNCTION f(1);",
      ),
    ).toEqual({
      kind: "createTrigger",
      orReplace: false,
      name: "c",
      timing: "after",
      events: [
        { event: "insert", columns: null },
        { event: "update", columns: null },
      ],
      table: ["t"],
      constraint: true,
      fromTable: ["s", "r"],
      deferrable: true,
      initially: "deferred",
      forEach: "row",
      when: bin(">", name("new", "a"), num(0)),
      execute: { routine: "function", name: ["f"], args: [num(1)] },
    });
    const bare = {
      kind: "createTrigger",
      orReplace: false,
      name: "c",
      timing: "after",
      events: [{ event: "delete", columns: null }],
      table: ["t"],
      constraint: true,
      forEach: "row",
      when: null,
      execute: { routine: "procedure", name: ["f"], args: [] },
    };
    expect(firstStmt("CREATE CONSTRAINT TRIGGER c AFTER DELETE ON t FOR EACH ROW EXECUTE PROCEDURE f();")).toEqual(
      bare,
    );
    expect(
      firstStmt(
        "CREATE CONSTRAINT TRIGGER c AFTER DELETE ON t NOT DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE PROCEDURE f();",
      ),
    ).toEqual({ ...bare, deferrable: false, initially: "immediate" });
    // A schema element may be one, as in PG's schema_stmt.
    expect(
      firstStmt("CREATE SCHEMA s CREATE CONSTRAINT TRIGGER c AFTER DELETE ON t FOR EACH ROW EXECUTE PROCEDURE f();")
        .elements,
    ).toEqual([bare]);
  });

  it("rejects other timings, row-less and statement forms, REFERENCING and refused attributes", () => {
    const trig = (middle: string) => `CREATE CONSTRAINT TRIGGER c AFTER DELETE ON t ${middle} EXECUTE PROCEDURE f();`;
    expect(parseFails("CREATE CONSTRAINT TRIGGER c BEFORE DELETE ON t FOR EACH ROW EXECUTE PROCEDURE f();")).toThrow(
      /Expected "after" but found "before"/,
    );
    expect(parseFails(trig("FOR ROW"))).toThrow(/Expected "each" but found "row"/);
    expect(parseFails(trig("FOR EACH STATEMENT"))).toThrow(/Expected "row" but found "statement"/);
    expect(parseFails(trig("NOT VALID FOR EACH ROW"))).toThrow(/TRIGGER constraints cannot be marked NOT VALID/);
    expect(parseFails(trig("NO INHERIT FOR EACH ROW"))).toThrow(/TRIGGER constraints cannot be marked NO INHERIT/);
    expect(parseFails(trig("NOT DEFERRABLE INITIALLY DEFERRED FOR EACH ROW"))).toThrow(
      /constraint declared INITIALLY DEFERRED must be DEFERRABLE/,
    );
    expect(parseFails(trig("REFERENCING NEW TABLE n FOR EACH ROW"))).toThrow(
      /Expected "for each row" but found "referencing"/,
    );
    expect(
      parseFails("CREATE OR REPLACE CONSTRAINT TRIGGER c AFTER DELETE ON t FOR EACH ROW EXECUTE PROCEDURE f();"),
    ).toThrow(/CREATE OR REPLACE CONSTRAINT TRIGGER is not supported/);
    expect(
      parseFails(
        "CREATE SCHEMA s CREATE OR REPLACE CONSTRAINT TRIGGER c AFTER DELETE ON t FOR EACH ROW EXECUTE PROCEDURE f();",
      ),
    ).toThrow(/CREATE OR REPLACE CONSTRAINT TRIGGER is not supported/);
    // FROM and the deferral attributes belong to constraint triggers only.
    expect(parseFails("CREATE TRIGGER tr AFTER INSERT ON t FROM x FOR EACH ROW EXECUTE FUNCTION f();")).toThrow(
      /Expected "execute" but found "from"/,
    );
    expect(parseFails("CREATE TRIGGER tr AFTER INSERT ON t DEFERRABLE FOR EACH ROW EXECUTE FUNCTION f();")).toThrow(
      /Expected "execute" but found "deferrable"/,
    );
  });
});

describe("SQL-lite duplicate trigger events", () => {
  it("rejects an event written twice, UPDATE OF included, as PG's grammar does", () => {
    expect(
      parseFails("CREATE CONSTRAINT TRIGGER c AFTER INSERT OR INSERT ON t FOR EACH ROW EXECUTE PROCEDURE f();"),
    ).toThrow(/duplicate trigger events specified \(1:44\)/);
    expect(parseFails("CREATE TRIGGER tr AFTER UPDATE OF a OR DELETE OR UPDATE ON t EXECUTE FUNCTION f();")).toThrow(
      /duplicate trigger events specified/,
    );
  });
});

describe("SQL-lite lead words of the prefixed, recursive and constraint CREATE forms", () => {
  it("names them where they may stand, and takes them as schema elements", () => {
    // The lead words neither CREATE map holds are named where they may stand.
    expect(parseFails("CREATE OR REPLACE frobnicate v;")).toThrow(
      expectsKeys(["view", "trigger", "recursive", "temp", "temporary", "local", "global"], '"frobnicate"'),
    );
    expect(parseFails("CREATE SCHEMA s CREATE frobnicate t;")).toThrow(
      expectsKeys(["table", "trigger", "recursive", "constraint", "temp", "unlogged"], '"frobnicate"'),
    );
    expect(parseFails("CREATE SCHEMA s CREATE UNLOGGED foo;")).toThrow(/Expected "table" but found "foo"/);
    expect(parseFails("CREATE SCHEMA s CREATE TEMP TABLE t AS SELECT 1;")).toThrow(/cannot be CREATE TABLE AS/);
    expect(firstStmt("CREATE SCHEMA s CREATE UNLOGGED TABLE t (a int) CREATE TEMP TABLE u (b int);").elements).toEqual([
      {
        kind: "createTable",
        ifNotExists: false,
        name: ["t"],
        items: [plainColumn("a", "int")],
        modifiers: ["unlogged"],
      },
      { kind: "createTable", ifNotExists: false, name: ["u"], items: [plainColumn("b", "int")], modifiers: ["temp"] },
    ]);
  });
});

describe("SQL-lite trigger REFERENCING transition tables", () => {
  it("parses OLD and NEW TABLE, AS optional, in either order", () => {
    expect(
      firstStmt(
        "CREATE TRIGGER tr AFTER UPDATE ON t REFERENCING NEW TABLE AS n OLD TABLE o FOR EACH STATEMENT EXECUTE FUNCTION f();",
      ),
    ).toEqual({
      kind: "createTrigger",
      orReplace: false,
      name: "tr",
      timing: "after",
      events: [{ event: "update", columns: null }],
      table: ["t"],
      referencing: [
        { kind: "new", name: "n" },
        { kind: "old", name: "o" },
      ],
      forEach: "statement",
      when: null,
      execute: { routine: "function", name: ["f"], args: [] },
    });
  });

  it("rejects ROW transitions and an empty clause", () => {
    expect(
      parseFails("CREATE TRIGGER tr AFTER INSERT ON t REFERENCING NEW ROW AS n FOR EACH ROW EXECUTE FUNCTION f();"),
    ).toThrow(/ROW variable naming in the REFERENCING clause is not supported/);
    expect(parseFails("CREATE TRIGGER tr AFTER INSERT ON t REFERENCING FOR EACH ROW EXECUTE FUNCTION f();")).toThrow(
      /Expected "old" or "new" but found "for"/,
    );
  });

  it("keeps referencing, old and new unreserved", () => {
    expect(
      firstStmt(
        "CREATE TRIGGER referencing AFTER INSERT ON new REFERENCING OLD TABLE old NEW TABLE new EXECUTE FUNCTION referencing();",
      ),
    ).toEqual({
      kind: "createTrigger",
      orReplace: false,
      name: "referencing",
      timing: "after",
      events: [{ event: "insert", columns: null }],
      table: ["new"],
      referencing: [
        { kind: "old", name: "old" },
        { kind: "new", name: "new" },
      ],
      forEach: null,
      when: null,
      execute: { routine: "function", name: ["referencing"], args: [] },
    });
    expect(firstStmt("SELECT referencing, old AS new FROM new old;")).toEqual(
      sel({ columns: [col(name("referencing")), col(name("old"), "new")], from: [tableFrom(["new"], "old")] }),
    );
  });
});

describe("SQL-lite TEMP and RECURSIVE views", () => {
  const view = (over: Record<string, unknown>) => ({
    kind: "createView",
    materialized: false,
    orReplace: false,
    ifNotExists: false,
    name: ["v"],
    columns: null,
    query: selectOne,
    withData: null,
    ...over,
  });

  it("parses both, with or without OR REPLACE", () => {
    expect(firstStmt("CREATE TEMP VIEW v AS SELECT 1;")).toEqual(view({ modifiers: ["temp"] }));
    expect(firstStmt("CREATE GLOBAL TEMPORARY VIEW v AS SELECT 1;")).toEqual(
      view({ modifiers: ["global", "temporary"] }),
    );
    expect(firstStmt("CREATE OR REPLACE TEMPORARY VIEW v (a) AS SELECT 1;")).toEqual(
      view({ orReplace: true, columns: ["a"], modifiers: ["temporary"] }),
    );
    expect(firstStmt("CREATE LOCAL TEMP RECURSIVE VIEW v (n) AS SELECT 1;")).toEqual(
      view({ columns: ["n"], recursive: true, modifiers: ["local", "temp"] }),
    );
    expect(firstStmt("CREATE OR REPLACE RECURSIVE VIEW v (n) WITH (security_barrier) AS SELECT 1;")).toEqual(
      view({ orReplace: true, columns: ["n"], recursive: true, options: [{ name: "security_barrier", value: null }] }),
    );
    // The span opens on CREATE, as an unprefixed view's does.
    expect((sqlLite.parse("CREATE TEMP VIEW v AS SELECT 1;")[0] as Record<string, any>).span.start).toEqual({
      row: 1,
      col: 0,
    });
    // Schema elements take both, as in PG's schema_stmt.
    expect(
      firstStmt("CREATE SCHEMA s CREATE TEMP VIEW v AS SELECT 1 CREATE RECURSIVE VIEW v (n) AS SELECT 1;").elements,
    ).toEqual([view({ modifiers: ["temp"] }), view({ columns: ["n"], recursive: true })]);
  });

  it("rejects a RECURSIVE view without columns or with a check option, and an unlogged view", () => {
    expect(parseFails("CREATE RECURSIVE VIEW v AS SELECT 1;")).toThrow(/Expected "\(" but found "as" \(1:24\)/);
    expect(parseFails("CREATE RECURSIVE VIEW v () AS SELECT 1;")).toThrow(/Expected a name but found "\)"/);
    expect(parseFails("CREATE RECURSIVE VIEW v (n) AS SELECT 1 WITH CHECK OPTION;")).toThrow(
      /WITH CHECK OPTION not supported on recursive views/,
    );
    for (const src of [
      "CREATE UNLOGGED VIEW v AS SELECT 1;",
      "CREATE OR REPLACE UNLOGGED VIEW v AS SELECT 1;",
      "CREATE UNLOGGED RECURSIVE VIEW v (n) AS SELECT 1;",
    ]) {
      expect(parseFails(src)).toThrow(/views cannot be unlogged because they do not have storage/);
    }
    expect(parseFails("CREATE TEMP MATERIALIZED VIEW mv AS SELECT 1;")).toThrow(
      /Expected "table", "recursive" or "view" but found "materialized"/,
    );
    expect(parseFails("EXPLAIN CREATE TEMP VIEW v AS SELECT 1;")).toThrow(
      /EXPLAIN takes CREATE TABLE AS or CREATE MATERIALIZED VIEW/,
    );
  });

  it("keeps recursive unreserved", () => {
    expect(firstStmt("CREATE RECURSIVE VIEW recursive (recursive) AS SELECT 1;")).toEqual(
      view({ name: ["recursive"], columns: ["recursive"], recursive: true }),
    );
    expect(firstStmt("CREATE VIEW recursive AS SELECT recursive FROM recursive;")).toEqual(
      view({
        name: ["recursive"],
        query: sel({ columns: [col(name("recursive"))], from: [tableFrom(["recursive"])] }),
      }),
    );
  });
});

describe("SQL-lite UNLOGGED materialized views and their storage clauses", () => {
  it("parses UNLOGGED, USING, WITH and TABLESPACE, and AS TABLE", () => {
    expect(
      firstStmt(
        "CREATE UNLOGGED MATERIALIZED VIEW IF NOT EXISTS mv (a) USING heap WITH (fillfactor = 50) TABLESPACE ts AS TABLE t WITH NO DATA;",
      ),
    ).toEqual({
      kind: "createView",
      materialized: true,
      orReplace: false,
      ifNotExists: true,
      name: ["mv"],
      columns: ["a"],
      query: { kind: "tableCmd", name: ["t"] },
      withData: false,
      accessMethod: "heap",
      options: [{ name: "fillfactor", value: num(50) }],
      tablespace: "ts",
      modifiers: ["unlogged"],
    });
    expect(firstStmt("CREATE MATERIALIZED VIEW mv TABLESPACE ts AS SELECT 1;")).toEqual({
      kind: "createView",
      materialized: true,
      orReplace: false,
      ifNotExists: false,
      name: ["mv"],
      columns: null,
      query: selectOne,
      withData: null,
      tablespace: "ts",
    });
  });

  it("rejects the clauses out of order, on a plain view, and AS EXECUTE", () => {
    expect(parseFails("CREATE MATERIALIZED VIEW mv USING heap TABLESPACE ts WITH (x = 1) AS SELECT 1;")).toThrow(
      /Expected "as" but found "with"/,
    );
    expect(parseFails("CREATE VIEW v TABLESPACE ts AS SELECT 1;")).toThrow(/Expected "as" but found "tablespace"/);
    expect(parseFails("CREATE OR REPLACE UNLOGGED MATERIALIZED VIEW v AS SELECT 1;")).toThrow(
      /Expected "recursive" or "view" but found "materialized"/,
    );
    expect(parseFails("CREATE VIEW v USING heap AS SELECT 1;")).toThrow(/Expected "as" but found "using"/);
    expect(parseFails("CREATE MATERIALIZED VIEW mv AS EXECUTE p;")).toThrow(/but found "execute"/);
    // In a schema element it is refused at MATERIALIZED, as an unprefixed one is.
    expect(parseFails("CREATE SCHEMA s CREATE UNLOGGED MATERIALIZED VIEW mv AS SELECT 1;")).toThrow(
      /Expected "table" but found "materialized" \(1:32\)/,
    );
  });

  it("spans from CREATE, and is explainable", () => {
    expect(
      (sqlLite.parse("CREATE UNLOGGED MATERIALIZED VIEW mv AS SELECT 1;")[0] as Record<string, any>).span.start,
    ).toEqual({ row: 1, col: 0 });
    expect(firstStmt("EXPLAIN CREATE UNLOGGED MATERIALIZED VIEW mv AS SELECT 1;").statement).toEqual({
      kind: "createView",
      materialized: true,
      orReplace: false,
      ifNotExists: false,
      name: ["mv"],
      columns: null,
      query: selectOne,
      withData: null,
      modifiers: ["unlogged"],
    });
  });

  it("keeps tablespace unreserved", () => {
    expect(firstStmt("CREATE MATERIALIZED VIEW mv (tablespace) TABLESPACE tablespace AS SELECT 1;")).toEqual({
      kind: "createView",
      materialized: true,
      orReplace: false,
      ifNotExists: false,
      name: ["mv"],
      columns: ["tablespace"],
      query: selectOne,
      withData: null,
      tablespace: "tablespace",
    });
  });
});

// --- psql scripts: sqlLiteScript ---

describe("SQL-lite psql scripts", () => {
  const script = (text: string) => stripSpans(sqlLiteScript.parse(text)) as Record<string, any>[];
  const bad = (src: string) => () => sqlLiteScript.parse(src);
  const meta = (command: string, args = "") => ({ kind: "psqlMeta", command, args });
  const copyIn = (table: string, data?: string) => ({
    kind: "copy",
    table: [table],
    columns: null,
    query: null,
    direction: "from",
    location: { kind: "stdin" },
    options: null,
    where: null,
    ...(data === undefined ? {} : { data }),
  });
  const one = firstStmt("SELECT 1;");
  const two = firstStmt("SELECT 2;");

  it("attaches the rows after COPY … FROM STDIN as data, verbatim", () => {
    const rows = "1\tit's; -- not a comment\n2\t\\N\n\n";
    expect(script(`COPY t FROM stdin;\n${rows}\\.\nSELECT 1;`)).toEqual([copyIn("t", rows), one]);
    expect(script('COPY t FROM STDIN (FORMAT csv);\na,"b;c"\n\\.\n')).toEqual([
      { ...copyIn("t", 'a,"b;c"\n'), options: [{ name: "format", value: { kind: "name", parts: ["csv"] } }] },
    ]);
    // The pre-9.0 spelling, the BINARY prefix included, takes its rows too.
    expect(
      script("COPY BINARY t FROM stdin;\nxx\n\\.\nCOPY t FROM stdin WITH CSV HEADER NULL AS '';\na,b\n\\.\n"),
    ).toEqual([
      {
        ...copyIn("t", "xx\n"),
        options: [{ name: "format", value: { kind: "name", parts: ["binary"] } }],
        legacy: true,
      },
      {
        ...copyIn("t", "a,b\n"),
        options: [
          { name: "format", value: { kind: "name", parts: ["csv"] } },
          { name: "header", value: null },
          { name: "null", value: { kind: "string", value: "" } },
        ],
        legacy: true,
      },
    ]);
    // A row is data even when it looks like a terminator or a meta-command.
    expect(script("COPY t FROM stdin;\n \\.\n\\.x\n\\connect db\n\\.")).toEqual([
      copyIn("t", " \\.\n\\.x\n\\connect db\n"),
    ]);
  });

  it("gives an empty block empty data, and reads CRLF line ends", () => {
    expect(script("COPY t FROM stdin;\n\\.\nSELECT 1;")).toEqual([copyIn("t", ""), one]);
    expect(script("COPY t FROM stdin;\r\n1\r\n\\.\r\nSELECT 1;\r\n")).toEqual([copyIn("t", "1\r\n"), one]);
    // Whitespace or a comment may follow the COPY's `;` on its line.
    expect(script("COPY t FROM stdin;  -- rows follow\n1\n\\.")).toEqual([copyIn("t", "1\n")]);
  });

  it("reads the rows once, whatever lookahead the COPY's parse does", () => {
    const sql = "COPY t (a, b) FROM stdin WITH (FORMAT csv, HEADER) WHERE a IN (SELECT x FROM u) AND (b, a) > (1, 2);";
    expect(script(`${sql}\na,b\n1,2\n\\.\n${sql}\n\\.\nSELECT 1;`)).toEqual([
      { ...firstStmt(sql), data: "a,b\n1,2\n" },
      { ...firstStmt(sql), data: "" },
      one,
    ]);
  });

  it("keeps spans true across the data block", () => {
    const dataSpan = (text: string) => {
      const tokens = sqlScriptParseLexer.tokenize(createInputStream(text));
      for (let token = tokens.next(); token !== null; token = tokens.next()) {
        if (token.type === "copydata") return token.position;
      }
      return null;
    };
    // From the first row through the `\.`, a CRLF line's `\r` aside.
    for (const eol of ["\n", "\r\n"]) {
      expect(dataSpan(`COPY t FROM stdin;${eol}1${eol}\\.${eol}x`)).toEqual({
        start: { row: 2, col: 0 },
        end: { row: 3, col: 2 },
      });
    }
    expect(sqlLiteScript.diagnose("COPY t FROM stdin; ab cd   \n1\n\\.").errors[0]!.end).toEqual({ row: 1, col: 24 });
    expect(() => sqlLiteScript.parse("COPY t FROM stdin; x \r\n1\n\\.")).toThrow(
      expect.objectContaining({ end: { row: 1, col: 20 } }),
    );
    expect((sqlLiteScript.parse("\\x\r\nSELECT 1;")[0] as any).span).toEqual({
      start: { row: 1, col: 0 },
      end: { row: 1, col: 2 },
    });
    const [copy, select] = sqlLiteScript.parse("COPY t FROM stdin;\n1\n2\n\\.\nSELECT 1;") as any[];
    expect(copy.span).toEqual({ start: { row: 1, col: 0 }, end: { row: 1, col: 17 } });
    expect(select.span).toEqual({ start: { row: 5, col: 0 }, end: { row: 5, col: 8 } });
    expect(bad("COPY t FROM stdin;\n1\n\\.\nSELECT 1 +;")).toThrow(/\(4:10\)/);
  });

  it("reads data only after a COPY from STDIN", () => {
    const toStdout = { ...copyIn("t"), direction: "to", location: { kind: "stdout" } };
    expect(script("COPY t TO stdout;\n\\.\n")).toEqual([toStdout, meta(".")]);
    expect(script("SELECT * FROM stdin;\nSELECT 1;")).toEqual([firstStmt("SELECT * FROM stdin;"), one]);
    expect(script("COPY t (stdin) FROM 'f';\nSELECT 1;")).toEqual([
      { ...copyIn("t"), columns: ["stdin"], location: { kind: "file", path: "f" } },
      one,
    ]);
    expect(script("COPY (SELECT 'from stdin') TO STDOUT;\nSELECT 1;")).toHaveLength(2);
    expect(script("COPY t FROM 'f' WHERE a IS DISTINCT FROM stdin;\nSELECT 1;")).toHaveLength(2);
    // Rows are read for a statement the grammar rejects, a qualified name included.
    expect(sqlLiteScript.diagnose("COPY s.from FROM stdin;\n1\n\\.\nSELECT 1;").ast).toHaveLength(1);
    // A COPY with no `;` ends the input, so it has no rows to read. Without
    // rows, `data` is absent, not undefined.
    expect(script("COPY t FROM stdin")).toStrictEqual([copyIn("t")]);
    expect("data" in parse("COPY t FROM stdin;\nSELECT 1;")[0]!).toBe(false);
  });

  it("keeps copy and stdin unreserved as names", () => {
    expect(script("COPY stdin FROM stdin;\n1\n\\.")).toEqual([copyIn("stdin", "1\n")]);
    // Rows are taken even when a table named `from` is rejected, after an
    // earlier COPY that ended on a qualified name's dot too.
    for (const sql of ["COPY from FROM stdin;", "COPY from.t FROM stdin;", "COPY s.;\nCOPY from FROM stdin;"]) {
      expect(stripSpans(sqlLiteScript.diagnose(`${sql}\n\\connect x\n\\.\nSELECT 1;`).ast)).toEqual([one]);
    }
    expect(script("SELECT copy, stdin FROM copy;\nSELECT 1;")).toEqual([
      firstStmt("SELECT copy, stdin FROM copy;"),
      one,
    ]);
  });

  it("rejects an unterminated block and text after the COPY's semicolon", () => {
    expect(bad("COPY t FROM stdin;\n1\n2")).toThrow(/COPY data is not terminated by a "\\\." line \(2:0\)/);
    expect(bad("COPY t FROM stdin;")).toThrow(/COPY data is not terminated/);
    expect(bad("COPY t FROM stdin; SELECT 1;\n\\.")).toThrow(/Unexpected text after COPY … FROM STDIN \(1:19\)/);
    expect(bad("COPY t FROM stdin; /* c */\n1\n\\.")).toThrow(/Unexpected text after COPY … FROM STDIN \(1:19\)/);
    expect(bad("COPY t FROM stdin; -\n1\n\\.")).toThrow(/Unexpected text after COPY … FROM STDIN \(1:19\)/);
    // With no terminator either, the rows swallowed the rest of the input: that is the error.
    expect(bad("COPY t FROM stdin; x\nSELECT 2;")).toThrow(/COPY data is not terminated/);
  });

  it("parses meta-command lines at the start, middle and end", () => {
    expect(
      script("\\restrict abc\nSELECT 1;\n\\connect -reuse-previous=on \"dbname='app'\"\nSELECT 2;\n\\unrestrict abc\n"),
    ).toEqual([
      meta("restrict", "abc"),
      one,
      meta("connect", "-reuse-previous=on \"dbname='app'\""),
      two,
      meta("unrestrict", "abc"),
    ]);
    // After a `;` on the same line, and with no statement at all.
    expect(script("SELECT 1; \\gset  \n")).toEqual([one, meta("gset")]);
    expect(script("\\set ON_ERROR_STOP on\r\n\\.")).toEqual([meta("set", "ON_ERROR_STOP on"), meta(".")]);
  });

  it("ends a command name at whitespace or a backslash, as psql does", () => {
    expect(script("\\dt+ s.*")).toEqual([meta("dt+", "s.*")]);
    expect(script("\\x\\y")).toEqual([meta("x", "\\y")]);
    expect(script("\\\\")).toEqual([meta("\\")]);
    expect(script("\\! ls -l")).toEqual([meta("!", "ls -l")]);
    expect(bad("\\")).toThrow(/Invalid psql meta-command "\\" \(1:0\)/);
    expect(bad("SELECT 1;\n\\ x")).toThrow(/Invalid psql meta-command "\\" \(2:0\)/);
  });

  it("parses statements as sqlLite does, spans included", () => {
    const text = "CREATE TABLE t (a int);\n-- c\nINSERT INTO t VALUES (1) /* c */ ;\nSELECT 1";
    expect(sqlLiteScript.parse(text)).toEqual(sqlLite.parse(text));
  });

  it("still rejects a backslash inside a statement", () => {
    expect(bad("SELECT 1 \\x;")).toThrow(/Unexpected character "\\" \(1:9\)/);
    expect(bad("SELECT 1 \\x")).toThrow(/Unexpected character "\\"/);
    // On a line of its own it is a meta-command, which cuts the statement short.
    expect(bad("SELECT\n\\x\n1;")).toThrow(/but found "\\x" \(2:0\)/);
    expect(bad("SELECT 1\n\\connect db")).toThrow(/Expected ";" but found "\\connect db" \(2:0\)/);
  });

  it("leaves sqlLite and sqlLexer strict", () => {
    expect(() => sqlLite.parse("\\connect db")).toThrow(/Unexpected character "\\"/);
    expect(() => sqlLite.parse("COPY t FROM stdin;\n1\n\\.")).toThrow(/Expected a statement but found "1" \(2:0\)/);
    expect(() => lex("\\x")).toThrow(/Unexpected character "\\"/);
    expect(lex("\\x", sqlScriptLexer)).toEqual([{ type: "psqlmeta", value: "\\x" }]);
  });

  it("recovers at the next statement, at a meta-command line and past COPY rows", () => {
    const { ast, errors } = sqlLiteScript.diagnose(
      [
        "SELECT FROM WHERE;",
        "\\connect db",
        "SELECT (1",
        "\\connect other",
        "COPY t FROM stdin WITH junk;",
        "1;SELECT 1;",
        "\\.",
        "bogus",
        "\\unrestrict k",
        "SELECT 2;",
      ].join("\n"),
    );
    expect(stripSpans(ast)).toEqual([meta("connect", "db"), meta("connect", "other"), meta("unrestrict", "k"), two]);
    expect(errors.map((error) => error.message)).toEqual([
      'Expected a name but found "where" (1:12)',
      'Expected ")" but found "\\connect other" (4:0)',
      'Expected "(" or a COPY option but found "junk" (5:23)',
      'Expected a statement or a psql meta-command but found "bogus" (8:0)',
    ]);
  });

  it("reports a backslash with no command name without losing the statement before it", () => {
    // `f(a)`'s parse looks one token past its `;`, at the bad line.
    const { ast, errors } = sqlLiteScript.diagnose("SELECT f(a);\n\\ x\n\\connect db\nSELECT 2;");
    expect(stripSpans(ast)).toEqual([firstStmt("SELECT f(a);"), meta("connect", "db"), two]);
    expect(errors.map((error) => error.message)).toEqual(['Invalid psql meta-command "\\" (2:0)']);
  });

  it("keeps a meta-command line that follows a lexer error", () => {
    const leads: [string, number][] = [
      ["SELECT 1;\n\\ x", 1],
      ["SELECT B'102'", 1],
      // The bad COPY and the text after its `;`.
      ["COPY t FROM stdin WITH junk; x\n1\n\\.", 2],
    ];
    for (const [lead, count] of leads) {
      const { ast, errors } = sqlLiteScript.diagnose(`${lead}\n\\connect db\nSELECT 2;`);
      expect(stripSpans(ast).slice(-2)).toEqual([meta("connect", "db"), two]);
      expect(errors).toHaveLength(count);
    }
  });

  it("keeps a COPY whose parse looked ahead into a bad data block", () => {
    const { ast, errors } = sqlLiteScript.diagnose("COPY t FROM stdin WHERE f(a); x\n1\n\\.\nSELECT 1;");
    expect(stripSpans(ast)).toEqual([{ ...firstStmt("COPY t FROM stdin WHERE f(a);"), data: "1\n" }, one]);
    expect(errors.map((error) => error.message)).toEqual(["Unexpected text after COPY … FROM STDIN (1:30)"]);
  });

  it("reports an error in the data block and keeps the COPY and its rows", () => {
    const { ast, errors } = sqlLiteScript.diagnose("COPY t FROM stdin; x\n1\n\\.\nSELECT 1;");
    expect(stripSpans(ast)).toEqual([copyIn("t", "1\n"), one]);
    expect(errors.map((error) => error.message)).toEqual(["Unexpected text after COPY … FROM STDIN (1:19)"]);
  });
});

// --- foreign data: wrappers, servers, user mappings, foreign tables ---

describe("SQL-lite foreign data", () => {
  const fails = (text: string) => () => sqlLite.parse(text);
  const ty = (typeName: string, args: number[] = []) => ({
    name: typeName,
    args,
    array: false,
  });
  const opt = (optionName: string, value: string) => ({
    name: optionName,
    value,
  });

  it("parses CREATE and ALTER FOREIGN DATA WRAPPER", () => {
    expect(firstStmt("CREATE FOREIGN DATA WRAPPER w;")).toEqual({
      kind: "createForeignDataWrapper",
      name: "w",
    });
    expect(
      firstStmt("CREATE FOREIGN DATA WRAPPER w HANDLER s.h NO VALIDATOR OPTIONS (debug 'true', user 'u');"),
    ).toEqual({
      kind: "createForeignDataWrapper",
      name: "w",
      functions: [
        { kind: "handler", name: ["s", "h"] },
        { kind: "validator", name: null },
      ],
      options: [opt("debug", "true"), opt("user", "u")],
    });
    // PG takes the clauses in any order.
    expect(firstStmt("CREATE FOREIGN DATA WRAPPER w VALIDATOR v NO HANDLER;").functions).toEqual([
      { kind: "validator", name: ["v"] },
      { kind: "handler", name: null },
    ]);
    expect(firstStmt("ALTER FOREIGN DATA WRAPPER w NO HANDLER OPTIONS (ADD a '1', SET b '2', DROP c, d '4');")).toEqual(
      {
        kind: "alterForeignDataWrapper",
        name: "w",
        functions: [{ kind: "handler", name: null }],
        options: [
          { action: "add", name: "a", value: "1" },
          { action: "set", name: "b", value: "2" },
          { action: "drop", name: "c" },
          opt("d", "4"),
        ],
      },
    );
    expect(firstStmt("ALTER FOREIGN DATA WRAPPER w VALIDATOR v;")).toEqual({
      kind: "alterForeignDataWrapper",
      name: "w",
      functions: [{ kind: "validator", name: ["v"] }],
    });
    expect(firstStmt("ALTER FOREIGN DATA WRAPPER w OPTIONS (DROP a);")).toEqual({
      kind: "alterForeignDataWrapper",
      name: "w",
      options: [{ action: "drop", name: "a" }],
    });
    // ADD, SET and DROP name an option when a string follows them.
    expect(firstStmt("ALTER FOREIGN DATA WRAPPER w OPTIONS (set 'x', drop 'y', SET add 'z');").options).toEqual([
      opt("set", "x"),
      opt("drop", "y"),
      { action: "set", name: "add", value: "z" },
    ]);
  });

  it("keeps RENAME TO and OWNER TO on wrappers and servers as alterObject", () => {
    expect(firstStmt("ALTER FOREIGN DATA WRAPPER w RENAME TO x;")).toEqual({
      kind: "alterObject",
      object: { objectType: "foreign data wrapper", name: ["w"] },
      action: { kind: "rename", to: "x" },
    });
    expect(firstStmt("ALTER FOREIGN DATA WRAPPER w OWNER TO CURRENT_USER;")).toEqual({
      kind: "alterObject",
      object: { objectType: "foreign data wrapper", name: ["w"] },
      action: { kind: "ownerTo", owner: "current_user" },
    });
    expect(firstStmt("ALTER SERVER s RENAME TO t;")).toEqual({
      kind: "alterObject",
      object: { objectType: "server", name: ["s"] },
      action: { kind: "rename", to: "t" },
    });
    expect(firstStmt("ALTER SERVER s OWNER TO r;")).toEqual({
      kind: "alterObject",
      object: { objectType: "server", name: ["s"] },
      action: { kind: "ownerTo", owner: "r" },
    });
  });

  it("parses CREATE and ALTER SERVER", () => {
    expect(firstStmt("CREATE SERVER s FOREIGN DATA WRAPPER postgres_fdw;")).toEqual({
      kind: "createServer",
      name: "s",
      wrapper: "postgres_fdw",
    });
    expect(
      firstStmt(
        "CREATE SERVER IF NOT EXISTS s TYPE 'pg' VERSION '17' FOREIGN DATA WRAPPER w OPTIONS (host 'foo', dbname 'films');",
      ),
    ).toEqual({
      kind: "createServer",
      ifNotExists: true,
      name: "s",
      type: "pg",
      version: "17",
      wrapper: "w",
      options: [opt("host", "foo"), opt("dbname", "films")],
    });
    expect(firstStmt("CREATE SERVER s VERSION NULL FOREIGN DATA WRAPPER w;")).toMatchObject({ version: null });
    // A server called `if` is no IF NOT EXISTS.
    expect(firstStmt("CREATE SERVER if FOREIGN DATA WRAPPER w;")).toMatchObject({ name: "if" });
    expect(firstStmt("ALTER SERVER s VERSION '2' OPTIONS (SET host 'x');")).toEqual({
      kind: "alterServer",
      name: "s",
      version: "2",
      options: [{ action: "set", name: "host", value: "x" }],
    });
    expect(firstStmt("ALTER SERVER s VERSION NULL;")).toEqual({
      kind: "alterServer",
      name: "s",
      version: null,
    });
    expect(firstStmt("ALTER SERVER s OPTIONS (port '5432');")).toEqual({
      kind: "alterServer",
      name: "s",
      options: [opt("port", "5432")],
    });
  });

  it("parses CREATE, ALTER and DROP USER MAPPING", () => {
    expect(firstStmt("CREATE USER MAPPING FOR app_user SERVER films OPTIONS (user 'bob', password 'x');")).toEqual({
      kind: "createUserMapping",
      user: "app_user",
      server: "films",
      options: [opt("user", "bob"), opt("password", "x")],
    });
    // PG reads the USER keyword as CURRENT_USER.
    expect(firstStmt("CREATE USER MAPPING IF NOT EXISTS FOR USER SERVER s;")).toEqual({
      kind: "createUserMapping",
      ifNotExists: true,
      user: "current_user",
      server: "s",
    });
    // A quoted "user" is a role of that name.
    expect(firstStmt('CREATE USER MAPPING FOR "user" SERVER s;')).toMatchObject({ user: "user" });
    for (const role of ["current_role", "current_user", "session_user", "public"]) {
      expect(firstStmt(`CREATE USER MAPPING FOR ${role.toUpperCase()} SERVER s;`)).toMatchObject({ user: role });
    }
    expect(firstStmt("ALTER USER MAPPING FOR CURRENT_ROLE SERVER s OPTIONS (DROP password, SET user 'u');")).toEqual({
      kind: "alterUserMapping",
      user: "current_role",
      server: "s",
      options: [
        { action: "drop", name: "password" },
        { action: "set", name: "user", value: "u" },
      ],
    });
    expect(firstStmt("DROP USER MAPPING IF EXISTS FOR u SERVER s;")).toEqual({
      kind: "dropUserMapping",
      ifExists: true,
      user: "u",
      server: "s",
    });
    expect(firstStmt("DROP USER MAPPING FOR USER SERVER s;")).toEqual({
      kind: "dropUserMapping",
      ifExists: false,
      user: "current_user",
      server: "s",
    });
  });

  it("still reads a user called mapping as a user", () => {
    expect(firstStmt("CREATE USER mapping;")).toEqual({
      kind: "createRole",
      user: true,
      name: "mapping",
      options: [],
    });
    expect(firstStmt("CREATE USER mapping WITH LOGIN;")).toMatchObject({
      kind: "createRole",
      name: "mapping",
    });
    expect(firstStmt("ALTER USER mapping WITH LOGIN;")).toMatchObject({
      kind: "alterRole",
      name: "mapping",
    });
    expect(firstStmt("ALTER USER mapping RENAME TO m;")).toMatchObject({
      kind: "alterRole",
      name: "mapping",
    });
    expect(firstStmt("DROP USER mapping, other;")).toMatchObject({
      kind: "drop",
      objectType: "user",
      names: [["mapping"], ["other"]],
    });
    expect(firstStmt("DROP USER IF EXISTS mapping;")).toMatchObject({
      objectType: "user",
      ifExists: true,
    });
  });

  it("parses CREATE FOREIGN TABLE with column and table options", () => {
    expect(
      firstStmt(
        "CREATE FOREIGN TABLE films (code char(5) OPTIONS (column_name 'c') NOT NULL, title varchar(40)) " +
          "SERVER films_srv OPTIONS (schema_name 'public');",
      ),
    ).toEqual({
      kind: "createForeignTable",
      name: ["films"],
      items: [
        {
          kind: "column",
          name: "code",
          dataType: ty("char", [5]),
          options: [opt("column_name", "c")],
          constraints: [{ kind: "notNull" }],
        },
        {
          kind: "column",
          name: "title",
          dataType: ty("varchar", [40]),
          constraints: [],
        },
      ],
      server: "films_srv",
      options: [opt("schema_name", "public")],
    });
    expect(firstStmt("CREATE FOREIGN TABLE IF NOT EXISTS s.f () INHERITS (p, q) SERVER s;")).toEqual({
      kind: "createForeignTable",
      ifNotExists: true,
      name: ["s", "f"],
      items: [],
      inherits: [["p"], ["q"]],
      server: "s",
    });
    expect(firstStmt("CREATE FOREIGN TABLE f (a int, CHECK (a > 0)) SERVER s;").items[1]).toMatchObject({
      kind: "check",
    });
    // PG's columnDef takes OPTIONS on any table.
    expect(firstStmt("CREATE TABLE t (a int OPTIONS (x 'y') DEFAULT 1);").items[0]).toEqual({
      kind: "column",
      name: "a",
      dataType: ty("int"),
      options: [opt("x", "y")],
      constraints: [{ kind: "default", expr: num(1) }],
    });
  });

  it("parses CREATE FOREIGN TABLE … PARTITION OF", () => {
    expect(firstStmt("CREATE FOREIGN TABLE f PARTITION OF p FOR VALUES IN (1) SERVER s;")).toEqual({
      kind: "createForeignTable",
      name: ["f"],
      items: [],
      partitionOf: { parent: ["p"], bound: { kind: "list", values: [num(1)] } },
      server: "s",
    });
    expect(
      firstStmt("CREATE FOREIGN TABLE f PARTITION OF p (a NOT NULL) DEFAULT SERVER s OPTIONS (t 'x');"),
    ).toMatchObject({
      items: [{ kind: "columnOptions", name: "a" }],
      partitionOf: { parent: ["p"], bound: { kind: "default" } },
      options: [opt("t", "x")],
    });
    expect(firstStmt("CREATE FOREIGN TABLE IF NOT EXISTS f PARTITION OF p DEFAULT SERVER s;")).toEqual({
      kind: "createForeignTable",
      ifNotExists: true,
      name: ["f"],
      items: [],
      partitionOf: { parent: ["p"], bound: { kind: "default" } },
      server: "s",
    });
  });

  it("parses ALTER FOREIGN TABLE with ALTER TABLE's actions and OPTIONS", () => {
    expect(
      firstStmt(
        "ALTER FOREIGN TABLE IF EXISTS ONLY f ADD COLUMN c int OPTIONS (n 'v'), ALTER c OPTIONS (ADD x 'y'), OPTIONS (DROP z);",
      ),
    ).toEqual({
      kind: "alterTable",
      foreign: true,
      ifExists: true,
      name: ["f"],
      only: true,
      actions: [
        {
          kind: "addColumn",
          ifNotExists: false,
          column: {
            kind: "column",
            name: "c",
            dataType: ty("int"),
            options: [opt("n", "v")],
            constraints: [],
          },
        },
        {
          kind: "columnGenericOptions",
          column: "c",
          options: [{ action: "add", name: "x", value: "y" }],
        },
        { kind: "genericOptions", options: [{ action: "drop", name: "z" }] },
      ],
    });
    expect(firstStmt("ALTER FOREIGN TABLE f RENAME TO g;")).toEqual({
      kind: "alterTable",
      foreign: true,
      ifExists: false,
      name: ["f"],
      actions: [{ kind: "renameTable", to: "g" }],
    });
    expect(firstStmt("ALTER FOREIGN TABLE f OWNER TO r;").actions).toEqual([{ kind: "ownerTo", owner: "r" }]);
    expect(firstStmt("ALTER FOREIGN TABLE f SET SCHEMA s;").actions).toEqual([{ kind: "setSchema", schema: "s" }]);
    expect(firstStmt("ALTER TABLE t ALTER COLUMN c OPTIONS (SET a 'b');").actions).toEqual([
      { kind: "columnGenericOptions", column: "c", options: [{ action: "set", name: "a", value: "b" }] },
    ]);
    expect(firstStmt("ALTER TABLE t ADD COLUMN a int OPTIONS (x 'y');").actions).toEqual([
      {
        kind: "addColumn",
        ifNotExists: false,
        column: { kind: "column", name: "a", dataType: ty("int"), options: [opt("x", "y")], constraints: [] },
      },
    ]);
    expect(firstStmt("ALTER TABLE t OPTIONS (a 'b');")).toEqual({
      kind: "alterTable",
      ifExists: false,
      name: ["t"],
      actions: [{ kind: "genericOptions", options: [opt("a", "b")] }],
    });
  });

  it("parses IMPORT FOREIGN SCHEMA", () => {
    expect(firstStmt("IMPORT FOREIGN SCHEMA remote FROM SERVER srv INTO local;")).toEqual({
      kind: "importForeignSchema",
      remoteSchema: "remote",
      server: "srv",
      into: "local",
    });
    expect(firstStmt("IMPORT FOREIGN SCHEMA r LIMIT TO (t1, s.t2) FROM SERVER srv INTO l;")).toMatchObject({
      qualification: { kind: "limitTo", tables: [["t1"], ["s", "t2"]] },
    });
    // ONLY and `*` are PG's relation_expr, accepted and ignored.
    expect(firstStmt("IMPORT FOREIGN SCHEMA r LIMIT TO (ONLY a, b *) FROM SERVER srv INTO l;")).toMatchObject({
      qualification: { kind: "limitTo", tables: [["a"], ["b"]] },
    });
    expect(
      firstStmt("IMPORT FOREIGN SCHEMA r EXCEPT (t3) FROM SERVER srv INTO l OPTIONS (import_default 'true');"),
    ).toEqual({
      kind: "importForeignSchema",
      remoteSchema: "r",
      qualification: { kind: "except", tables: [["t3"]] },
      server: "srv",
      into: "l",
      options: [opt("import_default", "true")],
    });
  });

  it("parses DROP FOREIGN TABLE, FOREIGN DATA WRAPPER and SERVER", () => {
    const drop = (objectType: string, names: string[][], ifExists: boolean, behavior: string | null) => ({
      kind: "drop",
      objectType,
      concurrently: false,
      ifExists,
      names,
      behavior,
    });
    expect(firstStmt("DROP FOREIGN TABLE IF EXISTS a, b.c CASCADE;")).toEqual(
      drop("foreign table", [["a"], ["b", "c"]], true, "cascade"),
    );
    expect(firstStmt("DROP FOREIGN DATA WRAPPER w;")).toEqual(drop("foreign data wrapper", [["w"]], false, null));
    expect(firstStmt("DROP SERVER IF EXISTS s, t RESTRICT;")).toEqual(drop("server", [["s"], ["t"]], true, "restrict"));
  });

  it("still comments on servers, wrappers and foreign tables", () => {
    expect(firstStmt("COMMENT ON SERVER s IS 'x';")).toEqual({
      kind: "comment",
      objectType: "server",
      name: ["s"],
      comment: "x",
    });
    expect(firstStmt("COMMENT ON FOREIGN DATA WRAPPER w IS 'x';")).toMatchObject({
      objectType: "foreign data wrapper",
      name: ["w"],
    });
    expect(firstStmt("COMMENT ON FOREIGN TABLE s.t IS NULL;")).toMatchObject({
      objectType: "foreign table",
      name: ["s", "t"],
      comment: null,
    });
  });

  it("rejects malformed foreign-data statements", () => {
    expect(fails("CREATE FOREIGN frob x;")).toThrow(/Expected "data" or "table" but found "frob"/);
    expect(fails("ALTER FOREIGN frob x;")).toThrow(/Expected "data" or "table" but found "frob"/);
    expect(fails("DROP FOREIGN frob x;")).toThrow(/Expected "data" or "table" but found "frob"/);
    expect(fails("CREATE FOREIGN DATA WRAPPER w NO frob;")).toThrow(
      /Expected "handler" or "validator" but found "frob"/,
    );
    expect(fails("CREATE FOREIGN DATA WRAPPER w HANDLER;")).toThrow(/Expected a name but found ";"/);
    expect(fails("ALTER FOREIGN DATA WRAPPER w;")).toThrow(
      /Expected "handler", "validator", "no", "options", "rename" or "owner" but found ";"/,
    );
    expect(fails("ALTER SERVER s;")).toThrow(/Expected "version", "options", "rename" or "owner" but found ";"/);
    expect(fails("CREATE SERVER s FOREIGN DATA WRAPPER w OPTIONS (host 1);")).toThrow(
      /Expected a string but found "1"/,
    );
    expect(fails("CREATE SERVER s FOREIGN DATA WRAPPER w OPTIONS ();")).toThrow(
      /Expected an option name but found "\)"/,
    );
    expect(fails("CREATE SERVER s FOREIGN DATA WRAPPER w OPTIONS (ADD a 'b');")).toThrow(
      /Expected a string but found "a"/,
    );
    expect(fails("CREATE SERVER s VERSION 1 FOREIGN DATA WRAPPER w;")).toThrow(
      /Expected a string or "null" but found "1"/,
    );
    expect(fails("CREATE SERVER s TYPE pg FOREIGN DATA WRAPPER w;")).toThrow(/Expected a string but found "pg"/);
    expect(fails("CREATE SERVER s;")).toThrow(/Expected "foreign data wrapper" but found ";"/);
    expect(fails("ALTER SERVER s OPTIONS (DROP a 'b');")).toThrow(/Expected "\)" but found "b"/);
    expect(fails("CREATE USER MAPPING FOR u;")).toThrow(/Expected "server" but found ";"/);
    expect(fails("ALTER USER MAPPING FOR u SERVER s;")).toThrow(/Expected "options" but found ";"/);
    expect(fails("CREATE FOREIGN TABLE f (a int);")).toThrow(/Expected "server" but found ";"/);
    expect(fails("CREATE FOREIGN TABLE f (a int) SERVER s WITH (fillfactor = 70);")).toThrow(/but found "with"/);
    expect(fails("CREATE FOREIGN TABLE f PARTITION OF p () FOR VALUES IN (1) SERVER s;")).toThrow(/but found "\)"/);
    expect(fails("CREATE FOREIGN TABLE f PARTITION OF p FOR VALUES IN (1) INHERITS (q) SERVER s;")).toThrow(
      /Expected "server" but found "inherits"/,
    );
    expect(fails("ALTER FOREIGN TABLE f RENAME TO g, OWNER TO r;")).toThrow(
      /RENAME cannot be combined with other ALTER FOREIGN TABLE actions/,
    );
    // PG gives the partition commands and RENAME CONSTRAINT to ALTER TABLE alone.
    expect(fails("ALTER FOREIGN TABLE f ATTACH PARTITION p DEFAULT;")).toThrow(/but found "attach"/);
    expect(fails("ALTER FOREIGN TABLE f DETACH PARTITION p;")).toThrow(/but found "detach"/);
    expect(fails("ALTER FOREIGN TABLE f RENAME CONSTRAINT a TO b;")).toThrow(
      /Expected "to", "column" or a name but found "constraint"/,
    );
    expect(firstStmt("ALTER FOREIGN TABLE f RENAME COLUMN a TO b;").actions).toEqual([
      { kind: "renameColumn", from: "a", to: "b" },
    ]);
    expect(fails("CREATE USER mapping IF;")).toThrow(/Expected "not" but found ";"/);
    expect(fails("DROP USER MAPPING IF frob FOR u SERVER s;")).toThrow(/Expected "exists" but found "frob"/);
    expect(fails("ALTER USER MAPPING IF EXISTS FOR u SERVER s OPTIONS (a 'b');")).toThrow(
      /Expected ";" but found "if"/,
    );
    expect(fails("ALTER SERVER s OPTIONS (drop);")).toThrow(/Expected an option name but found "\)"/);
    expect(fails("ALTER SERVER s OPTIONS (ADD a);")).toThrow(/Expected a string but found "\)"/);
    // A column's OPTIONS precedes its constraints, and a PARTITION OF column takes none.
    expect(fails("CREATE FOREIGN TABLE f (a int NOT NULL OPTIONS (x 'y')) SERVER s;")).toThrow(/but found "options"/);
    expect(fails("CREATE FOREIGN TABLE f PARTITION OF p (a OPTIONS (x 'y')) DEFAULT SERVER s;")).toThrow(
      /but found "options"/,
    );
    expect(fails("ALTER TABLE t ALTER c OPTIONS a;")).toThrow(/Expected "\(" but found "a"/);
    expect(fails("IMPORT FOREIGN SCHEMA r LIMIT (t) FROM SERVER s INTO l;")).toThrow(/Expected "to" but found "\("/);
    expect(fails("IMPORT FOREIGN SCHEMA r FROM s INTO l;")).toThrow(/Expected "server" but found "s"/);
    expect(fails("IMPORT FOREIGN SCHEMA r EXCEPT () FROM SERVER s INTO l;")).toThrow(/but found "\)"/);
  });

  it("keeps the foreign-data words unreserved as names and aliases", () => {
    const words = "options wrapper server mapping handler validator import version data".split(" ");
    expect(firstStmt(`SELECT ${words.join(", ")} FROM t;`).columns.map((c: any) => c.expr)).toEqual(
      words.map((word) => name(word)),
    );
    expect(firstStmt("SELECT 1 AS options, 2 server FROM mapping AS wrapper;")).toMatchObject({
      columns: [{ alias: "options" }, { alias: "server" }],
      from: [{ name: ["mapping"], alias: "wrapper" }],
    });
    expect(firstStmt("CREATE TABLE import (options int, server text, handler int, version int);")).toMatchObject({
      name: ["import"],
      items: [{ name: "options" }, { name: "server" }, { name: "handler" }, { name: "version" }],
    });
    // …and as the names of the objects being created.
    expect(
      firstStmt("CREATE FOREIGN DATA WRAPPER wrapper HANDLER handler VALIDATOR validator OPTIONS (options 'o');"),
    ).toMatchObject({
      name: "wrapper",
      functions: [{ name: ["handler"] }, { name: ["validator"] }],
    });
    expect(firstStmt("CREATE SERVER server FOREIGN DATA WRAPPER wrapper;")).toMatchObject({
      name: "server",
      wrapper: "wrapper",
    });
    expect(firstStmt("CREATE USER MAPPING FOR mapping SERVER server;")).toMatchObject({
      user: "mapping",
      server: "server",
    });
    expect(firstStmt("CREATE FOREIGN TABLE options (options int OPTIONS (options 'x')) SERVER server;")).toMatchObject({
      name: ["options"],
      items: [{ name: "options", options: [opt("options", "x")] }],
    });
    expect(firstStmt("IMPORT FOREIGN SCHEMA import FROM SERVER server INTO version;")).toMatchObject({
      remoteSchema: "import",
      into: "version",
    });
    expect(firstStmt("ALTER TABLE t ALTER options TYPE int;").actions[0]).toMatchObject({ column: "options" });
  });
});
