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
  /** Where the last recorded lexer error that swallowed the rest of its line (`Unterminated …`) starts. */
  swallowed: Position | null;
}

const states = new WeakMap<Ctx, RecoveryState>();

const stateOf = (ctx: Ctx): RecoveryState => {
  let state = states.get(ctx);
  if (state === undefined) {
    state = { reported: new WeakSet(), last: null, exhausted: false, lexer: null, swallowed: null };
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
  if (error.fromLexer && error.msg.startsWith("Unterminated ")) state.swallowed = error.start;
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

// Where a lexer error that swallowed the rest of its line (an unterminated
// string or the like) starts, if one was recorded since `open` (a construct's
// `{`): it may have taken the construct's `}` with it.
const swallowedSince = (ctx: Ctx, open: Position): Position | null => {
  const swallowed = states.get(ctx)?.swallowed ?? null;
  return swallowed !== null && notBefore(swallowed, open) ? swallowed : null;
};

/**
 * True when the `}` of a construct opened at `open` is likely gone: a lexer
 * error since then swallowed the rest of its line, nothing was read after it
 * (no item started at or after it: `itemStart` is where the last one did),
 * and the cursor is at the end of the input or on a later line that starts an
 * element. The construct then ends where it stands, with no error of its own.
 */
export const closeSwallowed = (ctx: Ctx, open: Position, itemStart: Position | null = null): boolean => {
  const swallowed = swallowedSince(ctx, open);
  if (swallowed === null || (itemStart !== null && notBefore(itemStart, swallowed))) return false;
  const token = ctx.peek();
  return token === null || (token.position.start.row > swallowed.row && startsElement(ctx, token));
};

/**
 * True when a body opened at `open` has to end before this line, which starts
 * an element: see `closeSwallowed`, or (`openSwallowed`, see
 * `readHeaderSettings`) the header's `{` went the same way and no item has been
 * read yet.
 */
export const bodyCutShort = (ctx: Ctx, open: Position, itemStart: Position | null, openSwallowed: boolean): boolean => {
  const token = ctx.peek();
  if (token === null) return false;
  if (openSwallowed && itemStart === null && startsElement(ctx, token)) return true;
  return closeSwallowed(ctx, open, itemStart);
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
 * Skip to just past the `}` closing a `{ … }` whose `{` (at `open`) is
 * already consumed, stepping over nested braces, or to the end of the input.
 * At the end of a line where a lexer error inside it swallowed the rest, and
 * so possibly that `}`, the skip stops instead (the line break not consumed).
 * With `ownLine` (a block whose `{` ended its line, so its `}` likely has a
 * line of its own) it goes on to a line that opens with `}` and consumes that,
 * but stops before a line that starts an element.
 */
export const skipPastClose = (ctx: Ctx, open: Position, ownLine = false): void => {
  let depth = 0;
  let lineStart = false;
  for (let token = peekReporting(ctx); token !== null; token = peekReporting(ctx)) {
    if (depth === 0 && lineStart && ownLine && swallowedSince(ctx, open) !== null) {
      if (isPunc(token, "}")) {
        ctx.next();
        return;
      }
      if (startsElement(ctx, token)) return;
    }
    if (depth === 0 && isPunc(token, "\n") && !ownLine && swallowedSince(ctx, open)?.row === token.position.start.row) {
      return;
    }
    lineStart = isPunc(token, "\n");
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
