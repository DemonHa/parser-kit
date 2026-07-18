import {
  attempt,
  bindTokens,
  custom,
  defineGrammar,
  delimited,
  describeFound,
  field,
  lazy,
  matchesFirst,
  oneOf,
  optional,
  type ParseContext,
  type Position,
  type PrattHelpers,
  pratt,
  type Rule,
  repeat,
  type Span,
  sepBy,
  seq,
  skip,
} from "../../src/index";
import { type SqlTokenType, sqlLexer } from "./lexer";

// SQL-lite parses a slice of PostgreSQL DDL — CREATE TABLE / INDEX / TYPE,
// ALTER TABLE, DROP TABLE, COMMENT ON — plus a DML core — SELECT (with
// WITH / DISTINCT / joins / WHERE / GROUP BY / HAVING / ORDER BY / LIMIT /
// OFFSET / UNION-INTERSECT-EXCEPT) and INSERT / UPDATE / DELETE with
// RETURNING — over the scalar expression sublanguage that DEFAULT / CHECK /
// index / WHERE clauses share. It is the end-to-end test for the PG-grade kit
// features: escaped/dollar strings, PG numbers, bind parameters, the operator
// reader, the fold-and-match keyword strategy, match-based and non-associative
// pratt operators, mutual expr↔query recursion via lazy(), and farthest-failure
// / nested recovery. The expression sublanguage also covers the PG special forms
// — CAST / EXTRACT / SUBSTRING / POSITION / TRIM, ARRAY[…] / ROW(…), array
// subscripts & slices, INTERVAL literals, and COLLATE / AT TIME ZONE postfixes —
// plus window functions: `fn(…) [WITHIN GROUP (ORDER BY …)] [FILTER (WHERE …)]
// [OVER (…) | OVER name]`, with named windows via a `WINDOW w AS (…)` clause.
//
// Out of scope (v1): LATERAL, WITH before INSERT/UPDATE/DELETE, VALUES as a
// standalone statement, FETCH, and table-function FROM items. Ordinary
// aggregates (no OVER/FILTER/WITHIN GROUP) still parse as plain function calls.

// --- AST ---
// Recursive nodes (Expr) are declared by hand, exactly as js-lite does; the
// rules below still produce every value.

export type ColType = { name: string; args: number[]; array: boolean; span: Span };

export type Expr =
  | { kind: "number"; value: number; span: Span }
  | { kind: "string"; value: string; span: Span }
  | { kind: "bool"; value: boolean; span: Span }
  | { kind: "null"; span: Span }
  | { kind: "name"; parts: string[]; span: Span }
  | { kind: "call"; name: string; args: Expr[]; span: Span }
  | { kind: "unary"; op: string; operand: Expr; span: Span }
  | { kind: "binary"; op: string; left: Expr; right: Expr; span: Span }
  | { kind: "cast"; expr: Expr; type: ColType; span: Span }
  | { kind: "is"; expr: Expr; negated: boolean; span: Span }
  // `IS [NOT] DISTINCT FROM x` and `IS [NOT] TRUE/FALSE/UNKNOWN` — companions to
  // the plain `is` node (IS [NOT] NULL), each carrying its own negation flag.
  | { kind: "isDistinct"; expr: Expr; from: Expr; negated: boolean; span: Span }
  | { kind: "isTest"; expr: Expr; test: "true" | "false" | "unknown"; negated: boolean; span: Span }
  // `escape` is present only when an `ESCAPE x` tail follows (LIKE / ILIKE).
  | { kind: "like"; expr: Expr; pattern: Expr; negated: boolean; ci: boolean; escape?: Expr; span: Span }
  // `x [NOT] SIMILAR TO pattern [ESCAPE x]` — a POSIX-ish sibling of LIKE.
  | { kind: "similarTo"; expr: Expr; pattern: Expr; negated: boolean; escape?: Expr; span: Span }
  | { kind: "between"; expr: Expr; lo: Expr; hi: Expr; negated: boolean; span: Span }
  | { kind: "in"; expr: Expr; list: Expr[]; negated: boolean; span: Span }
  // `x <cmp> ANY|ALL|SOME (array|subquery)` — a comparison whose RHS is
  // quantified. `right` is a scalar subquery or a parenthesised array expr.
  | { kind: "anyAll"; op: string; quantifier: "any" | "all" | "some"; left: Expr; right: Expr; span: Span }
  // --- DML expression additions (all pure-additive; existing nodes untouched) ---
  // `*` and `t.*` — used in select lists and `count(*)`. `table` is the dotted
  // qualifier for `t.*` / `s.t.*`, null for a bare `*`.
  | { kind: "star"; table: string[] | null; span: Span }
  // `then_` (not `then`) so the node is never mistaken for a thenable.
  | { kind: "case"; operand: Expr | null; whens: { when: Expr; then_: Expr }[]; else_: Expr | null; span: Span }
  // A scalar subquery `(SELECT …)` in expression position.
  | { kind: "subquery"; query: Query; span: Span }
  | { kind: "exists"; query: Query; negated: boolean; span: Span }
  // A distinct kind from `in` so `x IN (1,2,3)` keeps its list-valued shape.
  | { kind: "inSubquery"; expr: Expr; query: Query; negated: boolean; span: Span }
  // --- Phase 2: expression special forms ---
  // A positional / named bind parameter (`$1`, `$name`); `name` is the text after
  // the `$` ("1", "name"). Lexed as a dedicated `param` token.
  | { kind: "param"; name: string; span: Span }
  // `ARRAY[…]` constructor. `elements` may be empty (`ARRAY[]`).
  | { kind: "array"; elements: Expr[]; span: Span }
  // `ROW(…)` explicit row constructor.
  | { kind: "row"; items: Expr[]; span: Span }
  // Array subscript / slice postfix: `a[i]` (no `upper` key) or `a[lo:hi]`
  // (`upper` present, either bound possibly null for `a[:hi]` / `a[lo:]`).
  | { kind: "subscript"; base: Expr; index: Expr | null; upper?: Expr | null; span: Span }
  // `INTERVAL 'literal' [field]` — `fields` is the trailing unit spec (e.g.
  // "day", "hour to minute"), absent when only the literal is given.
  | { kind: "interval"; value: string; fields?: string; span: Span }
  // `EXTRACT(field FROM source)` — `field` is the unit keyword/string.
  | { kind: "extract"; field: string; source: Expr; span: Span }
  // `SUBSTRING(value FROM from FOR for_)`; either keyword tail may be null.
  | { kind: "substring"; value: Expr; from: Expr | null; for_: Expr | null; span: Span }
  // `POSITION(substring IN string)`.
  | { kind: "position"; substring: Expr; string: Expr; span: Span }
  // `TRIM([LEADING|TRAILING|BOTH] [characters] FROM source)`.
  | { kind: "trim"; side: "leading" | "trailing" | "both" | null; characters: Expr | null; source: Expr; span: Span }
  // `x COLLATE collation` — `collation` is the (possibly qualified) collation name.
  | { kind: "collate"; expr: Expr; collation: string[]; span: Span }
  // `x AT TIME ZONE zone`.
  | { kind: "atTimeZone"; expr: Expr; zone: Expr; span: Span }
  // --- Phase 3: window functions & aggregate modifiers ---
  // `fn(…) OVER (…)` / `fn(…) OVER name`. The spec is inlined onto the node (the
  // plan's flat shape): `name` is the referenced base window (a bare `OVER w`, or
  // a leading name inside the parens), null when the window is fully inline.
  | {
      kind: "window";
      fn: Expr;
      name: string | null;
      partitionBy: Expr[] | null;
      orderBy: OrderItem[] | null;
      frame: WindowFrame | null;
      span: Span;
    }
  // `fn(…) FILTER (WHERE predicate)` — an aggregate's filter clause. Wraps the
  // underlying call so `count(*) FILTER (…) OVER (…)` nests filter inside window.
  | { kind: "aggFilter"; fn: Expr; where: Expr; span: Span }
  // `fn(…) WITHIN GROUP (ORDER BY …)` — an ordered-set / hypothetical-set aggregate.
  | { kind: "withinGroup"; fn: Expr; orderBy: OrderItem[]; span: Span };

// One bound of a window frame (`ROWS/RANGE/GROUPS` extent). `preceding` /
// `following` carry the offset expression; the others are nullary.
export type WindowFrameBound =
  | { kind: "unboundedPreceding" }
  | { kind: "preceding"; offset: Expr }
  | { kind: "currentRow" }
  | { kind: "following"; offset: Expr }
  | { kind: "unboundedFollowing" };

// A frame clause: a mode plus one bound, or a `BETWEEN start AND end` pair
// (`end` null for the single-bound `ROWS start` shorthand).
export type WindowFrame = {
  mode: "rows" | "range" | "groups";
  start: WindowFrameBound;
  end: WindowFrameBound | null;
};

// A window specification, shared by inline `OVER (…)`, bare `OVER name`, and the
// `WINDOW w AS (…)` clause. `name` is the optional referenced base window; the
// rest are the inline additions (all null when only a base name is given).
export type WindowSpec = {
  name: string | null;
  partitionBy: Expr[] | null;
  orderBy: OrderItem[] | null;
  frame: WindowFrame | null;
};

