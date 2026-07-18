import { describeFound, describeType, type TypeLabels } from "./describe";
import { ParseError } from "./error";
import type { Position, Span } from "./position";
import { matchesToken, type Token, type TokenMatch, type TokenStream } from "./token";

// An entry of a rule's LL(1) dispatch set. `value` narrows the match to one
// literal; a missing `type` (used by string-keyword expressions) matches any
// token with that value.
export interface FirstEntry<TT extends string = string> {
  type?: TT;
  value?: string;
}

export const matchesFirst = <TT extends string>(
  token: Token<TT> | null,
  entries: readonly FirstEntry<TT>[],
): boolean => {
  if (token === null) return false;
  return entries.some(
    (entry) =>
      (entry.type === undefined || entry.type === token.type) &&
      (entry.value === undefined || entry.value === token.value),
  );
};

export interface Printer {
  write(text: string): void;
}

// A schema value carrying its output type: the parser-kit equivalent of a zod
// schema. `Infer<typeof rule>` reads the phantom `_out`.
export interface Rule<T, TT extends string = string> {
  readonly _out: T;
  parse(ctx: ParseContext<TT>): T;
  first(): readonly FirstEntry<TT>[];
  expected(labels?: TypeLabels): string;
  map<U>(fn: (value: T, span: Span) => U, inverse?: (value: U) => T): Rule<U, TT>;
  describe(display: string): Rule<T, TT>;
  print?(value: T, out: Printer): void;
  /** True when the rule can succeed without consuming input (e.g. optional). */
  readonly nullable?: boolean;
  /** Set by attempt(): oneOf/optional try the rule with backtracking. */
  readonly backtracks?: boolean;
  readonly inverse?: (value: unknown) => unknown;
}

export type Infer<R> = R extends Rule<infer T, any> ? T : never;

// The token vocabulary a rule is written against. Combinators derive their TT
// from their arguments with this, since TS cannot reliably infer a type
// parameter that only appears in a generic constraint.
export type RuleTT<R> = R extends Rule<any, infer TT> ? TT : never;

// Sync points for diagnose() recovery. `consume: true` skips past the token
// (statement terminators like ";"), false resumes on it (construct keywords).
export interface SyncPoint<TT extends string = string> extends TokenMatch<TT> {
  consume?: boolean;
}

// Safe façade over the token stream — what rules and custom() parsers see.
export interface ParseContext<TT extends string = string> {
  peek(): Token<TT> | null;
  /**
   * Look `n` tokens past the cursor without consuming; peekAhead(0) === peek().
   * Raw tokens — no trivia skipping (SQL lookahead wants exact tokens).
   */
  peekAhead(n: number): Token<TT> | null;
  next(): Token<TT> | null;
  eof(): boolean;
  is(type: TT, value?: string | readonly string[]): boolean;
  eat(type: TT, value?: string | readonly string[]): Token<TT> | null;
  parse<T>(rule: Rule<T, TT>): T;
  tryParse<T>(rule: Rule<T, TT>): T | null;
  position(): Position;
  croak(msg: string, start?: Position, end?: Position): never;
  // --- engine surface (also available to custom() parsers) ---
  /** End position of the last consumed token; used to close spans. */
  lastEnd(): Position;
  /** Span from `start` to the last consumed token. */
  spanFrom(start: Position): Span;
  /** Human label for a token type, from the lexer's display config. */
  label(type: string): string;
  /** True when the token is skippable trivia per the grammar's policy. */
  isTrivia(token: Token<TT>): boolean;
  /** Skip any trivia tokens at the cursor. */
  skipTrivia(): void;
  /**
   * Recovery hook: records the error and skips ahead to the next sync point.
   * Returns false when no error collector is installed (strict parse mode).
   */
  recover(error: ParseError): boolean;
  /**
   * Record-only sibling of recover(): pushes the error to the collector and
   * leaves resynchronization to the caller. False in strict parse mode.
   */
  report(error: ParseError): boolean;
  /**
   * Deepest croak() seen so far — survives tryParse rollback, cleared each
   * time an error is recorded. Fuels the preferFarthest error-reporting mode.
   */
  farthestError(): ParseError | null;
  /** Number of tokens consumed so far — used for progress guarantees. */
  consumed(): number;
}

