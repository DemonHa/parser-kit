import { defineLexer, readers } from "@parser-kit/core";

// JS-lite exercises the lexer config DBML doesn't: newlines are plain
// whitespace (DBML lexes them as punctuation), keywords are case-sensitive,
// and `/` is both a comment prefix and an operator (reader order decides).
export const jsLexer = defineLexer({
  keywords: {
    type: "kw",
    words: ["const", "let", "function", "if", "else", "while", "return", "true", "false", "null"],
    display: "a keyword",
  },
  punctuation: {
    type: "punc",
    tokens: [
      "(",
      ")",
      "{",
      "}",
      "[",
      "]",
      ";",
      ",",
      ".",
      "+",
      "-",
      "*",
      "/",
      "%",
      "!",
      "<",
      ">",
      "<=",
      ">=",
      "==",
      "!=",
      "===",
      "!==",
      "&&",
      "||",
      "=",
      "=>",
      "?",
      ":",
    ],
    display: "a symbol",
  },
  identifier: { type: "ident", start: /[A-Za-z_$]/, part: /[A-Za-z0-9_$]/, display: "an identifier" },
  readers: [
    readers.number("number", { display: "a number" }),
    readers.string("string", { quote: "'", display: "a string" }),
    readers.string("string", { quote: '"' }),
    readers.lineComment("comment", "//", { display: "a comment" }),
    readers.blockComment("comment", "/*", "*/"),
  ],
  whitespace: /[ \t\r\n]/,
});

export type JsTokenType = "kw" | "punc" | "ident" | "number" | "string" | "comment";
