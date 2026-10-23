import { describe, expect, it } from "vitest";
import { attempt, bindTokens, field, oneOf, optional, repeat, seq, skip } from "./combinators";
import { ParseError } from "./error";
import { defineExpression, defineGrammar } from "./grammar";
import { defineLexer, readers } from "./lexer";
import { makeRule } from "./rule";
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

describe("defineGrammar() — errorReporting.preferFarthest", () => {
  const farLexer = defineLexer({
    punctuation: { type: "punc", tokens: [":", ","], display: "a symbol" },
    identifier: { type: "far", start: /[a-z_]/i, part: /[a-z0-9_]/i, display: "an identifier" },
    readers: [readers.number("num", { display: "a number" })],
  });
  type FarTT = "punc" | "far" | "num";
  const t = bindTokens<FarTT>().token;

  // On `foo : bar` the attempted branch consumes two tokens before failing on
  // `bar`; the committed branch fails on `:` after one. The thrown error is
  // the shallow one — farthest selection swaps in the deeper, better message.
  const stmt = oneOf(
    attempt(seq(skip(t("far")), skip(t("punc", { values: [":"] })), field("value", t("num")))),
    seq(skip(t("far")), field("value", t("far"))),
  );
  const strict = defineGrammar({ lexer: farLexer, root: repeat(stmt) });
  const farthest = defineGrammar({
    lexer: farLexer,
    root: repeat(stmt),
    errorReporting: { preferFarthest: true },
  });

  it("off (default): reports the error the parse actually threw", () => {
    expect(() => strict.parse("foo : bar")).toThrow('Expected an identifier but found ":"');
  });

  it("on: reports the deepest failure from a discarded backtracking branch", () => {
    expect(() => farthest.parse("foo : bar")).toThrow('Expected a number but found "bar"');
  });

  it("on: diagnose() records the substituted error too", () => {
    const { errors } = farthest.diagnose("foo : bar");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.msg).toBe('Expected a number but found "bar"');
  });

  it("on: a describe() relabel at the same depth still wins the tie", () => {
    const labeled = defineGrammar({
      lexer: farLexer,
      root: seq(skip(t("far")), field("value", t("num").describe("a count"))),
      errorReporting: { preferFarthest: true },
    });
    expect(() => labeled.parse("foo bar")).toThrow('Expected a count but found "bar"');
  });
});

