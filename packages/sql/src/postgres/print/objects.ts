// The other schema objects: views, sequences, domains, types, routines,
// triggers, policies, publications, foreign data and the long tail.
//
// Routine bodies are strings the AST holds decoded, so the source's quoting is
// gone. A one-part `AS` definition is written dollar-quoted, `$$…$$`, or with
// the first tag of `$x$`, `$x1$`, `$x2$`, … that the body can't end early
// when it holds `$$` (or ends in `$`); a dollar-quoted body is read verbatim,
// so it round-trips whatever it holds. The two-part `AS 'obj', 'symbol'` of a
// C function is written as two string constants.
//
// CREATE FOREIGN TABLE takes CREATE TABLE's elements and partition bounds,
// printed by the tables family's element printers.
import { type Doc, group, indent, join, line } from "@parser-kit/core/print";
import type {
  AggregateOption,
  AlterDomainAction,
  AlterPublicationAction,
  AlterSubscriptionAction,
  AlterTypeAction,
  AlterViewAction,
  ColType,
  DefinitionArg,
  DefinitionElem,
  DomainConstraint,
  Expr,
  FdwFunction,
  FunctionOption,
  FunctionReturns,
  OpClassItem,
  PolicyClauses,
  PublicationObject,
  RelationOption,
  RoutineBody,
  Stmt,
} from "../ast";
import { RESERVED } from "../grammar";
import { commaList, ident, kw, lastText, parenList, parens, qualified, quoted, str } from "./context";
import { bExpr, expr } from "./expr";
import { columnDefinition, printQuery } from "./query";
import { defineFamily, statementPrinter } from "./registry";
import {
  alterConfig,
  alterGenericOptions,
  argName,
  commonAlterAction,
  functionArg,
  genericOptions,
  type OptionStyle,
  objectRef,
  objectRefName,
  operandTypes,
  operatorName,
  optionLabel,
  optionValue,
  parameterSet,
  relationOptions,
  roleSpec,
  sequenceOption,
  signature,
} from "./shared";
import { partitionBound, tableElements } from "./tables";
import { typeName } from "./types";

// The option lists the family prints (WITH / SET / RESET of storage
// parameters, publication and subscription options) take PG's def_elem: a
// reserved word may stand bare as a name or a word value, and `=` is written.
const STORAGE: OptionStyle = { eq: true, keywords: false, reservedNames: true, reservedValues: true };

// --- layout ---

/** `head clause clause …`: the clauses move to indented lines of their own when it doesn't fit. */
const stmt = (head: Doc, ...clauses: (Doc | null | false | undefined)[]): Doc =>
  group([
    head,
    indent(
      clauses
        .filter((c): c is Doc => c !== null && c !== false && c !== undefined && c !== "")
        .map((c) => [line, group(indent(c))]),
    ),
  ]);

/** Keywords and docs separated by spaces, empty parts left out. */
const words = (...parts: (Doc | null | false | undefined)[]): Doc =>
  join(
    " ",
    parts.filter((p): p is Doc => p !== null && p !== false && p !== undefined && p !== ""),
  );

const ifNotExists = (on: boolean | undefined): Doc => (on === true ? kw("IF NOT EXISTS") : "");
const ifExists = (on: boolean | undefined): Doc => (on === true ? kw("IF EXISTS") : "");

const names = (list: readonly string[]): Doc => commaList(list.map(ident));

const withOptions = (options: readonly RelationOption[] | undefined): Doc =>
  options === undefined ? "" : [kw("WITH"), " ", relationOptions(options, STORAGE)];

// A name read as a plain name (no reserved word bare): an aggregate's or a
// range type's option. Upper case when it can be bare.
const wordName = (name: string): string =>
  /^[a-z_][a-z0-9_]*$/.test(name) && ident(name) === name ? kw(name.toUpperCase()) : ident(name);

// A one-part bare word in upper case (a definition list's `INPUT`), or the
// label as it must be written.
const definitionName = (name: string): string =>
  /^[a-z_][a-z0-9_]*$/.test(name) && optionLabel(name) === name ? kw(name.toUpperCase()) : optionLabel(name);

// --- strings ---

/** A routine body, dollar-quoted with a tag the body can't close early. */
export const dollarQuote = (body: string): string => {
  for (let i = 0; ; i++) {
    const tag = i === 0 ? "" : i === 1 ? "x" : `x${i - 1}`;
    const closer = `$${tag}$`;
    if ((body + closer).indexOf(closer) === body.length) return `${closer}${body}${closer}`;
  }
};

// --- definitions (CREATE TYPE / COLLATION / OPERATOR / TEXT SEARCH) ---

