// The DML, transaction and session statements: INSERT / UPDATE / DELETE /
// MERGE, COPY, TRUNCATE, transactions, SET / SHOW, PREPARE, cursors, EXPLAIN,
// maintenance and the rest.
import { type Doc, group, indent, join, line } from "@parser-kit/core/print";
import type {
  Assignment,
  Copy,
  Cte,
  CursorDirection,
  DefaultValue,
  Expr,
  Indirection,
  Insert,
  LockMode,
  MaintenanceTarget,
  MergeAction,
  MergeWhen,
  OnConflict,
  Preparable,
  RelationOption,
  SelectItem,
  Stmt,
  TransactionMode,
} from "../ast";
import {
  clause,
  commaList,
  firstText,
  functionQualified,
  ident,
  isColNameKeyword,
  kw,
  parenList,
  parens,
  qualified,
  quoted,
  str,
} from "./context";
import { expr } from "./expr";
import { aliasClause, printFrom, printQuery, selectItems, withClause } from "./query";
import { defineFamily, statementPrinter } from "./registry";
import { type OptionStyle, partitionKey, relationOptions } from "./shared";
import { typeName } from "./types";

// --- shared pieces ---

/** A query or a data-modifying statement: what PREPARE, EXPLAIN and COPY (…) take. */
const preparable = (s: Preparable): Doc => statementPrinter.print(s);

/** A statement's parts, one per line when they don't fit on one. */
const statement = (parts: readonly Doc[]): Doc =>
  group(
    join(
      line,
      parts.filter((p) => p !== ""),
    ),
  );

const withPrefix = (ctes: Cte[] | undefined, recursive: boolean | undefined): Doc =>
  ctes !== undefined && ctes !== null ? withClause(ctes, recursive) : "";

const returning = (items: SelectItem[] | null): Doc =>
  items !== null ? clause(kw("RETURNING"), selectItems(items)) : "";

const where = (e: Expr | null): Doc => (e !== null ? clause(kw("WHERE"), expr(e)) : "");

// `WHERE cond` or `WHERE CURRENT OF cursor`.
const whereOrCurrent = (e: Expr | null, currentOf: string | undefined): Doc =>
  currentOf !== undefined ? [kw("WHERE CURRENT OF"), " ", ident(currentOf)] : where(e);

// `[ONLY] name`: PG's relation_expr.
const relation = (name: string[], only: boolean | undefined): Doc =>
  only ? [kw("ONLY"), " ", qualified(name)] : qualified(name);

// The utility statements' parenthesised options: `(ANALYZE, FORMAT json)`.
const UTILITY: OptionStyle = { eq: false, keywords: true, reservedNames: false, reservedValues: false };
// COPY's option names are PG's ColLabel (`NULL ''`).
const COPY: OptionStyle = { ...UTILITY, reservedNames: true };
const utilityOptions = (options: readonly RelationOption[]): Doc =>
  options.length > 0 ? [" ", relationOptions(options, UTILITY)] : "";

// --- assignment targets and values ---

// `.field` and `[i]` / `[lo:hi]` steps after an assigned or inserted column.
const indirection = (steps: Indirection | undefined): Doc =>
  steps === undefined
    ? ""
    : steps.map((s) =>
        s.kind === "field"
          ? [".", ident(s.name)]
          : [
              "[",
              s.index === null ? "" : expr(s.index),
              s.upper === undefined ? "" : [":", s.upper === null ? "" : expr(s.upper)],
              "]",
            ],
      );

const target = (column: string, steps: Indirection | undefined): Doc => [ident(column), indirection(steps)];

// `(a, b[1], c.f)`: INSERT's column list.
const targetList = (columns: string[], steps: Indirection[] | undefined): Doc =>
  parenList(columns.map((c, i) => target(c, steps?.[i])));

const item = (e: Expr | DefaultValue): Doc => (e.kind === "default" ? kw("DEFAULT") : expr(e));

