import { describe, expect, it } from "vitest";
import { ParseError } from "./error";
import { createInputStream } from "./input-stream";
import { defineLexer, readers } from "./lexer";
import type { Token } from "./token";

const toyLexer = defineLexer({
  keywords: {
    type: "kw",
    words: ["null", "true", "false", ["not", "null"], ["primary", "key"]],
    caseInsensitive: true,
    display: "a keyword",
  },
  punctuation: {
    type: "punc",
    tokens: ["(", ")", "[", "]", "{", "}", ",", ":", ".", "\n", "<", ">", "<>", "-"],
    display: "a symbol",
  },
  identifier: { type: "var", start: /[a-z_]/i, part: /[a-z0-9_]/i, display: "an identifier" },
  readers: [
    readers.number("num", { signs: ["-"], display: "a number" }),
    readers.string("str", { quote: "'", display: "a string", block: { fence: "'''", type: "mstr" } }),
    readers.lineComment("comment", "//", { display: "a comment" }),
    readers.blockComment("comment", "/*", "*/"),
  ],
});

const tokens = (text: string) => {
  const stream = toyLexer.tokenize(createInputStream(text));
  const out: Token[] = [];
  let token: Token | null;
  while ((token = stream.next()) !== null) {
    out.push(token);
  }
  return out;
};

const kinds = (text: string) => tokens(text).map((token) => `${token.type}:${token.value}`);

describe("defineLexer", () => {
  it("lexes identifiers and keywords", () => {
    expect(kinds("foo null nothing")).toEqual(["var:foo", "kw:null", "var:nothing"]);
  });

  it("matches keywords case-insensitively, keeping the lowercase form", () => {
    expect(kinds("NULL True")).toEqual(["kw:null", "kw:true"]);
  });

  it("joins multi-word keywords across whitespace runs", () => {
    expect(kinds("not    null")).toEqual(["kw:not null"]);
    expect(kinds("primary key")).toEqual(["kw:primary key"]);
  });

  it("falls back to an identifier when only a keyword prefix matches", () => {
    expect(kinds("nullify")).toEqual(["var:nullify"]);
    expect(kinds("not sure")).toEqual(["var:not", "var:sure"]);
  });

  it("prefers the longest punctuation token", () => {
    expect(kinds("<><")).toEqual(["punc:<>", "punc:<"]);
  });

  it("reads integers, floats and signed numbers", () => {
    expect(kinds("12 1.5 -3 -2.75")).toEqual(["num:12", "num:1.5", "num:-3", "num:-2.75"]);
  });

  it("leaves a trailing decimal point for the next token", () => {
    expect(kinds("1.foo")).toEqual(["num:1", "punc:.", "var:foo"]);
  });

  it("treats a sign without a following digit as punctuation", () => {
    expect(kinds("a - b")).toEqual(["var:a", "punc:-", "var:b"]);
    expect(kinds("a -3")).toEqual(["var:a", "num:-3"]);
  });

  it("reads quoted strings", () => {
    expect(kinds("'hello world'")).toEqual(["str:hello world"]);
    expect(kinds("''")).toEqual(["str:"]);
  });

  it("reads block strings with dedent", () => {
    expect(kinds("'''\n    line one\n      line two\n    '''")).toEqual(["mstr:line one\n  line two"]);
  });

  it("croaks on an unterminated block string", () => {
    expect(() => kinds("'''\nabc")).toThrow(ParseError);
    expect(() => kinds("'''\nabc")).toThrow(/Unterminated multi-line string/);
  });

  it("reads line comments up to the newline", () => {
    expect(kinds("// hi\nx")).toEqual(["comment: hi", "punc:\n", "var:x"]);
  });

  it("reads block comments, excluding the delimiters", () => {
    expect(kinds("/* a\nb */ x")).toEqual(["comment: a\nb ", "var:x"]);
  });

  it("records token positions", () => {
    const [name] = tokens("ab 'cd'");
    expect(name!.position).toEqual({ start: { row: 1, col: 0 }, end: { row: 1, col: 2 } });

    // String spans cover the content, not the quotes.
    const [, str] = tokens("ab 'cd'");
    expect(str!.position).toEqual({ start: { row: 1, col: 4 }, end: { row: 1, col: 6 } });
  });

  it("croaks on a character nothing can read", () => {
    expect(() => kinds("@")).toThrow(ParseError);
    expect(() => kinds("@")).toThrow(/Unexpected character "@"/);
  });

  it("exposes display labels for error messages", () => {
    expect(toyLexer.labels).toEqual({
      kw: "a keyword",
      punc: "a symbol",
      var: "an identifier",
      num: "a number",
      str: "a string",
      comment: "a comment",
    });
  });

  it("rejects keywords without an identifier definition", () => {
    expect(() => defineLexer({ keywords: { type: "kw", words: ["x"] } })).toThrow(/requires an `identifier`/);
  });

  it("supports custom readers", () => {
    const lexer = defineLexer({
      identifier: { type: "var", start: /[a-z]/, part: /[a-z]/ },
      readers: [
        readers.custom("hex", {
          startsWith: "#",
          read: (stream) => {
            stream.next();
            let value = "";
            while (!stream.eof() && /[0-9a-f]/i.test(stream.peek())) {
              value += stream.next();
            }
            return value;
          },
          display: "a hex color",
        }),
      ],
    });
    const stream = lexer.tokenize(createInputStream("#ff3 x"));
    expect(stream.next()).toMatchObject({ type: "hex", value: "ff3" });
    expect(stream.next()).toMatchObject({ type: "var", value: "x" });
    expect(lexer.labels).toEqual({ hex: "a hex color" });
  });
});
