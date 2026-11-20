// Tables and indexes: CREATE TABLE (every element, constraint, partitioning
// and storage clause), CREATE TABLE AS, ALTER [FOREIGN] TABLE with every
// action, ALTER … ALL IN TABLESPACE, and CREATE / ALTER INDEX.
//
// The element printers (`tableElements`, `partitionBound`) are exported for
// CREATE FOREIGN TABLE, which takes the same elements and bounds.
import { type Doc, group, indent, join, line } from "@parser-kit/core/print";
import type {
  AlterAction,
  AlterIndexAction,
  ColConstraint,
  ColumnDef,
  ColumnOptions,
  ConstraintAttrs,
  Expr,
  ForeignKeyTail,
  IndexColumn,
  IndexParams,
  PartitionBound,
  PartitionKey,
  PartitionRangeDatum,
  PartitionSpec,
  RefAction,
  Stmt,
  TableConstraint,
  TableConstraintAttrs,
  TableItem,
} from "../ast";
import { clause, commaList, ident, kw, lastText, parenList, parens, qualified, quoted } from "./context";
import { bExpr, expr } from "./expr";
import { printQuery } from "./query";
import { defineFamily, statementPrinter } from "./registry";
import {
  alterGenericOptions,
  genericOptions,
  ownerTo,
  relationOptions,
  renameTo,
  roleSpec,
  sequenceOption,
  sequenceOptions,
  setSchema,
  signedZero,
} from "./shared";
import { typeName } from "./types";

type CreateTable = Extract<Stmt, { kind: "createTable" }>;
type CreateTableAs = Extract<Stmt, { kind: "createTableAs" }>;
type CreateIndex = Extract<Stmt, { kind: "createIndex" }>;
type AlterTable = Extract<Stmt, { kind: "alterTable" }>;
type AlterIndex = Extract<Stmt, { kind: "alterIndex" }>;
type AlterAllInTablespace = Extract<Stmt, { kind: "alterAllInTablespace" }>;

/** Words separated by single spaces, the empty ones dropped. */
const words = (...parts: Doc[]): Doc =>
  join(
    " ",
    parts.filter((p) => p !== ""),
  );

/** `lead clause …`, each clause on an indented line of its own when the whole doesn't fit. */
const phrase = (lead: Doc, ...clauses: Doc[]): Doc => {
  const present = clauses.filter((c) => c !== "");
  return present.length === 0 ? lead : group([lead, indent(present.map((c) => [line, c]))]);
};

const names = (list: readonly string[]): Doc => parenList(list.map(ident));

// --- expressions in restricted positions ---

// What PG's index_elem, part_elem and exclusion element take unparenthesised: a
// column (one name part) or a function call. Anything else is parenthesised,
// which never changes what PG reads, and which this grammar requires of a
// partition key and drops again on parsing.
const isBareElement = (e: Expr): boolean => (e.kind === "name" && e.parts.length === 1) || e.kind === "call";
const element = (e: Expr): Doc =>
  e.kind === "name" && e.parts.length === 1 && LOOKAHEAD_WORDS.has(e.parts[0]!)
    ? quoted(e.parts[0]!)
    : isBareElement(e)
      ? expr(e)
      : parens(expr(e));

// PG's lexer reads FORMAT before JSON, WITHOUT before TIME and NULLS before
// FIRST / LAST as one token, which no name can be. So a name written where
// one of those words may follow it (a column before its type, an element
// before its operator class) is quoted when it is one of the three.
const LOOKAHEAD_WORDS = new Set(["format", "without", "nulls"]);
const leadName = (name: string): string => (LOOKAHEAD_WORDS.has(name) ? quoted(name) : ident(name));
const collation = (parts: readonly string[]): string =>
  parts.map((p, i) => (i === parts.length - 1 && LOOKAHEAD_WORDS.has(p) ? quoted(p) : ident(p))).join(".");

