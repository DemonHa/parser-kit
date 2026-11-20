import { createInputStream, type Lexer, ParseError, type Token } from "@parser-kit/core";
import { describe, expect, it } from "vitest";
import { type DbmlTokenType, dbmlLexer, dbmlParseLexer, dedentNote, rawName } from "../src/lexer";

const tokens = (text: string, lexer: Lexer<DbmlTokenType> = dbmlLexer): Token<DbmlTokenType>[] => {
  const stream = lexer.tokenize(createInputStream(text));
  const out: Token<DbmlTokenType>[] = [];
  let token: Token<DbmlTokenType> | null;
  while ((token = stream.next()) !== null) out.push(token);
  return out;
};

// `type:value`, with a newline token shown as `punc:⏎` so lists stay readable.
const kinds = (text: string, lexer?: Lexer<DbmlTokenType>): string[] =>
  tokens(text, lexer).map((token) => `${token.type}:${token.value === "\n" ? "⏎" : token.value}`);

const only = (text: string): Token<DbmlTokenType> => {
  const all = tokens(text);
  expect(all).toHaveLength(1);
  return all[0]!;
};

const value = (text: string): string => only(text).value;

// The error a lexer throws for `text`, with its message and span.
const lexError = (text: string) => {
  try {
    tokens(text);
  } catch (error) {
    expect(error).toBeInstanceOf(ParseError);
    const { msg, start, end } = error as ParseError;
    return { msg, start, end };
  }
  throw new Error(`expected ${JSON.stringify(text)} to fail`);
};

const at = (row: number, col: number) => ({ row, col });
const span = (startRow: number, startCol: number, endRow: number, endCol: number) => ({
  start: at(startRow, startCol),
  end: at(endRow, endCol),
});

describe("words", () => {
  it("lexes identifiers and keeps their case", () => {
    expect(kinds("Table users_2 TABLE _x")).toEqual(["ident:Table", "ident:users_2", "ident:TABLE", "ident:_x"]);
  });

  it("lexes every keyword as a plain identifier", () => {
    expect(kinds("Project Ref Enum Note indexes checks records TablePartial TableGroup pk null as")).toEqual([
      "ident:Project",
      "ident:Ref",
      "ident:Enum",
      "ident:Note",
      "ident:indexes",
      "ident:checks",
      "ident:records",
      "ident:TablePartial",
      "ident:TableGroup",
      "ident:pk",
      "ident:null",
      "ident:as",
    ]);
  });

  it("lexes Unicode letters and combining marks", () => {
    expect(kinds("bảng tên_cột 表 Ñandú")).toEqual(["ident:bảng", "ident:tên_cột", "ident:表", "ident:Ñandú"]);
    // A combining mark may start a word, as in `@dbml/parse`.
    expect(kinds("é ́x")).toEqual(["ident:é", "ident:́x"]);
  });

  it("spans an identifier exactly", () => {
    expect(tokens("  bảng\n")[0]!.position).toEqual(span(1, 2, 1, 6));
  });

  it("does not take non-ASCII digits as word characters", () => {
    expect(lexError("x١").msg).toBe('Unexpected character "١"');
    expect(lexError("x５").msg).toBe('Unexpected character "５"');
    expect(lexError("x²").msg).toBe('Unexpected character "²"');
  });
});

