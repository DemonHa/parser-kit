import { defineLexer, type InputStream, type Position, type Reader, readers } from "@parser-kit/core";

// SQL-lite is the PostgreSQL-flavoured counterpart to js-lite: it exercises the
// reader and keyword machinery DBML doesn't touch. Identifiers fold to
// lowercase (so grammar-side keyword matching is exact-value matching and
// unreserved words stay usable as names), quoted identifiers are case-preserved,
// and the operator reader coexists with the punctuation trie by partitioning the
// character space — `::`/`:`/`,`/`(`/`)`/`[`/`]`/`;`/`.` stay trie-lexed while
// `||`/`@>`/`<=`/… are read as operators.
export type SqlTokenType =
  | "ident"
  | "qident"
  | "string"
  | "bitstring"
  | "hexstring"
  | "number"
  | "op"
  | "punc"
  | "comment"
  | "param";

// --- PG's letter-prefixed literals ---
// `B'1011'`, `X'ff'` and `U&'\0041'` all begin with a letter, so each owns a
// reader that restores the stream and returns null when no quote follows the
// prefix — the same fall-through the E-string reader uses to keep `end` and
// `explain` identifiers, and what keeps `b`, `x` and `u` usable as plain names.

// Shared with `sqlLexer`'s own `whitespace` below rather than copied: a second
// literal would let the two drift, and `readUescapeTail` would then stop
// matching across a character the lexer still skips. Sharing one RegExp is only
// safe while it carries no `g`/`y` flag — both consumers call `.test()`, which
// is stateless without one and would otherwise desync through `lastIndex`.
const WHITESPACE = /[ \t\r\n]/;
const isHexDigit = (char: string) => /[0-9A-Fa-f]/.test(char);
const isBinaryDigit = (char: string) => /[01]/.test(char);
const isSpace = (char: string) => WHITESPACE.test(char);

// Scan a `'…'` body with the cursor on the opening quote, leaving it past the
// closing one. `doubling` collapses `''` to a single quote (PG's rule for the
// unicode form; a bit-string body has no escapes at all). The returned span
// covers the body, not the quotes, exactly as the shared string reader's does.
// Running off the end stays lenient there too — it reports `terminated: false`
// rather than croaking, so an unterminated literal here fails the same way an
// unterminated `'…'` does, at the `;` the parser never reaches. That flag is
// the reason this isn't `readers.string`'s body scan, which is otherwise
// byte-for-byte equivalent: EOF alone can't stand in for it, since a properly
// closed literal at the end of input leaves the stream at EOF as well.
const readQuotedBody = (stream: InputStream, doubling: boolean) => {
  stream.next(); // opening quote
  const start = stream.position();
  let value = "";
  while (!stream.eof()) {
    if (stream.peek() === "'") {
      const end = stream.position();
      stream.next(); // the terminator — or, with doubling, the first of a pair
      if (!doubling || stream.peek() !== "'") return { value, start, end, terminated: true };
      stream.next();
      value += "'";
      continue;
    }
    value += stream.next();
  }
  return { value, start, end: stream.position(), terminated: false };
};

// `B'1011'` / `X'ff'` — PG's bit-string constants. A digit outside the base is
// rejected here because PG rejects it in its scanner too: no later stage can
// make anything of `B'12'`, and the alternative is a bit string that silently
// isn't one.
const bitStringReader = (opts: {
  type: SqlTokenType;
  startsWith: string;
  isDigit: (char: string) => boolean;
  display: string;
  invalid: string;
}): Reader<SqlTokenType> =>
  readers.custom(opts.type, {
    startsWith: opts.startsWith,
    display: opts.display,
    read: (stream) => {
      const tokenStart = stream.position();
      stream.snapshot();
      stream.next(); // the prefix letter
      if (stream.peek() !== "'") {
        stream.reload(); // a `b` / `x` with no quote after it is an identifier
        return null;
      }
      const { value, start, end, terminated } = readQuotedBody(stream, false);
      // Only a literal that actually closed is checked: an unterminated one has
      // swallowed the rest of the input, so every character after the missing
      // quote is "not a digit" and the croak would blame the wrong thing.
      const bad = terminated ? [...value].find((char) => !opts.isDigit(char)) : undefined;
      if (bad !== undefined) stream.croak(`${opts.invalid} "${bad}"`, tokenStart, stream.position());
      return { value, start, end };
    },
  });