// An index or exclusion element: as `element`, but a COLLATE around it is
// written outside the parentheses, where PG reads it as the element's own
// collation (`a COLLATE "C"`). Inside them, it would make the element an
// expression (`(a COLLATE "C")`), which PG indexes differently; this grammar
// reads both spellings as the same tree. (A partition key keeps its own
// collation apart, so its COLLATE nodes are the parenthesised kind.)
const indexElement = (e: Expr): Doc =>
  e.kind === "collate" ? [element(e.expr), " ", kw("COLLATE"), " ", collation(e.collation)] : element(e);

// An operator class follows its element's expression, so a word that would
// continue that expression is quoted (`a "between"`, `f(a) "over" (…)`). The
// others are quoted by `ident` already (reserved words, IS, ISNULL, LIKE, …).
const opclass = (parts: readonly string[]): string =>
  parts.map((p, i) => (i === 0 && CONTINUING_WORDS.has(p) ? quoted(p) : ident(p))).join(".");
// BETWEEN continues any expression; OVER and FILTER a call, when a `(`
// (the operator class's options) follows.
const CONTINUING_WORDS = new Set(["between", "over", "filter"]);

// --- constraints ---

const deferral = (a: ConstraintAttrs): Doc[] => [
  a.deferrable === undefined ? "" : kw(a.deferrable ? "DEFERRABLE" : "NOT DEFERRABLE"),
  a.initially === undefined ? "" : kw(a.initially === "deferred" ? "INITIALLY DEFERRED" : "INITIALLY IMMEDIATE"),
];

const tableAttrs = (a: TableConstraintAttrs): Doc[] => [
  ...deferral(a),
  a.notValid ? kw("NOT VALID") : "",
  a.noInherit ? kw("NO INHERIT") : "",
];

const indexParams = (p: IndexParams): Doc[] => [
  p.include !== undefined ? [kw("INCLUDE"), " ", names(p.include)] : "",
  p.options !== undefined ? [kw("WITH"), " ", relationOptions(p.options)] : "",
  p.indexTablespace !== undefined ? `${kw("USING INDEX TABLESPACE")} ${ident(p.indexTablespace)}` : "",
];

const refAction = (a: RefAction): string => kw(a.toUpperCase());

const foreignKeyTail = (t: ForeignKeyTail): Doc[] => [
  t.match !== undefined ? `${kw("MATCH")} ${kw(t.match.toUpperCase())}` : "",
  t.onDelete !== null
    ? [
        `${kw("ON DELETE")} ${refAction(t.onDelete)}`,
        t.onDeleteColumns !== undefined ? [" ", names(t.onDeleteColumns)] : "",
      ]
    : "",
  t.onUpdate !== undefined ? `${kw("ON UPDATE")} ${refAction(t.onUpdate)}` : "",
];

const generatedWhen = (g: "always" | "by default"): string => kw(g === "always" ? "ALWAYS" : "BY DEFAULT");

const constraintName = (name: string | null | undefined): Doc =>
  name === null || name === undefined ? "" : `${kw("CONSTRAINT")} ${ident(name)}`;

/** One column constraint, `CONSTRAINT name` first when it has one. */
const columnConstraint = (c: ColConstraint): Doc => {
  if (c.kind === "collate") return `${kw("COLLATE")} ${qualified(c.collation)}`;
  let body: Doc;
  switch (c.kind) {
    case "notNull":
      body = kw("NOT NULL");
      break;
    case "nullable":
      body = kw("NULL");
      break;
    case "default":
      // PG reads a column default as a b_expr.
      body = [kw("DEFAULT"), " ", bExpr(c.expr)];
      break;
    case "primaryKey":
      body = phrase(kw("PRIMARY KEY"), ...indexParams(c), ...deferral(c));
      break;
    case "unique":
      body = phrase(words(kw("UNIQUE"), nullsTreatment(c.nulls)), ...indexParams(c), ...deferral(c));
      break;
    case "references":
      body = phrase(
        [kw("REFERENCES"), " ", qualified(c.table), c.columns !== null ? [" ", names(c.columns)] : ""],
        ...foreignKeyTail(c),
        ...deferral(c),
      );
      break;
    case "check":
      body = words(kw("CHECK"), parens(expr(c.expr)), c.noInherit ? kw("NO INHERIT") : "");
      break;
    case "identity":
      body = words(
        kw("GENERATED"),
        generatedWhen(c.generated),
        kw("AS IDENTITY"),
        c.options !== undefined ? sequenceOptions(c.options) : "",
      );
      break;
    case "generated":
      body = words(kw("GENERATED ALWAYS AS"), parens(expr(c.expr)), kw(c.virtual ? "VIRTUAL" : "STORED"));
      break;
  }
  return words(constraintName(c.name), body);
};

