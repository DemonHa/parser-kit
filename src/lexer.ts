import type { TypeLabels } from "./describe";
import type { InputStream } from "./input-stream";
import type { Position } from "./position";
import { matchesToken, type Token, type TokenMatch, type TokenStream } from "./token";
import { createTree, extractTokenByTree, type Trie } from "./trie";

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

// Lexer-side context readers may consult: the last significant token produced
// and the mode stack's top. It is a pure function of the tokens already emitted,
// which is what keeps buffer replay sound — parse branching can never change it.
export interface LexContext<TT extends string = string> {
  /** Last non-trivia token produced; null at the start of input. */
  lastToken: Token<TT> | null;
  /** The mode `lastToken` was lexed in. */
  lastMode: string;
  /** Current mode (top of the stack); the root mode is "default". */
  mode: string;
}

export interface Reader<TT extends string = string> {
  type: TT;
  display?: string;
  // `ctx` is deliberately untyped over the lexer's vocabulary: a reader only
  // knows its own token type, so the tokens it sees in `lastToken` are typed
  // by whichever lexer it is plugged into.
  startsWith: (char: string, stream: InputStream, ctx: LexContext) => boolean;
  read: (stream: InputStream, ctx: LexContext) => ReaderResult<TT> | null;
}

// A mode-change rule, evaluated after each token is produced (at lexing time,
// inside peek — sound because the relevant boundary is once-only lexing, not
// consumption). The first matching transition wins.
export interface ModeTransition<TT extends string = string> {
  /** Fires when the token just produced matches this pattern. */
  on: TokenMatch<TT>;
  /** Only fires when this mode was current while the token was lexed. */
  inMode?: string;
  /** Extra guard; `ctx.lastToken` is the token BEFORE the matched one. */
  when?: (ctx: LexContext<TT>) => boolean;
  /** Pop on the root mode is a no-op (a stray `}` is the parser's error). */
  action: "push" | "pop";
  /** Target mode; required for push. */
  mode?: string;
}

export interface ModeDef<TT extends string = string> {
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
    /**
     * Case-fold `token.value` (PG folds unquoted identifiers to lowercase).
     * After folding, grammar-side keyword matching is exact-value matching;
     * the raw text stays recoverable via the span.
     */
    fold?: "lower" | "upper";
  };
  /** Tried first, in order, dispatched on the current character. */
  readers?: readonly Reader<TT>[];
  /** Skipped between tokens. Defaults to space/tab — NOT newline. `""` disables skipping. */
  whitespace?: CharClass;
}

