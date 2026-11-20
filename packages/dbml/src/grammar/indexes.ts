import { custom, type Position, type Span } from "@parser-kit/core";
import {
  atLineEnd,
  type Ctx,
  type ExpressionValue,
  expectLineEnd,
  expectPunc,
  expectSpace,
  fail,
  type Ident,
  identFrom,
  isName,
  isNewline,
  isPunc,
  isWord,
  lookAhead,
  lowerKey,
  peekPastNewlines,
  readBody,
  readExpression,
  readIdent,
  readOptionalSettings,
  readSettings,
  readString,
  type Setting,
  type SettingsSpec,
  skipNewlines,
  type TT,
  touches,
} from "./common";

// The `indexes { … }` and `checks { … }` blocks of a table body, and the
// column `check:` setting. `indexes` and `checks` are keywords only when `{`
// follows on the same line; otherwise they name a column.

// --- AST ---

/** An index column's sort order, `[asc]` or `[desc]`; null when none is given. */
export type IndexOrder = "asc" | "desc" | null;

/**
 * A column name or a backtick expression in an index, with its sort order:
 * `id [desc]` inside parentheses; outside them, `id[desc]` (glued) or a
 * `[desc]` opening a later line.
 */
export type IndexColumn =
  | { kind: "column"; name: Ident; order: IndexOrder; span: Span }
  | { kind: "expression"; expression: ExpressionValue; order: IndexOrder; span: Span };

/** `( … )`: columns and expressions separated by commas, possibly none. */
export interface IndexComposite {
  kind: "composite";
  columns: IndexColumn[];
  span: Span;
}

export type IndexField = IndexColumn | IndexComposite;

/**
 * One line of an `indexes` block: its fields in source order, then its
 * settings. Usually one field (`id`, `` `lower(x)` ``, `(a, b)`), but
 * `@dbml/core` also takes several, separated by spaces or with a `(` glued to
 * the field before it (`a b`, `(a) b`, `lower(id)`), and indexes them all
 * together. A line of settings alone (`[unique]`) has no fields.
 */
export interface IndexEntry {
  fields: IndexField[];
  settings: Setting[];
  span: Span;
}

export interface Indexes {
  type: "indexes";
  entries: IndexEntry[];
  span: Span;
}

/** One line of a `checks` block: a backtick expression and its settings (`[name: '…']`). */
export interface CheckEntry {
  expression: ExpressionValue;
  settings: Setting[];
  span: Span;
}

export interface Checks {
  type: "checks";
  entries: CheckEntry[];
  span: Span;
}

// --- Settings ---

/** `name: '…'`: a string. */
const nameSetting = (ctx: Ctx, key: Ident, start: Position): Setting => {
  const value = readString(ctx);
  return { kind: "property", key: lowerKey(key), value, span: ctx.spanFrom(start) };
};

/**
 * `type: btree`: a name, bare or double-quoted. `@dbml/core` takes any name
 * here (`gin` too); whether it is `btree` or `hash` is not checked.
 */
const typeSetting = (ctx: Ctx, key: Ident, start: Position): Setting => {
  const name = readIdent(ctx, "an index type");
  return {
    kind: "property",
    key: lowerKey(key),
    value: { kind: "identifier", value: name, span: name.span },
    span: ctx.spanFrom(start),
  };
};

/** An index's `note:`: a string, kept as written (`@dbml/core` doesn't dedent it). */
const indexNoteSetting = (ctx: Ctx, _key: Ident, start: Position): Setting => {
  const value = readString(ctx);
  return { kind: "note", value, span: ctx.spanFrom(start) };
};

/** What an index entry's settings list accepts. */
export const INDEX_SETTINGS: SettingsSpec = {
  display: "an index setting",
  flags: {
    pk: (span) => ({ kind: "pk", spelling: "pk", span }),
    unique: (span) => ({ kind: "unique", span }),
  },
  values: { name: nameSetting, type: typeSetting, note: indexNoteSetting },
  custom: false,
};

/** What a `checks` entry's settings list accepts. */
export const CHECK_SETTINGS: SettingsSpec = {
  display: "a check setting",
  flags: {},
  values: { name: nameSetting },
  custom: false,
};

/** The column `check:` setting: a backtick expression. It may repeat. */
export const checkSetting = (ctx: Ctx, _key: Ident, start: Position): Setting => {
  const expression = readExpression(ctx);
  return { kind: "check", expression, span: ctx.spanFrom(start) };
};

// --- Indexes ---

// `[asc]` or `[desc]`, in any case: exactly one word.
const readOrder = (ctx: Ctx): "asc" | "desc" => {
  expectPunc(ctx, "[");
  const token = ctx.peek();
  if (!isWord(token, "asc") && !isWord(token, "desc")) fail(ctx, '"asc" or "desc"');
  ctx.next();
  expectPunc(ctx, "]");
  return token!.value as "asc" | "desc";
};

const atColumnStart = (ctx: Ctx): boolean => isName(ctx.peek()) || ctx.peek()?.type === "expression";

// A column name or an expression, then its sort order if `[` follows: glued
// to it outside parentheses (a spaced `[` there starts the entry's settings,
// and one on a later line is handled by the entry), anywhere inside them.
const readIndexColumn = (ctx: Ctx, inParens: boolean): IndexColumn => {
  const start = ctx.position();
  const token = ctx.peek();
  if (!atColumnStart(ctx)) fail(ctx, "a column name or an expression");
  const column = token!.type === "expression" ? readExpression(ctx) : identFrom(ctx.next()!);
  const wantsOrder = isPunc(ctx.peek(), "[") && (inParens || touches(ctx.lastEnd(), ctx.peek()));
  const order = wantsOrder ? readOrder(ctx) : null;
  const span = ctx.spanFrom(start);
  return "kind" in column
    ? { kind: "expression", expression: column, order, span }
    : { kind: "column", name: column, order, span };
};

