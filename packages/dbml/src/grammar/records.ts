import { custom, type Span } from "@parser-kit/core";
import {
  atEnumConstant,
  atLineEnd,
  atNumber,
  type BooleanValue,
  type Ctx,
  defineElement,
  type EnumConstant,
  type ExpressionValue,
  expectLineEnd,
  expectPunc,
  expectSpace,
  fail,
  type Ident,
  isBooleanWord,
  isPunc,
  isString,
  isWord,
  lookAhead,
  type NullValue,
  type NumberValue,
  peekPastNewlines,
  type QualifiedName,
  readBody,
  readBoolean,
  readEnumConstant,
  readExpression,
  readHeaderSettings,
  readIdent,
  readNumber,
  readOptionalSettings,
  readQualifiedName,
  readString,
  type Setting,
  type SettingsSpec,
  type StringValue,
  skipNewlines,
  type TT,
} from "./common";
import { report, skipSetting } from "./recovery";

// Sample rows for a table, at the top level, `records table(col, …) { … }`, or
// inside the table, `records (col, …) { … }` with the column list optional.
// A row is a line of comma-separated fields (a one-field row may continue on
// a comma-led line, see `readRow`); a field may be empty (`1, , 3`, a trailing
// `1,`). Whether a row's field count or values fit the
// columns is not checked here.

/** A field with nothing in it; its span is empty, just after the comma before it (or at the row's start). */
export interface EmptyField {
  kind: "empty";
  span: Span;
}

/** A record field: a string, a number, a boolean, `null`, an expression, an enum value or nothing. */
export type RecordField =
  | StringValue
  | NumberValue
  | BooleanValue
  | NullValue
  | ExpressionValue
  | EnumConstant
  | EmptyField;

export interface RecordRow {
  fields: RecordField[];
  span: Span;
}

export interface Records {
  type: "records";
  /** The table the rows are for; null inside a table. */
  table: QualifiedName | null;
  /** The listed columns; null when a records block inside a table lists none. */
  columns: Ident[] | null;
  settings: Setting[];
  rows: RecordRow[];
  span: Span;
}

/** What a records block's settings list accepts. */
export const RECORDS_SETTINGS: SettingsSpec = {
  display: "a records setting",
  flags: { example: (span) => ({ kind: "example", span }) },
  values: {},
  custom: false,
};

// `(a, b)`; it may span lines (the lexer drops line breaks inside parentheses)
// and may be empty. Under `diagnose` a bad column name is dropped, as a bad
// setting is from a settings list, so the rows are still read.
const readColumnList = (ctx: Ctx): Ident[] => {
  expectPunc(ctx, "(");
  const columns: Ident[] = [];
  if (isPunc(ctx.peek(), ")")) {
    ctx.next();
    return columns;
  }
  for (;;) {
    try {
      columns.push(readIdent(ctx, "a column name"));
      if (isPunc(ctx.peek(), ")")) {
        ctx.next();
        return columns;
      }
      expectPunc(ctx, ",", '"," or ")"');
    } catch (error) {
      if (!report(ctx, error)) throw error;
      const stop = skipSetting(ctx, ")");
      if (stop === null) return columns;
      ctx.next();
      if (stop === ")") return columns;
    }
  }
};

const readField = (ctx: Ctx): Exclude<RecordField, EmptyField> => {
  const token = ctx.peek();
  if (atEnumConstant(ctx)) return readEnumConstant(ctx);
  if (isString(token)) return readString(ctx);
  // As in `@dbml/core`, line breaks may come between a sign and its number.
  if (atNumber(ctx)) return readNumber(ctx, true);
  if (token?.type === "expression") return readExpression(ctx);
  if (isBooleanWord(token)) return readBoolean(ctx);
  if (isWord(token, "null")) return { kind: "null", span: { ...ctx.next()!.position } };
  return fail(ctx, 'a string, a number, an expression, "true", "false", "null" or an enum value');
};

const readRow = (ctx: Ctx): RecordRow => {
  const start = ctx.position();
  const fields: RecordField[] = [];
  for (;;) {
    if (isPunc(ctx.peek(), ",") || atLineEnd(ctx)) {
      const at = fields.length === 0 ? start : ctx.lastEnd();
      fields.push({ kind: "empty", span: { start: at, end: at } });
    } else {
      fields.push(readField(ctx));
    }
    if (!isPunc(ctx.peek(), ",")) {
      // As in `@dbml/core`, a row holding one field so far continues on a
      // later line that starts with a comma (blank lines may come between).
      if (fields.length !== 1 || !isPunc(peekPastNewlines(ctx), ",")) break;
      skipNewlines(ctx);
    }
    ctx.next();
  }
  expectLineEnd(ctx, '",", a new line or "}"');
  return { fields, span: ctx.spanFrom(start) };
};

const expectBody = (ctx: Ctx, settingsAllowed: boolean): void => {
  if (!isPunc(ctx.peek(), "{")) fail(ctx, settingsAllowed ? '"[" or "{"' : '"{"');
};

// The top level: the table name, then its column list on the same line (a
// space may separate them). Line breaks may come after the keyword and, as for
// other elements, before the settings list and the `{`.
export const recordsElement = defineElement("records", "records", (ctx, start): Records => {
  skipNewlines(ctx);
  const table = readQualifiedName(ctx, "a table name");
  if (!isPunc(ctx.peek(), "(")) fail(ctx, '"("');
  const columns = readColumnList(ctx);
  const { settings, settingsAllowed, openSwallowed } = readHeaderSettings(ctx, RECORDS_SETTINGS);
  if (!openSwallowed) expectBody(ctx, settingsAllowed);
  const rows = readBody(ctx, readRow, openSwallowed);
  return { type: "records", table, columns, settings, rows, span: ctx.spanFrom(start) };
});

/**
 * In a table body, `records` (any case) directly followed, on its line, by
 * `(`, `[` or `{` starts a records block; otherwise the word is a name (a
 * column called `records`).
 */
export const isRecordsItem = (ctx: Ctx): boolean => {
  if (!isWord(ctx.peek(), "records")) return false;
  const next = lookAhead(ctx, 1);
  return isPunc(next, "(") || isPunc(next, "[") || isPunc(next, "{");
};

// Inside a table the header stays on the keyword's line, as in `@dbml/core`.
// The column list may touch the keyword (`records(a)`); a settings list may
// not touch what comes before it, and the `{` may not either.
export const recordsItem = custom<Records, TT>(
  (ctx) => {
    const start = ctx.position();
    ctx.next();
    const columns = isPunc(ctx.peek(), "(") ? readColumnList(ctx) : null;
    const hasSettings = isPunc(ctx.peek(), "[");
    const settings = readOptionalSettings(ctx, RECORDS_SETTINGS);
    expectBody(ctx, !hasSettings);
    expectSpace(ctx);
    const rows = readBody(ctx, readRow);
    return { type: "records", table: null, columns, settings, rows, span: ctx.spanFrom(start) };
  },
  { expected: '"records"', first: [{ type: "ident", value: "records" }] },
);
