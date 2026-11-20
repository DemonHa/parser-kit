// Printers for the AST pieces several statement families share: option lists,
// routine arguments and signatures, object references, the RENAME / OWNER /
// SET SCHEMA actions, role specs and the SET / RESET of a parameter default.
// Each is small and stands alone; a family that needs one imports it from here
// rather than writing its own.
import { type Doc, group, indent, line } from "@parser-kit/core/print";
import type {
  AlterConfigAction,
  AlterGenericOption,
  ColType,
  DropSignature,
  Expr,
  FunctionArg,
  GenericOption,
  ObjectRef,
  RelationOption,
  RelationOptionValue,
} from "../ast";
import { commaList, ident, isColNameKeyword, kw, parenList, qualified, quoted, str } from "./context";
import { expr } from "./expr";
import { typeName } from "./types";

// --- names ---

const BARE_LABEL = /^[a-z_][a-z0-9_$]*$/;

/**
 * An option or definition name, PG's ColLabel: any word, reserved ones
 * included, so it is quoted only when it isn't a lower-case word (or when
 * `identifierQuote` is "always").
 */
// (`ident("a")` comes back quoted only under identifierQuote: "always".)
export const optionLabel = (name: string): string =>
  BARE_LABEL.test(name) && ident("a") === "a" ? name : quoted(name);

// The CURRENT_ / SESSION_ pseudo-roles, which are keywords where a role is
// specified. A role really named one of them has the same tree, so it prints
// as the keyword too.
const ROLE_KEYWORDS: ReadonlySet<string> = new Set(["current_user", "current_role", "session_user"]);

/** A role where PG takes a role spec: a name, or one of the pseudo-role keywords. */
export const roleSpec = (role: string): string => (ROLE_KEYWORDS.has(role) ? kw(role.toUpperCase()) : ident(role));

/** `[schema.]op`: an operator's dotted name, its last part the symbol. */
export const operatorName = (parts: readonly string[]): string =>
  [...parts.slice(0, -1).map(ident), parts[parts.length - 1]!].join(".");

// --- option lists ---

// A word value of an option list is any word, reserved ones included, bar
// `true` / `false`, which read as booleans.
const optionScalar = (v: Exclude<RelationOptionValue, { kind: "star" | "optionList" }>): Doc =>
  v.kind === "name"
    ? v.parts[0] === "true" || v.parts[0] === "false"
      ? quoted(v.parts[0])
      : optionLabel(v.parts[0]!)
    : expr(v);

/** An option's value: a scalar, `*` or a parenthesised list. */
export const relationOptionValue = (v: RelationOptionValue): Doc =>
  v.kind === "star" ? "*" : v.kind === "optionList" ? parenList(v.items.map(optionScalar)) : optionScalar(v);

/** `[namespace.]name [= value]`: one entry of a parenthesised option list. */
export const relationOption = (o: RelationOption): Doc => [
  o.namespace !== undefined ? `${optionLabel(o.namespace)}.` : "",
  optionLabel(o.name),
  o.value !== null ? [" = ", relationOptionValue(o.value)] : "",
];

/** `(name = value, …)`. */
export const relationOptions = (options: readonly RelationOption[]): Doc => parenList(options.map(relationOption));

/** `OPTIONS (name 'value', …)`: a CREATE's generic options. */
export const genericOptions = (options: readonly GenericOption[]): Doc => [
  kw("OPTIONS"),
  " ",
  parenList(options.map((o) => [optionLabel(o.name), " ", str(o.value)])),
];

/** `OPTIONS ([ADD | SET] name 'value' | DROP name, …)`: an ALTER's generic options. */
export const alterGenericOptions = (options: readonly AlterGenericOption[]): Doc => [
  kw("OPTIONS"),
  " ",
  parenList(
    options.map((o) =>
      o.action === "drop"
        ? [kw("DROP"), " ", optionLabel(o.name)]
        : [o.action !== undefined ? `${kw(o.action.toUpperCase())} ` : "", optionLabel(o.name), " ", str(o.value)],
    ),
  ),
];

