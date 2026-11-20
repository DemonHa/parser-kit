import { describe, expect, it } from "vitest";
import {
  bindTokens,
  defineGrammar,
  defineLexer,
  field,
  lazy,
  oneOf,
  type PrattDef,
  pratt,
  type Rule,
  seq,
  skip,
  stripSpans,
} from "../index";
import { type Doc, definePrinter, group, indent, line, precedence, render } from "./index";

// A grammar on core's default Pratt nodes (`type: "unary" | "binary"`), with
// one group of every shape `precedence` reads: right-, left- and
// non-associative ops, a tight and a loose prefix sharing nothing with an infix
// op but `-`, a closed and an open postfix, a custom-parse infix with a middle
// operand (a ternary) and one with two bounded operands (a BETWEEN).
type Node =
  | { type: "name"; value: string }
  | { type: "unary"; op: string; operand: Node }
  | { type: "binary"; op: string; left: Node; right: Node }
  | { type: "fact"; operand: Node }
  | { type: "at"; expr: Node; zone: Node }
  | { type: "cond"; test: Node; yes: Node; no: Node }
  | { type: "between"; expr: Node; lo: Node; hi: Node };

type TT = "punc" | "ident";
const lexer = defineLexer({
  punctuation: {
    type: "punc",
    tokens: ["(", ")", "=", "<", "+", "-", "*", "^", "!", "@", "?", ":", "~", "&"],
  },
  identifier: { type: "ident", start: /[a-z]/, part: /[a-z]/ },
  whitespace: /[ \t\r\n]/,
});
const { token } = bindTokens<TT>();
const punc = (v: string) => token("punc", { values: [v] });

const table: Omit<PrattDef<Node, TT>, "atom"> = {
  prefix: [
    { ops: ["-"], bp: 12, type: "punc" },
    { ops: ["not"], bp: 4, type: "ident" },
  ],
  infix: [
    {
      ops: ["?"],
      bp: 1,
      type: "punc",
      nodes: ["cond"],
      rhs: 0,
      parse: (ctx, test, h): Node => {
        ctx.next();
        const yes = h.parseRhs(0);
        ctx.parse(punc(":"));
        return { type: "cond", test, yes, no: h.parseRhs(0) };
      },
    },
    { ops: ["="], bp: 2, assoc: "right", type: "punc" },
    { ops: ["<"], bp: 5, assoc: "nonassoc", type: "punc" },
    {
      match: punc("~"),
      bp: 6,
      nodes: ["between"],
      rhs: 7,
      parse: (ctx, expr, h): Node => {
        ctx.next();
        const lo = h.parseRhs(7);
        ctx.parse(punc("&"));
        return { type: "between", expr, lo, hi: h.parseRhs(7) };
      },
    },
    { ops: ["+", "-"], bp: 10, type: "punc" },
    { ops: ["*"], bp: 11, type: "punc" },
    { ops: ["^"], bp: 13, assoc: "right", type: "punc" },
  ],
  postfix: [
    {
      match: punc("@"),
      bp: 14,
      nodes: ["at"],
      rhs: 15,
      parse: (ctx, expr, h): Node => {
        ctx.next();
        return { type: "at", expr, zone: h.parseRhs(15) };
      },
    },
    {
      match: punc("!"),
      bp: 15,
      nodes: ["fact"],
      rhs: "none",
      parse: (ctx, operand): Node => {
        ctx.next();
        return { type: "fact", operand };
      },
    },
  ],
};

const name = token("ident").map((t): Node => ({ type: "name", value: t.value }));
const expr: Rule<Node, TT> = lazy(() => full);
const atom = oneOf(
  name,
  seq(skip(punc("(")), field("e", expr), skip(punc(")"))).map((s) => s.e),
);
const full: Rule<Node, TT> = pratt<Node, TT>({ atom, ...table });
const grammar = defineGrammar({ lexer, root: full });
const parse = (s: string) => stripSpans(grammar.parse(s)) as Node;

const key = (n: Node) =>
  n.type === "binary" ? n.op : n.type === "unary" ? { prefix: n.op } : n.type === "name" ? null : n.type;