const definitionArg = (a: DefinitionArg): Doc => {
  switch (a.kind) {
    case "type":
      return typeName(a.type);
    case "keyword":
      return kw(a.value.toUpperCase());
    case "operator":
      return a.name.length === 1 ? a.name[0]! : [kw("OPERATOR"), "(", operatorName(a.name), ")"];
    case "number":
      return expr({ kind: "number", value: a.value, ...(a.raw !== undefined && { raw: a.raw }) } as Expr);
    case "string":
      return str(a.value);
    case "none":
      return kw("NONE");
  }
};

const definitionElem = (e: DefinitionElem): Doc =>
  e.value === undefined ? definitionName(e.name) : [definitionName(e.name), " = ", definitionArg(e.value)];

const definition = (elems: readonly DefinitionElem[]): Doc => parenList(elems.map(definitionElem));

// --- sequences ---

// --- domains ---

const constraintName = (name: string | null): Doc => (name === null ? "" : [kw("CONSTRAINT"), " ", ident(name), " "]);

const domainConstraint = (c: DomainConstraint): Doc => {
  switch (c.kind) {
    case "notNull":
      return [constraintName(c.name), kw("NOT NULL")];
    case "null":
      return [constraintName(c.name), kw("NULL")];
    case "check":
      return [constraintName(c.name), kw("CHECK"), " ", parens(expr(c.expr))];
    case "default":
      return [kw("DEFAULT"), " ", bExpr(c.expr)];
    case "collate":
      return [kw("COLLATE"), " ", qualified(c.collation)];
  }
};

const dropBehavior = (b: "cascade" | "restrict" | null): Doc => (b === null ? "" : kw(b.toUpperCase()));

const alterDomainAction = (a: AlterDomainAction): Doc => {
  switch (a.kind) {
    case "rename":
    case "ownerTo":
    case "setSchema":
      return commonAlterAction(a);
    case "setDefault":
      return [kw("SET DEFAULT"), " ", expr(a.expr)];
    case "dropDefault":
      return kw("DROP DEFAULT");
    case "setNotNull":
      return kw("SET NOT NULL");
    case "dropNotNull":
      return kw("DROP NOT NULL");
    case "addConstraint":
      return words(kw("ADD"), [domainConstraint(a.constraint)], a.notValid && kw("NOT VALID"));
    case "dropConstraint":
      return words(kw("DROP CONSTRAINT"), ifExists(a.ifExists), ident(a.name), dropBehavior(a.behavior));
    case "renameConstraint":
      return [kw("RENAME CONSTRAINT"), " ", ident(a.from), " ", kw("TO"), " ", ident(a.to)];
    case "validateConstraint":
      return [kw("VALIDATE CONSTRAINT"), " ", ident(a.name)];
  }
};

// --- types ---

const alterTypeAction = (a: AlterTypeAction): Doc => {
  switch (a.kind) {
    case "rename":
    case "ownerTo":
    case "setSchema":
      return commonAlterAction(a);
    case "addValue":
      return words(
        kw("ADD VALUE"),
        ifNotExists(a.ifNotExists),
        str(a.value),
        a.position !== null && [kw(a.position.placement.toUpperCase()), " ", str(a.position.value)],
      );
    case "renameValue":
      return [kw("RENAME VALUE"), " ", str(a.from), " ", kw("TO"), " ", str(a.to)];
  }
};

// --- views ---

const alterColumn = (column: string, rest: Doc): Doc => [kw("ALTER COLUMN"), " ", ident(column), " ", rest];

const alterViewAction = (a: AlterViewAction): Doc => {
  switch (a.kind) {
    case "rename":
    case "ownerTo":
    case "setSchema":
      return commonAlterAction(a);
    case "renameColumn":
      return [kw("RENAME COLUMN"), " ", ident(a.from), " ", kw("TO"), " ", ident(a.to)];
    case "setDefault":
      return alterColumn(a.column, [kw("SET DEFAULT"), " ", expr(a.expr)]);
    case "dropDefault":
      return alterColumn(a.column, kw("DROP DEFAULT"));
    case "setStatistics":
      return alterColumn(a.column, [kw("SET STATISTICS"), " ", a.value === null ? kw("DEFAULT") : String(a.value)]);
    case "setStorage":
      return alterColumn(a.column, [kw("SET STORAGE"), " ", kw((a.storage ?? "default").toUpperCase())]);
    case "setCompression":
      return alterColumn(a.column, [kw("SET COMPRESSION"), " ", a.method === null ? kw("DEFAULT") : ident(a.method)]);
    case "setColumnOptions":
      return alterColumn(a.column, [kw("SET"), " ", relationOptions(a.options, STORAGE)]);
    case "resetColumnOptions":
      return alterColumn(a.column, [kw("RESET"), " ", relationOptions(a.options, STORAGE)]);
    case "clusterOn":
      return [kw("CLUSTER ON"), " ", ident(a.index)];
    case "setWithoutCluster":
      return kw("SET WITHOUT CLUSTER");
    case "setAccessMethod":
      return [kw("SET ACCESS METHOD"), " ", a.method === null ? kw("DEFAULT") : ident(a.method)];
    case "replicaIdentity":
      return [
        kw("REPLICA IDENTITY"),
        " ",
        a.mode === "usingIndex" ? [kw("USING INDEX"), " ", ident(a.index!)] : kw(a.mode.toUpperCase()),
      ];
    case "setOptions":
      return [kw("SET"), " ", relationOptions(a.options, STORAGE)];
    case "resetOptions":
      return [kw("RESET"), " ", relationOptions(a.options, STORAGE)];
    case "setTablespace":
      return [kw("SET TABLESPACE"), " ", ident(a.tablespace)];
  }
};