const nullsTreatment = (n: "distinct" | "not distinct" | undefined): Doc =>
  n === undefined ? "" : kw(n === "distinct" ? "NULLS DISTINCT" : "NULLS NOT DISTINCT");

/** A table constraint; `name` is ALTER TABLE's ADD CONSTRAINT name when it holds it apart. */
const tableConstraint = (c: TableConstraint, name: string | null = c.name): Doc => {
  let body: Doc;
  switch (c.kind) {
    case "primaryKey":
      body = phrase(words(kw("PRIMARY KEY"), names(c.columns)), ...indexParams(c), ...deferral(c));
      break;
    case "unique":
      body = phrase(words(kw("UNIQUE"), nullsTreatment(c.nulls), names(c.columns)), ...indexParams(c), ...deferral(c));
      break;
    case "check":
      body = phrase(words(kw("CHECK"), parens(expr(c.expr))), ...tableAttrs(c));
      break;
    case "foreignKey":
      body = phrase(
        words(kw("FOREIGN KEY"), names(c.columns), kw("REFERENCES"), [
          qualified(c.refTable),
          c.refColumns !== null ? [" ", names(c.refColumns)] : "",
        ]),
        ...foreignKeyTail(c),
        ...tableAttrs(c),
      );
      break;
    case "exclude":
      body = phrase(
        words(
          kw("EXCLUDE"),
          c.using !== null ? `${kw("USING")} ${ident(c.using)}` : "",
          parenList(c.elements.map((el) => [indexElement(el.expr), " ", kw("WITH"), " ", el.operator])),
        ),
        ...indexParams(c),
        c.where !== undefined ? [kw("WHERE"), " ", parens(expr(c.where))] : "",
        ...deferral(c),
      );
      break;
  }
  return words(constraintName(name), body);
};

// --- table elements ---

/** `head constraint …`, a constraint per line when the whole doesn't fit. */
const withConstraints = (head: Doc, constraints: readonly ColConstraint[]): Doc =>
  constraints.length === 0 ? head : group([head, indent(constraints.map((c) => [line, columnConstraint(c)]))]);

const columnDef = (c: ColumnDef): Doc =>
  withConstraints(
    words(
      leadName(c.name),
      typeName(c.dataType),
      c.storage !== undefined ? `${kw("STORAGE")} ${kw(c.storage.toUpperCase())}` : "",
      c.compression !== undefined
        ? `${kw("COMPRESSION")} ${c.compression === "default" ? kw("DEFAULT") : ident(c.compression)}`
        : "",
      c.options !== undefined ? genericOptions(c.options) : "",
    ),
    c.constraints,
  );

const columnOptions = (c: ColumnOptions): Doc =>
  withConstraints(words(leadName(c.name), c.withOptions ? kw("WITH OPTIONS") : ""), c.constraints);

const tableItem = (item: TableItem): Doc => {
  switch (item.kind) {
    case "column":
      return columnDef(item);
    case "columnOptions":
      return columnOptions(item);
    case "likeTable":
      return words(
        kw("LIKE"),
        qualified(item.table),
        ...item.options.map((o) => kw(`${o.mode} ${o.property}`.toUpperCase())),
      );
    default:
      return tableConstraint(item);
  }
};

/** `(element, …)`: a table's columns, constraints and LIKE clauses. */
export const tableElements = (items: readonly TableItem[]): Doc => parenList(items.map(tableItem));

// --- partitioning ---

