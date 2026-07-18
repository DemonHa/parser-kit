import { describe, expect, it } from "vitest";
import {
  attempt,
  bindTokens,
  custom,
  delimited,
  field,
  lazy,
  oneOf,
  optional,
  repeat,
  sepBy,
  seq,
  skip,
} from "./combinators";
import { ParseError } from "./error";
import { defineGrammar } from "./grammar";
import { defineLexer, readers } from "./lexer";
import type { Rule } from "./rule";
import { stripSpans } from "./strip-spans";

const toyLexer = defineLexer({
  keywords: {
    type: "kw",
    words: ["null", "true", "false", ["not", "null"]],
    caseInsensitive: true,
    display: "a keyword",
  },
  punctuation: {
    type: "punc",
    tokens: ["(", ")", "[", "]", "{", "}", ",", ":", ".", "\n"],
    display: "a symbol",
  },
  identifier: { type: "var", start: /[a-z_]/i, part: /[a-z0-9_]/i, display: "an identifier" },
  readers: [
    readers.number("num", { display: "a number" }),
    readers.string("str", { quote: "'", display: "a string" }),
    readers.lineComment("comment", "//", { display: "a comment" }),
  ],
});

type ToyTT = "kw" | "punc" | "var" | "num" | "str" | "comment";

const { token, match } = bindTokens<ToyTT>();
const punc = (value: string) => token("punc", { values: [value] });

// parseValue runs any rule standalone with the toy lexer, comments as trivia.
const grammar = defineGrammar({
  lexer: toyLexer,
  root: token("var"),
  trivia: { between: [{ type: "comment" }] },
});
const parseWith = <T>(rule: Rule<T, ToyTT>, text: string): T => grammar.parseValue(rule, text);

describe("token()", () => {
  it("matches by type and returns a span-carrying node", () => {
    expect(parseWith(token("var"), "foo")).toEqual({
      type: "var",
      value: "foo",
      span: { start: { row: 1, col: 0 }, end: { row: 1, col: 3 } },
    });
  });

  it("narrows to the allowed values", () => {
    const rule = token("kw", { values: ["true", "false"] });
    expect(parseWith(rule, "true").value).toBe("true");
    expect(() => parseWith(rule, "null")).toThrow('Expected "true" or "false" but found "null"');
  });

  it("uses the lexer display label for type-only mismatches", () => {
    expect(() => parseWith(token("num"), "foo")).toThrow('Expected a number but found "foo"');
  });

  it("reports end of input", () => {
    expect(() => parseWith(token("num"), "")).toThrow("Expected a number but found end of input");
  });

  it("honors a display override and describe()", () => {
    expect(() => parseWith(token("num", { display: "an amount" }), "foo")).toThrow(
      'Expected an amount but found "foo"',
    );
    expect(() => parseWith(token("num").describe("a count"), "foo")).toThrow('Expected a count but found "foo"');
  });
});

describe("map()", () => {
  it("transforms the value and receives the span", () => {
    const rule = token("num").map((node, span) => ({ parsed: Number(node.value), span }));
    const result = parseWith(rule, "42");
    expect(result.parsed).toBe(42);
    expect(result.span).toEqual({ start: { row: 1, col: 0 }, end: { row: 1, col: 2 } });
  });
});

describe("seq() / field() / skip()", () => {
  const pair = seq(field("name", token("var")), skip(punc(":")), field("value", token("num")));

  it("collects fields, drops skips, and spans the whole match", () => {
    expect(parseWith(pair, "x: 1")).toEqual({
      name: { type: "var", value: "x", span: { start: { row: 1, col: 0 }, end: { row: 1, col: 1 } } },
      value: { type: "num", value: "1", span: { start: { row: 1, col: 3 }, end: { row: 1, col: 4 } } },
      span: { start: { row: 1, col: 0 }, end: { row: 1, col: 4 } },
    });
  });

  it("croaks with the failing item's expectation", () => {
    expect(() => parseWith(pair, "x 1")).toThrow('Expected ":" but found "1"');
  });

  it("extends its first set across a nullable prefix", () => {
    const rule = seq(field("qty", optional(token("num"))), field("name", token("var")));
    expect(rule.first()).toEqual([{ type: "num" }, { type: "var" }]);
    expect(stripSpans(parseWith(rule, "foo"))).toEqual({
      qty: null,
      name: { type: "var", value: "foo" },
    });
  });
});

