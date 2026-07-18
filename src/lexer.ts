import type { TypeLabels } from "./describe";
import type { InputStream } from "./input-stream";
import type { Position } from "./position";
import type { Token, TokenStream } from "./token";
import { createTree, extractTokenByTree } from "./trie";

// A character class: a set of characters, a regex, or a predicate.
export type CharClass = string | RegExp | ((char: string) => boolean);

export const charClassToPredicate = (charClass: CharClass): ((char: string) => boolean) => {
  if (typeof charClass === "string") return (char) => char !== "" && charClass.includes(char);
  if (charClass instanceof RegExp) return (char) => char !== "" && charClass.test(char);
  return (char) => char !== "" && charClass(char);
};

// What a reader hands back: the token value, optionally overriding the token
// type (block strings) or the recorded span (dbml strings span their content,
// not their quotes). `null` means "not mine after all" — the reader must have
// restored the stream itself.
export interface ReaderResult<TT extends string = string> {
  value: string;
  type?: TT;
  start?: Position;
  end?: Position;
}

export interface Reader<TT extends string = string> {
  type: TT;
  display?: string;
  startsWith: (char: string, stream: InputStream) => boolean;
  read: (stream: InputStream) => ReaderResult<TT> | null;
}

export interface LexerDef<TT extends string = string> {
  keywords?: {
    type: TT;
    /** Multi-word entries (["not", "null"]) match across whitespace via a trie. */
    words: readonly (string | readonly string[])[];
    caseInsensitive?: boolean;
    display?: string;
  };
  punctuation?: {
    type: TT;
    tokens: readonly string[];
    display?: string;
  };
  identifier?: {
    type: TT;
    start: CharClass;
    part: CharClass;
    display?: string;
  };
  /** Tried first, in order, dispatched on the current character. */
  readers?: readonly Reader<TT>[];
  /** Skipped between tokens. Defaults to space/tab — NOT newline. */
  whitespace?: CharClass;
}

export interface Lexer<TT extends string = string> {
  tokenize(input: InputStream): TokenStream<TT>;
  /** Token-type → human label map for error messages, from `display` fields. */
  labels: TypeLabels;
}

const readWhile = (input: InputStream, predicate: (char: string) => boolean) => {
  let out = "";
  while (!input.eof() && predicate(input.peek())) {
    out += input.next();
  }
  return out;
};

// Consume `seq` if it appears next (leaving the stream advanced past it), else
// restore the stream and report false. Uses the single snapshot slot, so it must
// only be called once the reader has committed (no pending outer snapshot).
const consumeSeq = (input: InputStream, seq: string): boolean => {
  input.snapshot();
  for (const char of seq) {
    if (input.peek() !== char) {
      input.reload();
      return false;
    }
    input.next();
  }
  return true;
};

