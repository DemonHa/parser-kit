import type { Position, Span, Token } from "@parser-kit/core";
import {
  type Ctx,
  colorSetting,
  defineElement,
  eatDot,
  expectLineEnd,
  expectPunc,
  fail,
  type Ident,
  isName,
  isPunc,
  isWord,
  noteSetting,
  type QualifiedName,
  readIdent,
  readOptionalSettings,
  type Setting,
  type SettingsSpec,
  skipNewlines,
  type TT,
  touches,
} from "./common";
import { report, skipPastClose } from "./recovery";

// `Ref` in its short (`Ref name: a.b > c.d`) and long (`Ref name { a.b > c.d }`)
// forms, and the `ref: > c.d` column setting. A long-form body holds exactly
// one relationship, as in `@dbml/core`.

/**
 * `>` many-to-one (`posts.user_id > users.id`), `<` one-to-many, `-`
 * one-to-one, `<>` many-to-many; `?` marks an optional side.
 */
export interface Relation {
  op: "<" | ">" | "-" | "<>";
  leftOptional?: true;
  rightOptional?: true;
  span: Span;
}

/**
 * One side of a relationship: `table.column`, `schema.table.column`, or a
 * composite `table.(a, b)`. The last part is the column, the one before it the
 * table and the one before that the schema.
 */
export interface Endpoint {
  table: QualifiedName;
  columns: Ident[];
  composite: boolean;
  span: Span;
}

export interface Ref {
  type: "ref";
  name: Ident | null;
  form: "short" | "long";
  left: Endpoint;
  relation: Relation;
  right: Endpoint;
  settings: Setting[];
  span: Span;
}

const RELATION_DISPLAY = "a relation (<, >, -, <>)";
const OPS: readonly Relation["op"][] = ["<", ">", "-", "<>"];
const isOp = (token: Token<TT> | null): token is Token<TT> & { value: Relation["op"] } =>
  token !== null && token.type === "punc" && (OPS as readonly string[]).includes(token.value);

// `?`? op `?`?, the marks of one relation touching (`>?`, `?<>?`), as in
// `@dbml/core`, which rejects `? >`.
export const readRelation = (ctx: Ctx): Relation => {
  const start = ctx.position();
  let leftOptional = false;
  if (isPunc(ctx.peek(), "?")) {
    leftOptional = true;
    const mark = ctx.next()!;
    if (!isOp(ctx.peek()) || !touches(mark.position.end, ctx.peek())) {
      fail(ctx, `${RELATION_DISPLAY} right after "?"`);
    }
  }
  const op = ctx.peek();
  if (!isOp(op)) return fail(ctx, RELATION_DISPLAY);
  ctx.next();
  const rightOptional = isPunc(ctx.peek(), "?") && touches(op.position.end, ctx.peek());
  if (rightOptional) ctx.next();
  return {
    op: op.value,
    ...(leftOptional && { leftOptional: true as const }),
    ...(rightOptional && { rightOptional: true as const }),
    span: ctx.spanFrom(start),
  };
};

// `(a, b)`, at least one column, no trailing comma.
const readColumnList = (ctx: Ctx): Ident[] => {
  expectPunc(ctx, "(");
  const columns = [readIdent(ctx, "a column name")];
  while (!isPunc(ctx.peek(), ")")) {
    expectPunc(ctx, ",", '"," or ")"');
    columns.push(readIdent(ctx, "a column name"));
  }
  ctx.next();
  return columns;
};

/** `table.column`, `schema.table.column`, or (with `composite`) `table.(a, b)`. */
export const readEndpoint = (ctx: Ctx, opts: { composite: boolean }): Endpoint => {
  const start = ctx.position();
  const parts = [readIdent(ctx, "a column reference")];
  let columns: Ident[] | null = null;
  let composite = false;
  while (parts.length < 3 && eatDot(ctx)) {
    if (opts.composite && isPunc(ctx.peek(), "(")) {
      columns = readColumnList(ctx);
      composite = true;
      break;
    }
    parts.push(readIdent(ctx, opts.composite ? 'a column name or "("' : "a column name"));
  }
  if (columns === null) {
    if (parts.length < 2) fail(ctx, '"."');
    columns = [parts.pop()!];
  }
  const name = parts[parts.length - 1]!;
  const schema = parts.length === 2 ? parts[0]! : null;
  const table: QualifiedName = { schema, name, span: { start: parts[0]!.span.start, end: name.span.end } };
  return { table, columns, composite, span: ctx.spanFrom(start) };
};

