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

const string = <TT extends string>(
  type: TT,
  opts: {
    quote: string;
    display?: string;
    /** Triple-fence form: `'''…'''` becomes its own token type, dedented. */
    block?: { fence: string; type: TT; dedent?: boolean };
  },
): Reader<TT> => {
  const { quote, block, display } = opts;

  // Consume `chars` if they appear next, else restore and report false.
  const tryConsume = (stream: InputStream, chars: string) => {
    stream.snapshot();
    for (const char of chars) {
      if (stream.peek() !== char) {
        stream.reload();
        return false;
      }
      stream.next();
    }
    return true;
  };

  const readBlock = (stream: InputStream, startPosition: Position): ReaderResult<TT> => {
    const fence = block!.fence;
    let raw = "";
    while (!stream.eof()) {
      if (stream.peek() === fence[0] && tryConsume(stream, fence)) {
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

  return {
    type,
    display,
    startsWith: (char) => char === quote,
    read: (stream) => {
      stream.next(); // opening quote
      const startPosition = stream.position();

      if (block?.fence.startsWith(quote) && tryConsume(stream, block.fence.slice(1))) {
        return readBlock(stream, startPosition);
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
  opts: { display?: string } = {},
): Reader<TT> => ({
  type,
  display: opts.display,
  startsWith: (char) => char === open[0],
  read: (stream) => {
    stream.snapshot();
    for (const char of open) {
      if (stream.peek() !== char) {
        stream.reload();
        return null;
      }
      stream.next();
    }

    let value = "";
    while (!stream.eof()) {
      if (stream.peek() === close[0]) {
        stream.snapshot();
        let matched = true;
        for (const char of close) {
          if (stream.peek() !== char) {
            matched = false;
            break;
          }
          stream.next();
        }
        if (matched) return { value };
        stream.reload();
      }
      value += stream.next();
    }
    return { value };
  },
});

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

export const readers = { number, string, lineComment, blockComment, custom };
