// Roles, privileges, comments and the DROP family: CREATE ROLE / USER / GROUP,
// ALTER ROLE / USER, GRANT / REVOKE on objects and roles, ALTER DEFAULT PRIVILEGES, DROP
// OWNED / REASSIGN OWNED, COMMENT ON, SECURITY LABEL and DROP.
import { type Doc, group, indent, join, line } from "@parser-kit/core/print";
import type { DefaultPrivilegesAction, GrantObject, Privilege, RoleGrantOption, RoleOption, Stmt } from "../ast";
import { clause, commaList, ident, kw, minimalIdent, parenList, qualified, quoted, str } from "./context";
import { defineFamily } from "./registry";
import {
  alterConfigAction,
  castTypes,
  numberText,
  objectKeyword,
  objectRef,
  operandTypes,
  operatorName,
  roleSpec,
  routineWithArgs,
  typeObjectName,
} from "./shared";

/**
 * A statement: its `head` words on one line, then each of the `rest` on a line
 * of its own, indented, when the whole doesn't fit.
 */
const stmt = (head: readonly Doc[], rest: readonly Doc[]): Doc =>
  group([join(" ", head), indent(rest.map((p) => [line, p]))]);

const behavior = (b: "cascade" | "restrict" | null): Doc[] => (b === null ? [] : [kw(b.toUpperCase())]);

const roleList = (roles: readonly string[]): Doc => commaList(roles.map(roleSpec));

// --- roles ---

const roleOption = (o: RoleOption): Doc => {
  switch (o.kind) {
    case "flag":
      return kw(`${o.value ? "" : "NO"}${o.name.toUpperCase()}`);
    case "connectionLimit":
      return `${kw("CONNECTION LIMIT")} ${numberText(o.limit)}`;
    case "password":
      return `${o.encrypted ? `${kw("ENCRYPTED")} ` : ""}${kw("PASSWORD")} ${o.password === null ? kw("NULL") : str(o.password)}`;
    case "validUntil":
      return `${kw("VALID UNTIL")} ${str(o.timestamp)}`;
    case "inRole":
      return clause(kw("IN ROLE"), roleList(o.roles));
    case "role":
      return clause(kw("ROLE"), roleList(o.roles));
    case "admin":
      return clause(kw("ADMIN"), roleList(o.roles));
  }
};

const withRoleOptions = (head: Doc[], options: readonly RoleOption[]): Doc =>
  options.length === 0 ? join(" ", head) : stmt([...head, kw("WITH")], options.map(roleOption));

// --- privileges ---

// The privilege keywords the grammar matches by value (some are reserved), and
// written as keywords: a role named one in a role grant reads back the same.
// Any other privilege or role is a name.
const PRIVILEGE_WORDS: ReadonlySet<string> = new Set([
  "select",
  "insert",
  "update",
  "delete",
  "truncate",
  "references",
  "trigger",
  "usage",
  "create",
  "connect",
  "temporary",
  "temp",
  "execute",
  "maintain",
  "set",
]);

const privilege = (p: Privilege): Doc => [
  p.name === "alter system"
    ? kw("ALTER SYSTEM")
    : PRIVILEGE_WORDS.has(p.name)
      ? kw(p.name.toUpperCase())
      : ident(p.name),
  p.columns !== null ? [" ", parenList(p.columns.map(ident))] : "",
];

const privileges = (privs: Privilege[] | "all", allColumns: string[] | undefined): Doc =>
  privs === "all"
    ? [kw("ALL PRIVILEGES"), allColumns !== undefined ? [" ", parenList(allColumns.map(ident))] : ""]
    : commaList(privs.map(privilege));

// The plural of `ALL {TABLES | …} IN SCHEMA` and of ALTER DEFAULT PRIVILEGES'
// `ON {TABLES | …}`, by the kind's singular.
const PLURALS: Record<string, string> = {
  table: "TABLES",
  sequence: "SEQUENCES",
  function: "FUNCTIONS",
  procedure: "PROCEDURES",
  routine: "ROUTINES",
  type: "TYPES",
  schema: "SCHEMAS",
};

const grantObject = (o: GrantObject): Doc => {
  if (o.inSchema !== null) {
    return clause(kw(`ALL ${PLURALS[o.objectType]!} IN SCHEMA`), commaList(o.inSchema.map(qualified)));
  }
  const items: Doc[] =
    o.oids !== undefined
      ? o.oids.map(numberText)
      : o.names.map((name, i) => {
          const sig = o.signatures?.[i];
          return sig !== undefined && sig !== null ? routineWithArgs(name, sig) : qualified(name);
        });
  // The kind is always written, TABLE too: then no object name can read as a kind word.
  return clause(objectKeyword(o.objectType), commaList(items));
};

// PUBLIC, or a role spec.
const grantee = (name: string): string => (name === "public" ? kw("PUBLIC") : roleSpec(name));
const grantees = (names: readonly string[]): Doc => commaList(names.map(grantee));

const roleGrantOption = (o: RoleGrantOption): string =>
  `${kw(o.name.toUpperCase())} ${o.value ? kw("OPTION") : kw("FALSE")}`;

const defaultPrivilegesAction = (a: DefaultPrivilegesAction): Doc => {
  const on = clause(kw("ON"), kw(PLURALS[a.objectType]!));
  if (a.kind === "grant") {
    return join(line, [
      clause(kw("GRANT"), privileges(a.privileges, a.allColumns)),
      on,
      clause(kw("TO"), grantees(a.grantees)),
      ...(a.withGrantOption ? [kw("WITH GRANT OPTION")] : []),
    ]);
  }
  return join(line, [
    clause(kw(a.grantOptionFor ? "REVOKE GRANT OPTION FOR" : "REVOKE"), privileges(a.privileges, a.allColumns)),
    on,
    clause(kw("FROM"), grantees(a.grantees)),
    ...behavior(a.behavior),
  ]);
};

