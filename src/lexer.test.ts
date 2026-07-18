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

describe("readers.number extensions (A4)", () => {
  const num = defineLexer({
    identifier: { type: "ident", start: /[A-Za-z_]/, part: /[A-Za-z0-9_]/ },
    punctuation: { type: "punc", tokens: ["."] },
    readers: [
      readers.number("num", {
        exponent: true,
        leadingDot: true,
        radix: { hex: true, octal: true, binary: true },
        separators: true,
      }),
    ],
  });

  it("reads scientific notation", () => {
    expect(lex(num, "1e5 1.5e-3 2E+10")).toEqual(["num:1e5", "num:1.5e-3", "num:2E+10"]);
  });

  it("backtracks a bare exponent, leaving the marker for the identifier scanner", () => {
    expect(lex(num, "1e")).toEqual(["num:1", "ident:e"]);
  });

  it("reads a leading-dot number but keeps `.` punctuation between identifiers", () => {
    expect(lex(num, ".5")).toEqual(["num:.5"]);
    expect(lex(num, "1.5")).toEqual(["num:1.5"]);
    expect(lex(num, "a.b")).toEqual(["ident:a", "punc:.", "ident:b"]);
  });

  it("reads hex, octal and binary literals", () => {
    expect(lex(num, "0x1F 0o17 0b1010")).toEqual(["num:0x1F", "num:0o17", "num:0b1010"]);
  });

  it("backtracks a bare radix marker to `0`", () => {
    expect(lex(num, "0x")).toEqual(["num:0", "ident:x"]);
    expect(lex(num, "0xG")).toEqual(["num:0", "ident:xG"]);
  });

  it("strips digit separators from the value", () => {
    expect(lex(num, "1_000_000")).toEqual(["num:1000000"]);
    expect(lex(num, "1_000.5")).toEqual(["num:1000.5"]);
    expect(lex(num, "0x1_F")).toEqual(["num:0x1F"]);
  });

  it("leaves a leading, trailing or doubled separator for the next token", () => {
    expect(lex(num, "1_")).toEqual(["num:1", "ident:_"]);
    expect(lex(num, "1__0")).toEqual(["num:1", "ident:__0"]);
  });

  it("produces values that `Number()` decodes", () => {
    const value = (text: string) => num.tokenize(createInputStream(text)).next()!.value;
    expect(Number(value("1_000_000"))).toBe(1000000);
    expect(Number(value("0x1F"))).toBe(31);
    expect(Number(value("0o17"))).toBe(15);
    expect(Number(value("0b1010"))).toBe(10);
    expect(Number(value("1.5e-3"))).toBe(0.0015);
  });

  it("spans the raw text including stripped separators", () => {
    const stream = num.tokenize(createInputStream("1_000"));
    expect(stream.next()).toMatchObject({
      value: "1000",
      position: { start: { row: 1, col: 0 }, end: { row: 1, col: 5 } },
    });
  });

  it("stays byte-identical to the plain reader without extensions", () => {
    const plain = defineLexer({
      identifier: { type: "ident", start: /[A-Za-z_]/, part: /[A-Za-z0-9_]/ },
      punctuation: { type: "punc", tokens: ["."] },
      readers: [readers.number("num", { signs: ["-"] })],
    });
    expect(lex(plain, "12 1.5 -3")).toEqual(["num:12", "num:1.5", "num:-3"]);
    expect(lex(plain, "1.foo")).toEqual(["num:1", "punc:.", "ident:foo"]);
    // No exponent/separator/radix support unless opted in.
    expect(lex(plain, "1e5")).toEqual(["num:1", "ident:e5"]);
    expect(lex(plain, "1_000")).toEqual(["num:1", "ident:_000"]);
  });
});

