import { custom, type Position, type Span } from "@parser-kit/core";
import {
  type Ctx,
  colorSetting,
  defineElement,
  expectPunc,
  expectSpace,
  fail,
  type Ident,
  isPunc,
  isWord,
  lookAhead,
  peekPastNewlines,
  type QualifiedName,
  readHeaderSettings,
  readNone,
  readNoteString,
  readQualifiedName,
  type Setting,
  type SettingsSpec,
  type StringValue,
  skipNewlines,
  type TT,
} from "./common";
import { closeSwallowed, report, skipPastClose } from "./recovery";

// The note item of a table or project body, `Note: '…'` (inline) or
// `Note { '…' }` (block). Its text is dedented like every note's.

export interface Note {
  type: "note";
  value: StringValue;
  form: "inline" | "block";
  span: Span;
}

/**
 * A block note's `'…' }`, its `{` already read. Under `diagnose`, an error
 * resumes after the block's `}`, keeping the text if it was read.
 */
const readNoteBody = (ctx: Ctx, open: Position): StringValue => {
  let value: StringValue | null = null;
  try {
    skipNewlines(ctx);
    value = readNoteString(ctx);
    skipNewlines(ctx);
    if (!isPunc(ctx.peek(), "}") && closeSwallowed(ctx, open)) return value;
    expectPunc(ctx, "}");
  } catch (error) {
    if (!report(ctx, error)) throw error;
    skipPastClose(ctx, open);
    if (value === null) throw error;
  }
  return value;
};

/**
 * `note` (any case) followed by `{`, or by `:` with or without line breaks
 * before it, starts a note item; otherwise the word is a name (a column called
 * `note`). As in `@dbml/core`, `note` with `{` on a later line is a name.
 */
export const isNoteItem = (ctx: Ctx): boolean => {
  if (!isWord(ctx.peek(), "note")) return false;
  return isPunc(lookAhead(ctx, 1), "{") || isPunc(peekPastNewlines(ctx, 1), ":");
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
    const open = ctx.position();
    expectPunc(ctx, "{");
    const value = readNoteBody(ctx, open);
    return { type: "note", value, form: "block", span: ctx.spanFrom(start) };
  },
  { expected: '"Note"', first: [{ type: "ident", value: "note" }] },
);

// A sticky note, a top-level element: `Note name [settings] { '…' }`. Only
// the top level reads `note` this way; in a body, `note` is the note item or
// a name (see `isNoteItem`).

export interface StickyNote {
  type: "stickyNote";
  name: QualifiedName;
  settings: Setting[];
  value: StringValue;
  span: Span;
}

// `color` takes a color or the word `none`.
const stickyColorSetting = (ctx: Ctx, key: Ident, start: Position): Setting => {
  const token = ctx.peek();
  if (token?.type === "color") return colorSetting(ctx, key, start);
  if (!isWord(token, "none")) fail(ctx, 'a color or "none"');
  const value = readNone(ctx);
  return { kind: "property", key: { ...key, value: key.value.toLowerCase() }, value, span: ctx.spanFrom(start) };
};

/** What a sticky note's settings list accepts. */
export const STICKY_NOTE_SETTINGS: SettingsSpec = {
  display: "a sticky note setting",
  flags: {},
  values: { color: stickyColorSetting },
  custom: true,
};

export const stickyNoteElement = defineElement("note", "Note", (ctx, start): StickyNote => {
  skipNewlines(ctx);
  const name = readQualifiedName(ctx, "a sticky note name");
  const { settings, settingsAllowed, openSwallowed } = readHeaderSettings(ctx, STICKY_NOTE_SETTINGS);
  if (!openSwallowed) {
    if (!isPunc(ctx.peek(), "{")) fail(ctx, settingsAllowed ? '"[" or "{"' : '"{"');
    ctx.next();
  }
  // From the element's start: a string left open in the header may have taken the `{` too.
  const value = readNoteBody(ctx, start);
  return { type: "stickyNote", name, settings, value, span: ctx.spanFrom(start) };
});