describe("digit-led words and numbers", () => {
  it("lexes integers, decimals and exponents as numbers, keeping the source text", () => {
    expect(kinds("0 42 007 1.5 1.50 5. 1e5 1E5 2.5e-3 1e+10 1.e2")).toEqual([
      "number:0",
      "number:42",
      "number:007",
      "number:1.5",
      "number:1.50",
      "number:5.",
      "number:1e5",
      "number:1E5",
      "number:2.5e-3",
      "number:1e+10",
      "number:1.e2",
    ]);
  });

  it("lexes a digit-led word with letters as an identifier", () => {
    expect(kinds("2fa_code 1abc 3d 1e 1ex 1e5x 1_000")).toEqual([
      "ident:2fa_code",
      "ident:1abc",
      "ident:3d",
      "ident:1e",
      "ident:1ex",
      "ident:1e5x",
      "ident:1_000",
    ]);
  });

  it("stops a number at punctuation", () => {
    expect(kinds("255)")).toEqual(["number:255", "punc:)"]);
    expect(kinds("(1,2)")).toEqual(["punc:(", "number:1", "punc:,", "number:2", "punc:)"]);
    expect(kinds("1e5.")).toEqual(["number:1e5", "punc:."]);
    expect(kinds("5.)")).toEqual(["number:5.", "punc:)"]);
    // `@dbml/parse` rejects a `5.` that ends the input; here it stays a number.
    expect(kinds("x 5.")).toEqual(["ident:x", "number:5."]);
    // A `.` after an exponent ends the number, with or without a fraction.
    expect(kinds("1.5e5.6")).toEqual(["number:1.5e5", "punc:.", "number:6"]);
  });

  it("leaves a sign to the grammar", () => {
    expect(kinds("-1 -2.5")).toEqual(["punc:-", "number:1", "punc:-", "number:2.5"]);
    // An exponent sign belongs to the number; a dangling one does not.
    expect(kinds("1e-")).toEqual(["ident:1e", "punc:-"]);
    expect(kinds("1e+")).toEqual(["ident:1e", "punc:+"]);
    expect(kinds("+1")).toEqual(["punc:+", "number:1"]);
  });

  it("does not start a number with a dot", () => {
    expect(kinds(".5")).toEqual(["punc:.", "number:5"]);
  });

  it("lexes a digit-led table name before a dot as an identifier", () => {
    expect(kinds("2fa.id")).toEqual(["ident:2fa", "punc:.", "ident:id"]);
  });

  it("rejects a decimal that runs into a word character or a second dot", () => {
    expect(lexError("1.5abc ")).toEqual({ msg: "Invalid number", ...span(1, 0, 1, 6) });
    expect(lexError("1.2.3")).toEqual({ msg: "Invalid number", ...span(1, 0, 1, 5) });
    expect(lexError("1.5e5x")).toEqual({ msg: "Invalid number", ...span(1, 0, 1, 6) });
    expect(lexError("1.id")).toEqual({ msg: "Invalid number", ...span(1, 0, 1, 4) });
  });

  it("spans a number exactly", () => {
    expect(tokens("x 2.5e-3]")[1]!.position).toEqual(span(1, 2, 1, 8));
  });
});

describe("single-quoted strings", () => {
  it("lexes a string and spans its quotes", () => {
    const token = only("'hello'");
    expect(token).toEqual({ type: "string", value: "hello", position: span(1, 0, 1, 7) });
  });

  it("lexes the empty string", () => {
    expect(only("''")).toEqual({ type: "string", value: "", position: span(1, 0, 1, 2) });
  });

  it("decodes every escape", () => {
    expect(value(String.raw`'\' \" \` \\'`)).toBe("' \" ` \\");
    expect(value(String.raw`'\n\t\r\0\b\v\f'`)).toBe("\n\t\r\0\b\v\f");
    expect(value("'\\u00e9\\u4E2D'")).toBe("é中");
  });

  it("keeps the backslash of an escaped space, as @dbml/parse does", () => {
    expect(value(String.raw`'a\ b'`)).toBe("a\\ b");
  });

  it("takes any other escaped character as itself", () => {
    expect(value(String.raw`'\a\q\%\#'`)).toBe("aq%#");
  });

  it("treats a backslash before a newline as a line continuation", () => {
    expect(value("'one \\\ntwo'")).toBe("one two");
    expect(value("'one \\\r\ntwo'")).toBe("one two");
  });

  it("spans the quotes across an escape and a continuation", () => {
    expect(only("'a\\\nb'").position).toEqual(span(1, 0, 2, 2));
  });

  it("rejects an unterminated string at the end of the line", () => {
    expect(lexError("'abc\n'")).toEqual({ msg: "Unterminated string", ...span(1, 0, 1, 4) });
    // A CRLF's carriage return is left out of the span.
    expect(lexError("x 'abc\r\ny")).toEqual({ msg: "Unterminated string", ...span(1, 2, 1, 6) });
  });

  it("rejects an unterminated string at the end of input", () => {
    expect(lexError("'abc")).toEqual({ msg: "Unterminated string", ...span(1, 0, 1, 4) });
    expect(lexError("'abc\\")).toEqual({ msg: "Unterminated string", ...span(1, 0, 1, 5) });
  });

  it("decodes \\u from the next four word characters, as @dbml/parse does", () => {
    // `parseInt` decodes what it can: up to the first non-hex character.
    expect(value("'\\u12g4'")).toBe("\u0012");
    expect(value("'\\uzzzz'")).toBe("\0");
  });

  it("rejects a unicode escape cut short", () => {
    expect(lexError(String.raw`'a\u12'`)).toEqual({
      msg: 'Invalid unicode escape sequence "\\u12": expected \\u followed by four hexadecimal digits',
      ...span(1, 2, 1, 6),
    });
    expect(lexError(String.raw`'\u-'`).msg).toBe(
      'Invalid unicode escape sequence "\\u": expected \\u followed by four hexadecimal digits',
    );
  });
});