const rangeDatum = (d: PartitionRangeDatum): Doc =>
  d.kind === "minvalue" ? kw("MINVALUE") : d.kind === "maxvalue" ? kw("MAXVALUE") : expr(d as Expr);

/** `FOR VALUES …` or `DEFAULT`: what a partition holds. */
export const partitionBound = (b: PartitionBound): Doc => {
  switch (b.kind) {
    case "default":
      return kw("DEFAULT");
    case "list":
      return [kw("FOR VALUES IN"), " ", parenList(b.values.map(expr))];
    case "range":
      return [
        kw("FOR VALUES FROM"),
        " ",
        parenList(b.from.map(rangeDatum)),
        " ",
        kw("TO"),
        " ",
        parenList(b.to.map(rangeDatum)),
      ];
    case "hash":
      return [kw("FOR VALUES WITH"), ` (${kw("MODULUS")} ${b.modulus}, ${kw("REMAINDER")} ${b.remainder})`];
  }
};

const partitionKey = (k: PartitionKey): Doc =>
  words(
    element(k.expr),
    k.collate !== undefined ? `${kw("COLLATE")} ${collation(k.collate)}` : "",
    k.opclass !== undefined ? opclass(k.opclass) : "",
  );

const partitionBy = (p: PartitionSpec): Doc => [
  kw(`PARTITION BY ${p.strategy.toUpperCase()}`),
  " ",
  parenList(p.keys.map(partitionKey)),
];

// --- CREATE TABLE ---

const createHead = (modifiers: readonly string[] | undefined, ifNotExists: boolean, name: string[]): Doc =>
  words(
    kw("CREATE"),
    modifiers !== undefined ? kw(modifiers.join(" ").toUpperCase()) : "",
    kw("TABLE"),
    ifNotExists ? kw("IF NOT EXISTS") : "",
    qualified(name),
  );

type StorageClauses = Pick<CreateTable, "accessMethod" | "withoutOids" | "options" | "onCommit" | "tablespace">;

const ON_COMMIT = { preserveRows: "PRESERVE ROWS", deleteRows: "DELETE ROWS", drop: "DROP" } as const;

/** `[USING m] [WITH (…) | WITHOUT OIDS] [ON COMMIT …] [TABLESPACE t]`, in PG's fixed order. */
const storageClauses = (s: StorageClauses): Doc[] => [
  ...(s.accessMethod !== undefined ? [`${kw("USING")} ${ident(s.accessMethod)}`] : []),
  ...(s.options !== undefined ? [[kw("WITH"), " ", relationOptions(s.options)]] : []),
  ...(s.withoutOids ? [kw("WITHOUT OIDS")] : []),
  ...(s.onCommit !== undefined ? [kw(`ON COMMIT ${ON_COMMIT[s.onCommit]}`)] : []),
  ...(s.tablespace !== undefined ? [`${kw("TABLESPACE")} ${ident(s.tablespace)}`] : []),
];

/** A statement's head, then its clauses, each on a line of its own when the whole doesn't fit. */
const withClauses = (head: Doc, clauses: readonly Doc[]): Doc => group([head, ...clauses.map((c) => [line, c])]);

const createTable = (t: CreateTable): Doc => {
  const head: Doc[] = [createHead(t.modifiers, t.ifNotExists, t.name)];
  const items = t.items.length > 0 ? [" ", tableElements(t.items)] : "";
  if (t.partitionOf !== undefined) {
    head.push(" ", kw("PARTITION OF"), " ", qualified(t.partitionOf.parent), items);
  } else if (t.ofType !== undefined) {
    head.push(" ", kw("OF"), " ", qualified(t.ofType), items);
  } else {
    head.push(" ", tableElements(t.items));
  }
  const clauses: Doc[] = [];
  if (t.partitionOf !== undefined) clauses.push(partitionBound(t.partitionOf.bound));
  if (t.inherits !== undefined) clauses.push([kw("INHERITS"), " ", parenList(t.inherits.map(qualified))]);
  if (t.partitionBy !== undefined) clauses.push(partitionBy(t.partitionBy));
  clauses.push(...storageClauses(t));
  return withClauses(head, clauses);
};

