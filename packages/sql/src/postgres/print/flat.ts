// One-line output without the general renderer: what `stringify` does at its
// default width. Every `line` is a space, every soft line nothing, every
// `ifBreak` its flat branch. A doc that must break somewhere (a hard line, or
// a group built to break) is left to `render`, which this returns null for.
import type { Doc, DocCommand } from "@parser-kit/core/print";

export const flat = (doc: Doc): string | null => {
  let out = "";
  const todo: Doc[] = [doc];
  while (todo.length > 0) {
    const d = todo.pop()!;
    if (typeof d === "string") {
      out += d;
    } else if (Array.isArray(d)) {
      for (let i = d.length - 1; i >= 0; i--) todo.push(d[i]!);
    } else {
      const c = d as DocCommand;
      switch (c.type) {
        case "group":
          if (c.break) return null;
          todo.push(c.contents);
          break;
        case "indent":
          todo.push(c.contents);
          break;
        case "ifBreak":
          todo.push(c.flatContents);
          break;
        case "line":
          if (c.hard) return null;
          if (!c.soft) out += " ";
          break;
      }
    }
  }
  // `render` drops trailing spaces and tabs; so does this.
  return out.replace(/[ \t]+$/, "");
};