// A `WINDOW name AS (spec)` entry from a SELECT's WINDOW clause.
export type NamedWindow = { name: string; spec: WindowSpec };

export type ColConstraint =
  | { kind: "notNull"; span: Span }
  | { kind: "nullable"; span: Span }
  | { kind: "default"; expr: Expr; span: Span }
  | { kind: "primaryKey"; span: Span }
  | { kind: "unique"; span: Span }
  | { kind: "references"; table: string[]; columns: string[] | null; onDelete: string | null; span: Span }
  | { kind: "check"; expr: Expr; span: Span };

export type ColumnDef = {
  kind: "column";
  name: string;
  dataType: ColType;
  constraints: ColConstraint[];
  span: Span;
};

export type TableConstraint =
  | { kind: "primaryKey"; name: string | null; columns: string[]; span: Span }
  | { kind: "unique"; name: string | null; columns: string[]; span: Span }
  | { kind: "check"; name: string | null; expr: Expr; span: Span }
  | {
      kind: "foreignKey";
      name: string | null;
      columns: string[];
      refTable: string[];
      refColumns: string[] | null;
      onDelete: string | null;
      span: Span;
    };

export type TableItem = ColumnDef | TableConstraint;

export type AlterAction =
  | { kind: "addColumn"; column: ColumnDef }
  | { kind: "dropColumn"; name: string }
  | { kind: "addConstraint"; name: string | null; constraint: TableConstraint }
  | { kind: "setDefault"; column: string; expr: Expr }
  | { kind: "dropDefault"; column: string };

export type Stmt =
  | { kind: "createTable"; ifNotExists: boolean; name: string[]; items: TableItem[]; span: Span }
  | {
      kind: "createIndex";
      unique: boolean;
      name: string | null;
      table: string[];
      using: string | null;
      columns: Expr[];
      where: Expr | null;
      span: Span;
    }
  | { kind: "createType"; name: string[]; values: string[]; span: Span }
  | { kind: "alterTable"; name: string[]; action: AlterAction; span: Span }
  | { kind: "dropTable"; ifExists: boolean; names: string[][]; span: Span }
  | { kind: "comment"; objectType: string; name: string[]; comment: string | null; span: Span }
  // A top-level query or DML statement is a statement too.
  | Query
  | Insert
  | Update
  | Delete;

// --- DML AST (the `{ kind }` idiom, mutually recursive with Expr via lazy) ---

export type SetOpKind = "union" | "unionAll" | "intersect" | "intersectAll" | "except" | "exceptAll";

export type Query = SelectStmt | { kind: "setOp"; op: SetOpKind; left: Query; right: Query; span: Span };

export type SelectStmt = {
  kind: "select";
  with_: Cte[] | null;
  recursive: boolean;
  // `false` = no DISTINCT, `true` = DISTINCT, `Expr[]` = DISTINCT ON (…).
  distinct: boolean | Expr[];
  columns: SelectItem[];
  from: FromItem[] | null;
  where: Expr | null;
  groupBy: Expr[] | null;
  having: Expr | null;
  // Named windows from a `WINDOW w AS (…)` clause (after HAVING, before ORDER BY).
  window: NamedWindow[] | null;
  orderBy: OrderItem[] | null;
  limit: Expr | null;
  offset: Expr | null;
  span: Span;
};

// `expr` may be a `star` node (`*`, `t.*`).
export type SelectItem = { expr: Expr; alias: string | null };

export type FromItemJoinType = "inner" | "left" | "right" | "full" | "cross";

export type FromItem =
  | { kind: "table"; name: string[]; alias: string | null }
  | { kind: "subquery"; query: Query; alias: string | null }
  | {
      kind: "join";
      joinType: FromItemJoinType;
      left: FromItem;
      right: FromItem;
      on: Expr | null;
      using: string[] | null;
    };

export type OrderItem = { expr: Expr; dir: "asc" | "desc" | null; nulls: "first" | "last" | null };

export type Cte = { name: string; columns: string[] | null; query: Query };

export type OnConflict = {
  target: string[] | null;
  action: { kind: "nothing" } | { kind: "update"; set: { column: string; value: Expr }[]; where: Expr | null };
};

export type Insert = {
  kind: "insert";
  table: string[];
  columns: string[] | null;
  source: { kind: "values"; rows: Expr[][] } | { kind: "select"; query: Query };
  onConflict: OnConflict | null;
  returning: SelectItem[] | null;
  span: Span;
};

export type Update = {
  kind: "update";
  table: string[];
  alias: string | null;
  set: { column: string; value: Expr }[];
  from: FromItem[] | null;
  where: Expr | null;
  returning: SelectItem[] | null;
  span: Span;
};

export type Delete = {
  kind: "delete";
  table: string[];
  alias: string | null;
  using: FromItem[] | null;
  where: Expr | null;
  returning: SelectItem[] | null;
  span: Span;
};

// --- reserved words (grammar data, not lexer config) ---
// PG's reserved set: these may not be a bare column/table/type name — only via a
// quoted identifier. Everything else (`type`, `role`, `comment`, `data`, `int`,
// `text`, …) stays usable as a name for free, because the fold-and-match strategy
// never took it away. Non-reserved keywords used by the grammar (`index`,
// `enum`, `cascade`, `between`, `like`, …) are matched by value regardless.
const RESERVED: ReadonlySet<string> = new Set([
  "all",
  "analyse",
  "analyze",
  "and",
  "any",
  "array",
  "as",
  "asc",
  "asymmetric",
  "both",
  "case",
  "cast",
  "check",
  "collate",
  "column",
  "constraint",
  "create",
  "current_date",
  "current_role",
  "current_time",
  "current_timestamp",
  "current_user",
  "default",
  "deferrable",
  "desc",
  "distinct",
  "do",
  "else",
  "end",
  "except",
  "false",
  "fetch",
  "for",
  "foreign",
  "from",
  "grant",
  "group",
  "having",
  "in",
  "initially",
  "intersect",
  "into",
  "is",
  "lateral",
  "leading",
  "limit",
  "localtime",
  "localtimestamp",
  "not",
  "null",
  "offset",
  "on",
  "only",
  "or",
  "order",
  "placing",
  "primary",
  "references",
  "returning",
  "select",
  "session_user",
  "some",
  "symmetric",
  "table",
  "then",
  "to",
  "trailing",
  "true",
  "union",
  "unique",
  "user",
  "using",
  "variadic",
  "when",
  "where",
  "window",
  "with",
  // DML clause / join lead-words. These must be reserved so `[AS] alias`
  // detection stops at them (else `FROM t JOIN u` reads `join` as t's alias,
  // `UPDATE t SET …` reads `set` as t's alias) and set-op / clause dispatch
  // stays LL(1). `from/where/group/order/having/limit/offset/on/using/union/
  // intersect/except/distinct/into/returning/when/then/else/end/case` are
  // already reserved above.
  "cross",
  "full",
  "inner",
  "join",
  "left",
  "natural",
  "right",
  "set",
  "values",
]);

// --- token sugar ---

const { token, match, word, phrase, identifierLike } = bindTokens<SqlTokenType>();
const punc = (value: string) => token("punc", { values: [value] });
const P = (value: string) => match("punc", value);
// Folding makes keyword matching exact-value matching against `ident` tokens.
const kw = (text: string) => word("ident", text);
const kwseq = (...words: [string, ...string[]]) => phrase("ident", ...words);

// --- names ---
// A name is an unreserved folded identifier or a case-preserved quoted one.
// `identifierLike` is type-only in its first set, so under oneOf's
// value-specific-first dispatch every keyword branch beats it: a reserved word
// like `select` is rejected here yet accepted when quoted (a `qident` token).
const identName = identifierLike("ident", { exclude: RESERVED, display: "a name" }).map((node) => node.value);
const qidentName = token("qident").map((node) => node.value);
const nameWord = oneOf(identName, qidentName).describe("a name");
const qualName = sepBy(nameWord, P(".")); // schema.table.column → string[]

// Zero-or-more of a rule with no recovery: dispatch on its first set and stop
// the moment it no longer matches. Unlike repeat(), a failure inside propagates
// (so an enclosing delimited({recover}) can resync) instead of being swallowed.
function many<T>(rule: Rule<T, SqlTokenType>): Rule<T[], SqlTokenType> {
  const first = rule.first();
  return custom<T[], SqlTokenType>(
    (ctx) => {
      const items: T[] = [];
      while (matchesFirst(ctx.peek(), first)) items.push(ctx.parse(rule));
      return items;
    },
    { expected: rule.expected(), first },
  );
}

// --- expressions ---

const expression: Rule<Expr, SqlTokenType> = lazy(() => expressionRule);
// A "b-expression": the same operator sublanguage minus the loose forms
// (comparison / IS / IN / LIKE / BETWEEN / AND / OR). PG uses it for operands
// whose end is marked by a keyword that also lexes as an operator — here, the
// `IN` inside `POSITION(sub IN str)`, which would otherwise be swallowed by the
// `in` postfix. Stops before any operator below the arithmetic/concat tier.
const bExpression: Rule<Expr, SqlTokenType> = lazy(() => bExprRule);
// The expr↔query cycle: exactly one Rule<Query> annotation, resolved lazily —
// the same one-boundary rule js-lite's expr/statement cycle follows. Declared
// here because the expression atom (scalar subquery, EXISTS, IN (SELECT …))
// reaches into it.
const query: Rule<Query, SqlTokenType> = lazy(() => queryRule);
const exprList = delimited(P("("), P(")"), P(","), expression, { interleaved: true });