const createTableAs = (t: CreateTableAs): Doc => {
  const head = [createHead(t.modifiers, t.ifNotExists, t.name), t.columns !== null ? [" ", names(t.columns)] : ""];
  let query = t.query.kind === "execute" ? statementPrinter.print(t.query) : printQuery(t.query);
  // A query ending in IS JSON would read the WITH of WITH [NO] DATA as its own
  // WITH UNIQUE, so it is parenthesised (the parentheses leave the tree as is).
  if (t.withData !== null && /(^|\s)(json|value|object|array|scalar)$/i.test(lastText(query))) query = parens(query);
  return withClauses(head, [
    ...storageClauses(t),
    clause(kw("AS"), query),
    ...(t.withData !== null ? [kw(t.withData ? "WITH DATA" : "WITH NO DATA")] : []),
  ]);
};

// --- CREATE INDEX ---

const indexColumn = (c: IndexColumn): Doc =>
  words(
    indexElement(c.expr),
    c.opclass !== undefined
      ? [opclass(c.opclass), c.opclassOptions !== undefined ? [" ", relationOptions(c.opclassOptions)] : ""]
      : "",
    c.dir !== undefined ? kw(c.dir.toUpperCase()) : "",
    c.nulls !== undefined ? kw(`NULLS ${c.nulls.toUpperCase()}`) : "",
  );

const createIndex = (i: CreateIndex): Doc => {
  const head = words(
    kw("CREATE"),
    i.unique ? kw("UNIQUE") : "",
    kw("INDEX"),
    i.concurrently ? kw("CONCURRENTLY") : "",
    i.ifNotExists ? kw("IF NOT EXISTS") : "",
    i.name !== null ? ident(i.name) : "",
    kw("ON"),
    i.only ? kw("ONLY") : "",
    qualified(i.table),
    i.using !== null ? `${kw("USING")} ${ident(i.using)}` : "",
    parenList(i.columns.map(indexColumn)),
  );
  const clauses: Doc[] = [];
  if (i.include !== null) clauses.push([kw("INCLUDE"), " ", names(i.include)]);
  if (i.nulls !== undefined) clauses.push(nullsTreatment(i.nulls));
  if (i.options !== undefined) clauses.push([kw("WITH"), " ", relationOptions(i.options)]);
  if (i.tablespace !== undefined) clauses.push(`${kw("TABLESPACE")} ${ident(i.tablespace)}`);
  if (i.where !== null) clauses.push(clause(kw("WHERE"), expr(i.where)));
  return withClauses(head, clauses);
};

// --- ALTER TABLE ---

const alterColumn = (column: string, rest: Doc): Doc => [kw("ALTER COLUMN"), " ", ident(column), " ", rest];

const statistics = (value: number | null): string =>
  value === null ? kw("DEFAULT") : (signedZero(value) ?? `${value}`);

const optionalIfExists = (ifExists: boolean | undefined): string => (ifExists ? ` ${kw("IF EXISTS")}` : "");

