import { beforeEach, describe, expect, it } from "vitest";
import { bindTokens, field, lazy, oneOf, optional, seq, skip } from "./combinators";
import { defineGrammar } from "./grammar";
import { defineLexer, readers } from "./lexer";
import { type PrattDef, type PrattInfix, pratt } from "./pratt";
import type { Rule } from "./rule";
import { stripSpans } from "./strip-spans";

const mathLexer = defineLexer({
  punctuation: { type: "punc", tokens: ["(", ")", "+", "-", "*", "^", "!"], display: "a symbol" },
  readers: [readers.number("num", { display: "a number" })],
});

type MathTT = "punc" | "num";

type Expr =
  | { kind: "num"; value: number }
  | { kind: "unary"; op: string; operand: Expr }
  | { kind: "binary"; op: string; left: Expr; right: Expr }
  | { kind: "factorial"; operand: Expr };

const { token } = bindTokens<MathTT>();
const punc = (value: string) => token("punc", { values: [value] });

const numberLit = token("num").map((node): Expr => ({ kind: "num", value: Number(node.value) }));
const parenExpr = seq(
  skip(punc("(")),
  field(
    "e",
    lazy<Expr, MathTT>(() => expression),
  ),
  skip(punc(")")),
).map((s) => s.e);

const mathInfix: PrattInfix<Expr, MathTT>[] = [
  { ops: ["+", "-"], bp: 11, type: "punc", map: (op, left, right): Expr => ({ kind: "binary", op, left, right }) },
  { ops: ["*"], bp: 12, type: "punc", map: (op, left, right): Expr => ({ kind: "binary", op, left, right }) },
  {
    ops: ["^"],
    bp: 13,
    assoc: "right",
    type: "punc",
    map: (op, left, right): Expr => ({ kind: "binary", op, left, right }),
  },
];
const mathPostfix: NonNullable<PrattDef<Expr, MathTT>["postfix"]> = [
  {
    match: punc("!"),
    bp: 17,
    parse: (ctx, left): Expr => {
      ctx.next();
      return { kind: "factorial", operand: left };
    },
  },
];
const mathAtom = oneOf(numberLit, parenExpr);
const mathPrefix: PrattDef<Expr, MathTT>["prefix"] = [
  { ops: ["-"], bp: 14, type: "punc", map: (op, operand): Expr => ({ kind: "unary", op, operand }) },
];

// Recursive rules carry the one explicit annotation type inference can't do.
const expression: Rule<Expr, MathTT> = pratt<Expr, MathTT>({
  atom: mathAtom,
  prefix: mathPrefix,
  infix: mathInfix,
  postfix: mathPostfix,
});

const grammar = defineGrammar({ lexer: mathLexer, root: expression });
const parse = (text: string) => stripSpans(grammar.parse(text));

const num = (value: number): Expr => ({ kind: "num", value });
const bin = (op: string, left: Expr, right: Expr): Expr => ({ kind: "binary", op, left, right });

describe("pratt()", () => {
  it("applies precedence", () => {
    expect(parse("1 + 2 * 3")).toEqual(bin("+", num(1), bin("*", num(2), num(3))));
  });

  it("respects parentheses", () => {
    expect(parse("(1 + 2) * 3")).toEqual(bin("*", bin("+", num(1), num(2)), num(3)));
  });

  it("associates left by default", () => {
    expect(parse("1 - 2 - 3")).toEqual(bin("-", bin("-", num(1), num(2)), num(3)));
  });

  it("supports right associativity", () => {
    expect(parse("2 ^ 3 ^ 4")).toEqual(bin("^", num(2), bin("^", num(3), num(4))));
  });

  it("binds prefix operators tighter than infix", () => {
    expect(parse("-2 + 3")).toEqual(bin("+", { kind: "unary", op: "-", operand: num(2) }, num(3)));
  });

  it("applies postfix operators tightest", () => {
    expect(parse("-2!")).toEqual({ kind: "unary", op: "-", operand: { kind: "factorial", operand: num(2) } });
  });

  it("reports the atom's expectation on failure", () => {
    expect(() => parse("+")).toThrow('Expected a number or "(" but found "+"');
  });
});

// SQL-ish table: keyword operators via lexer folding, multi-word operators via
// match groups, custom tails re-entering precedence climbing with parseRhs,
// and nonassoc comparisons.
const sqlLexer = defineLexer({
  punctuation: { type: "punc", tokens: ["(", ")", "<", ">", "<=", ">="], display: "a symbol" },
  identifier: { type: "ident", start: /[A-Za-z_]/, part: /[A-Za-z0-9_]/, display: "an identifier", fold: "lower" },
  readers: [readers.number("num", { display: "a number" })],
});