// `*` lexes as an operator token; introduced only in select-list / function-arg
// positions, so the pratt `*` multiply is untouched.
const bareStar = token("op", { values: ["*"] }).map((_node, span): Expr => ({ kind: "star", table: null, span }));

// `(` opens both `(expr)` and `(SELECT …)`; they share the first token, so the
// atom peeks one token past it — a `select`/`with` there means a subquery. No
// attempt() cost. (`peekAhead` gives raw tokens, which is what we want here.)
const startsQuery = (ctx: ParseContext<SqlTokenType>): boolean => {
  const after = ctx.peekAhead(1);
  return after !== null && after.type === "ident" && (after.value === "select" || after.value === "with");
};
const isSubqueryParen = (ctx: ParseContext<SqlTokenType>): boolean => ctx.is("punc", "(") && startsQuery(ctx);
const parenQuery = seq(skip(punc("(")), field("q", query), skip(punc(")"))).map((s) => s.q);

const numberLit = token("number").map((node, span): Expr => ({ kind: "number", value: Number(node.value), span }));
const stringLit = token("string").map((node, span): Expr => ({ kind: "string", value: node.value, span }));
const boolLit = token("ident", { values: ["true", "false"] }).map(
  (node, span): Expr => ({ kind: "bool", value: node.value === "true", span }),
);
const nullLit = kw("null").map((_node, span): Expr => ({ kind: "null", span }));
const parenExpr = seq(skip(punc("(")), field("e", expression), skip(punc(")"))).map((s) => s.e);

// A function argument: `*` (for `count(*)`) or an ordinary expression.
const functionArg = oneOf(bareStar, expression);

// --- special call syntaxes ---
// A handful of PG functions take keyword-separated arguments rather than a plain
// comma list. Their callee names are unreserved, so they are dispatched inside
// columnRef's call branch (below) once the `(` is consumed; each helper is
// entered positioned just past that `(` and consumes through the closing `)`.
// The trailing field of INTERVAL (`day`, `hour to minute`, …) is restricted to
// these unit words so it never swallows a following clause keyword like `from`.
const INTERVAL_FIELDS: ReadonlySet<string> = new Set(["year", "month", "day", "hour", "minute", "second", "to"]);

const expectClose = (ctx: ParseContext<SqlTokenType>): void => {
  if (!ctx.is("punc", ")")) ctx.croak(`Expected ")" but found ${describeFound(ctx.peek())}`);
  ctx.next(); // ")"
};

// EXTRACT(field FROM source). `field` is a unit keyword (an ident) or a string.
function parseExtract(ctx: ParseContext<SqlTokenType>, start: Position): Expr {
  const field = ctx.is("string") ? ctx.next()!.value : ctx.parse(nameWord);
  ctx.parse(kw("from"));
  const source = ctx.parse(expression);
  expectClose(ctx);
  return { kind: "extract", field, source, span: ctx.spanFrom(start) };
}

// POSITION(substring IN string). The first operand is a b-expression so the `IN`
// separator is not consumed by the `in` postfix operator.
function parsePosition(ctx: ParseContext<SqlTokenType>, start: Position): Expr {
  const substring = ctx.parse(bExpression);
  ctx.parse(kw("in"));
  const string = ctx.parse(expression);
  expectClose(ctx);
  return { kind: "position", substring, string, span: ctx.spanFrom(start) };
}

// TRIM([LEADING|TRAILING|BOTH] [characters] FROM source), or the short TRIM(x).
function parseTrim(ctx: ParseContext<SqlTokenType>, start: Position): Expr {
  const side = ctx.is("ident", ["leading", "trailing", "both"])
    ? (ctx.next()!.value as "leading" | "trailing" | "both")
    : null;
  let characters: Expr | null = null;
  let source: Expr;
  if (ctx.eat("ident", "from") !== null) {
    source = ctx.parse(expression); // e.g. TRIM(BOTH FROM x)
  } else {
    const first = ctx.parse(expression);
    if (ctx.eat("ident", "from") !== null) {
      characters = first; // TRIM([side] chars FROM source)
      source = ctx.parse(expression);
    } else {
      source = first; // TRIM(x)
    }
  }
  expectClose(ctx);
  return { kind: "trim", side, characters, source, span: ctx.spanFrom(start) };
}

// ROW(a, b, …) — an explicit row constructor (may be empty).
function parseRow(ctx: ParseContext<SqlTokenType>, start: Position): Expr {
  const items: Expr[] = [];
  if (!ctx.is("punc", ")")) {
    items.push(ctx.parse(expression));
    while (ctx.is("punc", ",")) {
      ctx.next(); // ","
      items.push(ctx.parse(expression));
    }
  }
  expectClose(ctx);
  return { kind: "row", items, span: ctx.spanFrom(start) };
}

// SUBSTRING(value FROM from FOR for_) — or the ordinary comma form
// SUBSTRING(x, y, z), which falls through to a plain call node.
function parseSubstring(ctx: ParseContext<SqlTokenType>, start: Position): Expr {
  const value = ctx.parse(expression);
  if (ctx.is("ident", "from") || ctx.is("ident", "for")) {
    const from = ctx.eat("ident", "from") !== null ? ctx.parse(expression) : null;
    const for_ = ctx.eat("ident", "for") !== null ? ctx.parse(expression) : null;
    expectClose(ctx);
    return { kind: "substring", value, from, for_, span: ctx.spanFrom(start) };
  }
  const args: Expr[] = [value];
  while (ctx.is("punc", ",")) {
    ctx.next(); // ","
    args.push(ctx.parse(functionArg));
  }
  expectClose(ctx);
  return { kind: "call", name: "substring", args, span: ctx.spanFrom(start) };
}

const SPECIAL_CALLS: Record<string, (ctx: ParseContext<SqlTokenType>, start: Position) => Expr> = {
  extract: parseExtract,
  position: parsePosition,
  trim: parseTrim,
  row: parseRow,
  substring: parseSubstring,
};

// --- window functions ---
// `fn(…)` may carry, in order, `WITHIN GROUP (ORDER BY …)`, `FILTER (WHERE …)`,
// and `OVER (…)` / `OVER name`. These are attached in columnRef's call branch (so
// the keywords stay unreserved and are only recognised right after a call's `)`),
// each nesting around the previous. The frame / partition / order pieces reuse
// the DML clause rules declared further down — safe because these helpers only
// run at parse time, long after those consts are initialised.

// The words that lead a window clause inside `OVER (…)`; a leading token that is
// none of them (and not `)`) is the referenced base-window name.
const WINDOW_CLAUSE_LEADS: ReadonlySet<string> = new Set(["partition", "order", "rows", "range", "groups"]);

// One frame bound: UNBOUNDED PRECEDING/FOLLOWING, CURRENT ROW, or `offset
// PRECEDING/FOLLOWING`. The offset is a full expression; `preceding`/`following`
// are unreserved and stop it (they are not operators), so no bp juggling.
function parseFrameBound(ctx: ParseContext<SqlTokenType>): WindowFrameBound {
  if (ctx.eat("ident", "unbounded") !== null) {
    if (ctx.eat("ident", "preceding") !== null) return { kind: "unboundedPreceding" };
    ctx.parse(kw("following"));
    return { kind: "unboundedFollowing" };
  }
  if (ctx.is("ident", "current")) {
    ctx.parse(kwseq("current", "row"));
    return { kind: "currentRow" };
  }
  const offset = ctx.parse(expression);
  if (ctx.eat("ident", "preceding") !== null) return { kind: "preceding", offset };
  ctx.parse(kw("following"));
  return { kind: "following", offset };
}

// `{ROWS|RANGE|GROUPS} bound` or `… BETWEEN start AND end`. Entered positioned on
// the mode word.
function parseFrame(ctx: ParseContext<SqlTokenType>): WindowFrame {
  const mode = ctx.next()!.value as "rows" | "range" | "groups";
  if (ctx.eat("ident", "between") !== null) {
    const start = parseFrameBound(ctx);
    ctx.parse(kw("and"));
    const end = parseFrameBound(ctx);
    return { mode, start, end };
  }
  return { mode, start: parseFrameBound(ctx), end: null };
}

// A window specification: a bare `name` reference, or a parenthesised inline spec
// (which may itself open with a base-window name). Shared by `OVER …` and the
// `WINDOW w AS (…)` clause, so it is a Rule (combinator call sites use it too).
const overSpecRule = custom<WindowSpec, SqlTokenType>(
  (ctx) => {
    if (!ctx.is("punc", "(")) {
      const name = ctx.parse(nameWord); // OVER name
      return { name, partitionBy: null, orderBy: null, frame: null };
    }
    ctx.next(); // "("
    let name: string | null = null;
    const head = ctx.peek();
    if (head !== null && (head.type === "qident" || (head.type === "ident" && !WINDOW_CLAUSE_LEADS.has(head.value)))) {
      name = ctx.parse(nameWord);
    }
    let partitionBy: Expr[] | null = null;
    if (ctx.is("ident", "partition")) {
      ctx.parse(kwseq("partition", "by"));
      partitionBy = ctx.parse(sepBy(expression, P(",")));
    }
    const orderBy = ctx.is("ident", "order") ? ctx.parse(orderByClause) : null;
    const frame = ctx.is("ident", ["rows", "range", "groups"]) ? parseFrame(ctx) : null;
    expectClose(ctx);
    return { name, partitionBy, orderBy, frame };
  },
  {
    expected: "a window specification",
    first: [{ type: "punc", value: "(" }, { type: "ident" }, { type: "qident" }],
  },
);

