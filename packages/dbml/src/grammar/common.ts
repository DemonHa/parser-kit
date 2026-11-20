import {
  custom,
  describeFound,
  type ParseContext,
  type Position,
  quoteList,
  type Rule,
  type Span,
  type Token,
} from "@parser-kit/core";
import { type DbmlTokenType, dedentNote, rawName } from "../lexer";
import type { Endpoint, Relation } from "./ref";

// The rules every construct shares: names, values, the settings framework and
// the body combinator. They are plain functions over the parse context, called
// from the `custom()` rules of each construct; keyword-or-name decisions are
// made by looking at tokens, never by backtracking.

export type TT = DbmlTokenType;
export type Ctx = ParseContext<TT>;
type Tok = Token<TT>;

// --- AST: names and values ---

/** A name as written: an identifier keeps its case, a quoted one is decoded and flagged. */
export interface Ident {
  value: string;
  quoted?: true;
  span: Span;
}

/** `schema.name` or `name`. */
export interface QualifiedName {
  schema: Ident | null;
  name: Ident;
  span: Span;
}

/**
 * `'…'`, `'''…'''` (`multiline`) or, where `@dbml/core` takes one as a string,
 * double-quoted text (`doubleQuoted`); decoded.
 */
export interface StringValue {
  kind: "string";
  value: string;
  multiline?: true;
  doubleQuoted?: true;
  span: Span;
}

/**
 * A number, any sign folded in. `raw` is the sign (if any) followed by the
 * literal as written, without any space between them, whenever that isn't
 * exactly what `String(value)` gives back for a safe integer: `1.50`, `1e2`,
 * `5.`, `007`, `+1`, `-0`.
 */
export interface NumberValue {
  kind: "number";
  value: number;
  raw?: string;
  span: Span;
}

export interface BooleanValue {
  kind: "boolean";
  value: boolean;
  span: Span;
}

export interface NullValue {
  kind: "null";
  span: Span;
}

/** A backtick expression; `value` is the raw text between the backticks. */
export interface ExpressionValue {
  kind: "expression";
  value: string;
  span: Span;
}

/** A color literal, `#` included (`#3498DB`). Whether it is valid hex is not checked. */
export interface ColorValue {
  kind: "color";
  value: string;
  span: Span;
}

/** A bare or quoted name used as a value (`varchar(MAX)`). */
export interface IdentifierValue {
  kind: "identifier";
  value: Ident;
  span: Span;
}

/** A reference to an enum value, `enum.value` or `schema.enum.value`. */
export interface EnumConstant {
  kind: "enumConstant";
  path: Ident[];
  span: Span;
}

export type Value =
  | StringValue
  | NumberValue
  | BooleanValue
  | NullValue
  | ExpressionValue
  | ColorValue
  | IdentifierValue
  | EnumConstant;

// --- Token helpers ---

export const isPunc = (token: Tok | null, value: string): boolean =>
  token !== null && token.type === "punc" && token.value === value;

/** An identifier token spelling `word` in any case (the parse stream folds identifiers). */
export const isWord = (token: Tok | null, word: string): boolean =>
  token !== null && token.type === "ident" && token.value === word;

export const isName = (token: Tok | null): boolean =>
  token !== null && (token.type === "ident" || token.type === "qident");

export const isNewline = (token: Tok | null): boolean => isPunc(token, "\n");

/** True at a line break, the end of input or a body's `}`: where a line may end. */
export const atLineEnd = (ctx: Ctx): boolean => {
  const token = ctx.peek();
  return token === null || isNewline(token) || isPunc(token, "}");
};

/** The first token after any line breaks `from` tokens past the cursor, without consuming anything. */
export const peekPastNewlines = (ctx: Ctx, from = 0): Tok | null => {
  let n = from;
  while (isNewline(ctx.peekAhead(n))) n++;
  return ctx.peekAhead(n);
};

/** Join already-rendered options: `"a"`, `"a" or "b"`, `"a", "b" or "c"`. */
export const quoteOptions = (options: readonly string[]): string =>
  options.length <= 1 ? (options[0] ?? "") : `${options.slice(0, -1).join(", ")} or ${options[options.length - 1]}`;