export interface ContextConfig<TT extends string = string> {
  labels?: TypeLabels;
  trivia?: readonly TokenMatch<TT>[];
  sync?: readonly SyncPoint<TT>[];
  errors?: ParseError[];
  /** Substitute the farthest croak for shallower errors as they are recorded. */
  preferFarthest?: boolean;
}

export function createParseContext<TT extends string>(
  stream: TokenStream<TT>,
  config: ContextConfig<TT> = {},
): ParseContext<TT> {
  const { labels, trivia = [], sync = [], errors, preferFarthest = false } = config;

  // Ring buffer of tokens already pulled off the stream. Only grows while a
  // tryParse snapshot is active; compacted back to empty once none is.
  let buffer: Token<TT>[] = [];
  let bufferPos = 0;
  const snapshots: { pos: number; last: Position | null; count: number }[] = [];
  let last: Position | null = null;
  let count = 0;

  // High-water mark of croak() failures, by tokens consumed. Deliberately not
  // part of the tryParse snapshot: surviving backtracking is the point.
  let farthest: ParseError | null = null;

  const peek = (): Token<TT> | null => {
    const buffered = buffer[bufferPos];
    if (buffered !== undefined) return buffered;
    return stream.peek();
  };

  const peekAhead = (n: number): Token<TT> | null => {
    // Fill the ring buffer ahead of the cursor, independent of snapshots;
    // next() drains it back down and resets it once fully replayed.
    while (buffer.length - bufferPos <= n) {
      const token = stream.next();
      if (token === null) break;
      buffer.push(token);
    }
    return buffer[bufferPos + n] ?? null;
  };

  const next = (): Token<TT> | null => {
    let token = buffer[bufferPos];
    if (token !== undefined) {
      bufferPos++;
      if (snapshots.length === 0 && bufferPos === buffer.length) {
        buffer = [];
        bufferPos = 0;
      }
    } else {
      token = stream.next() ?? undefined;
      if (token !== undefined && snapshots.length > 0) {
        buffer.push(token);
        bufferPos++;
      }
    }
    if (token !== undefined) {
      last = token.position.end;
      count++;
    }
    return token ?? null;
  };

  const compact = () => {
    if (snapshots.length === 0 && buffer.length > 0) {
      buffer = buffer.slice(bufferPos);
      bufferPos = 0;
    }
  };

  const eof = () => peek() === null;

  const is = (type: TT, value?: string | readonly string[]) => {
    const token = peek();
    if (!token || token.type !== type) return false;
    if (value === undefined) return true;
    return typeof value === "string" ? token.value === value : value.includes(token.value);
  };

  const position = () => {
    const token = peek();
    return token ? token.position.start : stream.position();
  };

  const lastEnd = () => last ?? position();

  const croak = (msg: string, start?: Position, end?: Position): never => {
    const token = peek();
    const fallback = token ? token.position : { start: stream.position(), end: stream.position() };
    const error = new ParseError(msg, start ?? fallback.start, end ?? fallback.end);
    error.consumed = count;
    // Strictly greater, so the first error at the farthest depth wins: a
    // describe() relabel croaks at the same count as the error it replaces,
    // and ties go to whichever error is actually thrown.
    if (farthest === null || count > farthest.consumed!) farthest = error;
    throw error;
  };

  // Recording path shared by recover() and report(). With preferFarthest, a
  // strictly deeper croak from a discarded backtracking branch replaces the
  // shallower error actually thrown; hand-built errors (no consumed stamp)
  // are recorded as-is. The high-water mark is cleared either way so a stale
  // deep failure can't shadow errors from whatever parses next.
  const record = (error: ParseError) => {
    const deeper =
      preferFarthest && farthest !== null && error.consumed !== undefined && farthest.consumed! > error.consumed;
    errors!.push(deeper ? farthest! : error);
    farthest = null;
  };

  const ctx: ParseContext<TT> = {
    peek,
    peekAhead,
    next,
    eof,
    is,
    eat: (type, value) => (is(type, value) ? next() : null),
    parse: (rule) => rule.parse(ctx),
    tryParse: (rule) => {
      snapshots.push({ pos: bufferPos, last, count });
      try {
        const value = rule.parse(ctx);
        snapshots.pop();
        compact();
        return value;
      } catch (error) {
        const snapshot = snapshots.pop()!;
        if (error instanceof ParseError) {
          bufferPos = snapshot.pos;
          last = snapshot.last;
          count = snapshot.count;
          compact();
          return null;
        }
        compact();
        throw error;
      }
    },
    position,
    croak,
    lastEnd,
    spanFrom: (start) => ({ start, end: lastEnd() }),
    label: (type) => describeType(type, labels),
    isTrivia: (token) => trivia.some((match) => matchesToken(token, match)),
    skipTrivia: () => {
      let token = peek();
      while (token !== null && ctx.isTrivia(token)) {
        next();
        token = peek();
      }
    },
    recover: (error) => {
      if (!errors) return false;
      record(error);
      // Skip ahead to the next sync point so parsing can resume. Lexer errors
      // hit while skipping are collected too.
      while (true) {
        let token: Token<TT> | null;
        try {
          token = peek();
        } catch (lexError) {
          if (lexError instanceof ParseError) {
            // The lexer consumes the offending character before croaking, so
            // recording the error and looping again makes progress.
            errors.push(lexError);
            continue;
          }
          throw lexError;
        }
        if (token === null) return true;
        const point = sync.find((entry) => matchesToken(token, entry));
        if (point) {
          if (point.consume) next();
          return true;
        }
        next();
      }
    },
    report: (error) => {
      if (!errors) return false;
      record(error);
      return true;
    },
    farthestError: () => farthest,
    consumed: () => count,
  };

  return ctx;
}

