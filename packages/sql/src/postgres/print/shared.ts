// Printers for AST pieces several statement families share. Each is
// self-contained: a family that needs one imports it from here rather than
// writing its own.
import { type Doc, join, line } from "@parser-kit/core/print";
import type {
  AlterGenericOption,
  Expr,
  GenericOption,
  PartitionKey,
  RelationOption,
  RelationOptionValue,
  SequenceOption,
} from "../ast";
import { RESERVED } from "../grammar";
import { ident, isColNameKeyword, kw, parenList, parens, qualified, quoted, str } from "./context";
import { expr } from "./expr";
import { typeName } from "./types";

// --- RelationOption ---

const BARE_WORD = /^[a-z_][a-z0-9_$]*$/;
// The words RESERVED holds that PG doesn't reserve (its type_func_name
// keywords, and SET), which its NonReservedWord admits bare. VALUES, which PG
// doesn't reserve either, stays quoted: `EXPLAIN (VALUES …` would open a query.
const NOT_RESERVED: ReadonlySet<string> = new Set([
  "cross",
  "full",
  "inner",
  "is",
  "join",
  "left",
  "like",
  "natural",
  "right",
  "set",
  "tablesample",
]);
// PG's reserved words: RESERVED less those, and the two it reads as functions bare.
const reserved = (w: string): boolean =>
  (RESERVED.has(w) && !NOT_RESERVED.has(w)) || w === "current_catalog" || w === "system_user";

/**
 * How an option list is spelt.
 * - `eq`: `name = value` (storage parameters) or `name value` (the utility
 *   lists of EXPLAIN, VACUUM, COPY, …, whose grammar in PG takes no `=`).
 * - `keywords`: a bare option name is written as a keyword (`ANALYZE`,
 *   `FORMAT`) rather than as a name.
 * - `reservedNames`: an option name may be a reserved word bare (PG's
 *   ColLabel: storage parameters, COPY); otherwise one is quoted, bar
 *   ANALYZE / ANALYSE (PG's utility_option_name).
 * - `reservedValues`: a word value may be a reserved word bare (PG's def_arg,
 *   storage parameters); otherwise one is quoted, bar ON (PG's
 *   opt_boolean_or_string, the utility lists' values).
 */
export interface OptionStyle {
  eq: boolean;
  keywords: boolean;
  reservedNames: boolean;
  reservedValues: boolean;
}

const optionValue = (v: RelationOptionValue, style: OptionStyle): Doc => {
  switch (v.kind) {
    case "star":
      return "*";
    case "optionList":
      return parenList(v.items.map((i) => optionValue(i, style)));
    case "name": {
      // `true` / `false` bare would read as booleans.
      const word = v.parts[0]!;
      // PG's def_arg (`reservedValues`) takes a reserved word bare but not a
      // col_name keyword (`between`, `values`), bar NONE, its own keyword there.
      const bare =
        BARE_WORD.test(word) &&
        word !== "true" &&
        word !== "false" &&
        (style.reservedValues ? word === "none" || !isColNameKeyword(word) : word === "on" || !reserved(word));
      return bare ? word : quoted(word);
    }
    case "number":
      return signedZero(v.value, v.raw) ?? expr(v);
    default:
      return expr(v);
  }
};

/** One `[namespace.]name [[=] value]` entry. */
export const relationOption = (o: RelationOption, style: OptionStyle): Doc => {
  const word = (w: string): string => {
    const bare = BARE_WORD.test(w) && (style.reservedNames || w === "analyze" || w === "analyse" || !reserved(w));
    return !bare ? quoted(w) : style.keywords ? kw(w.toUpperCase()) : w;
  };
  const name = o.namespace !== undefined ? `${word(o.namespace)}.${word(o.name)}` : word(o.name);
  return o.value === null ? name : [name, style.eq ? " = " : " ", optionValue(o.value, style)];
};

/** Storage parameters, `WITH (fillfactor = 70)`: PG's reloptions and def_arg values. */
export const STORAGE_PARAMETERS: OptionStyle = { eq: true, keywords: false, reservedNames: true, reservedValues: true };

/** `(option, …)`. */
export const relationOptions = (options: readonly RelationOption[], style: OptionStyle): Doc =>
  parenList(options.map((o) => relationOption(o, style)));

// --- PartitionKey ---

// PG's lexer reads FORMAT before JSON, WITHOUT before TIME and NULLS before
// FIRST / LAST as one token, which no name can be. So a name written where
// one of those words may follow it (a column before its type, an element
// before its operator class) is quoted when it is one of the three.
const LOOKAHEAD_WORDS: ReadonlySet<string> = new Set(["format", "without", "nulls"]);

/** A name another word may follow: a column before its type. */
export const leadName = (name: string): string => (LOOKAHEAD_WORDS.has(name) ? quoted(name) : ident(name));

/** A collation name, which an operator class may follow. */
export const collationName = (parts: readonly string[]): string =>
  parts.map((p, i) => (i === parts.length - 1 && LOOKAHEAD_WORDS.has(p) ? quoted(p) : ident(p))).join(".");

// BETWEEN continues any expression; OVER and FILTER a call when a `(` (the
// operator class's options) follows. The other words that would continue one
// are quoted by `ident` already (reserved words, IS, ISNULL, LIKE, …).
const CONTINUING_WORDS: ReadonlySet<string> = new Set(["between", "over", "filter"]);

