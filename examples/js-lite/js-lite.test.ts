import { describe, expect, it } from "vitest";
import { ParseError, stripSpans } from "../../src/index";
import { type Expr, jsLite, type Stmt } from "./grammar";

const parse = (text: string) => stripSpans(jsLite.parse(text));

type Loose = Record<string, unknown>;
const num = (value: number): Loose => ({ kind: "number", value });
const ident = (name: string): Loose => ({ kind: "ident", name });
const bin = (op: string, left: unknown, right: unknown): Loose => ({ kind: "binary", op, left, right });

const firstExpr = (text: string): Loose => {
  const [stmt] = parse(text);
  return (stmt as Loose & { expression: Loose }).expression;
};

describe("JS-lite statements", () => {
  it("parses const/let declarations, narrowing declKind", () => {
    const [stmt] = parse("const x = 1;");
    expect(stmt).toEqual({
      kind: "var",
      declKind: "const",
      name: "x",
      init: num(1),
    });

    // Literal narrowing from the schema: declKind is "const" | "let".
    const decl = jsLite.parse("let y = 2;")[0] as Extract<Stmt, { kind: "var" }>;
    const declKind: "const" | "let" = decl.declKind;
    expect(declKind).toBe("let");
  });

  it("parses function declarations with a block body", () => {
    const [stmt] = parse("function add(a, b) { return a + b; }");
    expect(stmt).toEqual({
      kind: "function",
      name: "add",
      params: ["a", "b"],
      body: {
        kind: "block",
        body: [{ kind: "return", argument: bin("+", ident("a"), ident("b")) }],
      },
    });
  });

  it("parses if/else with nested statements", () => {
    const [stmt] = parse("if (x > 1) { y = 2; } else y = 3;");
    expect(stmt).toEqual({
      kind: "if",
      test: bin(">", ident("x"), num(1)),
      consequent: {
        kind: "block",
        body: [{ kind: "expr", expression: { kind: "assign", target: ident("y"), value: num(2) } }],
      },
      alternate: { kind: "expr", expression: { kind: "assign", target: ident("y"), value: num(3) } },
    });
  });

  it("parses while loops and bare returns", () => {
    const [stmt] = parse("while (ok) { return; }");
    expect(stmt).toEqual({
      kind: "while",
      test: ident("ok"),
      body: { kind: "block", body: [{ kind: "return", argument: null }] },
    });
  });

  it("parses several statements, skipping comment trivia", () => {
    const program = parse("// setup\nconst x = 1;\n/* then */\nx = x + 1;\n");
    expect(program).toHaveLength(2);
    expect((program[1] as Loose).kind).toBe("expr");
  });
});

describe("JS-lite expressions", () => {
  it("applies operator precedence", () => {
    expect(firstExpr("1 + 2 * 3;")).toEqual(bin("+", num(1), bin("*", num(2), num(3))));
    expect(firstExpr("(1 + 2) * 3;")).toEqual(bin("*", bin("+", num(1), num(2)), num(3)));
  });

  it("parses comparison and logical operators by precedence", () => {
    expect(firstExpr("a < 1 && b >= 2 || c === 3;")).toEqual(
      bin("||", bin("&&", bin("<", ident("a"), num(1)), bin(">=", ident("b"), num(2))), bin("===", ident("c"), num(3))),
    );
  });

  it("makes assignment right-associative", () => {
    expect(firstExpr("a = b = 1;")).toEqual({
      kind: "assign",
      target: ident("a"),
      value: { kind: "assign", target: ident("b"), value: num(1) },
    });
  });

  it("parses the ternary conditional", () => {
    expect(firstExpr("ok ? 1 : 2;")).toEqual({
      kind: "cond",
      test: ident("ok"),
      consequent: num(1),
      alternate: num(2),
    });
  });

  it("binds unary operators tighter than binary ones", () => {
    expect(firstExpr("-a * b;")).toEqual(bin("*", { kind: "unary", op: "-", operand: ident("a") }, ident("b")));
    expect(firstExpr("!a && b;")).toEqual(bin("&&", { kind: "unary", op: "!", operand: ident("a") }, ident("b")));
  });

  it("chains call, member and index postfixes", () => {
    expect(firstExpr("a.b.c(1)[x];")).toEqual({
      kind: "index",
      object: {
        kind: "call",
        callee: { kind: "member", object: { kind: "member", object: ident("a"), property: "b" }, property: "c" },
        args: [num(1)],
      },
      index: ident("x"),
    });
  });

  it("parses literals and arrays", () => {
    expect(firstExpr("[1, 'two', true, null];")).toEqual({
      kind: "array",
      elements: [num(1), { kind: "string", value: "two" }, { kind: "boolean", value: true }, { kind: "null" }],
    });
  });
});