// Attach any trailing WITHIN GROUP / FILTER / OVER modifiers to a freshly-parsed
// call node. Each is optional and guarded by a peek so the unreserved lead words
// (`within`, `filter`, `over`) still work as plain aliases / names when they are
// not actually starting a modifier (`count(*) filter` reads `filter` as an alias).
function applyCallModifiers(ctx: ParseContext<SqlTokenType>, fn: Expr, start: Position): Expr {
  let result = fn;
  if (ctx.is("ident", "within") && ctx.peekAhead(1)?.value === "group") {
    ctx.parse(kwseq("within", "group"));
    if (!ctx.is("punc", "(")) ctx.croak(`Expected "(" but found ${describeFound(ctx.peek())}`);
    ctx.next(); // "("
    const orderBy = ctx.parse(orderByClause);
    expectClose(ctx);
    result = { kind: "withinGroup", fn: result, orderBy, span: ctx.spanFrom(start) };
  }
  const filterNext = ctx.peekAhead(1);
  if (ctx.is("ident", "filter") && filterNext?.type === "punc" && filterNext.value === "(") {
    ctx.next(); // filter
    ctx.next(); // "("
    ctx.parse(kw("where"));
    const where = ctx.parse(expression);
    expectClose(ctx);
    result = { kind: "aggFilter", fn: result, where, span: ctx.spanFrom(start) };
  }
  if (ctx.is("ident", "over")) {
    const after = ctx.peekAhead(1);
    const startsSpec =
      after !== null &&
      ((after.type === "punc" && after.value === "(") ||
        after.type === "qident" ||
        (after.type === "ident" && !RESERVED.has(after.value)));
    if (startsSpec) {
      ctx.next(); // over
      const spec = ctx.parse(overSpecRule);
      result = { kind: "window", fn: result, ...spec, span: ctx.spanFrom(start) };
    }
  }
  return result;
}

// A dotted name, optionally a trailing `.*` (→ star) or a `(args)` call. One
// custom rule (no attempt): walk the `name (. name)*` chain, then dispatch on
// whether `.*` / `(` follows. Subsumes the old nameOrCall — `s.t.c`, `foo(a,b)`,
// `now()`, and now `t.*`, `count(*)`, `count(distinct x)`. Also the entry point
// for `INTERVAL 'literal' [field]` (an unreserved word that leads a literal) and
// the keyword-argument functions in SPECIAL_CALLS.
const columnRef = custom<Expr, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    // INTERVAL 'literal' [field] — only when a string literal follows; otherwise
    // `interval` is an ordinary (unreserved) name and falls through below.
    if (ctx.is("ident", "interval") && ctx.peekAhead(1)?.type === "string") {
      ctx.next(); // interval
      const value = ctx.next()!.value; // the string literal
      const units: string[] = [];
      while (ctx.peek()?.type === "ident" && INTERVAL_FIELDS.has(ctx.peek()!.value)) {
        units.push(ctx.next()!.value);
      }
      return {
        kind: "interval",
        value,
        ...(units.length > 0 && { fields: units.join(" ") }),
        span: ctx.spanFrom(start),
      };
    }
    const parts: string[] = [ctx.parse(nameWord)];
    while (ctx.is("punc", ".")) {
      ctx.next(); // "."
      if (ctx.is("op", "*")) {
        ctx.next(); // "*"
        return { kind: "star", table: parts, span: ctx.spanFrom(start) };
      }
      parts.push(ctx.parse(nameWord));
    }
    if (ctx.is("punc", "(")) {
      ctx.next(); // "("
      // A keyword-argument function (EXTRACT / POSITION / TRIM / ROW / SUBSTRING)
      // owns the rest of the call; a plain name falls through to a normal call.
      const special = parts.length === 1 ? SPECIAL_CALLS[parts[0]!] : undefined;
      if (special !== undefined) return special(ctx, start);
      // PG allows a leading DISTINCT in an aggregate call; accepted but not
      // recorded (the call AST is intentionally unchanged from the DDL era).
      ctx.eat("ident", "distinct");
      const args: Expr[] = [];
      if (!ctx.is("punc", ")")) {
        args.push(ctx.parse(functionArg));
        while (ctx.is("punc", ",")) {
          ctx.next(); // ","
          args.push(ctx.parse(functionArg));
        }
      }
      if (!ctx.is("punc", ")")) ctx.croak(`Expected ")" but found ${describeFound(ctx.peek())}`);
      ctx.next(); // ")"
      const call: Expr = { kind: "call", name: parts.join("."), args, span: ctx.spanFrom(start) };
      // Trailing WITHIN GROUP / FILTER / OVER window modifiers, if any.
      return applyCallModifiers(ctx, call, start);
    }
    return { kind: "name", parts, span: ctx.spanFrom(start) };
  },
  { expected: "a name", first: [{ type: "ident" }, { type: "qident" }] },
);

// CASE [operand] (WHEN e THEN e)+ [ELSE e] END. Written as custom() because the
// optional operand shares the `ident` first set with WHEN — a plain
// optional(expression) would fire on `when` and croak inside nameWord.
const caseExpr = custom<Expr, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    ctx.parse(kw("case"));
    const operand = ctx.is("ident", "when") ? null : ctx.parse(expression);
    const whens: { when: Expr; then_: Expr }[] = [];
    do {
      ctx.parse(kw("when"));
      const when = ctx.parse(expression);
      ctx.parse(kw("then"));
      const then_ = ctx.parse(expression);
      whens.push({ when, then_ });
    } while (ctx.is("ident", "when"));
    const else_ = ctx.eat("ident", "else") !== null ? ctx.parse(expression) : null;
    ctx.parse(kw("end"));
    return { kind: "case", operand, whens, else_, span: ctx.spanFrom(start) };
  },
  { expected: '"case"', first: [{ type: "ident", value: "case" }] },
);

// EXISTS (query). Negation (NOT EXISTS) is folded in by the `not` prefix below,
// so this atom only builds the positive form.
const existsExpr = seq(skip(kw("exists")), field("query", parenQuery)).map(
  ({ query: q }, span): Expr => ({ kind: "exists", query: q, negated: false, span }),
);

// `(` dispatches on the token past it: a scalar subquery vs a parenthesised
// expression. The alterAction custom rule (below) is the peekAhead template.
const subqueryExpr = parenQuery.map((q, span): Expr => ({ kind: "subquery", query: q, span }));
const parenOrSubquery = custom<Expr, SqlTokenType>(
  (ctx) => (isSubqueryParen(ctx) ? ctx.parse(subqueryExpr) : ctx.parse(parenExpr)),
  { expected: '"("', first: [{ type: "punc", value: "(" }] },
);

// A positional / named bind parameter (`$1`, `$name`) — a dedicated token.
const paramLit = token("param").map((node, span): Expr => ({ kind: "param", name: node.value, span }));

// CAST(expr AS type) — the function-call spelling of the `::` cast, producing the
// same `cast` node. `cast` is reserved, so it can only reach here (never a name).
const castExpr = seq(
  skip(kw("cast")),
  skip(punc("(")),
  field("expr", expression),
  skip(kw("as")),
  field(
    "type",
    lazy(() => typeRef),
  ),
  skip(punc(")")),
).map(({ expr, type }, span): Expr => ({ kind: "cast", expr, type, span }));

// ARRAY[…] constructor. `array` is reserved, so this atom owns the keyword; the
// element list may be empty (`ARRAY[]`).
const arrayExpr = seq(
  skip(kw("array")),
  field("elements", delimited(P("["), P("]"), P(","), expression, { interleaved: true })),
).map(({ elements }, span): Expr => ({ kind: "array", elements, span }));

const atom = oneOf(
  numberLit,
  stringLit,
  boolLit,
  nullLit,
  paramLit,
  caseExpr,
  existsExpr,
  castExpr,
  arrayExpr,
  parenOrSubquery,
  columnRef,
);

// --- data types ---
// A type name with optional `(args)` (varchar(10), numeric(10,2)) and an array
// suffix (`int[]`, `text[][]`). Array dims are collapsed to a boolean.
const typeArg = token("number").map((node) => Number(node.value));
const arraySuffix = custom<boolean, SqlTokenType>(
  (ctx) => {
    let seen = false;
    while (ctx.is("punc", "[")) {
      ctx.next(); // "["
      ctx.eat("number"); // optional dimension size, e.g. [3]
      if (!ctx.is("punc", "]")) ctx.croak(`Expected "]" but found ${describeFound(ctx.peek())}`);
      ctx.next(); // "]"
      seen = true;
    }
    return seen;
  },
  { expected: '"["', first: [{ type: "punc", value: "[" }] },
);
const typeRef = seq(
  field(
    "name",
    qualName.map((parts) => parts.join(".")),
  ),
  field("args", optional(delimited(P("("), P(")"), P(","), typeArg, { interleaved: true }))),
  field("array", arraySuffix),
).map(({ name, args, array }, span): ColType => ({ name, args: args ?? [], array, span }));

