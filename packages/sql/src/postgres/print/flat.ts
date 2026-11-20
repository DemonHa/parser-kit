// One-line output without the general renderer: what `stringify` does at its
// default width, and what `render` gives at width Infinity. Inside a group
// every `line` is a space, every soft line nothing and every `ifBreak` its flat
// branch. Where `render` would break instead (a hard line, a group built to
// break, or a line or `ifBreak` outside every group, which `render` lays out
// broken), this returns null and leaves the doc to `render`.
import type { Doc, DocCommand } from "@parser-kit/core/print";

// Pops back out of a group's contents.
const LEAVE = Symbol("leave");

export const flat = (doc: Doc): string | null => {
  let out = "";
  let depth = 0;
  const todo: (Doc | typeof LEAVE)[] = [doc];
  while (todo.length > 0) {
    const d = todo.pop()!;
    if (d === LEAVE) {
      depth--;
    } else if (typeof d === "string") {
      out += d;
    } else if (Array.isArray(d)) {
      for (let i = d.length - 1; i >= 0; i--) todo.push(d[i]!);
    } else {
      const c = d as DocCommand;
      switch (c.type) {
        case "group":
          if (c.break) return null;
          depth++;
          todo.push(LEAVE, c.contents);
          break;
        case "indent":
          todo.push(c.contents);
          break;
        case "ifBreak":
          if (depth === 0) return null;
          todo.push(c.flatContents);
          break;
        case "line":
          if (c.hard || depth === 0) return null;
          if (!c.soft) out += " ";
          break;
        default: {
          // A command this doesn't know (one core adds later): leave it to `render`.
          const unknown: never = c;
          void unknown;
          return null;
        }
      }
    }
  }
  // `render` drops trailing spaces and tabs; so does this.
  return out.replace(/[ \t]+$/, "");
};