type SqlTT = "punc" | "ident" | "num";

type SqlExpr =
  | { kind: "num"; value: number }
  | { kind: "ident"; name: string }
  | { kind: "binary"; op: string; left: SqlExpr; right: SqlExpr }
  | { kind: "like"; negated: boolean; left: SqlExpr; right: SqlExpr }
  | { kind: "between"; subject: SqlExpr; lo: SqlExpr; hi: SqlExpr };

const { token: sqlToken, word, phrase } = bindTokens<SqlTT>();
const sqlPunc = (value: string) => sqlToken("punc", { values: [value] });

const sqlNum = sqlToken("num").map((node): SqlExpr => ({ kind: "num", value: Number(node.value) }));
const sqlIdent = sqlToken("ident").map((node): SqlExpr => ({ kind: "ident", name: node.value }));
const sqlParen = seq(
  skip(sqlPunc("(")),
  field(
    "e",
    lazy<SqlExpr, SqlTT>(() => sqlExpression),
  ),
  skip(sqlPunc(")")),
).map((s) => s.e);

const sqlBin = (op: string, left: SqlExpr, right: SqlExpr): SqlExpr => ({ kind: "binary", op, left, right });

const sqlInfix: PrattInfix<SqlExpr, SqlTT>[] = [
  { ops: ["or"], bp: 4, type: "ident", map: sqlBin },
  { ops: ["and"], bp: 5, type: "ident", map: sqlBin },
  {
    match: phrase("ident", "not", "like"),
    bp: 7,
    parse: (ctx, left, h): SqlExpr => {
      ctx.parse(phrase("ident", "not", "like"));
      return { kind: "like", negated: true, left, right: h.parseRhs(8) };
    },
  },
  {
    match: word("ident", "like"),
    bp: 7,
    parse: (ctx, left, h): SqlExpr => {
      ctx.next(); // "like"
      return { kind: "like", negated: false, left, right: h.parseRhs(8) };
    },
  },
  {
    match: word("ident", "between"),
    bp: 7,
    parse: (ctx, left, h): SqlExpr => {
      ctx.next(); // "between"
      const lo = h.parseRhs(8);
      ctx.parse(word("ident", "and"));
      const hi = h.parseRhs(8);
      return { kind: "between", subject: left, lo, hi };
    },
  },
  { ops: ["<", ">", "<=", ">="], bp: 9, type: "punc", assoc: "nonassoc", map: sqlBin },
];
const sqlAtom = oneOf(sqlNum, sqlParen, sqlIdent);

const sqlExpression: Rule<SqlExpr, SqlTT> = pratt<SqlExpr, SqlTT>({ atom: sqlAtom, infix: sqlInfix });

const sqlGrammar = defineGrammar({ lexer: sqlLexer, root: sqlExpression });
const parseSql = (text: string) => sqlGrammar.parse(text);

const id = (name: string): SqlExpr => ({ kind: "ident", name });
const sqlNumLit = (value: number): SqlExpr => ({ kind: "num", value });

describe("pratt() keyword & match-group operators", () => {
  it("matches keyword operators by folded value", () => {
    expect(parseSql("a AND b")).toEqual(sqlBin("and", id("a"), id("b")));
  });

  it("parses a multi-word operator via a phrase match group", () => {
    expect(parseSql("name NOT LIKE pattern")).toEqual({
      kind: "like",
      negated: true,
      left: id("name"),
      right: id("pattern"),
    });
  });

  it("keeps the single-word variant as its own group", () => {
    expect(parseSql("name like pattern")).toEqual({
      kind: "like",
      negated: false,
      left: id("name"),
      right: id("pattern"),
    });
  });

  it("reports a mid-phrase miss with the per-word message", () => {
    expect(() => parseSql("a not b")).toThrow('Expected "like" but found "b"');
  });

  it("parses BETWEEN's internal AND above the and-operator's bp", () => {
    expect(parseSql("x between 1 and 2")).toEqual({
      kind: "between",
      subject: id("x"),
      lo: sqlNumLit(1),
      hi: sqlNumLit(2),
    });
  });

  it("stops parseRhs before a lower-bp operator", () => {
    expect(parseSql("x between 1 and 2 and ok")).toEqual(
      sqlBin("and", { kind: "between", subject: id("x"), lo: sqlNumLit(1), hi: sqlNumLit(2) }, id("ok")),
    );
  });
});

