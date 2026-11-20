import { custom, type Position, type Span } from "@parser-kit/core";
import {
  atEnumConstant,
  atLineEnd,
  atNumber,
  bracketOnLaterLine,
  type Ctx,
  expectPunc,
  expectSpace,
  fail,
  type Ident,
  identFrom,
  isBooleanWord,
  isName,
  isPunc,
  isString,
  isWord,
  type NumberValue,
  noteSetting,
  type QualifiedName,
  readBoolean,
  readEnumConstant,
  readExpression,
  readIdent,
  readNumber,
  readQualifiedName,
  readSettings,
  readString,
  type Setting,
  type SettingsSpec,
  skipNewlines,
  type TT,
  touches,
  type Value,
} from "./common";
import { checkSetting } from "./indexes";
import { refSetting } from "./ref";

// A table column: `name type [bare flags] [settings]`, one per line.

/**
 * A column type: `int`, `varchar(255)`, `decimal(1, 2)`, `int[]`, a quoted
 * `"double precision"` or a schema-qualified `s.status`. `args` is null
 * without parentheses. `arraySizes` has one entry per array suffix, in order:
 * null for `[]`, the size for `[3]`; it is empty for a non-array type.
 */
export interface DataType {
  name: QualifiedName;
  args: Value[] | null;
  arraySizes: (NumberValue | null)[];
  span: Span;
}

export interface Column {
  type: "column";
  name: Ident;
  dataType: DataType;
  settings: Setting[];
  span: Span;
}

// A type argument: a number (signed), a string or a name (`MAX`, `"x"`).
const readTypeArg = (ctx: Ctx): Value => {
  const token = ctx.peek();
  if (isName(token)) {
    const value = identFrom(ctx.next()!);
    return { kind: "identifier", value, span: value.span };
  }
  if (isString(token)) return readString(ctx);
  if (atNumber(ctx)) return readNumber(ctx);
  return fail(ctx, "a number, a string or a name");
};

const readDataType = (ctx: Ctx): DataType => {
  const start = ctx.position();
  const name = readQualifiedName(ctx, "a column type");
  let args: Value[] | null = null;
  if (isPunc(ctx.peek(), "(")) {
    ctx.next();
    args = [];
    if (!isPunc(ctx.peek(), ")")) {
      args.push(readTypeArg(ctx));
      while (!isPunc(ctx.peek(), ")")) {
        expectPunc(ctx, ",", '"," or ")"');
        args.push(readTypeArg(ctx));
      }
    }
    ctx.next();
  }
  // `[]` or `[3]` touching the type is an array suffix; `int []` is an empty
  // settings list. As in `@dbml/core`, so is a `[` opening a later line right
  // after the type (`int⏎[]`).
  const arraySizes: (NumberValue | null)[] = [];
  for (;;) {
    if (bracketOnLaterLine(ctx)) skipNewlines(ctx);
    else if (!(isPunc(ctx.peek(), "[") && touches(ctx.lastEnd(), ctx.peek()))) break;
    ctx.next();
    if (isPunc(ctx.peek(), "]")) {
      arraySizes.push(null);
    } else {
      if (ctx.peek()?.type !== "number") fail(ctx, 'a number or "]"');
      arraySizes.push(readNumber(ctx));
    }
    expectPunc(ctx, "]");
  }
  return { name, args, arraySizes, span: ctx.spanFrom(start) };
};

// A default: an enum value (`status.active`, `s.status.active`, read first,
// so `true.x` is one too), a string, a number (signed), a backtick
// expression, `true`, `false` or `null`.
const readDefault = (ctx: Ctx, _key: Ident, start: Position): Setting => {
  const token = ctx.peek();
  let value: Value;
  if (atEnumConstant(ctx)) {
    value = readEnumConstant(ctx);
  } else if (isString(token)) {
    value = readString(ctx);
  } else if (atNumber(ctx)) {
    value = readNumber(ctx);
  } else if (token?.type === "expression") {
    value = readExpression(ctx);
  } else if (isBooleanWord(token)) {
    value = readBoolean(ctx);
  } else if (isWord(token, "null")) {
    value = { kind: "null", span: { ...ctx.next()!.position } };
  } else {
    return fail(ctx, 'a string, a number, an expression, "true", "false", "null" or an enum value');
  }
  return { kind: "default", value, span: ctx.spanFrom(start) };
};

/** What a column's settings list accepts. */
export const COLUMN_SETTINGS: SettingsSpec = {
  display: "a column setting",
  flags: {
    pk: (span) => ({ kind: "pk", spelling: "pk", span }),
    "primary key": (span) => ({ kind: "pk", spelling: "primary key", span }),
    null: (span) => ({ kind: "null", not: false, span }),
    "not null": (span) => ({ kind: "null", not: true, span }),
    unique: (span) => ({ kind: "unique", span }),
    increment: (span) => ({ kind: "increment", span }),
  },
  values: {
    default: readDefault,
    note: noteSetting,
    ref: refSetting,
    check: checkSetting,
  },
  custom: true,
};

export const column = custom<Column, TT>(
  (ctx) => {
    const start = ctx.position();
    const name = readIdent(ctx, "a column");
    if (atLineEnd(ctx)) fail(ctx, "a column type");
    // A space is only worth asking for before something that can start a type.
    if (!isName(ctx.peek())) fail(ctx, "a column type");
    expectSpace(ctx);
    const dataType = readDataType(ctx);
    // `pk` and `unique` may also follow the type bare, before any settings
    // list; whitespace separates each.
    const settings: Setting[] = [];
    for (;;) {
      const token = ctx.peek();
      if (isWord(token, "pk")) settings.push({ kind: "pk", spelling: "pk", bare: true, span: { ...token!.position } });
      else if (isWord(token, "unique")) settings.push({ kind: "unique", bare: true, span: { ...token!.position } });
      else break;
      expectSpace(ctx);
      ctx.next();
    }
    if (isPunc(ctx.peek(), "[")) {
      expectSpace(ctx);
      settings.push(...readSettings(ctx, COLUMN_SETTINGS));
      if (!atLineEnd(ctx)) fail(ctx, 'a new line or "}"');
    } else if (!atLineEnd(ctx)) {
      fail(ctx, '"pk", "unique", "[", a new line or "}"');
    }
    return { type: "column", name, dataType, settings, span: ctx.spanFrom(start) };
  },
  { expected: "a column", first: [{ type: "ident" }, { type: "qident" }] },
);
