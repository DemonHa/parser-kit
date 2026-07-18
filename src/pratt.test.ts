import { describe, expect, it } from "vitest";
import { bindTokens, field, lazy, oneOf, seq, skip } from "./combinators";
import { defineGrammar } from "./grammar";
import { defineLexer, readers } from "./lexer";
import { pratt } from "./pratt";
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

// Recursive rules carry the one explicit annotation type inference can't do.
const expression: Rule<Expr, MathTT> = pratt<Expr, MathTT>({
  atom: oneOf(numberLit, parenExpr),
  prefix: [{ ops: ["-"], bp: 14, type: "punc", map: (op, operand): Expr => ({ kind: "unary", op, operand }) }],
  infix: [
    { ops: ["+", "-"], bp: 11, type: "punc", map: (op, left, right): Expr => ({ kind: "binary", op, left, right }) },
    { ops: ["*"], bp: 12, type: "punc", map: (op, left, right): Expr => ({ kind: "binary", op, left, right }) },
    {
      ops: ["^"],
      bp: 13,
      assoc: "right",
      type: "punc",
      map: (op, left, right): Expr => ({ kind: "binary", op, left, right }),
    },
  ],
  postfix: [
    {
      match: punc("!"),
      bp: 17,
      parse: (ctx, left): Expr => {
        ctx.next();
        return { kind: "factorial", operand: left };
      },
    },
  ],
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

const sqlExpression: Rule<SqlExpr, SqlTT> = pratt<SqlExpr, SqlTT>({
  atom: oneOf(sqlNum, sqlParen, sqlIdent),
  infix: [
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
  ],
});

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
