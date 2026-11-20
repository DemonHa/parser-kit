import type { Doc, DocCommand } from "./doc";

export interface RenderOptions {
  /**
   * Target line width, in characters. Default 80. `Infinity` lays every group
   * out flat (only hard lines break) and skips all width measurement.
   */
  width?: number;
  /**
   * One indentation level: a number of spaces, or a string such as `"\t"`.
   * Default 2. A string is measured by its length, so a tab counts as one column.
   */
  indent?: number | string;
}

// One indentation level, linked to its parent. `next` caches the child so each
// depth's string is built once per render.
interface IndentLevel {
  readonly text: string;
  readonly width: number;
  next?: IndentLevel;
}

const FLAT = 0;
const BREAK = 1;
type Mode = typeof FLAT | typeof BREAK;

// The work stack holds commands as flat triples (indentation, mode, doc), so a
// push allocates nothing. The doc is on top: pop the doc, then mode, then indentation.
type Stack = (IndentLevel | Mode | Doc)[];

/**
 * Whether `doc`, laid out flat, plus whatever follows it up to the next line
 * break, fits in `width` columns. `rest` is the render stack: once `doc` is
 * measured, the commands after it are read from the top down, in their own
 * modes, until one of them breaks a line.
 */
const fits = (doc: Doc, rest: Stack, width: number): boolean => {
  const todo: (Mode | Doc)[] = [FLAT, doc];
  let restIndex = rest.length;
  while (width >= 0) {
    if (todo.length === 0) {
      if (restIndex === 0) return true;
      todo.push(rest[restIndex - 2] as Mode, rest[restIndex - 1] as Doc);
      restIndex -= 3;
      continue;
    }
    const d = todo.pop() as Doc;
    const mode = todo.pop() as Mode;
    if (typeof d === "string") {
      const nl = d.indexOf("\n");
      if (nl >= 0) return width - nl >= 0;
      width -= d.length;
    } else if (Array.isArray(d)) {
      for (let i = d.length - 1; i >= 0; i--) todo.push(mode, d[i]!);
    } else {
      const c = d as DocCommand;
      switch (c.type) {
        case "group":
          todo.push(c.break ? BREAK : mode, c.contents);
          break;
        case "indent":
          todo.push(mode, c.contents);
          break;
        case "ifBreak":
          todo.push(mode, mode === BREAK ? c.breakContents : c.flatContents);
          break;
        case "line":
          // The first newline ends the measured line: everything so far fit.
          if (mode === BREAK || c.hard) return true;
          if (!c.soft) width -= 1;
          break;
      }
    }
  }
  return false;
};

// Drops spaces and tabs at the end of the output. Called at every line break the
// doc makes and at the end, so no rendered line ends in whitespace. (Text that
// contains its own "\n" is written as is.)
const trimTrailing = (out: string[]): void => {
  while (out.length > 0) {
    const last = out[out.length - 1]!;
    let end = last.length;
    while (end > 0 && (last[end - 1] === " " || last[end - 1] === "\t")) end--;
    if (end > 0) {
      if (end < last.length) out[out.length - 1] = last.slice(0, end);
      return;
    }
    out.pop();
  }
};

/**
 * Lays `doc` out as text. A group prints flat when it fits in what is left of
 * the current line, and broken otherwise; lines outside every group always
 * break. Text is measured by `.length`, an indentation string by its length,
 * and a `"\n"` inside text is written as is (no indentation added after it).
 *
 * Spaces and tabs before each line break the doc makes, and at the very end,
 * are dropped (prettier does the same), so a group ending in `line` before a
 * hard line leaves no trailing space. Lines outside every group always break,
 * and an `ifBreak` outside every group prints its broken branch. The walk
 * is iterative, so document depth is limited by memory, not the call stack.
 */
export const render = (doc: Doc, options?: RenderOptions): string => {
  const width = options?.width ?? 80;
  const unit = options?.indent ?? 2;
  const unitText = typeof unit === "number" ? " ".repeat(unit) : unit;
  const measure = width !== Number.POSITIVE_INFINITY;

  const root: IndentLevel = { text: "", width: 0 };
  const deeper = (level: IndentLevel): IndentLevel =>
    (level.next ??= { text: level.text + unitText, width: level.width + unitText.length });

  // Output chunks, joined once at the end. Keeping them separate lets a newline
  // trim the trailing whitespace before it without rescanning the whole output.
  const out: string[] = [];
  let pos = 0;
  // Indentation owed by the last newline, written before the next text.
  let pending: IndentLevel | null = null;

  const stack: Stack = [root, BREAK, doc];
  while (stack.length > 0) {
    const d = stack.pop() as Doc;
    const mode = stack.pop() as Mode;
    const level = stack.pop() as IndentLevel;

    if (typeof d === "string") {
      if (d === "") continue;
      if (pending !== null) {
        out.push(pending.text);
        pending = null;
      }
      out.push(d);
      if (measure) {
        const nl = d.lastIndexOf("\n");
        pos = nl >= 0 ? d.length - nl - 1 : pos + d.length;
      }
    } else if (Array.isArray(d)) {
      for (let i = d.length - 1; i >= 0; i--) stack.push(level, mode, d[i]!);
    } else {
      const c = d as DocCommand;
      switch (c.type) {
        case "group": {
          let groupMode: Mode;
          if (c.break) groupMode = BREAK;
          else if (mode === FLAT || !measure) groupMode = FLAT;
          else groupMode = fits(c.contents, stack, width - pos) ? FLAT : BREAK;
          stack.push(level, groupMode, c.contents);
          break;
        }
        case "indent":
          stack.push(deeper(level), mode, c.contents);
          break;
        case "ifBreak":
          stack.push(level, mode, mode === BREAK ? c.breakContents : c.flatContents);
          break;
        case "line":
          if (mode === FLAT && !c.hard) {
            if (!c.soft) {
              if (pending !== null) {
                out.push(pending.text);
                pending = null;
              }
              out.push(" ");
              pos += 1;
            }
          } else {
            trimTrailing(out);
            out.push("\n");
            pending = level;
            pos = level.width;
          }
          break;
      }
    }
  }
  trimTrailing(out);
  return out.join("");
};
