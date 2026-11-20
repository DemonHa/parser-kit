import { describe, expect, expectTypeOf, it } from "vitest";
import type { Span } from "../position";
import { type Doc, definePrinter, extendPrinter, type NodePrinter, type Printable, render } from "./index";

// Two unions that share a discriminant value, as SQL's expression and FROM item
// both have `kind: "subquery"`.
interface Query {
  kind: "query";
  from: From[];
  where: Expr | null;
  span: Span;
}
type Expr =
  | { kind: "col"; name: string; span: Span }
  | { kind: "num"; value: number; span: Span }
  | { kind: "add"; left: Expr; right: Expr; span: Span }
  | { kind: "subquery"; query: Query; span: Span };
type From = { kind: "table"; name: string; span: Span } | { kind: "subquery"; query: Query; alias: string; span: Span };

const span: Span = { start: { row: 1, col: 1 }, end: { row: 1, col: 1 } };
const str = (d: Doc) => render(d);

const printQuery = (q: Printable<Query>): Doc => [
  "SELECT * FROM ",
  q.from.map(printFrom).flatMap((d, i) => (i === 0 ? [d] : [", ", d])),
  q.where ? [" WHERE ", printExpr(q.where)] : "",
];
const printExpr = definePrinter<Printable<Expr>>()("kind", {
  col: (n) => n.name,
  num: (n) => String(n.value),
  add: (n, print) => [print(n.left), " + ", print(n.right)],
  subquery: (n) => ["(", printQuery(n.query), ")"],
});
const printFrom = definePrinter<Printable<From>>()("kind", {
  table: (n) => n.name,
  subquery: (n) => ["(", printQuery(n.query), ") AS ", n.alias],
});

describe("definePrinter", () => {
  it("dispatches on the discriminant, with the same kind handled per union", () => {
    const inner: Query = { kind: "query", from: [{ kind: "table", name: "t", span }], where: null, span };
    const q: Query = {
      kind: "query",
      from: [{ kind: "subquery", query: inner, alias: "s", span }],
      where: {
        kind: "add",
        left: { kind: "col", name: "a", span },
        right: { kind: "subquery", query: inner, span },
        span,
      },
      span,
    };
    expect(str(printQuery(q))).toBe("SELECT * FROM (SELECT * FROM t) AS s WHERE a + (SELECT * FROM t)");
  });

  it("accepts hand-built nodes without spans through Printable", () => {
    const hand: Printable<Expr> = { kind: "add", left: { kind: "num", value: 1 }, right: { kind: "col", name: "x" } };
    expect(str(printExpr(hand))).toBe("1 + x");
    // Parsed nodes still fit.
    expectTypeOf<Expr>().toMatchTypeOf<Printable<Expr>>();
  });

  it("works with any discriminant key", () => {
    type Node = { type: "a" } | { type: "b"; n: number };
    const p = definePrinter<Node>()("type", { a: () => "A", b: (n) => `B${n.n}` });
    expect(str([p({ type: "a" }), p({ type: "b", n: 2 })])).toBe("AB2");
    expect(p.key).toBe("type");
  });

  it("throws on a node whose kind it has no handler for", () => {
    const bad = { kind: "nope" } as unknown as Printable<Expr>;
    expect(() => printExpr(bad)).toThrow('No printer for kind "nope"');
  });

  it("requires a handler for every variant and narrows each node", () => {
    type Node = { kind: "a"; x: string } | { kind: "b"; y: number };
    // @ts-expect-error — `b` is missing.
    definePrinter<Node>()("kind", { a: (n) => n.x });
    definePrinter<Node>()("kind", {
      a: (n) => n.x,
      // @ts-expect-error — `n` is the `b` variant, which has no `x`.
      b: (n) => n.x,
    });
    definePrinter<Node>()("kind", {
      a: (n) => n.x,
      b: (n) => String(n.y),
      // @ts-expect-error — no such variant.
      c: () => "",
    });
    // @ts-expect-error — not a key of the union.
    definePrinter<Node>()("tag", {});
    expectTypeOf(definePrinter<Node>()("kind", { a: (n) => n.x, b: (n) => String(n.y) })).toEqualTypeOf<
      NodePrinter<Node, "kind">
    >();
  });
});

describe("extendPrinter", () => {
  type Node = { kind: "lit"; v: string } | { kind: "neg"; operand: Node } | { kind: "pair"; a: Node; b: Node };
  const base = definePrinter<Node>()("kind", {
    lit: (n) => n.v,
    neg: (n, print) => ["-", print(n.operand)],
    pair: (n, print) => ["(", print(n.a), ", ", print(n.b), ")"],
  });

  it("replaces some handlers and keeps the rest, all the way down", () => {
    const dialect = extendPrinter(base, { lit: (n) => `'${n.v}'` });
    const tree: Node = {
      kind: "pair",
      a: { kind: "lit", v: "x" },
      b: { kind: "neg", operand: { kind: "lit", v: "y" } },
    };
    expect(str(base(tree))).toBe("(x, -y)");
    // `pair` and `neg` come from the base, and recurse through the dialect.
    expect(str(dialect(tree))).toBe("('x', -'y')");
  });

  it("leaves the base untouched and exposes its handlers for spreading", () => {
    const dialect = extendPrinter(base, { neg: (n, print) => ["NOT ", print(n.operand)] });
    expect(dialect.handlers.lit).toBe(base.handlers.lit);
    expect(str(base({ kind: "neg", operand: { kind: "lit", v: "a" } }))).toBe("-a");
    // @ts-expect-error — overrides must be handlers of the same union.
    extendPrinter(base, { other: () => "" });
  });
});
