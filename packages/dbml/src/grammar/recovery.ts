import { ParseError, type Position, type Token } from "@parser-kit/core";
import type { Ctx, TT } from "./common";

// Error recovery for `diagnose`. Three layers resynchronise, innermost first:
//
//   - a settings list skips a bad setting to its next `,` or `]`;
//   - a `{ … }` body skips a bad line to its line break or its `}`;
//   - the top level skips a bad element to the next element keyword that
//     starts a line outside any braces.
//
// Each layer records the error with core's `ctx.report()`, which returns false
// under `parse`, so the error is rethrown there and `parse` still stops at the
// first one. The skips are package-local: core's sync points match single
// tokens, while DBML resynchronises by line and brace depth, and its element
// keywords are also valid names inside bodies.
//
// Cascades are suppressed here rather than at each call site (see `report`).
// A construct that resynchronised past its own `}` and has nothing to return
// rethrows the error it already reported; the enclosing layer then resumes
// where the cursor stands instead of skipping again (a body still reports
// junk after that `}` on the same line, as after any complete item).

interface RecoveryState {
  /** Errors already recorded, so a rethrown one isn't recorded twice. */
  reported: WeakSet<ParseError>;
  /** Where the last recorded error starts. */
  last: Position | null;
  /** A skip ran into the end of the input: the rest of the input is accounted for. */
  exhausted: boolean;
  /** Where the last recorded lexer error starts. */
  lexer: Position | null;
}

const states = new WeakMap<Ctx, RecoveryState>();

const stateOf = (ctx: Ctx): RecoveryState => {
  let state = states.get(ctx);
  if (state === undefined) {
    state = { reported: new WeakSet(), last: null, exhausted: false, lexer: null };
    states.set(ctx, state);
  }
  return state;
};

/** True for an error some inner layer has recorded and resynchronised after. */
export const wasReported = (ctx: Ctx, error: unknown): boolean =>
  error instanceof ParseError && stateOf(ctx).reported.has(error);

const samePlace = (a: Position, b: Position): boolean => a.row === b.row && a.col === b.col;
const notBefore = (a: Position, b: Position): boolean => a.row > b.row || (a.row === b.row && a.col >= b.col);

/**
 * Record `error` for `diagnose`; false under `parse`, where the caller
 * rethrows it. A cascade is dropped but still counts as handled:
 *
 *   - an error already recorded (rethrown by a construct that resynchronised);
 *   - one starting where the last recorded one starts (a list and the body
 *     around it both unclosed at the end of input);
 *   - anything after a skip ran into the end of the input (an unterminated
 *     string or comment that swallowed the rest leaves every enclosing `}`
 *     missing);
 *   - a parser error while the cursor hasn't yet passed the last recorded
 *     lexer error, which lookahead can raise before the tokens in front of it
 *     are consumed (the same swallowed rest, met without a skip).
 *
 * Nothing is ever dropped under `parse`: before the first error is recorded,
 * none of these can hold.
 */
export const report = (ctx: Ctx, error: unknown): boolean => {
  if (!(error instanceof ParseError)) return false;
  const state = stateOf(ctx);
  const cascade =
    state.reported.has(error) ||
    state.exhausted ||
    (state.last !== null && samePlace(state.last, error.start)) ||
    (!error.fromLexer && state.lexer !== null && notBefore(state.lexer, ctx.lastEnd()));
  if (cascade) return true;
  if (!ctx.report(error)) return false;
  state.reported.add(error);
  state.last = error.start;
  if (error.fromLexer) state.lexer = error.start;
  return true;
};

/**
 * The next token, recording any lexer error met on the way (the lexer consumes
 * what it croaked on, so peeking again makes progress), or null at the end of
 * the input, which marks the input exhausted.
 */
const peekReporting = (ctx: Ctx): Token<TT> | null => {
  for (;;) {
    let token: Token<TT> | null;
    try {
      token = ctx.peek();
    } catch (error) {
      if (!report(ctx, error)) throw error;
      continue;
    }
    if (token === null) stateOf(ctx).exhausted = true;
    return token;
  }
};

