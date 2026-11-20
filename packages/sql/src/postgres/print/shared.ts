// Printers for AST pieces that several statement families share. Each is
// self-contained: a family that needs one imports it from here rather than
// writing its own.
import { type Doc, group, indent, join, line } from "@parser-kit/core/print";
import type { AlterConfigAction, ColType, DropSignature, Expr, FunctionArg, ObjectRef } from "../ast";
import { commaList, ident, isColNameKeyword, kw, parenList, qualified, quoted, str } from "./context";
import { expr } from "./expr";
import { typeName } from "./types";

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

type ConfigValues = Exclude<Extract<AlterConfigAction, { kind: "set" }>["values"], "fromCurrent">;

const oneValue = (values: ConfigValues): Expr | null =>
  values !== "default" && values.length === 1 ? values[0]! : null;
const isString = (v: Expr | null): v is Extract<Expr, { kind: "string" }> => v?.kind === "string";
const isNumber = (v: Expr | null): boolean =>
  v?.kind === "number" || (v?.kind === "unary" && (v.op === "-" || v.op === "+") && v.operand.kind === "number");
// A word value, written quoted: TIME ZONE takes an IDENT there, which no PG
// keyword is unless quoted (`"local"` is a zone, LOCAL the default); SESSION
// AUTHORIZATION, which takes any non-reserved word, reads it the same way.
const word = (v: Expr | null): string | null =>
  v?.kind === "name" && v.parts.length === 1 ? quoted(v.parts[0]!) : null;

// SET's special forms, by the name the grammar gives them: each one's
// keywords, and its value when the values fit the form (else null, and the
// generic `"name" TO value` spells them). SCHEMA and NAMES are kept special
// though a generic spelling would parse to the same tree: to PG they set
// search_path and client_encoding, while `schema TO …` names a parameter that
// doesn't exist.
const SPECIAL_SETS: Record<string, { keywords: string; value: (values: ConfigValues) => Doc | null }> = {
  "time zone": {
    keywords: "TIME ZONE",
    value: (values) => {
      if (values === "default") return kw("DEFAULT");
      const v = oneValue(values);
      return isString(v) || isNumber(v) || v?.kind === "interval" ? expr(v!) : word(v);
    },
  },
  "session authorization": {
    keywords: "SESSION AUTHORIZATION",
    value: (values) => {
      if (values === "default") return kw("DEFAULT");
      const v = oneValue(values);
      return isString(v) ? str(v.value) : word(v);
    },
  },
  "transaction snapshot": {
    keywords: "TRANSACTION SNAPSHOT",
    value: (values) => {
      const v = oneValue(values);
      return isString(v) ? str(v.value) : null;
    },
  },
  // The grammar matches DOCUMENT and CONTENT bare, by value.
  "xml option": {
    keywords: "XML OPTION",
    value: (values) => {
      const v = oneValue(values);
      return v?.kind === "name" && v.parts.length === 1 && (v.parts[0] === "document" || v.parts[0] === "content")
        ? kw(v.parts[0].toUpperCase())
        : null;
    },
  },
  schema: {
    keywords: "SCHEMA",
    value: (values) => {
      const v = oneValue(values);
      return isString(v) ? str(v.value) : null;
    },
  },
  names: {
    keywords: "NAMES",
    value: (values) => {
      if (values === "default") return kw("DEFAULT");
      const v = oneValue(values);
      return isString(v) ? str(v.value) : null;
    },
  },
};

// RESET's (and SHOW's) multi-word targets.
const SPECIAL_RESETS: Record<string, string> = {
  all: "ALL",
  "time zone": "TIME ZONE",
  "transaction isolation level": "TRANSACTION ISOLATION LEVEL",
  "session authorization": "SESSION AUTHORIZATION",
};

// A word value is a name, quoted when it must be: `expr` would write the
// words PG reads as functions (`system_user`) bare, which no value may be.
const configValue = (v: Expr): Doc => (v.kind === "name" && v.parts.length === 1 ? ident(v.parts[0]!) : expr(v));
const configValues = (values: ConfigValues): Doc =>
  values === "default" ? kw("DEFAULT") : commaList(values.map(configValue));

/**
 * The SET / RESET of parameter defaults ALTER ROLE and ALTER DATABASE take
 * (and could print the SET / RESET statements' bodies): `SET name TO value, …`, `SET name
 * FROM CURRENT`, one of SET's special forms, or `RESET name`.
 */
export const alterConfigAction = (a: AlterConfigAction): Doc => {
  if (a.kind === "reset") {
    const special = a.name.length === 1 ? SPECIAL_RESETS[a.name[0]!] : undefined;
    return [kw("RESET"), " ", special !== undefined ? kw(special) : qualified(a.name)];
  }
  if (a.values !== "fromCurrent" && a.name.length === 1 && Object.hasOwn(SPECIAL_SETS, a.name[0]!)) {
    const special = SPECIAL_SETS[a.name[0]!]!;
    const value = special.value(a.values);
    if (value !== null) return group([kw("SET"), " ", kw(special.keywords), indent([line, value])]);
  }
  if (a.values === "fromCurrent") return [kw("SET"), " ", qualified(a.name), " ", kw("FROM CURRENT")];
  return group([kw("SET"), " ", qualified(a.name), " ", kw("TO"), indent([line, configValues(a.values)])]);
};