describe("readers.operator (A5)", () => {
  // `::`/`:` stay in the punctuation trie (no operator char overlaps them); comment
  // readers precede the operator reader so `stopAt` can partition cleanly.
  const pg = defineLexer({
    identifier: { type: "ident", start: /[A-Za-z_]/, part: /[A-Za-z0-9_]/ },
    punctuation: { type: "punc", tokens: ["::", ":", ",", "(", ")", ";", "."] },
    readers: [
      readers.lineComment("comment", "--"),
      readers.blockComment("comment", "/*", "*/"),
      readers.operator("op"),
      readers.number("num"),
    ],
  });

  it("reads multi-character operators greedily", () => {
    expect(lex(pg, "a || b")).toEqual(["ident:a", "op:||", "ident:b"]);
    expect(lex(pg, "x @> y")).toEqual(["ident:x", "op:@>", "ident:y"]);
    expect(lex(pg, "a <= b")).toEqual(["ident:a", "op:<=", "ident:b"]);
  });

  it("coexists with the punctuation trie by partitioning the character space", () => {
    expect(lex(pg, "a::b")).toEqual(["ident:a", "punc:::", "ident:b"]);
    expect(lex(pg, "1::float8")).toEqual(["num:1", "punc:::", "ident:float8"]);
    expect(lex(pg, "a::int || b")).toEqual(["ident:a", "punc:::", "ident:int", "op:||", "ident:b"]);
  });

  it("stops before a `--` comment start mid-run", () => {
    expect(lex(pg, "a@--x")).toEqual(["ident:a", "op:@", "comment:x"]);
  });

  it("stops before a `/*` comment start mid-run", () => {
    expect(lex(pg, "a@/* c */b")).toEqual(["ident:a", "op:@", "comment: c ", "ident:b"]);
  });

  it("trims a trailing + or - unless the operator contains a strong char", () => {
    expect(lex(pg, "=-")).toEqual(["op:=", "op:-"]);
    expect(lex(pg, "*+")).toEqual(["op:*", "op:+"]);
    expect(lex(pg, "@-")).toEqual(["op:@-"]);
    expect(lex(pg, "~+")).toEqual(["op:~+"]);
    expect(lex(pg, "<->")).toEqual(["op:<->"]);
    expect(lex(pg, "+")).toEqual(["op:+"]);
  });

  it("splits `a=-1` into `=` then `-` per the trailing-trim rule", () => {
    expect(lex(pg, "a=-1")).toEqual(["ident:a", "op:=", "op:-", "num:1"]);
  });

  it("records operator spans", () => {
    const stream = pg.tokenize(createInputStream("@>"));
    expect(stream.next()).toMatchObject({
      type: "op",
      value: "@>",
      position: { start: { row: 1, col: 0 }, end: { row: 1, col: 2 } },
    });
  });
});

describe("identifier case folding (B)", () => {
  // The PG setup: unquoted identifiers fold to lowercase, quoted identifiers
  // come from a string reader and keep their case.
  const pg = defineLexer({
    identifier: { type: "ident", start: /[A-Za-z_]/, part: /[A-Za-z0-9_$]/, fold: "lower" },
    punctuation: { type: "punc", tokens: ["(", ")", ",", ";"] },
    readers: [readers.string("qident", { quote: '"', escape: { doubling: true } })],
  });

  it("folds unquoted identifiers to lowercase", () => {
    expect(lex(pg, "SELECT Foo bar")).toEqual(["ident:select", "ident:foo", "ident:bar"]);
  });

  it("supports upper folding", () => {
    const upper = defineLexer({
      identifier: { type: "ident", start: /[A-Za-z_]/, part: /[A-Za-z0-9_]/, fold: "upper" },
    });
    expect(lex(upper, "select")).toEqual(["ident:SELECT"]);
  });

  it("preserves case in quoted identifiers, with doubling", () => {
    expect(lex(pg, '"MyTable"')).toEqual(["qident:MyTable"]);
    expect(lex(pg, '"a""b"')).toEqual(['qident:a"b']);
  });

  it("keeps the raw text recoverable via the span", () => {
    const stream = pg.tokenize(createInputStream("SELECT"));
    expect(stream.next()).toMatchObject({
      value: "select",
      position: { start: { row: 1, col: 0 }, end: { row: 1, col: 6 } },
    });
  });

  it("leaves the keyword trie untouched by folding", () => {
    const withKeywords = defineLexer({
      keywords: { type: "kw", words: [["not", "null"]], caseInsensitive: true },
      identifier: { type: "ident", start: /[A-Za-z_]/, part: /[A-Za-z0-9_]/, fold: "upper" },
    });
    // The trie keeps its own lowercase form; only plain identifiers fold.
    expect(lex(withKeywords, "NOT NULL other")).toEqual(["kw:not null", "ident:OTHER"]);
  });
});