// --- pratt operator table ---
// Binding powers follow PG (highest binds tightest): :: cast, unary -, * /,
// + -, other operators (|| @>), BETWEEN/IN/LIKE, comparisons (nonassoc), IS,
// NOT, AND, OR. Keyword operators are plain `ident`-typed matches thanks to
// folding; multi-word ones (NOT LIKE, BETWEEN … AND) use match-based groups.
const binary = (ops: string[], bp: number, assoc?: "nonassoc") => ({
  ops,
  bp,
  type: "op" as const,
  assoc,
  map: (op: string, left: Expr, right: Expr, span: Span): Expr => ({ kind: "binary", op, left, right, span }),
});

// AND / OR are `ident`-typed exact matches (folding makes them exact); a plain
// `ops` group, distinct from `binary`'s "op"-typed symbol operators.
const kwBinary = (op: string, bp: number) => ({
  ops: [op],
  bp,
  type: "ident" as const,
  map: (_op: string, left: Expr, right: Expr, span: Span): Expr => ({ kind: "binary", op, left, right, span }),
});

const closeSpan = (left: Expr, end: Span["end"]): Span => ({ start: left.span.start, end });

// `IN (…)` tail, shared by the postfix `in` and the `not in` branch: a
// `(SELECT …)` builds an inSubquery node, anything else the list-valued `in`.
const inTail = (ctx: ParseContext<SqlTokenType>, left: Expr, negated: boolean): Expr => {
  if (isSubqueryParen(ctx)) {
    const q = ctx.parse(parenQuery);
    return { kind: "inSubquery", expr: left, query: q, negated, span: closeSpan(left, ctx.lastEnd()) };
  }
  const list = ctx.parse(exprList);
  return { kind: "in", expr: left, list, negated, span: closeSpan(left, ctx.lastEnd()) };
};

// The optional `ESCAPE x` tail shared by LIKE / ILIKE / SIMILAR TO. Returns the
// escape expression, or undefined when no ESCAPE follows (so the node omits the
// key entirely). Bound at bp 11 like the pattern itself, above the loose logical
// operators. `escape` is unreserved, matched by value.
const escapeTail = (ctx: ParseContext<SqlTokenType>, h: PrattHelpers<Expr>): Expr | undefined =>
  ctx.eat("ident", "escape") !== null ? h.parseRhs(11) : undefined;

// --- shared pratt groups (reused by the full expression rule and the b-expr) ---
const unaryMinusPrefix = {
  ops: ["-"],
  type: "op" as const,
  bp: 16,
  map: (op: string, operand: Expr, span: Span): Expr => ({ kind: "unary", op, operand, span }),
};

// The tight arithmetic / concat / JSON-and-regex tier (bp ≥ 12) — everything
// above the comparison/logical forms. Shared verbatim with the b-expression.
const arithInfix = [
  binary(["*", "/"], 14),
  binary(["+", "-"], 13),
  binary(["||"], 12),
  binary(["@>"], 12),
  // JSON/JSONB access & containment (`-> ->> #> #>> #-`, existence `? ?| ?&`,
  // `<@`), POSIX regex (`~ !~ ~* !~*`) and full-text match (`@@`). All lex as
  // single `op` tokens already; they share the bp-12 "other operators" tier
  // with `||`/`@>` and are left-associative, so `a -> 'k' ->> 'j'` nests left.
  binary(["->", "->>", "#>", "#>>", "#-", "?", "?|", "?&", "<@", "~", "!~", "~*", "!~*", "@@"], 12),
];

// `::` cast and `[…]` subscript bind tightest (bp 18). Both are shared with the
// b-expression so `POSITION(a[1]::text IN b)` parses its first operand fully.
const castPostfix = {
  match: punc("::"),
  bp: 18,
  parse: (ctx: ParseContext<SqlTokenType>, left: Expr): Expr => {
    ctx.next(); // "::"
    const type = ctx.parse(typeRef);
    return { kind: "cast", expr: left, type, span: closeSpan(left, ctx.lastEnd()) };
  },
};

// `a[i]` element access and `a[lo:hi]` slice. A `:` marks a slice; either bound
// may be omitted (`a[:hi]`, `a[lo:]`). The non-slice form omits the `upper` key.
const subscriptPostfix = {
  match: punc("["),
  bp: 18,
  parse: (ctx: ParseContext<SqlTokenType>, left: Expr): Expr => {
    ctx.next(); // "["
    const hasIndex = !ctx.is("punc", ":") && !ctx.is("punc", "]");
    const index = hasIndex ? ctx.parse(expression) : null;
    let upper: Expr | null | undefined;
    if (ctx.is("punc", ":")) {
      ctx.next(); // ":"
      upper = ctx.is("punc", "]") ? null : ctx.parse(expression);
    }
    if (!ctx.is("punc", "]")) ctx.croak(`Expected "]" but found ${describeFound(ctx.peek())}`);
    ctx.next(); // "]"
    return upper === undefined
      ? { kind: "subscript", base: left, index, span: closeSpan(left, ctx.lastEnd()) }
      : { kind: "subscript", base: left, index, upper, span: closeSpan(left, ctx.lastEnd()) };
  },
};

// `x COLLATE collation` and `x AT TIME ZONE zone` — postfixes near the cast tier.
const collatePostfix = {
  match: kw("collate"),
  bp: 18,
  parse: (ctx: ParseContext<SqlTokenType>, left: Expr): Expr => {
    ctx.parse(kw("collate"));
    const collation = ctx.parse(qualName);
    return { kind: "collate", expr: left, collation, span: closeSpan(left, ctx.lastEnd()) };
  },
};
const atTimeZonePostfix = {
  match: kw("at"),
  bp: 18,
  parse: (ctx: ParseContext<SqlTokenType>, left: Expr, h: PrattHelpers<Expr>): Expr => {
    ctx.parse(kwseq("at", "time", "zone"));
    const zone = h.parseRhs(18);
    return { kind: "atTimeZone", expr: left, zone, span: closeSpan(left, ctx.lastEnd()) };
  },
};