// --- routine arguments ---

// Words a routine argument's name can't be bare as, beyond PG's col_name
// keywords (which its param_name excludes): a mode word would read as the
// mode, and the lead word of a multi-word type name would read, with the type
// after it, as one type (`double precision`).
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

/** A routine argument's or RETURNS TABLE column's name, PG's param_name. */
export const argName = (name: string): string =>
  ARG_NAME_QUOTED.has(name) || isColNameKeyword(name) ? quoted(name) : ident(name);

/** `[mode] [name] type [DEFAULT expr]`: one argument of a routine's or aggregate's signature. */
export const functionArg = (a: FunctionArg): Doc => [
  a.mode !== null ? `${kw(a.mode.toUpperCase())} ` : "",
  a.name !== null ? `${argName(a.name)} ` : "",
  typeName(a.type),
  a.defaultValue !== null ? [" ", kw("DEFAULT"), " ", expr(a.defaultValue)] : "",
];

/** `(arg, …)`, or an aggregate's `(*)`. */
export const signature = (s: DropSignature): Doc =>
  s.star && s.args.length === 0 ? "(*)" : parenList(s.args.map(functionArg));

// --- object references ---

const operandType = (t: ColType | null): Doc => (t === null ? kw("NONE") : typeName(t));

/** `(left, right)`: an operator's operand types, NONE for a prefix operator's missing side. */
export const operandTypes = (operands: readonly [ColType | null, ColType | null]): Doc => [
  "(",
  operandType(operands[0]),
  ", ",
  operandType(operands[1]),
  ")",
];

/**
 * The reference part of an object, as COMMENT ON, SECURITY LABEL, ALTER
 * EXTENSION ADD / DROP and the generic ALTER name it: everything after the
 * object kind's keywords.
 */
export const objectRefName = (ref: ObjectRef): Doc => {
  const parts: Doc[] = [];
  if (ref.source !== undefined && ref.target !== undefined) {
    parts.push(["(", typeName(ref.source), ` ${kw("AS")} `, typeName(ref.target), ")"]);
  }
  if (ref.type !== undefined) parts.push([kw("FOR"), " ", typeName(ref.type)]);
  if (ref.language !== undefined) parts.push([kw("LANGUAGE"), " ", ident(ref.language)]);
  if (ref.oid !== undefined) parts.push(Object.is(ref.oid, -0) ? "-0" : String(ref.oid));
  if (ref.name !== undefined) {
    if (ref.operands !== undefined) {
      parts.push([operatorName(ref.name), " ", operandTypes(ref.operands)]);
    } else {
      parts.push(ref.signature !== undefined ? [qualified(ref.name), signature(ref.signature)] : qualified(ref.name));
    }
  }
  if (ref.using !== undefined) parts.push([kw("USING"), " ", ident(ref.using)]);
  if (ref.table !== undefined) {
    // `DOMAIN` after ON reads as the keyword when a name follows it.
    const table = ref.table.length === 1 && ref.table[0] === "domain" ? quoted("domain") : qualified(ref.table);
    parts.push([kw("ON"), " ", table]);
  }
  if (ref.domain !== undefined) parts.push([kw("ON DOMAIN"), " ", qualified(ref.domain)]);
  return parts.flatMap((p, i) => (i === 0 ? [p] : [" ", p]));
};

/** `kind reference`: an object's kind keywords, then its reference. */
export const objectRef = (ref: ObjectRef): Doc => [kw(ref.objectType.toUpperCase()), " ", objectRefName(ref)];

// --- actions ---

/** RENAME TO, OWNER TO and SET SCHEMA, the actions most ALTER targets share. */
export const commonAlterAction = (
  a: { kind: "rename"; to: string } | { kind: "ownerTo"; owner: string } | { kind: "setSchema"; schema: string },
): Doc =>
  a.kind === "rename"
    ? [kw("RENAME TO"), " ", ident(a.to)]
    : a.kind === "ownerTo"
      ? [kw("OWNER TO"), " ", roleSpec(a.owner)]
      : [kw("SET SCHEMA"), " ", ident(a.schema)];

