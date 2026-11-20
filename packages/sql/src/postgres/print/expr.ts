// Expressions: every `Expr` kind, plus the pieces several of them share
// (ORDER BY items, window specifications, SQL/JSON clauses).
//
// Parentheses come from the grammar's own Pratt tables through `precedence`:
// a binary node is keyed by its operator, an operator node by the key its
// group lists in `nodes`, and an atom by null. Positions the grammar parses
// with its restricted `b_expr` table (POSITION's first operand, BETWEEN's lower
// bound, XMLTABLE's PATH and DEFAULT) print in the `b` context, which wraps
// whatever that table can't build. Positions that take a bare atom (PG's
// c_expr: XMLEXISTS's path, a JSON_OBJECT key before VALUE) wrap anything that
// isn't one.
//
// `expr.ts` and `query.ts` import each other (expressions hold subqueries,
// queries hold expressions), so neither may use the other's exports at module
// load (no top-level calls, spreads or `extendPrinter` of them), only inside
// functions.
import {
  type Doc,
  definePrinter,
  group,
  indent,
  join,
  line,
  type NodePrinter,
  type PrecedenceKey,
  precedence,
  softline,
} from "@parser-kit/core/print";
import type {
  Expr,
  JsonBehavior,
  JsonFormat,
  JsonPassingArg,
  JsonReturning,
  JsonValueExpr,
  OrderItem,
  WindowFrame,
  WindowFrameBound,
  WindowSpec,
  XmlNamedValue,
  XmlPassing,
} from "../ast";
import { bExprTable, expressionTable } from "../grammar";
import {
  commaList,
  firstChar,
  firstText,
  functionQualified,
  functionWord,
  ident,
  isColNameKeyword,
  kw,
  minimalIdent,
  OPERATOR_CHARS,
  parenList,
  parens,
  qualified,
  quoted,
  str,
} from "./context";
import { printQuery } from "./query";
import { typeName } from "./types";

// --- precedence keys ---

// The operators the tables name a node for: every op of a plain `ops` infix
// group, and every key a custom group lists in `nodes`. A binary node with any
// other operator is the generic catch-all's (`op`), as is one spelled
// `OPERATOR(…)`.
const NAMED_INFIX = new Set<string>();
for (const g of expressionTable.infix) {
  if ("ops" in g && g.ops && !g.parse) for (const op of g.ops) NAMED_INFIX.add(op);
  const nodes = (g as { nodes?: readonly string[] | Record<string, unknown> }).nodes;
  if (nodes) for (const k of Array.isArray(nodes) ? nodes : Object.keys(nodes)) NAMED_INFIX.add(k);
}
// The prefix operators the grammar reads by value. Any other one can only be
// written `OPERATOR(op) x`.
const PREFIX_OPS = new Set(expressionTable.prefix.flatMap((g) => g.ops));

const isWordOp = (op: string): boolean => /^[a-z]/.test(op);

const binaryKey = (op: string, opSchema: string[] | undefined): string =>
  opSchema === undefined && NAMED_INFIX.has(op) ? op : "op";

/** The node's entry in the Pratt table, as `precedence` reads it. */
const exprKey = (e: Expr): PrecedenceKey => {
  switch (e.kind) {
    case "binary":
      return binaryKey(e.op, e.opSchema);
    case "unary":
      return e.opSchema === undefined && PREFIX_OPS.has(e.op) ? { prefix: e.op } : "unary operator";
    case "anyAll":
      return e.opSchema === undefined && NAMED_INFIX.has(`any ${e.op}`) ? `any ${e.op}` : "any op";
    case "in":
    case "inSubquery":
      return e.negated ? `not ${e.kind}` : e.kind;
    case "exists":
      return e.negated ? { prefix: "not" } : null;
    case "number":
      // A negative value (folded in elsewhere, or built by hand) reads back as a sign.
      return e.value < 0 || e.raw?.startsWith("-") ? { prefix: "-" } : null;
    case "like":
    case "similarTo":
    case "between":
    case "is":
    case "isDistinct":
    case "isTest":
    case "isNormalized":
    case "isDocument":
    case "isJson":
    case "cast":
    case "subscript":
    case "collate":
    case "atTimeZone":
    case "atLocal":
      return e.kind;
    default:
      return null;
  }
};

