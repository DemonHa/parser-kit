import { custom, type Span } from "@parser-kit/core";
import {
  type Ctx,
  expectPunc,
  expectSpace,
  isPunc,
  isWord,
  peekPastNewlines,
  readNoteString,
  type StringValue,
  skipNewlines,
  type TT,
} from "./common";

// The note item of a table or project body, `Note: '…'` (inline) or
// `Note { '…' }` (block). Its text is dedented like every note's.

export interface Note {
  type: "note";
  value: StringValue;
  form: "inline" | "block";
  span: Span;
}

/**
 * `note` (any case) followed by `{`, or by `:` with or without line breaks
 * before it, starts a note item; otherwise the word is a name (a column called
 * `note`). As in `@dbml/core`, `note` with `{` on a later line is a name.
 */
export const isNoteItem = (ctx: Ctx): boolean => {
  if (!isWord(ctx.peek(), "note")) return false;
  return isPunc(ctx.peekAhead(1), "{") || isPunc(peekPastNewlines(ctx, 1), ":");
};

export const noteItem = custom<Note, TT>(
  (ctx) => {
    const start = ctx.position();
    ctx.next();
    if (!isPunc(ctx.peek(), "{")) {
      skipNewlines(ctx);
      expectPunc(ctx, ":");
      skipNewlines(ctx);
      const value = readNoteString(ctx);
      return { type: "note", value, form: "inline", span: ctx.spanFrom(start) };
    }
    expectSpace(ctx);
    expectPunc(ctx, "{");
    skipNewlines(ctx);
    const value = readNoteString(ctx);
    skipNewlines(ctx);
    expectPunc(ctx, "}");
    return { type: "note", value, form: "block", span: ctx.spanFrom(start) };
  },
  { expected: '"Note"', first: [{ type: "ident", value: "note" }] },
);