describe("oneOf()", () => {
  it("dispatches on the first set", () => {
    const rule = oneOf(token("var"), token("num"));
    expect(parseWith(rule, "foo").value).toBe("foo");
    expect(parseWith(rule, "12").value).toBe("12");
  });

  it("lists every branch in the failure message", () => {
    const rule = oneOf(token("var"), token("num"));
    expect(() => parseWith(rule, "'s'")).toThrow('Expected an identifier or a number but found "s"');
  });

  it("prefers value-specific branches over type-only branches regardless of order", () => {
    const rule = oneOf(
      token("kw").map(() => "any keyword"),
      token("kw", { values: ["null"] }).map(() => "the null literal"),
    );
    expect(parseWith(rule, "null")).toBe("the null literal");
    expect(parseWith(rule, "true")).toBe("any keyword");
  });

  it("rejects overlapping first sets at definition time", () => {
    expect(() => oneOf(token("var"), token("var"))).toThrow(/overlapping first sets/);
    expect(() => oneOf(token("kw", { values: ["null"] }), token("kw", { values: ["null"] }))).toThrow(
      /overlapping first sets/,
    );
  });

  it("allows overlap when a branch is wrapped in attempt(), backtracking into later branches", () => {
    const pairInParens = seq(
      skip(punc("(")),
      field("a", token("var")),
      skip(punc(",")),
      field("b", token("var")),
      skip(punc(")")),
    );
    const single = seq(skip(punc("(")), field("only", token("var")), skip(punc(")")));
    const rule = oneOf(attempt(pairInParens), single);

    expect(stripSpans(parseWith(rule, "(x, y)"))).toEqual({
      a: { type: "var", value: "x" },
      b: { type: "var", value: "y" },
    });
    expect(stripSpans(parseWith(rule, "(x)"))).toEqual({ only: { type: "var", value: "x" } });
  });
});

describe("optional()", () => {
  it("parses when the first set matches and defaults otherwise", () => {
    const rule = seq(field("num", optional(token("num"))), field("name", token("var")));
    expect(stripSpans(parseWith(rule, "1 x")).num).toEqual({ type: "num", value: "1" });
    expect(parseWith(rule, "x").num).toBeNull();
  });

  it("supports an explicit default", () => {
    const rule = seq(field("props", optional(token("num"), { default: [] as never[] })), field("name", token("var")));
    expect(parseWith(rule, "x").props).toEqual([]);
  });

  it("backtracks attempt() rules instead of failing", () => {
    const dotted = attempt(seq(field("head", token("var")), skip(punc(".")), field("tail", token("var"))));
    const rule = seq(field("path", optional(dotted)), field("rest", token("var")));
    expect(stripSpans(parseWith(rule, "a.b c")).path).toEqual({
      head: { type: "var", value: "a" },
      tail: { type: "var", value: "b" },
    });
    // "a c" matches dotted's first set but not its body: rolled back to null.
    const fallback = parseWith(rule, "a");
    expect(fallback.path).toBeNull();
    expect(fallback.rest.value).toBe("a");
  });
});

describe("delimited()", () => {
  const item = token("var");

  it("parses interleaved comma lists", () => {
    const rule = delimited(match("punc", "["), match("punc", "]"), match("punc", ","), item, { interleaved: true });
    expect(stripSpans(parseWith(rule, "[a, b, c]")).map((node) => node.value)).toEqual(["a", "b", "c"]);
    expect(parseWith(rule, "[]")).toEqual([]);
    expect(() => parseWith(rule, "[a b]")).toThrow('Expected "," but found "b"');
  });

  it("parses separator-terminated bodies, collapsing separator and trivia runs", () => {
    const rule = delimited(match("punc", "{"), match("punc", "}"), match("punc", "\n"), item);
    const body = "{\n\na // trailing comment\n// a whole comment line\n\nb\n}";
    expect(parseWith(rule, body).map((node) => node.value)).toEqual(["a", "b"]);
  });

  it("requires the separator between items", () => {
    const rule = delimited(match("punc", "{"), match("punc", "}"), match("punc", "\n"), item);
    expect(() => parseWith(rule, "{\na b\n}")).toThrow("Expected a new line but found");
  });
});