// The bp a group reads a node's trailing operand at, from its `nodes` record:
// what a position the grammar parses the same way reads too.
const tailOf = (key: string): number => {
  for (const g of expressionTable.infix) {
    const nodes = (g as { nodes?: unknown }).nodes;
    if (nodes && !Array.isArray(nodes)) {
      const rhs = (nodes as Record<string, number | "none">)[key];
      if (typeof rhs === "number") return rhs;
    }
  }
  throw new Error(`No group reads a "${key}" operand`);
};
// Op's operand (`a OPERATOR(+) b`, and the prefix `OPERATOR(-) b`), and the
// LIKE / BETWEEN tier's (a BETWEEN bound, SUBSTRING … SIMILAR's operands).
const OP_OPERAND = tailOf("op");
const LIKE_OPERAND = tailOf("like");

const prec = precedence<Expr, "b">(expressionTable, {
  key: exprKey,
  print: (e): Doc => printExpr(e),
  // `OPERATOR(op) x`: the atom rule reads its operand at Op's bp + 1.
  atoms: { "unary operator": OP_OPERAND },
  contexts: { b: bExprTable },
});

// An atom never needs parentheses from `precedence`, and nothing it prints
// reads `precedence`'s operand context (its own operands go through `expr` and
// friends, which set one), so it skips `precedence` entirely: most nodes are
// atoms, and this is the hot path. (OVERLAPS, an atom here, reads `inB` below.)

/** An expression where the grammar reads a whole one: a call argument, a clause, a list item. */
export const expr = (e: Expr): Doc =>
  within(false, () => (exprKey(e) === null ? printExpr(e) : prec.operand(e, 0, null)));
/** An expression where the grammar reads PG's restricted `b_expr`. */
export const bExpr = (e: Expr): Doc => within(true, () => prec.operand(e, 0, "b"));
/** Whether a node is PG's c_expr, which stands anywhere an operand does: an atom, but not OVERLAPS. */
const isAtom = (e: Expr): boolean => exprKey(e) === null && e.kind !== "overlaps";
/** An expression where the grammar reads a bare atom (PG's c_expr): anything else is parenthesised. */
export const atomic = (e: Expr): Doc => (isAtom(e) ? expr(e) : ["(", expr(e), ")"]);

// `row OVERLAPS row` is an atom to this grammar but an a_expr to PG, so in a
// b_expr position it is parenthesised by hand. `inB` says whether the operand
// being printed is one (set by `bExpr`, cleared by `expr`); a pair of
// parentheses `precedence` adds around a part of it leaves it set, which can
// only add parentheses.
let inB = false;
const within = <T>(b: boolean, print: () => T): T => {
  const outer = inB;
  inB = b;
  try {
    return print();
  } finally {
    inB = outer;
  }
};

// PG declares IN and the IS tests non-associative (`a IS NULL IS NULL` is a
// syntax error), but they are postfix groups here, which `precedence` treats
// as chaining and the parser lets chain. So one of them as the left operand of
// another at the same bp is parenthesised by hand; the bps come from the table.
// (The infix groups of those tiers, LIKE / BETWEEN / comparisons, chain to
// nothing already: they have no `assoc`.)
const NONASSOC_POSTFIX = new Set([
  "in",
  "inSubquery",
  "is",
  "isDistinct",
  "isTest",
  "isNormalized",
  "isDocument",
  "isJson",
]);
const TIER = new Map<string, number>();
for (const g of expressionTable.postfix) {
  const nodes = g.nodes === undefined ? [] : Array.isArray(g.nodes) ? g.nodes : Object.keys(g.nodes);
  for (const k of nodes) if (NONASSOC_POSTFIX.has(k)) TIER.set(k, g.bp);
}
const tierOf = (e: Expr): number | undefined => {
  const k = exprKey(e);
  return typeof k === "string" ? TIER.get(k) : undefined;
};
const left = (parent: Expr, child: Expr): Doc => {
  const tier = tierOf(parent);
  if (tier !== undefined && tierOf(child) === tier) return ["(", expr(child), ")"];
  return exprKey(child) === null ? printExpr(child) : prec.child(parent, child, "left");
};
const right = (parent: Expr, child: Expr): Doc =>
  exprKey(child) === null ? printExpr(child) : prec.child(parent, child, "right");

// --- names and calls ---

