// The document IR: a Wadler/Leijen-style description of output text that
// `render` lays out for a given line width. A Doc is a string, an array of
// Docs (concatenation), or one of the commands below. Docs are plain immutable
// values: build them once, render them at any width. Build groups with
// `group()` and don't mutate an array after wrapping it, because `group()`
// decides once whether its contents must break.

/** A document: text, a concatenation (array), or a layout command. */
export type Doc = string | readonly Doc[] | DocCommand;

/** Every non-text, non-array Doc node. Switch on `type`. */
export type DocCommand = Group | Indent | Line | IfBreak;

/**
 * Lays its contents out flat (every `line` a space, every `softline` nothing)
 * when they fit in the remaining width, and broken (every line a newline)
 * otherwise.
 */
export interface Group {
  readonly type: "group";
  readonly contents: Doc;
  /**
   * True when the group can never be flat: it was built with `shouldBreak`,
   * or its flat layout contains a `hardline` or a group that must break.
   * Computed once by `group()`; don't build a Group literal by hand.
   */
  readonly break: boolean;
}

/** Adds one indentation level to every line break inside `contents`. */
export interface Indent {
  readonly type: "indent";
  readonly contents: Doc;
}

/**
 * A possible line break. In a flat group a plain line prints a space and a soft
 * line prints nothing; in a broken group both print a newline plus the current
 * indentation. A hard line always breaks, and breaks every group around it.
 */
export interface Line {
  readonly type: "line";
  readonly soft?: true;
  readonly hard?: true;
}

/** Prints `breakContents` when the enclosing group is broken, else `flatContents`. */
export interface IfBreak {
  readonly type: "ifBreak";
  readonly breakContents: Doc;
  readonly flatContents: Doc;
}

export interface GroupOptions {
  /** Break the group even if it would fit. Groups around it break too. */
  shouldBreak?: boolean;
}

export interface BlockOptions {
  /** Opening delimiter, printed after the header. Default `"{"`. */
  open?: Doc;
  /** Closing delimiter, on its own line. Default `"}"`. */
  close?: Doc;
}

export interface ListOptions {
  /** Printed between items, before the line break. Default `","`. */
  separator?: Doc;
  /** `"omit"` prints nothing at all for an empty list; `"keep"` (default) prints `open` + `close`. */
  empty?: "keep" | "omit";
}

/** A space or a newline. */
export const line: Line = { type: "line" };
/** Nothing or a newline. */
export const softline: Line = { type: "line", soft: true };
/** Always a newline; forces every enclosing group to break. */
export const hardline: Line = { type: "line", hard: true };
/**
 * A space that never becomes a line break. Use it where a newline would change
 * meaning, e.g. between two tokens a lexer would join across lines.
 */
export const nbsp = " ";

/** True when laying `contents` out flat is impossible. Iterative, so deep docs are safe. */
const mustBreak = (contents: Doc): boolean => {
  const todo: Doc[] = [contents];
  while (todo.length > 0) {
    const d = todo.pop()!;
    if (typeof d === "string") continue;
    if (Array.isArray(d)) {
      for (const c of d) todo.push(c);
      continue;
    }
    const c = d as DocCommand;
    switch (c.type) {
      case "group":
        // Already computed for the nested group; no need to look inside.
        if (c.break) return true;
        break;
      case "line":
        if (c.hard) return true;
        break;
      case "indent":
        todo.push(c.contents);
        break;
      case "ifBreak":
        // Only the flat branch is printed when this group is flat, so a hard
        // line in the broken branch doesn't force a break (prettier's does).
        todo.push(c.flatContents);
        break;
    }
  }
  return false;
};

/** Tries `contents` on one line; breaks all of its own lines if it doesn't fit. */
export const group = (contents: Doc, options?: GroupOptions): Group => ({
  type: "group",
  contents,
  break: options?.shouldBreak === true || mustBreak(contents),
});

/** Indents the line breaks inside `contents` by one level. */
export const indent = (contents: Doc): Indent => ({ type: "indent", contents });

/** `breakContents` if the enclosing group breaks, otherwise `flatContents`. */
export const ifBreak = (breakContents: Doc, flatContents: Doc = ""): IfBreak => ({
  type: "ifBreak",
  breakContents,
  flatContents,
});

/** Puts `separator` between consecutive docs. */
export const join = (separator: Doc, docs: readonly Doc[]): Doc[] => {
  const out: Doc[] = [];
  for (let i = 0; i < docs.length; i++) {
    if (i > 0) out.push(separator);
    out.push(docs[i]!);
  }
  return out;
};

const isEmpty = (d: Doc): boolean => d === "" || (Array.isArray(d) && d.length === 0);

/**
 * A header followed by a delimited body with one item per line, indented:
 *
 * ```text
 * header {
 *   item
 *   item
 * }
 * ```
 *
 * The body always breaks. With no items it prints `header {}`. An empty header
 * (`""` or `[]`) prints the body alone, with no leading space.
 */
export const block = (header: Doc, items: readonly Doc[], options?: BlockOptions): Doc[] => {
  const open = options?.open ?? "{";
  const close = options?.close ?? "}";
  const head: Doc[] = isEmpty(header) ? [open] : [header, " ", open];
  if (items.length === 0) return [...head, close];
  return [...head, indent([hardline, join(hardline, items)]), hardline, close];
};

/**
 * A bracketed, separated list. Flat it prints `[a, b]`; broken, one item per
 * line, indented, with the brackets on their own lines. `open` is any Doc, so a
 * leading space can live in it: `list(" [", settings, "]", { empty: "omit" })`
 * prints ` [pk, unique]`, or nothing at all when `settings` is empty.
 */
export const list = (open: Doc, items: readonly Doc[], close: Doc, options?: ListOptions): Doc => {
  if (items.length === 0) return options?.empty === "omit" ? "" : [open, close];
  return group([open, indent([softline, join([options?.separator ?? ",", line], items)]), softline, close]);
};
