import { stripSpans } from "@parser-kit/core";
import { block, type Doc, group, hardline, indent, join, line, list, render } from "@parser-kit/core/print";
import { describe, expect, it } from "vitest";
import { type Expr, jsLite, type Stmt } from "./grammar";

// A genericity guard for `@parser-kit/core/print`: a small js-lite printer
// written against the public IR only. Parsing what it prints must give back
// the same tree, at every width.

// Binding power of each node as an operand, mirroring the grammar's Pratt table.
const BINARY_BP: Record<string, number> = {
  "||": 4,
  "&&": 5,
  "==": 8,
  "!=": 8,
  "===": 8,
  "!==": 8,
  "<": 9,
  ">": 9,
  "<=": 9,
  ">=": 9,
  "+": 11,
  "-": 11,
  "*": 12,
  "/": 12,
  "%": 12,
};
const POSTFIX = 17;
const ATOM = 20;

const bp = (e: Expr): number => {
  switch (e.kind) {
    case "arrow":
      return 1;
    case "assign":
      return 2;
    case "cond":
      return 3;
    case "binary":
      return BINARY_BP[e.op]!;
    case "unary":
      return 14;
    case "call":
    case "member":
    case "index":
      return POSTFIX;
    default:
      return ATOM;
  }
};

/** Prints `e`, parenthesised if it binds looser than `min`. */
const operand = (e: Expr, min: number): Doc => (bp(e) < min ? ["(", expr(e), ")"] : expr(e));

const str = (s: string): string => (s.includes("'") ? `"${s}"` : `'${s}'`);

const params = (ps: string[]): Doc => (ps.length === 1 ? ps[0]! : list("(", ps, ")"));

const expr = (e: Expr): Doc => {
  switch (e.kind) {
    case "number":
      return String(e.value);
    case "string":
      return str(e.value);
    case "boolean":
      return String(e.value);
    case "null":
      return "null";
    case "ident":
      return e.name;
    case "array":
      return list("[", e.elements.map(expr), "]");
    case "arrow":
      return isExpr(e.body)
        ? group([params(e.params), " =>", indent([line, expr(e.body)])])
        : [params(e.params), " => ", stmt(e.body)];
    case "unary":
      // `- -x` must not print as `--x`.
      return [e.op, e.operand.kind === "unary" ? " " : "", operand(e.operand, 14)];
    case "binary": {
      const p = bp(e);
      return group([operand(e.left, p), " ", e.op, indent([line, operand(e.right, p + 1)])]);
    }
    case "assign":
      return [operand(e.target, 3), " = ", operand(e.value, 2)];
    case "cond":
      return group([operand(e.test, 4), indent([line, "? ", expr(e.consequent), line, ": ", expr(e.alternate)])]);
    case "call":
      return [operand(e.callee, POSTFIX), list("(", e.args.map(expr), ")")];
    case "member":
      return [operand(e.object, POSTFIX), ".", e.property];
    case "index":
      return [operand(e.object, POSTFIX), "[", expr(e.index), "]"];
  }
};

const STMT_KINDS = new Set(["var", "function", "if", "while", "return", "block", "expr"]);
const isExpr = (n: Expr | Stmt): n is Expr => !STMT_KINDS.has(n.kind);

/** A statement body after `if (…)` / `while (…)`: blocks stay on the line, others indent. */
const body = (s: Stmt): Doc => (s.kind === "block" ? [" ", stmt(s)] : group(indent([line, stmt(s)])));

const stmt = (s: Stmt): Doc => {
  switch (s.kind) {
    case "var":
      return group([s.declKind, " ", s.name, " =", indent([line, expr(s.init)]), ";"]);
    case "function":
      return ["function ", s.name, list("(", s.params, ")"), " ", stmt(s.body)];
    case "if":
      return [
        "if (",
        expr(s.test),
        ")",
        body(s.consequent),
        s.alternate ? [s.consequent.kind === "block" ? " " : line, "else", body(s.alternate)] : "",
      ];
    case "while":
      return ["while (", expr(s.test), ")", body(s.body)];
    case "return":
      return ["return", s.argument ? [" ", expr(s.argument)] : "", ";"];
    case "block":
      return block("", s.body.map(stmt));
    case "expr":
      return [expr(s.expression), ";"];
  }
};

const program = (stmts: Stmt[]): Doc => join(hardline, stmts.map(stmt));

const print = (stmts: Stmt[], width: number) => render(program(stmts), { width });

const SOURCES = [
  "const x = 1 + 2 * 3;",
  "let y = (1 + 2) * 3 - 4 - (5 - 6);",
  "a = b = c;",
  "x = !(a && b) || -y;",
  "z = - -1;",
  "r = a ? b : c ? d : e;",
  "r = (a ? b : c) ? d : e;",
  "f(g(1, 2), [3, 4, [5]], 'str', \"it's\");",
  "obj.method(arg)[0].prop = null;",
  "(x => x + 1)(2);",
  "const add = (a, b) => a + b;",
  "const noop = () => { return; };",
  "function fib(n) { if (n <= 1) { return n; } return fib(n - 1) + fib(n - 2); }",
  "function empty() {}",
  "while (i < 10) i = i + 1;",
  "if (a) { b(); } else if (c) d(); else { e(); }",
  "if (veryLongConditionName && anotherQuiteLongCondition) doSomethingWith(argumentOne, argumentTwo);",
  "{ const nested = []; }",
  "const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0) / items.length;",
];

describe("a js-lite printer on the doc IR", () => {
  const widths = [Number.POSITIVE_INFINITY, 80, 40, 20, 1];

  for (const source of SOURCES) {
    it(`round-trips ${source}`, () => {
      const ast = jsLite.parse(source);
      for (const width of widths) {
        const printed = print(ast, width);
        const reparsed = jsLite.parse(printed);
        expect(stripSpans(reparsed), `width ${width}:\n${printed}`).toEqual(stripSpans(ast));
        // Idempotent: printing the re-parsed tree gives the same text.
        expect(print(reparsed, width)).toBe(printed);
      }
    });
  }

  it("prints canonical output at width Infinity: groups flat, blocks and statements on their own lines", () => {
    const ast = jsLite.parse("const   add=(a,b)=>a+b ;\nif(x){y(  1 );}else z = [ 1,2 ];");
    expect(print(ast, Number.POSITIVE_INFINITY)).toBe(
      "const add = (a, b) => a + b;\nif (x) {\n  y(1);\n} else z = [1, 2];",
    );
  });

  it("breaks groups from the outside in at a narrow width", () => {
    const ast = jsLite.parse(
      "const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0) / items.length;",
    );
    expect(print(ast, 40)).toBe(
      [
        "const total =",
        "  items.reduce(",
        "    (sum, item) =>",
        "      sum + item.price * item.quantity,",
        "    0",
        "  ) /",
        "    items.length;",
      ].join("\n"),
    );
  });

  it("indents nested blocks", () => {
    const ast = jsLite.parse("function f(n) { while (n > 0) { n = n - 1; } return n; }");
    expect(print(ast, 80)).toBe(
      ["function f(n) {", "  while (n > 0) {", "    n = n - 1;", "  }", "  return n;", "}"].join("\n"),
    );
  });
});