type Call = Extract<Expr, { kind: "call" }>;
// No DISTINCT, ALL, VARIADIC or ORDER BY, and no `*` or named argument.
const isPlain = (c: Call): boolean =>
  !c.distinct &&
  !c.all &&
  !c.variadic &&
  c.orderBy === undefined &&
  c.args.every((a) => a.kind !== "namedArg" && !(a.kind === "star" && a.table === null));

// A one-part call named by one of PG's col_name keywords is written quoted, an
// ordinary function to PG, unless it has the shape of the keyword form PG (and
// this grammar) read as a plain call: `coalesce(a, b)`, `substring(a, 1)`,
// `normalize(a)`, a legacy `json_object(…)`. TRIM, EXTRACT, POSITION and ROW
// are left bare whatever their shape: quoted, this grammar still reads them as
// the keyword form, so no spelling of another shape would parse back.
const bareForm = (name: string, c: Call): boolean => {
  switch (name) {
    case "coalesce":
    case "greatest":
    case "least":
    case "nullif":
    case "grouping":
    case "xmlconcat":
      return isPlain(c) && c.args.length > 0;
    case "normalize":
      return isPlain(c) && c.args.length === 1;
    case "json_object":
      return c.args.length > 0 && !c.distinct && !c.all && !c.variadic && c.orderBy === undefined;
    case "substring":
    case "overlay":
    case "trim":
    case "extract":
    case "position":
    case "row":
      return true;
    default:
      return false;
  }
};
const callName = (c: Call): string => {
  const name = c.name[0]!;
  return c.name.length === 1 && isColNameKeyword(name) && !bareForm(name, c) ? quoted(name) : functionQualified(c.name);
};

const callArgs = (c: Call): Doc => {
  if (c.args.length === 0 && !c.distinct && !c.all && c.orderBy === undefined) return "()";
  const args = c.args.map((a, i) => {
    const doc = expr(a);
    return c.variadic && i === c.args.length - 1 ? [kw("VARIADIC"), " ", doc] : doc;
  });
  const head = c.distinct ? `${kw("DISTINCT")} ` : c.all ? `${kw("ALL")} ` : "";
  const order = c.orderBy ? [line, orderBy(c.orderBy)] : "";
  return parens([head, commaList(args), order]);
};

/** `name(args)`. */
const fn = (name: string, args: Doc): Doc => [kw(name), args];

// --- subscripts and field selections ---

// A run of `[…]` and `.field` steps over a root. PG takes them after a column
// reference (`a[1].f`, but `a.f` would be a dotted name), a parameter's
// subscripts (`$1[1]`), or a parenthesised expression or subquery; any other
// root is parenthesised, so `f(x)[1]` prints as PG's `(f(x))[1]`.
const chain = (e: Expr): Doc => {
  const steps: Doc[] = [];
  let root = e;
  let fields = false;
  for (;;) {
    if (root.kind === "subscript") {
      const lo = root.index === null ? "" : expr(root.index);
      const hi = root.upper === undefined ? "" : [":", root.upper === null ? "" : expr(root.upper)];
      steps.push(["[", lo, hi, "]"]);
      root = root.base;
    } else if (root.kind === "fieldSelect") {
      steps.push(root.field === null ? ".*" : [".", ident(root.field)]);
      fields = true;
      root = root.expr;
    } else {
      break;
    }
  }
  steps.reverse();
  const bare =
    (root.kind === "name" && firstStepKind(e) === "subscript") ||
    (root.kind === "param" && !fields) ||
    root.kind === "subquery";
  return [bare ? printExpr(root) : ["(", expr(root), ")"], steps];
};
// The kind of the step nearest the root.
const firstStepKind = (e: Expr): "subscript" | "fieldSelect" => {
  let node = e;
  let kind: "subscript" | "fieldSelect" = "subscript";
  while (node.kind === "subscript" || node.kind === "fieldSelect") {
    kind = node.kind;
    node = node.kind === "subscript" ? node.base : node.expr;
  }
  return kind;
};

// --- shared clause pieces ---

/** `ORDER BY a DESC NULLS LAST, b`. */
export const orderBy = (items: readonly OrderItem[]): Doc =>
  group([kw("ORDER BY"), indent([line, commaList(items.map(orderItem))])]);

