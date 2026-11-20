import {
  defineLexer,
  type InputStream,
  type Lexer,
  type LexerDef,
  type ModeDef,
  type ModeTransition,
  type Position,
  type Reader,
  readers,
  type Token,
  type TokenStream,
} from "@parser-kit/core";

// The DBML lexer. Its rules follow `@dbml/parse`'s hand-written lexer (the
// compiler behind `@dbml/core`), which is the de facto spec: where the docs and
// that lexer disagree, this file follows the lexer.
//
// DBML is line-oriented, so a newline is a `punc` token ("\n") in the default
// mode. Inside `[ … ]` and `( … )` the lexer switches to the `inline` mode,
// where newlines are whitespace, so a settings list or a composite column list
// may span lines. Outside brackets, `{ … }` does not change mode (inside them, see
// `TRANSITIONS`). `\r` is whitespace everywhere,
// so CRLF files lex like LF ones.
//
// Relation operators are lexed one mark at a time (`<`, `>`, `-`, `<>`, `?`), so
// `>?` and `> ?` give the same tokens. `@dbml/parse` lexes `<>?`, `?-` and the
// like as single operators and rejects the spaced forms, so the grammar checks
// that the marks of one relation touch (by their spans). Front matter (`---`
// lines at the top of a file) is not lexed specially.
//
// Every keyword is an ordinary `ident`: keywords are contextual and
// case-insensitive, which the grammar handles on top of `dbmlParseLexer`.
export type DbmlTokenType =
  | "ident"
  | "qident"
  | "string"
  | "blockString"
  | "expression"
  | "number"
  | "color"
  | "punc"
  | "comment";

// --- Character classes ---
// `@dbml/parse`'s: a word starts with a Unicode letter, a combining mark or `_`
// and continues with those or an ASCII digit. A word that starts with a digit
// goes through the number reader, which hands back an identifier when the word
// isn't a number (`2fa_code`). Other Unicode digits are not word characters.
const ID_START = /[\p{L}\p{M}_]/u;
const ID_PART = /[\p{L}\p{M}_0-9]/u;
const isIdStart = (char: string): boolean => char !== "" && ID_START.test(char);
const isIdPart = (char: string): boolean => char !== "" && ID_PART.test(char);
const isDigit = (char: string): boolean => char >= "0" && char <= "9";

// Consume `seq` if it comes next, else leave the stream where it was. Uses the
// stream's single snapshot slot, so it must not run while another snapshot is
// pending.
const consumeSeq = (stream: InputStream, seq: string): boolean => {
  stream.snapshot();
  for (const char of seq) {
    if (stream.peek() !== char) {
      stream.reload();
      return false;
    }
    stream.next();
  }
  return true;
};

// --- Quoted forms ---
// `'…'` strings and `"…"` identifiers are single-line and decode backslash
// escapes; `'''…'''` strings may span lines and decode escapes (a note's text
// is dedented later, see `dedentNote`); backtick expressions may span lines and
// are raw. Running into a newline (where one isn't allowed) or the end of input
// croaks: core's `readers.string` would let the literal run to the end of input
// instead. Every token spans its quotes.

// `@dbml/parse`'s escapes. A backslash before a newline (LF or CRLF) is a line
// continuation, `\ ` keeps its backslash, and any other escaped character
// stands for itself. `\u` takes the next four word characters and decodes them
// as a hexadecimal UTF-16 code unit the way `@dbml/parse` does, with
// `parseInt`: `\u00e9` is `é`, and characters that aren't hexadecimal decode
// what they can (`\u12g4` is U+0012, `\uzzzz` is U+0000).
const ESCAPES: Readonly<Record<string, string>> = {
  t: "\t",
  n: "\n",
  r: "\r",
  "\\": "\\",
  "'": "'",
  '"': '"',
  "`": "`",
  "0": "\0",
  b: "\b",
  v: "\v",
  f: "\f",
  " ": "\\ ",
  "\n": "",
};

// Decode one escape; the stream is just past the backslash, which sits at
// `backslash`. Returns null at the end of input (the caller reports the
// unterminated literal).
const readEscape = (stream: InputStream, backslash: Position): string | null => {
  if (stream.eof()) return null;
  const char = stream.next();
  if (char === "\r") {
    if (stream.peek() === "\n") stream.next();
    return "";
  }
  if (char === "u") {
    let hex = "";
    while (hex.length < 4 && isIdPart(stream.peek())) hex += stream.next();
    if (hex.length < 4) {
      stream.croak(
        `Invalid unicode escape sequence "\\u${hex}": expected \\u followed by four hexadecimal digits`,
        backslash,
        stream.position(),
      );
    }
    // NaN (no leading hex digit) is U+0000, as upstream.
    return String.fromCharCode(Number.parseInt(hex, 16));
  }
  return ESCAPES[char] ?? char;
};

