import { defineLexer, type InputStream, type Lexer, type Position, type Reader, readers } from "@parser-kit/core";

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

// --- Quoted literals ---
// PG reads every quoted form in its scanner (scan.l), and so does this file:
// sql-lite owns its `'…'`, `E'…'`, `"…"`, `B'…'`, `X'…'` and `U&` readers rather
// than borrowing core's `readers.string`, which is lenient where PG is not —
// it lets an unterminated literal run to the end of input, and knows only the
// `{n,t,r,b,f}` backslash escapes. Running off the end croaks here, as it does
// in PG: anything else would turn `SELECT 'abc FROM t` into one string.
//
// The letter-prefixed forms (`E'…'`, `B'…'`, `X'…'`, `U&'…'`, `U&"…"`) all begin
// with a letter, so each reader restores the stream and returns null when no
// quote follows the prefix — that fall-through is what keeps `e`, `b`, `x`,
// `u`, `end` and `explain` usable as plain names.

// PG's `space` class, `\f` and `\v` included. Shared with `sqlLexer`'s own
// `whitespace` below rather than copied: a second literal would let the two
// drift, and `readUescapeTail` would then stop matching across a character the
// lexer still skips. Sharing one RegExp is only safe while it carries no
// `g`/`y` flag — every consumer calls `.test()`, which is stateless without one
// and would otherwise desync through `lastIndex`.
const WHITESPACE = /[ \t\r\n\f\v]/;
const isHexDigit = (char: string) => /[0-9A-Fa-f]/.test(char);
const isBinaryDigit = (char: string) => /[01]/.test(char);
const isOctalDigit = (char: string) => char >= "0" && char <= "7";
const isSpace = (char: string) => WHITESPACE.test(char);
const isNewline = (char: string) => char === "\n" || char === "\r";

// PG's {quotecontinue}, tried with the cursor just past a closing `'`: two
// string constants separated by whitespace that contains at least one newline
// are one constant (`'foo'` newline `'bar'` is `foobar`), and a `--` comment
// counts as whitespace there. On a match the cursor is left past the next
// opening quote; otherwise it is restored. It takes the stream's one snapshot
// slot, so callers only reach it once their own literal is committed.
const readQuoteContinuation = (stream: InputStream): boolean => {
  const first = stream.peek();
  if (first !== "-" && !isSpace(first)) return false; // the common case: no snapshot
  stream.snapshot();
  let newline = false;
  for (;;) {
    const char = stream.peek();
    if (char === "-") {
      stream.next();
      // A lone `-` is an operator, so there is no continuation: `'a'⏎-'b'`
      // must not go on to the quote test below.
      if (stream.peek() !== "-") break;
      while (stream.peek() !== "" && !isNewline(stream.peek())) stream.next();
      continue;
    }
    if (!isSpace(char)) {
      if (newline && char === "'") {
        stream.next();
        return true;
      }
      break;
    }
    if (isNewline(char)) newline = true;
    stream.next();
  }
  stream.reload();
  return false;
};

interface QuotedForm {
  quote: "'" | '"';
  /** `''` (or `""`) inside the body is one quote character. */
  doubling: boolean;
  /** Whether {quotecontinue} applies; identifiers never continue. */
  continuation: boolean;
  /** PG's own message for running off the end. */
  unterminated: string;
}

const STRING: QuotedForm = {
  quote: "'",
  doubling: true,
  continuation: true,
  unterminated: "Unterminated quoted string",
};
const IDENTIFIER: QuotedForm = {
  quote: '"',
  doubling: true,
  continuation: false,
  unterminated: "Unterminated quoted identifier",
};
// A bit-string body has no escapes at all, so `B'1''0'` is two literals, as
// it is in PG.
const BIT_STRING: QuotedForm = {
  quote: "'",
  doubling: false,
  continuation: true,
  unterminated: "Unterminated bit string literal",
};
const HEX_STRING: QuotedForm = { ...BIT_STRING, unterminated: "Unterminated hexadecimal string literal" };
// The UESCAPE operand. One that never closes is reported as the bad escape
// character it is, the same message as any other the tail rejects.
const UESCAPE_CHAR: QuotedForm = { ...STRING, unterminated: "Invalid Unicode escape character" };