const alterAction = (a: AlterAction): Doc => {
  switch (a.kind) {
    case "addColumn":
      // COLUMN is always written: without it, a column named like a constraint
      // keyword (`"primary"`) would read as one.
      return [kw("ADD COLUMN"), a.ifNotExists ? ` ${kw("IF NOT EXISTS")}` : "", " ", columnDef(a.column)];
    case "dropColumn":
      return words(
        kw("DROP COLUMN"),
        a.ifExists ? kw("IF EXISTS") : "",
        ident(a.name),
        a.behavior !== undefined ? kw(a.behavior.toUpperCase()) : "",
      );
    case "addConstraint":
      return [kw("ADD"), " ", tableConstraint(a.constraint, a.name ?? a.constraint.name)];
    case "setDefault":
      return alterColumn(a.column, [kw("SET DEFAULT"), " ", expr(a.expr)]);
    case "dropDefault":
      return alterColumn(a.column, kw("DROP DEFAULT"));
    case "setNotNull":
      return alterColumn(a.column, kw("SET NOT NULL"));
    case "dropNotNull":
      return alterColumn(a.column, kw("DROP NOT NULL"));
    case "setDataType":
      return alterColumn(
        a.column,
        words(
          kw("TYPE"),
          typeName(a.dataType),
          a.collate !== undefined ? `${kw("COLLATE")} ${qualified(a.collate)}` : "",
          a.using !== undefined ? [kw("USING"), " ", expr(a.using)] : "",
        ),
      );
    case "setExpression":
      return alterColumn(a.column, [kw("SET EXPRESSION AS"), " ", parens(expr(a.expr))]);
    case "dropExpression":
      return alterColumn(a.column, `${kw("DROP EXPRESSION")}${optionalIfExists(a.ifExists)}`);
    case "addIdentity":
      return alterColumn(
        a.column,
        words(
          kw("ADD GENERATED"),
          generatedWhen(a.generated),
          kw("AS IDENTITY"),
          a.options !== undefined ? sequenceOptions(a.options) : "",
        ),
      );
    case "alterIdentity":
      return alterColumn(
        a.column,
        words(
          ...a.options.map((o) =>
            o.kind === "generated"
              ? `${kw("SET GENERATED")} ${generatedWhen(o.generated)}`
              : o.kind === "restart"
                ? sequenceOption(o)
                : [kw("SET"), " ", sequenceOption(o)],
          ),
        ),
      );
    case "dropIdentity":
      return alterColumn(a.column, `${kw("DROP IDENTITY")}${optionalIfExists(a.ifExists)}`);
    case "setStatistics":
      return alterColumn(a.column, `${kw("SET STATISTICS")} ${statistics(a.value)}`);
    case "setStorage":
      return alterColumn(a.column, `${kw("SET STORAGE")} ${kw((a.storage ?? "default").toUpperCase())}`);
    case "setCompression":
      return alterColumn(a.column, `${kw("SET COMPRESSION")} ${a.method === null ? kw("DEFAULT") : ident(a.method)}`);
    case "setColumnOptions":
      return alterColumn(a.column, [kw("SET"), " ", relationOptions(a.options)]);
    case "resetColumnOptions":
      return alterColumn(a.column, [kw("RESET"), " ", relationOptions(a.options)]);
    case "columnGenericOptions":
      return alterColumn(a.column, alterGenericOptions(a.options));
    case "genericOptions":
      return alterGenericOptions(a.options);
    case "alterConstraint":
      return words(kw("ALTER CONSTRAINT"), ident(a.name), ...deferral(a.attrs));
    case "renameColumn":
      return `${kw("RENAME COLUMN")} ${ident(a.from)} ${kw("TO")} ${ident(a.to)}`;
    case "renameConstraint":
      return `${kw("RENAME CONSTRAINT")} ${ident(a.from)} ${kw("TO")} ${ident(a.to)}`;
    case "renameTable":
      return renameTo(a.to);
    case "ownerTo":
      return ownerTo(a.owner);
    case "replicaIdentity":
      return a.mode === "usingIndex"
        ? `${kw("REPLICA IDENTITY USING INDEX")} ${ident(a.index!)}`
        : kw(`REPLICA IDENTITY ${a.mode.toUpperCase()}`);
    case "dropConstraint":
      return words(
        kw("DROP CONSTRAINT"),
        a.ifExists ? kw("IF EXISTS") : "",
        ident(a.name),
        a.behavior !== null ? kw(a.behavior.toUpperCase()) : "",
      );
    case "validateConstraint":
      return `${kw("VALIDATE CONSTRAINT")} ${ident(a.name)}`;
    case "setSchema":
      return setSchema(a.schema);
    case "setTablespace":
      return `${kw("SET TABLESPACE")} ${ident(a.tablespace)}`;
    case "setOptions":
      return [kw("SET"), " ", relationOptions(a.options)];
    case "resetOptions":
      return [kw("RESET"), " ", relationOptions(a.options)];
    case "enableTrigger":
      return words(
        kw("ENABLE"),
        a.mode !== null ? kw(a.mode.toUpperCase()) : "",
        kw("TRIGGER"),
        a.trigger.kind === "name" ? ident(a.trigger.name) : kw(a.trigger.kind.toUpperCase()),
      );
    case "disableTrigger":
      return words(
        kw("DISABLE TRIGGER"),
        a.trigger.kind === "name" ? ident(a.trigger.name) : kw(a.trigger.kind.toUpperCase()),
      );
    case "attachPartition":
      return [kw("ATTACH PARTITION"), " ", qualified(a.partition), " ", partitionBound(a.bound)];
    case "detachPartition":
      return words(kw("DETACH PARTITION"), qualified(a.partition), a.mode !== null ? kw(a.mode.toUpperCase()) : "");
    case "clusterOn":
      return `${kw("CLUSTER ON")} ${ident(a.index)}`;
    case "setWithoutCluster":
      return kw("SET WITHOUT CLUSTER");
    case "setWithoutOids":
      return kw("SET WITHOUT OIDS");
    case "setLogged":
      return kw("SET LOGGED");
    case "setUnlogged":
      return kw("SET UNLOGGED");
    case "setAccessMethod":
      return `${kw("SET ACCESS METHOD")} ${a.method === null ? kw("DEFAULT") : ident(a.method)}`;
    case "enableRule":
      return words(kw("ENABLE"), a.mode !== undefined ? kw(a.mode.toUpperCase()) : "", kw("RULE"), ident(a.rule));
    case "disableRule":
      return `${kw("DISABLE RULE")} ${ident(a.rule)}`;
    case "rowSecurity":
      return kw(`${ROW_SECURITY[a.action]} ROW LEVEL SECURITY`);
    case "inherit":
      return `${kw("INHERIT")} ${qualified(a.parent)}`;
    case "noInherit":
      return `${kw("NO INHERIT")} ${qualified(a.parent)}`;
    case "of":
      return `${kw("OF")} ${qualified(a.type)}`;
    case "notOf":
      return kw("NOT OF");
  }
};