// The top-level def doubles as the root mode ("default"). A mode-free def
// compiles to a one-entry stack — behaviorally identical to before.
export interface LexerDef<TT extends string = string> extends ModeDef<TT> {
  /** Alternate lexing modes (own readers/punctuation/whitespace), by name. */
  modes?: Record<string, ModeDef<TT>>;
  /** Token-driven mode changes; evaluated after each token, first match wins. */
  transitions?: readonly ModeTransition<TT>[];
  /** Token types excluded from `LexContext.lastToken` tracking (comments). */
  trivia?: readonly TT[];
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

// A mode's definition with its derived tables, built once at define time.
interface CompiledMode<TT extends string> {
  keywords: ModeDef<TT>["keywords"];
  punctuation: ModeDef<TT>["punctuation"];
  identifier: ModeDef<TT>["identifier"];
  readers: readonly Reader<TT>[];
  isWhitespace: (char: string) => boolean;
  isIdStart: (char: string) => boolean;
  isIdPart: (char: string) => boolean;
  foldIdentifier: (word: string) => string;
  caseInsensitive: boolean;
  keywordsTree: Trie | null;
  punctuationTree: Trie | null;
}

export function defineLexer<const TT extends string>(def: LexerDef<TT>): Lexer<TT> {
  const compileMode = (mode: ModeDef<TT>): CompiledMode<TT> => {
    const { keywords, punctuation, identifier, readers = [] } = mode;

    if (keywords && !identifier) {
      throw new Error("defineLexer: `keywords` requires an `identifier` definition to scan words with");
    }

    const caseInsensitive = keywords?.caseInsensitive ?? false;
    return {
      keywords,
      punctuation,
      identifier,
      readers,
      isWhitespace: charClassToPredicate(mode.whitespace ?? " \t"),
      isIdStart: identifier ? charClassToPredicate(identifier.start) : () => false,
      isIdPart: identifier ? charClassToPredicate(identifier.part) : () => false,
      foldIdentifier:
        identifier?.fold === "lower"
          ? (word: string) => word.toLowerCase()
          : identifier?.fold === "upper"
            ? (word: string) => word.toUpperCase()
            : (word: string) => word,
      caseInsensitive,
      keywordsTree: keywords
        ? createTree(
            keywords.words.map((entry) => {
              const words = typeof entry === "string" ? [entry] : entry;
              return words.map((word) => (caseInsensitive ? word.toLowerCase() : word));
            }),
          )
        : null,
      punctuationTree: punctuation ? createTree(punctuation.tokens) : null,
    };
  };

  // The top-level def is the root mode; a mode-free def compiles to this
  // one-entry table and behaves exactly as before.
  const modes: Record<string, CompiledMode<TT>> = { default: compileMode(def) };
  for (const [name, mode] of Object.entries(def.modes ?? {})) {
    modes[name] = compileMode(mode);
  }

  const transitions = def.transitions ?? [];
  for (const transition of transitions) {
    if (transition.action === "push" && transition.mode === undefined) {
      throw new Error("defineLexer: a push transition requires a target `mode`");
    }
    for (const name of [transition.mode, transition.inMode]) {
      if (name !== undefined && !(name in modes)) {
        throw new Error(`defineLexer: transition references unknown mode "${name}"`);
      }
    }
  }

  const triviaTypes = new Set<TT>(def.trivia ?? []);

  const labels: TypeLabels = {};
  for (const mode of Object.values(modes)) {
    const { keywords, punctuation, identifier, readers } = mode;
    if (keywords?.display && !(keywords.type in labels)) labels[keywords.type] = keywords.display;
    if (punctuation?.display && !(punctuation.type in labels)) labels[punctuation.type] = punctuation.display;
    if (identifier?.display && !(identifier.type in labels)) labels[identifier.type] = identifier.display;
    for (const reader of readers) {
      if (reader.display && !(reader.type in labels)) labels[reader.type] = reader.display;
    }
  }

  const tokenize = (input: InputStream): TokenStream<TT> => {
    let current: Token<TT> | null = null;
    const modeStack: string[] = ["default"];
    const lexCtx: LexContext<TT> = { lastToken: null, lastMode: "default", mode: "default" };

    const readIdentifier = (mode: CompiledMode<TT>): Token<TT> => {
      const startPosition = input.position();

      if (mode.keywordsTree) {
        const keyword = extractTokenByTree(
          mode.keywordsTree,
          input.snapshot,
          input.reload,
          () => {
            const word = readWhile(input, mode.isIdPart);
            return mode.caseInsensitive ? word.toLowerCase() : word;
          },
          () => readWhile(input, mode.isWhitespace),
          " ",
        );
        if (keyword !== null) {
          return {
            type: mode.keywords!.type,
            value: keyword,
            position: { start: startPosition, end: input.position() },
          };
        }
      }

      return {
        type: mode.identifier!.type,
        value: mode.foldIdentifier(readWhile(input, mode.isIdPart)),
        position: { start: startPosition, end: input.position() },
      };
    };

    const readPunctuation = (mode: CompiledMode<TT>): Token<TT> | null => {
      const startPosition = input.position();
      const value = extractTokenByTree(mode.punctuationTree!, input.snapshot, input.reload, input.next, () => {
        return;
      });
      if (value === null) return null;
      return {
        type: mode.punctuation!.type,
        value,
        position: { start: startPosition, end: input.position() },
      };
    };

    const readNext = (): Token<TT> | null => {
      const mode = modes[lexCtx.mode]!;
      readWhile(input, mode.isWhitespace);
      if (input.eof()) {
        return null;
      }
      const char = input.peek();

      for (const reader of mode.readers) {
        if (!reader.startsWith(char, input, lexCtx)) continue;
        const startPosition = input.position();
        const result = reader.read(input, lexCtx);
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

      if (mode.identifier && mode.isIdStart(char)) {
        return readIdentifier(mode);
      }

      if (mode.punctuationTree) {
        const token = readPunctuation(mode);
        if (token) return token;
      }

      const startPosition = input.position();
      input.next();
      const endPosition = input.position();
      input.croak(`Unexpected character "${char}"`, startPosition, endPosition);
    };

    // Transitions and lastToken tracking fire here — at lexing time, inside
    // peek. Sound because each character position is lexed at most once
    // (rollback replays stored tokens) and lexer context is a pure function
    // of the tokens already produced; the parser has no API to mutate it.
    const produce = (): Token<TT> | null => {
      const token = readNext();
      if (token === null) return null;
      const lexedIn = lexCtx.mode;
      for (const transition of transitions) {
        if (transition.inMode !== undefined && transition.inMode !== lexedIn) continue;
        if (!matchesToken(token, transition.on)) continue;
        if (transition.when && !transition.when(lexCtx)) continue;
        if (transition.action === "push") {
          modeStack.push(transition.mode!);
        } else if (modeStack.length > 1) {
          modeStack.pop();
        }
        lexCtx.mode = modeStack[modeStack.length - 1]!;
        break;
      }
      if (!triviaTypes.has(token.type)) {
        lexCtx.lastToken = token;
        lexCtx.lastMode = lexedIn;
      }
      return token;
    };

    const next = () => {
      const token = current;
      current = null;
      return token ?? produce();
    };

    const peek = () => {
      return current || (current = produce());
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
const isHexDigit = (char: string) => /[0-9a-fA-F]/.test(char);
const isOctalDigit = (char: string) => char >= "0" && char <= "7";
const isBinaryDigit = (char: string) => char === "0" || char === "1";

const number = <TT extends string>(
  type: TT,
  opts: {
    signs?: readonly string[];
    decimal?: boolean;
    /** Scientific notation: `1e5`, `1.5e-3`, `2E+10`. Never on radix forms. */
    exponent?: boolean;
    /** A `.` with no integer part starts a number: `.5` (guarded so `a.b` doesn't). */
    leadingDot?: boolean;
    /** `0x…`/`0o…`/`0b…` integer literals (PG16). `Number(value)` decodes them. */
    radix?: { hex?: boolean; octal?: boolean; binary?: boolean };
    /** `_` between digits (PG16); stripped from `value` so `Number(value)` works. */
    separators?: boolean;
    display?: string;
  } = {},
): Reader<TT> => {
  const { signs = [], decimal = true, exponent = false, leadingDot = false, radix, separators = false, display } = opts;

  // Read a run of digits (per `isDigitChar`), allowing `_` separators between two
  // digits when enabled. Separators are dropped from the returned run (raw text
  // stays in the span); a leading/trailing/doubled `_` is never consumed, so `1_`
  // yields `1` and leaves `_` for the next token. Every `_` lookahead is a
  // self-contained snapshot/reload, so this never nests inside a caller's snapshot
  // (callers only reload when the run came back empty, i.e. when no `_` was seen).
  const readDigitRun = (stream: InputStream, isDigitChar: (c: string) => boolean): string => {
    if (!isDigitChar(stream.peek())) return "";
    let out = stream.next();
    while (!stream.eof()) {
      const char = stream.peek();
      if (isDigitChar(char)) {
        out += stream.next();
      } else if (separators && char === "_") {
        stream.snapshot();
        stream.next(); // provisional separator
        if (isDigitChar(stream.peek())) continue; // valid: drop `_`, read the digit next
        stream.reload(); // trailing/doubled `_` — leave it for the next token
        break;
      } else {
        break;
      }
    }
    return out;
  };

  // At a leading `0`: try `0x`/`0o`/`0b`. A bare marker (`0x` with no hex digit)
  // backtracks to just `0`, leaving the marker char for the identifier scanner.
  const readRadix = (stream: InputStream, sign: string): string | null => {
    stream.snapshot();
    const zero = stream.next(); // "0"
    const marker = stream.peek();
    const digitsFor =
      radix!.hex && (marker === "x" || marker === "X")
        ? isHexDigit
        : radix!.octal && (marker === "o" || marker === "O")
          ? isOctalDigit
          : radix!.binary && (marker === "b" || marker === "B")
            ? isBinaryDigit
            : null;

    if (digitsFor === null) {
      stream.reload(); // `0` not followed by an enabled marker
      return null;
    }
    stream.next(); // marker
    const digits = readDigitRun(stream, digitsFor);
    if (digits) return sign + zero + marker + digits;
    stream.reload(); // bare `0x`/`0o`/`0b`
    return null;
  };

  return {
    type,
    display,
    startsWith: (char, stream) => {
      if (isDigit(char)) return true;
      if (leadingDot && char === ".") {
        // `.` only begins a number when a digit follows (`.5`, not `a.b`).
        stream.snapshot();
        stream.next();
        const ok = isDigit(stream.peek());
        stream.reload();
        return ok;
      }
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

      if (radix && stream.peek() === "0") {
        const radixValue = readRadix(stream, sign);
        if (radixValue !== null) return { value: radixValue };
        // Otherwise `0` is an ordinary decimal digit — fall through.
      }

      const intPart = readDigitRun(stream, isDigit);
      let value = sign + intPart;
      let hasMantissa = intPart.length > 0;

      // A decimal point only continues the number when digits follow it, so a
      // trailing `.` (e.g. a schema separator) is left for the next token.
      if (decimal && stream.peek() === ".") {
        stream.snapshot();
        const dot = stream.next();
        const fraction = readDigitRun(stream, isDigit);
        if (fraction) {
          value += dot + fraction;
          hasMantissa = true;
        } else {
          stream.reload();
        }
      }

      // `1e5`, `1.5e-3`. A bare `1e` backtracks, leaving `e…` for the identifier
      // scanner; the exponent never attaches without a preceding mantissa.
      if (exponent && hasMantissa && (stream.peek() === "e" || stream.peek() === "E")) {
        stream.snapshot();
        const e = stream.next();
        const expSign = stream.peek() === "+" || stream.peek() === "-" ? stream.next() : "";
        const expDigits = readDigitRun(stream, isDigit);
        if (expDigits) {
          value += e + expSign + expDigits;
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

// PG-style multi-character operators (`||`, `@>`, `<->`, …). Coexists with the
// punctuation trie by partitioning the character space: operator `chars` and the
// punctuation token characters must not overlap, so `::`/`:`/`,`/`(`/`)`/`;`/`.`
// stay trie-lexed while operators are read here. Comment readers (`--`, `/*`) must
// precede this reader in the array; `stopAt` then guarantees a scan never swallows
// a comment start mid-run (`@--x` reads `@`, then the comment reader takes `--x`).
const operator = <TT extends string>(
  type: TT,
  opts: {
    chars?: string;
    /** Sequences the scan must never cross (comment starts). Default `["--", "/*"]`. */
    stopAt?: readonly string[];
    /** PG's rule: trim a trailing `+`/`-` unless the operator contains a "strong" char. */
    noTrailing?: { chars: string; unless: string };
    display?: string;
  } = {},
): Reader<TT> => {
  const chars = opts.chars ?? "+-*/<>=~!@#%^&|`?";
  const stopAt = opts.stopAt ?? ["--", "/*"];
  const noTrailing = opts.noTrailing ?? { chars: "+-", unless: "~!@#%^&|`?" };
  const isOpChar = (char: string) => char !== "" && chars.includes(char);

  return {
    type,
    display: opts.display,
    startsWith: (char) => isOpChar(char),
    read: (stream) => {
      // Scan every operator char, then restore — the final length (after cutting
      // at a comment start and trimming) is re-consumed for real, so a single
      // snapshot/reload keeps the span exact without per-char bookkeeping.
      stream.snapshot();
      let raw = "";
      while (isOpChar(stream.peek())) raw += stream.next();
      stream.reload();

      // Cut before the earliest comment start so `@--x` → `@` and `@/*` → `@`.
      let cut = raw.length;
      for (const seq of stopAt) {
        const idx = raw.indexOf(seq);
        if (idx !== -1 && idx < cut) cut = idx;
      }
      let value = raw.slice(0, cut);

      // Trim trailing `+`/`-` (PG lets `a=-1` lex as `=` then `-1`), unless the
      // operator contains a char that makes a trailing sign significant (`@-`).
      if (![...value].some((char) => noTrailing.unless.includes(char))) {
        while (value.length > 1 && noTrailing.chars.includes(value[value.length - 1]!)) {
          value = value.slice(0, -1);
        }
      }

      if (value.length === 0) return null; // e.g. a bare comment start — fall through
      for (const _ of value) stream.next();
      return { value };
    },
  };
};

// True when `seq` appears next, without consuming it. Uses the single snapshot
// slot, so it must not run inside a caller's pending snapshot.
const peeksSeq = (input: InputStream, seq: string): boolean => {
  input.snapshot();
  for (const char of seq) {
    if (input.peek() !== char) {
      input.reload();
      return false;
    }
    input.next();
  }
  input.reload();
  return true;
};

// Word-valued tokens after which `/` still begins a regex in JS: keyword heads
// of statements/expressions. Value-like keywords (`this`, `true`, `false`,
// `null`, `super`) end an expression and take division instead, so they are
// deliberately absent.
const REGEX_AFTER_WORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

// The default JS division-vs-regex predicate. It classifies `lastToken` by
// value shape (the kit doesn't know which token type is "an identifier"):
// word-shaped values are identifiers/keywords, digit-led values are numbers,
// `)`/`]` close expressions, and a backtick is a template tail (the opening
// backtick is never consulted — template mode has no regex reader). String
// tokens carry their decoded content, so word- or digit-shaped content
// classifies correctly and exotic content is the author's cue to override.
const defaultRegexAllowedAfter = (ctx: LexContext): boolean => {
  const last = ctx.lastToken;
  if (last === null) return true;
  const value = last.value;
  if (/^[A-Za-z_$]/.test(value)) return REGEX_AFTER_WORDS.has(value);
  if (value === ")" || value === "]" || value === "`") return false;
  if (/^\.?[0-9]/.test(value)) return false;
  return true;
};

// JS regular-expression literals, dispatched on the previous significant token
// (division never follows `=`/`(`/keywords; regex never follows an expression).
// Must come after the `//`//* comment readers in the array so comments win.
// `value` is the full raw literal including delimiters and flags.
const regex = <TT extends string>(
  type: TT,
  opts: { allowedAfter?: (ctx: LexContext) => boolean; display?: string } = {},
): Reader<TT> => {
  const allowedAfter = opts.allowedAfter ?? defaultRegexAllowedAfter;
  const isFlag = (char: string) => /[a-z]/i.test(char);

  return {
    type,
    display: opts.display,
    startsWith: (char, _stream, ctx) => char === "/" && allowedAfter(ctx),
    read: (stream) => {
      const startPosition = stream.position();
      const croakUnterminated = (): never =>
        stream.croak("Unterminated regular expression", startPosition, stream.position());

      let value = stream.next(); // opening `/`
      let inClass = false;
      while (true) {
        if (stream.eof() || stream.peek() === "\n" || stream.peek() === "\r") croakUnterminated();
        const char = stream.next();
        value += char;
        if (char === "\\") {
          if (stream.eof() || stream.peek() === "\n" || stream.peek() === "\r") croakUnterminated();
          value += stream.next();
        } else if (char === "[") {
          inClass = true;
        } else if (char === "]") {
          inClass = false;
        } else if (char === "/" && !inClass) {
          break;
        }
      }
      return { value: value + readWhile(stream, isFlag) };
    },
  };
};

// A run of template-literal text, up to (not including) the closing delimiter
// or the interpolation opener — both left for the mode's punctuation, which is
// what drives the mode transitions (Acorn's shape). Returns null on a delimiter
// so no empty chunks are emitted; a lone `$` is content. `value` is raw: an
// escape keeps its backslash, it only shields the next char from delimiter
// matching (cooked values are an AST concern — `map` on the chunk token).
const templateChunk = <TT extends string>(
  type: TT,
  opts: { exit?: string; enter?: string; escape?: string; display?: string } = {},
): Reader<TT> => {
  const exit = opts.exit ?? "`";
  const enter = opts.enter ?? "${";
  const escapeChar = opts.escape ?? "\\";

  return {
    type,
    display: opts.display,
    startsWith: () => true, // read() decides — null on a delimiter falls through
    read: (stream) => {
      const startPosition = stream.position();
      let value = "";
      while (!stream.eof()) {
        const char = stream.peek();
        if (char === exit[0] && peeksSeq(stream, exit)) break;
        if (char === enter[0] && peeksSeq(stream, enter)) break;
        value += stream.next();
        if (char === escapeChar && !stream.eof()) value += stream.next();
      }
      if (stream.eof()) {
        // Consume-to-EOF happened above, so recovery keeps its progress.
        stream.croak("Unterminated template", startPosition, stream.position());
      }
      if (value === "") return null;
      return { value };
    },
  };
};

const custom = <TT extends string>(
  type: TT,
  opts: {
    startsWith: CharClass;
    read: (stream: InputStream, ctx: LexContext) => ReaderResult<TT> | string | null;
    display?: string;
  },
): Reader<TT> => {
  const starts = charClassToPredicate(opts.startsWith);
  return {
    type,
    display: opts.display,
    startsWith: (char) => starts(char),
    read: (stream, ctx) => {
      const result = opts.read(stream, ctx);
      if (result === null) return null;
      return typeof result === "string" ? { value: result } : result;
    },
  };
};

export const readers = {
  number,
  string,
  dollarString,
  lineComment,
  blockComment,
  operator,
  regex,
  templateChunk,
  custom,
};
