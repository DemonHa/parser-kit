// Printers for AST pieces several statement families share. Each is
// self-contained: a family that needs one imports it from here rather than
// writing its own.
import type { Doc } from "@parser-kit/core/print";
import type { PartitionKey, RelationOption, RelationOptionValue } from "../ast";
import { kw, parenList, qualified, quoted } from "./context";
import { expr } from "./expr";

// --- RelationOption ---

// An option name or word value is any word to the grammar (PG's ColLabel), so
// a lower-case word is written bare even when reserved; anything else quoted.
const BARE_WORD = /^[a-z_][a-z0-9_$]*$/;
const optionWord = (word: string): string => (BARE_WORD.test(word) ? word : quoted(word));

const optionValue = (v: RelationOptionValue): Doc => {
  switch (v.kind) {
    case "star":
      return "*";
    case "optionList":
      return parenList(v.items.map(optionValue));
    case "name": {
      // `true` / `false` bare would read as booleans.
      const word = v.parts[0]!;
      return word === "true" || word === "false" ? quoted(word) : optionWord(word);
    }
    default:
      return expr(v);
  }
};

/**
 * How an option list is spelt. `eq`: `name = value` (storage parameters) or
 * `name value` (the utility lists of EXPLAIN, VACUUM, COPY, …, whose grammar
 * in PG takes no `=`). `keywords`: a bare option name is written as a keyword
 * (`ANALYZE`, `FORMAT`) rather than as a name.
 */
export interface OptionStyle {
  eq: boolean;
  keywords: boolean;
}

/** One `[namespace.]name [[=] value]` entry. */
export const relationOption = (o: RelationOption, style: OptionStyle): Doc => {
  const word = (w: string): string => (style.keywords && BARE_WORD.test(w) ? kw(w.toUpperCase()) : optionWord(w));
  const name = o.namespace !== undefined ? `${word(o.namespace)}.${word(o.name)}` : word(o.name);
  return o.value === null ? name : [name, style.eq ? " = " : " ", optionValue(o.value)];
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
