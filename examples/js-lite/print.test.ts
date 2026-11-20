import { stripSpans } from "@parser-kit/core";
import {
  block,
  type Doc,
  definePrinter,
  group,
  hardline,
  indent,
  join,
  line,
  list,
  type NodePrinter,
  precedence,
  render,
} from "@parser-kit/core/print";
import { describe, expect, it } from "vitest";
import { type Expr, expressionTable, jsLite, type Stmt } from "./grammar";

// A genericity guard for `@parser-kit/core/print`: a small js-lite printer
// written against the public API only. Parsing what it prints must give back
// the same tree, at every width.

// Parentheses come from the grammar's own Pratt table. Binary nodes are keyed
// by their operator; every other operator node by the kind its group names in
// `nodes`; atoms by null. An arrow function is an atom whose body runs to the
// end of the expression, so it is declared with the bp that body is parsed at.
const prec = precedence<Expr>(expressionTable, {
  key: (e) => {
    switch (e.kind) {
      case "binary":
        return e.op;
      case "number":
      case "string":
      case "boolean":
      case "null":
      case "ident":
      case "array":
        return null;
      default:
        return e.kind;
    }
  },
  print: (e): Doc => expr(e),
  atoms: { arrow: 0 },
});

// Enough for the corpus below, which has no string holding both quote kinds or a backslash.
const str = (s: string): string => (s.includes("'") ? `"${s}"` : `'${s}'`);

const params = (ps: string[]): Doc => (ps.length === 1 ? ps[0]! : list("(", ps, ")"));

// Expressions and statements are separate unions, so each gets its own printer;
// they call each other for arrow bodies and expression statements. Mutually
// recursive printers need one type annotation, like recursive rules.
const expr: NodePrinter<Expr, "kind"> = definePrinter<Expr>()("kind", {
  number: (e) => String(e.value),
  string: (e) => str(e.value),
  boolean: (e) => String(e.value),
  null: () => "null",
  ident: (e) => e.name,
  array: (e, print) => list("[", e.elements.map(print), "]"),
  arrow: (e, print) =>
    isExpr(e.body)
      ? group([params(e.params), " =>", indent([line, print(e.body)])])
      : [params(e.params), " => ", stmt(e.body)],
  // `- -x` must not print as `--x`.
  unary: (e) => [e.op, e.operand.kind === "unary" ? " " : "", prec.child(e, e.operand, "right")],
  binary: (e) => group([prec.child(e, e.left, "left"), " ", e.op, indent([line, prec.child(e, e.right, "right")])]),
  assign: (e) => [prec.child(e, e.target, "left"), " = ", prec.child(e, e.value, "right")],
  cond: (e, print) =>
    group([
      prec.child(e, e.test, "left"),
      indent([line, "? ", print(e.consequent), line, ": ", prec.child(e, e.alternate, "right")]),
    ]),
  call: (e, print) => [prec.child(e, e.callee, "left"), list("(", e.args.map(print), ")")],
  member: (e) => [prec.child(e, e.object, "left"), ".", e.property],
  index: (e, print) => [prec.child(e, e.object, "left"), "[", print(e.index), "]"],
});

const STMT_KINDS = new Set(["var", "function", "if", "while", "return", "block", "expr"]);
const isExpr = (n: Expr | Stmt): n is Expr => !STMT_KINDS.has(n.kind);

/** A statement body after `if (…)` / `while (…)`: blocks stay on the line, others indent. */
const body = (s: Stmt): Doc => (s.kind === "block" ? [" ", stmt(s)] : group(indent([line, stmt(s)])));

const stmt: NodePrinter<Stmt, "kind"> = definePrinter<Stmt>()("kind", {
  var: (s) => group([s.declKind, " ", s.name, " =", indent([line, expr(s.init)]), ";"]),
  function: (s, print) => ["function ", s.name, list("(", s.params, ")"), " ", print(s.body)],
  if: (s) => [
    "if (",
    expr(s.test),
    ")",
    body(s.consequent),
    s.alternate ? [s.consequent.kind === "block" ? " " : line, "else", body(s.alternate)] : "",
  ],
  while: (s) => ["while (", expr(s.test), ")", body(s.body)],
  return: (s) => ["return", s.argument ? [" ", expr(s.argument)] : "", ";"],
  block: (s, print) => block("", s.body.map(print)),
  expr: (s) => [expr(s.expression), ";"],
});

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
  "x = a - (b - c) - d * (e + f) % g;",
  "x = !(!a) || -(-b) || !-c;",
  "r = (a = b) ? c = d : e = f;",
  "r = a ? b : x => x ? y : z;",
  "r = (a ? b : c).d + (x => x)(1) + (y => y);",
  "f(a = b, (c, d) => c || d)[e ? f : g];",
  "x = (a ? b : c) || (d = e);",
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

  it("prints only the parentheses the grammar's binding powers need", () => {
    const ast = jsLite.parse("x = ((a + b)) * (c) - (d * e) - (f - g); y = (h = i); z = (a ? b : c);");
    expect(print(ast, Number.POSITIVE_INFINITY)).toBe("x = (a + b) * c - d * e - (f - g);\ny = h = i;\nz = a ? b : c;");
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