// The `UESCAPE 'c'` tail, read with the cursor just past a unicode literal's
// closing quote. A word that isn't UESCAPE, or one with no quoted character
// after it, restores the cursor and leaves those tokens to the parser — so
// `SELECT U&'\0041' uescape FROM t` still reads `uescape` as a column alias.
// `skipSpace` uses this lexer's whitespace class rather than PG's wider one, so
// a comment between the two declines the tail; that is what a comment does
// anywhere inside a statement here (they are trivia only between statements),
// so it is no new hazard.
const readUescapeTail = (stream: InputStream): string | null => {
  const skipSpace = () => {
    while (isSpace(stream.peek())) stream.next();
  };
  // `InputStream` has a single snapshot slot, so this clobbers the caller's —
  // safe only because the caller took it before `U` and is past every path that
  // could reload it by the time the literal is ours.
  stream.snapshot();
  skipSpace();
  for (const char of "uescape") {
    if (stream.peek().toLowerCase() !== char) {
      stream.reload();
      return null;
    }
    stream.next();
  }
  skipSpace();
  if (stream.peek() !== "'") {
    stream.reload();
    return null;
  }
  // The tail is committed from here: no path below restores the cursor.
  const start = stream.position();
  // Read the whole `'…'`, not one character, so that a croak below resumes
  // *past* it. Croaking with the closing quote unconsumed would leave it to
  // open a runaway string and swallow the rest of the file.
  const { value: escapeChar, terminated } = readQuotedBody(stream, true);
  // PG's check_uescapechar: exactly one character, and not one that could be
  // part of an escape it introduces (a hex digit or `+`), a quote, or space.
  // `terminated` is part of the test, not an afterthought: without it a
  // truncated `UESCAPE '!` whose body happens to be one legal character would
  // pass, silently changing what the literal ahead of it decodes to.
  if (
    !terminated ||
    escapeChar.length !== 1 ||
    isHexDigit(escapeChar) ||
    "+'\"".includes(escapeChar) ||
    isSpace(escapeChar)
  ) {
    stream.croak("Invalid Unicode escape character", start, stream.position());
  }
  return escapeChar;
};

// PG's two escape shapes — `\XXXX` and `\+XXXXXX` — plus a doubled escape
// character standing for a literal one.
const decodeUnicodeEscapes = (stream: InputStream, raw: string, escapeChar: string, start: Position): string => {
  const invalidValue = (): never => stream.croak("Invalid Unicode escape value", start, stream.position());
  const invalidPair = (): never => stream.croak("Invalid Unicode surrogate pair", start, stream.position());
  let value = "";
  let index = 0;
  // PG rejects an unpaired surrogate instead of letting it through, and so does
  // this: a lone one would reach the AST as a JS string that is not valid
  // Unicode text. A well-formed pair needs no assembly — JS strings are UTF-16,
  // so its two code units compose into the astral character on their own.
  let pendingHigh = false;
  while (index < raw.length) {
    if (raw[index] !== escapeChar) {
      if (pendingHigh) invalidPair();
      value += raw[index]!;
      index += 1;
      continue;
    }
    if (raw[index + 1] === escapeChar) {
      if (pendingHigh) invalidPair();
      value += escapeChar;
      index += 2;
      continue;
    }
    const long = raw[index + 1] === "+";
    const from = index + (long ? 2 : 1);
    const width = long ? 6 : 4;
    const digits = raw.slice(from, from + width);
    if (digits.length < width || ![...digits].every(isHexDigit)) invalidValue();
    const code = Number.parseInt(digits, 16);
    // PG's is_valid_unicode_codepoint — zero is not a valid escape either.
    if (code === 0 || code > 0x10ffff) invalidValue();
    // A high surrogate must be followed by a low one, and a low one may only
    // follow a high one.
    if (pendingHigh !== (code >= 0xdc00 && code <= 0xdfff)) invalidPair();
    pendingHigh = code >= 0xd800 && code <= 0xdbff;
    value += String.fromCodePoint(code);
    index = from + width;
  }
  if (pendingHigh) invalidPair();
  return value;
};

