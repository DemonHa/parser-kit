// Type names: `int`, `varchar(10)`, `timestamp(3) with time zone`, `text[]`,
// `SETOF record`, `"char"`.
import type { Doc } from "@parser-kit/core/print";
import type { ColType } from "../ast";
import { isColNameKeyword, kw, quoted, typeQualified } from "./context";

// The multi-word spellings the grammar folds into one name part
// (`["double precision"]`), keyed by their lead word. A part holding one of
// these is written as the words; quoted, it would be one name looked up as
// written, which is what `quoted` records.
const MULTI_WORD_LEADS = new Set(["double", "character", "char", "national", "bit", "timestamp", "time", "interval"]);
const isMultiWord = (part: string): boolean => {
  const space = part.indexOf(" ");
  return space > 0 && MULTI_WORD_LEADS.has(part.slice(0, space)) && /^[a-z ]+$/.test(part);
};

// TIME and TIMESTAMP spell their precision before the rest of the name.
const ARGS_BEFORE_TAIL = new Set(["timestamp", "time"]);

// PG's col_name keywords that are type names in their own right. Any other
// col_name keyword (`between`, `row`, `values`, …) can't stand bare as a type
// name, so it is quoted (`isColNameKeyword`).
const KEYWORD_TYPES = new Set([
  "bigint",
  "bit",
  "boolean",
  "char",
  "character",
  "dec",
  "decimal",
  "float",
  "int",
  "integer",
  "interval",
  "nchar",
  "numeric",
  "real",
  "smallint",
  "time",
  "timestamp",
  "varchar",
]);

/**
 * A type name, written as the grammar folded it (lower-case); `SETOF` is the
 * one keyword. `literal` is set for a typed literal's type, where a bare
 * `interval` would read as an INTERVAL literal instead.
 */
export const typeName = (t: ColType, literal = false): Doc => {
  const args = t.args.length > 0 ? `(${t.args.join(", ")})` : "";
  let name: string;
  if (t.name.length === 1 && t.quoted) {
    // A quoted keyword spelling (`"char"`, `"int"`) is quoted even though it is a bare word.
    name = `${quoted(t.name[0]!)}${args}`;
  } else if (t.name.length === 1 && isMultiWord(t.name[0]!)) {
    const words = t.name[0]!;
    const space = words.indexOf(" ");
    const lead = words.slice(0, space);
    name = ARGS_BEFORE_TAIL.has(lead) ? `${lead}${args}${words.slice(space)}` : `${words}${args}`;
  } else if (
    t.name.length === 1 &&
    ((isColNameKeyword(t.name[0]!) && !KEYWORD_TYPES.has(t.name[0]!)) || (literal && t.name[0] === "interval"))
  ) {
    name = `${quoted(t.name[0]!)}${args}`;
  } else {
    name = `${typeQualified(t.name)}${args}`;
  }
  return `${t.setof ? `${kw("SETOF")} ` : ""}${name}${t.array ? "[]" : ""}`;
};