const isPunc = (token: Token<TT>, value: string): boolean => token.type === "punc" && token.value === value;

// Whether a token starts an element's header line; `root.ts` registers it, as
// the element registry imports the modules that import this one.
type ElementStart = (ctx: Ctx, token: Token<TT>) => boolean;
let startsElement: ElementStart = () => false;
export const registerElementStart = (test: ElementStart): void => {
  startsElement = test;
};

/**
 * True when a body has to end at this line: a string left open inside its
 * `[ … ]` swallowed its `}` (`[note: 'oops }`), so the line break before the
 * cursor is one the parse stream restored, and the line starts an element.
 */
export const bodyCutShort = (ctx: Ctx, afterRestoredBreak: boolean): boolean => {
  const token = ctx.peek();
  return afterRestoredBreak && token !== null && startsElement(ctx, token);
};

/**
 * Skip the rest of a bad body line: up to its line break or the body's `}`
 * (neither consumed), stepping over any `{ … }` on the way. False when the
 * input ran out first.
 */
export const skipLine = (ctx: Ctx): boolean => {
  let depth = 0;
  for (let token = peekReporting(ctx); token !== null; token = peekReporting(ctx)) {
    if (depth === 0 && (isPunc(token, "\n") || isPunc(token, "}"))) return true;
    if (isPunc(token, "{")) depth++;
    else if (isPunc(token, "}")) depth--;
    ctx.next();
  }
  return false;
};

/**
 * Skip the rest of a bad setting, up to the list's next `,` or `close` (not
 * consumed), stepping over nested brackets. (`close` is `)` for a records
 * header's column list.) It also stops at a brace or line
 * break, which can't be inside a list: the list was left open (a line break
 * shows inside one only when the parse stream restores it after a string left
 * open there). Returns what it stopped at.
 */
export const skipSetting = (ctx: Ctx, close: "]" | ")" = "]"): "," | "]" | ")" | null => {
  let depth = 0;
  for (let token = peekReporting(ctx); token !== null; token = peekReporting(ctx)) {
    if (isPunc(token, "{") || isPunc(token, "}") || isPunc(token, "\n")) return null;
    if (depth === 0 && (isPunc(token, ",") || isPunc(token, close))) return token.value as "," | "]" | ")";
    if (isPunc(token, "[") || isPunc(token, "(")) depth++;
    else if ((isPunc(token, "]") || isPunc(token, ")")) && depth > 0) depth--;
    ctx.next();
  }
  return null;
};

/**
 * Skip to just past the `}` closing a `{ … }` whose `{` is already consumed,
 * stepping over nested braces, or to the end of the input.
 */
export const skipPastClose = (ctx: Ctx): void => {
  let depth = 0;
  for (let token = peekReporting(ctx); token !== null; token = peekReporting(ctx)) {
    ctx.next();
    if (isPunc(token, "{")) depth++;
    else if (isPunc(token, "}") && depth-- === 0) return;
  }
};

/**
 * Skip a bad element, up to the next token for which `resumesAt` holds at
 * brace depth 0 at the start of a line (or right after a `}` that brings the
 * depth back to 0), or to the end of the input. A `}` with no `{` before it
 * (an element whose `{` was missing) leaves the depth at 0.
 */
export const skipElement = (ctx: Ctx, resumesAt: (token: Token<TT>) => boolean): void => {
  let depth = 0;
  let closed = false;
  for (let token = peekReporting(ctx); token !== null; token = peekReporting(ctx)) {
    // A line break token ends at column 0 of the next line, and nothing else
    // can end there: the cursor is at the start of a line.
    const lineStart = ctx.consumed() === 0 || ctx.lastEnd().col === 0 || closed;
    if (depth === 0 && lineStart && resumesAt(token)) return;
    ctx.next();
    closed = false;
    if (isPunc(token, "{")) depth++;
    else if (isPunc(token, "}")) {
      depth = Math.max(0, depth - 1);
      closed = depth === 0;
    }
  }
};