describe("sepBy()", () => {
  it("parses a bare separated list", () => {
    const rule = sepBy(token("var"), match("punc", "."));
    expect(stripSpans(parseWith(rule, "a.b.c")).map((node) => node.value)).toEqual(["a", "b", "c"]);
    expect(parseWith(rule, "a")).toHaveLength(1);
  });
});

describe("repeat()", () => {
  it("parses zero or more items until end of input", () => {
    const rule = repeat(token("var"));
    expect(parseWith(rule, "a b c").map((node) => node.value)).toEqual(["a", "b", "c"]);
    expect(parseWith(rule, "")).toEqual([]);
  });

  it("stops at an `until` match", () => {
    const rule = seq(
      skip(punc("{")),
      field("items", repeat(token("var"), { until: [match("punc", "}")] })),
      skip(punc("}")),
    );
    expect(parseWith(rule, "{ a b }").items.map((node) => node.value)).toEqual(["a", "b"]);
  });

  it("croaks on an item outside the rule's first set", () => {
    expect(() => parseWith(repeat(token("var")), "a 1")).toThrow('Expected an identifier but found "1"');
  });
});

describe("lazy()", () => {
  it("supports recursive rules", () => {
    interface Tree {
      value?: string;
      children?: Tree[];
    }
    const tree: Rule<Tree, ToyTT> = lazy(() =>
      oneOf(
        token("var").map((node): Tree => ({ value: node.value })),
        delimited(match("punc", "("), match("punc", ")"), match("punc", ","), tree, { interleaved: true }).map(
          (children): Tree => ({ children }),
        ),
      ),
    );
    expect(parseWith(tree, "(a, (b, c))")).toEqual({
      children: [{ value: "a" }, { children: [{ value: "b" }, { value: "c" }] }],
    });
  });
});

describe("custom()", () => {
  it("composes with other rules and can call ctx.parse", () => {
    // A dotted pair `a.b` promoted to a single string, like dbml's enum_ref.
    const dotted = custom<string, ToyTT>(
      (ctx) => {
        const head = ctx.parse(token("var"));
        if (ctx.eat("punc", ".")) {
          const tail = ctx.parse(token("var"));
          return `${head.value}.${tail.value}`;
        }
        return head.value;
      },
      { expected: "an identifier", first: [{ type: "var" }] },
    );

    const rule = oneOf(
      dotted,
      token("num").map((node) => node.value),
    );
    expect(parseWith(rule, "status.active")).toBe("status.active");
    expect(parseWith(rule, "plain")).toBe("plain");
    expect(parseWith(rule, "12")).toBe("12");
    expect(() => parseWith(rule, "'s'")).toThrow('Expected an identifier or a number but found "s"');
  });
});

describe("stripSpans()", () => {
  it("removes span keys at every depth", () => {
    const value = {
      span: 1,
      list: [{ span: 2, keep: true }],
      nested: { deep: { span: 3, value: "x" } },
    };
    expect(stripSpans(value)).toEqual({ list: [{ keep: true }], nested: { deep: { value: "x" } } });
  });
});

describe("ParseError", () => {
  it("carries msg, start and end with a positioned message", () => {
    const error = new ParseError("boom", { row: 2, col: 3 }, { row: 2, col: 5 });
    expect(error.message).toBe("boom (2:3)");
    expect(error.msg).toBe("boom");
    expect(error.start).toEqual({ row: 2, col: 3 });
    expect(error.end).toEqual({ row: 2, col: 5 });
  });
});