export const skipNewlines = (ctx: Ctx): void => {
  while (isNewline(ctx.peek())) ctx.next();
};

/**
 * Consume the `.` of a dotted name if one comes next. Line breaks may sit on
 * either side of it, as in `@dbml/core` (`s\n.t` is `s.t`).
 */
export const eatDot = (ctx: Ctx): boolean => {
  if (!isPunc(peekPastNewlines(ctx), ".")) return false;
  skipNewlines(ctx);
  ctx.next();
  skipNewlines(ctx);
  return true;
};

/**
 * Fail unless whitespace separates the next token from the last one:
 * `@dbml/core` rejects `"id"int`, `int(1)pk` and a settings list glued to a
 * name (`Table a[note: 'x']`).
 */
export const expectSpace = (ctx: Ctx): void => {
  // A line break token ends at column 0 of the next line, where only a token
  // after the break can start: that is not a glued token.
  const end = ctx.lastEnd();
  if (end.col !== 0 && touches(end, ctx.peek())) fail(ctx, "a space");
};

/**
 * What turned up, for an error message: like core's `describeFound`, but an
 * identifier is shown as written, and a string, a quoted identifier or an
 * expression by its kind (its decoded text could pass for something else).
 */
export const describeToken = (token: Tok | null): string => {
  if (token === null) return describeFound(token);
  switch (token.type) {
    case "ident":
      return `"${rawName(token)}"`;
    case "string":
    case "blockString":
      return "a string";
    case "expression":
      return "an expression";
    case "qident":
      return "a quoted identifier";
    default:
      return describeFound(token);
  }
};

/** Fail with the core-style `Expected X but found Y`, pointing at the next token. */
export function fail(ctx: Ctx, expected: string): never {
  return ctx.croak(`Expected ${expected} but found ${describeToken(ctx.peek())}`);
}

export const expectPunc = (ctx: Ctx, value: string, expected = quoteList(value)): Tok => {
  if (!isPunc(ctx.peek(), value)) fail(ctx, expected);
  return ctx.next()!;
};

export const expectWord = (ctx: Ctx, word: string, expected = quoteList(word)): Tok => {
  if (!isWord(ctx.peek(), word)) fail(ctx, expected);
  return ctx.next()!;
};

/** Two tokens touch when nothing, not even a space, separates them. */
export const touches = (end: Position, token: Tok | null): boolean =>
  token !== null && token.position.start.row === end.row && token.position.start.col === end.col;

/** A line's content is over: the next token must end it (a line break, `}` or the end of input). */
export const expectLineEnd = (ctx: Ctx, expected = "a new line"): void => {
  if (!atLineEnd(ctx)) fail(ctx, expected);
};

// --- Names ---

export const identFrom = (token: Tok): Ident =>
  token.type === "qident"
    ? { value: token.value, quoted: true, span: { ...token.position } }
    : { value: rawName(token), span: { ...token.position } };

/** An identifier or a quoted identifier. */
export const readIdent = (ctx: Ctx, expected = "a name"): Ident => {
  if (!isName(ctx.peek())) fail(ctx, expected);
  return identFrom(ctx.next()!);
};

/** `name` or `schema.name`. */
export const readQualifiedName = (ctx: Ctx, expected = "a name"): QualifiedName => {
  const first = readIdent(ctx, expected);
  if (!eatDot(ctx)) return { schema: null, name: first, span: first.span };
  const name = readIdent(ctx);
  return { schema: first, name, span: { start: first.span.start, end: name.span.end } };
};

/** An optional `as alias` after a table or enum name. */
export const readAlias = (ctx: Ctx): Ident | null => {
  if (!isWord(ctx.peek(), "as")) return null;
  ctx.next();
  skipNewlines(ctx);
  return readIdent(ctx, "an alias");
};

// --- Values ---

export const stringFrom = (token: Tok): StringValue => ({
  kind: "string",
  value: token.value,
  ...(token.type === "blockString" && { multiline: true as const }),
  ...(token.type === "qident" && { doubleQuoted: true as const }),
  span: { ...token.position },
});

