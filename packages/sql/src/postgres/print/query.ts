// Queries: SELECT, VALUES, TABLE and set operations, with their WITH and
// ORDER BY / LIMIT / OFFSET / FETCH / locking tails, and every FROM item.
import { type Doc, definePrinter, group, indent, join, line, type NodePrinter } from "@parser-kit/core/print";
import type {
  ColumnDefinition,
  Cte,
  Expr,
  FromItem,
  GroupByItem,
  JsonTableColumn,
  LockingClause,
  Query,
  SelectItem,
  SelectStmt,
  SetOpKind,
  TableSample,
  XmlNamespace,
  XmlTableColumn,
} from "../ast";
import {
  bareIdent,
  clause,
  commaList,
  firstChar,
  ident,
  kw,
  parenList,
  parens,
  qualified,
  statementPrinter,
  str,
} from "./context";
import {
  atomic,
  bExpr,
  expr,
  exprKey,
  jsonBehavior,
  jsonFormat,
  jsonPassing,
  jsonQuotes,
  jsonValue,
  jsonWrapper,
  orderBy,
  printExpr,
  windowSpec,
  xmlPassing,
} from "./expr";
import { typeName } from "./types";

// --- names and aliases ---

/** ` AS alias (a, b)`, or nothing. AS is always written: a keyword alias needs it. */
const aliasClause = (alias: string | null | undefined, columns?: string[]): Doc =>
  alias === null || alias === undefined
    ? ""
    : columns === undefined
      ? ` ${kw("AS")} ${ident(alias)}`
      : [` ${kw("AS")} ${ident(alias)} `, parenList(columns.map(ident))];

const selectItem = (i: SelectItem): Doc =>
  i.expr.kind === "star" && i.expr.table === null
    ? "*"
    : i.alias !== null
      ? [expr(i.expr), ` ${kw("AS")} ${ident(i.alias)}`]
      : expr(i.expr);

/** A RETURNING-shaped list: what a SELECT list holds. */
export const selectItems = (items: readonly SelectItem[]): Doc => commaList(items.map(selectItem));

// --- WITH ---

const cte = (c: Cte): Doc => [
  ident(c.name),
  c.columns !== null ? [" ", parenList(c.columns.map(ident))] : "",
  " ",
  kw("AS"),
  " ",
  c.materialized === true ? `${kw("MATERIALIZED")} ` : c.materialized === false ? `${kw("NOT MATERIALIZED")} ` : "",
  parens(statementPrinter.print(c.query)),
  c.search !== undefined
    ? [
        line,
        kw("SEARCH"),
        " ",
        kw(c.search.order === "depth" ? "DEPTH FIRST BY" : "BREADTH FIRST BY"),
        " ",
        commaList(c.search.by.map(ident)),
        " ",
        kw("SET"),
        " ",
        ident(c.search.set),
      ]
    : "",
  c.cycle !== undefined
    ? [
        line,
        kw("CYCLE"),
        " ",
        commaList(c.cycle.columns.map(ident)),
        " ",
        kw("SET"),
        " ",
        ident(c.cycle.set),
        c.cycle.mark !== null
          ? [" ", kw("TO"), " ", expr(c.cycle.mark.to), " ", kw("DEFAULT"), " ", expr(c.cycle.mark.default)]
          : "",
        " ",
        kw("USING"),
        " ",
        ident(c.cycle.using),
      ]
    : "",
];

/** `WITH [RECURSIVE] a AS (…), b AS (…)`. */
export const withClause = (ctes: readonly Cte[], recursive: boolean | undefined): Doc =>
  clause(recursive ? kw("WITH RECURSIVE") : kw("WITH"), commaList(ctes.map(cte)));

// --- queries ---

const hasWith = (q: Query): boolean => q.with_ !== null && q.with_ !== undefined;
const hasTail = (q: Query): boolean => q.orderBy != null || q.limit != null || q.offset != null || q.locking != null;