describe("pratt() nonassoc", () => {
  it("rejects chained comparisons", () => {
    expect(() => parseSql("a < b < c")).toThrow('Operator "<" is non-associative');
  });

  it("rejects mixed chains within the group", () => {
    expect(() => parseSql("a < b > c")).toThrow('Operator ">" is non-associative');
  });

  it("parses explicitly grouped comparisons", () => {
    expect(parseSql("(a < b) < c")).toEqual(sqlBin("<", sqlBin("<", id("a"), id("b")), id("c")));
  });

  it("lets lower-bp operators follow a comparison", () => {
    expect(parseSql("a < b and c < d")).toEqual(
      sqlBin("and", sqlBin("<", id("a"), id("b")), sqlBin("<", id("c"), id("d"))),
    );
  });
});

// Opt-in `when` guards: a group that matched the current token can still
// decline after peeking, handing the token to a later group or ending the
// expression.
type GuardExpr =
  | { kind: "num"; value: number }
  | { kind: "binary"; op: string; left: GuardExpr; right: GuardExpr }
  | { kind: "factorial" | "double-factorial"; operand: GuardExpr }
  | { kind: "zero-times"; right: GuardExpr };

const guardCalls: string[] = [];
const guardNum = token("num").map((node): GuardExpr => ({ kind: "num", value: Number(node.value) }));
const guardParen = seq(
  skip(punc("(")),
  field(
    "e",
    lazy<GuardExpr, MathTT>(() => guarded),
  ),
  skip(punc(")")),
).map((s) => s.e);
const guardBin = (op: string, left: GuardExpr, right: GuardExpr): GuardExpr => ({ kind: "binary", op, left, right });

const guarded: Rule<GuardExpr, MathTT> = pratt<GuardExpr, MathTT>({
  atom: oneOf(guardNum, guardParen),
  infix: [
    { ops: ["+", "-"], bp: 11, type: "punc", map: guardBin },
    {
      // Sees `left`: only a literal 0 on the left takes this group.
      ops: ["*"],
      bp: 12,
      type: "punc",
      when: (ctx, left) => {
        guardCalls.push(`* ${ctx.peek()?.value}`);
        return left.kind === "num" && left.value === 0;
      },
      map: (_op, _left, right): GuardExpr => ({ kind: "zero-times", right }),
    },
    { ops: ["*"], bp: 12, type: "punc", map: guardBin },
    {
      // Peeks past the operator: `^` only before a number, with no fallback.
      match: punc("^"),
      bp: 13,
      when: (ctx) => ctx.peekAhead(1)?.type === "num",
      parse: (ctx, left, h) => {
        ctx.next();
        return guardBin("^", left, h.parseRhs(13));
      },
    },
  ],
  postfix: [
    {
      match: punc("!"),
      bp: 17,
      when: (ctx, left) => left.kind === "num" && ctx.peekAhead(1)?.value === "!",
      parse: (ctx, left): GuardExpr => {
        ctx.next();
        ctx.next();
        return { kind: "double-factorial", operand: left };
      },
    },
    {
      match: punc("!"),
      bp: 17,
      when: (_ctx, left) => left.kind === "num",
      parse: (ctx, left): GuardExpr => {
        ctx.next();
        return { kind: "factorial", operand: left };
      },
    },
  ],
});

// The trailing `^ (…)` lets a test show where the guarded expression stopped.
const guardRoot = seq(
  field("e", guarded),
  field("rest", optional(seq(skip(punc("^")), field("x", guarded)).map((s) => s.x))),
);
const guardGrammar = defineGrammar({ lexer: mathLexer, root: guardRoot });
const parseGuarded = (text: string) => stripSpans(guardGrammar.parse(text));

const errorOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a parse error");
};

