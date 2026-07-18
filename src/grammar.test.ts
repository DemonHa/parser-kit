import { describe, expect, it } from "vitest";
import { bindTokens, field, optional, seq } from "./combinators";
import { ParseError } from "./error";
import { defineExpression, defineGrammar } from "./grammar";
import { defineLexer, readers } from "./lexer";
import { stripSpans } from "./strip-spans";

// A miniature dbml-style language: keyword-led top-level constructs, newlines
// lexed as punctuation, newline/comment trivia between constructs.
const miniLexer = defineLexer({
  keywords: { type: "kw", words: ["item", "group"], caseInsensitive: true, display: "a keyword" },
  punctuation: { type: "punc", tokens: ["{", "}", "\n", ","], display: "a symbol" },
  identifier: { type: "var", start: /[a-z_]/i, part: /[a-z0-9_]/i, display: "an identifier" },
  readers: [readers.lineComment("comment", "//", { display: "a comment" })],
});

type MiniTT = "kw" | "punc" | "var" | "comment";

const { token } = bindTokens<MiniTT>();
const name = token("var").map((node) => node.value);

const itemExpr = defineExpression({
  keyword: { type: "kw", value: "item" } as const,
  type: "item",
  display: "Item",
  rule: seq(field("name", name)),
});

const groupExpr = defineExpression({
  keyword: { type: "kw", value: "group" } as const,
  type: "group",
  display: "Group",
  rule: seq(field("name", name), field("alias", optional(name))),
});

const mini = defineGrammar({
  lexer: miniLexer,
  expressions: [itemExpr, groupExpr],
  trivia: { between: [{ type: "punc", value: "\n" }, { type: "comment" }] },
});

describe("defineExpression()", () => {
  it("consumes the keyword, stamps the discriminant and spans the construct", () => {
    const ast = mini.parse("item apple");
    expect(ast.program).toHaveLength(1);
    expect(stripSpans(ast.program[0])).toEqual({ type: "item", name: "apple" });
    expect(ast.program[0]).toMatchObject({
      span: { start: { row: 1, col: 0 }, end: { row: 1, col: 10 } },
    });
  });
});

describe("defineGrammar() — expressions form", () => {
  it("parses a program, skipping newline and comment trivia between constructs", () => {
    const ast = mini.parse("// leading comment\nitem apple\n\ngroup fruit basket\nITEM pear\n");
    expect(stripSpans(ast.program)).toEqual([
      { type: "item", name: "apple" },
      { type: "group", name: "fruit", alias: "basket" },
      { type: "item", name: "pear" },
    ]);
  });

  it("derives the top-level error message from the expression displays", () => {
    expect(() => mini.parse("bogus")).toThrow('Expected "Item" or "Group" but found "bogus"');
  });

  it("throws the first error in strict mode", () => {
    expect(() => mini.parse("item apple\nbogus\nitem pear")).toThrow(ParseError);
  });

  it("diagnose() recovers at the derived keyword sync points", () => {
    const { ast, errors } = mini.diagnose("item apple\nbogus stuff more\nitem pear");
    expect(stripSpans(ast.program)).toEqual([
      { type: "item", name: "apple" },
      { type: "item", name: "pear" },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.msg).toBe('Expected "Item" or "Group" but found "bogus"');
  });

  it("diagnose() collects lexer errors while recovering", () => {
    const { ast, errors } = mini.diagnose("item apple\n@\nitem pear");
    expect(stripSpans(ast.program)).toEqual([
      { type: "item", name: "apple" },
      { type: "item", name: "pear" },
    ]);
    expect(errors.some((error) => error.msg === 'Unexpected character "@"')).toBe(true);
  });

  it("diagnose() reports errors inside a construct and resumes at the next keyword", () => {
    const { ast, errors } = mini.diagnose("item ,\nitem pear");
    expect(stripSpans(ast.program)).toEqual([{ type: "item", name: "pear" }]);
    expect(errors[0]!.msg).toBe('Expected an identifier but found ","');
  });
});

describe("defineGrammar() — parseValue", () => {
  it("runs a sub-rule standalone", () => {
    expect(mini.parseValue(name, "apple")).toBe("apple");
  });

  it("rejects leftover input", () => {
    expect(() => mini.parseValue(name, "apple pie")).toThrow('Expected end of input but found "pie"');
  });
});
