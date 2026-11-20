import type { Span } from "@parser-kit/core";
import {
  colorSetting,
  defineElement,
  fail,
  type Ident,
  isNewline,
  isPunc,
  isWord,
  noteSetting,
  peekPastNewlines,
  type QualifiedName,
  quoteOptions,
  readAlias,
  readBody,
  readOptionalSettings,
  readQualifiedName,
  type Setting,
  type SettingsSpec,
  skipNewlines,
  touches,
} from "./common";
import { readTableItem, type TableItem } from "./table-items";

// `Table schema.name as alias [settings] { … }`. Line breaks may separate the
// parts of the header, as in `@dbml/core`, with one exception before the
// settings list (see below).

export interface Table {
  type: "table";
  name: QualifiedName;
  alias: Ident | null;
  settings: Setting[];
  items: TableItem[];
  span: Span;
}

/** What a table's settings list accepts. */
export const TABLE_SETTINGS: SettingsSpec = {
  display: "a table setting",
  flags: {},
  values: { note: noteSetting, headercolor: colorSetting },
  custom: true,
};

export const tableElement = defineElement("table", "Table", (ctx, start): Table => {
  skipNewlines(ctx);
  const name = readQualifiedName(ctx, "a table name");
  if (isWord(peekPastNewlines(ctx), "as")) skipNewlines(ctx);
  const alias = readAlias(ctx);
  // `@dbml/core` reads a `[` after a line break that directly follows the
  // name or alias as part of that name, so the settings list may start on a
  // later line only when a space or a comment ends the name's line. (The
  // lexer drops a `\r` like a space, so a CRLF line ending counts as one
  // here; `@dbml/core` does not count it.)
  const spacedBreak = isNewline(ctx.peek()) && !touches(ctx.lastEnd(), ctx.peek());
  if (spacedBreak && isPunc(peekPastNewlines(ctx), "[")) skipNewlines(ctx);
  const hasSettings = isPunc(ctx.peek(), "[");
  const settings = readOptionalSettings(ctx, TABLE_SETTINGS);
  const settingsAllowed = !hasSettings && (spacedBreak || !isNewline(ctx.peek()));
  skipNewlines(ctx);
  if (!isPunc(ctx.peek(), "{")) {
    const options = [alias === null && !hasSettings && '"as"', settingsAllowed && '"["', '"{"'];
    fail(ctx, quoteOptions(options.filter((option): option is string => option !== false)));
  }
  const items = readBody(ctx, readTableItem);
  return { type: "table", name, alias, settings, items, span: ctx.spanFrom(start) };
});