describe("pratt() when guards", () => {
  beforeEach(() => {
    guardCalls.length = 0;
  });

  it("falls through to a later infix group when the guard declines", () => {
    expect(parseGuarded("0 * 2")).toEqual({ e: { kind: "zero-times", right: num(2) }, rest: null });
    expect(parseGuarded("1 * 2")).toEqual({ e: bin("*", num(1), num(2)), rest: null });
  });

  it("ends the expression when an infix guard declines with no fallback", () => {
    expect(parseGuarded("1 ^ 2")).toEqual({ e: bin("^", num(1), num(2)), rest: null });
    expect(parseGuarded("1 + 2 ^ (3)")).toEqual({ e: bin("+", num(1), num(2)), rest: num(3) });
  });

  it("guards postfix groups, falling through and then ending the loop", () => {
    expect(parseGuarded("3!!")).toEqual({ e: { kind: "double-factorial", operand: num(3) }, rest: null });
    expect(parseGuarded("3!")).toEqual({ e: { kind: "factorial", operand: num(3) }, rest: null });
    expect(() => parseGuarded("(1 + 2)!")).toThrow('found "!"');
  });

  it("hands a token every postfix group declines on to infix lookup", () => {
    const bang = pratt<GuardExpr, MathTT>({
      atom: guardNum,
      infix: [{ ops: ["!"], bp: 11, type: "punc", map: guardBin }],
      postfix: [
        {
          match: punc("!"),
          bp: 17,
          when: (ctx) => ctx.peekAhead(1)?.type !== "num",
          parse: (ctx, left): GuardExpr => {
            ctx.next();
            return { kind: "factorial", operand: left };
          },
        },
      ],
    });
    const bangGrammar = defineGrammar({ lexer: mathLexer, root: bang });
    expect(stripSpans(bangGrammar.parse("3!"))).toEqual({ kind: "factorial", operand: num(3) });
    expect(stripSpans(bangGrammar.parse("3 ! 4"))).toEqual(bin("!", num(3), num(4)));
  });

  it("runs a guard only for tokens its group's operator matched", () => {
    parseGuarded("1 + 2 - 3");
    expect(guardCalls).toEqual([]);
    parseGuarded("1 * 2");
    expect(guardCalls).toEqual(["* *"]);
  });

  it("matches the unguarded tables exactly when every guard accepts", () => {
    // The same tables with an always-true guard on every infix and postfix
    // group: same first set, same trees and spans, same chain errors.
    const accept = <G extends object>(groups: readonly G[]) => groups.map((group) => ({ ...group, when: () => true }));

    const mathTwin = pratt<Expr, MathTT>({
      atom: mathAtom,
      prefix: mathPrefix,
      infix: accept(mathInfix),
      postfix: accept(mathPostfix),
    });
    const mathTwinGrammar = defineGrammar({ lexer: mathLexer, root: mathTwin });
    expect(mathTwin.first()).toEqual(expression.first());
    for (const text of ["1 + 2 * 3", "(1 + 2) * 3", "1 - 2 - 3", "2 ^ 3 ^ 4", "-2 + 3", "-2!", "3! * -(4 + 5)!"]) {
      expect(mathTwinGrammar.parse(text)).toEqual(grammar.parse(text));
    }

    const sqlTwin = pratt<SqlExpr, SqlTT>({ atom: sqlAtom, infix: accept(sqlInfix) });
    const sqlTwinGrammar = defineGrammar({ lexer: sqlLexer, root: sqlTwin });
    expect(sqlTwin.first()).toEqual(sqlExpression.first());
    for (const text of ["name NOT LIKE pattern", "x between 1 and 2 and ok", "a < b and c < d", "(a < b) < c"]) {
      expect(sqlTwinGrammar.parse(text)).toEqual(sqlGrammar.parse(text));
    }
    for (const text of ["a < b < c", "a < b > c"]) {
      expect(() => sqlGrammar.parse(text)).toThrow(/is non-associative/);
      expect(errorOf(() => sqlTwinGrammar.parse(text))).toBe(errorOf(() => sqlGrammar.parse(text)));
    }
  });

  it("does not report a nonassoc chain for an operator its guard declines", () => {
    const cmp: Rule<SqlExpr, SqlTT> = pratt<SqlExpr, SqlTT>({
      atom: oneOf(sqlNum, sqlIdent),
      infix: [
        {
          ops: ["<", ">"],
          bp: 9,
          type: "punc",
          assoc: "nonassoc",
          // Reads `left`: the chain check must see the combined `a < b`.
          when: (ctx, left) => left.kind !== "binary" || ctx.peekAhead(1)?.value !== "(",
          map: sqlBin,
        },
      ],
    });
    // The declined `< (…)` is left for the enclosing rule.
    const root = seq(
      field("e", cmp),
      field("rest", optional(seq(skip(sqlPunc("<")), field("x", sqlParen)).map((s) => s.x))),
    );
    const cmpGrammar = defineGrammar({ lexer: sqlLexer, root });
    expect(() => cmpGrammar.parse("a < b < c")).toThrow('Operator "<" is non-associative');
    expect(stripSpans(cmpGrammar.parse("a < b < (c)"))).toEqual({ e: sqlBin("<", id("a"), id("b")), rest: id("c") });
  });
});