const orderItem = (o: OrderItem): Doc => [
  expr(o.expr),
  o.dir === "asc" ? ` ${kw("ASC")}` : o.dir === "desc" ? ` ${kw("DESC")}` : "",
  o.using !== undefined ? [` ${kw("USING")} `, o.using] : "",
  o.nulls === "first" ? ` ${kw("NULLS FIRST")}` : o.nulls === "last" ? ` ${kw("NULLS LAST")}` : "",
];

const frameBound = (b: WindowFrameBound): Doc => {
  switch (b.kind) {
    case "unboundedPreceding":
      return kw("UNBOUNDED PRECEDING");
    case "unboundedFollowing":
      return kw("UNBOUNDED FOLLOWING");
    case "currentRow":
      return kw("CURRENT ROW");
    case "preceding":
      return [frameOffset(b.offset), " ", kw("PRECEDING")];
    case "following":
      return [frameOffset(b.offset), " ", kw("FOLLOWING")];
  }
};

// An offset that opens with a word a bound or BETWEEN opens with (a column
// named `unbounded`, `current`) would read as that bound: parenthesised.
const frameOffset = (e: Expr): Doc => {
  const doc = expr(e);
  return /^(?:unbounded|current|between)(?![a-z0-9_$])/.test(firstText(doc)) ? ["(", doc, ")"] : doc;
};

const EXCLUSIONS = { currentRow: "CURRENT ROW", group: "GROUP", ties: "TIES", noOthers: "NO OTHERS" } as const;

const frame = (f: WindowFrame): Doc => [
  kw(f.mode.toUpperCase()),
  " ",
  f.end === null
    ? frameBound(f.start)
    : [kw("BETWEEN"), " ", frameBound(f.start), " ", kw("AND"), " ", frameBound(f.end)],
  f.exclude !== undefined ? [" ", kw("EXCLUDE"), " ", kw(EXCLUSIONS[f.exclude])] : "",
];

const WINDOW_CLAUSE_WORDS = new Set(["partition", "order", "rows", "range", "groups"]);

/** A window specification in parentheses: `(w PARTITION BY a ORDER BY b ROWS …)`. */
export const windowSpec = (s: WindowSpec): Doc => {
  const parts: Doc[] = [];
  // A base window named like a clause word would read as that clause.
  if (s.name !== null) parts.push(WINDOW_CLAUSE_WORDS.has(s.name) ? quoted(s.name) : ident(s.name));
  if (s.partitionBy !== null) {
    parts.push(group([kw("PARTITION BY"), indent([line, commaList(s.partitionBy.map(expr))])]));
  }
  if (s.orderBy !== null) parts.push(orderBy(s.orderBy));
  if (s.frame !== null) parts.push(frame(s.frame));
  return group(["(", indent([softline, join(line, parts)]), softline, ")"]);
};

export const jsonFormat = (f: JsonFormat | undefined): Doc =>
  f === undefined
    ? ""
    : [" ", kw("FORMAT JSON"), f.encoding !== undefined ? [" ", kw("ENCODING"), " ", minimalIdent(f.encoding)] : ""];
export const jsonValue = (v: JsonValueExpr): Doc => [expr(v.expr), jsonFormat(v.format)];
const jsonReturning = (r: JsonReturning | undefined): Doc[] =>
  r === undefined ? [] : [[kw("RETURNING"), " ", typeName(r.type), jsonFormat(r.format)]];
const jsonOnNull = (n: "null" | "absent" | undefined): Doc[] =>
  n === undefined ? [] : [kw(n === "null" ? "NULL ON NULL" : "ABSENT ON NULL")];
const jsonUnique = (u: boolean | undefined): Doc[] =>
  u === undefined ? [] : [kw(u ? "WITH UNIQUE KEYS" : "WITHOUT UNIQUE KEYS")];
export const jsonPassing = (p: JsonPassingArg[] | undefined): Doc[] =>
  p === undefined
    ? []
    : [
        group([
          kw("PASSING"),
          indent([line, commaList(p.map((a) => [jsonValue(a.value), " ", kw("AS"), " ", ident(a.name)]))]),
        ]),
      ];
