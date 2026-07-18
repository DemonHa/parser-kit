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