// --- routines ---

const functionReturns = (r: FunctionReturns): Doc =>
  r.kind === "table"
    ? [kw("RETURNS TABLE"), " ", parenList(r.columns.map((c) => [argName(c.name), " ", typeName(c.type)]))]
    : [kw("RETURNS"), " ", r.setof ? `${kw("SETOF")} ` : "", typeName(r.type)];

const functionOption = (o: FunctionOption): Doc => {
  switch (o.kind) {
    case "language":
      return [kw("LANGUAGE"), " ", ident(o.name)];
    case "as":
      return [kw("AS"), " ", o.parts.length === 1 ? dollarQuote(o.parts[0]!) : join(", ", o.parts.map(str))];
    case "volatility":
      return kw(o.value.toUpperCase());
    case "leakproof":
      return kw(o.value ? "LEAKPROOF" : "NOT LEAKPROOF");
    case "strictness":
      return kw(
        o.value === "strict"
          ? "STRICT"
          : o.value === "calledOnNullInput"
            ? "CALLED ON NULL INPUT"
            : "RETURNS NULL ON NULL INPUT",
      );
    case "security":
      return [o.external ? `${kw("EXTERNAL")} ` : "", kw(o.definer ? "SECURITY DEFINER" : "SECURITY INVOKER")];
    case "parallel":
      return [kw("PARALLEL"), " ", kw(o.value.toUpperCase())];
    case "cost":
      return [kw("COST"), " ", expr(o.value)];
    case "rows":
      return [kw("ROWS"), " ", expr(o.value)];
    case "window":
      return kw("WINDOW");
    case "set":
      return [kw("SET"), " ", parameterSet(o.parameter, o.value.kind === "list" ? o.value.values : o.value.kind)];
  }
};

const routineBody = (b: RoutineBody): Doc => {
  if (b.kind === "return") return [kw("RETURN"), " ", expr(b.expr)];
  const statements = b.statements.map(
    (s): Doc => [s.kind === "return" ? [kw("RETURN"), " ", expr(s.expr)] : statementPrinter.print(s), ";"],
  );
  return group([kw("BEGIN ATOMIC"), indent(statements.map((s) => [line, s])), line, kw("END")]);
};

const routine = (
  orReplace: boolean,
  what: string,
  name: string[],
  args: Parameters<typeof functionArg>[0][],
  returns: FunctionReturns | null,
  options: readonly FunctionOption[],
  body: RoutineBody | undefined,
): Doc =>
  stmt(
    [words(kw("CREATE"), orReplace && kw("OR REPLACE"), kw(what), qualified(name)), parenList(args.map(functionArg))],
    returns !== null && functionReturns(returns),
    ...options.map(functionOption),
    body !== undefined && routineBody(body),
  );

// `bare` writes the name unquoted whatever `identifierQuote` says, for the
// legacy form's first entry, which must open with an unquoted word.
const aggregateOption = (o: AggregateOption, bare = false): Doc => {
  const name = bare ? kw(o.name.toUpperCase()) : wordName(o.name);
  return o.value === null ? name : [name, " = ", o.value.kind === "type" ? typeName(o.value.type) : expr(o.value.expr)];
};

// --- policies ---

const policyClauses = (c: PolicyClauses): Doc[] => [
  c.roles !== undefined ? [kw("TO"), " ", commaList(c.roles.map(roleSpec))] : "",
  c.using !== undefined ? [kw("USING"), " ", parens(expr(c.using))] : "",
  c.withCheck !== undefined ? [kw("WITH CHECK"), " ", parens(expr(c.withCheck))] : "",
];

// --- publications and subscriptions ---

const publicationObject = (o: PublicationObject): Doc =>
  o.kind === "tablesInSchema"
    ? [kw("TABLES IN SCHEMA"), " ", o.schema === null ? kw("CURRENT_SCHEMA") : ident(o.schema)]
    : words(
        kw("TABLE"),
        o.only === true && kw("ONLY"),
        [qualified(o.name), o.columns !== undefined ? [" ", parenList(o.columns.map(ident))] : ""],
        o.where !== undefined && [kw("WHERE"), " ", parens(expr(o.where))],
      );