const ROW_SECURITY = { enable: "ENABLE", disable: "DISABLE", force: "FORCE", noForce: "NO FORCE" } as const;

/** `head action, action, …`, the actions on the next lines when they don't fit. */
const actionList = (head: Doc, actions: readonly Doc[]): Doc => group([head, indent([line, commaList(actions)])]);

const alterTable = (t: AlterTable): Doc =>
  actionList(
    words(
      kw(t.foreign ? "ALTER FOREIGN TABLE" : "ALTER TABLE"),
      t.ifExists ? kw("IF EXISTS") : "",
      t.only ? kw("ONLY") : "",
      qualified(t.name),
    ),
    t.actions.map(alterAction),
  );

const alterIndexAction = (a: AlterIndexAction): Doc => {
  switch (a.kind) {
    case "rename":
      return renameTo(a.to);
    case "attachPartition":
      return `${kw("ATTACH PARTITION")} ${qualified(a.partition)}`;
    case "setStatistics":
      return `${kw("ALTER COLUMN")} ${a.column} ${kw("SET STATISTICS")} ${statistics(a.value)}`;
    default:
      return alterAction(a);
  }
};

const alterIndex = (i: AlterIndex): Doc =>
  actionList(
    words(kw("ALTER INDEX"), i.ifExists ? kw("IF EXISTS") : "", qualified(i.name)),
    i.actions.map(alterIndexAction),
  );

const alterAllInTablespace = (a: AlterAllInTablespace): Doc =>
  withClauses(
    [kw(`ALTER ${a.objectType.toUpperCase()} ALL IN TABLESPACE`), " ", ident(a.tablespace)],
    [
      ...(a.ownedBy !== undefined ? [clause(kw("OWNED BY"), commaList(a.ownedBy.map(roleSpec)))] : []),
      words(kw("SET TABLESPACE"), ident(a.newTablespace), a.nowait ? kw("NOWAIT") : ""),
    ],
  );

export const tablesFamily = defineFamily(
  "tables",
  {
    createTable,
    createTableAs,
    alterTable,
    alterAllInTablespace,
    createIndex,
    alterIndex,
  },
  [],
);