const assignment = (a: Assignment): Doc => {
  if ("column" in a) return [target(a.column, a.indirection), " = ", item(a.value)];
  const v = a.value;
  // A row source is `(1, DEFAULT)` or `ROW(1, DEFAULT)`; a subquery prints its own parentheses.
  const source: Doc =
    v.kind === "row"
      ? [v.implicit ? "" : kw("ROW"), parenList((v.items as (Expr | DefaultValue)[]).map(item))]
      : expr(v);
  return [targetList(a.columns, a.indirection), " = ", source];
};

const setClause = (set: Assignment[]): Doc => clause(kw("SET"), commaList(set.map(assignment)));

// --- INSERT ---

const OVERRIDING = { system: "OVERRIDING SYSTEM VALUE", user: "OVERRIDING USER VALUE" } as const;

const valuesRows = (rows: (Expr | DefaultValue)[][]): Doc =>
  clause(kw("VALUES"), commaList(rows.map((row) => parenList(row.map(item)))));

// INSERT's source. A query opening with VALUES is parenthesised: bare, the
// grammar reads it as INSERT's own VALUES rows.
const insertSource = (source: Insert["source"]): Doc => {
  switch (source.kind) {
    case "values":
      return valuesRows(source.rows);
    case "defaultValues":
      return kw("DEFAULT VALUES");
    case "select": {
      const doc = printQuery(source.query);
      return firstText(doc).toLowerCase() === "values" ? parens(doc) : doc;
    }
  }
};

const onConflict = (c: OnConflict): Doc => {
  const arbiter: Doc[] = [];
  if (c.target !== null) arbiter.push([" ", parenList(c.target.map(ident))]);
  if (c.constraint !== undefined) arbiter.push([" ", kw("ON CONSTRAINT"), " ", ident(c.constraint)]);
  if (c.inference !== undefined) {
    arbiter.push([" ", parenList(c.inference.elements.map(partitionKey))]);
    if (c.inference.where !== undefined) arbiter.push(indent([line, where(c.inference.where)]));
  }
  const action =
    c.action.kind === "nothing"
      ? kw("DO NOTHING")
      : statement([[kw("DO UPDATE"), " ", setClause(c.action.set)], where(c.action.where)]);
  return group([kw("ON CONFLICT"), arbiter, indent([line, action])]);
};

// --- MERGE ---

const MATCH = {
  matched: "WHEN MATCHED",
  notMatched: "WHEN NOT MATCHED",
  notMatchedBySource: "WHEN NOT MATCHED BY SOURCE",
} as const;

const mergeAction = (a: MergeAction): Doc => {
  switch (a.kind) {
    case "update":
      return [kw("UPDATE"), " ", setClause(a.set)];
    case "delete":
      return kw("DELETE");
    case "nothing":
      return kw("DO NOTHING");
    case "insert":
      return statement([
        kw("INSERT"),
        a.columns !== null ? targetList(a.columns, a.indirection) : "",
        a.overriding !== undefined ? kw(OVERRIDING[a.overriding]) : "",
        a.source.kind === "values" ? valuesRows(a.source.rows) : kw("DEFAULT VALUES"),
      ]);
  }
};

const mergeWhen = (w: MergeWhen): Doc =>
  group([
    kw(MATCH[w.match]),
    w.condition !== null ? [" ", kw("AND"), " ", expr(w.condition)] : "",
    " ",
    kw("THEN"),
    indent([line, mergeAction(w.action)]),
  ]);

// --- COPY ---

// The pre-9.0 bare-word spelling of one option, as the parser maps it onto the
// parenthesised list's names, or null when the option has none.
const legacyCopyOption = (o: RelationOption): Doc | null => {
  if (o.namespace !== undefined) return null;
  const v = o.value;
  const names = (): Doc | null => {
    if (v?.kind === "star") return "*";
    if (v?.kind !== "optionList" || !v.items.every((i) => i.kind === "name")) return null;
    return group(commaList(v.items.map((i) => ident((i as { parts: string[] }).parts[0]!))));
  };
  switch (o.name) {
    case "format":
      return v?.kind === "name" && (v.parts[0] === "binary" || v.parts[0] === "csv")
        ? kw(v.parts[0].toUpperCase())
        : null;
    case "freeze":
    case "header":
      return v === null ? kw(o.name.toUpperCase()) : null;
    case "delimiter":
    case "null":
    case "quote":
    case "escape":
    case "encoding":
      return v?.kind === "string" ? [kw(o.name.toUpperCase()), " ", str(v.value)] : null;
    case "force_quote":
    case "force_not_null":
    case "force_null": {
      const columns = names();
      const words = { force_quote: "FORCE QUOTE", force_not_null: "FORCE NOT NULL", force_null: "FORCE NULL" };
      return columns !== null ? [kw(words[o.name]), " ", columns] : null;
    }
    default:
      return null;
  }
};