/**
 * A string token. `@dbml/core` also reads double-quoted text as a string
 * wherever a string value is expected, so a `qident` counts here too.
 */
export const isString = (token: Tok | null): boolean =>
  token !== null && (token.type === "string" || token.type === "blockString" || token.type === "qident");

/** A backtick expression. */
export const readExpression = (ctx: Ctx): ExpressionValue => {
  const token = ctx.peek();
  if (token?.type !== "expression") return fail(ctx, "an expression");
  ctx.next();
  return { kind: "expression", value: token.value, span: { ...token.position } };
};

export const readString = (ctx: Ctx, expected = "a string"): StringValue => {
  if (!isString(ctx.peek())) fail(ctx, expected);
  return stringFrom(ctx.next()!);
};

/** A note's text: a string, dedented the way `@dbml/core` dedents notes. */
export const readNoteString = (ctx: Ctx): StringValue => {
  const value = readString(ctx);
  return { ...value, value: dedentNote(value.value) };
};

/** True when a number, or a sign that a number may follow, is next. */
export const atNumber = (ctx: Ctx): boolean => {
  const token = ctx.peek();
  return token !== null && (token.type === "number" || isPunc(token, "-") || isPunc(token, "+"));
};

/**
 * A number with an optional leading `-` or `+` (spaces may separate the sign,
 * and line breaks too with `breaksAfterSign`).
 */
export const readNumber = (ctx: Ctx, breaksAfterSign = false): NumberValue => {
  const start = ctx.position();
  let sign = "";
  if (isPunc(ctx.peek(), "-") || isPunc(ctx.peek(), "+")) {
    sign = ctx.next()!.value;
    if (breaksAfterSign) skipNewlines(ctx);
  }
  if (ctx.peek()?.type !== "number") fail(ctx, "a number");
  const text = ctx.next()!.value;
  const magnitude = Number(text);
  const value = sign === "-" ? -magnitude : magnitude;
  const written = sign + text;
  const exact = Number.isSafeInteger(value) && written === String(value);
  return { kind: "number", value, ...(!exact && { raw: written }), span: ctx.spanFrom(start) };
};

/** True when an enum value (`enum.value`, `schema.enum.value`) comes next: a name, then a dot. */
export const atEnumConstant = (ctx: Ctx): boolean => isName(ctx.peek()) && isPunc(peekPastNewlines(ctx, 1), ".");

/** An enum value, `enum.value` or `schema.enum.value`; line breaks may surround the dots. */
export const readEnumConstant = (ctx: Ctx): EnumConstant => {
  const path = [readIdent(ctx)];
  while (path.length < 3 && eatDot(ctx)) {
    path.push(readIdent(ctx, "an enum value"));
  }
  return { kind: "enumConstant", path, span: ctx.spanFrom(path[0]!.span.start) };
};

export const isBooleanWord = (token: Tok | null): boolean => isWord(token, "true") || isWord(token, "false");

export const readBoolean = (ctx: Ctx): BooleanValue => {
  const token = ctx.next()!;
  return { kind: "boolean", value: token.value === "true", span: { ...token.position } };
};

export const readColor = (ctx: Ctx): ColorValue => {
  if (ctx.peek()?.type !== "color") fail(ctx, "a color");
  const token = ctx.next()!;
  return { kind: "color", value: token.value, span: { ...token.position } };
};

/** The word `none` (any case): `@dbml/core` takes it as a custom property value and as a sticky note's `color`. */
export const readNone = (ctx: Ctx): IdentifierValue => {
  const value = identFrom(ctx.next()!);
  return { kind: "identifier", value, span: value.span };
};

/** What a custom property may hold: a string, a number, a boolean, a color or `none`. */
export const readPropertyValue = (ctx: Ctx): Value => {
  const token = ctx.peek();
  if (isString(token)) return stringFrom(ctx.next()!);
  if (atNumber(ctx)) return readNumber(ctx);
  if (isBooleanWord(token)) return readBoolean(ctx);
  if (token?.type === "color") return readColor(ctx);
  if (isWord(token, "none")) return readNone(ctx);
  return fail(ctx, 'a string, a number, a boolean, a color or "none"');
};

