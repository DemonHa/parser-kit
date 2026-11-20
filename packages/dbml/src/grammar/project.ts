import type { Span } from "@parser-kit/core";
import {
  type Ctx,
  defineElement,
  expectPunc,
  fail,
  type Ident,
  identFrom,
  isName,
  isPunc,
  readBody,
  readIdent,
  readString,
  type StringValue,
  skipNewlines,
} from "./common";
import { isNoteItem, type Note, noteItem } from "./note";

// `Project name { key: '…'  Note: '…' }`. The name is optional; a project
// takes no settings list, a property's key is a bare word and its value is a
// string.

export interface ProjectProperty {
  type: "property";
  key: Ident;
  value: StringValue;
  span: Span;
}

export interface Project {
  type: "project";
  name: Ident | null;
  items: (ProjectProperty | Note)[];
  span: Span;
}

const readProjectItem = (ctx: Ctx): ProjectProperty | Note => {
  if (isNoteItem(ctx)) return ctx.parse(noteItem);
  const start = ctx.position();
  // The key is a bare word; a line break may come before the `:`.
  if (ctx.peek()?.type !== "ident") fail(ctx, "a property or a note");
  const key = identFrom(ctx.next()!);
  skipNewlines(ctx);
  expectPunc(ctx, ":");
  skipNewlines(ctx);
  const value = readString(ctx);
  return { type: "property", key, value, span: ctx.spanFrom(start) };
};

export const projectElement = defineElement("project", "Project", (ctx, start): Project => {
  skipNewlines(ctx);
  const name = isName(ctx.peek()) ? readIdent(ctx) : null;
  skipNewlines(ctx);
  if (!isPunc(ctx.peek(), "{")) fail(ctx, name === null ? 'a name or "{"' : '"{"');
  const items = readBody(ctx, readProjectItem);
  return { type: "project", name, items, span: ctx.spanFrom(start) };
});
