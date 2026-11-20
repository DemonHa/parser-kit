// Printers for AST pieces several statement families share: option lists
// (`RelationOption`, `GenericOption`), role names, sequence options and the
// common ALTER actions (rename, owner, schema). Each is small and
// self-contained, so a family imports only what it needs.
import { type Doc, join, line } from "@parser-kit/core/print";
import type {
  AlterGenericOption,
  GenericOption,
  RelationOption,
  RelationOptionScalar,
  RelationOptionValue,
  SequenceOption,
} from "../ast";
import { ident, isColNameKeyword, kw, parenList, parens, qualified, quoted, str } from "./context";
import { expr } from "./expr";
import { typeName } from "./types";

// PG's ColLabel: any word, a reserved one included, so a lower-case word is
// written bare unless the caller says it must not be.
const BARE_WORD = /^[a-z_][a-z0-9_$]*$/;
const label = (name: string, bareAllowed = true): string => (bareAllowed && BARE_WORD.test(name) ? name : quoted(name));

/** `-0` for a negative zero with no text of its own, which the number printer would write as `0`. */
export const signedZero = (value: number, raw?: string): string | null =>
  Object.is(value, -0) && raw === undefined ? "-0" : null;

// A word value: bare unless it would read as a boolean.
const optionScalar = (v: RelationOptionScalar): Doc => {
  switch (v.kind) {
    case "name": {
      // PG's def_arg takes a type name or a reserved word bare, but not a
      // col_name keyword (`between`, `values`), and a bare true / false
      // would read as a boolean.
      const word = v.parts[0]!;
      return label(word, word !== "true" && word !== "false" && !isColNameKeyword(word));
    }
    case "string":
      return str(v.value);
    case "number":
      return signedZero(v.value, v.raw) ?? expr(v);
    default:
      return expr(v);
  }
};

const optionValue = (v: RelationOptionValue): Doc =>
  v.kind === "star" ? "*" : v.kind === "optionList" ? parenList(v.items.map(optionScalar)) : optionScalar(v);

/**
 * One `[namespace.]name [= value]` entry of a parenthesised option list.
 * `separator` is what goes between the name and its value: `" = "` for
 * storage parameters (`WITH (fillfactor = 70)`), `" "` for the lists PG writes
 * without one (COPY's and EXPLAIN's).
 */
export const relationOption = (o: RelationOption, separator = " = "): Doc => [
  o.namespace !== undefined ? `${label(o.namespace)}.` : "",
  label(o.name),
  o.value !== null ? [separator, optionValue(o.value)] : "",
];

/** `(a = 1, b, c = 'x')`. */
export const relationOptions = (options: readonly RelationOption[], separator?: string): Doc =>
  parenList(options.map((o) => relationOption(o, separator)));

/** `OPTIONS (name 'value', …)`: a CREATE's generic options. */
export const genericOptions = (options: readonly GenericOption[]): Doc => [
  kw("OPTIONS"),
  " ",
  parenList(options.map((o) => `${label(o.name)} ${str(o.value)}`)),
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
        ? `${kw("DROP")} ${label(o.name)}`
        : `${o.action !== undefined ? `${kw(o.action.toUpperCase())} ` : ""}${label(o.name)} ${str(o.value)}`,
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