// The return type breaks the cycle between `prec` and `print` for inference.
const prec = precedence<Node>(table, { key, print: (n): Doc => print(n) });

const print = definePrinter<Node>()("type", {
  name: (n) => n.value,
  unary: (n) => [n.op, n.op === "not" ? " " : "", prec.child(n, n.operand, "right")],
  binary: (n) => group([prec.child(n, n.left, "left"), " ", n.op, indent([line, prec.child(n, n.right, "right")])]),
  fact: (n) => [prec.child(n, n.operand, "left"), "!"],
  at: (n) => [prec.child(n, n.expr, "left"), " @ ", prec.child(n, n.zone, "right")],
  cond: (n, p) => [prec.child(n, n.test, "left"), " ? ", p(n.yes), " : ", prec.child(n, n.no, "right")],
  between: (n) => [
    prec.child(n, n.expr, "left"),
    " ~ ",
    prec.child(n, n.lo, "right"),
    " & ",
    prec.child(n, n.hi, "right"),
  ],
});

const text = (n: Node, width = Number.POSITIVE_INFINITY) => render(prec.operand(n), { width });
const roundTrip = (source: string) => text(parse(source));

// Every tree up to `depth`, over one leaf and every node shape.
const trees = (depth: number): Node[] => {
  const a: Node = { type: "name", value: "a" };
  if (depth === 0) return [a];
  const sub = trees(depth - 1);
  const out: Node[] = [a];
  for (const x of sub) {
    out.push({ type: "unary", op: "-", operand: x }, { type: "unary", op: "not", operand: x });
    out.push({ type: "fact", operand: x });
    for (const y of sub) {
      out.push({ type: "at", expr: x, zone: y });
      for (const op of ["=", "<", "+", "-", "*", "^"]) out.push({ type: "binary", op, left: x, right: y });
      for (const z of sub) {
        out.push({ type: "cond", test: x, yes: y, no: z }, { type: "between", expr: x, lo: y, hi: z });
      }
    }
  }
  return out;
};

