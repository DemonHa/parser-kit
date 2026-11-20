import type { Span } from "@parser-kit/core";
import {
  atLineEnd,
  type Ctx,
  defineElement,
  expectSpace,
  fail,
  type Ident,
  isPunc,
  noteSetting,
  type QualifiedName,
  readAlias,
  readBody,
  readIdent,
  readQualifiedName,
  readSettings,
  type Setting,
  type SettingsSpec,
  skipNewlines,
} from "./common";

// `Enum schema.name as alias { value [note: '…'] … }`. An enum takes no
// settings list; a value takes only `note`.

export interface EnumValue {
  name: Ident;
  settings: Setting[];
  span: Span;
}

export interface Enum {
  type: "enum";
  name: QualifiedName;
  alias: Ident | null;
  values: EnumValue[];
  span: Span;
}

/** What an enum value's settings list accepts. */
export const ENUM_VALUE_SETTINGS: SettingsSpec = {
  display: "an enum value setting",
  flags: {},
  values: { note: noteSetting },
  custom: false,
};

const readEnumValue = (ctx: Ctx): EnumValue => {
  const start = ctx.position();
  const name = readIdent(ctx, "an enum value");
  if (isPunc(ctx.peek(), "[")) {
    expectSpace(ctx);
    const settings = readSettings(ctx, ENUM_VALUE_SETTINGS);
    if (!atLineEnd(ctx)) fail(ctx, 'a new line or "}"');
    return { name, settings, span: ctx.spanFrom(start) };
  }
  if (!atLineEnd(ctx)) fail(ctx, '"[", a new line or "}"');
  return { name, settings: [], span: ctx.spanFrom(start) };
};

export const enumElement = defineElement("enum", "Enum", (ctx, start): Enum => {
  skipNewlines(ctx);
  const name = readQualifiedName(ctx, "an enum name");
  skipNewlines(ctx);
  const alias = readAlias(ctx);
  skipNewlines(ctx);
  if (!isPunc(ctx.peek(), "{")) fail(ctx, alias === null ? '"as" or "{"' : '"{"');
  const values = readBody(ctx, readEnumValue);
  return { type: "enum", name, alias, values, span: ctx.spanFrom(start) };
});