const publicationObjects = (objects: readonly PublicationObject[]): Doc => commaList(objects.map(publicationObject));

const alterPublicationAction = (a: AlterPublicationAction): Doc =>
  a.kind === "setOptions"
    ? [kw("SET"), " ", relationOptions(a.options, STORAGE)]
    : [kw(a.kind.toUpperCase()), " ", publicationObjects(a.objects)];

const alterSubscriptionAction = (a: AlterSubscriptionAction): Doc => {
  switch (a.kind) {
    case "connection":
      return [kw("CONNECTION"), " ", str(a.connection)];
    case "setPublication":
    case "addPublication":
    case "dropPublication":
      return words(
        kw(`${a.kind.slice(0, -"Publication".length).toUpperCase()} PUBLICATION`),
        names(a.publications),
        withOptions(a.options),
      );
    case "refreshPublication":
      return words(kw("REFRESH PUBLICATION"), withOptions(a.options));
    case "enable":
    case "disable":
      return kw(a.kind.toUpperCase());
    case "setOptions":
      return [kw("SET"), " ", relationOptions(a.options, STORAGE)];
    case "skip":
      return [kw("SKIP"), " ", relationOptions(a.options, STORAGE)];
  }
};

// --- foreign data ---

const fdwFunction = (f: FdwFunction): Doc =>
  f.name === null ? kw(`NO ${f.kind.toUpperCase()}`) : [kw(f.kind.toUpperCase()), " ", qualified(f.name)];

const serverVersion = (v: string | null | undefined): Doc =>
  v === undefined ? "" : [kw("VERSION"), " ", v === null ? kw("NULL") : str(v)];

const userMapping = (user: string, server: string): Doc => [
  kw("FOR"),
  " ",
  roleSpec(user),
  " ",
  kw("SERVER"),
  " ",
  ident(server),
];

// --- operator classes ---

const opClassItem = (i: OpClassItem): Doc => {
  switch (i.kind) {
    case "operator":
      return words(
        kw("OPERATOR"),
        String(i.strategy),
        operatorName(i.operator),
        i.operands !== undefined && operandTypes(i.operands),
        i.purpose !== undefined &&
          (i.purpose.kind === "search" ? kw("FOR SEARCH") : [kw("FOR ORDER BY"), " ", qualified(i.purpose.family)]),
      );
    case "function":
      return words(
        kw("FUNCTION"),
        String(i.support),
        i.types !== undefined && parenList(i.types.map((t: ColType) => typeName(t))),
        [qualified(i.name), i.signature !== undefined ? signature(i.signature) : ""],
      );
    case "storage":
      return [kw("STORAGE"), " ", typeName(i.type)];
  }
};

// --- statistics ---

// A statistics item is a column, a function call or a parenthesised
// expression: anything but a one-part name is parenthesised, which keeps the
// tree.
const statisticsItem = (e: Expr): Doc => (e.kind === "name" && e.parts.length === 1 ? expr(e) : ["(", expr(e), ")"]);

// --- views ---