const BEHAVIORS = {
  error: "ERROR",
  null: "NULL",
  true: "TRUE",
  false: "FALSE",
  unknown: "UNKNOWN",
  emptyArray: "EMPTY ARRAY",
  emptyObject: "EMPTY OBJECT",
} as const;
export const jsonBehavior = (b: JsonBehavior | undefined, on: "EMPTY" | "ERROR"): Doc[] =>
  b === undefined
    ? []
    : [[b.kind === "default" ? [kw("DEFAULT"), " ", expr(b.expr)] : kw(BEHAVIORS[b.kind]), " ", kw(`ON ${on}`)]];
export const jsonWrapper = (w: "without" | "conditional" | "unconditional" | undefined): Doc[] =>
  w === undefined
    ? []
    : [
        kw(
          w === "without"
            ? "WITHOUT WRAPPER"
            : w === "conditional"
              ? "WITH CONDITIONAL WRAPPER"
              : "WITH UNCONDITIONAL WRAPPER",
        ),
      ];
export const jsonQuotes = (q: "keep" | "omit" | undefined): Doc[] =>
  q === undefined ? [] : [kw(q === "keep" ? "KEEP QUOTES" : "OMIT QUOTES")];

// A JSON_OBJECT key before VALUE is a c_expr: an operator expression there is
// parenthesised (before `:` it needn't be, but VALUE is the one spelling here).
const jsonKeyValue = (key: Expr, value: JsonValueExpr): Doc => [atomic(key), " ", kw("VALUE"), " ", jsonValue(value)];

/** `name(head, clause, clause)`, the clauses after the arguments separated by lines. */
const clauses = (name: string, args: Doc[], tail: Doc[]): Doc =>
  fn(
    name,
    parens(tail.length === 0 ? commaList(args) : [commaList(args), args.length > 0 ? line : "", join(line, tail)]),
  );

const xmlNamed = (v: XmlNamedValue): Doc =>
  v.name === undefined ? expr(v.value) : [expr(v.value), " ", kw("AS"), " ", ident(v.name)];
/** `PASSING [BY REF] doc [BY VALUE]`; the document is an atom. */
export const xmlPassing = (p: XmlPassing): Doc => [
  kw("PASSING"),
  p.byBefore !== undefined ? [" ", kw(p.byBefore === "ref" ? "BY REF" : "BY VALUE")] : "",
  " ",
  atomic(p.expr),
  p.byAfter !== undefined ? [" ", kw(p.byAfter === "ref" ? "BY REF" : "BY VALUE")] : "",
];

// The NOT a negated predicate puts after its operand.
const not = (negated: boolean): string => (negated ? ` ${kw("NOT")}` : "");
const isTail = (e: Extract<Expr, { kind: `is${string}` }>, rest: Doc): Doc => [
  left(e, e.expr),
  ` ${kw("IS")}`,
  not(e.negated),
  " ",
  rest,
];

// The operator of a binary or quantified node: a keyword, a symbol, or the
// explicit `OPERATOR(schema.op)` spelling.
const operator = (op: string, opSchema: string[] | undefined): string =>
  opSchema !== undefined
    ? `${kw("OPERATOR")}(${[...opSchema.map(ident), op].join(".")})`
    : isWordOp(op)
      ? kw(op.toUpperCase())
      : op;

// --- the expression printer ---

