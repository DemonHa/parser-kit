// Printers for AST pieces that several statement families share. Each is
// self-contained: a family that needs one imports it from here rather than
// writing its own.
import { type Doc, group, indent, join, line } from "@parser-kit/core/print";
import type { AlterConfigAction, ColType, DropSignature, FunctionArg, ObjectRef } from "../ast";
import { commaList, ident, kw, parenList, qualified, quoted } from "./context";
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
  a.name !== null ? `${ARG_NAME_QUOTED.has(a.name) ? quoted(a.name) : ident(a.name)} ` : "",
  typeName(a.type),
  a.defaultValue !== null ? [` ${kw("DEFAULT")} `, expr(a.defaultValue)] : "",
];

/** A routine's or aggregate's argument list: `(*)` or `(arg, …)`. */
export const signature = (s: DropSignature): Doc => (s.star ? "(*)" : parenList(s.args.map(functionArg)));

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
 * One existing object as COMMENT ON, SECURITY LABEL, ALTER EXTENSION and the
 * generic ALTER name it: its keyword(s), then the reference its kind takes.
 */
export const objectRef = (o: ObjectRef): Doc => {
  const parts: Doc[] = [objectKeyword(o.objectType)];
  if (o.oid !== undefined) parts.push(String(o.oid));
  if (o.source !== undefined && o.target !== undefined) parts.push(castTypes(o.source, o.target));
  if (o.type !== undefined) {
    parts.push(kw("FOR"), typeName(o.type));
    if (o.language !== undefined) parts.push(kw("LANGUAGE"), ident(o.language));
  }
  if (o.name !== undefined) {
    if (o.operands !== undefined) {
      parts.push(operatorName(o.name), operandTypes(o.operands));
    } else if (o.signature !== undefined) {
      parts.push([qualified(o.name), signature(o.signature)]);
    } else {
      parts.push(qualified(o.name));
    }
  }
  if (o.table !== undefined) parts.push(kw("ON"), qualified(o.table));
  if (o.domain !== undefined) parts.push(kw("ON DOMAIN"), qualified(o.domain));
  if (o.using !== undefined) parts.push(kw("USING"), ident(o.using));
  return join(" ", parts);
};

// SET's special forms, by the name the grammar gives them. Their names hold a
// space, so no generic `name TO value` spells them.
const SPECIAL_SETS: Record<string, string> = {
  "time zone": "TIME ZONE",
  "session authorization": "SESSION AUTHORIZATION",
  "transaction snapshot": "TRANSACTION SNAPSHOT",
  "xml option": "XML OPTION",
};

// RESET's (and SHOW's) multi-word targets.
const SPECIAL_RESETS: Record<string, string> = {
  all: "ALL",
  "time zone": "TIME ZONE",
  "transaction isolation level": "TRANSACTION ISOLATION LEVEL",
  "session authorization": "SESSION AUTHORIZATION",
};

const configValues = (values: Exclude<Extract<AlterConfigAction, { kind: "set" }>["values"], "fromCurrent">): Doc =>
  values === "default" ? kw("DEFAULT") : commaList(values.map(expr));

/**
 * The SET / RESET of parameter defaults ALTER ROLE and ALTER DATABASE take
 * (and the SET / RESET statements' bodies): `SET name TO value, …`, `SET name
 * FROM CURRENT`, one of SET's special forms, or `RESET name`.
 */
export const alterConfigAction = (a: AlterConfigAction): Doc => {
  if (a.kind === "reset") {
    const special = a.name.length === 1 ? SPECIAL_RESETS[a.name[0]!] : undefined;
    return [kw("RESET"), " ", special !== undefined ? kw(special) : qualified(a.name)];
  }
  const special = a.name.length === 1 && Object.hasOwn(SPECIAL_SETS, a.name[0]!) ? SPECIAL_SETS[a.name[0]!]! : null;
  if (special !== null && a.values !== "fromCurrent") {
    // XML OPTION's value is a keyword the grammar matches bare.
    const value =
      a.name[0] === "xml option" && a.values !== "default" && a.values.length === 1 && a.values[0]!.kind === "name"
        ? kw(a.values[0]!.parts.join(".").toUpperCase())
        : configValues(a.values);
    return group([kw("SET"), " ", kw(special), indent([line, value])]);
  }
  if (a.values === "fromCurrent") return [kw("SET"), " ", qualified(a.name), " ", kw("FROM CURRENT")];
  return group([kw("SET"), " ", qualified(a.name), " ", kw("TO"), indent([line, configValues(a.values)])]);
};