describe("precedence", () => {
  it("round-trips random deeper trees", () => {
    // A fixed-seed LCG, so a failure reproduces.
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const gen = (depth: number): Node => {
      const pick = depth === 0 ? 0 : rand(8);
      const sub = () => gen(depth - 1);
      switch (pick) {
        case 0:
          return { type: "name", value: "a" };
        case 1:
          return { type: "unary", op: rand(2) ? "-" : "not", operand: sub() };
        case 2:
          return { type: "fact", operand: sub() };
        case 3:
          return { type: "at", expr: sub(), zone: sub() };
        case 4:
          return { type: "cond", test: sub(), yes: sub(), no: sub() };
        case 5:
          return { type: "between", expr: sub(), lo: sub(), hi: sub() };
        default:
          return { type: "binary", op: ["=", "<", "+", "-", "*", "^"][rand(6)]!, left: sub(), right: sub() };
      }
    };
    for (let i = 0; i < 2000; i++) {
      const tree = gen(5);
      const printed = text(tree, 20);
      expect(parse(printed), printed).toEqual(tree);
    }
  });

  it("round-trips every tree up to depth 2 through print and parse", () => {
    const all = trees(2);
    expect(all.length).toBeGreaterThan(5000);
    for (const tree of all) {
      for (const width of [Number.POSITIVE_INFINITY, 1]) {
        const printed = text(tree, width);
        expect(parse(printed), printed).toEqual(tree);
      }
    }
  });

  it("drops parentheses binding powers make redundant", () => {
    expect(roundTrip("((a + a)) * (a) - (a * a) - (a - a)")).toBe("(a + a) * a - a * a - (a - a)");
    expect(roundTrip("(a ^ a) ^ (a ^ a)")).toBe("(a ^ a) ^ a ^ a");
    expect(roundTrip("a = (a = a)")).toBe("a = a = a");
    expect(roundTrip("(-a) ^ a + -(a ^ a)")).toBe("(-a) ^ a + -a ^ a");
    expect(roundTrip("(a!)! + (-a)!")).toBe("a!! + (-a)!");
  });

  it("keeps non-associative chains parenthesised", () => {
    expect(roundTrip("(a < a) < a")).toBe("(a < a) < a");
    expect(roundTrip("a < (a < a)")).toBe("a < (a < a)");
  });

  it("parenthesises a custom-parse group's own chain, whose associativity it can't see", () => {
    expect(roundTrip("(a ~ a & a) ~ a & a")).toBe("(a ~ a & a) ~ a & a");
    expect(roundTrip("a ~ (a + a) & a * a")).toBe("a ~ a + a & a * a");
    expect(roundTrip("a ~ (a < a) & a")).toBe("a ~ (a < a) & a");
  });

  it("wraps a child whose open tail would swallow what follows it", () => {
    expect(roundTrip("(a ? a : a) + a")).toBe("(a ? a : a) + a");
    expect(roundTrip("a ? a = a : a ? a : a")).toBe("a ? a = a : a ? a : a");
    expect(roundTrip("(a @ a) + a")).toBe("a @ a + a");
    expect(roundTrip("a @ (a + a)")).toBe("a @ (a + a)");
    expect(roundTrip("(a @ a)!")).toBe("(a @ a)!");
    expect(roundTrip("(not a) = a")).toBe("not a = a");
    expect(roundTrip("a * (not a)")).toBe("a * (not a)");
  });

  it("throws on a key the table doesn't name, rather than guessing", () => {
    const loose = precedence<Node>(table, { key: (n) => (n.type === "binary" ? n.op : null), print });
    const odd: Node = { type: "binary", op: "%", left: parse("a"), right: parse("a") };
    expect(() => loose.parens(parse("a + a"), odd, "left")).toThrow('no group builds "%"');
    expect(() => prec.operand({ type: "unary", op: "~", operand: parse("a") })).toThrow(
      'no group builds {"prefix":"~"}',
    );
  });

  it("checks an operand position by its bp, for operands parsed outside the table", () => {
    const sum = parse("a + a");
    expect(render(prec.operand(sum, 10), {})).toBe("a + a");
    expect(render(prec.operand(sum, 11), {})).toBe("(a + a)");
    expect(render(prec.operand(parse("a ? a : a"), 2), {})).toBe("(a ? a : a)");
  });

  it("parenthesises nodes a context's restricted table can't build", () => {
    const restricted: typeof table = { prefix: [table.prefix![0]!], infix: table.infix!.slice(4), postfix: [] };
    const b = precedence<Node, "b">(table, { key, print, contexts: { b: restricted } });
    expect(render(b.operand(parse("a + a * a"), 0, "b"), {})).toBe("a + a * a");
    expect(render(b.operand(parse("a < a"), 0, "b"), {})).toBe("(a < a)");
    expect(render(b.operand(parse("not a"), 0, "b"), {})).toBe("(not a)");
    expect(render(b.operand(parse("a!"), 0, "b"), {})).toBe("(a!)");
    const sum = parse("a + (a < a)") as Extract<Node, { type: "binary" }>;
    expect(render(b.child(sum, sum.right, "right", "b"), {})).toBe("(a < a)");
    expect(render(b.child(sum, sum.left, "left", "b"), {})).toBe("a");
  });

  it("applies a context all the way down, until parentheses restore the full table", () => {
    // Only `<` in the restricted table: `+` binds tighter in the main one, but
    // can't appear in the context at all, even as a grandchild.
    const lt: typeof table = { infix: [table.infix![2]!] };
    const b = precedence<Node, "b">(table, { key, print: (n): Doc => bp(n), contexts: { b: lt } });
    const bp: (n: Node) => Doc = definePrinter<Node>()("type", {
      ...print.handlers,
      binary: (n) => [b.child(n, n.left, "left"), " ", n.op, " ", b.child(n, n.right, "right")],
      unary: (n) => [n.op, n.op === "not" ? " " : "", b.child(n, n.operand, "right")],
    });
    expect(render(b.operand(parse("a < a + a"), 0, "b"), {})).toBe("a < (a + a)");
    // Inside the parentheses the main table applies again.
    expect(render(b.operand(parse("a + a < a * a"), 0, "b"), {})).toBe("(a + a) < (a * a)");
    expect(render(b.operand(parse("a + a * a"), 0, "b"), {})).toBe("(a + a * a)");
    expect(render(b.operand(parse("a < a + a"), 0), {})).toBe("a < a + a");
  });

  it("gives each node of a group its own tail", () => {
    // `like` reads its pattern at bp 3, so it would swallow a following
    // `and`; `in` ends in its own `)`.
    type E = { k: "x" } | { k: "like"; l: E; r: E } | { k: "in"; l: E } | { k: "and"; l: E; r: E };
    const t = {
      infix: [
        { ops: ["and"], bp: 4, nodes: ["and"] },
        { ops: ["like"], bp: 6, parse: () => null, nodes: { like: 3, in: "none" as const } },
      ],
    };
    const p = precedence<E>(t, { key: (n) => (n.k === "x" ? null : n.k), print: () => "" });
    const x: E = { k: "x" };
    const and: E = { k: "and", l: x, r: x };
    expect(p.parens(and, { k: "like", l: x, r: x }, "left")).toBe(true);
    expect(p.parens(and, { k: "in", l: x }, "left")).toBe(false);
  });

  it("wraps before a postfix whose token an infix group also takes", () => {
    // Where the postfix's bp is too low, pratt offers its token to infix
    // lookup: in `a + b!` the `!` is the bp-20 infix inside `+`'s operand.
    type E = { k: "x" } | { k: "add"; l: E; r: E } | { k: "fact"; e: E };
    const t = {
      infix: [
        { ops: ["+"], bp: 10, nodes: ["add"] },
        { ops: ["!"], bp: 20 },
      ],
      postfix: [{ match: { first: () => [{ value: "!" }] }, bp: 5, nodes: ["fact"], rhs: "none" as const }],
    };
    const p = precedence<E>(t, { key: (n) => (n.k === "x" ? null : n.k), print: () => "" });
    const x: E = { k: "x" };
    const add: E = { k: "add", l: x, r: x };
    expect(p.parens({ k: "fact", e: add }, add, "left")).toBe(true);
    expect(p.parens({ k: "fact", e: x }, x, "left")).toBe(false);
  });

  it("takes a custom wrapper and open atoms", () => {
    type E = { k: "lam"; body: E } | { k: "x" } | { k: "add"; l: E; r: E };
    const t = { infix: [{ ops: ["+"], bp: 10, nodes: ["add"] }] };
    const p = precedence<E>(t, {
      key: (n) => (n.k === "x" ? null : n.k),
      print: (n): Doc => (n.k === "x" ? "x" : n.k),
      wrap: (d) => ["[", d, "]"],
      atoms: { lam: 0 },
    });
    const lam: E = { k: "lam", body: { k: "x" } };
    const add: E = { k: "add", l: lam, r: lam };
    expect(render(p.child(add, lam, "left"), {})).toBe("[lam]");
    expect(render(p.child(add, lam, "right"), {})).toBe("[lam]");
    expect(render(p.child(add, { k: "x" }, "right"), {})).toBe("x");
  });

  it("rejects a key two groups build with different binding powers", () => {
    expect(() =>
      precedence<Node>(
        {
          infix: [
            { ops: ["+"], bp: 1 },
            { ops: ["+"], bp: 2 },
          ],
        },
        { key: () => "+", print },
      ),
    ).toThrow(/two groups build "\+"/);
    expect(() =>
      precedence<Node>(
        {
          infix: [
            { ops: ["+"], bp: 1 },
            { ops: ["+"], bp: 1 },
          ],
        },
        { key: () => "+", print },
      ),
    ).not.toThrow();
    // Same bp, different associativity.
    expect(() =>
      precedence<Node>(
        {
          infix: [
            { ops: ["+"], bp: 1 },
            { ops: ["+"], bp: 1, assoc: "nonassoc" },
          ],
        },
        { key: () => "+", print },
      ),
    ).toThrow(/two groups build "\+"/);
  });
});