// Scan a quoted body with the cursor on the opening quote, leaving it past the
// closing one (past the last one, when continuations joined several). The
// returned span covers the body, not the quotes — from the first body's start
// to the last body's end. Every croak here runs to the end of input, so the
// stream is past the literal and recovery resumes after it.
const readQuotedBody = (stream: InputStream, form: QuotedForm, tokenStart: Position) => {
  stream.next(); // opening quote
  const start = stream.position();
  let value = "";
  for (;;) {
    const char = stream.peek();
    if (char === "") stream.croak(form.unterminated, tokenStart, stream.position());
    if (char !== form.quote) {
      value += stream.next();
      continue;
    }
    const end = stream.position();
    stream.next(); // the terminator — or, with doubling, the first of a pair
    if (form.doubling && stream.peek() === form.quote) {
      stream.next();
      value += form.quote;
      continue;
    }
    if (form.continuation && readQuoteContinuation(stream)) continue;
    return { value, start, end };
  }
};

// A double-quoted identifier, `"…"` or `U&"…"`. PG rejects the empty one in
// its scanner — there is no zero-length name to refer to.
const readIdentifierBody = (stream: InputStream, tokenStart: Position) => {
  const body = readQuotedBody(stream, IDENTIFIER, tokenStart);
  if (body.value === "") stream.croak("Zero-length delimited identifier", tokenStart, stream.position());
  return body;
};

// `B'1011'` / `X'ff'` — PG's bit-string constants. PG checks the digits later,
// in `bit_in`; checking here rejects `B'12'` just the same and points at the
// literal, and the alternative is a bit string that silently isn't one.
const bitStringReader = (opts: {
  type: SqlTokenType;
  startsWith: string;
  form: QuotedForm;
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
      const { value, start, end } = readQuotedBody(stream, opts.form, tokenStart);
      const bad = [...value].find((char) => !opts.isDigit(char));
      if (bad !== undefined) stream.croak(`${opts.invalid} "${bad}"`, tokenStart, stream.position());
      return { value, start, end };
    },
  });

// `E'…'`'s body, scanned raw: a backslash shields the character after it (so
// `\'` does not close the literal) and both stay in the text for
// `decodeEscapes`. Each continued constant is its own segment, because an
// escape sequence never spans the quotes between two of them.
const readEscapeBody = (stream: InputStream, tokenStart: Position) => {
  stream.next(); // opening quote
  const start = stream.position();
  const segments: string[] = [];
  let raw = "";
  for (;;) {
    const char = stream.peek();
    if (char === "") stream.croak(STRING.unterminated, tokenStart, stream.position());
    if (char === "\\") {
      raw += stream.next();
      if (!stream.eof()) raw += stream.next();
      continue;
    }
    if (char !== "'") {
      raw += stream.next();
      continue;
    }
    const end = stream.position();
    stream.next();
    if (stream.peek() === "'") {
      // Doubled, it is a quote character, kept raw as a lone `'`. The decoder
      // passes that through: a backslash in `raw` always has its partner
      // beside it, and no escape's digits can include a quote.
      stream.next();
      raw += "'";
      continue;
    }
    segments.push(raw);
    raw = "";
    if (readQuoteContinuation(stream)) continue;
    return { segments, start, end };
  }
};

const SINGLE_CHAR_ESCAPES: Record<string, string> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
let utf8: TextDecoder | undefined;