export function defineLexer<const TT extends string>(def: LexerDef<TT>): Lexer<TT> {
  const { keywords, punctuation, identifier, readers = [] } = def;

  if (keywords && !identifier) {
    throw new Error("defineLexer: `keywords` requires an `identifier` definition to scan words with");
  }

  const isWhitespace = charClassToPredicate(def.whitespace ?? " \t");
  const isIdStart = identifier ? charClassToPredicate(identifier.start) : () => false;
  const isIdPart = identifier ? charClassToPredicate(identifier.part) : () => false;

  const caseInsensitive = keywords?.caseInsensitive ?? false;
  const keywordsTree = keywords
    ? createTree(
        keywords.words.map((entry) => {
          const words = typeof entry === "string" ? [entry] : entry;
          return words.map((word) => (caseInsensitive ? word.toLowerCase() : word));
        }),
      )
    : null;
  const punctuationTree = punctuation ? createTree(punctuation.tokens) : null;

  const labels: TypeLabels = {};
  if (keywords?.display) labels[keywords.type] = keywords.display;
  if (punctuation?.display) labels[punctuation.type] = punctuation.display;
  if (identifier?.display) labels[identifier.type] = identifier.display;
  for (const reader of readers) {
    if (reader.display && !(reader.type in labels)) labels[reader.type] = reader.display;
  }

  const tokenize = (input: InputStream): TokenStream<TT> => {
    let current: Token<TT> | null = null;

    const readIdentifier = (): Token<TT> => {
      const startPosition = input.position();

      if (keywordsTree) {
        const keyword = extractTokenByTree(
          keywordsTree,
          input.snapshot,
          input.reload,
          () => {
            const word = readWhile(input, isIdPart);
            return caseInsensitive ? word.toLowerCase() : word;
          },
          () => readWhile(input, isWhitespace),
          " ",
        );
        if (keyword !== null) {
          return {
            type: keywords!.type,
            value: keyword,
            position: { start: startPosition, end: input.position() },
          };
        }
      }

      return {
        type: identifier!.type,
        value: readWhile(input, isIdPart),
        position: { start: startPosition, end: input.position() },
      };
    };

    const readPunctuation = (): Token<TT> | null => {
      const startPosition = input.position();
      const value = extractTokenByTree(punctuationTree!, input.snapshot, input.reload, input.next, () => {
        return;
      });
      if (value === null) return null;
      return {
        type: punctuation!.type,
        value,
        position: { start: startPosition, end: input.position() },
      };
    };

    const readNext = (): Token<TT> | null => {
      readWhile(input, isWhitespace);
      if (input.eof()) {
        return null;
      }
      const char = input.peek();

      for (const reader of readers) {
        if (!reader.startsWith(char, input)) continue;
        const startPosition = input.position();
        const result = reader.read(input);
        if (result === null) continue;
        return {
          type: result.type ?? reader.type,
          value: result.value,
          position: {
            start: result.start ?? startPosition,
            end: result.end ?? input.position(),
          },
        };
      }

      if (identifier && isIdStart(char)) {
        return readIdentifier();
      }

      if (punctuationTree) {
        const token = readPunctuation();
        if (token) return token;
      }

      const startPosition = input.position();
      input.next();
      const endPosition = input.position();
      input.croak(`Unexpected character "${char}"`, startPosition, endPosition);
    };

    const next = () => {
      const token = current;
      current = null;
      return token ?? readNext();
    };

    const peek = () => {
      return current || (current = readNext());
    };

    const eof = () => {
      return peek() === null;
    };

    return {
      next,
      peek,
      eof,
      croak: input.croak,
      position: input.position,
    };
  };

  return { tokenize, labels };
}

// --- Built-in reader library ---

const isDigit = (char: string) => char >= "0" && char <= "9";

const number = <TT extends string>(
  type: TT,
  opts: { signs?: readonly string[]; decimal?: boolean; display?: string } = {},
): Reader<TT> => {
  const { signs = [], decimal = true, display } = opts;
  return {
    type,
    display,
    startsWith: (char, stream) => {
      if (isDigit(char)) return true;
      if (!signs.includes(char)) return false;
      // A sign only begins a number when a digit follows (`-3`, not `a - b`).
      stream.snapshot();
      stream.next();
      const negative = isDigit(stream.peek());
      stream.reload();
      return negative;
    },
    read: (stream) => {
      const sign = signs.includes(stream.peek()) ? stream.next() : "";
      let value = sign + readWhile(stream, isDigit);

      // A decimal point only continues the number when digits follow it, so a
      // trailing `.` (e.g. a schema separator) is left for the next token.
      if (decimal && stream.peek() === ".") {
        stream.snapshot();
        const dot = stream.next();
        const fraction = readWhile(stream, isDigit);
        if (fraction) {
          value += dot + fraction;
        } else {
          stream.reload();
        }
      }

      return { value };
    },
  };
};

