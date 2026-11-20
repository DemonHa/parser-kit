// Printers for AST pieces several statement families share. Each is
// self-contained: a family that needs one imports it from here rather than
// writing its own.
import type { Doc } from "@parser-kit/core/print";
import type { PartitionKey, RelationOption, RelationOptionValue } from "../ast";
import { RESERVED } from "../grammar";
import { kw, parenList, qualified, quoted } from "./context";
import { expr } from "./expr";

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
      const bare =
        BARE_WORD.test(word) &&
        word !== "true" &&
        word !== "false" &&
        (style.reservedValues || word === "on" || !reserved(word));
      return bare ? word : quoted(word);
    }
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

/** `(option, …)`. */
export const relationOptions = (options: readonly RelationOption[], style: OptionStyle): Doc =>
  parenList(options.map((o) => relationOption(o, style)));

// --- PartitionKey ---

/**
 * A partition key or ON CONFLICT arbiter element: `column | func(…) | (expr)`,
 * then `[COLLATE collation] [opclass]`. Anything but a one-part column or a
 * call is parenthesised, as the grammar requires.
 */
export const partitionKey = (k: PartitionKey): Doc => [
  (k.expr.kind === "name" && k.expr.parts.length === 1) || k.expr.kind === "call"
    ? expr(k.expr)
    : ["(", expr(k.expr), ")"],
  k.collate !== undefined ? [" ", kw("COLLATE"), " ", qualified(k.collate)] : "",
  k.opclass !== undefined ? [" ", qualified(k.opclass)] : "",
];