interface QuotedForm {
  /** The closing delimiter. */
  close: string;
  /** Whether a raw newline may appear inside. */
  multiline: boolean;
  /** Whether backslash escapes are decoded. */
  escapes: boolean;
  /** The croak message for a literal that runs off the end (or the line). */
  unterminated: string;
}

const STRING: QuotedForm = { close: "'", multiline: false, escapes: true, unterminated: "Unterminated string" };
const BLOCK_STRING: QuotedForm = {
  close: "'''",
  multiline: true,
  escapes: true,
  unterminated: "Unterminated multi-line string",
};
const QUOTED_IDENTIFIER: QuotedForm = {
  close: '"',
  multiline: false,
  escapes: true,
  unterminated: "Unterminated quoted identifier",
};
const EXPRESSION: QuotedForm = { close: "`", multiline: true, escapes: false, unterminated: "Unterminated expression" };

// Read a quoted body up to and including its closing delimiter; the opening one
// is already consumed and began at `start`. Returns the decoded body.
const readQuoted = (stream: InputStream, form: QuotedForm, start: Position): string => {
  const first = form.close[0]!;
  let value = "";
  // Where a `\r` just read began, so a literal cut off by a CRLF ends before it.
  let beforeCR: Position | null = null;
  for (;;) {
    if (stream.eof() || (!form.multiline && stream.peek() === "\n")) {
      stream.croak(form.unterminated, start, beforeCR ?? stream.position());
    }
    const char = stream.peek();
    beforeCR = char === "\r" ? stream.position() : null;
    if (char === first && consumeSeq(stream, form.close)) return value;
    if (form.escapes && char === "\\") {
      const backslash = stream.position();
      stream.next();
      const decoded = readEscape(stream, backslash);
      if (decoded === null) stream.croak(form.unterminated, start, stream.position());
      value += decoded;
      continue;
    }
    value += stream.next();
  }
};

/**
 * Dedent a note's text the way `@dbml/core` does. It applies this to note
 * values, `'…'` and `'''…'''` alike, except an index's `note:` setting, and to
 * nothing else: a `'''` default or project property keeps its text as written,
 * so the lexer leaves string values undedented and the grammar calls this
 * where it reads such a note. It drops the lines before the first one with
 * non-whitespace content, then strips the smallest indentation of the
 * remaining non-blank lines from every remaining line. Trailing lines are kept, so a closing `'''` on its own indented line
 * leaves the value ending in `"\n"`. A text with no content keeps only its
 * last line. Line breaks are not normalised (a CRLF file keeps its `\r`s).
 * For the grammar only; not part of the package entry.
 */
export const dedentNote = (text: string): string => {
  const lines = text.split("\n");
  const rest = lines.slice(lines.findIndex((line) => line.trimStart() !== ""));
  let indent = Number.POSITIVE_INFINITY;
  for (const line of rest) {
    const trimmed = line.trimStart();
    if (trimmed !== "") indent = Math.min(indent, line.length - trimmed.length);
  }
  if (indent === Number.POSITIVE_INFINITY) return rest.join("\n");
  return rest.map((line) => line.slice(indent)).join("\n");
};

// `'''…'''`, decoded but not dedented (see `dedentNote`). It declines any other
// `'`, which `stringReader` then reads.
const blockStringReader: Reader<DbmlTokenType> = readers.custom("blockString", {
  startsWith: "'",
  display: "a multi-line string",
  read: (stream) => {
    const start = stream.position();
    if (!consumeSeq(stream, "'''")) return null;
    return readQuoted(stream, BLOCK_STRING, start);
  },
});

// `'…'`; `''` is the empty string.
const stringReader: Reader<DbmlTokenType> = readers.custom("string", {
  startsWith: "'",
  display: "a string",
  read: (stream) => {
    const start = stream.position();
    stream.next();
    return readQuoted(stream, STRING, start);
  },
});

const quotedIdentifierReader: Reader<DbmlTokenType> = readers.custom("qident", {
  startsWith: '"',
  display: "a quoted identifier",
  read: (stream) => {
    const start = stream.position();
    stream.next();
    return readQuoted(stream, QUOTED_IDENTIFIER, start);
  },
});

