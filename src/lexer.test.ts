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

// Shared helper: lex `text` with `lexer` into `type:value` strings.
const lex = (lexer: ReturnType<typeof defineLexer>, text: string) => {
  const stream = lexer.tokenize(createInputStream(text));
  const out: string[] = [];
  let token: Token | null;
  while ((token = stream.next()) !== null) {
    out.push(`${token.type}:${token.value}`);
  }
  return out;
};

describe("readers.string escapes (A1)", () => {
  // Plain `'…'` with doubling, plus an `E'…'` prefixed instance that also decodes
  // backslash escapes — the two coexist by matching different startsWith chars.
  const pg = defineLexer({
    identifier: { type: "ident", start: /[A-Za-z_]/, part: /[A-Za-z0-9_]/ },
    readers: [
      readers.string("str", { quote: "'", prefix: "E", escape: { doubling: true, backslash: true } }),
      readers.string("str", { quote: "'", escape: { doubling: true } }),
    ],
  });

  it("decodes doubled quotes into a single quote", () => {
    expect(lex(pg, "'a''b'")).toEqual(["str:a'b"]);
    expect(lex(pg, "''")).toEqual(["str:"]);
    expect(lex(pg, "''''")).toEqual(["str:'"]);
  });

  it("handles a doubled quote at the very end", () => {
    expect(lex(pg, "'a'''")).toEqual(["str:a'"]);
  });

  it("decodes backslash escapes in E-strings", () => {
    expect(lex(pg, "E'a\\nb'")).toEqual(["str:a\nb"]);
    expect(lex(pg, "e'x\\ty'")).toEqual(["str:x\ty"]);
  });

  it("passes unknown backslash escapes through (PG semantics)", () => {
    expect(lex(pg, "E'\\q'")).toEqual(["str:q"]);
  });

  it("falls through when the prefix is not followed by a quote", () => {
    expect(lex(pg, "EXPLAIN")).toEqual(["ident:EXPLAIN"]);
    expect(lex(pg, "explain")).toEqual(["ident:explain"]);
  });

  it("keeps doubling available inside prefixed strings", () => {
    expect(lex(pg, "E'a''b'")).toEqual(["str:a'b"]);
  });

  it("croaks on a backslash at EOF", () => {
    expect(() => lex(pg, "E'ab\\")).toThrow(ParseError);
    expect(() => lex(pg, "E'ab\\")).toThrow(/Unterminated string/);
  });

  it("spans the raw content so the original text is recoverable", () => {
    const stream = pg.tokenize(createInputStream("'a''b'"));
    // value is decoded (a'b) but the span covers the raw a''b between the quotes.
    expect(stream.next()).toMatchObject({
      value: "a'b",
      position: { start: { row: 1, col: 1 }, end: { row: 1, col: 5 } },
    });
  });

  it("stays byte-identical to the plain reader without escape config", () => {
    const plain = defineLexer({
      identifier: { type: "ident", start: /[A-Za-z_]/, part: /[A-Za-z0-9_]/ },
      readers: [readers.string("str", { quote: "'" })],
    });
    // A doubled quote is just two adjacent strings when doubling is off.
    expect(lex(plain, "'a''b'")).toEqual(["str:a", "str:b"]);
  });
});

describe("readers.blockComment nesting (A2)", () => {
  const nested = defineLexer({
    identifier: { type: "ident", start: /[A-Za-z_]/, part: /[A-Za-z0-9_]/ },
    readers: [readers.blockComment("comment", "/*", "*/", { nested: true })],
    whitespace: /[ \t\r\n]/,
  });
  const flat = defineLexer({
    identifier: { type: "ident", start: /[A-Za-z_]/, part: /[A-Za-z0-9_]/ },
    readers: [readers.blockComment("comment", "/*", "*/")],
    whitespace: /[ \t\r\n]/,
  });

  it("balances nested delimiters, keeping inner ones in the value", () => {
    expect(lex(nested, "/* a /* b */ c */x")).toEqual(["comment: a /* b */ c ", "ident:x"]);
  });

  it("balances multiple levels of nesting", () => {
    expect(lex(nested, "/* a /* b /* c */ d */ e */x")).toEqual(["comment: a /* b /* c */ d */ e ", "ident:x"]);
  });

  it("closes at the first delimiter without nesting (unchanged default)", () => {
    expect(lex(flat, "/* a /* b */x")).toEqual(["comment: a /* b ", "ident:x"]);
  });

  it("stays lenient at EOF in both modes", () => {
    expect(lex(nested, "/* a /* b */")).toEqual(["comment: a /* b */"]);
    expect(lex(flat, "/* a /* b")).toEqual(["comment: a /* b"]);
  });
});

describe("readers.dollarString (A3)", () => {
  const pg = defineLexer({
    identifier: { type: "ident", start: /[A-Za-z_]/, part: /[A-Za-z0-9_]/ },
    punctuation: { type: "punc", tokens: ["$"] },
    readers: [readers.dollarString("dstr"), readers.number("num")],
  });

  it("reads $$…$$ and $tag$…$tag$ raw content", () => {
    expect(lex(pg, "$$abc$$")).toEqual(["dstr:abc"]);
    expect(lex(pg, "$$$$")).toEqual(["dstr:"]);
    expect(lex(pg, "$tag$he$$llo$tag$")).toEqual(["dstr:he$$llo"]);
  });

  it("terminates only on the exact matching closer", () => {
    expect(lex(pg, "$a$ outer $b$ inner $b$ still $a$")).toEqual(["dstr: outer $b$ inner $b$ still "]);
  });

  it("falls through for positional params and bare dollars", () => {
    expect(lex(pg, "$1")).toEqual(["punc:$", "num:1"]);
    expect(lex(pg, "$foo bar")).toEqual(["punc:$", "ident:foo", "ident:bar"]);
  });

  it("croaks on an unterminated dollar string", () => {
    expect(() => lex(pg, "$$abc")).toThrow(ParseError);
    expect(() => lex(pg, "$tag$abc")).toThrow(/Unterminated dollar-quoted string/);
  });

  it("spans the raw content between the openers and closer", () => {
    const stream = pg.tokenize(createInputStream("$$abc$$"));
    expect(stream.next()).toMatchObject({
      type: "dstr",
      value: "abc",
      position: { start: { row: 1, col: 2 }, end: { row: 1, col: 5 } },
    });
  });
});