// The grammar puts a WITH written over a set operation on its leftmost arm
// (see attachWith), reaching through any parenthesised arm on the way. So a
// leftmost arm's WITH is written at the front of the whole query, where it
// came from, unless some set operation on the way down has a WITH of its own.
const hoistedWith = (q: Query): Query | null => {
  let node = q;
  while (node.kind === "setOp") {
    if (hasWith(node)) return null;
    node = node.left;
  }
  return node !== q && hasWith(node) ? node : null;
};

const LEVEL: Record<SetOpKind, number> = {
  union: 1,
  unionAll: 1,
  except: 1,
  exceptAll: 1,
  intersect: 2,
  intersectAll: 2,
};
const SET_OPS: Record<SetOpKind, string> = {
  union: "UNION",
  unionAll: "UNION ALL",
  except: "EXCEPT",
  exceptAll: "EXCEPT ALL",
  intersect: "INTERSECT",
  intersectAll: "INTERSECT ALL",
};

/**
 * A query, WITH and tail included. `hoisted` is a leftmost arm whose WITH an
 * enclosing query has already written, when `q` is on the way down to it.
 */
export const printQuery = (q: Query, hoisted: Query | null = null): Doc => {
  const parts: Doc[] = [];
  let skip = hoisted;
  if (hasWith(q)) {
    if (q !== hoisted) parts.push(withClause(q.with_!, q.recursive));
  } else if (hoisted === null) {
    skip = hoistedWith(q);
    if (skip !== null) parts.push(withClause(skip.with_!, skip.recursive));
  }
  body(q, skip, parts);
  tail(q, parts);
  return group(join(line, parts));
};

// The clauses of a query without its WITH and tail, appended to `parts`.
const body = (q: Query, hoisted: Query | null, parts: Doc[]): void => {
  switch (q.kind) {
    case "select":
      selectBody(q, parts);
      return;
    case "values":
      parts.push(clause(kw("VALUES"), commaList(q.rows.map((row) => parenList(row.map(expr))))));
      return;
    case "tableCmd":
      parts.push([kw("TABLE"), " ", q.only ? `${kw("ONLY")} ` : "", qualified(q.name)]);
      return;
    case "setOp": {
      const level = LEVEL[q.op];
      arm(q.left, hoisted, (a) => a.kind === "setOp" && LEVEL[a.op] < level, parts);
      parts.push(kw(SET_OPS[q.op]));
      arm(q.right, null, (a) => a.kind === "setOp" && LEVEL[a.op] <= level, parts);
      return;
    }
  }
};

// A set-operation arm, parenthesised when it has a WITH or a tail of its own
// (which would otherwise belong to the whole query) or binds looser than the
// set operation it is in.
const arm = (a: Query, hoisted: Query | null, looser: (a: Query) => boolean, parts: Doc[]): void => {
  if (hasTail(a) || (hasWith(a) && a !== hoisted) || looser(a)) {
    parts.push(parens(printQuery(a, hoisted)));
  } else {
    body(a, hoisted, parts);
  }
};

const selectBody = (q: SelectStmt, parts: Doc[]): void => {
  const head =
    q.distinct === false
      ? kw("SELECT")
      : q.distinct === true
        ? kw("SELECT DISTINCT")
        : [kw("SELECT DISTINCT ON"), " ", parenList(q.distinct.map(expr))];
  parts.push(q.columns.length === 0 ? head : clause(head, selectItems(q.columns)));
  if (q.into !== undefined) {
    const modifiers = q.into.modifiers?.map((m) => `${kw(m.toUpperCase())} `) ?? [];
    parts.push([kw("INTO"), " ", modifiers, qualified(q.into.name)]);
  }
  if (q.from !== null) parts.push(clause(kw("FROM"), commaList(q.from.map(printFrom))));
  if (q.where !== null) parts.push(clause(kw("WHERE"), expr(q.where)));
  if (q.groupBy !== null) {
    parts.push(
      clause(q.groupByDistinct ? kw("GROUP BY DISTINCT") : kw("GROUP BY"), commaList(q.groupBy.map(groupByItem))),
    );
  }
  if (q.having !== null) parts.push(clause(kw("HAVING"), expr(q.having)));
  if (q.window !== null) {
    parts.push(
      clause(kw("WINDOW"), commaList(q.window.map((w) => [ident(w.name), " ", kw("AS"), " ", windowSpec(w.spec)]))),
    );
  }
};