const expressionRule = pratt<Expr, SqlTokenType>({
  atom,
  prefix: [
    unaryMinusPrefix,
    {
      ops: ["not"],
      type: "ident",
      bp: 6,
      // `NOT EXISTS (…)` folds into the exists node's `negated` flag rather than
      // wrapping it — mirroring how NOT IN / NOT LIKE carry their own negation.
      map: (_op, operand, span): Expr =>
        operand.kind === "exists"
          ? { kind: "exists", query: operand.query, negated: !operand.negated, span }
          : { kind: "unary", op: "not", operand, span },
    },
  ],
  infix: [
    ...arithInfix,
    {
      // LIKE / ILIKE / SIMILAR TO. RHS at bp 11 keeps it out of the looser
      // comparison level; an optional `ESCAPE x` tail follows the pattern.
      match: token("ident", { values: ["like", "ilike", "similar"] }),
      bp: 10,
      parse: (ctx, left, h): Expr => {
        const op = ctx.next()!.value;
        if (op === "similar") {
          ctx.parse(kw("to"));
          const pattern = h.parseRhs(11);
          const esc = escapeTail(ctx, h);
          return {
            kind: "similarTo",
            expr: left,
            pattern,
            negated: false,
            ...(esc !== undefined && { escape: esc }),
            span: closeSpan(left, ctx.lastEnd()),
          };
        }
        const pattern = h.parseRhs(11);
        const esc = escapeTail(ctx, h);
        return {
          kind: "like",
          expr: left,
          pattern,
          negated: false,
          ci: op === "ilike",
          ...(esc !== undefined && { escape: esc }),
          span: closeSpan(left, ctx.lastEnd()),
        };
      },
    },
    {
      // BETWEEN lo AND hi — the internal AND is recursed past at bp 11 (above
      // AND's own bp) and then consumed explicitly, so no ambiguity machinery.
      match: kw("between"),
      bp: 10,
      parse: (ctx, left, h): Expr => {
        ctx.parse(kw("between"));
        const lo = h.parseRhs(11);
        ctx.parse(kw("and"));
        const hi = h.parseRhs(11);
        return { kind: "between", expr: left, lo, hi, negated: false, span: closeSpan(left, ctx.lastEnd()) };
      },
    },
    {
      // NOT LIKE / NOT ILIKE / NOT BETWEEN / NOT IN all share the leading `not`
      // token, so per the pratt contract they are one group dispatching
      // internally on the following word.
      match: kw("not"),
      bp: 10,
      parse: (ctx, left, h): Expr => {
        ctx.parse(kw("not"));
        if (ctx.is("ident", ["like", "ilike"])) {
          const op = ctx.next()!.value;
          const pattern = h.parseRhs(11);
          const esc = escapeTail(ctx, h);
          return {
            kind: "like",
            expr: left,
            pattern,
            negated: true,
            ci: op === "ilike",
            ...(esc !== undefined && { escape: esc }),
            span: closeSpan(left, ctx.lastEnd()),
          };
        }
        if (ctx.is("ident", "similar")) {
          ctx.parse(kwseq("similar", "to"));
          const pattern = h.parseRhs(11);
          const esc = escapeTail(ctx, h);
          return {
            kind: "similarTo",
            expr: left,
            pattern,
            negated: true,
            ...(esc !== undefined && { escape: esc }),
            span: closeSpan(left, ctx.lastEnd()),
          };
        }
        if (ctx.is("ident", "between")) {
          ctx.next();
          const lo = h.parseRhs(11);
          ctx.parse(kw("and"));
          const hi = h.parseRhs(11);
          return { kind: "between", expr: left, lo, hi, negated: true, span: closeSpan(left, ctx.lastEnd()) };
        }
        if (ctx.is("ident", "in")) {
          ctx.next();
          return inTail(ctx, left, true);
        }
        return ctx.croak(
          `Expected "like", "ilike", "similar", "between" or "in" after "not" but found ${describeFound(ctx.peek())}`,
        );
      },
    },
    // Same-precedence comparisons in one nonassoc group: `a < b < c` errors,
    // `(a < b) < c` parses. A custom parse so the RHS can be quantified with
    // ANY / ALL / SOME (`x = ANY (array|subquery)`); otherwise it builds the
    // ordinary binary node with a bp-10 RHS (nonassoc = bp + 1).
    {
      ops: ["<", ">", "<=", ">=", "=", "<>", "!="],
      bp: 9,
      type: "op",
      assoc: "nonassoc",
      parse: (ctx, left, h): Expr => {
        const op = ctx.next()!.value;
        if (ctx.is("ident", ["any", "all", "some"])) {
          const quantifier = ctx.next()!.value as "any" | "all" | "some";
          const right = ctx.parse(parenOrSubquery);
          return { kind: "anyAll", op, quantifier, left, right, span: closeSpan(left, ctx.lastEnd()) };
        }
        const right = h.parseRhs(10);
        return { kind: "binary", op, left, right, span: closeSpan(left, ctx.lastEnd()) };
      },
    },
    kwBinary("and", 4),
    kwBinary("or", 2),
  ],
  postfix: [
    castPostfix,
    subscriptPostfix,
    collatePostfix,
    atTimeZonePostfix,
    {
      match: kw("is"),
      bp: 8,
      parse: (ctx, left, h): Expr => {
        ctx.parse(kw("is"));
        const negated = ctx.eat("ident", "not") !== null;
        // IS [NOT] DISTINCT FROM x — the RHS binds like a comparison operand
        // (bp 9), so it stops before AND / OR but past tighter operators.
        if (ctx.is("ident", "distinct")) {
          ctx.parse(kwseq("distinct", "from"));
          const from = h.parseRhs(9);
          return { kind: "isDistinct", expr: left, from, negated, span: closeSpan(left, ctx.lastEnd()) };
        }
        // IS [NOT] TRUE / FALSE / UNKNOWN.
        if (ctx.is("ident", ["true", "false", "unknown"])) {
          const test = ctx.next()!.value as "true" | "false" | "unknown";
          return { kind: "isTest", expr: left, test, negated, span: closeSpan(left, ctx.lastEnd()) };
        }
        // IS [NOT] NULL.
        ctx.parse(kw("null"));
        return { kind: "is", expr: left, negated, span: closeSpan(left, ctx.lastEnd()) };
      },
    },
    {
      match: kw("in"),
      bp: 10,
      parse: (ctx, left): Expr => {
        ctx.parse(kw("in"));
        return inTail(ctx, left, false);
      },
    },
  ],
});

// The b-expression: the tight sublanguage (arithmetic / concat / JSON / cast /
// subscript) with none of the comparison, IS, IN, LIKE, BETWEEN or logical
// forms — see `bExpression` above. Used for the first operand of POSITION so its
// `IN` separator is left for the special-call parser instead of the `in` postfix.
const bExprRule = pratt<Expr, SqlTokenType>({
  atom,
  prefix: [unaryMinusPrefix],
  infix: arithInfix,
  postfix: [castPostfix, subscriptPostfix],
});

// --- constraints ---

const columnList = delimited(P("("), P(")"), P(","), nameWord, { interleaved: true });

const onDeleteAction = seq(
  skip(kwseq("on", "delete")),
  field("action", oneOf(kw("cascade"), kw("restrict"), kwseq("set", "null"))),
).map(({ action }) => action.value);

const columnConstraint = oneOf(
  kwseq("not", "null").map((_node, span): ColConstraint => ({ kind: "notNull", span })),
  kw("null").map((_node, span): ColConstraint => ({ kind: "nullable", span })),
  seq(skip(kw("default")), field("expr", expression)).map(
    ({ expr }, span): ColConstraint => ({ kind: "default", expr, span }),
  ),
  kwseq("primary", "key").map((_node, span): ColConstraint => ({ kind: "primaryKey", span })),
  kw("unique").map((_node, span): ColConstraint => ({ kind: "unique", span })),
  seq(
    skip(kw("references")),
    field("table", qualName),
    field("columns", optional(columnList)),
    field("onDelete", optional(onDeleteAction)),
  ).map(
    ({ table, columns, onDelete }, span): ColConstraint => ({ kind: "references", table, columns, onDelete, span }),
  ),
  seq(skip(kw("check")), field("expr", parenExpr)).map(
    ({ expr }, span): ColConstraint => ({ kind: "check", expr, span }),
  ),
);

const tableConstraintBody = oneOf(
  seq(skip(kwseq("primary", "key")), field("columns", columnList)).map(
    ({ columns }, span): TableConstraint => ({ kind: "primaryKey", name: null, columns, span }),
  ),
  seq(skip(kw("unique")), field("columns", columnList)).map(
    ({ columns }, span): TableConstraint => ({ kind: "unique", name: null, columns, span }),
  ),
  seq(skip(kw("check")), field("expr", parenExpr)).map(
    ({ expr }, span): TableConstraint => ({ kind: "check", name: null, expr, span }),
  ),
  seq(
    skip(kwseq("foreign", "key")),
    field("columns", columnList),
    skip(kw("references")),
    field("refTable", qualName),
    field("refColumns", optional(columnList)),
    field("onDelete", optional(onDeleteAction)),
  ).map(
    ({ columns, refTable, refColumns, onDelete }, span): TableConstraint => ({
      kind: "foreignKey",
      name: null,
      columns,
      refTable,
      refColumns,
      onDelete,
      span,
    }),
  ),
);

const namedConstraint = seq(skip(kw("constraint")), field("name", nameWord), field("body", tableConstraintBody)).map(
  ({ name, body }): TableConstraint => ({ ...body, name }),
);

const tableConstraint = oneOf(namedConstraint, tableConstraintBody);

const columnDef = seq(
  field("name", nameWord),
  field("dataType", typeRef),
  field("constraints", many(columnConstraint)),
).map(({ name, dataType, constraints }, span): ColumnDef => ({ kind: "column", name, dataType, constraints, span }));

// A table body item: a table constraint (keyword-led, value-specific first set)
// or a column definition (name-led, type-only first set). oneOf's
// value-specific-first dispatch picks the constraint on `primary`/`unique`/… and
// the column on any other name, with no ambiguity.
const tableItem = oneOf(tableConstraint, columnDef);

// --- statements ---

const createTableRest = seq(
  skip(kw("table")),
  // attempt() so a typo'd `IF NOT EXIST` backtracks to try a table name rather
  // than hard-committing — the vector the farthest-failure test exploits.
  field(
    "ifNotExists",
    optional(attempt(kwseq("if", "not", "exists"))).map((x) => x !== null),
  ),
  field("name", qualName),
  field("items", delimited(P("("), P(")"), P(","), tableItem, { interleaved: true, recover: true })),
).map(({ ifNotExists, name, items }, span): Stmt => ({ kind: "createTable", ifNotExists, name, items, span }));

const createIndexRest = seq(
  field(
    "unique",
    optional(kw("unique")).map((x) => x !== null),
  ),
  skip(kw("index")),
  // The index name is optional; `attempt` lets it backtrack when `on` follows
  // instead (an `on` ident matches the type-only first set but is reserved).
  field("name", optional(attempt(nameWord))),
  skip(kw("on")),
  field("table", qualName),
  field("using", optional(seq(skip(kw("using")), field("m", nameWord)).map((s) => s.m))),
  field("columns", exprList),
  field("where", optional(seq(skip(kw("where")), field("e", expression)).map((s) => s.e))),
).map(
  ({ unique, name, table, using, columns, where }, span): Stmt => ({
    kind: "createIndex",
    unique,
    name,
    table,
    using,
    columns,
    where,
    span,
  }),
);

const createTypeRest = seq(
  skip(kw("type")),
  field("name", qualName),
  skip(kwseq("as", "enum")),
  field(
    "values",
    delimited(
      P("("),
      P(")"),
      P(","),
      token("string").map((n) => n.value),
      { interleaved: true },
    ),
  ),
).map(({ name, values }, span): Stmt => ({ kind: "createType", name, values, span }));