// A backtick expression. Its value is the raw text between the backticks.
const expressionReader: Reader<DbmlTokenType> = readers.custom("expression", {
  startsWith: "`",
  display: "an expression",
  read: (stream) => {
    const start = stream.position();
    stream.next();
    return readQuoted(stream, EXPRESSION, start);
  },
});

// `#` and the word characters after it, kept with the `#` (`#3498DB`). Like
// `@dbml/parse`, any word characters are accepted, none included; whether they
// form a valid colour is a semantic check.
const colorReader: Reader<DbmlTokenType> = readers.custom("color", {
  startsWith: "#",
  display: "a color",
  read: (stream) => {
    let value = stream.next();
    while (isIdPart(stream.peek())) value += stream.next();
    return value;
  },
});

// `// …` to the end of the line and `/* … */`. The value is the text between
// the delimiters; a line comment's value and span leave out a `\r` that ends
// it (a CRLF's, or one at the end of input). An unterminated block comment
// croaks, as it does in `@dbml/parse`. A `/` that starts neither form has no
// use in DBML's syntax (`@dbml/parse` lexes it as an operator that no
// construct accepts), so it croaks here.
const commentReader: Reader<DbmlTokenType> = readers.custom("comment", {
  startsWith: "/",
  display: "a comment",
  read: (stream) => {
    const start = stream.position();
    stream.next();
    if (stream.peek() === "/") {
      stream.next();
      let value = "";
      let beforeCR: Position | null = null;
      while (!stream.eof() && stream.peek() !== "\n") {
        beforeCR = stream.peek() === "\r" ? stream.position() : null;
        value += stream.next();
      }
      if (beforeCR === null) return value;
      return { value: value.slice(0, -1), end: beforeCR };
    }
    if (stream.peek() === "*") {
      stream.next();
      let value = "";
      for (;;) {
        if (stream.eof()) stream.croak("Unterminated comment", start, stream.position());
        if (stream.peek() === "*" && consumeSeq(stream, "*/")) return value;
        value += stream.next();
      }
    }
    return stream.croak('Unexpected character "/"', start, stream.position());
  },
});

// A word that starts with a digit, read as `@dbml/parse` reads it:
// - digits with at most one `.` and an optional exponent are a number (`42`,
//   `1.5`, `5.`, `1e5`, `2.5E-3`), provided no word character follows (one
//   divergence: `@dbml/parse` rejects a `5.` that ends the input; here it is a
//   number, and the grammar rejects a file that ends in one anyway);
// - with no `.`, a word character after the digits (or after the exponent)
//   makes the whole word an identifier (`2fa_code`, `1abc`, `1e5x`);
// - with a `.`, a word character after the number, or a second `.` straight
//   after the fraction, is an invalid number (`1.5abc`, `1.2.3`); a `.` after
//   an exponent ends the number (`1.5e5.6` is `1.5e5`, `.`, `6`).
// A number's value is its exact source text; the grammar decodes it.
const numberReader: Reader<DbmlTokenType> = readers.custom("number", {
  startsWith: isDigit,
  display: "a number",
  read: (stream) => {
    const start = stream.position();
    let text = "";
    const digits = () => {
      while (isDigit(stream.peek())) text += stream.next();
    };
    // Consume an exponent (`e`, an optional sign, at least one digit) if one
    // comes next; otherwise leave the stream alone.
    const exponent = (): boolean => {
      const marker = stream.peek();
      if (marker !== "e" && marker !== "E") return false;
      stream.snapshot();
      let part = stream.next();
      if (stream.peek() === "+" || stream.peek() === "-") part += stream.next();
      if (!isDigit(stream.peek())) {
        stream.reload();
        return false;
      }
      text += part;
      digits();
      return true;
    };

    digits();
    if (stream.peek() !== ".") {
      exponent();
      if (!isIdPart(stream.peek())) return text;
      while (isIdPart(stream.peek())) text += stream.next();
      return { type: "ident", value: text };
    }

    text += stream.next();
    digits();
    const hasExponent = exponent();
    if (!isIdPart(stream.peek()) && (hasExponent || stream.peek() !== ".")) return text;
    while (isIdPart(stream.peek()) || stream.peek() === ".") stream.next();
    return stream.croak("Invalid number", start, stream.position());
  },
});

// --- The lexer ---