export const printExpr: NodePrinter<Expr, "kind"> = definePrinter<Expr>()("kind", {
  number: (e) => e.raw ?? String(e.value),
  string: (e) => str(e.value),
  bool: (e) => kw(e.value ? "TRUE" : "FALSE"),
  null: () => kw("NULL"),
  name: (e) => qualified(e.parts),
  param: (e) => `$${e.name}`,
  star: (e) => (e.table === null ? "*" : [qualified(e.table), ".*"]),
  bitString: (e) => `${kw(e.hex ? "X" : "B")}'${e.value}'`,
  sqlValueFunction: (e) => [kw(e.name.toUpperCase()), e.precision !== undefined ? `(${e.precision})` : ""],
  typedLiteral: (e) => [typeName(e.type, true), " ", str(e.value)],
  // The precision goes before the literal, or on the trailing SECOND field.
  interval: (e) => {
    const p = e.precision !== undefined ? `(${e.precision})` : "";
    return e.fields === undefined
      ? [kw("INTERVAL"), p, " ", str(e.value)]
      : [kw("INTERVAL"), " ", str(e.value), " ", kw(e.fields.toUpperCase()), p];
  },
  call: (e) => [callName(e), callArgs(e)],
  namedArg: (e) => [functionWord(e.name), " => ", expr(e.value)],
  unary: (e) => {
    const operand =
      e.opSchema === undefined && PREFIX_OPS.has(e.op) ? right(e, e.operand) : prec.operand(e.operand, OP_OPERAND);
    if (e.op === "not") return [kw("NOT"), " ", operand];
    const op = PREFIX_OPS.has(e.op) && e.opSchema === undefined ? e.op : operator(e.op, e.opSchema ?? []);
    // `- -1` must not print as `--1`, a comment, nor `@ -1` as the operator `@-`.
    const space = !PREFIX_OPS.has(e.op) || e.opSchema !== undefined || OPERATOR_CHARS.has(firstChar(operand));
    return [op, space ? " " : "", operand];
  },
  binary: (e) => group([left(e, e.left), ` ${operator(e.op, e.opSchema)}`, indent([line, right(e, e.right)])]),
  anyAll: (e) => [
    left(e, e.left),
    " ",
    operator(e.op, e.opSchema),
    " ",
    kw(e.quantifier.toUpperCase()),
    " ",
    e.right.kind === "subquery" ? printExpr(e.right) : ["(", expr(e.right), ")"],
  ],
  cast: (e) => [left(e, e.expr), "::", typeName(e.type)],
  collate: (e) => [left(e, e.expr), " ", kw("COLLATE"), " ", qualified(e.collation)],
  atTimeZone: (e) => [left(e, e.expr), " ", kw("AT TIME ZONE"), " ", right(e, e.zone)],
  atLocal: (e) => [left(e, e.expr), " ", kw("AT LOCAL")],
  is: (e) => isTail(e, kw("NULL")),
  isTest: (e) => isTail(e, kw(e.test.toUpperCase())),
  isDocument: (e) => isTail(e, kw("DOCUMENT")),
  isNormalized: (e) => isTail(e, [e.form !== null ? `${kw(e.form.toUpperCase())} ` : "", kw("NORMALIZED")]),
  isJson: (e) =>
    isTail(e, [
      kw("JSON"),
      e.itemType !== null ? ` ${kw(e.itemType.toUpperCase())}` : "",
      e.uniqueKeys !== null ? ` ${kw(e.uniqueKeys ? "WITH UNIQUE KEYS" : "WITHOUT UNIQUE KEYS")}` : "",
    ]),
  isDistinct: (e) => isTail(e, [kw("DISTINCT FROM"), " ", right(e, e.from)]),
  like: (e) =>
    group([
      left(e, e.expr),
      not(e.negated),
      " ",
      kw(e.ci ? "ILIKE" : "LIKE"),
      indent([line, right(e, e.pattern), e.escape !== undefined ? [" ", kw("ESCAPE"), " ", right(e, e.escape)] : ""]),
    ]),
  similarTo: (e) =>
    group([
      left(e, e.expr),
      not(e.negated),
      " ",
      kw("SIMILAR TO"),
      indent([line, right(e, e.pattern), e.escape !== undefined ? [" ", kw("ESCAPE"), " ", right(e, e.escape)] : ""]),
    ]),
  between: (e) =>
    group([
      left(e, e.expr),
      not(e.negated),
      " ",
      kw("BETWEEN"),
      e.symmetric !== undefined ? ` ${kw(e.symmetric ? "SYMMETRIC" : "ASYMMETRIC")}` : "",
      indent([line, within(true, () => prec.operand(e.lo, LIKE_OPERAND, "b")), " ", kw("AND"), " ", right(e, e.hi)]),
    ]),
  in: (e) => [left(e, e.expr), not(e.negated), " ", kw("IN"), " ", parenList(e.list.map(expr))],
  inSubquery: (e) => [left(e, e.expr), not(e.negated), " ", kw("IN"), " ", parens(printQuery(e.query))],
  exists: (e) => [e.negated ? `${kw("NOT")} ` : "", kw("EXISTS"), " ", parens(printQuery(e.query))],
  subquery: (e) => parens(printQuery(e.query)),
  arraySubquery: (e) => [kw("ARRAY"), parens(printQuery(e.query))],
  case: (e) =>
    group([
      kw("CASE"),
      e.operand !== null ? [" ", expr(e.operand)] : "",
      indent(
        e.whens.map((w) => [
          line,
          group([kw("WHEN"), " ", expr(w.when), indent([line, kw("THEN"), " ", expr(w.then_)])]),
        ]),
      ),
      e.else_ !== null ? indent([line, kw("ELSE"), " ", expr(e.else_)]) : "",
      line,
      kw("END"),
    ]),
  array: (e) => [kw("ARRAY"), brackets(e)],
  row: (e) =>
    e.implicit && e.items.length > 1 ? parenList(e.items.map(expr)) : [kw("ROW"), parenList(e.items.map(expr))],
  overlaps: (e, print) => {
    const doc = [print(e.left), " ", kw("OVERLAPS"), " ", print(e.right)];
    return inB ? ["(", doc, ")"] : doc;
  },
  subscript: (e) => chain(e),
  fieldSelect: (e) => chain(e),
  extract: (e) => fn("EXTRACT", parens([minimalIdent(e.field), " ", kw("FROM"), " ", expr(e.source)])),
  substring: (e) =>
    fn(
      "SUBSTRING",
      parens([
        expr(e.value),
        e.from !== null ? [" ", kw("FROM"), " ", expr(e.from)] : "",
        e.for_ !== null ? [" ", kw("FOR"), " ", expr(e.for_)] : "",
      ]),
    ),
  substringSimilar: (e) =>
    fn(
      "SUBSTRING",
      // Both operands are parenthesised from LIKE's tier down: PG reads a
      // looser value's SIMILAR as SIMILAR TO, and a pattern ending in LIKE or
      // SIMILAR TO would take the ESCAPE.
      parens([
        within(false, () => prec.operand(e.value, LIKE_OPERAND, null)),
        " ",
        kw("SIMILAR"),
        " ",
        within(false, () => prec.operand(e.pattern, LIKE_OPERAND, null)),
        " ",
        kw("ESCAPE"),
        " ",
        expr(e.escape),
      ]),
    ),
  normalize: (e) => fn("NORMALIZE", parens([expr(e.value), ", ", kw(e.form.toUpperCase())])),
  collationFor: (e) => [kw("COLLATION FOR"), " ", parens(expr(e.expr))],
  position: (e) => fn("POSITION", parens([bExpr(e.substring), " ", kw("IN"), " ", bExpr(e.string)])),
  trim: (e) =>
    fn(
      "TRIM",
      parens([
        e.side !== null ? `${kw(e.side.toUpperCase())} ` : "",
        e.characters !== null ? [expr(e.characters), " "] : "",
        e.side !== null || e.characters !== null ? `${kw("FROM")} ` : "",
        expr(e.source),
      ]),
    ),
  overlay: (e) =>
    fn(
      "OVERLAY",
      parens([
        expr(e.value),
        " ",
        kw("PLACING"),
        " ",
        expr(e.placing),
        " ",
        kw("FROM"),
        " ",
        expr(e.from),
        e.for_ !== null ? [" ", kw("FOR"), " ", expr(e.for_)] : "",
      ]),
    ),
  jsonObject: (e) =>
    clauses(
      "JSON_OBJECT",
      e.entries.map((kv) => jsonKeyValue(kv.key, kv.value)),
      [...jsonOnNull(e.onNull), ...jsonUnique(e.uniqueKeys), ...jsonReturning(e.returning)],
    ),
  jsonArray: (e) =>
    clauses("JSON_ARRAY", e.elements.map(jsonValue), [...jsonOnNull(e.onNull), ...jsonReturning(e.returning)]),
  jsonArrayQuery: (e) =>
    clauses("JSON_ARRAY", [[printQuery(e.query), jsonFormat(e.format)]], jsonReturning(e.returning)),
  jsonObjectAgg: (e) =>
    clauses(
      "JSON_OBJECTAGG",
      [jsonKeyValue(e.key, e.value)],
      [...jsonOnNull(e.onNull), ...jsonUnique(e.uniqueKeys), ...jsonReturning(e.returning)],
    ),
  jsonArrayAgg: (e) =>
    clauses(
      "JSON_ARRAYAGG",
      [[jsonValue(e.value), e.orderBy !== undefined ? [line, orderBy(e.orderBy)] : ""]],
      [...jsonOnNull(e.onNull), ...jsonReturning(e.returning)],
    ),
  jsonValue: (e) =>
    clauses(
      "JSON_VALUE",
      [jsonValue(e.context), expr(e.path)],
      [
        ...jsonPassing(e.passing),
        ...jsonReturning(e.returning),
        ...jsonBehavior(e.onEmpty, "EMPTY"),
        ...jsonBehavior(e.onError, "ERROR"),
      ],
    ),
  jsonQuery: (e) =>
    clauses(
      "JSON_QUERY",
      [jsonValue(e.context), expr(e.path)],
      [
        ...jsonPassing(e.passing),
        ...jsonReturning(e.returning),
        ...jsonWrapper(e.wrapper),
        ...jsonQuotes(e.quotes),
        ...jsonBehavior(e.onEmpty, "EMPTY"),
        ...jsonBehavior(e.onError, "ERROR"),
      ],
    ),
  jsonExists: (e) =>
    clauses(
      "JSON_EXISTS",
      [jsonValue(e.context), expr(e.path)],
      [...jsonPassing(e.passing), ...jsonBehavior(e.onError, "ERROR")],
    ),
  jsonParse: (e) => clauses("JSON", [jsonValue(e.value)], jsonUnique(e.uniqueKeys)),
  jsonScalar: (e) => fn("JSON_SCALAR", parens(expr(e.value))),
  jsonSerialize: (e) => clauses("JSON_SERIALIZE", [jsonValue(e.value)], jsonReturning(e.returning)),
  window: (e, print) => [
    print(e.fn),
    " ",
    kw("OVER"),
    " ",
    e.partitionBy === null && e.orderBy === null && e.frame === null && e.name !== null ? ident(e.name) : windowSpec(e),
  ],
  aggFilter: (e, print) => [print(e.fn), " ", kw("FILTER"), " ", parens([kw("WHERE"), " ", expr(e.where)])],
  withinGroup: (e, print) => [print(e.fn), " ", kw("WITHIN GROUP"), " ", parens(orderBy(e.orderBy))],
  nullTreatment: (e, print) => [print(e.fn), " ", kw(e.treatment === "ignore" ? "IGNORE NULLS" : "RESPECT NULLS")],
  xmlElement: (e) =>
    fn(
      "XMLELEMENT",
      parenList([
        [kw("NAME"), " ", ident(e.name)],
        ...(e.attributes !== undefined ? [fn("XMLATTRIBUTES", parenList(e.attributes.map(xmlNamed)))] : []),
        ...(e.content ?? []).map(expr),
      ]),
    ),
  xmlForest: (e) => fn("XMLFOREST", parenList(e.items.map(xmlNamed))),
  xmlPi: (e) =>
    fn("XMLPI", parenList([[kw("NAME"), " ", ident(e.name)], ...(e.content !== undefined ? [expr(e.content)] : [])])),
  xmlRoot: (e) =>
    fn(
      "XMLROOT",
      parenList([
        expr(e.expr),
        [kw("VERSION"), " ", e.version !== undefined ? expr(e.version) : kw("NO VALUE")],
        ...(e.standalone !== undefined ? [[kw("STANDALONE"), " ", kw(e.standalone.toUpperCase())]] : []),
      ]),
    ),
  xmlParse: (e) =>
    fn(
      "XMLPARSE",
      parens([
        kw(e.option.toUpperCase()),
        " ",
        expr(e.expr),
        e.whitespace !== undefined
          ? [" ", kw(e.whitespace === "preserve" ? "PRESERVE WHITESPACE" : "STRIP WHITESPACE")]
          : "",
      ]),
    ),
  xmlSerialize: (e) =>
    fn(
      "XMLSERIALIZE",
      parens([
        kw(e.option.toUpperCase()),
        " ",
        expr(e.expr),
        " ",
        kw("AS"),
        " ",
        typeName(e.type),
        e.indent !== undefined ? [" ", kw(e.indent ? "INDENT" : "NO INDENT")] : "",
      ]),
    ),
  xmlExists: (e) => fn("XMLEXISTS", parens([atomic(e.path), " ", xmlPassing(e.passing)])),
});

// `[a, b]`: an ARRAY's elements, a row of a multidimensional one written as bare brackets.
const brackets = (e: Extract<Expr, { kind: "array" }>): Doc =>
  group([
    "[",
    indent([softline, commaList(e.elements.map((x) => (x.kind === "array" && x.implicit ? brackets(x) : expr(x))))]),
    softline,
    "]",
  ]);
