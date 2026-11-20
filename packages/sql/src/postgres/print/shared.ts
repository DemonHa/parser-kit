// Printers for AST pieces several statement families share. Each is
// self-contained: a family that needs one imports it from here rather than
// writing its own.
import { type Doc, group, indent, join, line } from "@parser-kit/core/print";
import type {
  AlterConfigAction,
  ColType,
  DropSignature,
  Expr,
  FunctionArg,
  ObjectRef,
  PartitionKey,
  RelationOption,
  RelationOptionValue,
} from "../ast";
import { RESERVED } from "../grammar";
import { commaList, ident, isColNameKeyword, kw, parenList, qualified, quoted } from "./context";
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

// --- object references, routine signatures and roles ---

/** An object keyword, or run of them, as the AST folds it (`"text search dictionary"`). */
export const objectKeyword = (objectType: string): string => kw(objectType.toUpperCase());

// PG's pseudo-roles, which the grammar matches bare, by value, where a role is
// specified (OWNER TO, GRANT, ALTER ROLE): quoted, they would name a role
// called `current_user`.
const PSEUDO_ROLES: ReadonlySet<string> = new Set(["current_user", "current_role", "session_user"]);

/** A role where PG takes a role spec: a name, or a pseudo-role written as its keyword. */
export const roleSpec = (name: string): string => (PSEUDO_ROLES.has(name) ? kw(name.toUpperCase()) : ident(name));

// Words that would read as something other than an argument's name before its
// type: an argument mode, SETOF, and the lead words of multi-word type names
// (`double precision`). Quoted, each is a plain name.
const ARG_NAME_QUOTED: ReadonlySet<string> = new Set([
  "in",
  "out",
  "inout",
  "variadic",
  "setof",
  "double",
  "character",
  "char",
  "national",
  "bit",
  "timestamp",
  "time",
  "interval",
]);

/** One argument of a routine signature: `[mode] [name] type [DEFAULT expr]`. */
export const functionArg = (a: FunctionArg): Doc => [
  a.mode !== null ? `${kw(a.mode.toUpperCase())} ` : "",
  // PG's param_name is a type_function_name: no col_name keyword either.
  a.name !== null ? `${ARG_NAME_QUOTED.has(a.name) || isColNameKeyword(a.name) ? quoted(a.name) : ident(a.name)} ` : "",
  typeName(a.type),
  a.defaultValue !== null ? [` ${kw("DEFAULT")} `, expr(a.defaultValue)] : "",
];

/** A routine's or aggregate's argument list: `(*)` or `(arg, …)`. */
export const signature = (s: DropSignature): Doc => (s.star ? "(*)" : parenList(s.args.map(functionArg)));

/**
 * A routine or aggregate named with its argument list: PG's func_name, so a
 * one-part name can't be a col_name keyword (`"coalesce"(int)`).
 */
export const routineWithArgs = (name: readonly string[], sig: DropSignature): Doc => [
  name.length === 1 && isColNameKeyword(name[0]!) ? quoted(name[0]!) : qualified(name),
  signature(sig),
];

/**
 * A type or domain named as DROP, COMMENT ON and SECURITY LABEL name one: PG's
 * Typename, written as a type name is: `int` bare (int4), a col_name keyword
 * that names no type (`"between"`) quoted. The tree doesn't record quoting, so
 * a source `"int"` prints as `int` too. A name holding a space came from a
 * quoted name, which stays quoted.
 */
export const typeObjectName = (name: readonly string[]): Doc =>
  name.length === 1 && /\s/.test(name[0]!)
    ? quoted(name[0]!)
    : typeName({ name: [...name], args: [], array: false } as unknown as ColType);

/**
 * A number the grammar read with `Number`, written so it reads back the same:
 * an overflow is Infinity, and a `-0` keeps its sign.
 */
export const numberText = (n: number): string =>
  n === Number.POSITIVE_INFINITY
    ? "1e999"
    : n === Number.NEGATIVE_INFINITY
      ? "-1e999"
      : Object.is(n, -0)
        ? "-0"
        : String(n);

/** An operator name, `[schema.]op`: the qualifying parts are names, the last the symbol. */
export const operatorName = (name: readonly string[]): string =>
  [...name.slice(0, -1).map(ident), name[name.length - 1]!].join(".");

/** An operator's `(left, right)` operand types, NONE for a missing side. */
export const operandTypes = (operands: readonly [ColType | null, ColType | null]): Doc =>
  parenList(operands.map((t) => (t === null ? kw("NONE") : typeName(t))));

/** A cast's `(source AS target)`. */
export const castTypes = (source: ColType, target: ColType): Doc => [
  "(",
  typeName(source),
  ` ${kw("AS")} `,
  typeName(target),
  ")",
];

/**
 * One existing object as COMMENT ON and SECURITY LABEL name it (and ALTER
 * EXTENSION and the generic ALTER, once printed): its keyword(s), then the
 * reference its kind takes.
 */
