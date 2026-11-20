import type { Span } from "@parser-kit/core";
import {
  colorSetting,
  defineElement,
  fail,
  type Ident,
  isPunc,
  noteSetting,
  readBody,
  readHeaderSettings,
  readIdent,
  type Setting,
  type SettingsSpec,
  skipNewlines,
} from "./common";
import { type PartialItem, readPartialItem } from "./table-items";

// `TablePartial name [settings] { … }`: a reusable set of table items, injected
// into tables with `~name` (see `injection.ts`). Its body takes what a table
// body takes, except injections and records. Nothing is merged here.

export interface TablePartial {
  type: "tablePartial";
  name: Ident;
  settings: Setting[];
  items: PartialItem[];
  span: Span;
}

/** What a table partial's settings list accepts: unlike a table's, no custom properties. */
export const TABLE_PARTIAL_SETTINGS: SettingsSpec = {
  display: "a table partial setting",
  flags: {},
  values: { note: noteSetting, headercolor: colorSetting },
  custom: false,
};

export const tablePartialElement = defineElement("tablepartial", "TablePartial", (ctx, start): TablePartial => {
  skipNewlines(ctx);
  const name = readIdent(ctx, "a table partial name");
  const { settings, settingsAllowed } = readHeaderSettings(ctx, TABLE_PARTIAL_SETTINGS);
  if (!isPunc(ctx.peek(), "{")) fail(ctx, settingsAllowed ? '"[" or "{"' : '"{"');
  const items = readBody(ctx, readPartialItem);
  return { type: "tablePartial", name, settings, items, span: ctx.spanFrom(start) };
});