describe("multi-line strings", () => {
  it("lexes a block string as its own token type, spanning the quotes", () => {
    expect(only("'''abc'''")).toEqual({ type: "blockString", value: "abc", position: span(1, 0, 1, 9) });
    expect(only("'''\n  a\n'''").position).toEqual(span(1, 0, 3, 3));
  });

  it("keeps the decoded body as written, leaving the dedent to note values", () => {
    // `@dbml/core` dedents notes only; a `'''` default keeps its indentation.
    expect(value("'''\n    a\n      b\n    '''")).toBe("\n    a\n      b\n    ");
  });

  it("decodes escapes", () => {
    expect(value(String.raw`'''\n  a\t'''`)).toBe("\n  a\t");
    expect(value("'''it\\'s\\''''")).toBe("it's'");
    expect(value("'''a\\\n  b'''")).toBe("a  b");
  });

  it("keeps single and double quotes inside", () => {
    expect(value("'''say 'hi' and ''twice'' \"ok\"'''")).toBe("say 'hi' and ''twice'' \"ok\"");
  });

  it("lexes the empty block string", () => {
    expect(only("''''''")).toEqual({ type: "blockString", value: "", position: span(1, 0, 1, 6) });
  });

  it("keeps a CRLF file's carriage returns, as @dbml/core does", () => {
    expect(value("'''\r\n    a\r\n    '''")).toBe("\r\n    a\r\n    ");
  });

  it("rejects an unterminated block string", () => {
    expect(lexError("'''abc\n  def''")).toEqual({ msg: "Unterminated multi-line string", ...span(1, 0, 2, 7) });
  });
});

describe("dedentNote", () => {
  // The value of a note written as `src`, as `@dbml/core` reads it.
  const note = (src: string): string => dedentNote(value(src));

  it("drops the leading blank lines and strips the smallest indentation", () => {
    expect(note("'''\n    first\n      second\n    third'''")).toBe("first\n  second\nthird");
  });

  it("keeps a trailing whitespace-only line as a final newline", () => {
    // The closing quotes on their own indented line leave a trailing "\n".
    expect(note("'''\n    a\n      b\n    '''")).toBe("a\n  b\n");
    expect(note("'''\n  a\n \t'''")).toBe("a\n");
    // With no indentation left, the last line is empty all the same.
    expect(note("'''\nline\n'''")).toBe("line\n");
  });

  it("ignores blank lines when measuring the indentation, and shortens them", () => {
    expect(note("'''\n    a\n\n  \n    b'''")).toBe("a\n\n\nb");
    expect(note("'''\n  a\n        \n  b'''")).toBe("a\n      \nb");
  });

  it("counts tabs as indentation", () => {
    expect(note("'''\n\t\ta\n\tb'''")).toBe("\ta\nb");
  });

  it("keeps the first line when it has content", () => {
    expect(note("'''  a\n  b'''")).toBe("a\nb");
    expect(note("'''a\n    b'''")).toBe("a\n    b");
  });

  it("keeps only the last line of a text with no content", () => {
    expect(note("'''  \n   '''")).toBe("   ");
    expect(note("''''''")).toBe("");
  });

  it("dedents after decoding escapes", () => {
    expect(note(String.raw`'''\n  a\n  b'''`)).toBe("a\nb");
  });

  it("strips the leading whitespace of a single-quoted note", () => {
    expect(note("'   abc'")).toBe("abc");
  });

  it("keeps a CRLF file's carriage returns", () => {
    expect(note("'''\r\n    a\r\n    '''")).toBe("a\r\n");
  });
});