// A block string is dedented by the smallest common leading indentation of
// its content lines; the newline right after the opening fence and the one
// before the closing fence are dropped.
const dedentBlock = (raw: string) => {
  const lines = raw.split("\n");
  if (lines[0] === "") lines.shift();
  if (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();

  const indents = lines.filter((line) => line.trim() !== "").map((line) => line.length - line.trimStart().length);
  const indent = indents.length ? Math.min(...indents) : 0;

  return lines.map((line) => line.slice(indent)).join("\n");
};

// PG's `backslash: true` set. A map form overrides this wholesale; any character
// not in the active map passes through unchanged (`E'\q'` decodes to `q`).
const DEFAULT_BACKSLASH: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" };

const string = <TT extends string>(
  type: TT,
  opts: {
    quote: string;
    display?: string;
    /** Triple-fence form: `'''…'''` becomes its own token type, dedented. */
    block?: { fence: string; type: TT; dedent?: boolean };
    /** Prefix that must precede the quote (e.g. "E" for `E'…'`); own reader instance. */
    prefix?: string;
    /** Whether the prefix matches case-insensitively (PG's `E`/`e`). Default true. */
    prefixCaseInsensitive?: boolean;
    escape?: {
      /** `''` inside `'…'` decodes to one quote in the value. */
      doubling?: boolean;
      /** `true` = the `{n,t,r,b,f}` set; a map overrides it. Unknown chars pass through. */
      backslash?: boolean | Record<string, string>;
    };
  },
): Reader<TT> => {
  const { quote, block, display, prefix, escape: escaping } = opts;
  const prefixCaseInsensitive = opts.prefixCaseInsensitive ?? true;

  const matchesPrefixChar = (char: string): boolean => {
    const p = prefix![0]!;
    return prefixCaseInsensitive ? char.toLowerCase() === p.toLowerCase() : char === p;
  };

  const readBlock = (stream: InputStream, startPosition: Position): ReaderResult<TT> => {
    const fence = block!.fence;
    let raw = "";
    while (!stream.eof()) {
      if (stream.peek() === fence[0] && consumeSeq(stream, fence)) {
        return {
          type: block!.type,
          value: block!.dedent === false ? raw : dedentBlock(raw),
          start: startPosition,
          end: stream.position(),
        };
      }
      raw += stream.next();
    }
    stream.croak("Unterminated multi-line string", startPosition, stream.position());
  };

  // Escape-aware body scan. Decodes into `value`; the raw text stays recoverable
  // via the span. Only `\` at EOF croaks — running off the end otherwise stays
  // lenient, matching the plain path below.
  const readEscaped = (stream: InputStream, startPosition: Position): ReaderResult<TT> => {
    const doubling = escaping!.doubling ?? false;
    const backslashMap =
      escaping!.backslash === true ? DEFAULT_BACKSLASH : escaping!.backslash ? escaping!.backslash : null;

    let value = "";
    while (!stream.eof()) {
      const char = stream.peek();

      if (char === quote) {
        if (doubling) {
          stream.snapshot();
          stream.next(); // provisional close
          if (stream.peek() === quote) {
            stream.next();
            value += quote;
            continue;
          }
          stream.reload(); // it was the real terminator
        }
        break;
      }

      if (backslashMap && char === "\\") {
        stream.next(); // consume backslash
        if (stream.eof()) {
          stream.croak("Unterminated string", startPosition, stream.position());
        }
        const escaped = stream.next();
        value += backslashMap[escaped] ?? escaped;
        continue;
      }

      value += stream.next();
    }

    const endPosition = stream.position();
    stream.next(); // closing quote (or nothing at EOF)
    return { value, start: startPosition, end: endPosition };
  };

  return {
    type,
    display,
    startsWith: (char) => (prefix ? matchesPrefixChar(char) : char === quote),
    read: (stream) => {
      // A prefixed reader owns its `startsWith`; if the quote doesn't follow the
      // prefix, restore and fall through (so `EXPLAIN` stays an identifier).
      if (prefix) {
        stream.snapshot();
        for (const char of prefix) {
          const matches = prefixCaseInsensitive
            ? stream.peek().toLowerCase() === char.toLowerCase()
            : stream.peek() === char;
          if (!matches) {
            stream.reload();
            return null;
          }
          stream.next();
        }
        if (stream.peek() !== quote) {
          stream.reload();
          return null;
        }
      }

      stream.next(); // opening quote
      const startPosition = stream.position();

      if (block?.fence.startsWith(quote) && consumeSeq(stream, block.fence.slice(1))) {
        return readBlock(stream, startPosition);
      }

      if (escaping) {
        return readEscaped(stream, startPosition);
      }

      const value = readWhile(stream, (char) => char !== quote);
      const endPosition = stream.position();
      stream.next(); // closing quote (or nothing at EOF)
      return { value, start: startPosition, end: endPosition };
    },
  };
};

const lineComment = <TT extends string>(type: TT, prefix: string, opts: { display?: string } = {}): Reader<TT> => ({
  type,
  display: opts.display,
  startsWith: (char) => char === prefix[0],
  read: (stream) => {
    stream.snapshot();
    for (const char of prefix) {
      if (stream.peek() !== char) {
        stream.reload();
        return null;
      }
      stream.next();
    }
    return { value: readWhile(stream, (char) => char !== "\n" && char !== "\r") };
  },
});

const blockComment = <TT extends string>(
  type: TT,
  open: string,
  close: string,
  opts: { display?: string; nested?: boolean } = {},
): Reader<TT> => ({
  type,
  display: opts.display,
  startsWith: (char) => char === open[0],
  read: (stream) => {
    if (!consumeSeq(stream, open)) return null;

    // With `nested`, a depth counter lets `open`/`close` pairs balance; inner
    // delimiters stay in the value and only the outermost `close` terminates.
    // `close` is tested before `open` so shared-first-char delimiters are
    // unambiguous. At-EOF stays lenient (partial value, no croak) either way.
    let value = "";
    let depth = 1;
    while (!stream.eof()) {
      if (stream.peek() === close[0] && consumeSeq(stream, close)) {
        depth -= 1;
        if (depth === 0) return { value };
        value += close;
        continue;
      }
      if (opts.nested && stream.peek() === open[0] && consumeSeq(stream, open)) {
        depth += 1;
        value += open;
        continue;
      }
      value += stream.next();
    }
    return { value };
  },
});

// PG dollar-quoted strings: `$tag$…$tag$` (tag optional, `$$…$$`). The tag
// follows identifier rules (letter/`_` start), so `$1` positional params fall
// through. Content is raw — no decoding — and the exact `$tag$` closer, matched
// case-sensitively, is the only terminator (so differently-tagged `$…$` nest for
// free). Unterminated croaks — PG errors here, and swallowing the tail would be a
// poor diagnostic.
const isTagStart = (char: string) => /[A-Za-z_]/.test(char);
const isTagPart = (char: string) => /[A-Za-z0-9_]/.test(char);

const dollarString = <TT extends string>(type: TT, opts: { display?: string } = {}): Reader<TT> => {
  // Scan the content once the `$tag$` opener is committed; croaks on EOF. Split
  // out with an explicit return type so the terminal croak is seen as never.
  const readBody = (stream: InputStream, tag: string): ReaderResult<TT> => {
    const startPosition = stream.position();
    const closer = `$${tag}$`;
    let value = "";
    while (!stream.eof()) {
      if (stream.peek() === "$") {
        const endPosition = stream.position();
        if (consumeSeq(stream, closer)) {
          return { value, start: startPosition, end: endPosition };
        }
      }
      value += stream.next();
    }
    stream.croak("Unterminated dollar-quoted string", startPosition, stream.position());
  };

  return {
    type,
    display: opts.display,
    startsWith: (char) => char === "$",
    read: (stream) => {
      stream.snapshot();
      stream.next(); // opening `$`

      let tag = "";
      if (isTagStart(stream.peek())) {
        tag += stream.next();
        while (isTagPart(stream.peek())) tag += stream.next();
      }

      // The tag must be closed by `$`; otherwise this isn't a dollar string
      // (`$1`, a bare `$`) — restore and fall through.
      if (stream.peek() !== "$") {
        stream.reload();
        return null;
      }
      stream.next(); // closing `$` of the opener

      return readBody(stream, tag);
    },
  };
};

const custom = <TT extends string>(
  type: TT,
  opts: {
    startsWith: CharClass;
    read: (stream: InputStream) => ReaderResult<TT> | string | null;
    display?: string;
  },
): Reader<TT> => {
  const starts = charClassToPredicate(opts.startsWith);
  return {
    type,
    display: opts.display,
    startsWith: (char) => starts(char),
    read: (stream) => {
      const result = opts.read(stream);
      if (result === null) return null;
      return typeof result === "string" ? { value: result } : result;
    },
  };
};

export const readers = { number, string, dollarString, lineComment, blockComment, custom };
