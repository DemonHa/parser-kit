// What every PostgreSQL printer module shares: the options of the call in
// progress and the lexical rules for writing keywords, names and strings.
//
// The options live in module state for the duration of one `stringify` call
// (set and restored by `withOptions`), so the printers stay plain functions of
// a node and need no options argument threaded through every handler.
import { type Doc, group, indent, join, line, quoting, softline } from "@parser-kit/core/print";
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
  routine: false,
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

/**
 * Runs `print` for a CREATE [OR REPLACE] FUNCTION / PROCEDURE statement. psql
 * (and `parseScript`) counts every bare `begin` outside parentheses in one as
 * opening a `BEGIN ATOMIC` body, whose `;`s don't end the statement, so a name
 * `begin` is quoted there, or the statements after it would be split wrongly.
 */
export const inRoutineStatement = <T>(print: () => T): T => {
  const saved = state.routine;
  state.routine = true;
  try {
    return print();
  } finally {
    state.routine = saved;
  }
};

/** Whether a word may be written bare where it reads as a name: not `begin` in a routine statement. */
export const bareAllowed = (word: string): boolean => !(state.routine && word === "begin");

/** A keyword, or a run of keywords, written upper-case in the source. */
export const kw = (text: string): string => (state.lower ? text.toLowerCase() : text);

// PG's reserved words beyond the grammar's RESERVED: two it reads as functions
// when bare (the grammar reads them as names, so it doesn't reserve them).
const ALSO_RESERVED: ReadonlySet<string> = new Set(["current_catalog", "system_user"]);
// PG's type_func_name_keyword list: a function or type may be named one, but
// not a column, table or alias, so those are quoted. `exists` is a
// col_name_keyword, fine as a column name to PG, but the grammar here reads it
// as EXISTS wherever an expression starts.
const NOT_COLUMN_NAMES: ReadonlySet<string> = new Set([
  "authorization",
  "binary",
  "collation",
  "concurrently",
  "cross",
  "current_schema",
  "freeze",
  "full",
  "ilike",
  "inner",
  "is",
  "isnull",
  "join",
  "left",
  "like",
  "natural",
  "notnull",
  "outer",
  "overlaps",
  "right",
  "similar",
  "tablesample",
  "verbose",
  "exists",
]);
const reservedRoutine = (w: string): boolean => RESERVED.has(w) || ALSO_RESERVED.has(w);
const reservedName = (w: string): boolean => reservedRoutine(w) || NOT_COLUMN_NAMES.has(w);

// PG's bare identifier, as the grammar reads one: a lower-case word that is
// not reserved. Anything else is written quoted, `"` doubled.
const rules = { quote: '"', start: /[a-z_]/, part: /[a-z0-9_$]/, fold: "lower" } as const;
const quoteName = quoting({ ...rules, reserved: reservedName });
const quoteRoutine = quoting({ ...rules, reserved: reservedRoutine });

// The common case, a bare word, without the general rules' per-character scan.
const BARE_WORD = /^[a-z_][a-z0-9_$]*$/;
const minimal = (name: string): string =>
  !bareAllowed(name)
    ? quoteName(name, "always")
    : BARE_WORD.test(name) && !reservedRoutine(name)
      ? name
      : quoteRoutine(name, "minimal");
const minimalName = (name: string): string =>
  !bareAllowed(name)
    ? quoteName(name, "always")
    : BARE_WORD.test(name) && !reservedName(name)
      ? name
      : quoteName(name, "minimal");

/** A table, column, alias or other object name. */
export const ident = (name: string): string => (state.always ? quoteName(name, "always") : minimalName(name));
/** A dotted name, each part through `ident`. */
export const qualified = (parts: readonly string[]): string => parts.map(ident).join(".");
/** A name always written quoted. */
export const quoted = (name: string): string => quoteName(name, "always");
/**
 * A type name part, or a word PG reads as a name (an EXTRACT field, an
 * encoding): quoted only when it must be, whatever `identifierQuote` says.
 */
export const minimalIdent = minimal;

/**
 * A dotted function name, PG's `ColId indirection`: the first part is a column
 * name (no reserved or type_func_name keyword), the rest any word.
 */
export const functionQualified = (parts: readonly string[]): string =>
  parts.map((p, i) => (i === 0 ? minimalName(p) : minimal(p))).join(".");
/**
 * A dotted type name, PG's `type_function_name attrs`: the first part is no
 * reserved or col_name keyword, the rest any word.
 */