describe("quoted identifiers", () => {
  it("lexes a quoted identifier, spanning its quotes", () => {
    expect(only('"order items"')).toEqual({ type: "qident", value: "order items", position: span(1, 0, 1, 13) });
  });

  it("decodes escapes", () => {
    expect(value('"a\\"b\\\\c\\n\\u0041"')).toBe('a"b\\c\nA');
  });

  it("keeps the case and keyword spelling", () => {
    expect(kinds('"Table" "NOTE"', dbmlParseLexer)).toEqual(["qident:Table", "qident:NOTE"]);
  });

  it("rejects a quoted identifier that runs off the line or the input", () => {
    expect(lexError('"a\nb"')).toEqual({ msg: "Unterminated quoted identifier", ...span(1, 0, 1, 2) });
    expect(lexError('"ab')).toEqual({ msg: "Unterminated quoted identifier", ...span(1, 0, 1, 3) });
  });
});

describe("backtick expressions", () => {
  it("keeps the body raw and spans the backticks", () => {
    expect(only("`now()`")).toEqual({ type: "expression", value: "now()", position: span(1, 0, 1, 7) });
    expect(value(String.raw`${"`"}a\nb \' c${"`"}`)).toBe(String.raw`a\nb \' c`);
  });

  it("may span lines", () => {
    expect(only("`a >\n  b`")).toEqual({ type: "expression", value: "a >\n  b", position: span(1, 0, 2, 4) });
  });

  it("keeps quotes inside", () => {
    expect(value("`lower(\"name\") || 'x'`")).toBe("lower(\"name\") || 'x'");
  });

  it("rejects an unterminated expression", () => {
    expect(lexError("`abc\ndef")).toEqual({ msg: "Unterminated expression", ...span(1, 0, 2, 3) });
  });
});

describe("colors", () => {
  it("lexes a color with its #", () => {
    expect(only("#3498DB")).toEqual({ type: "color", value: "#3498DB", position: span(1, 0, 1, 7) });
    expect(kinds("[headercolor: #fff]")).toEqual(["punc:[", "ident:headercolor", "punc::", "color:#fff", "punc:]"]);
  });

  it("leaves colour validation to later stages", () => {
    expect(value("#zz9")).toBe("#zz9");
    expect(kinds("# ]")).toEqual(["color:#", "punc:]"]);
  });
});

describe("punctuation", () => {
  it("lexes every punctuation mark", () => {
    expect(kinds("{ } [ ] ( ) , : . ~ < > - <> ? *")).toEqual([
      "punc:{",
      "punc:}",
      "punc:[",
      "punc:]",
      "punc:(",
      "punc:)",
      "punc:,",
      "punc::",
      "punc:.",
      "punc:~",
      "punc:<",
      "punc:>",
      "punc:-",
      "punc:<>",
      "punc:?",
      "punc:*",
    ]);
    expect(kinds("+")).toEqual(["punc:+"]);
  });

  it("takes <> as one token and leaves optional markers separate, for the grammar to join", () => {
    expect(kinds("a.b<>c.d")).toEqual(["ident:a", "punc:.", "ident:b", "punc:<>", "ident:c", "punc:.", "ident:d"]);
    expect(kinds("?<>? >? ?-")).toEqual(["punc:?", "punc:<>", "punc:?", "punc:>", "punc:?", "punc:?", "punc:-"]);
  });

  it("rejects characters DBML has no use for", () => {
    expect(lexError("id int;")).toEqual({ msg: 'Unexpected character ";"', ...span(1, 6, 1, 7) });
    expect(lexError("a = b").msg).toBe('Unexpected character "="');
    expect(lexError("a / b")).toEqual({ msg: 'Unexpected character "/"', ...span(1, 2, 1, 3) });
    expect(lexError("a <= b").msg).toBe('Unexpected character "="');
    expect(lexError("a != b").msg).toBe('Unexpected character "!"');
    expect(lexError("a % b").msg).toBe('Unexpected character "%"');
    expect(lexError("a & b").msg).toBe('Unexpected character "&"');
    expect(lexError("a | b").msg).toBe('Unexpected character "|"');
  });

  it("does not lex front matter specially", () => {
    expect(kinds("---\nk: v\n---\n")).toEqual([
      "punc:-",
      "punc:-",
      "punc:-",
      "punc:⏎",
      "ident:k",
      "punc::",
      "ident:v",
      "punc:⏎",
      "punc:-",
      "punc:-",
      "punc:-",
      "punc:⏎",
    ]);
  });

  it("has no arrow tokens", () => {
    expect(kinds("a -> b <- c")).toEqual(["ident:a", "punc:-", "punc:>", "ident:b", "punc:<", "punc:-", "ident:c"]);
  });
});

