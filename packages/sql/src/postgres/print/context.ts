// What every PostgreSQL printer module shares: the options of the call in
// progress and the lexical rules for writing keywords, names and strings.
//
// The options live in module state for the duration of one `stringify` call
// (set and restored by `withOptions`), so the printers stay plain functions of
// a node and need no options argument threaded through every handler.
import { type Doc, group, indent, join, line, quoting, softline } from "@parser-kit/core/print";
import type { Stmt } from "../ast";
import { RESERVED } from "../grammar";

export interface StringifyOptions {
  /**
   * Target line width. Default `Infinity`: every statement on one line. A
   * number lays the output out to fit it where it can (`80` for readable SQL).
   */
  width?: number;
  /** One indentation level when the output breaks: a number of spaces or a string. Default 2. */
  indent?: number | string;
  /** How keywords are written. Default `"upper"`. Names are never re-cased. */
  keywordCase?: "upper" | "lower";
  /**
   * `"minimal"` (default) quotes a name only when it must be (not a lower-case
   * word, or a reserved one); `"always"` quotes every table, column and alias
   * name. Function and type names stay minimal either way: quoting one can
   * change what it means (`int` is `int4`, `"int"` is looked up as written).
   */
  identifierQuote?: "minimal" | "always";
  /**
   * The `;` after statements, when printing statements: after every one
   * (`"always"`, default), only between them (`"between"`), or none.
   */
  semicolons?: "always" | "between" | "never";
  /**
   * `"standard"` (default) writes every string as `'…'`, the reading of a
   * server with `standard_conforming_strings = on`. `"escape"` writes one that
   * holds a backslash or a control character as `E'…'` instead, which every
   * server reads the same way.
   */
  strings?: "standard" | "escape";
}

const state = {
  lower: false,
  always: false,
  escape: false,
};

/** Runs `print` with `options` in effect, restoring the previous ones after (calls may nest). */
export const withOptions = <T>(options: StringifyOptions | undefined, print: () => T): T => {
  const saved = { lower: state.lower, always: state.always, escape: state.escape };
  state.lower = options?.keywordCase === "lower";
  state.always = options?.identifierQuote === "always";
  state.escape = options?.strings === "escape";
  try {
    return print();
  } finally {
    state.lower = saved.lower;
    state.always = saved.always;
    state.escape = saved.escape;
  }
};

/** A keyword, or a run of keywords, written upper-case in the source. */
export const kw = (text: string): string => (state.lower ? text.toLowerCase() : text);

// PG's bare identifier, as the grammar reads one: a lower-case word that is
// not reserved. Anything else is written quoted, `"` doubled.
const quoteName = quoting({ quote: '"', start: /[a-z_]/, part: /[a-z0-9_$]/, reserved: RESERVED, fold: "lower" });

// The common case, a bare word, without the general rules' per-character scan.
const BARE_WORD = /^[a-z_][a-z0-9_$]*$/;
const minimal = (name: string): string =>
  BARE_WORD.test(name) && !RESERVED.has(name) ? name : quoteName(name, "minimal");

/** A table, column, alias or other object name. */
export const ident = (name: string): string => (state.always ? quoteName(name, "always") : minimal(name));
/** A function or type name: quoted only when it must be, whatever `identifierQuote` says. */
export const bareIdent = minimal;
/** A dotted name, each part through `ident`. */
export const qualified = (parts: readonly string[]): string => parts.map(ident).join(".");
/** A dotted function or type name, each part through `bareIdent`. */
export const bareQualified = (parts: readonly string[]): string => parts.map(bareIdent).join(".");

// What `E'…'` writes with a backslash: control characters and the backslash
// itself (the quote is doubled, as in `'…'`).
const ESCAPES: Record<string, string> = {
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\\": "\\\\",
};
const needsEscape = (code: number): boolean => code < 0x20 || code === 0x7f || code === 0x5c;
const escapeAll = (text: string): string => {
  let out = "";
  for (const ch of text) {
    out += needsEscape(ch.charCodeAt(0)) ? (ESCAPES[ch] ?? `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`) : ch;
  }
  return out;
};

/**
 * A string constant. Re-encoded from the value (the source spelling is gone):
 * `'…'` with `''` doubling, or `E'…'` under `strings: "escape"` when the value
 * holds a backslash or a control character.
 */
export const str = (value: string): string => {
  const quoted = value.replace(/'/g, "''");
  if (state.escape) {
    for (let i = 0; i < value.length; i++) {
      if (needsEscape(value.charCodeAt(i))) return `${kw("E")}'${escapeAll(quoted)}'`;
    }
  }
  return `'${quoted}'`;
};

/** `a, b, c`, breaking after each comma when the enclosing group breaks. */
export const commaList = (items: readonly Doc[]): Doc => join([",", line], items);

/** `( … )` around `inner`, which moves to its own indented lines when it doesn't fit. */
export const parens = (inner: Doc): Doc => group(["(", indent([softline, inner]), softline, ")"]);

/** `(a, b, c)`. */
export const parenList = (items: readonly Doc[]): Doc => parens(commaList(items));

/** A clause: its keyword, then its body indented on the next line when it doesn't fit. */
export const clause = (keyword: Doc, body: Doc): Doc => group([keyword, indent([line, body])]);

/**
 * The first character a doc prints, or "" when it prints nothing. Follows the
 * leftmost path only (and the flat branch of an `ifBreak`), so it is cheap.
 */
export const firstChar = (doc: Doc): string => {
  const todo: Doc[] = [doc];
  while (todo.length > 0) {
    const d = todo.pop()!;
    if (typeof d === "string") {
      if (d !== "") return d[0]!;
    } else if (Array.isArray(d)) {
      for (let i = d.length - 1; i >= 0; i--) todo.push(d[i]!);
    } else {
      const c = d as Exclude<Doc, string | readonly Doc[]>;
      if (c.type === "line") return " ";
      todo.push(c.type === "ifBreak" ? c.flatContents : c.contents);
    }
  }
  return "";
};

/**
 * The statement printer, set by `index.ts` once every family is loaded. A
 * family module that prints a nested statement (a CTE body) calls it through
 * here rather than importing `index.ts`, which imports the family modules.
 */
export const statementPrinter: { print: (stmt: Stmt) => Doc } = {
  print: () => {
    throw new Error("The statement printer is not loaded");
  },
};

/** PG's operator characters: two of them side by side lex as one operator, `--` as a comment. */
export const OPERATOR_CHARS = new Set("+-*/<>=~!@#%^&|`?");

/**
 * Thrown for a node whose printer has not been written yet. The statement
 * families land one at a time; until a family has its printer, its statements
 * throw this rather than printing something wrong.
 */
export class NotPrintableError extends Error {
  constructor(readonly kind: string) {
    super(`A "${kind}" statement is not yet printable`);
    this.name = "NotPrintableError";
  }
}