// --- Settings ---

/** `[ … ]` items, in source order, duplicates kept. */
export type Setting =
  | { kind: "pk"; spelling: "pk" | "primary key"; bare?: true; span: Span }
  | { kind: "null"; not: boolean; span: Span }
  | { kind: "unique"; bare?: true; span: Span }
  | { kind: "increment" | "inactive"; span: Span }
  | { kind: "example"; span: Span }
  | { kind: "default"; value: Value; span: Span }
  | { kind: "note"; value: StringValue; span: Span }
  | { kind: "ref"; relation: Relation; target: Endpoint; span: Span }
  | {
      kind: "action";
      on: "delete" | "update";
      action: "cascade" | "restrict" | "set null" | "set default" | "no action";
      span: Span;
    }
  | { kind: "property"; key: Ident; value: Value; span: Span };

/**
 * What one context accepts inside `[ … ]`. `flags` are settings without a
 * value, keyed by their lowercase words (`"primary key"`); `values` are
 * `key: value` settings keyed by their lowercase key. With `custom`, any other
 * `key: value` is a `property` (custom properties: a key of one or more words
 * and a string, number, boolean, color or `none` value).
 */
export interface SettingsSpec {
  /** What one setting of this context is called in error messages (`a column setting`). */
  display: string;
  flags: Readonly<Record<string, (span: Span) => Setting>>;
  values: Readonly<Record<string, (ctx: Ctx, key: Ident, start: Position) => Setting>>;
  custom: boolean;
}

/** A known `key: color` setting (`headercolor`, `color`): a property with a lowercase key. */
export const colorSetting = (ctx: Ctx, key: Ident, start: Position): Setting => {
  const value = readColor(ctx);
  return { kind: "property", key: { ...key, value: key.value.toLowerCase() }, value, span: ctx.spanFrom(start) };
};

export const noteSetting = (ctx: Ctx, _key: Ident, start: Position): Setting => {
  const value = readNoteString(ctx);
  return { kind: "note", value, span: ctx.spanFrom(start) };
};

// One setting: the words of its key, then either nothing (a flag) or `:` and a
// value. The key's words decide which it is.
const readSetting = (ctx: Ctx, spec: SettingsSpec): Setting => {
  const start = ctx.position();
  if (ctx.peek()?.type !== "ident") fail(ctx, spec.display);
  const words: Tok[] = [];
  while (ctx.peek()?.type === "ident") words.push(ctx.next()!);
  const folded = words.map((word) => word.value).join(" ");
  const key: Ident = {
    value: words.map(rawName).join(" "),
    span: { start: words[0]!.position.start, end: words[words.length - 1]!.position.end },
  };
  const unknownKey = (): never => {
    const names = [...Object.keys(spec.flags), ...Object.keys(spec.values)];
    return ctx.croak(`Expected ${quoteList(names)} but found "${key.value}"`, key.span.start, key.span.end);
  };
  if (!isPunc(ctx.peek(), ":")) {
    const flag = spec.flags[folded];
    if (flag !== undefined) return flag(ctx.spanFrom(start));
    if (spec.custom) return fail(ctx, '":"');
    // Without custom keys, words after a known key can only be a missing
    // comma (after a flag, `pk unique`) or colon (after a valued key, `note x`):
    // point at the first word after it.
    for (let n = words.length - 1; n > 0; n--) {
      const prefix = words
        .slice(0, n)
        .map((word) => word.value)
        .join(" ");
      const missing =
        spec.flags[prefix] !== undefined ? '"," or "]"' : spec.values[prefix] !== undefined ? '":"' : null;
      if (missing !== null) {
        const next = words[n]!;
        return ctx.croak(
          `Expected ${missing} but found ${describeToken(next)}`,
          next.position.start,
          next.position.end,
        );
      }
    }
    return spec.values[folded] !== undefined ? fail(ctx, '":"') : unknownKey();
  }
  if (spec.flags[folded] !== undefined) fail(ctx, '"," or "]"');
  ctx.next();
  const known = spec.values[folded];
  if (known !== undefined) return known(ctx, key, start);
  if (!spec.custom) return unknownKey();
  const value = readPropertyValue(ctx);
  return { kind: "property", key, value, span: ctx.spanFrom(start) };
};

