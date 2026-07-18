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
  orderBy: null,
  limit: null,
  offset: null,
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