describe("JS-lite arrow functions (attempt backtracking)", () => {
  it("parses a parenthesized-params arrow", () => {
    expect(firstExpr("(a, b) => a + b;")).toEqual({
      kind: "arrow",
      params: ["a", "b"],
      body: bin("+", ident("a"), ident("b")),
    });
  });

  it("backtracks to a parenthesized expression", () => {
    expect(firstExpr("(a + b);")).toEqual(bin("+", ident("a"), ident("b")));
    expect(firstExpr("(a);")).toEqual(ident("a"));
  });

  it("parses a single-identifier arrow, backtracking from a plain identifier", () => {
    expect(firstExpr("x => x * 2;")).toEqual({
      kind: "arrow",
      params: ["x"],
      body: bin("*", ident("x"), num(2)),
    });
    expect(firstExpr("x;")).toEqual(ident("x"));
  });

  it("parses an arrow with a block body", () => {
    expect(firstExpr("(x) => { return x; };")).toEqual({
      kind: "arrow",
      params: ["x"],
      body: { kind: "block", body: [{ kind: "return", argument: ident("x") }] },
    });
  });

  it("parses immediately-invoked and higher-order forms", () => {
    const expr = firstExpr("apply(x => x + 1, [1, 2]);") as Loose & { args: Expr[] };
    expect(expr.kind).toBe("call");
    expect((expr.args[0] as Loose).kind).toBe("arrow");
  });
});

describe("JS-lite spans", () => {
  it("attaches spans to every node", () => {
    const [stmt] = jsLite.parse("const x = 1 + 2;");
    expect(stmt!.span).toEqual({ start: { row: 1, col: 0 }, end: { row: 1, col: 16 } });
    const init = (stmt as Extract<Stmt, { kind: "var" }>).init as Extract<Expr, { kind: "binary" }>;
    expect(init.span.start).toEqual({ row: 1, col: 10 });
    expect(init.left.span).toEqual({ start: { row: 1, col: 10 }, end: { row: 1, col: 11 } });
  });
});

describe("JS-lite errors and recovery", () => {
  it("reports friendly parse errors", () => {
    expect(() => jsLite.parse("const = 1;")).toThrow('Expected an identifier but found "="');
    expect(() => jsLite.parse("1 + ;")).toThrow(ParseError);
    expect(() => jsLite.parse("@")).toThrow('Unexpected character "@"');
  });

  it("labels a non-statement start with the statement description", () => {
    expect(() => jsLite.parse("const x = 1; ]")).toThrow('Expected a statement but found "]"');
  });

  it("diagnose() recovers at the ; sync point and keeps later statements", () => {
    const { ast, errors } = jsLite.diagnose("const x = ;\nconst y = 2;");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(stripSpans(ast)).toContainEqual({
      kind: "var",
      declKind: "const",
      name: "y",
      init: num(2),
    });
  });

  it("diagnose() returns no errors for a valid program", () => {
    const { ast, errors } = jsLite.diagnose("const x = 1;\nwhile (x < 3) { x = x + 1; }");
    expect(errors).toEqual([]);
    expect(ast).toHaveLength(2);
  });
});