// After CREATE, dispatch on the next word: TABLE, [UNIQUE] INDEX, or TYPE.
const createStmt = seq(skip(kw("create")), field("body", oneOf(createTableRest, createIndexRest, createTypeRest))).map(
  ({ body }) => body,
);

// ALTER's action is dispatched with a one-token peekAhead: `ADD [COLUMN] …` vs
// `ADD [CONSTRAINT name] …` vs a bare table constraint all begin with `add`, and
// looking at the word *after* it decides the shape before anything is consumed.
const alterAction = custom<AlterAction, SqlTokenType>(
  (ctx) => {
    const head = ctx.peek();
    if (head !== null && head.type === "ident" && head.value === "add") {
      const after = ctx.peekAhead(1);
      ctx.next(); // ADD
      if (after?.value === "column") {
        ctx.next(); // COLUMN
        return { kind: "addColumn", column: ctx.parse(columnDef) };
      }
      if (after?.value === "constraint") {
        ctx.next(); // CONSTRAINT
        const name = ctx.parse(nameWord);
        return { kind: "addConstraint", name, constraint: ctx.parse(tableConstraintBody) };
      }
      if (after !== null && ["primary", "unique", "check", "foreign"].includes(after.value)) {
        return { kind: "addConstraint", name: null, constraint: ctx.parse(tableConstraintBody) };
      }
      return { kind: "addColumn", column: ctx.parse(columnDef) };
    }
    if (head !== null && head.type === "ident" && head.value === "drop") {
      ctx.next(); // DROP
      ctx.eat("ident", "column"); // optional COLUMN
      return { kind: "dropColumn", name: ctx.parse(nameWord) };
    }
    if (head !== null && head.type === "ident" && head.value === "alter") {
      ctx.next(); // ALTER
      ctx.eat("ident", "column"); // optional COLUMN
      const column = ctx.parse(nameWord);
      if (ctx.is("ident", "set")) {
        ctx.parse(kwseq("set", "default"));
        return { kind: "setDefault", column, expr: ctx.parse(expression) };
      }
      ctx.parse(kwseq("drop", "default"));
      return { kind: "dropDefault", column };
    }
    return ctx.croak(`Expected "add", "drop" or "alter" but found ${describeFound(ctx.peek())}`);
  },
  {
    expected: '"add", "drop" or "alter"',
    first: [
      { type: "ident", value: "add" },
      { type: "ident", value: "drop" },
      { type: "ident", value: "alter" },
    ],
  },
);

const alterStmt = seq(skip(kw("alter")), skip(kw("table")), field("name", qualName), field("action", alterAction)).map(
  ({ name, action }, span): Stmt => ({ kind: "alterTable", name, action, span }),
);

const dropStmt = seq(
  skip(kw("drop")),
  skip(kw("table")),
  field(
    "ifExists",
    optional(attempt(kwseq("if", "exists"))).map((x) => x !== null),
  ),
  field("names", sepBy(qualName, P(","))),
).map(({ ifExists, names }, span): Stmt => ({ kind: "dropTable", ifExists, names, span }));

const commentStmt = seq(
  skip(kw("comment")),
  skip(kw("on")),
  field(
    "objectType",
    oneOf(kw("table"), kw("column"), kw("index"), kw("type"), kw("schema")).map((n) => n.value),
  ),
  field("name", qualName),
  skip(kw("is")),
  // The comment body flows a dollar-quoted string (`$tag$…$tag$`, one `string`
  // token) through the grammar, or NULL to clear it.
  field(
    "comment",
    oneOf(
      token("string").map((n) => n.value),
      kw("null").map((): string | null => null),
    ),
  ),
).map(({ objectType, name, comment }, span): Stmt => ({ kind: "comment", objectType, name, comment, span }));

// --- DML: shared clause pieces ---

// `[AS] alias`. A custom rule rather than optional(seq(...)) because the
// alias's first set is a bare `ident`, which also matches every following
// clause keyword — so it checks RESERVED directly and stops at a clause/join
// word (that is why `set`, `values`, and the join leads are reserved). A
// quoted identifier is always a name; a bare word only when unreserved.
const asAlias = custom<string | null, SqlTokenType>(
  (ctx) => {
    const hasAs = ctx.eat("ident", "as") !== null;
    const tok = ctx.peek();
    const isName = tok !== null && (tok.type === "qident" || (tok.type === "ident" && !RESERVED.has(tok.value)));
    if (isName) return ctx.parse(nameWord);
    if (hasAs) return ctx.croak(`Expected an alias but found ${describeFound(ctx.peek())}`);
    return null;
  },
  { expected: "an alias", first: [{ type: "ident" }, { type: "qident" }] },
);

const eq = token("op", { values: ["="] });
const assignment = seq(field("column", nameWord), skip(eq), field("value", expression)).map(({ column, value }) => ({
  column,
  value,
}));
const setAssignments = seq(skip(kw("set")), field("items", sepBy(assignment, P(",")))).map((s) => s.items);

const whereClause = seq(skip(kw("where")), field("e", expression)).map((s) => s.e);
const groupByClause = seq(skip(kwseq("group", "by")), field("exprs", sepBy(expression, P(",")))).map((s) => s.exprs);
const havingClause = seq(skip(kw("having")), field("e", expression)).map((s) => s.e);

// `WINDOW w AS (spec), … ` — named window definitions. `overSpecRule` (declared
// with the window helpers above) parses each `(…)` body.
const namedWindowDef = seq(field("name", nameWord), skip(kw("as")), field("spec", overSpecRule)).map(
  ({ name, spec }): NamedWindow => ({ name, spec }),
);
const windowClause = seq(skip(kw("window")), field("defs", sepBy(namedWindowDef, P(",")))).map((s) => s.defs);

const orderItem = seq(
  field("expr", expression),
  field("dir", optional(oneOf(kw("asc"), kw("desc")).map((n) => n.value as "asc" | "desc"))),
  field(
    "nulls",
    optional(
      seq(
        skip(kw("nulls")),
        field(
          "n",
          oneOf(kw("first"), kw("last")).map((n) => n.value as "first" | "last"),
        ),
      ).map((s) => s.n),
    ),
  ),
).map(({ expr, dir, nulls }): OrderItem => ({ expr, dir: dir ?? null, nulls: nulls ?? null }));
const orderByClause = seq(skip(kwseq("order", "by")), field("items", sepBy(orderItem, P(",")))).map((s) => s.items);

// DISTINCT / DISTINCT ON (…) / ALL. Succeeds consuming nothing (→ false) so it
// can sit as a plain field after SELECT.
const distinctClause = custom<boolean | Expr[], SqlTokenType>(
  (ctx) => {
    if (ctx.eat("ident", "all") !== null) return false;
    if (ctx.eat("ident", "distinct") !== null) {
      return ctx.eat("ident", "on") !== null ? ctx.parse(exprList) : true;
    }
    return false;
  },
  {
    expected: '"distinct" or "all"',
    first: [
      { type: "ident", value: "distinct" },
      { type: "ident", value: "all" },
    ],
  },
);

// LIMIT / OFFSET, in either order; `LIMIT ALL` is a null limit.
const limitOffset = custom<{ limit: Expr | null; offset: Expr | null }, SqlTokenType>(
  (ctx) => {
    let limit: Expr | null = null;
    let offset: Expr | null = null;
    for (let i = 0; i < 2; i++) {
      if (ctx.eat("ident", "limit") !== null) {
        limit = ctx.eat("ident", "all") !== null ? null : ctx.parse(expression);
      } else if (ctx.eat("ident", "offset") !== null) {
        offset = ctx.parse(expression);
      } else {
        break;
      }
    }
    return { limit, offset };
  },
  {
    expected: '"limit" or "offset"',
    first: [
      { type: "ident", value: "limit" },
      { type: "ident", value: "offset" },
    ],
  },
);

const selectItem = oneOf(
  bareStar.map((expr): SelectItem => ({ expr, alias: null })),
  seq(field("expr", expression), field("alias", asAlias)).map(({ expr, alias }): SelectItem => ({ expr, alias })),
);
const returningClause = seq(skip(kw("returning")), field("items", sepBy(selectItem, P(",")))).map((s) => s.items);

// --- DML: FROM items and joins ---

const tableNameFromItem = seq(field("name", qualName), field("alias", asAlias)).map(
  ({ name, alias }): FromItem => ({ kind: "table", name, alias }),
);
const subqueryFromItem = seq(skip(punc("(")), field("query", query), skip(punc(")")), field("alias", asAlias)).map(
  ({ query: q, alias }): FromItem => ({ kind: "subquery", query: q, alias }),
);
const tableRef = oneOf(subqueryFromItem, tableNameFromItem);

// Reads an optional join lead — `[NATURAL] [INNER|LEFT|RIGHT|FULL [OUTER]|CROSS]
// JOIN` — consuming the keywords and returning the type, or null (consuming
// nothing) when no JOIN follows. All lead-words are reserved, so this never
// collides with a preceding table's alias.
const readJoin = (ctx: ParseContext<SqlTokenType>): { joinType: FromItemJoinType; natural: boolean } | null => {
  const lead = ctx.peek();
  const leads = ["join", "inner", "left", "right", "full", "cross", "natural"];
  if (lead === null || lead.type !== "ident" || !leads.includes(lead.value)) return null;
  const natural = ctx.eat("ident", "natural") !== null;
  let joinType: FromItemJoinType = "inner";
  if (ctx.eat("ident", "cross") !== null) {
    joinType = "cross";
  } else if (ctx.eat("ident", "inner") !== null) {
    joinType = "inner";
  } else if (ctx.eat("ident", "left") !== null) {
    joinType = "left";
    ctx.eat("ident", "outer");
  } else if (ctx.eat("ident", "right") !== null) {
    joinType = "right";
    ctx.eat("ident", "outer");
  } else if (ctx.eat("ident", "full") !== null) {
    joinType = "full";
    ctx.eat("ident", "outer");
  }
  ctx.parse(kw("join"));
  return { joinType, natural };
};

