import type { Span } from "@parser-kit/core";
import {
  atLineEnd,
  type Ctx,
  colorSetting,
  defineElement,
  fail,
  type Ident,
  isPunc,
  noteSetting,
  type QualifiedName,
  readBody,
  readHeaderSettings,
  readIdent,
  readQualifiedName,
  type Setting,
  type SettingsSpec,
  skipNewlines,
} from "./common";
import { isNoteItem, type Note, noteItem } from "./note";

// `TableGroup name [settings] { table  schema.table  Note: '…' }`. The name is
// a single identifier; a member is a table name, one per line, which may be
// called `note` (a member is only a note when `:` or `{` follows the word).

/** A table listed in a group: `t` or `s.t`. */
export interface TableGroupMember extends QualifiedName {
  type: "member";
}

export interface TableGroup {
  type: "tableGroup";
  name: Ident;
  settings: Setting[];
  items: (TableGroupMember | Note)[];
  span: Span;
}

/** What a table group's settings list accepts. */
export const TABLE_GROUP_SETTINGS: SettingsSpec = {
  display: "a table group setting",
  flags: {},
  values: { color: colorSetting, note: noteSetting },
  custom: true,
};

const readGroupItem = (ctx: Ctx): TableGroupMember | Note => {
  if (isNoteItem(ctx)) return ctx.parse(noteItem);
  const name = readQualifiedName(ctx, "a table name or a note");
  // Not `expectLineEnd`: a name with more after it (`Note n { … }`) is most
  // likely no member, so `diagnose` doesn't keep it.
  if (!atLineEnd(ctx)) fail(ctx, 'a new line or "}"');
  return { type: "member", ...name };
};

export const tableGroupElement = defineElement("tablegroup", "TableGroup", (ctx, start): TableGroup => {
  skipNewlines(ctx);
  const name = readIdent(ctx, "a table group name");
  const { settings, settingsAllowed, openSwallowed } = readHeaderSettings(ctx, TABLE_GROUP_SETTINGS);
  if (!openSwallowed && !isPunc(ctx.peek(), "{")) fail(ctx, settingsAllowed ? '"[" or "{"' : '"{"');
  const items = readBody(ctx, readGroupItem, openSwallowed);
  return { type: "tableGroup", name, settings, items, span: ctx.spanFrom(start) };
});