interface RuleImpl<T, TT extends string> {
  parse(ctx: ParseContext<TT>): T;
  first(): readonly FirstEntry<TT>[];
  expected(labels?: TypeLabels): string;
  nullable?: boolean;
  backtracks?: boolean;
  print?(value: T, out: Printer): void;
  inverse?: (value: unknown) => unknown;
}

// Builds a Rule from its three core operations, adding the shared map() /
// describe() plumbing every combinator gets for free.
export function makeRule<T, TT extends string = string>(impl: RuleImpl<T, TT>): Rule<T, TT> {
  const rule: Rule<T, TT> = {
    _out: undefined as T,
    parse: impl.parse,
    first: impl.first,
    expected: impl.expected,
    nullable: impl.nullable,
    backtracks: impl.backtracks,
    print: impl.print,
    inverse: impl.inverse,
    map: (fn, inverse) =>
      makeRule({
        parse: (ctx) => {
          const start = ctx.position();
          const value = rule.parse(ctx);
          return fn(value, ctx.spanFrom(start));
        },
        first: () => rule.first(),
        expected: (labels) => rule.expected(labels),
        nullable: rule.nullable,
        backtracks: rule.backtracks,
        inverse: inverse as ((value: unknown) => unknown) | undefined,
      }),
    describe: (display) =>
      makeRule({
        parse: (ctx) => {
          const before = ctx.consumed();
          try {
            return rule.parse(ctx);
          } catch (error) {
            // A failure on the very first token gets the new label; failures
            // deeper inside the rule keep their more precise message.
            if (error instanceof ParseError && ctx.consumed() === before) {
              croakExpected(ctx, display);
            }
            throw error;
          }
        },
        first: () => rule.first(),
        expected: () => display,
        nullable: rule.nullable,
        backtracks: rule.backtracks,
      }),
  };
  return rule;
}

// Shared "Expected X but found Y" failure used by token-level rules.
export const croakExpected = <TT extends string>(ctx: ParseContext<TT>, expected: string): never => {
  return ctx.croak(`Expected ${expected} but found ${describeFound(ctx.peek())}`);
};

// describeType(type, labels) does `labels?.[type]` — give rules a live view
// onto the context's label table instead of a copied record.
export const contextLabels = <TT extends string>(ctx: ParseContext<TT>): TypeLabels =>
  new Proxy({} as TypeLabels, {
    get: (_target, key) => (typeof key === "string" ? ctx.label(key) : undefined),
    has: () => true,
  });