export const objectRef = (o: ObjectRef): Doc => {
  const parts: Doc[] = [objectKeyword(o.objectType)];
  if (o.oid !== undefined) parts.push(numberText(o.oid));
  if (o.source !== undefined && o.target !== undefined) parts.push(castTypes(o.source, o.target));
  if (o.type !== undefined) {
    parts.push(kw("FOR"), typeName(o.type));
    if (o.language !== undefined) parts.push(kw("LANGUAGE"), ident(o.language));
  }
  if (o.name !== undefined) {
    if (o.operands !== undefined) {
      parts.push(operatorName(o.name), operandTypes(o.operands));
    } else if (o.signature !== undefined) {
      parts.push(routineWithArgs(o.name, o.signature));
    } else if (o.objectType === "type" || o.objectType === "domain") {
      parts.push(typeObjectName(o.name));
    } else {
      parts.push(qualified(o.name));
    }
  }
  if (o.table !== undefined) parts.push(kw("ON"), qualified(o.table));
  if (o.domain !== undefined) parts.push(kw("ON DOMAIN"), qualified(o.domain));
  if (o.using !== undefined) parts.push(kw("USING"), ident(o.using));
  return join(" ", parts);
};

// --- SET / RESET ---

// The multi-word targets SHOW, RESET and SET name as one name part.
const CONFIG_FORMS: Record<string, string> = {
  "time zone": "TIME ZONE",
  "transaction isolation level": "TRANSACTION ISOLATION LEVEL",
  "session authorization": "SESSION AUTHORIZATION",
};

/** SHOW and RESET's target: ALL, a multi-word form, or a dotted parameter name. */
export const configTarget = (name: string[]): Doc => {
  if (name.length === 1 && name[0] === "all") return kw("ALL");
  const form = name.length === 1 ? CONFIG_FORMS[name[0]!] : undefined;
  return form !== undefined ? kw(form) : qualified(name);
};

// One value of a SET list: a number, a string, a boolean or a word (a name
// node). `on`, reserved, is a value word to the grammar; any other word is
// written as a name would be.
const configValue = (e: Expr, words: "value" | "word" | "zone"): Doc => {
  if (e.kind !== "name") return expr(e);
  const word = e.parts[0]!;
  if (words === "value" && word === "on") return word;
  // PG's zone_value takes an IDENT, no keyword: a word is always quoted
  // (bare LOCAL, for one, is TIME ZONE's DEFAULT).
  if (words === "zone") return quoted(word);
  return ident(word);
};

// A value SET's special forms take, by form; the generic `name TO value` form
// takes anything else.
const isString = (v: Expr): boolean => v.kind === "string";
const isWord = (v: Expr): boolean => v.kind === "string" || (v.kind === "name" && v.parts.length === 1);
const isZone = (v: Expr): boolean => v.kind === "number" || v.kind === "unary" || v.kind === "interval" || isWord(v);

const SPECIAL_SET: Record<string, { words: string; one: (v: Expr) => boolean; byDefault: boolean }> = {
  "time zone": { words: "TIME ZONE", one: isZone, byDefault: true },
  schema: { words: "SCHEMA", one: isString, byDefault: false },
  names: { words: "NAMES", one: isString, byDefault: true },
  role: { words: "ROLE", one: isWord, byDefault: false },
  "session authorization": { words: "SESSION AUTHORIZATION", one: isWord, byDefault: true },
  "xml option": {
    words: "XML OPTION",
    one: (v) => v.kind === "name" && v.parts.length === 1 && (v.parts[0] === "document" || v.parts[0] === "content"),
    byDefault: false,
  },
  "transaction snapshot": { words: "TRANSACTION SNAPSHOT", one: isString, byDefault: false },
};

/**
 * What follows `SET [scope]` in the SET statement, and `SET` in ALTER ROLE /
 * ALTER DATABASE: one of SET's special forms where the value fits it, else
 * `name TO value, …`, `name TO DEFAULT` or `name FROM CURRENT`.
 */
export const configSet = (configName: string[], values: Expr[] | "default" | "fromCurrent"): Doc => {
  const special = configName.length === 1 ? SPECIAL_SET[configName[0]!] : undefined;
  if (special !== undefined) {
    if (values === "default" && special.byDefault) return [kw(special.words), " ", kw("DEFAULT")];
    if (Array.isArray(values) && values.length === 1 && special.one(values[0]!)) {
      const v = values[0]!;
      const word = configName[0] === "time zone" ? "zone" : configName[0] === "xml option" ? "value" : "word";
      return [
        kw(special.words),
        " ",
        configName[0] === "xml option" ? kw((v as { parts: string[] }).parts[0]!.toUpperCase()) : configValue(v, word),
      ];
    }
  }
  const name = qualified(configName);
  if (values === "fromCurrent") return [name, " ", kw("FROM CURRENT")];
  if (values === "default") return [name, " ", kw("TO DEFAULT")];
  return group([name, " ", kw("TO"), indent([line, commaList(values.map((v) => configValue(v, "value")))])]);
};

/**
 * The SET / RESET of parameter defaults ALTER ROLE and ALTER DATABASE take:
 * `SET …` as the SET statement's, `RESET target` as the RESET statement's.
 */
export const alterConfigAction = (a: AlterConfigAction): Doc =>
  a.kind === "reset" ? [kw("RESET"), " ", configTarget(a.name)] : [kw("SET"), " ", configSet(a.name, a.values)];