/**
 * A settings list, `[a, b: c]`. It may be empty and may span lines (the lexer
 * drops newlines inside brackets), but takes no stray or trailing comma.
 */
export const readSettings = (ctx: Ctx, spec: SettingsSpec): Setting[] => {
  expectPunc(ctx, "[");
  const settings: Setting[] = [];
  if (isPunc(ctx.peek(), "]")) {
    ctx.next();
    return settings;
  }
  for (;;) {
    settings.push(readSetting(ctx, spec));
    if (isPunc(ctx.peek(), "]")) {
      ctx.next();
      return settings;
    }
    expectPunc(ctx, ",", '"," or "]"');
  }
};

/** A settings list if one comes next, else `[]`. */
export const readOptionalSettings = (ctx: Ctx, spec: SettingsSpec): Setting[] => {
  if (!isPunc(ctx.peek(), "[")) return [];
  expectSpace(ctx);
  return readSettings(ctx, spec);
};

/**
 * The settings list of an element header, if one comes next, and the line
 * breaks before its `{`. `@dbml/core` reads a `[` after a line break that
 * directly follows the name as part of that name, so the list may start on a
 * later line only when a space or a comment ends the name's line. (The lexer
 * drops a `\r` like a space, so a CRLF line ending counts as one here;
 * `@dbml/core` does not count it.) `settingsAllowed` says whether a `[` could
 * still have come where the cursor stops, for the caller's error message.
 */
export const readHeaderSettings = (
  ctx: Ctx,
  spec: SettingsSpec,
): { settings: Setting[]; hasSettings: boolean; settingsAllowed: boolean } => {
  const spacedBreak = isNewline(ctx.peek()) && !touches(ctx.lastEnd(), ctx.peek());
  if (spacedBreak && isPunc(peekPastNewlines(ctx), "[")) skipNewlines(ctx);
  const hasSettings = isPunc(ctx.peek(), "[");
  const settings = readOptionalSettings(ctx, spec);
  const settingsAllowed = !hasSettings && (spacedBreak || !isNewline(ctx.peek()));
  skipNewlines(ctx);
  return { settings, hasSettings, settingsAllowed };
};

// --- Bodies ---

/**
 * A `{ … }` body of line items: blank lines may appear anywhere, each item
 * ends at a line break, and the close may follow the last item on its line,
 * so a whole body may sit on one line (`Table a { id int }`). Reaching the end
 * of input before `}` fails. `item` reads one item and leaves the cursor at its
 * line's end.
 */
export const readBody = <T>(ctx: Ctx, item: (ctx: Ctx) => T): T[] => {
  expectPunc(ctx, "{");
  const items: T[] = [];
  for (;;) {
    skipNewlines(ctx);
    if (isPunc(ctx.peek(), "}")) {
      ctx.next();
      return items;
    }
    if (ctx.eof()) fail(ctx, '"}"');
    items.push(item(ctx));
    if (ctx.eof()) fail(ctx, '"}"');
    if (!isNewline(ctx.peek()) && !isPunc(ctx.peek(), "}")) fail(ctx, 'a new line or "}"');
  }
};

// --- Elements ---

/** A top-level element kind: its keyword (lowercase), its display and its rule. */
export interface ElementEntry<T> {
  keyword: string;
  display: string;
  rule: Rule<T, TT>;
}

/**
 * A keyword-led element. `parse` runs after the keyword is consumed and gets
 * the element's start for its span.
 */
export const defineElement = <T extends { type: string }>(
  keyword: string,
  display: string,
  parse: (ctx: Ctx, start: Position) => T,
): ElementEntry<T> => ({
  keyword,
  display,
  rule: custom<T, TT>(
    (ctx) => {
      const start = ctx.position();
      expectWord(ctx, keyword, `"${display}"`);
      return parse(ctx, start);
    },
    { expected: `"${display}"`, first: [{ type: "ident", value: keyword }] },
  ),
});