// Decode `E'…'` the way scan.l's `xe` state does. `\b \f \n \r \t \v` are
// control characters and any other escaped character stands for itself.
// `\ooo` (one to three octal digits) and `\xh[h]` are single *bytes*, so a run
// of them is assembled and read as UTF-8 — `E'\303\251'` is `é` — and a run
// that isn't valid UTF-8, or holds a NUL, is rejected as PG rejects it.
// `\uXXXX` and `\UXXXXXXXX` are code points, with UTF-16 surrogate pairs
// combined and unpaired halves rejected.
const decodeEscapes = (stream: InputStream, segments: readonly string[], start: Position): string => {
  // Most E-strings are a single segment with nothing to decode.
  if (segments.length === 1 && !segments[0]!.includes("\\")) return segments[0]!;
  const fail = (message: string): never => stream.croak(message, start, stream.position());
  let value = "";
  let bytes: number[] = [];
  let pendingHigh = 0;
  const flushBytes = () => {
    if (bytes.length === 0) return;
    if (bytes.includes(0)) fail('Invalid byte sequence for encoding "UTF8": 0x00');
    // `ignoreBOM`: a U+FEFF spelled in escapes is content, not a marker to strip.
    utf8 ??= new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    try {
      value += utf8.decode(new Uint8Array(bytes));
    } catch {
      fail('Invalid byte sequence for encoding "UTF8"');
    }
    bytes = [];
  };
  // Everything but a byte escape ends a byte run, and everything but the low
  // half ends a pending high surrogate.
  const append = (text: string) => {
    if (pendingHigh !== 0) fail("Invalid Unicode surrogate pair");
    flushBytes();
    value += text;
  };
  for (const raw of segments) {
    let index = 0;
    while (index < raw.length) {
      const slash = raw.indexOf("\\", index);
      if (slash === -1) {
        append(raw.slice(index));
        break;
      }
      if (slash > index) append(raw.slice(index, slash));
      const char = raw[slash + 1]!;
      index = slash + 2;
      if (char === "u" || char === "U") {
        const width = char === "u" ? 4 : 8;
        const digits = raw.slice(index, index + width);
        if (digits.length < width || ![...digits].every(isHexDigit)) {
          fail("Invalid Unicode escape: use \\uXXXX or \\UXXXXXXXX");
        }
        index += width;
        const code = Number.parseInt(digits, 16);
        if (pendingHigh !== 0) {
          if (code < 0xdc00 || code > 0xdfff) fail("Invalid Unicode surrogate pair");
          const pair = 0x10000 + ((pendingHigh - 0xd800) << 10) + (code - 0xdc00);
          pendingHigh = 0;
          append(String.fromCodePoint(pair));
        } else if (code >= 0xd800 && code <= 0xdbff) {
          flushBytes();
          pendingHigh = code;
        } else if (code >= 0xdc00 && code <= 0xdfff) {
          fail("Invalid Unicode surrogate pair");
        } else {
          // PG's is_valid_unicode_codepoint — zero is not a valid escape either.
          if (code === 0 || code > 0x10ffff) fail("Invalid Unicode escape value");
          append(String.fromCodePoint(code));
        }
        continue;
      }
      if (isOctalDigit(char)) {
        let end = index;
        while (end < index + 2 && isOctalDigit(raw[end] ?? "")) end += 1;
        if (pendingHigh !== 0) fail("Invalid Unicode surrogate pair");
        // PG keeps the low byte of `\777`, as an `unsigned char` would.
        bytes.push(Number.parseInt(raw.slice(slash + 1, end), 8) & 0xff);
        index = end;
        continue;
      }
      if (char === "x" && isHexDigit(raw[index] ?? "")) {
        const end = isHexDigit(raw[index + 1] ?? "") ? index + 2 : index + 1;
        if (pendingHigh !== 0) fail("Invalid Unicode surrogate pair");
        bytes.push(Number.parseInt(raw.slice(index, end), 16));
        index = end;
        continue;
      }
      append(SINGLE_CHAR_ESCAPES[char] ?? char);
    }
    // A pair never spans two continued constants: PG ends the literal's
    // `xeu` state at the quote between them.
    if (pendingHigh !== 0) fail("Invalid Unicode surrogate pair");
  }
  flushBytes();
  return value;
};