const GROUPINGS = { rollup: "ROLLUP", cube: "CUBE" } as const;

const groupByItem = (g: GroupByItem): Doc => {
  switch (g.kind) {
    case "rollup":
    case "cube":
      return [kw(GROUPINGS[g.kind]), " ", parenList(g.args.map(grouping))];
    case "groupingSets":
      return [kw("GROUPING SETS"), " ", parenList(g.sets.map(grouping))];
    case "emptyGrouping":
      return "()";
    default: {
      // A call named like the ROLLUP / CUBE constructs would read as one.
      const named = g.kind === "call" && g.name.length === 1 && (g.name[0] === "rollup" || g.name[0] === "cube");
      return named ? ["(", expr(g), ")"] : expr(g);
    }
  }
};

// One grouping inside ROLLUP / CUBE / GROUPING SETS: `a`, `(a, b)` or `()`. A
// lone expression that itself opens with `(` is parenthesised once more, or
// its own parentheses would read as the grouping's.
const grouping = (exprs: Expr[]): Doc => {
  if (exprs.length !== 1) return parenList(exprs.map(expr));
  const doc = expr(exprs[0]!);
  return firstChar(doc) === "(" ? ["(", doc, ")"] : doc;
};

// --- the tail ---

const STRENGTHS = {
  update: "FOR UPDATE",
  noKeyUpdate: "FOR NO KEY UPDATE",
  share: "FOR SHARE",
  keyShare: "FOR KEY SHARE",
} as const;

const locking = (l: LockingClause): Doc => [
  kw(STRENGTHS[l.strength]),
  l.of.length > 0 ? [" ", kw("OF"), " ", commaList(l.of.map(qualified))] : "",
  l.wait === "nowait" ? ` ${kw("NOWAIT")}` : l.wait === "skipLocked" ? ` ${kw("SKIP LOCKED")}` : "",
];

// A FETCH count is PG's select_fetch_first_value, a c_expr or a signed
// constant: anything else is parenthesised.
const fetchCount = (e: Expr): Doc => (exprKey(e) === null ? expr(e) : ["(", expr(e), ")"]);

// LIMIT n OFFSET m, or the standard OFFSET m FETCH FIRST n ROWS … when the
// limit needs the FETCH spelling (WITH TIES, or the count-less ROW ONLY).
const tail = (q: Query, parts: Doc[]): void => {
  if (q.orderBy != null) parts.push(orderBy(q.orderBy));
  const offset = q.offset != null ? clause(kw("OFFSET"), expr(q.offset)) : null;
  if (q.limit != null) {
    const implicit = q.limit.kind === "number" && q.limit.implicit === true;
    if (q.withTies || implicit) {
      if (offset !== null) parts.push(offset);
      parts.push([
        kw("FETCH FIRST"),
        " ",
        implicit ? "" : [fetchCount(q.limit), " "],
        kw(implicit ? "ROW" : "ROWS"),
        " ",
        kw(q.withTies ? "WITH TIES" : "ONLY"),
      ]);
    } else {
      parts.push(clause(kw("LIMIT"), expr(q.limit)));
      if (offset !== null) parts.push(offset);
    }
  } else if (offset !== null) {
    parts.push(offset);
  }
  if (q.locking != null) for (const l of q.locking) parts.push(locking(l));
};

// --- FROM items ---