// A query ending in IS JSON (in its select list, WHERE, a join condition,
// GROUP BY, …) would take the WITH of a following WITH DATA or WITH CHECK
// OPTION for the test's own uniqueness clause, so such a query is
// parenthesised. Told from the printed text: a query ending in a word IS JSON
// may end in (a column named `value`) gets parentheses it didn't need, which
// keeps the tree all the same.
const IS_JSON_END = /(?:^|[^a-z0-9_$"])(?:json|value|array|object|scalar)$/i;
const viewQuery = (q: Extract<Stmt, { kind: "createView" }>["query"], trailing: boolean): Doc => {
  const doc = printQuery(q);
  return trailing && IS_JSON_END.test(lastText(doc)) ? ["(", doc, ")"] : doc;
};

// --- the family ---

export const objectsFamily = defineFamily(
  "objects",
  {
    createView: (n) => {
      const trailing = n.withData !== null || n.checkOption !== undefined;
      return group([
        stmt(
          words(
            kw("CREATE"),
            n.orReplace && kw("OR REPLACE"),
            ...(n.modifiers ?? []).map((m) => kw(m.toUpperCase())),
            n.recursive === true && kw("RECURSIVE"),
            kw(n.materialized ? "MATERIALIZED VIEW" : "VIEW"),
            ifNotExists(n.ifNotExists),
            [qualified(n.name), n.columns !== null ? [" ", parenList(n.columns.map(ident))] : ""],
          ),
          n.accessMethod !== undefined && [kw("USING"), " ", ident(n.accessMethod)],
          withOptions(n.options),
          n.tablespace !== undefined && [kw("TABLESPACE"), " ", ident(n.tablespace)],
        ),
        " ",
        kw("AS"),
        line,
        viewQuery(n.query, trailing),
        n.withData !== null ? [line, kw(n.withData ? "WITH DATA" : "WITH NO DATA")] : "",
        n.checkOption !== undefined ? [line, kw(`WITH ${n.checkOption.toUpperCase()} CHECK OPTION`)] : "",
      ]);
    },
    alterView: (n) =>
      stmt(
        words(kw(n.materialized ? "ALTER MATERIALIZED VIEW" : "ALTER VIEW"), ifExists(n.ifExists), qualified(n.name)),
        commaList(n.actions.map(alterViewAction)),
      ),
    refreshMaterializedView: (n) =>
      stmt(
        words(kw("REFRESH MATERIALIZED VIEW"), n.concurrently && kw("CONCURRENTLY"), qualified(n.name)),
        n.withData !== null && kw(n.withData ? "WITH DATA" : "WITH NO DATA"),
      ),
    createSequence: (n) =>
      stmt(
        words(kw("CREATE SEQUENCE"), ifNotExists(n.ifNotExists), qualified(n.name)),
        ...n.options.map(sequenceOption),
      ),
    alterSequence: (n) =>
      stmt(
        words(kw("ALTER SEQUENCE"), ifExists(n.ifExists), qualified(n.name)),
        ...(n.action.kind === "options"
          ? n.action.options.map(sequenceOption)
          : n.action.kind === "setLogged" || n.action.kind === "setUnlogged"
            ? [kw(n.action.kind === "setLogged" ? "SET LOGGED" : "SET UNLOGGED")]
            : [commonAlterAction(n.action)]),
      ),
    createDomain: (n) =>
      stmt(
        [kw("CREATE DOMAIN"), " ", qualified(n.name), " ", kw("AS"), " ", typeName(n.dataType)],
        ...n.constraints.map(domainConstraint),
      ),
    alterDomain: (n) => stmt([kw("ALTER DOMAIN"), " ", qualified(n.name)], alterDomainAction(n.action)),
    createType: (n) => {
      const head = [kw("CREATE TYPE"), " ", qualified(n.name)];
      switch (n.form) {
        case "shell":
          return head;
        case "base":
          return [head, " ", definition(n.definition)];
        case "enum":
          return [head, " ", kw("AS ENUM"), " ", parenList(n.values.map(str))];
        case "range":
          return [
            head,
            " ",
            kw("AS RANGE"),
            " ",
            parenList(n.options.map((o) => [wordName(o.name), " = ", qualified(o.value)])),
          ];
        case "composite":
          return [head, " ", kw("AS"), " ", parenList(n.attributes.map(columnDefinition))];
      }
    },
    alterType: (n) => stmt([kw("ALTER TYPE"), " ", qualified(n.name)], alterTypeAction(n.action)),
    createFunction: (n) => routine(n.orReplace, "FUNCTION", n.name, n.args, n.returns, n.options, n.body),
    createProcedure: (n) => routine(n.orReplace, "PROCEDURE", n.name, n.args, null, n.options, n.body),
    alterFunction: (n) =>
      stmt(
        [kw("ALTER FUNCTION"), " ", qualified(n.name), n.args !== null ? parenList(n.args.map(functionArg)) : ""],
        ...(n.action.kind === "options" ? n.action.options.map(functionOption) : [commonAlterAction(n.action)]),
      ),
    createAggregate: (n) => {
      // PG has no empty `()` signature: an aggregate without one is the legacy
      // `name (BASETYPE = …, …)` form, which this grammar reads when an
      // unquoted name and `=` open the list. Otherwise `()` keeps the tree.
      const first = n.options[0];
      const legacy =
        !n.star &&
        n.args.length === 0 &&
        first?.value != null &&
        /^[a-z_][a-z0-9_$]*$/.test(first.name) &&
        !RESERVED.has(first.name);
      return [
        words(kw("CREATE"), n.orReplace && kw("OR REPLACE"), kw("AGGREGATE"), qualified(n.name)),
        legacy ? "" : signature({ star: n.star, args: n.args }),
        " ",
        parenList(n.options.map((o, i) => aggregateOption(o, legacy && i === 0))),
      ];
    },
    alterAggregate: (n) =>
      stmt(
        [kw("ALTER AGGREGATE"), " ", qualified(n.name), signature({ star: n.star, args: n.args })],
        commonAlterAction(n.action),
      ),
    createTrigger: (n) =>
      stmt(
        words(
          kw("CREATE"),
          n.orReplace && kw("OR REPLACE"),
          n.constraint === true && kw("CONSTRAINT"),
          kw("TRIGGER"),
          ident(n.name),
        ),
        words(
          kw(n.timing === "insteadOf" ? "INSTEAD OF" : n.timing.toUpperCase()),
          join(
            ` ${kw("OR")} `,
            n.events.map((e) =>
              e.columns === null
                ? kw(e.event.toUpperCase())
                : [kw(e.event.toUpperCase()), " ", kw("OF"), " ", names(e.columns)],
            ),
          ),
        ),
        [kw("ON"), " ", qualified(n.table)],
        n.fromTable !== undefined && [kw("FROM"), " ", qualified(n.fromTable)],
        n.deferrable !== undefined && kw(n.deferrable ? "DEFERRABLE" : "NOT DEFERRABLE"),
        n.initially !== undefined && kw(`INITIALLY ${n.initially.toUpperCase()}`),
        n.referencing !== undefined && [
          kw("REFERENCING"),
          " ",
          join(
            " ",
            n.referencing.map((t) => [kw(`${t.kind.toUpperCase()} TABLE AS`), " ", ident(t.name)]),
          ),
        ],
        n.forEach !== null && kw(`FOR EACH ${n.forEach.toUpperCase()}`),
        n.when !== null && [kw("WHEN"), " ", parens(expr(n.when))],
        [
          kw(`EXECUTE ${n.execute.routine.toUpperCase()}`),
          " ",
          qualified(n.execute.name),
          n.execute.args.length === 0 ? "()" : parenList(n.execute.args.map(expr)),
        ],
      ),
    createPolicy: (n) =>
      stmt(
        [kw("CREATE POLICY"), " ", ident(n.name), " ", kw("ON"), " ", qualified(n.table)],
        n.as !== undefined && [kw("AS"), " ", kw(n.as.toUpperCase())],
        n.command !== undefined && [kw("FOR"), " ", kw(n.command.toUpperCase())],
        ...policyClauses(n),
      ),
    alterPolicy: (n) =>
      stmt([kw("ALTER POLICY"), " ", ident(n.name), " ", kw("ON"), " ", qualified(n.table)], ...policyClauses(n)),
    createPublication: (n) =>
      stmt(
        [kw("CREATE PUBLICATION"), " ", ident(n.name)],
        n.allTables === true && kw("FOR ALL TABLES"),
        n.objects !== undefined && [kw("FOR"), " ", publicationObjects(n.objects)],
        withOptions(n.options),
      ),
    alterPublication: (n) => stmt([kw("ALTER PUBLICATION"), " ", ident(n.name)], alterPublicationAction(n.action)),
    createSubscription: (n) =>
      stmt(
        [kw("CREATE SUBSCRIPTION"), " ", ident(n.name)],
        [kw("CONNECTION"), " ", str(n.connection)],
        [kw("PUBLICATION"), " ", names(n.publications)],
        withOptions(n.options),
      ),
    alterSubscription: (n) => stmt([kw("ALTER SUBSCRIPTION"), " ", ident(n.name)], alterSubscriptionAction(n.action)),
    createDatabase: (n) =>
      stmt(
        [kw("CREATE DATABASE"), " ", ident(n.name), n.options.length > 0 ? ` ${kw("WITH")}` : ""],
        ...n.options.map(databaseOption),
      ),
    alterDatabase: (n) => {
      const head = [kw("ALTER DATABASE"), " ", ident(n.name)];
      switch (n.action.kind) {
        case "options":
          return stmt(
            [head, n.action.options.length > 0 ? ` ${kw("WITH")}` : ""],
            ...n.action.options.map(databaseOption),
          );
        case "setTablespace":
          return stmt(head, [kw("SET TABLESPACE"), " ", ident(n.action.tablespace)]);
        case "refreshCollationVersion":
          return stmt(head, kw("REFRESH COLLATION VERSION"));
        case "set":
        case "reset":
          return stmt(head, alterConfig(n.action));
      }
    },
    createSchema: (n) =>
      stmt(
        words(kw("CREATE SCHEMA"), ifNotExists(n.ifNotExists), n.name !== null && ident(n.name)),
        n.authorization !== null && [kw("AUTHORIZATION"), " ", roleSpec(n.authorization)],
        ...n.elements.map((e) => statementPrinter.print(e)),
      ),
    alterSchema: (n) => stmt([kw("ALTER SCHEMA"), " ", ident(n.name)], commonAlterAction(n.action)),
    createExtension: (n) =>
      stmt(
        words(kw("CREATE EXTENSION"), ifNotExists(n.ifNotExists), ident(n.name)),
        ...n.options.map((o) =>
          o.kind === "schema"
            ? [kw("SCHEMA"), " ", ident(o.schema)]
            : o.kind === "version"
              ? [kw("VERSION"), " ", str(o.version)]
              : kw("CASCADE"),
        ),
      ),
    alterExtension: (n) => {
      const a = n.action;
      return stmt(
        [kw("ALTER EXTENSION"), " ", ident(n.name)],
        a.kind === "setSchema"
          ? commonAlterAction(a)
          : a.kind === "update"
            ? words(kw("UPDATE"), a.version !== undefined && [kw("TO"), " ", str(a.version)])
            : [kw(a.kind.toUpperCase()), " ", objectRef(a.object)],
      );
    },
    createTablespace: (n) =>
      stmt(
        [kw("CREATE TABLESPACE"), " ", ident(n.name)],
        n.owner !== null && [kw("OWNER"), " ", roleSpec(n.owner)],
        [kw("LOCATION"), " ", str(n.location)],
        n.options.length > 0 && withOptions(n.options),
      ),
    alterTablespace: (n) =>
      stmt(
        [kw("ALTER TABLESPACE"), " ", ident(n.name)],
        [kw(n.action.kind === "setOptions" ? "SET" : "RESET"), " ", relationOptions(n.action.options, STORAGE)],
      ),
    createForeignDataWrapper: (n) =>
      stmt(
        [kw("CREATE FOREIGN DATA WRAPPER"), " ", ident(n.name)],
        ...(n.functions ?? []).map(fdwFunction),
        n.options !== undefined && genericOptions(n.options),
      ),
    alterForeignDataWrapper: (n) =>
      stmt(
        [kw("ALTER FOREIGN DATA WRAPPER"), " ", ident(n.name)],
        ...(n.functions ?? []).map(fdwFunction),
        n.options !== undefined && alterGenericOptions(n.options),
      ),
    createServer: (n) =>
      stmt(
        words(kw("CREATE SERVER"), ifNotExists(n.ifNotExists), ident(n.name)),
        n.type !== undefined && [kw("TYPE"), " ", str(n.type)],
        serverVersion(n.version),
        [kw("FOREIGN DATA WRAPPER"), " ", ident(n.wrapper)],
        n.options !== undefined && genericOptions(n.options),
      ),
    alterServer: (n) =>
      stmt(
        [kw("ALTER SERVER"), " ", ident(n.name)],
        serverVersion(n.version),
        n.options !== undefined && alterGenericOptions(n.options),
      ),
    createUserMapping: (n) =>
      stmt(
        words(kw("CREATE USER MAPPING"), ifNotExists(n.ifNotExists)),
        userMapping(n.user, n.server),
        n.options !== undefined && genericOptions(n.options),
      ),
    alterUserMapping: (n) =>
      stmt(kw("ALTER USER MAPPING"), userMapping(n.user, n.server), alterGenericOptions(n.options)),
    dropUserMapping: (n) => stmt(words(kw("DROP USER MAPPING"), ifExists(n.ifExists)), userMapping(n.user, n.server)),
    importForeignSchema: (n) =>
      stmt(
        [kw("IMPORT FOREIGN SCHEMA"), " ", ident(n.remoteSchema)],
        n.qualification !== undefined && [
          kw(n.qualification.kind === "limitTo" ? "LIMIT TO" : "EXCEPT"),
          " ",
          parenList(n.qualification.tables.map(qualified)),
        ],
        [kw("FROM SERVER"), " ", ident(n.server)],
        [kw("INTO"), " ", ident(n.into)],
        n.options !== undefined && genericOptions(n.options),
      ),
    createCast: (n) =>
      stmt(
        [kw("CREATE CAST"), " (", typeName(n.source), " ", kw("AS"), " ", typeName(n.target), ")"],
        n.method === "withoutFunction"
          ? kw("WITHOUT FUNCTION")
          : n.method === "inout"
            ? kw("WITH INOUT")
            : [
                kw("WITH FUNCTION"),
                " ",
                qualified(n.function!.name),
                n.function!.signature !== undefined ? signature(n.function!.signature) : "",
              ],
        n.context !== undefined && kw(`AS ${n.context.toUpperCase()}`),
      ),
    createCollation: (n) => {
      const head = words(kw("CREATE COLLATION"), ifNotExists(n.ifNotExists), qualified(n.name));
      return n.from !== undefined
        ? stmt(head, [kw("FROM"), " ", qualified(n.from)])
        : [head, " ", definition(n.definition ?? [])];
    },
    createConversion: (n) =>
      stmt(
        words(kw("CREATE"), n.default === true && kw("DEFAULT"), kw("CONVERSION"), qualified(n.name)),
        [kw("FOR"), " ", str(n.source)],
        [kw("TO"), " ", str(n.target)],
        [kw("FROM"), " ", qualified(n.function)],
      ),
    createStatistics: (n) =>
      stmt(
        words(
          kw("CREATE STATISTICS"),
          ifNotExists(n.ifNotExists),
          n.name !== undefined && qualified(n.name),
          n.kinds !== undefined && parenList(n.kinds.map(ident)),
        ),
        [kw("ON"), " ", commaList(n.on.map(statisticsItem))],
        [kw("FROM"), " ", commaList(n.from.map(qualified))],
      ),
    createEventTrigger: (n) =>
      stmt(
        [kw("CREATE EVENT TRIGGER"), " ", ident(n.name), " ", kw("ON"), " ", ident(n.event)],
        n.when !== undefined && [
          kw("WHEN"),
          " ",
          join(
            ` ${kw("AND")} `,
            n.when.map((w) => [ident(w.variable), " ", kw("IN"), " ", parenList(w.values.map(str))]),
          ),
        ],
        [kw(`EXECUTE ${n.execute.routine.toUpperCase()}`), " ", qualified(n.execute.name), "()"],
      ),
    createLanguage: (n) =>
      stmt(
        words(
          kw("CREATE"),
          n.orReplace && kw("OR REPLACE"),
          n.trusted === true && kw("TRUSTED"),
          n.procedural === true && kw("PROCEDURAL"),
          kw("LANGUAGE"),
          ident(n.name),
        ),
        n.handler !== undefined && [kw("HANDLER"), " ", qualified(n.handler)],
        n.inline !== undefined && [kw("INLINE"), " ", qualified(n.inline)],
        n.validator !== undefined &&
          (n.validator === null ? kw("NO VALIDATOR") : [kw("VALIDATOR"), " ", qualified(n.validator)]),
      ),
    createAccessMethod: (n) =>
      stmt([kw("CREATE ACCESS METHOD"), " ", ident(n.name)], kw(`TYPE ${n.type.toUpperCase()}`), [
        kw("HANDLER"),
        " ",
        qualified(n.handler),
      ]),
    createTextSearch: (n) => [
      kw(`CREATE TEXT SEARCH ${n.objectType.toUpperCase()}`),
      " ",
      qualified(n.name),
      " ",
      definition(n.definition),
    ],
    createOperator: (n) => [kw("CREATE OPERATOR"), " ", operatorName(n.name), " ", definition(n.definition)],
    createOperatorClass: (n) =>
      stmt(
        words(kw("CREATE OPERATOR CLASS"), qualified(n.name), n.default === true && kw("DEFAULT")),
        [kw("FOR TYPE"), " ", typeName(n.type)],
        [kw("USING"), " ", ident(n.using)],
        n.family !== undefined && [kw("FAMILY"), " ", qualified(n.family)],
        [kw("AS"), " ", commaList(n.items.map(opClassItem))],
      ),
    createOperatorFamily: (n) =>
      stmt([kw("CREATE OPERATOR FAMILY"), " ", qualified(n.name)], [kw("USING"), " ", ident(n.using)]),
    alterObject: (n) =>
      stmt(
        words(kw("ALTER"), kw(n.object.objectType.toUpperCase()), ifExists(n.ifExists), objectRefName(n.object)),
        commonAlterAction(n.action),
      ),
    // PARTITION OF's element list may be left out; the plain form's may be
    // empty, `()`, but never left out.
    createForeignTable: (n) =>
      stmt(
        [
          words(
            kw("CREATE FOREIGN TABLE"),
            ifNotExists(n.ifNotExists),
            qualified(n.name),
            n.partitionOf !== undefined ? [kw("PARTITION OF"), " ", qualified(n.partitionOf.parent)] : "",
          ),
          n.partitionOf === undefined || n.items.length > 0 ? [" ", tableElements(n.items)] : "",
        ],
        n.partitionOf !== undefined && partitionBound(n.partitionOf.bound),
        n.inherits !== undefined && [kw("INHERITS"), " ", parenList(n.inherits.map(qualified))],
        [kw("SERVER"), " ", ident(n.server)],
        n.options !== undefined && genericOptions(n.options),
      ),
  },
  [],
);

// CREATE / ALTER DATABASE's options: a space-separated `name = value` run,
// whose entries lead with an unreserved or quoted word, never one that leads
// another ALTER DATABASE action. PG's two-word CONNECTION LIMIT is one name.
const DATABASE_ACTION_WORDS: ReadonlySet<string> = new Set(["rename", "set", "reset", "refresh"]);
function databaseOption(o: RelationOption): Doc {
  if (o.name === "connection limit" && o.namespace === undefined && o.value !== null) {
    return [kw("CONNECTION LIMIT"), " = ", optionValue(o.value, STORAGE)];
  }
  const name = (w: string): string => (DATABASE_ACTION_WORDS.has(w) ? quoted(w) : ident(w));
  return [
    o.namespace !== undefined ? `${name(o.namespace)}.` : "",
    name(o.name),
    o.value !== null ? [" = ", optionValue(o.value, STORAGE)] : "",
  ];
}