describe("newlines", () => {
  it("lexes a newline as a token inside braces and at the top level", () => {
    expect(kinds("Table t {\n  id int\n}\n")).toEqual([
      "ident:Table",
      "ident:t",
      "punc:{",
      "punc:⏎",
      "ident:id",
      "ident:int",
      "punc:⏎",
      "punc:}",
      "punc:⏎",
    ]);
  });

  it("treats a newline inside brackets as whitespace", () => {
    expect(kinds("[pk,\n  note: 'x'\n]")).toEqual([
      "punc:[",
      "ident:pk",
      "punc:,",
      "ident:note",
      "punc::",
      "string:x",
      "punc:]",
    ]);
  });

  it("treats a newline inside parentheses as whitespace", () => {
    expect(kinds("t.(\n  a,\n  b\n)\n")).toEqual([
      "ident:t",
      "punc:.",
      "punc:(",
      "ident:a",
      "punc:,",
      "ident:b",
      "punc:)",
      "punc:⏎",
    ]);
  });

  it("nests brackets and goes back to newline tokens once they all close", () => {
    expect(kinds("(a [\nasc\n], b)\nc")).toEqual([
      "punc:(",
      "ident:a",
      "punc:[",
      "ident:asc",
      "punc:]",
      "punc:,",
      "ident:b",
      "punc:)",
      "punc:⏎",
      "ident:c",
    ]);
  });

  it("keeps newline tokens in a braced body after a bracket list", () => {
    expect(kinds("{\nid int [pk]\nname text\n}")).toEqual([
      "punc:{",
      "punc:⏎",
      "ident:id",
      "ident:int",
      "punc:[",
      "ident:pk",
      "punc:]",
      "punc:⏎",
      "ident:name",
      "ident:text",
      "punc:⏎",
      "punc:}",
    ]);
  });

  it("ignores a stray closer at the top level", () => {
    expect(kinds("]\na")).toEqual(["punc:]", "punc:⏎", "ident:a"]);
  });

  it("leaves one bracket level per closer, whichever opener it closes", () => {
    expect(kinds("[(]\na\n)\nb")).toEqual(["punc:[", "punc:(", "punc:]", "ident:a", "punc:)", "punc:⏎", "ident:b"]);
  });

  it("leaves the inline mode at a brace, so an unclosed bracket stops there", () => {
    expect(kinds("Table t [note: 'x' {\nid int\n}\n")).toEqual([
      "ident:Table",
      "ident:t",
      "punc:[",
      "ident:note",
      "punc::",
      "string:x",
      "punc:{",
      "punc:⏎",
      "ident:id",
      "ident:int",
      "punc:⏎",
      "punc:}",
      "punc:⏎",
    ]);
    expect(kinds("(a\n}\nb")).toEqual(["punc:(", "ident:a", "punc:}", "punc:⏎", "ident:b"]);
    // Each brace leaves one level: with two open, the second brace restores newlines.
    expect(kinds("[(a {\nb\n}\nc")).toEqual([
      "punc:[",
      "punc:(",
      "ident:a",
      "punc:{",
      "ident:b",
      "punc:}",
      "punc:⏎",
      "ident:c",
    ]);
  });

  it("does not change mode for brackets inside strings, expressions or comments", () => {
    expect(kinds("'[' \"(\" `(` // [\nb")).toEqual([
      "string:[",
      "qident:(",
      "expression:(",
      "comment: [",
      "punc:⏎",
      "ident:b",
    ]);
    expect(kinds("/* ( */\nb")).toEqual(["comment: ( ", "punc:⏎", "ident:b"]);
  });

  it("treats a carriage return as whitespace inside brackets too", () => {
    expect(kinds("[pk,\r\n  unique\r\n]\r\n")).toEqual([
      "punc:[",
      "ident:pk",
      "punc:,",
      "ident:unique",
      "punc:]",
      "punc:⏎",
    ]);
  });

  it("treats a carriage return as whitespace, so CRLF lexes like LF", () => {
    const crlf = "Table t {\r\n  id int [\r\n    pk\r\n  ]\r\n}\r\n";
    expect(kinds(crlf)).toEqual(kinds(crlf.replaceAll("\r\n", "\n")));
    expect(tokens("a\r\nb")[1]!.position).toEqual(span(1, 2, 2, 0));
  });

  it("spans a newline token", () => {
    expect(tokens("a\nb")[1]!.position).toEqual(span(1, 1, 2, 0));
  });
});