const columnDefinition = (d: ColumnDefinition): Doc => [
  ident(d.name),
  " ",
  typeName(d.type),
  d.collate !== undefined ? [" ", kw("COLLATE"), " ", qualified(d.collate)] : "",
];

// PG's func_alias_clause: an alias clause, or a column definition list with or
// without an alias.
const funcAlias = (
  alias: string | null,
  columns: string[] | undefined,
  definitions: ColumnDefinition[] | undefined,
): Doc =>
  definitions === undefined
    ? aliasClause(alias, columns)
    : [" ", kw("AS"), " ", alias !== null ? [ident(alias), " "] : "", parenList(definitions.map(columnDefinition))];

const lateral = (l: boolean | undefined): string => (l ? `${kw("LATERAL")} ` : "");
const ordinality = (o: boolean | undefined): string => (o ? ` ${kw("WITH ORDINALITY")}` : "");

const tablesample = (t: TableSample | undefined): Doc =>
  t === undefined
    ? ""
    : [
        " ",
        kw("TABLESAMPLE"),
        " ",
        bareIdent(t.method),
        " ",
        parenList(t.args.map(expr)),
        t.repeatable !== null ? [" ", kw("REPEATABLE"), " ", parens(expr(t.repeatable))] : "",
      ];

const JOINS = {
  inner: "JOIN",
  left: "LEFT JOIN",
  right: "RIGHT JOIN",
  full: "FULL JOIN",
  cross: "CROSS JOIN",
} as const;

type Join = Extract<FromItem, { kind: "join" }>;

// A join without its alias clause. Joins nest to the left, so the left item is
// written bare; a join on the right is parenthesised (PG nests `a JOIN b JOIN
// c ON p ON q` that way, and the parentheses say so).
const joinBody = (j: Join): Doc => [
  printFrom(j.left),
  line,
  j.natural ? `${kw("NATURAL")} ` : "",
  kw(JOINS[j.joinType]),
  " ",
  j.right.kind === "join" && j.right.alias === undefined ? parens(joinBody(j.right)) : printFrom(j.right),
  j.on !== null ? [" ", kw("ON"), " ", expr(j.on)] : "",
  j.using !== null
    ? [
        " ",
        kw("USING"),
        " ",
        parenList(j.using.map(ident)),
        j.usingAlias !== undefined ? [" ", kw("AS"), " ", ident(j.usingAlias)] : "",
      ]
    : "",
];

// The variant tests read the flag itself (not `in`), so the field-coverage
// check sees it read.
const xmlNamespace = (n: XmlNamespace): Doc =>
  (n as { default?: true }).default
    ? [kw("DEFAULT"), " ", bExpr(n.uri)]
    : [bExpr(n.uri), " ", kw("AS"), " ", ident((n as { name: string }).name)];

const xmlTableColumn = (c: XmlTableColumn): Doc => {
  if ((c as { forOrdinality?: true }).forOrdinality) return [ident(c.name), " ", kw("FOR ORDINALITY")];
  const col = c as Extract<XmlTableColumn, { type: unknown }>;
  return [
    ident(col.name),
    " ",
    typeName(col.type),
    col.path !== undefined ? [" ", kw("PATH"), " ", bExpr(col.path)] : "",
    col.default !== undefined ? [" ", kw("DEFAULT"), " ", bExpr(col.default)] : "",
    col.notNull === true ? ` ${kw("NOT NULL")}` : col.notNull === false ? ` ${kw("NULL")}` : "",
  ];
};

const jsonPath = (path: string | undefined): Doc[] => (path === undefined ? [] : [[kw("PATH"), " ", str(path)]]);