export const typeQualified = (parts: readonly string[]): string =>
  parts.map((p, i) => (i === 0 && parts.length > 1 && COL_NAME_KEYWORDS.has(p) ? quoted(p) : minimal(p))).join(".");

// PG's col_name_keyword list (gram.y): words a column may be named, but not
// a one-part function, a named argument or a TABLESAMPLE method, so those are
// quoted. (Most are type names or keyword forms this grammar reads by value.)
const COL_NAME_KEYWORDS: ReadonlySet<string> = new Set([
  "between",
  "bigint",
  "bit",
  "boolean",
  "char",
  "character",
  "coalesce",
  "dec",
  "decimal",
  "exists",
  "extract",
  "float",
  "greatest",
  "grouping",
  "inout",
  "int",
  "integer",
  "interval",
  "json",
  "json_array",
  "json_arrayagg",
  "json_exists",
  "json_object",
  "json_objectagg",
  "json_query",
  "json_scalar",
  "json_serialize",
  "json_table",
  "json_value",
  "least",
  "merge_action",
  "national",
  "nchar",
  "none",
  "normalize",
  "nullif",
  "numeric",
  "out",
  "overlay",
  "position",
  "precision",
  "real",
  "row",
  "setof",
  "smallint",
  "substring",
  "time",
  "timestamp",
  "treat",
  "trim",
  "values",
  "varchar",
  "xmlattributes",
  "xmlconcat",
  "xmlelement",
  "xmlexists",
  "xmlforest",
  "xmlnamespaces",
  "xmlparse",
  "xmlpi",
  "xmlroot",
  "xmlserialize",
  "xmltable",
]);

/** Whether a one-part function name is one of PG's col_name keywords. */
export const isColNameKeyword = (name: string): boolean => COL_NAME_KEYWORDS.has(name);

/** A named argument's name or a TABLESAMPLE method: PG's type_function_name. */
export const functionWord = (name: string): string => (COL_NAME_KEYWORDS.has(name) ? quoted(name) : minimal(name));

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
export const firstChar = (doc: Doc): string => firstText(doc)[0] ?? "";

/**
 * Whether a doc may print `(` first, in either layout: unlike `firstChar`, this
 * follows both branches of an `ifBreak`.
 */
export const mayOpenWithParen = (doc: Doc): boolean => {
  const todo: Doc[] = [doc];
  while (todo.length > 0) {
    const d = todo.pop()!;
    if (typeof d === "string") {
      // Another branch may still be pending.
      if (d[0] === "(") return true;
      continue;
    }
    if (Array.isArray(d)) {
      // Only the leftmost element that prints anything counts.
      const firstNonEmpty = d.find((c) => !(typeof c === "string" && c === ""));
      if (firstNonEmpty !== undefined) todo.push(firstNonEmpty);
      continue;
    }
    const c = d as Exclude<Doc, string | readonly Doc[]>;
    if (c.type === "line") continue;
    if (c.type === "ifBreak") todo.push(c.breakContents, c.flatContents);
    else todo.push(c.contents);
  }
  return false;
};

/** The last non-empty text a doc prints (" " for a line), or "". */
export const lastText = (doc: Doc): string => {
  const todo: Doc[] = [doc];
  while (todo.length > 0) {
    const d = todo.pop()!;
    if (typeof d === "string") {
      if (d !== "") return d;
    } else if (Array.isArray(d)) {
      for (const c of d) todo.push(c);
    } else {
      const c = d as Exclude<Doc, string | readonly Doc[]>;
      if (c.type === "line") return " ";
      todo.push(c.type === "ifBreak" ? c.flatContents : c.contents);
    }
  }
  return "";
};

/** The first non-empty text a doc prints (" " for a line), or "". */
export const firstText = (doc: Doc): string => {
  const todo: Doc[] = [doc];
  while (todo.length > 0) {
    const d = todo.pop()!;
    if (typeof d === "string") {
      if (d !== "") return d;
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

/** PG's operator characters: two of them side by side lex as one operator, `--` as a comment. */
export const OPERATOR_CHARS = new Set("+-*/<>=~!@#%^&|`?");

/**
 * Thrown for a statement kind the parser reads but the printer can't print
 * yet, rather than printing something wrong. Every kind is printable today;
 * a statement the grammar learns before its printer does throws this until
 * the printer catches up. `kind` names the statement kind.
 */
export class NotPrintableError extends Error {
  readonly kind: string;
  constructor(kind: string) {
    super(`A "${kind}" statement is not yet printable`);
    this.kind = kind;
    this.name = "NotPrintableError";
  }
}