const isFormatBinary = (o: RelationOption | undefined): boolean =>
  o !== undefined &&
  o.namespace === undefined &&
  o.name === "format" &&
  o.value?.kind === "name" &&
  o.value.parts[0] === "binary";
const isDelimiter = (o: RelationOption | undefined): boolean =>
  o !== undefined && o.namespace === undefined && o.name === "delimiter" && o.value?.kind === "string";

// COPY's options: `WITH (option, …)`, or under `legacy` PG's pre-9.0 spelling,
// which the tree records by its flag alone. The legacy options are written as
// bare words where each has one; otherwise the BINARY prefix and USING
// DELIMITERS take what they can from the front, which still marks the
// statement legacy, and the rest goes in the list.
const copyOptions = (c: Copy): { prefix: Doc; delimiters: Doc; options: Doc } => {
  const options = c.options ?? [];
  const list = (opts: readonly RelationOption[]): Doc =>
    opts.length > 0 ? [kw("WITH"), " ", relationOptions(opts, COPY)] : "";
  if (c.legacy !== true) return { prefix: "", delimiters: "", options: list(options) };
  const words = (opts: readonly RelationOption[]): Doc[] | null => {
    const out: Doc[] = [];
    for (const o of opts) {
      const doc = legacyCopyOption(o);
      if (doc === null) return null;
      out.push(doc);
    }
    return out;
  };
  const all = words(options);
  if (all !== null) return { prefix: "", delimiters: "", options: all.length > 0 ? join(" ", all) : kw("WITH") };
  const binary = c.table !== null && isFormatBinary(options[0]);
  const delimiter = options[binary ? 1 : 0];
  const using = c.table !== null && isDelimiter(delimiter);
  const prefix = binary ? kw("BINARY") : "";
  const delimiters = using ? [kw("USING DELIMITERS"), " ", str((delimiter!.value as { value: string }).value)] : "";
  const i = (binary ? 1 : 0) + (using ? 1 : 0);
  const rest = options.slice(i);
  const restWords = words(rest);
  return { prefix, delimiters, options: restWords !== null ? join(" ", restWords) : list(rest) };
};

const copy = (c: Copy): Doc => {
  const { prefix, delimiters, options } = copyOptions(c);
  const location =
    c.location.kind === "file"
      ? str(c.location.path)
      : c.location.kind === "program"
        ? [kw("PROGRAM"), " ", str(c.location.command)]
        : kw(c.location.kind === "stdin" ? "STDIN" : "STDOUT");
  const source: Doc =
    c.query !== null
      ? parens(preparable(c.query))
      : [qualified(c.table!), c.columns !== null ? [" ", parenList(c.columns.map(ident))] : ""];
  return statement([
    [kw("COPY"), " ", prefix === "" ? "" : [prefix, " "], source],
    [kw(c.direction === "from" ? "FROM" : "TO"), " ", location],
    delimiters,
    options,
    where(c.where),
  ]);
};

// --- transactions and session ---

const ISOLATION = {
  serializable: "SERIALIZABLE",
  repeatableRead: "REPEATABLE READ",
  readCommitted: "READ COMMITTED",
  readUncommitted: "READ UNCOMMITTED",
} as const;

const transactionMode = (m: TransactionMode): string => {
  switch (m.kind) {
    case "isolation":
      return kw(`ISOLATION LEVEL ${ISOLATION[m.level]}`);
    case "readWrite":
      return kw(m.value ? "READ WRITE" : "READ ONLY");
    case "deferrable":
      return kw(m.value ? "DEFERRABLE" : "NOT DEFERRABLE");
  }
};