// The `UESCAPE 'c'` tail, read with the cursor just past a unicode literal's
// closing quote. A word that isn't UESCAPE, or one with no quoted character
// after it, restores the cursor and leaves those tokens to the parser — so
// `SELECT U&'\0041' uescape FROM t` still reads `uescape` as a column alias.
// Whitespace and comments may separate the parts, as they may any two tokens
// in PG (whose parser, not its scanner, reads the tail).
const readUescapeTail = (stream: InputStream): string | null => {
  // Skip whitespace and both comment forms; false when a `-` or `/` turned out
  // not to start one, or a block comment never closed. Either way the tail is
  // declined, and the main readers lex — or croak on — what is there.
  const skipSpace = (): boolean => {
    for (;;) {
      const char = stream.peek();
      if (isSpace(char)) {
        stream.next();
      } else if (char === "-") {
        stream.next();
        if (stream.peek() !== "-") return false;
        while (stream.peek() !== "" && !isNewline(stream.peek())) stream.next();
      } else if (char === "/") {
        stream.next();
        if (stream.peek() !== "*") return false;
        stream.next();
        if (!skipBlockComment(stream)) return false;
      } else {
        return true;
      }
    }
  };
  // `InputStream` has a single snapshot slot, so this clobbers the caller's —
  // safe only because the caller took it before `U` and is past every path that
  // could reload it by the time the literal is ours.
  stream.snapshot();
  const decline = () => {
    stream.reload();
    return null;
  };
  if (!skipSpace()) return decline();
  for (const char of "uescape") {
    if (stream.peek().toLowerCase() !== char) return decline();
    stream.next();
  }
  if (!skipSpace() || stream.peek() !== "'") return decline();
  // The tail is committed from here: no path below restores the cursor.
  const start = stream.position();
  // Read the whole `'…'`, not one character, so that a croak below resumes
  // *past* it. Croaking with the closing quote unconsumed would leave it to
  // open a runaway string and swallow the rest of the file.
  const { value: escapeChar } = readQuotedBody(stream, UESCAPE_CHAR, start);
  // PG's check_uescapechar: exactly one ASCII character (one byte), and not one that could be
  // part of an escape it introduces (a hex digit or `+`), a quote, or space.
  if (
    escapeChar.length !== 1 ||
    escapeChar > "\x7f" ||
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

// `U&'\0041' [UESCAPE 'c']` and `U&"d\0061t" [UESCAPE 'c']`. PG decodes these just
// after scanning (its parser reads the tail); this reader does it in the
// lexer. The string form yields an ordinary `string` token and the identifier
// form an ordinary `qident`, so either is usable everywhere its plain spelling is — enum labels, `COMMENT ON … IS`,
// DEFAULTs, any name — with no grammar surface at all. The UESCAPE tail belongs
// to the reader because it chooses the escape character, so nothing can be
// decoded until we know whether it is there. No `display`: labels are
// first-wins per token type and `"a string"` is already registered.
const unicodeStringReader: Reader<SqlTokenType> = readers.custom("string", {
  startsWith: "Uu",
  read: (stream) => {
    const tokenStart = stream.position();
    stream.snapshot();
    stream.next(); // `U`
    // A bare `u`, or a `u&` with no quote after it, is not ours: both restore
    // and lex as `u`, `&`, and whatever followed — PG's {xufailed}.
    if (stream.peek() !== "&") {
      stream.reload();
      return null;
    }
    stream.next(); // `&`
    const quote = stream.peek();
    if (quote !== "'" && quote !== '"') {
      stream.reload();
      return null;
    }
    const {
      value: raw,
      start,
      end,
    } = quote === "'" ? readQuotedBody(stream, STRING, tokenStart) : readIdentifierBody(stream, tokenStart);
    const escapeChar = readUescapeTail(stream);
    return {
      type: quote === "'" ? "string" : "qident",
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

// `'…'` — a standard-conforming string: backslash is an ordinary character.
const stringReader: Reader<SqlTokenType> = readers.custom("string", {
  startsWith: "'",
  display: "a string",
  read: (stream) => readQuotedBody(stream, STRING, stream.position()),
});

// `E'…'` — the escape string. Decoded once the whole literal is read, so an
// invalid escape croaks with the stream already past it.
const escapeStringReader: Reader<SqlTokenType> = readers.custom("string", {
  startsWith: "Ee",
  read: (stream) => {
    const tokenStart = stream.position();
    stream.snapshot();
    stream.next(); // `E`
    if (stream.peek() !== "'") {
      stream.reload(); // `end`, `explain`, a bare `e`: an identifier
      return null;
    }
    const { segments, start, end } = readEscapeBody(stream, tokenStart);
    return { value: decodeEscapes(stream, segments, tokenStart), start, end };
  },
});

// `"…"` — case-preserved (no fold), doubled `""` is one quote.
const quotedIdentifierReader: Reader<SqlTokenType> = readers.custom("qident", {
  startsWith: '"',
  display: "a quoted identifier",
  read: (stream) => readIdentifierBody(stream, stream.position()),
});

// Skip a `/* … */` body with the cursor just past its opener, nesting as PG's
// does; false when the input ends first, with the cursor at the end.
const skipBlockComment = (stream: InputStream, onChar?: (text: string) => void): boolean => {
  let depth = 1;
  for (;;) {
    // Peek first: `next()` at the end of input still advances the position.
    const char = stream.peek();
    if (char === "") return false;
    stream.next();
    if (char === "*" && stream.peek() === "/") {
      stream.next();
      depth -= 1;
      if (depth === 0) return true;
      onChar?.("*/");
    } else if (char === "/" && stream.peek() === "*") {
      stream.next();
      depth += 1;
      onChar?.("/*");
    } else {
      onChar?.(char);
    }
  }
};

// `/* … */`, nested. Unlike core's `blockComment` it croaks when the input
// ends inside one, as PG does.
const blockCommentReader: Reader<SqlTokenType> = readers.custom("comment", {
  startsWith: "/",
  read: (stream) => {
    const tokenStart = stream.position();
    stream.snapshot();
    stream.next();
    if (stream.peek() !== "*") {
      stream.reload(); // a `/` operator
      return null;
    }
    stream.next();
    let value = "";
    if (!skipBlockComment(stream, (text) => (value += text))) {
      stream.croak("Unterminated /* comment", tokenStart, stream.position());
    }
    return value;
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
    // Both are type "string"; the E reader falls through when the quote doesn't
    // follow, so `end` and `explain` still lex as identifiers.
    stringReader,
    escapeStringReader,
    // The other letter-prefixed literals (see above). Bit strings keep a token
    // type of their own — they are `bit` constants, not text — while a unicode
    // literal decodes to a plain string or quoted identifier.
    bitStringReader({
      type: "bitstring",
      startsWith: "Bb",
      form: BIT_STRING,
      isDigit: isBinaryDigit,
      display: "a bit string",
      invalid: "Invalid binary digit",
    }),
    bitStringReader({
      type: "hexstring",
      startsWith: "Xx",
      form: HEX_STRING,
      isDigit: isHexDigit,
      display: "a hex string",
      invalid: "Invalid hexadecimal digit",
    }),
    unicodeStringReader,
    quotedIdentifierReader,
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
    blockCommentReader,
    readers.operator("op", { display: "an operator" }),
  ],
  trivia: ["comment"],
  // SQL is newline-insensitive: newlines are ordinary whitespace.
  whitespace: WHITESPACE,
});

// What the grammar parses: `sqlLexer`'s tokens with every `comment` dropped, so
// a comment is legal anywhere whitespace is (`SELECT /* x */ 1`, `count -- n
// ⏎ (*)`), as in PG's scanner — except around `UESCAPE` (see
// `readUescapeTail`). Core skips trivia only in the list-shaped combinators and
// at the grammar's root boundaries, and `peek`/`peekAhead` lookahead never
// skips, so the comments are removed before the parse context sees them.
// Comments are not kept in the AST, and spans end at the last real token rather
// than at a trailing comment. `sqlLexer` itself still emits `comment` tokens
// for anyone tokenizing SQL directly (highlighters, formatters).
export const sqlParseLexer: Lexer<SqlTokenType> = {
  labels: sqlLexer.labels,
  tokenize: (input) => {
    const tokens = sqlLexer.tokenize(input);
    const peek = () => {
      let token = tokens.peek();
      while (token !== null && token.type === "comment") {
        tokens.next();
        token = tokens.peek();
      }
      return token;
    };
    return {
      next: () => {
        peek();
        return tokens.next();
      },
      peek,
      eof: () => peek() === null,
      croak: tokens.croak,
      position: tokens.position,
    };
  },
};