// `+` is for a unary plus on a number (`default: +1`), which `@dbml/core`
// accepts.
const PUNCTUATION = ["{", "}", "[", "]", "(", ")", ",", ":", ".", "~", "<", ">", "-", "<>", "?", "*", "+", "\n"];

// What both modes share; they differ only in whether a newline is a token.
const SHARED_MODE = {
  readers: [
    blockStringReader,
    stringReader,
    quotedIdentifierReader,
    expressionReader,
    colorReader,
    commentReader,
    numberReader,
  ],
  identifier: { type: "ident", start: isIdStart, part: isIdPart, display: "an identifier" },
  punctuation: { type: "punc", tokens: PUNCTUATION, display: "punctuation" },
} satisfies ModeDef<DbmlTokenType>;

const INLINE_MODE = { ...SHARED_MODE, whitespace: " \t\r\n" } satisfies ModeDef<DbmlTokenType>;

// `[` and `(` enter the inline mode and `]` and `)` leave it, one level each.
// Closers are not matched to openers (`[(]` leaves the `(` level, not the `[`
// one); a mismatch is the parser's error. A stray closer at the top level is a
// no-op. Braces never appear inside brackets in DBML, so a `{` or `}` lexed in
// the inline mode means a bracket was left open: it leaves one level too, so a
// single missing `]` doesn't turn the rest of the file's newlines into
// whitespace (with more levels open, each brace leaves one more).
const TRANSITIONS: readonly ModeTransition<DbmlTokenType>[] = [
  { on: { type: "punc", value: "[" }, action: "push", mode: "inline" },
  { on: { type: "punc", value: "(" }, action: "push", mode: "inline" },
  { on: { type: "punc", value: "]" }, action: "pop" },
  { on: { type: "punc", value: ")" }, action: "pop" },
  { on: { type: "punc", value: "{" }, inMode: "inline", action: "pop" },
  { on: { type: "punc", value: "}" }, inMode: "inline", action: "pop" },
];

const DBML_LEXER = {
  ...SHARED_MODE,
  whitespace: " \t\r",
  modes: { inline: INLINE_MODE },
  transitions: TRANSITIONS,
  trivia: ["comment"],
} satisfies LexerDef<DbmlTokenType>;

/**
 * The DBML lexer. It emits every token, comments included, for highlighters
 * and other tools that tokenize DBML directly.
 */
export const dbmlLexer: Lexer<DbmlTokenType> = defineLexer<DbmlTokenType>(DBML_LEXER);

// --- The parse stream ---

// The raw text of every case-folded identifier token, keyed by the folded copy.
const rawNames = new WeakMap<Token<DbmlTokenType>, string>();

/**
 * The name a token spells, as written: an identifier's original case (the
 * parse stream folds `value` to lowercase), or the decoded name of a quoted
 * identifier. For the grammar only; not part of the package entry.
 */
export const rawName = (token: Token<DbmlTokenType>): string => rawNames.get(token) ?? token.value;

// `tokens` with comments dropped and each identifier replaced by a copy whose
// value is lowercased, its raw text recorded in `rawNames`. `peek` hands back
// the same copy until it is consumed, so the map keeps working across lookahead.
const forParsing = (tokens: TokenStream<DbmlTokenType>): TokenStream<DbmlTokenType> => {
  let current: Token<DbmlTokenType> | null = null;
  const peek = (): Token<DbmlTokenType> | null => {
    if (current !== null) return current;
    let token = tokens.peek();
    while (token !== null && token.type === "comment") {
      tokens.next();
      token = tokens.peek();
    }
    if (token !== null && token.type === "ident") {
      const folded = token.value.toLowerCase();
      if (folded !== token.value) {
        const copy = { ...token, value: folded };
        rawNames.set(copy, token.value);
        token = copy;
      }
    }
    current = token;
    return token;
  };
  return {
    next: () => {
      const token = peek();
      current = null;
      tokens.next();
      return token;
    },
    peek,
    eof: () => peek() === null,
    croak: tokens.croak,
    position: tokens.position,
  };
};

/**
 * What the grammar parses: `dbmlLexer`'s tokens with comments dropped, so a
 * comment is legal wherever whitespace is, and identifiers folded to lowercase,
 * so keywords match case-insensitively by value while staying usable as names.
 * `rawName(token)` gives an identifier's original text back.
 */
export const dbmlParseLexer: Lexer<DbmlTokenType> = {
  labels: dbmlLexer.labels,
  tokenize: (input) => forParsing(dbmlLexer.tokenize(input)),
};
