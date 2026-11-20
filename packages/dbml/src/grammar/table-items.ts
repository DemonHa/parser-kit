import type { Infer, Rule } from "@parser-kit/core";
import { type Column, column } from "./column";
import { type Ctx, fail, isName, quoteOptions, type TT } from "./common";
import { checksItem, indexesItem, isChecksItem, isIndexesItem } from "./indexes";
import { isPartialInjection, partialInjection } from "./injection";
import { isNoteItem, noteItem } from "./note";
import { isRecordsItem, recordsItem } from "./records";

// What may appear in a table body. Each entry decides from the next tokens
// whether the line is its item (a keyword is only a keyword where the token
// after it says so); a line no entry claims is a column. A new item kind is one
// line here. A table partial's body takes the same items, except those marked
// `tableOnly`.

interface TableItemEntry {
  /** What the item is called in error messages (`a note`). */
  display: string;
  matches: (ctx: Ctx) => boolean;
  rule: Rule<object, TT>;
  /** Only a table body takes it, not a table partial's. */
  tableOnly?: true;
}

const TABLE_ITEMS = [
  { display: "a note", matches: isNoteItem, rule: noteItem },
  { display: "a partial injection", matches: isPartialInjection, rule: partialInjection, tableOnly: true },
  { display: "records", matches: isRecordsItem, rule: recordsItem, tableOnly: true },
  { display: '"indexes"', matches: isIndexesItem, rule: indexesItem },
  { display: '"checks"', matches: isChecksItem, rule: checksItem },
] as const satisfies readonly TableItemEntry[];

type Entry = (typeof TABLE_ITEMS)[number];

export type TableItem = Column | Infer<Entry["rule"]>;

/** What a table partial's body may hold. */
export type PartialItem = Column | Infer<Exclude<Entry, { tableOnly: true }>["rule"]>;

const ENTRIES: readonly TableItemEntry[] = TABLE_ITEMS;
const PARTIAL_ENTRIES = ENTRIES.filter((entry) => entry.tableOnly !== true);
const expectedItem = (entries: readonly TableItemEntry[]): string =>
  quoteOptions(["a column", ...entries.map((entry) => entry.display)]);
const EXPECTED_ITEM = expectedItem(ENTRIES);
const EXPECTED_PARTIAL_ITEM = expectedItem(PARTIAL_ENTRIES);

const readItem = (ctx: Ctx, entries: readonly TableItemEntry[], expected: string): object => {
  for (const entry of ENTRIES) {
    if (!entry.matches(ctx)) continue;
    // A table-only item in a partial: the line is neither a column nor a
    // partial item.
    if (!entries.includes(entry)) fail(ctx, expected);
    return ctx.parse(entry.rule);
  }
  if (!isName(ctx.peek())) fail(ctx, expected);
  return ctx.parse(column);
};

/** One table-body line. */
export const readTableItem = (ctx: Ctx): TableItem => readItem(ctx, ENTRIES, EXPECTED_ITEM) as TableItem;

/** One line of a table partial's body. */
export const readPartialItem = (ctx: Ctx): PartialItem =>
  readItem(ctx, PARTIAL_ENTRIES, EXPECTED_PARTIAL_ITEM) as PartialItem;
