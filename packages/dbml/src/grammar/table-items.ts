import type { Infer, Rule } from "@parser-kit/core";
import { type Column, column } from "./column";
import { type Ctx, fail, isName, quoteOptions, type TT } from "./common";
import { isNoteItem, noteItem } from "./note";

// What may appear in a table body. Each entry decides from the next tokens
// whether the line is its item (a keyword is only a keyword where the token
// after it says so); a line no entry claims is a column. A new item kind is one
// line here.

interface TableItemEntry {
  /** What the item is called in error messages (`a note`). */
  display: string;
  matches: (ctx: Ctx) => boolean;
  rule: Rule<object, TT>;
}

const TABLE_ITEMS = [
  { display: "a note", matches: isNoteItem, rule: noteItem },
] as const satisfies readonly TableItemEntry[];

const EXPECTED_ITEM = quoteOptions(["a column", ...TABLE_ITEMS.map((entry) => entry.display)]);

export type TableItem = Column | Infer<(typeof TABLE_ITEMS)[number]["rule"]>;

/** One table-body line. */
export const readTableItem = (ctx: Ctx): TableItem => {
  for (const entry of TABLE_ITEMS) {
    if (entry.matches(ctx)) return ctx.parse(entry.rule);
  }
  if (!isName(ctx.peek())) fail(ctx, EXPECTED_ITEM);
  return ctx.parse(column);
};