describe("comments", () => {
  it("emits line and block comments between tokens", () => {
    expect(kinds("a // note\nb /* x\ny */ c")).toEqual([
      "ident:a",
      "comment: note",
      "punc:⏎",
      "ident:b",
      "comment: x\ny ",
      "ident:c",
    ]);
  });

  it("ends a line comment at the end of input", () => {
    expect(only("// last")).toEqual({ type: "comment", value: " last", position: span(1, 0, 1, 7) });
  });

  it("ends a line comment before a CRLF's carriage return", () => {
    expect(kinds("a // x\r\nb")).toEqual(["ident:a", "comment: x", "punc:⏎", "ident:b"]);
    expect(tokens("a // x\r\nb")[1]!.position).toEqual(span(1, 2, 1, 6));
  });

  it("lexes comments inside brackets", () => {
    expect(kinds("[pk, // primary\n note: 'x' /* n */]")).toEqual([
      "punc:[",
      "ident:pk",
      "punc:,",
      "comment: primary",
      "ident:note",
      "punc::",
      "string:x",
      "comment: n ",
      "punc:]",
    ]);
  });

  it("spans a comment from its opening delimiter", () => {
    expect(tokens("x /* a */")[1]!.position).toEqual(span(1, 2, 1, 9));
    expect(tokens("// a\n")[0]!.position).toEqual(span(1, 0, 1, 4));
  });

  it("does not start a comment inside a string or an expression", () => {
    expect(kinds("'// no' `/* no */`")).toEqual(["string:// no", "expression:/* no */"]);
  });

  it("rejects an unterminated block comment", () => {
    expect(lexError("a /* b\nc")).toEqual({ msg: "Unterminated comment", ...span(1, 2, 2, 1) });
  });
});