const modes = (list: TransactionMode[]): Doc =>
  list.length > 0 ? group(indent([line, commaList(list.map(transactionMode))])) : "";

const chain = (c: boolean): string => (c ? ` ${kw("AND CHAIN")}` : "");

const scope = (s: "session" | "local" | null): string =>
  s === "session" ? `${kw("SESSION")} ` : s === "local" ? `${kw("LOCAL")} ` : "";

// The multi-word targets SHOW, RESET and SET name as one name part.
const CONFIG_FORMS: Record<string, string> = {
  "time zone": "TIME ZONE",
  "transaction isolation level": "TRANSACTION ISOLATION LEVEL",
  "session authorization": "SESSION AUTHORIZATION",
};

// SHOW and RESET's target: ALL, a multi-word form, or a dotted parameter name.
const configTarget = (name: string[]): Doc => {
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

const setStmt = (s: Extract<Stmt, { kind: "set" }>): Doc => {
  const head = [kw("SET"), " ", scope(s.scope)];
  const special = s.name.length === 1 ? SPECIAL_SET[s.name[0]!] : undefined;
  if (special !== undefined) {
    if (s.values === "default" && special.byDefault) return [head, kw(special.words), " ", kw("DEFAULT")];
    if (Array.isArray(s.values) && s.values.length === 1 && special.one(s.values[0]!)) {
      const v = s.values[0]!;
      const word = s.name[0] === "time zone" ? "zone" : s.name[0] === "xml option" ? "value" : "word";
      return [
        head,
        kw(special.words),
        " ",
        s.name[0] === "xml option" ? kw((v as { parts: string[] }).parts[0]!.toUpperCase()) : configValue(v, word),
      ];
    }
  }
  const name = qualified(s.name);
  if (s.values === "fromCurrent") return [head, name, " ", kw("FROM CURRENT")];
  if (s.values === "default") return [head, name, " ", kw("TO DEFAULT")];
  return group([head, name, " ", kw("TO"), indent([line, commaList(s.values.map((v) => configValue(v, "value")))])]);
};

// --- cursors ---

const direction = (d: CursorDirection): string => {
  switch (d.kind) {
    case "next":
    case "prior":
    case "first":
    case "last":
    case "all":
      return kw(d.kind.toUpperCase());
    case "absolute":
    case "relative":
      return `${kw(d.kind.toUpperCase())} ${d.count}`;
    case "count":
      return String(d.count);
    case "forward":
    case "backward":
      return d.count === null
        ? kw(d.kind.toUpperCase())
        : `${kw(d.kind.toUpperCase())} ${d.count === "all" ? kw("ALL") : d.count}`;
  }
};

const fetchOrMove = (s: Extract<Stmt, { kind: "fetch" | "move" }>): Doc => [
  kw(s.kind === "fetch" ? "FETCH" : "MOVE"),
  " ",
  s.direction !== null ? `${direction(s.direction)} ` : "",
  kw("FROM"),
  " ",
  ident(s.cursor),
];

// --- maintenance ---

const targets = (tables: MaintenanceTarget[]): Doc =>
  tables.length > 0
    ? group(
        indent([
          line,
          commaList(
            tables.map((t) => [qualified(t.name), t.columns !== null ? [" ", parenList(t.columns.map(ident))] : ""]),
          ),
        ]),
      )
    : "";

const LOCK_MODES: Record<LockMode, string> = {
  accessShare: "ACCESS SHARE",
  rowShare: "ROW SHARE",
  rowExclusive: "ROW EXCLUSIVE",
  shareUpdateExclusive: "SHARE UPDATE EXCLUSIVE",
  share: "SHARE",
  shareRowExclusive: "SHARE ROW EXCLUSIVE",
  exclusive: "EXCLUSIVE",
  accessExclusive: "ACCESS EXCLUSIVE",
};

const isVerboseFlag = (options: readonly RelationOption[]): boolean =>
  options.length === 1 &&
  options[0]!.name === "verbose" &&
  options[0]!.value === null &&
  options[0]!.namespace === undefined;

const DISCARD = { all: "ALL", plans: "PLANS", sequences: "SEQUENCES", temp: "TEMP" } as const;
const REINDEX = { index: "INDEX", table: "TABLE", schema: "SCHEMA", database: "DATABASE", system: "SYSTEM" } as const;

export const dmlFamily = defineFamily(
  "dml",
  {
    insert: (s) =>
      statement([
        withPrefix(s.with_, s.recursive),
        [
          kw("INSERT INTO"),
          " ",
          qualified(s.table),
          s.alias !== undefined ? [" ", kw("AS"), " ", ident(s.alias)] : "",
          s.columns !== null ? [" ", targetList(s.columns, s.indirection)] : "",
        ],
        s.overriding !== undefined ? kw(OVERRIDING[s.overriding]) : "",
        insertSource(s.source),
        s.onConflict !== null ? onConflict(s.onConflict) : "",
        returning(s.returning),
      ]),
    update: (s) =>
      statement([
        withPrefix(s.with_, s.recursive),
        [kw("UPDATE"), " ", relation(s.table, s.only), aliasClause(s.alias)],
        setClause(s.set),
        s.from !== null ? clause(kw("FROM"), commaList(s.from.map(printFrom))) : "",
        whereOrCurrent(s.where, s.currentOf),
        returning(s.returning),
      ]),
    delete: (s) =>
      statement([
        withPrefix(s.with_, s.recursive),
        [kw("DELETE FROM"), " ", relation(s.table, s.only), aliasClause(s.alias)],
        s.using !== null ? clause(kw("USING"), commaList(s.using.map(printFrom))) : "",
        whereOrCurrent(s.where, s.currentOf),
        returning(s.returning),
      ]),
    merge: (s) =>
      statement([
        withPrefix(s.with_, s.recursive),
        [kw("MERGE INTO"), " ", relation(s.table, s.only), aliasClause(s.alias)],
        clause(kw("USING"), printFrom(s.source)),
        clause(kw("ON"), expr(s.on)),
        ...s.when.map(mergeWhen),
        returning(s.returning),
      ]),
    copy,
    truncate: (s) =>
      statement([
        clause(kw("TRUNCATE TABLE"), commaList(s.names.map((n, i) => relation(n, s.only?.[i])))),
        s.identity !== null ? kw(s.identity === "restart" ? "RESTART IDENTITY" : "CONTINUE IDENTITY") : "",
        s.behavior !== null ? kw(s.behavior === "cascade" ? "CASCADE" : "RESTRICT") : "",
      ]),
    begin: (s) => [kw(s.start ? "START TRANSACTION" : "BEGIN"), modes(s.modes)],
    commit: (s) => [kw("COMMIT"), chain(s.chain)],
    rollback: (s) =>
      s.savepoint !== null ? [kw("ROLLBACK TO SAVEPOINT"), " ", ident(s.savepoint)] : [kw("ROLLBACK"), chain(s.chain)],
    savepoint: (s) => [kw("SAVEPOINT"), " ", ident(s.name)],
    releaseSavepoint: (s) => [kw("RELEASE SAVEPOINT"), " ", ident(s.name)],
    prepareTransaction: (s) => [kw("PREPARE TRANSACTION"), " ", str(s.gid)],
    commitPrepared: (s) => [kw("COMMIT PREPARED"), " ", str(s.gid)],
    rollbackPrepared: (s) => [kw("ROLLBACK PREPARED"), " ", str(s.gid)],
    set: setStmt,
    setTransaction: (s) => [
      kw("SET"),
      " ",
      scope(s.scope),
      kw(s.characteristics ? "SESSION CHARACTERISTICS AS TRANSACTION" : "TRANSACTION"),
      modes(s.modes),
    ],
    setConstraints: (s) => [
      kw("SET CONSTRAINTS"),
      " ",
      s.constraints === "all" ? kw("ALL") : group(commaList(s.constraints.map(qualified))),
      " ",
      kw(s.mode === "deferred" ? "DEFERRED" : "IMMEDIATE"),
    ],
    show: (s) => [kw("SHOW"), " ", configTarget(s.name)],
    reset: (s) => [kw("RESET"), " ", configTarget(s.name)],
    do: (s) => [kw("DO"), s.language !== null ? [" ", kw("LANGUAGE"), " ", ident(s.language)] : "", " ", str(s.body)],
    deallocate: (s) => [kw("DEALLOCATE PREPARE"), " ", s.name !== null ? ident(s.name) : kw("ALL")],
    prepare: (s) =>
      group([
        kw("PREPARE"),
        " ",
        ident(s.name),
        s.types !== null ? [" ", parenList(s.types.map((t) => typeName(t)))] : "",
        " ",
        kw("AS"),
        indent([line, preparable(s.query)]),
      ]),
    execute: (s) => [kw("EXECUTE"), " ", ident(s.name), s.args !== null ? parenList(s.args.map(expr)) : ""],
    explain: (s) =>
      group([kw("EXPLAIN"), utilityOptions(s.options), indent([line, statementPrinter.print(s.statement)])]),
    analyze: (s) => [kw("ANALYZE"), utilityOptions(s.options), targets(s.tables)],
    vacuum: (s) => [kw("VACUUM"), utilityOptions(s.options), targets(s.tables)],
    cluster: (s) => [
      kw("CLUSTER"),
      // `CLUSTER (VERBOSE)` with no table is PG 17's; the flag is older.
      s.table === undefined && isVerboseFlag(s.options) ? ` ${kw("VERBOSE")}` : utilityOptions(s.options),
      s.table !== undefined ? [" ", qualified(s.table)] : "",
      s.index !== undefined ? [" ", kw("USING"), " ", ident(s.index)] : "",
    ],
    reindex: (s) => [
      kw("REINDEX"),
      utilityOptions(s.options),
      " ",
      kw(REINDEX[s.target]),
      s.concurrently ? ` ${kw("CONCURRENTLY")}` : "",
      s.name !== undefined ? [" ", qualified(s.name)] : "",
    ],
    checkpoint: () => kw("CHECKPOINT"),
    load: (s) => [kw("LOAD"), " ", str(s.file)],
    discard: (s) => [kw("DISCARD"), " ", kw(DISCARD[s.target])],
    listen: (s) => [kw("LISTEN"), " ", ident(s.channel)],
    notify: (s) => [kw("NOTIFY"), " ", ident(s.channel), s.payload !== undefined ? [", ", str(s.payload)] : ""],
    unlisten: (s) => [kw("UNLISTEN"), " ", s.channel !== null ? ident(s.channel) : "*"],
    lock: (s) =>
      statement([
        clause(kw("LOCK TABLE"), commaList(s.tables.map((t) => relation(t.name, t.only)))),
        s.mode !== null ? [kw("IN"), " ", kw(LOCK_MODES[s.mode]), " ", kw("MODE")] : "",
        s.nowait ? kw("NOWAIT") : "",
      ]),
    // PG's func_name: a one-part name is no col_name keyword (`CALL "coalesce"()`).
    callProcedure: (s) => [
      kw("CALL"),
      " ",
      s.name.length === 1 && isColNameKeyword(s.name[0]!) ? quoted(s.name[0]!) : functionQualified(s.name),
      parenList(
        s.args.map((a, i) => (s.variadic && i === s.args.length - 1 ? [kw("VARIADIC"), " ", expr(a)] : expr(a))),
      ),
    ],
    declare: (s) =>
      group([
        kw("DECLARE"),
        " ",
        ident(s.name),
        s.binary ? ` ${kw("BINARY")}` : "",
        s.sensitivity !== null ? ` ${kw(s.sensitivity.toUpperCase())}` : "",
        s.scroll === true ? ` ${kw("SCROLL")}` : s.scroll === false ? ` ${kw("NO SCROLL")}` : "",
        " ",
        kw("CURSOR"),
        s.hold === true ? ` ${kw("WITH HOLD")}` : s.hold === false ? ` ${kw("WITHOUT HOLD")}` : "",
        " ",
        kw("FOR"),
        indent([line, printQuery(s.query)]),
      ]),
    fetch: fetchOrMove,
    move: fetchOrMove,
    close: (s) => [kw("CLOSE"), " ", s.name !== null ? ident(s.name) : kw("ALL")],
  },
  [],
);