const jsonTableColumn = (c: JsonTableColumn): Doc => {
  switch (c.kind) {
    case "ordinality":
      return [ident(c.name), " ", kw("FOR ORDINALITY")];
    case "exists":
      return join(" ", [
        ident(c.name),
        typeName(c.type),
        kw("EXISTS"),
        ...jsonPath(c.path),
        ...jsonBehavior(c.onError, "ERROR"),
      ]);
    case "value":
      return join(" ", [
        [ident(c.name), " ", typeName(c.type), jsonFormat(c.format)],
        ...jsonPath(c.path),
        ...jsonWrapper(c.wrapper),
        ...jsonQuotes(c.quotes),
        ...jsonBehavior(c.onEmpty, "EMPTY"),
        ...jsonBehavior(c.onError, "ERROR"),
      ]);
    case "nested":
      return [
        kw("NESTED PATH"),
        " ",
        str(c.path),
        c.pathName !== undefined ? [" ", kw("AS"), " ", ident(c.pathName)] : "",
        " ",
        kw("COLUMNS"),
        " ",
        parenList(c.columns.map(jsonTableColumn)),
      ];
  }
};

/** A FROM item. */
export const printFrom: NodePrinter<FromItem, "kind"> = definePrinter<FromItem>()("kind", {
  table: (t) =>
    t.columns === undefined && t.tablesample === undefined && !t.only
      ? `${qualified(t.name)}${t.alias !== null ? ` ${kw("AS")} ${ident(t.alias)}` : ""}`
      : [
          t.only ? `${kw("ONLY")} ` : "",
          qualified(t.name),
          aliasClause(t.alias, t.columns),
          tablesample(t.tablesample),
        ],
  subquery: (s) => [lateral(s.lateral), parens(printQuery(s.query)), aliasClause(s.alias, s.columns)],
  function: (f) => [
    lateral(f.lateral),
    printExpr(f.call),
    ordinality(f.ordinality),
    funcAlias(f.alias, f.columns, f.columnDefinitions),
  ],
  rowsFrom: (r) => [
    lateral(r.lateral),
    kw("ROWS FROM"),
    " ",
    parenList(
      r.calls.map((c, i) => {
        const defs = r.callColumnDefinitions?.[i];
        return defs ? [printExpr(c), " ", kw("AS"), " ", parenList(defs.map(columnDefinition))] : printExpr(c);
      }),
    ),
    ordinality(r.ordinality),
    funcAlias(r.alias, r.columns, r.columnDefinitions),
  ],
  jsonTable: (j) => [
    lateral(j.lateral),
    kw("JSON_TABLE"),
    parens([
      commaList([
        jsonValue(j.table.context),
        [str(j.table.path), j.table.pathName !== undefined ? [" ", kw("AS"), " ", ident(j.table.pathName)] : ""],
      ]),
      ...jsonPassing(j.table.passing).map((d) => [line, d]),
      line,
      kw("COLUMNS"),
      " ",
      parenList(j.table.columns.map(jsonTableColumn)),
      ...jsonBehavior(j.table.onError, "ERROR").map((d) => [line, d]),
    ]),
    aliasClause(j.alias, j.columns),
  ],
  xmlTable: (x) => [
    lateral(x.lateral),
    kw("XMLTABLE"),
    parens([
      x.namespaces !== undefined ? [kw("XMLNAMESPACES"), parenList(x.namespaces.map(xmlNamespace)), ",", line] : "",
      atomic(x.rowPath),
      " ",
      xmlPassing(x.passing),
      line,
      kw("COLUMNS"),
      " ",
      indent(commaList(x.tableColumns.map(xmlTableColumn))),
    ]),
    aliasClause(x.alias, x.columns),
  ],
  join: (j) => (j.alias === undefined ? joinBody(j) : [parens(joinBody(j)), aliasClause(j.alias, j.columns)]),
});

/** The query statements, for the statement printer. */
export const queryStatements = {
  select: (q: SelectStmt) => printQuery(q),
  values: (q: Extract<Query, { kind: "values" }>) => printQuery(q),
  tableCmd: (q: Extract<Query, { kind: "tableCmd" }>) => printQuery(q),
  setOp: (q: Extract<Query, { kind: "setOp" }>) => printQuery(q),
};