describe("dbmlParseLexer", () => {
  it("drops comments", () => {
    expect(kinds("a // x\nb /* y */ c", dbmlParseLexer)).toEqual(["ident:a", "punc:⏎", "ident:b", "ident:c"]);
  });

  it("reaches the end of input past a trailing comment", () => {
    const stream = dbmlParseLexer.tokenize(createInputStream("a // x"));
    expect(stream.next()?.value).toBe("a");
    expect(stream.eof()).toBe(true);
    expect(stream.peek()).toBeNull();
  });

  it("folds identifiers to lowercase and keeps the raw names", () => {
    const parsed = tokens("TABLE Users bảng ẞig 2FA", dbmlParseLexer);
    expect(parsed.map((token) => token.value)).toEqual(["table", "users", "bảng", "ßig", "2fa"]);
    expect(parsed.map(rawName)).toEqual(["TABLE", "Users", "bảng", "ẞig", "2FA"]);
  });

  it("gives the value of every other token as its raw name", () => {
    const parsed = tokens(`"Order Items" 'Str' \`Now()\` #ABC 1E5 {`, dbmlParseLexer);
    expect(parsed.map(rawName)).toEqual(["Order Items", "Str", "Now()", "#ABC", "1E5", "{"]);
  });

  it("keeps the folded token's span", () => {
    const [table] = tokens("  Table", dbmlParseLexer);
    expect(table).toEqual({ type: "ident", value: "table", position: span(1, 2, 1, 7) });
  });

  it("returns the same folded token from repeated peeks", () => {
    const stream = dbmlParseLexer.tokenize(createInputStream("/* c */ Table t"));
    const peeked = stream.peek();
    expect(stream.peek()).toBe(peeked);
    expect(stream.next()).toBe(peeked);
    expect(rawName(peeked!)).toBe("Table");
    expect(stream.next()?.value).toBe("t");
    expect(stream.eof()).toBe(true);
    expect(stream.next()).toBeNull();
  });

  it("surfaces lexer errors", () => {
    const stream = dbmlParseLexer.tokenize(createInputStream("a 'b"));
    expect(stream.next()?.value).toBe("a");
    expect(() => stream.peek()).toThrow(ParseError);
  });

  it("shares the lexer's labels", () => {
    expect(dbmlParseLexer.labels).toBe(dbmlLexer.labels);
    expect(dbmlLexer.labels).toMatchObject({
      ident: "an identifier",
      qident: "a quoted identifier",
      string: "a string",
      blockString: "a multi-line string",
      expression: "an expression",
      number: "a number",
      color: "a color",
      punc: "punctuation",
      comment: "a comment",
    });
  });
});

describe("a realistic document", () => {
  it("lexes a table with settings, notes and a ref", () => {
    const source = [
      "Table public.users as U [headercolor: #3498DB] {",
      "  id integer [pk, increment] // the key",
      "  \"full name\" varchar(255) [not null, note: 'Shown as is']",
      "  created_at timestamp [default: `now()`]",
      "  Note: '''",
      "    Users of the app.",
      "  '''",
      "}",
      "Ref: U.id < posts.(author_id, editor_id)",
    ].join("\r\n");
    expect(kinds(source, dbmlParseLexer)).toEqual([
      "ident:table",
      "ident:public",
      "punc:.",
      "ident:users",
      "ident:as",
      "ident:u",
      "punc:[",
      "ident:headercolor",
      "punc::",
      "color:#3498DB",
      "punc:]",
      "punc:{",
      "punc:⏎",
      "ident:id",
      "ident:integer",
      "punc:[",
      "ident:pk",
      "punc:,",
      "ident:increment",
      "punc:]",
      "punc:⏎",
      "qident:full name",
      "ident:varchar",
      "punc:(",
      "number:255",
      "punc:)",
      "punc:[",
      "ident:not",
      "ident:null",
      "punc:,",
      "ident:note",
      "punc::",
      "string:Shown as is",
      "punc:]",
      "punc:⏎",
      "ident:created_at",
      "ident:timestamp",
      "punc:[",
      "ident:default",
      "punc::",
      "expression:now()",
      "punc:]",
      "punc:⏎",
      "ident:note",
      "punc::",
      "blockString:\r\n    Users of the app.\r\n  ",
      "punc:⏎",
      "punc:}",
      "punc:⏎",
      "ident:ref",
      "punc::",
      "ident:u",
      "punc:.",
      "ident:id",
      "punc:<",
      "ident:posts",
      "punc:.",
      "punc:(",
      "ident:author_id",
      "punc:,",
      "ident:editor_id",
      "punc:)",
    ]);
    // Positions keep counting correctly after the multi-line string and the CRLFs.
    const all = tokens(source, dbmlParseLexer);
    expect(all.find((token) => token.type === "blockString")?.position).toEqual(span(5, 8, 7, 5));
    expect(all.find((token) => token.value === "posts")?.position).toEqual(span(9, 12, 9, 17));
  });
});