// `U&'\0041' [UESCAPE 'c']`. PG decodes these in its scanner and so does this
// reader: the result is an ordinary `string` token, so a unicode literal is
// usable everywhere a plain one is — enum labels, `COMMENT ON … IS`, DEFAULTs —
// with no grammar surface at all. The UESCAPE tail belongs to the reader for
// the same reason it belongs to PG's scanner: it chooses the escape character,
// so nothing can be decoded until we know whether it is there. No `display`:
// labels are first-wins per token type and `"a string"` is already registered.
const unicodeStringReader: Reader<SqlTokenType> = readers.custom("string", {
  startsWith: "Uu",
  read: (stream) => {
    const tokenStart = stream.position();
    stream.snapshot();
    stream.next(); // `U`
    // Neither `U&"…"` — a unicode-escaped *identifier*, out of scope — nor a
    // bare `u` is ours. Both restore and lex as they did before: `u`, `&`, and
    // whatever followed.
    if (stream.peek() !== "&") {
      stream.reload();
      return null;
    }
    stream.next(); // `&`
    if (stream.peek() !== "'") {
      stream.reload();
      return null;
    }
    const { value: raw, start, end } = readQuotedBody(stream, true);
    const escapeChar = readUescapeTail(stream);
    return {
      value: decodeUnicodeEscapes(stream, raw, escapeChar ?? "\\", tokenStart),
      start,
      // Body start through the end of whatever the literal consumed. With no
      // tail that is the usual body span; with one it deliberately runs past
      // the body's closing quote, so it is no longer a quotable slice of the
      // source — the trade is that an enclosing node's `spanFrom` reaches the
      // end of the text the literal took, instead of stopping 12 characters
      // short of it. Nothing here slices source by span; errors point with it.
      end: escapeChar === null ? end : stream.position(),
    };
  },
});

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
    // The other letter-prefixed literals (see above). Bit strings keep a token
    // type of their own — they are `bit` constants, not text — while a unicode
    // literal decodes to a plain string.
    bitStringReader({
      type: "bitstring",
      startsWith: "Bb",
      isDigit: isBinaryDigit,
      display: "a bit string",
      invalid: "Invalid binary digit",
    }),
    bitStringReader({
      type: "hexstring",
      startsWith: "Xx",
      isDigit: isHexDigit,
      display: "a hex string",
      invalid: "Invalid hexadecimal digit",
    }),
    unicodeStringReader,
    // Quoted identifiers: case-preserved (no fold), doubled `""` is one quote.
    readers.string("qident", { quote: '"', escape: { doubling: true }, display: "a quoted identifier" }),
    readers.dollarString("string"),
    // Positional / named parameters (`$1`, `$name`). Must follow the dollar-string
    // reader: `$tag$…$tag$` is claimed there first, and only a `$` that is *not* a
    // dollar-string opener (no `$` closes the tag) falls through to here. `$` is
    // neither an operator char nor an identifier start, so nothing else competes.
    readers.custom("param", {
      startsWith: "$",
      display: "a parameter",
      read: (stream) => {
        stream.snapshot();
        stream.next(); // opening `$`
        let name = "";
        if (/[0-9]/.test(stream.peek())) {
          while (/[0-9]/.test(stream.peek())) name += stream.next();
        } else if (/[A-Za-z_]/.test(stream.peek())) {
          while (/[A-Za-z0-9_]/.test(stream.peek())) name += stream.next();
        }
        // A bare `$` (no digits/name) isn't a parameter — restore and fall through
        // so the lexer reports it as an unexpected character, matching PG.
        if (name === "") {
          stream.reload();
          return null;
        }
        return name;
      },
    }),
    // Comment readers must precede the operator reader: `stopAt` then guarantees
    // an operator scan never swallows a comment start (`@--x` → `@`, then `--x`).
    readers.lineComment("comment", "--", { display: "a comment" }),
    readers.blockComment("comment", "/*", "*/", { nested: true }),
    readers.operator("op", { display: "an operator" }),
  ],
  trivia: ["comment"],
  // SQL is newline-insensitive: newlines are ordinary whitespace.
  whitespace: WHITESPACE,
});