// `( … )`: columns and expressions separated by commas; may be empty and may
// span lines.
const readComposite = (ctx: Ctx): IndexComposite => {
  const start = ctx.position();
  expectPunc(ctx, "(");
  const columns: IndexColumn[] = [];
  if (!isPunc(ctx.peek(), ")")) {
    columns.push(readIndexColumn(ctx, true));
    while (!isPunc(ctx.peek(), ")")) {
      expectPunc(ctx, ",", columns[columns.length - 1]!.order === null ? '"[", "," or ")"' : '"," or ")"');
      columns.push(readIndexColumn(ctx, true));
    }
  }
  ctx.next();
  return { kind: "composite", columns, span: ctx.spanFrom(start) };
};

const readIndexField = (ctx: Ctx): IndexField =>
  isPunc(ctx.peek(), "(") ? readComposite(ctx) : readIndexColumn(ctx, false);

// True when a line break directly follows the last token (nothing, not even
// a space, between them) and the next line, past any blank ones, opens with
// `[`: `@dbml/core` then binds that `[` to the token before the break. Two
// cases differ from `@dbml/core`, which also binds across a `\r` (CRLF) or a
// comment glued to the token (`id// c`): the parse stream has dropped both, so
// their break no longer touches the token.
const bracketOnLaterLine = (ctx: Ctx): boolean =>
  isNewline(ctx.peek()) && touches(ctx.lastEnd(), ctx.peek()) && isPunc(peekPastNewlines(ctx), "[");

// A `[` that binds to an entry which takes no sort order.
function unboundBracket(ctx: Ctx): never {
  skipNewlines(ctx);
  const token = ctx.peek()!;
  return ctx.croak(
    'A "[" opening the line right after an index entry is a sort order, which only a bare column or expression takes',
    token.position.start,
    token.position.end,
  );
}

const readIndexEntry = (ctx: Ctx): IndexEntry => {
  const start = ctx.position();
  const fields: IndexField[] = [];
  let settings: Setting[];
  if (isPunc(ctx.peek(), "[")) {
    // A line of settings alone: `@dbml/core` takes it as an index of no columns.
    settings = readSettings(ctx, INDEX_SETTINGS);
  } else {
    if (!isPunc(ctx.peek(), "(") && !atColumnStart(ctx)) fail(ctx, 'a column name, an expression, "(" or "["');
    fields.push(readIndexField(ctx));
    for (;;) {
      // As in `@dbml/core`, a `[` opening a later line binds to the field
      // before it: the sort order of a bare column or expression, and an
      // error after anything else.
      if (bracketOnLaterLine(ctx)) {
        const last = fields[fields.length - 1]!;
        if (last.kind === "composite" || last.order !== null) unboundBracket(ctx);
        skipNewlines(ctx);
        fields[fields.length - 1] = { ...last, order: readOrder(ctx), span: ctx.spanFrom(last.span.start) };
        continue;
      }
      // More fields until the line ends or a spaced `[` starts the settings.
      // A field after the first is separated by a space, unless it is a `(`
      // glued to the one before (`lower(id)`).
      if (atLineEnd(ctx) || isPunc(ctx.peek(), "[")) break;
      if (isPunc(ctx.peek(), "(")) {
        fields.push(readComposite(ctx));
        continue;
      }
      if (!atColumnStart(ctx)) fail(ctx, 'a column name, an expression, "(", "[", a new line or "}"');
      if (touches(ctx.lastEnd(), ctx.peek())) fail(ctx, "a space");
      fields.push(readIndexColumn(ctx, false));
    }
    settings = readOptionalSettings(ctx, INDEX_SETTINGS);
  }
  // Nor may such a `[` follow a settings list.
  if (bracketOnLaterLine(ctx)) unboundBracket(ctx);
  return { fields, settings, span: ctx.spanFrom(start) };
};

// --- Checks ---

const readCheckEntry = (ctx: Ctx): CheckEntry => {
  const start = ctx.position();
  const expression = readExpression(ctx);
  if (!isPunc(ctx.peek(), "[")) expectLineEnd(ctx, '"[", a new line or "}"');
  const settings = readOptionalSettings(ctx, CHECK_SETTINGS);
  return { expression, settings, span: ctx.spanFrom(start) };
};

// --- Table items ---

/** `keyword` (any case) directly followed by `{` on the same line. */
const isBlock = (keyword: string) => (ctx: Ctx) => isWord(ctx.peek(), keyword) && isPunc(lookAhead(ctx, 1), "{");

const readBlockBody = <T>(ctx: Ctx, item: (ctx: Ctx) => T): T[] => {
  ctx.next();
  expectSpace(ctx);
  return readBody(ctx, item);
};

export const isIndexesItem = isBlock("indexes");
export const isChecksItem = isBlock("checks");

export const indexesItem = custom<Indexes, TT>(
  (ctx) => {
    const start = ctx.position();
    const entries = readBlockBody(ctx, readIndexEntry);
    return { type: "indexes", entries, span: ctx.spanFrom(start) };
  },
  { expected: '"indexes"', first: [{ type: "ident", value: "indexes" }] },
);

export const checksItem = custom<Checks, TT>(
  (ctx) => {
    const start = ctx.position();
    const entries = readBlockBody(ctx, readCheckEntry);
    return { type: "checks", entries, span: ctx.spanFrom(start) };
  },
  { expected: '"checks"', first: [{ type: "ident", value: "checks" }] },
);