const ACTION_DISPLAY = '"cascade", "restrict", "set null", "set default" or "no action"';

// `cascade`, `restrict`, `set null`, `set default` or `no action`, any case.
const actionSetting =
  (on: "delete" | "update") =>
  (ctx: Ctx, _key: Ident, start: Position): Setting => {
    const first = ctx.peek();
    let action: Extract<Setting, { kind: "action" }>["action"] | null = null;
    if (isWord(first, "cascade") || isWord(first, "restrict")) {
      action = isWord(first, "cascade") ? "cascade" : "restrict";
      ctx.next();
    } else if (isWord(first, "set")) {
      ctx.next();
      if (isWord(ctx.peek(), "null")) action = "set null";
      else if (isWord(ctx.peek(), "default")) action = "set default";
      else fail(ctx, '"null" or "default"');
      ctx.next();
    } else if (isWord(first, "no")) {
      ctx.next();
      if (!isWord(ctx.peek(), "action")) fail(ctx, '"action"');
      ctx.next();
      action = "no action";
    }
    if (action === null) return fail(ctx, ACTION_DISPLAY);
    return { kind: "action", on, action, span: ctx.spanFrom(start) };
  };

const REF_SETTINGS: SettingsSpec = {
  display: "a Ref setting",
  flags: { inactive: (span) => ({ kind: "inactive", span }) },
  values: {
    delete: actionSetting("delete"),
    update: actionSetting("update"),
    color: colorSetting,
    note: noteSetting,
  },
  custom: true,
};

/** The `ref: > table.column` column setting; the key and `:` are already read. */
export const refSetting = (ctx: Ctx, _key: Ident, start: Position): Setting => {
  const relation = readRelation(ctx);
  const target = readEndpoint(ctx, { composite: false });
  return { kind: "ref", relation, target, span: ctx.spanFrom(start) };
};

// `left op right [settings]`. The short form lets the relation sit on either
// side of a line break; inside a long-form body only a break after it is
// allowed, as in `@dbml/core`. The settings start on the right endpoint's line.
const readRefLine = (ctx: Ctx, form: "short" | "long") => {
  const left = readEndpoint(ctx, { composite: true });
  if (form === "short") skipNewlines(ctx);
  const relation = readRelation(ctx);
  skipNewlines(ctx);
  const right = readEndpoint(ctx, { composite: true });
  const hasSettings = isPunc(ctx.peek(), "[");
  const settings = readOptionalSettings(ctx, REF_SETTINGS);
  return { line: { left, relation, right, settings }, hasSettings };
};

export const refElement = defineElement("ref", "Ref", (ctx, start): Ref => {
  skipNewlines(ctx);
  const name = isName(ctx.peek()) ? readIdent(ctx) : null;
  skipNewlines(ctx);
  if (isPunc(ctx.peek(), ":")) {
    ctx.next();
    skipNewlines(ctx);
    const { line, hasSettings } = readRefLine(ctx, "short");
    expectLineEnd(ctx, hasSettings ? "a new line" : '"[" or a new line');
    return { type: "ref", name, form: "short", ...line, span: ctx.spanFrom(start) };
  }
  if (!isPunc(ctx.peek(), "{")) fail(ctx, name === null ? 'a name, ":" or "{"' : '":" or "{"');
  ctx.next();
  let line: ReturnType<typeof readRefLine>["line"] | null = null;
  try {
    skipNewlines(ctx);
    const read = readRefLine(ctx, "long");
    line = read.line;
    expectLineEnd(ctx, read.hasSettings ? 'a new line or "}"' : '"[", a new line or "}"');
    skipNewlines(ctx);
    // A long-form body holds one relationship: a second line fails here.
    expectPunc(ctx, "}");
  } catch (error) {
    // Under `diagnose`, resume after the body's `}`, keeping the relationship
    // if it was read.
    if (!report(ctx, error)) throw error;
    skipPastClose(ctx);
    if (line === null) throw error;
  }
  return { type: "ref", name, form: "long", ...line, span: ctx.spanFrom(start) };
});