// --- parameter defaults ---

// The parameters PG spells as a form of their own, keyword words and no TO.
// The tree holds a form's name as one part (`["time zone"]`), as it does a
// quoted generic name of the same text (`SET "time zone" TO …`), so a form is
// written only where the value is one the form reads; anything else is written
// as the generic, quoted name, which reads back the same.
type Values = readonly Expr[] | "default" | "fromCurrent";
const one = (values: Values): Expr | null => (Array.isArray(values) && values.length === 1 ? values[0]! : null);
const ZONE_VALUES: ReadonlySet<string> = new Set(["string", "number", "unary", "name", "interval"]);
const SET_FORMS: Record<string, (values: Values) => Doc | null> = {
  // PG's zone_value takes a name only as a plain identifier, no keyword of any
  // kind (and a bare LOCAL reads as DEFAULT), so a zone name is always quoted.
  "time zone": (values) => {
    if (values === "default") return kw("DEFAULT");
    const v = one(values);
    if (v === null || !ZONE_VALUES.has(v.kind)) return null;
    return v.kind === "name" && v.parts.length === 1 ? quoted(v.parts[0]!) : expr(v);
  },
  "session authorization": (values) => {
    if (values === "default") return kw("DEFAULT");
    const v = one(values);
    return v !== null && (v.kind === "string" || (v.kind === "name" && v.parts.length === 1)) ? expr(v) : null;
  },
  "xml option": (values) => {
    const v = one(values);
    return v?.kind === "name" && (v.parts[0] === "document" || v.parts[0] === "content")
      ? kw(v.parts[0].toUpperCase())
      : null;
  },
  "transaction snapshot": (values) => (one(values)?.kind === "string" ? expr(one(values)!) : null),
  // SCHEMA and NAMES are PG's search_path and client_encoding: a parameter
  // written `schema` or `names` would be another one.
  schema: (values) => (one(values)?.kind === "string" ? expr(one(values)!) : null),
  names: (values) =>
    values === "default" ? kw("DEFAULT") : one(values)?.kind === "string" ? expr(one(values)!) : null,
};
// The forms RESET takes.
const RESET_FORMS: ReadonlySet<string> = new Set(["time zone", "transaction isolation level", "session authorization"]);

// ON is reserved but a SET value all the same, as OFF is.
const parameterValue = (v: Expr): Doc =>
  v.kind === "name" && v.parts.length === 1 && v.parts[0] === "on" ? kw("ON") : expr(v);

/**
 * `name {TO value[, …] | TO DEFAULT | FROM CURRENT}`, the SET of a parameter
 * as a routine, a role or a database sets it (after the SET keyword), or one
 * of PG's own forms (`TIME ZONE 'UTC'`, `SCHEMA 'x'`).
 */
export const parameterSet = (name: readonly string[], values: Values): Doc => {
  const form = name.length === 1 && Object.hasOwn(SET_FORMS, name[0]!) ? SET_FORMS[name[0]!]!(values) : null;
  if (form !== null) return [kw(name[0]!.toUpperCase()), " ", form];
  if (values === "fromCurrent") return [qualified(name), " ", kw("FROM CURRENT")];
  const value = values === "default" ? kw("DEFAULT") : commaList(values.map(parameterValue));
  return group([qualified(name), " ", kw("TO"), indent([line, value])]);
};

/** `SET name …` or `RESET name`: the SET / RESET of a role's or database's parameter default. */
export const alterConfig = (a: AlterConfigAction): Doc =>
  a.kind === "set"
    ? [kw("SET"), " ", parameterSet(a.name, a.values)]
    : [
        kw("RESET"),
        " ",
        a.name.length === 1 && (a.name[0] === "all" || RESET_FORMS.has(a.name[0]!))
          ? kw(a.name[0]!.toUpperCase())
          : qualified(a.name),
      ];