// --- DROP ---

type Drop = Extract<Stmt, { kind: "drop" }>;

// One object a DROP names, with what its kind adds to the name.
const dropItem = (d: Drop, name: string[], i: number): Doc => {
  if (d.operands !== undefined) return [operatorName(name), " ", operandTypes(d.operands[i]!)];
  const sig = d.signatures?.[i];
  if (sig !== undefined && sig !== null) return routineWithArgs(name, sig);
  if (d.objectType !== "type" && d.objectType !== "domain") return qualified(name);
  // DROP TYPE reads a bare `concurrently` as its option, not as the type's name.
  if (name[0] === "concurrently") return [quoted(name[0]), ...name.slice(1).map((p) => `.${minimalIdent(p)}`)];
  return typeObjectName(name);
};

const dropStmt = (d: Drop): Doc => {
  const head: Doc[] = [kw("DROP"), objectKeyword(d.objectType)];
  if (d.concurrently) head.push(kw("CONCURRENTLY"));
  if (d.ifExists) head.push(kw("IF EXISTS"));
  const items: Doc[] =
    d.source !== undefined && d.target !== undefined
      ? [castTypes(d.source, d.target)]
      : d.names.map((name, i) => dropItem(d, name, i));
  const tail: Doc[] = [];
  if (d.table !== undefined) tail.push(`${kw("ON")} ${qualified(d.table)}`);
  if (d.using !== undefined) tail.push(`${kw("USING")} ${ident(d.using)}`);
  if (d.force === true) tail.push(kw("WITH (FORCE)"));
  return stmt(head, [commaList(items), ...tail, ...behavior(d.behavior)]);
};

export const rolesFamily = defineFamily(
  "roles",
  {
    createRole: (n) =>
      withRoleOptions(
        [kw(`CREATE ${n.group === true ? "GROUP" : n.user ? "USER" : "ROLE"}`), ident(n.name)],
        n.options,
      ),
    alterRole: (n) => {
      // RENAME takes a plain role name, never a pseudo-role.
      const role = n.name === null ? kw("ALL") : n.action.kind === "rename" ? ident(n.name) : roleSpec(n.name);
      const head: Doc[] = [kw(n.user ? "ALTER USER" : "ALTER ROLE"), role];
      if (n.database !== undefined) head.push(kw("IN DATABASE"), ident(n.database));
      const a = n.action;
      switch (a.kind) {
        case "options":
          return withRoleOptions(head, a.options);
        case "rename":
          return stmt(head, [`${kw("RENAME TO")} ${ident(a.to)}`]);
        default:
          return stmt(head, [alterConfigAction(a)]);
      }
    },
    grant: (n) => {
      const parts: Doc[] = [clause(kw("GRANT"), privileges(n.privileges, n.allColumns))];
      if (n.on !== null) parts.push(clause(kw("ON"), grantObject(n.on)));
      parts.push(clause(kw("TO"), grantees(n.grantees)));
      if (n.options !== undefined) {
        parts.push(clause(kw("WITH"), commaList(n.options.map(roleGrantOption))));
      } else if (n.withGrantOption) {
        parts.push(kw(n.on !== null ? "WITH GRANT OPTION" : "WITH ADMIN OPTION"));
      }
      if (n.grantedBy !== undefined) parts.push(`${kw("GRANTED BY")} ${roleSpec(n.grantedBy)}`);
      return group(join(line, parts));
    },
    revoke: (n) => {
      const lead = n.grantOptionFor
        ? n.on !== null
          ? "REVOKE GRANT OPTION FOR"
          : "REVOKE ADMIN OPTION FOR"
        : n.option !== undefined
          ? `REVOKE ${n.option.toUpperCase()} OPTION FOR`
          : "REVOKE";
      const parts: Doc[] = [clause(kw(lead), privileges(n.privileges, n.allColumns))];
      if (n.on !== null) parts.push(clause(kw("ON"), grantObject(n.on)));
      parts.push(clause(kw("FROM"), grantees(n.grantees)));
      if (n.grantedBy !== undefined) parts.push(`${kw("GRANTED BY")} ${roleSpec(n.grantedBy)}`);
      parts.push(...behavior(n.behavior));
      return group(join(line, parts));
    },
    alterDefaultPrivileges: (n) =>
      group(
        join(line, [
          kw("ALTER DEFAULT PRIVILEGES"),
          ...n.options.map((o) =>
            o.kind === "forRole"
              ? clause(kw("FOR ROLE"), roleList(o.roles))
              : clause(kw("IN SCHEMA"), commaList(o.schemas.map(ident))),
          ),
          defaultPrivilegesAction(n.action),
        ]),
      ),
    dropOwned: (n) => stmt([kw("DROP OWNED BY")], [roleList(n.roles), ...behavior(n.behavior)]),
    reassignOwned: (n) => stmt([kw("REASSIGN OWNED BY")], [roleList(n.roles), `${kw("TO")} ${roleSpec(n.newRole)}`]),
    // The node is its object reference, with the statement's own keys beside it.
    comment: (n) =>
      stmt([kw("COMMENT ON"), objectRef(n)], [`${kw("IS")} ${n.comment === null ? kw("NULL") : str(n.comment)}`]),
    securityLabel: (n) =>
      stmt(
        [
          kw("SECURITY LABEL"),
          ...(n.provider !== undefined ? [kw("FOR"), n.provider === "" ? str("") : ident(n.provider)] : []),
          kw("ON"),
          objectRef(n),
        ],
        [`${kw("IS")} ${n.label === null ? kw("NULL") : str(n.label)}`],
      ),
    drop: dropStmt,
  },
  [],
);