describe("defineGrammar() — errorReporting.propagateLexerErrors", () => {
  // `@` doesn't lex. The lexer consumes it before croaking, so once a
  // backtracking branch rolls back the character is gone for good.
  const lexLexer = defineLexer({
    punctuation: { type: "punc", tokens: [":", ",", ";"], display: "a symbol" },
    identifier: { type: "word", start: /[a-z_]/i, part: /[a-z0-9_]/i, display: "an identifier" },
    readers: [readers.number("num", { display: "a number" })],
  });
  type LexTT = "punc" | "word" | "num";
  const t = bindTokens<LexTT>().token;
  const p = (value: string) => t("punc", { values: [value] });
  const punc = (value: string) => skip(p(value));
  const num = t("num").map((node) => node.value);
  const word = t("word").map((node) => node.value);

  // `foo : 1` takes the attempted branch; on `foo : @` that branch hits the
  // lexer error and, by default, the committed branch then misreports `:`.
  const stmt = seq(
    field(
      "value",
      oneOf(attempt(seq(skip(t("word")), punc(":"), field("n", num))), seq(skip(t("word")), field("n", word))),
    ),
    punc(";"),
  );
  const sync = [{ type: "punc", value: ";", consume: true }] as const;
  const plain = defineGrammar({ lexer: lexLexer, root: repeat(stmt), recovery: { sync } });
  const propagating = defineGrammar({
    lexer: lexLexer,
    root: repeat(stmt),
    recovery: { sync },
    errorReporting: { propagateLexerErrors: true },
  });

  it("off (default): backtracking swallows the lexer error and leaves it untagged", () => {
    expect(() => plain.parse("foo : @;")).toThrow('Expected an identifier but found ":" (1:4)');
    expect(stripSpans(plain.parse("foo @ bar;"))).toEqual([{ value: { n: "bar" } }]); // `@` silently dropped
    // Not even as an own `undefined` key: the field is declared, never defined.
    expect(() => plain.parse("@")).toThrow(expect.not.objectContaining({ fromLexer: undefined }));
  });

  it("on: tryParse rethrows the lexer error, tagged fromLexer", () => {
    expect(() => propagating.parse("foo : @;")).toThrow(
      expect.objectContaining({ message: 'Unexpected character "@" (1:6)', fromLexer: true }),
    );
    expect(() => propagating.parse("foo @ bar;")).toThrow('Unexpected character "@" (1:4)');
    expect(() => propagating.parseValue(stmt, "foo : @;")).toThrow(expect.objectContaining({ fromLexer: true }));
    expect(stripSpans(propagating.parse("foo : 1; foo bar;"))).toEqual([
      { value: { n: "1" } },
      { value: { n: "bar" } },
    ]);
  });

  it("on: escapes nested attempts", () => {
    const root = oneOf(
      attempt(seq(skip(t("word")), field("inner", oneOf(attempt(seq(punc(":"), field("n", num))), p(","))))),
      seq(skip(t("word")), field("other", word)),
    );
    const grammar = (propagateLexerErrors: boolean) =>
      defineGrammar({ lexer: lexLexer, root, errorReporting: { propagateLexerErrors } });
    expect(() => grammar(true).parse("foo : @")).toThrow('Unexpected character "@"');
    expect(() => grammar(false).parse("foo : @")).toThrow('Expected an identifier but found ":"');
    // Ordinary failures inside the nest still roll back.
    expect(() => grammar(true).parse("foo : bar")).toThrow('Expected an identifier but found ":"');
  });

  it("on: diagnose() records each lexer error once and resumes at the next sync point", () => {
    const { ast, errors } = propagating.diagnose("foo : @; foo : 2; foo : @ @ 3; foo bar;");
    // The second `@` of the third statement is hit by recovery's own skip loop.
    expect(errors.map((error) => error.message)).toEqual([
      'Unexpected character "@" (1:6)',
      'Unexpected character "@" (1:24)',
      'Unexpected character "@" (1:26)',
    ]);
    expect(stripSpans(ast)).toEqual([{ value: { n: "2" } }, { value: { n: "bar" } }]);
  });

  it("on: describe() keeps the lexer message instead of relabelling it", () => {
    const root = seq(skip(t("word")), field("n", t("num").describe("a count")));
    const grammar = (propagateLexerErrors: boolean) =>
      defineGrammar({ lexer: lexLexer, root, errorReporting: { propagateLexerErrors } });
    expect(() => grammar(false).parse("foo @")).toThrow("Expected a count but found end of input");
    expect(() => grammar(true).parse("foo @")).toThrow('Unexpected character "@"');
  });

  it("on: a propagated lexer error is never replaced by a farthest croak", () => {
    // The attempt croaks on `x` four tokens in; the second branch has consumed
    // one token when its lookahead reaches the `@`. Lexer errors carry no
    // consumed stamp, so the shallower lexer error still wins.
    const lookahead = makeRule<null, LexTT>({
      parse: (ctx) => {
        ctx.next();
        ctx.peekAhead(4);
        return ctx.croak("unreachable");
      },
      first: () => [{ type: "word" }],
      expected: () => "a lookahead",
    });
    const root = oneOf(
      attempt(seq(skip(t("word")), punc(":"), skip(t("num")), punc(","), skip(t("num")))),
      attempt(lookahead),
    );
    const grammar = (propagateLexerErrors: boolean) =>
      defineGrammar({ lexer: lexLexer, root, errorReporting: { preferFarthest: true, propagateLexerErrors } });
    expect(() => grammar(false).parse("foo : 1 , x @")).toThrow('Expected a number but found "x"');
    expect(() => grammar(true).parse("foo : 1 , x @")).toThrow('Unexpected character "@"');
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