/** An operator class, which follows its element's expression. */
export const opclassName = (parts: readonly string[]): string =>
  parts.map((p, i) => (i === 0 && CONTINUING_WORDS.has(p) ? quoted(p) : ident(p))).join(".");

/**
 * What PG's index_elem, part_elem and exclusion element take: a column (one
 * name part) or a call bare, anything else parenthesised, which never changes
 * what PG reads, and which this grammar requires of a partition key and drops
 * again on parsing.
 */
export const keyElement = (e: Expr): Doc =>
  e.kind === "name" && e.parts.length === 1
    ? LOOKAHEAD_WORDS.has(e.parts[0]!)
      ? quoted(e.parts[0]!)
      : expr(e)
    : e.kind === "call"
      ? expr(e)
      : parens(expr(e));

/**
 * A partition key or ON CONFLICT arbiter element: `column | func(…) | (expr)`,
 * then `[COLLATE collation] [opclass]`.
 */
export const partitionKey = (k: PartitionKey): Doc => [
  keyElement(k.expr),
  k.collate !== undefined ? [" ", kw("COLLATE"), " ", collationName(k.collate)] : "",
  k.opclass !== undefined ? [" ", opclassName(k.opclass)] : "",
];

// PG's ColLabel: any word, a reserved one included.
const colLabel = (name: string): string => (BARE_WORD.test(name) ? name : quoted(name));

/** `OPTIONS (name 'value', …)`: a CREATE's generic options. */
export const genericOptions = (options: readonly GenericOption[]): Doc => [
  kw("OPTIONS"),
  " ",
  parenList(options.map((o) => `${colLabel(o.name)} ${str(o.value)}`)),
];

/**
 * `OPTIONS ([ADD | SET] name 'value' | DROP name, …)`: an ALTER's generic
 * options. ADD, SET and DROP are actions only when no string follows them,
 * so an option of one of those names needs no quoting.
 */
export const alterGenericOptions = (options: readonly AlterGenericOption[]): Doc => [
  kw("OPTIONS"),
  " ",
  parenList(
    options.map((o) =>
      o.action === "drop"
        ? `${kw("DROP")} ${colLabel(o.name)}`
        : `${o.action !== undefined ? `${kw(o.action.toUpperCase())} ` : ""}${colLabel(o.name)} ${str(o.value)}`,
    ),
  ),
];

// The pseudo-roles a role position reads as keywords.
const ROLE_KEYWORDS = new Set(["current_user", "current_role", "session_user"]);

/**
 * A role: a name, or CURRENT_USER / CURRENT_ROLE / SESSION_USER. The tree
 * can't tell those from a role quoted with the same name, so they print as
 * the keywords.
 */
export const roleSpec = (role: string): string => (ROLE_KEYWORDS.has(role) ? kw(role.toUpperCase()) : ident(role));

/** `RENAME TO name`. */
export const renameTo = (to: string): Doc => `${kw("RENAME TO")} ${ident(to)}`;
/** `OWNER TO role`. */
export const ownerTo = (owner: string): Doc => `${kw("OWNER TO")} ${roleSpec(owner)}`;
/** `SET SCHEMA name`. */
export const setSchema = (schema: string): Doc => `${kw("SET SCHEMA")} ${ident(schema)}`;

/** One sequence option, as CREATE / ALTER SEQUENCE and an identity column take it. */
export const sequenceOption = (o: SequenceOption): Doc => {
  switch (o.kind) {
    case "as":
      return [kw("AS"), " ", typeName(o.type)];
    case "increment":
      return [kw("INCREMENT BY"), " ", expr(o.value)];
    case "minValue":
      return o.value === null ? kw("NO MINVALUE") : [kw("MINVALUE"), " ", expr(o.value)];
    case "maxValue":
      return o.value === null ? kw("NO MAXVALUE") : [kw("MAXVALUE"), " ", expr(o.value)];
    case "start":
      return [kw("START WITH"), " ", expr(o.value)];
    case "restart":
      return o.value === null ? kw("RESTART") : [kw("RESTART WITH"), " ", expr(o.value)];
    case "cache":
      return [kw("CACHE"), " ", expr(o.value)];
    case "cycle":
      return kw(o.value ? "CYCLE" : "NO CYCLE");
    case "ownedBy":
      // A one-part `none` is quoted: bare, it is OWNED BY NONE.
      return [
        kw("OWNED BY"),
        " ",
        o.owner === null
          ? kw("NONE")
          : o.owner.length === 1 && o.owner[0] === "none"
            ? quoted("none")
            : qualified(o.owner),
      ];
    case "sequenceName":
      return [kw("SEQUENCE NAME"), " ", qualified(o.name)];
  }
};

/** `(option option …)`: sequence options, which PG separates with spaces, not commas. */
export const sequenceOptions = (options: readonly SequenceOption[]): Doc =>
  parens(join(line, options.map(sequenceOption)));

/** `-0` for a negative zero with no text of its own, which the number printer would write as `0`. */
export const signedZero = (value: number, raw?: string): string | null =>
  Object.is(value, -0) && raw === undefined ? "-0" : null;
