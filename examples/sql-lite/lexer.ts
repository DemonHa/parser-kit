import { defineLexer, readers } from "../../src/index";

// SQL-lite is the PostgreSQL-flavoured counterpart to js-lite: it exercises the
// reader and keyword machinery DBML doesn't touch. Identifiers fold to
// lowercase (so grammar-side keyword matching is exact-value matching and
// unreserved words stay usable as names), quoted identifiers are case-preserved,
// and the operator reader coexists with the punctuation trie by partitioning the
// character space — `::`/`:`/`,`/`(`/`)`/`[`/`]`/`;`/`.` stay trie-lexed while
// `||`/`@>`/`<=`/… are read as operators.
export type SqlTokenType = "ident" | "qident" | "string" | "number" | "op" | "punc" | "comment";

export const sqlLexer = defineLexer({
  identifier: {
    type: "ident",
    start: /[A-Za-z_]/,
    part: /[A-Za-z0-9_$]/,
    display: "an identifier",
    // PG folds unquoted identifiers to lowercase; the raw text stays in the span.
    fold: "lower",
  },
  punctuation: {
    // No character here overlaps the operator reader's `chars`, so `::` reads as
    // one cast token right next to a `||` or `@>` operator with no precedence
    // machinery — the partition alone keeps them apart.
    type: "punc",
    tokens: ["(", ")", "[", "]", ",", ";", ".", "::", ":"],
    display: "punctuation",
  },
  readers: [
    readers.number("number", {
      exponent: true,
      leadingDot: true,
      radix: { hex: true },
      separators: true,
      display: "a number",
    }),
    // Standard strings double their quote; E-strings decode backslash escapes.
    // Both are type "string"; the E reader owns its own `startsWith` and falls
    // through (reload + null) when the quote doesn't follow, so `end` and
    // `explain` still lex as identifiers.
    readers.string("string", { quote: "'", escape: { doubling: true }, display: "a string" }),
    readers.string("string", { quote: "'", prefix: "E", escape: { doubling: true, backslash: true } }),
    // Quoted identifiers: case-preserved (no fold), doubled `""` is one quote.
    readers.string("qident", { quote: '"', escape: { doubling: true }, display: "a quoted identifier" }),
    readers.dollarString("string"),
    // Comment readers must precede the operator reader: `stopAt` then guarantees
    // an operator scan never swallows a comment start (`@--x` → `@`, then `--x`).
    readers.lineComment("comment", "--", { display: "a comment" }),
    readers.blockComment("comment", "/*", "*/", { nested: true }),
    readers.operator("op", { display: "an operator" }),
  ],
  trivia: ["comment"],
  // SQL is newline-insensitive: newlines are ordinary whitespace.
  whitespace: /[ \t\r\n]/,
});
