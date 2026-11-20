// Type names: `int`, `varchar(10)`, `timestamp(3) with time zone`, `text[]`,
// `SETOF record`, `"char"`.
import type { Doc } from "@parser-kit/core/print";
import type { ColType } from "../ast";
import { bareQualified, kw } from "./context";

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

/** A type name, written as the grammar folded it (lower-case); `SETOF` is the one keyword. */
export const typeName = (t: ColType): Doc => {
  const args = t.args.length > 0 ? `(${t.args.join(", ")})` : "";
  let name: string;
  if (t.name.length === 1 && t.quoted) {
    // A quoted keyword spelling (`"char"`, `"int"`) is quoted even though it is a bare word.
    name = `"${t.name[0]!.replace(/"/g, '""')}"${args}`;
  } else if (t.name.length === 1 && isMultiWord(t.name[0]!)) {
    const words = t.name[0]!;
    const space = words.indexOf(" ");
    const lead = words.slice(0, space);
    name = ARGS_BEFORE_TAIL.has(lead) ? `${lead}${args}${words.slice(space)}` : `${words}${args}`;
  } else {
    name = `${bareQualified(t.name)}${args}`;
  }
  return `${t.setof ? `${kw("SETOF")} ` : ""}${name}${t.array ? "[]" : ""}`;
};