// One FROM entry and its left-assoc chain of joins. CROSS / NATURAL joins take
// no ON/USING; every other join takes an optional `ON expr` or `USING (cols)`.
const joinTail = custom<FromItem, SqlTokenType>(
  (ctx) => {
    let left = ctx.parse(tableRef);
    while (true) {
      const join = readJoin(ctx);
      if (join === null) break;
      const right = ctx.parse(tableRef);
      let on: Expr | null = null;
      let using: string[] | null = null;
      if (!join.natural && join.joinType !== "cross") {
        if (ctx.eat("ident", "on") !== null) on = ctx.parse(expression);
        else if (ctx.eat("ident", "using") !== null) using = ctx.parse(columnList);
      }
      left = { kind: "join", joinType: join.joinType, left, right, on, using };
    }
    return left;
  },
  {
    expected: "a table reference",
    first: [{ type: "punc", value: "(" }, { type: "ident" }, { type: "qident" }],
  },
);
const fromClause = sepBy(joinTail, P(","));

// --- SELECT core + set-ops + WITH ---

const selectCore = seq(
  skip(kw("select")),
  field("distinct", distinctClause),
  field("columns", sepBy(selectItem, P(","))),
  field("from", optional(seq(skip(kw("from")), field("f", fromClause)).map((s) => s.f))),
  field("where", optional(whereClause)),
  field("groupBy", optional(groupByClause)),
  field("having", optional(havingClause)),
  field("window", optional(windowClause)),
  field("orderBy", optional(orderByClause)),
  field("limitOffset", limitOffset),
).map(
  (
    { distinct, columns, from, where, groupBy, having, window: windowDefs, orderBy, limitOffset: lo },
    span,
  ): SelectStmt => ({
    kind: "select",
    with_: null,
    recursive: false,
    distinct,
    columns,
    from: from ?? null,
    where: where ?? null,
    groupBy: groupBy ?? null,
    having: having ?? null,
    window: windowDefs ?? null,
    orderBy: orderBy ?? null,
    limit: lo.limit,
    offset: lo.offset,
    span,
  }),
);

const cte = seq(
  field("name", nameWord),
  field("columns", optional(columnList)),
  skip(kw("as")),
  skip(punc("(")),
  field("query", query),
  skip(punc(")")),
).map(({ name, columns, query: q }): Cte => ({ name, columns: columns ?? null, query: q }));
const withPrefix = seq(
  skip(kw("with")),
  field(
    "recursive",
    optional(kw("recursive")).map((x) => x !== null),
  ),
  field("ctes", sepBy(cte, P(","))),
).map(({ recursive, ctes }) => ({ recursive, ctes }));

// A set-op term: a plain SELECT core or a parenthesised query.
const selectTerm: Rule<Query, SqlTokenType> = oneOf(
  selectCore,
  seq(skip(punc("(")), field("q", query), skip(punc(")"))).map((s) => s.q),
);

// The set-op layer (left-assoc) over select-terms. Keeping it here — rather than
// as a separate statement — leaves the `(`-dispatch in exactly one place.
const setOpQuery = custom<Query, SqlTokenType>(
  (ctx) => {
    let left = ctx.parse(selectTerm);
    while (true) {
      const t = ctx.peek();
      if (t === null || t.type !== "ident") break;
      let op: SetOpKind;
      if (t.value === "union") {
        ctx.next();
        op = ctx.eat("ident", "all") !== null ? "unionAll" : "union";
      } else if (t.value === "intersect") {
        ctx.next();
        op = ctx.eat("ident", "all") !== null ? "intersectAll" : "intersect";
      } else if (t.value === "except") {
        ctx.next();
        op = ctx.eat("ident", "all") !== null ? "exceptAll" : "except";
      } else {
        break;
      }
      const right = ctx.parse(selectTerm);
      left = { kind: "setOp", op, left, right, span: { start: left.span.start, end: ctx.lastEnd() } };
    }
    return left;
  },
  {
    expected: "a query",
    first: [
      { type: "ident", value: "select" },
      { type: "punc", value: "(" },
    ],
  },
);

// A leading WITH attaches to the leftmost SELECT of the set-op tree.
const attachWith = (q: Query, w: { recursive: boolean; ctes: Cte[] }): void => {
  let node: Query = q;
  while (node.kind === "setOp") node = node.left;
  node.with_ = w.ctes;
  node.recursive = w.recursive;
};
const queryRule = custom<Query, SqlTokenType>(
  (ctx) => {
    const w = ctx.is("ident", "with") ? ctx.parse(withPrefix) : null;
    const q = ctx.parse(setOpQuery);
    if (w !== null) attachWith(q, w);
    return q;
  },
  {
    expected: "a query",
    first: [
      { type: "ident", value: "with" },
      { type: "ident", value: "select" },
      { type: "punc", value: "(" },
    ],
  },
);

// --- INSERT / UPDATE / DELETE ---

const valuesSource = seq(skip(kw("values")), field("rows", sepBy(exprList, P(",")))).map(({ rows }) => ({
  kind: "values" as const,
  rows,
}));
const insertSource = oneOf(
  valuesSource,
  query.map((q) => ({ kind: "select" as const, query: q })),
);

const onConflict = seq(
  skip(kwseq("on", "conflict")),
  field("target", optional(columnList)),
  skip(kw("do")),
  field(
    "action",
    oneOf(
      kw("nothing").map(() => ({ kind: "nothing" as const })),
      seq(skip(kw("update")), field("set", setAssignments), field("where", optional(whereClause))).map(
        ({ set, where }) => ({ kind: "update" as const, set, where: where ?? null }),
      ),
    ),
  ),
).map(({ target, action }): OnConflict => ({ target: target ?? null, action }));

const insertStmt = seq(
  skip(kw("insert")),
  skip(kw("into")),
  field("table", qualName),
  // A `(` here is a column list unless it opens a parenthesised query source;
  // attempt() rolls the column-list read back when the `(` is really a SELECT.
  field("columns", optional(attempt(columnList))),
  field("source", insertSource),
  field("onConflict", optional(onConflict)),
  field("returning", optional(returningClause)),
).map(
  ({ table, columns, source, onConflict: oc, returning }, span): Insert => ({
    kind: "insert",
    table,
    columns: columns ?? null,
    source,
    onConflict: oc ?? null,
    returning: returning ?? null,
    span,
  }),
);

const updateStmt = seq(
  skip(kw("update")),
  field("table", qualName),
  field("alias", asAlias),
  field("set", setAssignments),
  field("from", optional(seq(skip(kw("from")), field("f", fromClause)).map((s) => s.f))),
  field("where", optional(whereClause)),
  field("returning", optional(returningClause)),
).map(
  ({ table, alias, set, from, where, returning }, span): Update => ({
    kind: "update",
    table,
    alias,
    set,
    from: from ?? null,
    where: where ?? null,
    returning: returning ?? null,
    span,
  }),
);

const deleteStmt = seq(
  skip(kw("delete")),
  skip(kw("from")),
  field("table", qualName),
  field("alias", asAlias),
  field("using", optional(seq(skip(kw("using")), field("f", fromClause)).map((s) => s.f))),
  field("where", optional(whereClause)),
  field("returning", optional(returningClause)),
).map(
  ({ table, alias, using, where, returning }, span): Delete => ({
    kind: "delete",
    table,
    alias,
    using: using ?? null,
    where: where ?? null,
    returning: returning ?? null,
    span,
  }),
);

// A top-level query statement (SELECT / WITH / parenthesised set-op).
const queryStmt = query.map((q): Stmt => q);

// First-sets: create/alter/drop/comment/insert/update/delete each dispatch on
// their own keyword; queryStmt owns `select`/`with`/`(` — all disjoint.
const statementBody = oneOf(
  createStmt,
  alterStmt,
  dropStmt,
  commentStmt,
  insertStmt,
  updateStmt,
  deleteStmt,
  queryStmt,
).describe("a statement");
// Each statement owns its trailing `;`; `;` is also the recovery sync point.
const statement = seq(field("stmt", statementBody), skip(punc(";"))).map(({ stmt }) => stmt);

// --- grammar ---

export const sqlLite = defineGrammar({
  lexer: sqlLexer,
  root: repeat(statement),
  trivia: { between: [{ type: "comment" }] },
  recovery: { sync: [{ type: "punc", value: ";", consume: true }] },
  // Opt into PG-style farthest-failure reporting: when a discarded backtracking
  // branch (a mistyped IF NOT EXISTS) got deeper than the error that surfaced,
  // report the deeper one.
  errorReporting: { preferFarthest: true },
});
