import {
  attempt,
  bindTokens,
  custom,
  defineGrammar,
  delimited,
  describeFound,
  type FirstEntry,
  field,
  lazy,
  matchesFirst,
  oneOf,
  optional,
  type ParseContext,
  ParseError,
  type Position,
  type PrattHelpers,
  pratt,
  quoteList,
  type Rule,
  renderLiteral,
  repeat,
  type Span,
  sepBy,
  seq,
  skip,
  type Token,
} from "@parser-kit/core";
import { type SqlTokenType, sqlLexer } from "./lexer";

// SQL-lite parses a slice of PostgreSQL DDL — CREATE [TEMP | UNLOGGED] TABLE (incl. TABLE AS,
// LIKE, INHERITS and the WITH / ON COMMIT / TABLESPACE clauses) / INDEX / TYPE
// (enum, composite, RANGE) / [MATERIALIZED] VIEW / SEQUENCE / DOMAIN, ALTER
// TABLE, DROP family, TRUNCATE, COMMENT ON — plus a DML core — SELECT (with
// WITH / DISTINCT / joins / WHERE / GROUP BY / HAVING / ORDER BY / LIMIT /
// OFFSET / UNION-INTERSECT-EXCEPT) and INSERT / UPDATE / DELETE with
// RETURNING — over the scalar expression sublanguage that DEFAULT / CHECK /
// index / WHERE clauses share. It is the end-to-end test for the PG-grade kit
// features: escaped/prefixed/dollar strings, PG numbers, bind parameters, the
// operator reader, the fold-and-match keyword strategy, match-based and non-associative
// pratt operators, mutual expr↔query recursion via lazy(), and farthest-failure
// / nested recovery. The expression sublanguage also covers the PG special forms
// — CAST / EXTRACT / SUBSTRING / POSITION / TRIM / OVERLAY, ARRAY[…] / ROW(…)
// and the implicit row `(a, b)`, array subscripts & slices, INTERVAL and DATE /
// TIME / TIMESTAMP literals, the niladic keyword functions (CURRENT_DATE,
// CURRENT_USER, …), the COLLATE / AT TIME ZONE postfixes, `row OVERLAPS row`,
// BETWEEN [A]SYMMETRIC and the `IS [NOT] JSON` predicate family — plus window
// functions: `fn(…) [WITHIN GROUP (ORDER BY …)] [IGNORE|RESPECT NULLS] [FILTER
// (WHERE …)] [OVER (…) | OVER name]`, with named windows via a `WINDOW w AS
// (…)` clause. Calls also carry the aggregate modifiers that live *inside* the
// argument list — `count(DISTINCT x)`, `array_agg(a ORDER BY b)` — and PG's
// named-argument notation is accepted in argument position, `f(a => 1)`.
//
// The SELECT surface also carries the remaining query clauses: LATERAL /
// table-function / ROWS FROM / TABLESAMPLE / ONLY FROM items, WITH ORDINALITY,
// parenthesised joins (`(a JOIN b ON …) AS j`), each alias optionally followed
// by a column-alias list (`t AS x (a, b)`), VALUES as a standalone query and
// table source, FETCH FIRST … ROWS, FOR UPDATE/SHARE locking, SELECT … INTO a
// new (optionally TEMP / UNLOGGED) table, and GROUP BY [ALL | DISTINCT] over
// ROLLUP / CUBE / GROUPING SETS and the empty grouping `()`. A WITH prefix may
// lead any DML statement (`WITH … INSERT/UPDATE/DELETE`), and a CTE body may
// itself be data-modifying (`WITH x AS (DELETE … RETURNING …) …`).
//
// A column-alias list is read only after an alias: a bare `FROM t (a, b)` is a
// call to a table function `t`, which is how PG reads it too. Out of scope (v1):
// a function's column-definition list (`f() AS g (n int)`). Ordinary aggregates
// (no OVER / FILTER / WITHIN GROUP / IGNORE-RESPECT NULLS) still parse as plain
// function calls, carrying their DISTINCT / ORDER BY modifiers on the call node
// itself.

// --- AST ---
// Recursive nodes (Expr) are declared by hand, exactly as js-lite does; the
// rules below still produce every value.

export type ColType = { name: string; args: number[]; array: boolean; span: Span };

// A row constructor: the explicit `ROW(…)` (which may be empty, or hold a single
// item) and the implicit `(a, b, …)` (always two items or more — a lone `(a)` is
// just a parenthesised expression). They share a node, but `implicit` (present
// only on the bare spelling) keeps them apart, because PG does not always treat
// them alike: `GROUP BY (a, b)` groups by `a` and `b`, `GROUP BY ROW(a, b)` by
// one composite value. Named on its own so OVERLAPS can require it on both sides.
export type RowExpr = { kind: "row"; items: Expr[]; implicit?: true; span: Span };

export type Expr =
  | { kind: "number"; value: number; span: Span }
  | { kind: "string"; value: string; span: Span }
  | { kind: "bool"; value: boolean; span: Span }
  | { kind: "null"; span: Span }
  | { kind: "name"; parts: string[]; span: Span }
  // `distinct` and `orderBy` are the aggregate modifiers that live inside the
  // argument list (`count(DISTINCT x)`, `array_agg(a ORDER BY b)`); both keys are
  // omitted entirely on a call that has neither.
  | { kind: "call"; name: string; args: Expr[]; distinct?: true; orderBy?: OrderItem[]; span: Span }
  // `name => value` in argument position — PG's named function-call notation.
  | { kind: "namedArg"; name: string; value: Expr; span: Span }
  | { kind: "unary"; op: string; operand: Expr; span: Span }
  | { kind: "binary"; op: string; left: Expr; right: Expr; span: Span }
  | { kind: "cast"; expr: Expr; type: ColType; span: Span }
  | { kind: "is"; expr: Expr; negated: boolean; span: Span }
  // `IS [NOT] DISTINCT FROM x` and `IS [NOT] TRUE/FALSE/UNKNOWN` — companions to
  // the plain `is` node (IS [NOT] NULL), each carrying its own negation flag.
  | { kind: "isDistinct"; expr: Expr; from: Expr; negated: boolean; span: Span }
  | { kind: "isTest"; expr: Expr; test: "true" | "false" | "unknown"; negated: boolean; span: Span }
  // `IS [NOT] JSON [VALUE | SCALAR | ARRAY | OBJECT] [{WITH | WITHOUT} UNIQUE [KEYS]]`.
  // `itemType` is the item-type word as written (null when there is none, which
  // means the same as VALUE); `uniqueKeys` is true for WITH UNIQUE, false for
  // WITHOUT UNIQUE and null when neither is written. The optional KEYS noise word
  // is not recorded.
  | {
      kind: "isJson";
      expr: Expr;
      itemType: "value" | "scalar" | "array" | "object" | null;
      uniqueKeys: boolean | null;
      negated: boolean;
      span: Span;
    }
  // `escape` is present only when an `ESCAPE x` tail follows (LIKE / ILIKE).
  | { kind: "like"; expr: Expr; pattern: Expr; negated: boolean; ci: boolean; escape?: Expr; span: Span }
  // `x [NOT] SIMILAR TO pattern [ESCAPE x]` — a POSIX-ish sibling of LIKE.
  | { kind: "similarTo"; expr: Expr; pattern: Expr; negated: boolean; escape?: Expr; span: Span }
  // `symmetric` is present only when a SYMMETRIC (true) or ASYMMETRIC (false)
  // keyword was written; ASYMMETRIC is the default, so its absence means the same.
  | { kind: "between"; expr: Expr; lo: Expr; hi: Expr; negated: boolean; symmetric?: boolean; span: Span }
  | { kind: "in"; expr: Expr; list: Expr[]; negated: boolean; span: Span }
  // `x <cmp> ANY|ALL|SOME (array|subquery)` — a comparison whose RHS is
  // quantified. `right` is a scalar subquery or a parenthesised array expr (a row
  // only with a second pair of parentheses, `x = ANY ((a, b))`, as in PG).
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
  // `ROW(…)` and the implicit `(a, b, …)` — see RowExpr.
  | RowExpr
  // `(start, end) OVERLAPS (start, end)` — two periods, each a two-item row
  // constructor (either spelling). PG rejects any other arity at parse time, and
  // so does this grammar.
  | { kind: "overlaps"; left: RowExpr; right: RowExpr; span: Span }
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
  | { kind: "withinGroup"; fn: Expr; orderBy: OrderItem[]; span: Span }
  // `fn(…) IGNORE NULLS` / `RESPECT NULLS` — a window function's null treatment.
  // Wraps the call like the other modifiers, nesting inside FILTER / OVER.
  | { kind: "nullTreatment"; fn: Expr; treatment: "ignore" | "respect"; span: Span }
  // --- Phase 10: the remaining literal forms ---
  // PG's bit-string constants, `B'1011'` and `X'ff'`. `value` is the digits as
  // written, case included — so `X'AB'` and `X'ab'` stay distinguishable even
  // though they denote the same bits — and `hex` records which spelling
  // produced them, since the two differ in width per digit rather than in
  // value. The third new literal form, `U&'\0041'`, needs no node: it decodes
  // in the lexer to an ordinary `string` token, exactly as an E-string does.
  | { kind: "bitString"; value: string; hex: boolean; span: Span }
  // --- niladic keyword functions, typed datetime literals and OVERLAY ---
  // `CURRENT_DATE`, `CURRENT_TIMESTAMP(3)`, `USER`, … — the reserved keywords PG
  // evaluates as functions without an argument list (its SQLValueFunction).
  // `precision` is the optional fractional-seconds precision that the four
  // time-valued ones take, omitted when none is written.
  | { kind: "sqlValueFunction"; name: SqlValueFunctionName; precision?: number; span: Span }
  // `DATE '2024-01-01'`, `TIMESTAMP(3) WITH TIME ZONE '…'` — a string literal
  // prefixed by the type it is read as. `type` is the full typeRef node, so the
  // multi-word spellings and the hoisted precision come out exactly as they do
  // in a cast. INTERVAL keeps its own node: its field spec trails the literal.
  | { kind: "typedLiteral"; type: ColType; value: string; span: Span }
  // `OVERLAY(value PLACING placing FROM from [FOR for_])`. The comma spelling,
  // `overlay(a, b, 1)`, stays an ordinary call node.
  | { kind: "overlay"; value: Expr; placing: Expr; from: Expr; for_: Expr | null; span: Span };

// The nine niladic keyword functions. All are reserved words, so none of them
// was usable as a bare name before it became an expression either.
const SQL_VALUE_FUNCTIONS = [
  "current_date",
  "current_time",
  "current_timestamp",
  "localtime",
  "localtimestamp",
  "current_role",
  "current_user",
  "session_user",
  "user",
] as const;
export type SqlValueFunctionName = (typeof SQL_VALUE_FUNCTIONS)[number];

// One bound of a window frame (`ROWS/RANGE/GROUPS` extent). `preceding` /
// `following` carry the offset expression; the others are nullary.
export type WindowFrameBound =
  | { kind: "unboundedPreceding" }
  | { kind: "preceding"; offset: Expr }
  | { kind: "currentRow" }
  | { kind: "following"; offset: Expr }
  | { kind: "unboundedFollowing" };

// A frame clause: a mode plus one bound, or a `BETWEEN start AND end` pair
// (`end` null for the single-bound `ROWS start` shorthand). `exclude` is the
// optional `EXCLUDE …` tail, present only when written — `noOthers` is the
// explicit spelling of the default, kept distinct from an absent clause.
export type WindowFrame = {
  mode: "rows" | "range" | "groups";
  start: WindowFrameBound;
  end: WindowFrameBound | null;
  exclude?: WindowFrameExclusion;
};
export type WindowFrameExclusion = "currentRow" | "group" | "ties" | "noOthers";

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

// The `[NOT] DEFERRABLE` / `INITIALLY DEFERRED | IMMEDIATE` attributes PG allows
// on a UNIQUE, PRIMARY KEY or foreign-key constraint, column- or table-level,
// and on a table-level EXCLUDE constraint.
// Each key is omitted entirely when its clause is absent — so a missing
// `deferrable` is PG's default, not NOT DEFERRABLE, and `initially: "deferred"`
// alone still means deferrable, as INITIALLY DEFERRED implies it.
export type ConstraintAttrs = { deferrable?: boolean; initially?: "deferred" | "immediate" };

export type RefAction = "no action" | "restrict" | "cascade" | "set null" | "set default";

// What follows `REFERENCES t [(cols)]`. `onDelete` predates the rest, so it is
// always present (null when absent); `match` and `onUpdate` are omitted when
// absent.
export type ForeignKeyTail = {
  match?: "full" | "partial" | "simple";
  onDelete: RefAction | null;
  onUpdate?: RefAction;
};

export type ColConstraint =
  | { kind: "notNull"; span: Span }
  | { kind: "nullable"; span: Span }
  | { kind: "default"; expr: Expr; span: Span }
  | ({ kind: "primaryKey"; span: Span } & ConstraintAttrs)
  | ({ kind: "unique"; span: Span } & ConstraintAttrs)
  | ({ kind: "references"; table: string[]; columns: string[] | null; span: Span } & ForeignKeyTail & ConstraintAttrs)
  | { kind: "check"; expr: Expr; span: Span }
  // `GENERATED {ALWAYS | BY DEFAULT} AS IDENTITY [(sequence options)]`;
  // `options` is present only when the parenthesised list is.
  | { kind: "identity"; generated: "always" | "by default"; options?: SequenceOption[]; span: Span }
  // `GENERATED ALWAYS AS (expr) STORED` — a stored generated column.
  | { kind: "generated"; expr: Expr; span: Span }
  | { kind: "collate"; collation: string[]; span: Span };

export type ColumnDef = {
  kind: "column";
  name: string;
  dataType: ColType;
  constraints: ColConstraint[];
  span: Span;
};

export type TableConstraint =
  | ({ kind: "primaryKey"; name: string | null; columns: string[]; span: Span } & ConstraintAttrs)
  | ({ kind: "unique"; name: string | null; columns: string[]; span: Span } & ConstraintAttrs)
  | { kind: "check"; name: string | null; expr: Expr; span: Span }
  | ({
      kind: "foreignKey";
      name: string | null;
      columns: string[];
      refTable: string[];
      refColumns: string[] | null;
      span: Span;
    } & ForeignKeyTail &
      ConstraintAttrs)
  | ExcludeConstraint;

// One `element WITH operator` pair of an EXCLUDE constraint. `operator` is the
// operator's text (`=`, `&&`).
export type ExclusionElement = { expr: Expr; operator: string; span: Span };

// `EXCLUDE [USING method] (element WITH operator, …) [INCLUDE (cols)] [WHERE
// (pred)]`. `using` is null when PG's default (btree) applies, as on
// createIndex; `include` and `where` are omitted when absent.
export type ExcludeConstraint = {
  kind: "exclude";
  name: string | null;
  using: string | null;
  elements: ExclusionElement[];
  include?: string[];
  where?: Expr;
  span: Span;
} & ConstraintAttrs;

// One `{INCLUDING | EXCLUDING} property` option of a `LIKE source` table item.
export type LikeOption = {
  mode: "including" | "excluding";
  property:
    | "comments"
    | "compression"
    | "constraints"
    | "defaults"
    | "identity"
    | "generated"
    | "indexes"
    | "statistics"
    | "storage"
    | "all";
};

// `LIKE source [option …]` in a CREATE TABLE element list — copy the source
// table's columns (and whatever the options name) into the new one. `options`
// is in source order and empty when none is written.
export type LikeTable = { kind: "likeTable"; table: string[]; options: LikeOption[]; span: Span };

// A column of a `PARTITION OF parent (…)` element list: no type (the parent
// fixes it), only constraints. `withOptions` is present only when the optional
// `WITH OPTIONS` noise words are written.
export type ColumnOptions = {
  kind: "columnOptions";
  name: string;
  withOptions?: true;
  constraints: ColConstraint[];
  span: Span;
};

export type TableItem = ColumnDef | TableConstraint | LikeTable | ColumnOptions;

// One key of `PARTITION BY strategy (key, …)`: a column (a `name` node), a
// function call, or a parenthesised expression, then an optional collation and
// operator class. Both are omitted when absent.
export type PartitionKey = { expr: Expr; collate?: string[]; opclass?: string[]; span: Span };
export type PartitionSpec = { strategy: "range" | "list" | "hash"; keys: PartitionKey[]; span: Span };

// A range bound's datum: an expression, or MINVALUE / MAXVALUE. PG reads those
// two as column references and picks them out afterwards — quoted or not — so
// this does too, and the words stay names everywhere else.
export type PartitionRangeDatum = Expr | { kind: "minvalue" | "maxvalue"; span: Span };

// `FOR VALUES …` / `DEFAULT` — what a `PARTITION OF parent` table holds.
export type PartitionBound =
  | { kind: "range"; from: PartitionRangeDatum[]; to: PartitionRangeDatum[]; span: Span }
  | { kind: "list"; values: Expr[]; span: Span }
  | { kind: "hash"; modulus: number; remainder: number; span: Span }
  | { kind: "default"; span: Span };

export type PartitionOf = { parent: string[]; bound: PartitionBound };

// One `[namespace.]name [[=] value]` entry of a parenthesised option list — the
// storage parameters of `CREATE TABLE … WITH (…)`, and the shape PG reuses for
// its other generic option lists. `value` is null for a bare name, which PG's
// boolean options read as true (`WITH (security_barrier)`); a word value keeps
// the `name` shape, a quoted string the `string` one, so the two stay apart.
// `*` and a parenthesised list are COPY's (`FORCE_QUOTE *`, `FORCE_NULL (a, b)`).
// `namespace` is present only for a qualified reloption (`toast.fillfactor`).
export type RelationOptionScalar = Extract<Expr, { kind: "number" | "string" | "bool" | "name" }>;
export type RelationOptionValue =
  | RelationOptionScalar
  | Extract<Expr, { kind: "star" }>
  | { kind: "optionList"; items: RelationOptionScalar[]; span: Span };
export type RelationOption = { namespace?: string; name: string; value: RelationOptionValue | null; span: Span };

// One element of CREATE INDEX's column list: PG's `index_elem`, an expression
// followed by `[opclass [(parameter, …)]] [ASC | DESC] [NULLS {FIRST | LAST}]`.
// A COLLATE clause stays on `expr`, as it does everywhere else. Every key but
// `expr` is present only when its clause is written.
export type IndexColumn = {
  expr: Expr;
  opclass?: string[];
  opclassOptions?: RelationOption[];
  dir?: "asc" | "desc";
  nulls?: "first" | "last";
};

export type AlterAction =
  | { kind: "addColumn"; ifNotExists: boolean; column: ColumnDef }
  | { kind: "dropColumn"; name: string }
  | { kind: "addConstraint"; name: string | null; constraint: TableConstraint }
  | { kind: "setDefault"; column: string; expr: Expr }
  | { kind: "dropDefault"; column: string }
  | { kind: "setNotNull"; column: string }
  | { kind: "dropNotNull"; column: string }
  | { kind: "setDataType"; column: string; dataType: ColType }
  | { kind: "renameColumn"; from: string; to: string }
  | { kind: "renameConstraint"; from: string; to: string }
  | { kind: "renameTable"; to: string }
  | { kind: "ownerTo"; owner: string }
  | { kind: "replicaIdentity"; mode: "default" | "full" | "nothing" | "usingIndex"; index: string | null };

// The actions of ALTER {SCHEMA | DOMAIN | TYPE | INDEX}. `rename` is the object's
// own (ALTER TABLE's is `renameTable`); a domain's `addConstraint` keeps its name
// inside `constraint`, not beside it as ALTER TABLE's does.
type AlterRenameTo = { kind: "rename"; to: string };
type AlterOwnerTo = Extract<AlterAction, { kind: "ownerTo" }>;
type AlterSetSchema = { kind: "setSchema"; schema: string };
export type AlterSchemaAction = AlterRenameTo | AlterOwnerTo;
export type AlterDomainAction =
  | AlterRenameTo
  | AlterOwnerTo
  | AlterSetSchema
  | { kind: "setDefault"; expr: Expr }
  | { kind: "dropDefault" }
  | { kind: "setNotNull" }
  | { kind: "dropNotNull" }
  | { kind: "addConstraint"; constraint: Extract<DomainConstraint, { kind: "check" }>; notValid: boolean }
  | { kind: "dropConstraint"; ifExists: boolean; name: string; behavior: "cascade" | "restrict" | null }
  | { kind: "renameConstraint"; from: string; to: string }
  | { kind: "validateConstraint"; name: string };
// `position` is the `{BEFORE | AFTER} 'existing'` placement of a new enum value.
export type AlterTypeAction =
  | AlterRenameTo
  | AlterOwnerTo
  | AlterSetSchema
  | {
      kind: "addValue";
      ifNotExists: boolean;
      value: string;
      position: { placement: "before" | "after"; value: string } | null;
    }
  | { kind: "renameValue"; from: string; to: string };
export type AlterIndexAction =
  | AlterRenameTo
  | { kind: "setTablespace"; tablespace: string }
  | { kind: "setOptions"; options: RelationOption[] }
  | { kind: "resetOptions"; options: RelationOption[] };
// ALTER FUNCTION's and ALTER SEQUENCE's `options` hold the run of attributes or
// sequence options written in place of a named action, in source order.
export type AlterFunctionAction =
  | AlterRenameTo
  | AlterOwnerTo
  | AlterSetSchema
  | { kind: "options"; options: FunctionOption[] };
export type AlterAggregateAction = AlterRenameTo | AlterOwnerTo | AlterSetSchema;
// The column actions are ALTER TABLE's shapes, the option lists ALTER INDEX's.
export type AlterViewAction =
  | AlterRenameTo
  | AlterOwnerTo
  | AlterSetSchema
  | Extract<AlterAction, { kind: "renameColumn" | "setDefault" | "dropDefault" }>
  | Extract<AlterIndexAction, { kind: "setOptions" | "resetOptions" }>;
export type AlterSequenceAction =
  | AlterRenameTo
  | AlterOwnerTo
  | AlterSetSchema
  | { kind: "options"; options: SequenceOption[] };

// --- Phase 7: more CREATE objects ---

// `CREATE TYPE` in its three body shapes, all sharing the `createType` kind and
// discriminated by `form`. The enum form keeps its original `values` payload.
export type CompositeAttr = { name: string; type: ColType };
// A `name = value` option in a `RANGE` type body (`SUBTYPE = float8`, …). `value`
// is the raw (possibly qualified) name / type on the right of the `=`.
export type RangeOption = { name: string; value: string };
export type CreateType =
  | { kind: "createType"; form: "enum"; name: string[]; values: string[]; span: Span }
  | { kind: "createType"; form: "composite"; name: string[]; attributes: CompositeAttr[]; span: Span }
  | { kind: "createType"; form: "range"; name: string[]; options: RangeOption[]; span: Span };

// A single `CREATE SEQUENCE` option. Numeric operands are full expressions (so a
// signed `MINVALUE -100` parses); the flag / ownership forms carry their own shape.
export type SequenceOption =
  | { kind: "as"; type: ColType }
  | { kind: "increment"; value: Expr }
  | { kind: "minValue"; value: Expr | null } // null = NO MINVALUE
  | { kind: "maxValue"; value: Expr | null } // null = NO MAXVALUE
  | { kind: "start"; value: Expr }
  | { kind: "restart"; value: Expr | null } // null = bare RESTART
  | { kind: "cache"; value: Expr }
  | { kind: "cycle"; value: boolean } // false = NO CYCLE
  | { kind: "ownedBy"; owner: string[] | null }; // null = OWNED BY NONE

// A `CREATE DOMAIN` constraint. DEFAULT / COLLATE are never named; NOT NULL /
// NULL / CHECK may carry an optional `CONSTRAINT name`.
export type DomainConstraint =
  | { kind: "notNull"; name: string | null }
  | { kind: "null"; name: string | null }
  | { kind: "check"; name: string | null; expr: Expr }
  | { kind: "default"; expr: Expr }
  | { kind: "collate"; collation: string[] };

// `CREATE [OR REPLACE] [MATERIALIZED] VIEW [IF NOT EXISTS] name [(cols)] AS query
// [WITH [NO] DATA]`. `withData` is materialized-only (`null` otherwise / when the
// clause is absent); `ifNotExists` is materialized-only in PG but stored uniformly.
export type CreateView = {
  kind: "createView";
  materialized: boolean;
  orReplace: boolean;
  ifNotExists: boolean;
  name: string[];
  columns: string[] | null;
  query: Query;
  withData: boolean | null;
  span: Span;
};

// `CREATE SEQUENCE [IF NOT EXISTS] name option*`.
export type CreateSequence = {
  kind: "createSequence";
  ifNotExists: boolean;
  name: string[];
  options: SequenceOption[];
  span: Span;
};

// `CREATE DOMAIN name [AS] type constraint*`.
export type CreateDomain = {
  kind: "createDomain";
  name: string[];
  dataType: ColType;
  constraints: DomainConstraint[];
  span: Span;
};

// `CREATE DATABASE name [[WITH] option …]`. The options are PG's space-separated
// `name [=] value` list, kept in written order with PG's two-word `CONNECTION
// LIMIT` folded into one name — `[]` when none is written.
export type CreateDatabase = { kind: "createDatabase"; name: string; options: RelationOption[]; span: Span };

// `CREATE SCHEMA [IF NOT EXISTS] {name [AUTHORIZATION role] | AUTHORIZATION
// role} [element …]`. `name` is null in the AUTHORIZATION-only form (PG names
// the schema after the role), `authorization` null when no AUTHORIZATION is
// written, and `elements` the CREATE / GRANT statements nested in it, `[]` when
// none is.
export type CreateSchema = {
  kind: "createSchema";
  ifNotExists: boolean;
  name: string | null;
  authorization: string | null;
  elements: Stmt[];
  span: Span;
};

// One `CREATE EXTENSION` option, in written order (PG takes them in any).
export type ExtensionOption =
  | { kind: "schema"; schema: string }
  | { kind: "version"; version: string }
  | { kind: "cascade" };

// `CREATE EXTENSION [IF NOT EXISTS] name [WITH] option*`.
export type CreateExtension = {
  kind: "createExtension";
  ifNotExists: boolean;
  name: string;
  options: ExtensionOption[];
  span: Span;
};

// `CREATE TABLESPACE name [OWNER role] LOCATION 'dir' [WITH (option, …)]`.
// `options` is `[]` when no WITH list is written.
export type CreateTablespace = {
  kind: "createTablespace";
  name: string;
  owner: string | null;
  location: string;
  options: RelationOption[];
  span: Span;
};

// One `CREATE ROLE` option, in written order. A `flag` folds each attribute's
// `NO`-prefixed spelling into `value: false`; `password` is null for `PASSWORD
// NULL`, and `encrypted` marks the (PG-ignored) `ENCRYPTED` noise word.
export type RoleOption =
  | {
      kind: "flag";
      name: "superuser" | "createdb" | "createrole" | "inherit" | "login" | "replication" | "bypassrls";
      value: boolean;
    }
  | { kind: "connectionLimit"; limit: number }
  | { kind: "password"; encrypted: boolean; password: string | null }
  | { kind: "validUntil"; timestamp: string }
  | { kind: "inRole" | "role" | "admin"; roles: string[] };

// `CREATE {ROLE|USER} name [[WITH] option …]`. `user` marks the USER spelling,
// which PG reads as ROLE with LOGIN defaulted on.
export type CreateRole = { kind: "createRole"; user: boolean; name: string; options: RoleOption[]; span: Span };

// `CREATE TABLE [IF NOT EXISTS] name [(cols)] AS query [WITH [NO] DATA]` — the
// query-backed table. Distinct kind from `createTable` so its `query` payload is
// unmistakable. `columns` is the optional output-column-name list.
export type CreateTableAs = {
  kind: "createTableAs";
  ifNotExists: boolean;
  name: string[];
  columns: string[] | null;
  query: Query;
  withData: boolean | null;
  // The storage clauses PG allows ahead of the AS (its `USING method` aside,
  // which is not parsed), each omitted when absent — the same keys, and the
  // same rule, as on `createTable` (INHERITS aside).
  options?: RelationOption[];
  onCommit?: "preserveRows" | "deleteRows" | "drop";
  tablespace?: string;
  // As on `createTable`: the CREATE prefix modifiers, omitted when absent.
  modifiers?: string[];
  span: Span;
};

// --- Phase 8: functions / aggregates / triggers ---
// The routine body (`AS $$…$$` / plpgsql) is kept OPAQUE — the dollar-quoted
// string lexes as one `string` token and we store its inner text verbatim rather
// than parsing plpgsql, matching node-sql-parser's practical depth.

// One argument of a function/aggregate signature: `[mode] [name] type [DEFAULT
// expr]`. `mode` and `name` are null when absent; both are recovered by a small
// two-token heuristic (a mode word is only a mode when a further name/type word
// follows it, and a name only precedes the type when two name-ish tokens run
// together that do not themselves open a multi-word type name — so bare
// `integer` / `numeric(10,2)` / a dotted type / `double precision` have no name).
export type FunctionArg = {
  mode: "in" | "out" | "inout" | "variadic" | null;
  name: string | null;
  type: ColType;
  defaultValue: Expr | null;
};

// A routine's argument list as DROP identifies it, and an aggregate's as CREATE,
// ALTER and DROP AGGREGATE parse it: `(*)` (aggregates only) is `star` with no args.
export type DropSignature = { star: boolean; args: FunctionArg[] };

// `RETURNS [SETOF] type` or `RETURNS TABLE (col type, …)`.
export type FunctionReturns =
  | { kind: "type"; setof: boolean; type: ColType }
  | { kind: "table"; columns: CompositeAttr[] };

// A `SET config = value` value: an ordered value list, or `FROM CURRENT`.
export type FunctionSetValue = { kind: "list"; values: Expr[] } | { kind: "fromCurrent" };

// One characteristic clause of a CREATE FUNCTION. Order-free (parsed by a loop);
// all option words stay unreserved and are matched by value.
export type FunctionOption =
  | { kind: "language"; name: string }
  | { kind: "as"; parts: string[] } // `AS 'def'` — one part; `AS 'obj', 'sym'` — two
  | { kind: "volatility"; value: "immutable" | "stable" | "volatile" }
  | { kind: "leakproof"; value: boolean } // `[NOT] LEAKPROOF`
  | { kind: "strictness"; value: "strict" | "calledOnNullInput" | "returnsNullOnNullInput" }
  | { kind: "security"; external: boolean; definer: boolean }
  | { kind: "parallel"; value: "unsafe" | "restricted" | "safe" }
  | { kind: "cost"; value: Expr }
  | { kind: "rows"; value: Expr }
  | { kind: "window" }
  | { kind: "set"; parameter: string; value: FunctionSetValue };

// `CREATE [OR REPLACE] FUNCTION name (args) [RETURNS …] option*`.
export type CreateFunction = {
  kind: "createFunction";
  orReplace: boolean;
  name: string[];
  args: FunctionArg[];
  returns: FunctionReturns | null;
  options: FunctionOption[];
  span: Span;
};

// `CREATE [OR REPLACE] PROCEDURE name (args) option*` — a function with no
// RETURNS, whose options are those of CREATE FUNCTION's that PG also admits on
// a procedure (LANGUAGE, AS, [EXTERNAL] SECURITY and SET).
export type CreateProcedure = {
  kind: "createProcedure";
  orReplace: boolean;
  name: string[];
  args: FunctionArg[];
  options: FunctionOption[];
  span: Span;
};

// One `NAME [= value]` entry of the aggregate definition list (SFUNC, STYPE,
// INITCOND, …). `value` is null for a bare flag (HYPOTHETICAL, FINALFUNC_EXTRA);
// a `type` variant for a type/function-name RHS, a `literal` for a string/number.
export type AggregateOptionValue = { kind: "type"; type: ColType } | { kind: "literal"; expr: Expr };
export type AggregateOption = { name: string; value: AggregateOptionValue | null };

// `CREATE [OR REPLACE] AGGREGATE name ( signature ) ( definition )` — or the
// legacy single-paren form `name ( definition )`. `star` marks a `(*)` signature
// (e.g. an aggregate that ignores its input like `count(*)`).
export type CreateAggregate = {
  kind: "createAggregate";
  orReplace: boolean;
  name: string[];
  star: boolean;
  args: FunctionArg[];
  options: AggregateOption[];
  span: Span;
};

// One trigger event: INSERT / DELETE / TRUNCATE, or UPDATE with an optional
// `OF col, …` column list.
export type TriggerEvent = { event: "insert" | "update" | "delete" | "truncate"; columns: string[] | null };

// `CREATE [OR REPLACE] TRIGGER name {BEFORE|AFTER|INSTEAD OF} event [OR …] ON
// table [FOR [EACH] {ROW|STATEMENT}] [WHEN (cond)] EXECUTE {FUNCTION|PROCEDURE}
// fn(args)`. Constraint-trigger extras (DEFERRABLE / REFERENCING / FROM) are out
// of scope.
export type CreateTrigger = {
  kind: "createTrigger";
  orReplace: boolean;
  name: string;
  timing: "before" | "after" | "insteadOf";
  events: TriggerEvent[];
  table: string[];
  forEach: "row" | "statement" | null;
  when: Expr | null;
  execute: { routine: "function" | "procedure"; name: string[]; args: Expr[] };
  span: Span;
};

// --- Phase 9: DCL / TCL / session ---

// A single privilege in GRANT/REVOKE: a keyword like SELECT/INSERT/USAGE with an
// optional column list (`UPDATE (a, b)`). For a role grant the same shape carries
// the granted role name (columns null).
export type Privilege = { name: string; columns: string[] | null };

// The `ON objectType name[, …]` target of an object-privilege grant. `objectType`
// is the folded object keyword (default "table"); `names` lists the objects — or
// is empty for the `ALL {TABLES|SEQUENCES|FUNCTIONS} IN SCHEMA s[, …]` form, whose
// schemas live in `inSchema` (null otherwise).
export type GrantObject = { objectType: string; names: string[][]; inSchema: string[][] | null };

// `GRANT { privilege[, …] | ALL [PRIVILEGES] } ON … TO grantee[, …] [WITH GRANT
// OPTION]`, or the role form `GRANT role[, …] TO grantee[, …] [WITH ADMIN
// OPTION]`. `on` is null for a role grant; then `privileges` carries the granted
// role names (each with columns null). `"all"` = ALL PRIVILEGES.
export type Grant = {
  kind: "grant";
  privileges: Privilege[] | "all";
  on: GrantObject | null;
  grantees: string[];
  withGrantOption: boolean; // WITH GRANT OPTION (object) or WITH ADMIN OPTION (role)
  span: Span;
};

export type Revoke = {
  kind: "revoke";
  grantOptionFor: boolean; // GRANT OPTION FOR / ADMIN OPTION FOR
  privileges: Privilege[] | "all";
  on: GrantObject | null;
  grantees: string[];
  behavior: "cascade" | "restrict" | null;
  span: Span;
};

export type TransactionMode =
  | { kind: "isolation"; level: "serializable" | "repeatableRead" | "readCommitted" | "readUncommitted" }
  | { kind: "readWrite"; value: boolean } // true = READ WRITE, false = READ ONLY
  | { kind: "deferrable"; value: boolean }; // true = DEFERRABLE, false = NOT DEFERRABLE

// BEGIN / START TRANSACTION / COMMIT / ROLLBACK / SAVEPOINT / RELEASE SAVEPOINT.
export type Transaction =
  | { kind: "begin"; start: boolean; modes: TransactionMode[]; span: Span } // start = `START TRANSACTION`
  | { kind: "commit"; chain: boolean; span: Span } // chain = AND CHAIN
  | { kind: "rollback"; chain: boolean; savepoint: string | null; span: Span } // savepoint = ROLLBACK TO [SAVEPOINT] name
  | { kind: "savepoint"; name: string; span: Span }
  | { kind: "releaseSavepoint"; name: string; span: Span };

// SET [SESSION|LOCAL] { name {=|TO} value[, …] | TIME ZONE value | ROLE|SCHEMA|NAMES
// value }. `name` is the dotted config parameter (or "time zone"/"role"/…);
// `values` is the value list, or "default" for the DEFAULT keyword.
export type SetStmt = {
  kind: "set";
  scope: "session" | "local" | null;
  name: string;
  values: Expr[] | "default";
  span: Span;
};

// SHOW {name | ALL} — `name` is "all" for SHOW ALL.
export type Show = { kind: "show"; name: string; span: Span };
// RESET {name | ALL}.
export type Reset = { kind: "reset"; name: string; span: Span };

// DO [LANGUAGE lang] 'body' — the body is one (dollar-quoted) string, kept opaque
// like a function body; LANGUAGE may precede or follow the code.
export type Do = { kind: "do"; language: string | null; body: string; span: Span };

// DEALLOCATE [PREPARE] {name | ALL} — `name` is null for DEALLOCATE ALL.
export type Deallocate = { kind: "deallocate"; name: string | null; span: Span };

// PREPARE name [(type, …)] AS statement — `types` is null when the list is
// omitted. The body is any statement dmlStatement accepts (a query or DML),
// named `query` as a CTE's body of the same union is (and as PG names it).
export type Prepare = {
  kind: "prepare";
  name: string;
  types: ColType[] | null;
  query: Query | Insert | Update | Delete;
  span: Span;
};
// EXECUTE name [(expr, …)] — `args` is null when the list is omitted.
export type Execute = { kind: "execute"; name: string; args: Expr[] | null; span: Span };
// PG's eight table-level lock modes, camelCased from their keyword spelling.
export type LockMode =
  | "accessShare"
  | "rowShare"
  | "rowExclusive"
  | "shareUpdateExclusive"
  | "share"
  | "shareRowExclusive"
  | "exclusive"
  | "accessExclusive";
// LOCK [TABLE] [ONLY] name [*] [, …] [IN mode MODE] [NOWAIT]. ONLY is per table;
// a trailing `*` spells the default (descendants included) and is not recorded.
// `mode` is null when IN … MODE is omitted (PG then takes ACCESS EXCLUSIVE).
export type LockTarget = { name: string[]; only: boolean };
export type Lock = {
  kind: "lock";
  tables: LockTarget[];
  mode: LockMode | null;
  nowait: boolean;
  span: Span;
};
// CALL name ( [arg, …] ) — the argument list is always written, possibly empty.
// Not kind "call", which is the expression node (whose `name` is joined).
export type CallProcedure = { kind: "callProcedure"; name: string[]; args: Expr[]; span: Span };

// DECLARE name [option …] CURSOR [{WITH | WITHOUT} HOLD] FOR query. The options
// come in any order, as in PG: `binary` is false when BINARY is absent;
// `sensitivity`, `scroll` (false for NO SCROLL) and `hold` (false for WITHOUT
// HOLD) are null when their words are absent.
export type DeclareCursor = {
  kind: "declare";
  name: string;
  binary: boolean;
  sensitivity: "asensitive" | "insensitive" | null;
  scroll: boolean | null;
  hold: boolean | null;
  query: Query;
  span: Span;
};
// A FETCH / MOVE direction. A bare count is `count`; FORWARD / BACKWARD's
// `count` is null when neither a count nor ALL follows the word.
export type CursorDirection =
  | { kind: "next" | "prior" | "first" | "last" | "all" }
  | { kind: "absolute" | "relative" | "count"; count: number }
  | { kind: "forward" | "backward"; count: number | "all" | null };
// {FETCH | MOVE} [direction] [{FROM | IN}] cursor — `direction` is null when
// omitted; the FROM / IN noise word is dropped.
export type CursorFetch = { kind: "fetch" | "move"; direction: CursorDirection | null; cursor: string; span: Span };
// CLOSE {name | ALL} — `name` is null for CLOSE ALL.
export type CloseCursor = { kind: "close"; name: string | null; span: Span };

// Where COPY reads from or writes to: a server-side file, a shell command's
// pipe, or the client connection: STDIN for FROM, STDOUT for TO, as PG's docs
// spell it. (PG's grammar takes either word in either direction; this parser
// accepts only the matching one.)
export type CopyLocation =
  | { kind: "file"; path: string }
  | { kind: "program"; command: string }
  | { kind: "stdin" }
  | { kind: "stdout" };
// `COPY table [(col, …)] FROM location [[WITH] (option, …)] [WHERE cond]` or
// `COPY {table [(col, …)] | (query)} TO location [[WITH] (option, …)]`.
// Exactly one of `table` and `query` is set; `columns` is null without a list
// (and always with a query), `options` without the parenthesised list, and
// `where` unless a FROM writes one. The query is any statement PREPARE takes;
// PG requires RETURNING on a DML query only in analysis, so without RETURNING it
// is accepted here, as ON COMMIT on a permanent table is.
export type Copy = {
  kind: "copy";
  table: string[] | null;
  columns: string[] | null;
  query: Query | Insert | Update | Delete | null;
  direction: "from" | "to";
  location: CopyLocation;
  options: RelationOption[] | null;
  where: Expr | null;
  span: Span;
};

export type Stmt =
  // `modifiers` are the prefix words between CREATE and TABLE (PG's TEMP /
  // UNLOGGED family, see parseTempPrefix), in source order. Omitted, not null,
  // when there are none.
  // The clauses after the element list follow the same rule: each key is
  // present only when its clause is written (see parseTableClauses).
  // `partitionOf` marks a `PARTITION OF parent … FOR VALUES …` table, whose
  // `items` are `columnOptions` and table constraints — empty when it writes no
  // element list.
  | {
      kind: "createTable";
      ifNotExists: boolean;
      name: string[];
      items: TableItem[];
      partitionOf?: PartitionOf;
      inherits?: string[][];
      partitionBy?: PartitionSpec;
      options?: RelationOption[];
      onCommit?: "preserveRows" | "deleteRows" | "drop";
      tablespace?: string;
      modifiers?: string[];
      span: Span;
    }
  // `options` (WITH (…)) is present only when written; the older `include` and
  // `where` keys stay null when absent.
  | {
      kind: "createIndex";
      unique: boolean;
      concurrently: boolean;
      ifNotExists: boolean;
      name: string | null;
      table: string[];
      using: string | null;
      columns: IndexColumn[];
      include: string[] | null;
      options?: RelationOption[];
      where: Expr | null;
      span: Span;
    }
  | CreateType
  | CreateView
  | CreateSequence
  | CreateDomain
  | CreateDatabase
  | CreateSchema
  | CreateExtension
  | CreateTablespace
  | CreateRole
  | CreateTableAs
  | CreateFunction
  | CreateProcedure
  | CreateAggregate
  | CreateTrigger
  // `ALTER TABLE [IF EXISTS] name action[, …]`. `actions` is never empty, and a
  // RENAME is always its only element — PG keeps those out of the action list.
  | { kind: "alterTable"; ifExists: boolean; name: string[]; actions: AlterAction[]; span: Span }
  | { kind: "alterSchema"; name: string; action: AlterSchemaAction; span: Span }
  | { kind: "alterDomain"; name: string[]; action: AlterDomainAction; span: Span }
  | { kind: "alterType"; name: string[]; action: AlterTypeAction; span: Span }
  // As on alterTable, `actions` is never empty and a RENAME stands alone.
  | { kind: "alterIndex"; ifExists: boolean; name: string[]; actions: AlterIndexAction[]; span: Span }
  // `args` is null when the signature is left off, as PG allows for a name that
  // is not overloaded; an aggregate's is never optional, and `star` marks `(*)`.
  | { kind: "alterFunction"; name: string[]; args: FunctionArg[] | null; action: AlterFunctionAction; span: Span }
  | {
      kind: "alterAggregate";
      name: string[];
      star: boolean;
      args: FunctionArg[];
      action: AlterAggregateAction;
      span: Span;
    }
  // As on alterIndex, `actions` is never empty and a RENAME or SET SCHEMA stands alone.
  | {
      kind: "alterView";
      materialized: boolean;
      ifExists: boolean;
      name: string[];
      actions: AlterViewAction[];
      span: Span;
    }
  | { kind: "alterSequence"; ifExists: boolean; name: string[]; action: AlterSequenceAction; span: Span }
  // Generalized DROP: `DROP <object> [CONCURRENTLY] [IF EXISTS] name[, …]
  // [CASCADE|RESTRICT]`. `objectType` is the folded keyword (`"materialized
  // view"` for the two-word one); `behavior` is the trailing CASCADE/RESTRICT
  // (null when absent, and always null where PG takes none: DATABASE, ROLE,
  // USER). CONCURRENTLY is only accepted on the original six object kinds.
  // The remaining keys belong to one object kind each and are omitted elsewhere:
  // - `signatures` (FUNCTION / PROCEDURE / AGGREGATE): one entry per name, null
  //   where a function or procedure name carries no argument list;
  // - `table` (TRIGGER): the `ON table` the trigger belongs to;
  // - `force` (DATABASE): present, as true, only when `(FORCE)` is written.
  | {
      kind: "drop";
      objectType: string;
      concurrently: boolean;
      ifExists: boolean;
      names: string[][];
      behavior: "cascade" | "restrict" | null;
      signatures?: (DropSignature | null)[];
      table?: string[];
      force?: true;
      span: Span;
    }
  // `TRUNCATE [TABLE] name[, …] [RESTART|CONTINUE IDENTITY] [CASCADE|RESTRICT]`.
  | {
      kind: "truncate";
      names: string[][];
      identity: "restart" | "continue" | null;
      behavior: "cascade" | "restrict" | null;
      span: Span;
    }
  | { kind: "comment"; objectType: string; name: string[]; comment: string | null; span: Span }
  // DCL / TCL / session (Phase 9).
  | Grant
  | Revoke
  | Transaction
  | SetStmt
  | Show
  | Reset
  | Do
  | Deallocate
  | Prepare
  | Execute
  | Lock
  | CallProcedure
  | DeclareCursor
  | CursorFetch
  | CloseCursor
  | Copy
  // A top-level query or DML statement is a statement too.
  | Query
  | Insert
  | Update
  | Delete;

// --- DML AST (the `{ kind }` idiom, mutually recursive with Expr via lazy) ---

export type SetOpKind = "union" | "unionAll" | "intersect" | "intersectAll" | "except" | "exceptAll";

// `VALUES (…), (…)` as a query — usable standalone, as a set-op term, and as a
// parenthesised FROM source. Carries the same trailing ORDER BY / LIMIT / OFFSET
// tail a SELECT does (parsed by the shared clause rules).
export type ValuesQuery = {
  kind: "values";
  rows: Expr[][];
  orderBy: OrderItem[] | null;
  limit: Expr | null;
  offset: Expr | null;
  span: Span;
};

export type Query = SelectStmt | ValuesQuery | { kind: "setOp"; op: SetOpKind; left: Query; right: Query; span: Span };

// `FOR UPDATE|SHARE|NO KEY UPDATE|KEY SHARE [OF t, …] [NOWAIT|SKIP LOCKED]` — a
// row-locking clause. A SELECT may carry several (each locks its listed tables).
export type LockingClause = {
  strength: "update" | "noKeyUpdate" | "share" | "keyShare";
  of: string[][];
  wait: "nowait" | "skipLocked" | null;
};

// `SELECT … INTO [[GLOBAL | LOCAL] {TEMP | TEMPORARY} | UNLOGGED] [TABLE] target`
// — the result rows become a new table. `modifiers` holds the storage words in
// source order (so at most `["global", "temp"]`-shaped pairs) and is present
// only when at least one is written.
export type SelectInto = { name: string[]; modifiers?: string[] };

export type SelectStmt = {
  kind: "select";
  with_: Cte[] | null;
  recursive: boolean;
  // `false` = no DISTINCT, `true` = DISTINCT, `Expr[]` = DISTINCT ON (…).
  distinct: boolean | Expr[];
  columns: SelectItem[];
  // Present only when a SELECT INTO clause is written. PG's grammar admits the
  // clause on any `simple_select` — a set-op arm, a subquery, a CTE body — and
  // rejects the misplaced ones in parse analysis rather than in the grammar, so
  // this parser records it wherever it is written.
  into?: SelectInto;
  from: FromItem[] | null;
  where: Expr | null;
  // A GROUP BY item is a plain expression or a ROLLUP / CUBE / GROUPING SETS
  // grouping element (a bare expr keeps its Expr shape, so ungrouped tests hold).
  groupBy: GroupByItem[] | null;
  // `GROUP BY DISTINCT …`; present only for the DISTINCT modifier, and then
  // always `true` — an explicit `ALL` is the default spelling and records
  // nothing, exactly as `SELECT ALL` does.
  groupByDistinct?: true;
  having: Expr | null;
  // Named windows from a `WINDOW w AS (…)` clause (after HAVING, before ORDER BY).
  window: NamedWindow[] | null;
  orderBy: OrderItem[] | null;
  limit: Expr | null;
  offset: Expr | null;
  // Row-locking clauses (`FOR UPDATE …`), after LIMIT/OFFSET; null when absent.
  locking: LockingClause[] | null;
  span: Span;
};

// A GROUP BY entry: an ordinary expression, or one of the grouping-set
// constructs. `args` / `sets` group their operands — each inner `Expr[]` is one
// grouping (a bare `a` → `[a]`, a parenthesised `(a, b)` → `[a, b]`, `()` → `[]`).
export type GroupingElement =
  | { kind: "rollup"; args: Expr[][]; span: Span }
  | { kind: "cube"; args: Expr[][]; span: Span }
  | { kind: "groupingSets"; sets: Expr[][]; span: Span }
  // PG's `empty_grouping_set`: the `()` written directly as a GROUP BY item —
  // one grouping over no columns, i.e. the grand-total row. Inside GROUPING SETS
  // the same empty grouping is an empty `Expr[]` instead, since there it is one
  // element of a list rather than an item in its own right.
  | { kind: "emptyGrouping"; span: Span };
export type GroupByItem = Expr | GroupingElement;

// `expr` may be a `star` node (`*`, `t.*`).
export type SelectItem = { expr: Expr; alias: string | null };

export type FromItemJoinType = "inner" | "left" | "right" | "full" | "cross";

// `TABLESAMPLE method (arg, …) [REPEATABLE (seed)]` on a table FROM item.
export type TableSample = { method: string; args: Expr[]; repeatable: Expr | null };

// `columns` is the column-alias list that may follow an alias — `t AS x (a, b)`
// renames t's first two columns — on any of the three leaf items. Like `only`,
// `lateral` and `tablesample`, it is present only when written, so an item
// without one keeps its prior shape.
export type FromItem =
  // `only` is present (and true) only for `ONLY t`, which excludes inheritance
  // children; `tablesample` only when a TABLESAMPLE clause follows.
  | { kind: "table"; name: string[]; alias: string | null; columns?: string[]; tablesample?: TableSample; only?: true }
  // `lateral` is present (and true) only for a `LATERAL (subquery)`.
  | { kind: "subquery"; query: Query; alias: string | null; columns?: string[]; lateral?: boolean }
  // A table-function FROM item — `foo(args) alias`, optionally LATERAL. `call`
  // is the underlying `call` expression node. `ordinality` is present (and
  // true) only for `WITH ORDINALITY`, as on a `rowsFrom` item.
  | { kind: "function"; call: Expr; alias: string | null; columns?: string[]; lateral?: boolean; ordinality?: boolean }
  // `ROWS FROM (f(…), g(…))` — several table functions zipped side by side,
  // optionally LATERAL. `calls` are the underlying `call` expression nodes.
  | {
      kind: "rowsFrom";
      calls: Expr[];
      alias: string | null;
      columns?: string[];
      lateral?: boolean;
      ordinality?: boolean;
    }
  // `alias` and `columns` are present only on a parenthesised join that carries
  // an alias clause — `(a JOIN b ON …) AS x (c, d)`. A parenthesised join
  // without one is the bare join node: the parentheses only group.
  | {
      kind: "join";
      joinType: FromItemJoinType;
      left: FromItem;
      right: FromItem;
      on: Expr | null;
      using: string[] | null;
      alias?: string;
      columns?: string[];
    };

// `using` is PG's sort-operator spelling (`ORDER BY a USING <`), which stands
// in place of ASC/DESC — so `dir` is null whenever it is set. The key is present
// only when the clause is written; a plain item keeps its three keys.
export type OrderItem = {
  expr: Expr;
  dir: "asc" | "desc" | null;
  using?: string;
  nulls: "first" | "last" | null;
};

// `SEARCH {DEPTH | BREADTH} FIRST BY col, … SET seq_col` on a CTE: `by` lists the
// ordering columns, `set` names the sequence column the clause adds.
export type CteSearch = { order: "depth" | "breadth"; by: string[]; set: string };

// `CYCLE col, … SET mark_col [TO value DEFAULT default] USING path_col` on a
// CTE. `mark` holds the TO / DEFAULT pair, which PG takes together or not at all
// (omitted, the mark column is a boolean); null when it is not written.
export type CteCycle = { columns: string[]; set: string; mark: { to: Expr; default: Expr } | null; using: string };

// A CTE body is a query or a data-modifying statement (kept in the `query` field
// for both, so plain `WITH … SELECT` output is unchanged). `materialized`
// (`true` = MATERIALIZED, `false` = NOT MATERIALIZED), `search` and `cycle` are
// present only when written, so a CTE without them keeps its original shape.
// PG's grammar admits SEARCH / CYCLE on any CTE; parse analysis rejects them
// unless that CTE is actually recursive (it refers to itself under WITH
// RECURSIVE), so they are recorded wherever written.
export type Cte = {
  name: string;
  columns: string[] | null;
  materialized?: boolean;
  query: Query | Insert | Update | Delete;
  search?: CteSearch;
  cycle?: CteCycle;
};

// One `column = value` item of a SET list, shared by UPDATE and ON CONFLICT DO
// UPDATE.
export type Assignment = { column: string; value: Expr };

// `constraint` is present only for `ON CONFLICT ON CONSTRAINT name`, which
// names the arbiter instead of listing its columns (`target` is then null).
export type OnConflict = {
  target: string[] | null;
  constraint?: string;
  action: { kind: "nothing" } | { kind: "update"; set: Assignment[]; where: Expr | null };
};

// A bare DEFAULT standing for a column's default in an INSERT VALUES row. It
// is a row item, not an expression. PG's a_expr also admits DEFAULT (e.g.
// `UPDATE t SET a = DEFAULT`), but this grammar accepts it only here so far.
export type DefaultValue = { kind: "default"; span: Span };

// Which value wins for an identity column: `OVERRIDING {SYSTEM | USER} VALUE`.
export type InsertOverriding = "system" | "user";

// The three DML statements each accept a leading `WITH …` prefix. `with_` /
// `recursive` are present only when one attaches (like FromItem's optional
// `lateral`), so WITH-less DML keeps its original AST shape. INSERT's `alias`
// (`INSERT INTO t AS a`) and `overriding` follow the same rule.
export type Insert = {
  kind: "insert";
  table: string[];
  alias?: string;
  columns: string[] | null;
  overriding?: InsertOverriding;
  source:
    | { kind: "values"; rows: (Expr | DefaultValue)[][] }
    | { kind: "select"; query: Query }
    | { kind: "defaultValues" };
  onConflict: OnConflict | null;
  returning: SelectItem[] | null;
  with_?: Cte[];
  recursive?: boolean;
  span: Span;
};

export type Update = {
  kind: "update";
  table: string[];
  alias: string | null;
  set: Assignment[];
  from: FromItem[] | null;
  where: Expr | null;
  returning: SelectItem[] | null;
  with_?: Cte[];
  recursive?: boolean;
  span: Span;
};

export type Delete = {
  kind: "delete";
  table: string[];
  alias: string | null;
  using: FromItem[] | null;
  where: Expr | null;
  returning: SelectItem[] | null;
  with_?: Cte[];
  recursive?: boolean;
  span: Span;
};

// --- reserved words (grammar data, not lexer config) ---
// PG's reserved set: these may not be a bare column/table/type name — only via a
// quoted identifier. Everything else (`type`, `role`, `comment`, `data`, `int`,
// `text`, …) stays usable as a name for free, because the fold-and-match strategy
// never took it away. Non-reserved keywords used by the grammar (`index`,
// `enum`, `cascade`, `between`, `ilike`, …) are matched by value regardless.
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
  // `tablesample` must be reserved so a table item's `[AS] alias` detector stops
  // before it (else `FROM t TABLESAMPLE …` reads `tablesample` as t's alias).
  "tablesample",
  "values",
  // Not in PG's reserved list proper but a `type_func_name_keyword`, which is no
  // more usable as a column or table name there. `CREATE TABLE t (LIKE src)` and
  // a column `like text` are the same tokens, so a table body always reads
  // `like` as the LIKE clause (see tableItem); reserving the word, which is PG's
  // own answer, makes it no column name anywhere rather than everywhere but
  // there — and keeps a bare `(like)` from passing for a CTAS column list.
  // Being coarser than PG's tier, it also costs what that tier keeps: `like` as
  // an alias after AS, a function name (`like(a, b)`), a type name (`a::like`)
  // and the last part of a qualified name (`t.like`) — the same four a reserved
  // word such as `left` already costs here.
  "like",
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
// `B'1011'` and `X'ff'` lex as token types of their own, which is what lets the
// node record the spelling without re-reading the source. Any literal that
// closed has had its digits checked by the lexer, leaving these plain maps; one
// that did not has swallowed the `;` as well, so no statement can be built from
// it either way.
const bitStringLit = token("bitstring").map(
  (node, span): Expr => ({ kind: "bitString", value: node.value, hex: false, span }),
);
const hexStringLit = token("hexstring").map(
  (node, span): Expr => ({ kind: "bitString", value: node.value, hex: true, span }),
);
const boolLit = token("ident", { values: ["true", "false"] }).map(
  (node, span): Expr => ({ kind: "bool", value: node.value === "true", span }),
);
const nullLit = kw("null").map((_node, span): Expr => ({ kind: "null", span }));
const parenExpr = seq(skip(punc("(")), field("e", expression), skip(punc(")"))).map((s) => s.e);

// A function argument: `*` (for `count(*)`), a named argument (`a => 1`), or an
// ordinary expression. The named form is picked out by a two-token peek rather
// than a backtracking branch: `=>` appears in no operator table, so an argument
// that is *not* named can never have consumed one. Widening this rule widens
// every position that reaches it — a plain call, a FROM table function, and
// SUBSTRING's comma form from its second argument on (`parseSubstring` reads the
// first through `expression`, to tell the FROM/FOR form from the comma one, so
// `substring(str => 'abc', from => 2)` is still rejected). That is deliberate as
// far as it goes: PG accepts named arguments in all of those positions.
const plainFunctionArg = oneOf(bareStar, expression);
// lazy() so the first set and expected string stay verbatim the ones above;
// custom() takes them eagerly, and evaluating them at module scope would enter
// `expression`'s lazy() before `expressionRule` exists.
const functionArg: Rule<Expr, SqlTokenType> = lazy(() =>
  custom<Expr, SqlTokenType>(
    (ctx) => {
      const head = ctx.peek();
      const after = ctx.peekAhead(1);
      if (
        head !== null &&
        (head.type === "ident" || head.type === "qident") &&
        after !== null &&
        after.type === "op" &&
        after.value === "=>"
      ) {
        const start = ctx.position();
        const argName = ctx.parse(nameWord);
        ctx.next(); // "=>"
        return { kind: "namedArg", name: argName, value: ctx.parse(expression), span: ctx.spanFrom(start) };
      }
      return ctx.parse(plainFunctionArg);
    },
    { expected: plainFunctionArg.expected(), first: plainFunctionArg.first() },
  ),
);

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

// The `a, b, …` of a row constructor, entered just past its `(` and consuming
// through the `)`. Only an explicit ROW may be empty: the implicit spelling reads
// its first item unconditionally, so `()` still fails where an expression does.
function parseRowItems(ctx: ParseContext<SqlTokenType>, allowEmpty: boolean): Expr[] {
  const items: Expr[] = [];
  if (!(allowEmpty && ctx.is("punc", ")"))) {
    items.push(ctx.parse(expression));
    while (ctx.eat("punc", ",") !== null) items.push(ctx.parse(expression));
  }
  expectClose(ctx);
  return items;
}

// ROW(a, b, …) — an explicit row constructor (may be empty). May lead OVERLAPS.
function parseRow(ctx: ParseContext<SqlTokenType>, start: Position): Expr {
  const row: RowExpr = { kind: "row", items: parseRowItems(ctx, true), span: ctx.spanFrom(start) };
  return startsOverlaps(ctx) ? parseOverlaps(ctx, row) : row;
}

// --- OVERLAPS ---
// `row OVERLAPS row`. `overlaps` is unreserved here — PG reserves it, but this
// grammar never did, so `SELECT a overlaps FROM t` reads it as an alias — and a
// pratt infix group cannot decline once it has matched, so the operator never
// enters the pratt table. The row constructors that may lead it (the implicit
// `(a, b)` in parenOrSubquery, and ROW(…) above) look for the tail themselves,
// and only claim `overlaps` when a row can follow it: a `(` or a `ROW (`.
// Consuming the tail at atom level gives OVERLAPS the tightest precedence there
// is, so a trailing `::` binds to the whole predicate rather than to the
// right-hand row. That is PG's reading too: both of its operands are rows, not
// expressions, so `(c, d)::text` cannot be one, and the cast can only apply to
// the finished predicate. Two over-acceptances come with the atom: a trailing
// `[…]` binds the same way, where PG would reject it (as `ROW(a, b)[1]` already
// was), and the b-expression shares the atom, so OVERLAPS also reaches positions
// PG's b_expr does not admit, such as POSITION's first operand. Everything
// looser composes as usual: `… OVERLAPS … AND x` is an AND, and `NOT` (a
// prefix) wraps the predicate.
const startsOverlaps = (ctx: ParseContext<SqlTokenType>): boolean => {
  if (!ctx.is("ident", "overlaps")) return false;
  const after = ctx.peekAhead(1);
  if (after?.type === "punc" && after.value === "(") return true;
  const next = ctx.peekAhead(2);
  return after?.type === "ident" && after.value === "row" && next?.type === "punc" && next.value === "(";
};

// PG checks the arity of both periods in the grammar action itself, so a wrong
// count is rejected at parse time here too, reported over the offending row.
const expectPeriod = (ctx: ParseContext<SqlTokenType>, row: RowExpr, side: "left" | "right"): void => {
  if (row.items.length !== 2) {
    ctx.croak(
      `Expected 2 items on the ${side} of OVERLAPS but found ${row.items.length}`,
      row.span.start,
      row.span.end,
    );
  }
};

// Entered on `overlaps`, which startsOverlaps has vouched for. The right-hand
// row is read directly rather than through the atom, so it cannot open a second
// OVERLAPS of its own — PG's `row OVERLAPS row` does not chain either.
function parseOverlaps(ctx: ParseContext<SqlTokenType>, left: RowExpr): Expr {
  expectPeriod(ctx, left, "left");
  ctx.next(); // overlaps
  const start = ctx.position();
  const explicit = ctx.eat("ident", "row") !== null;
  ctx.next(); // "("
  const items = parseRowItems(ctx, explicit);
  const right: RowExpr = { kind: "row", items, ...(!explicit && { implicit: true }), span: ctx.spanFrom(start) };
  expectPeriod(ctx, right, "right");
  return { kind: "overlaps", left, right, span: ctx.spanFrom(left.span.start) };
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

// OVERLAY(value PLACING placing FROM from [FOR for_]). Not a SPECIAL_CALLS
// entry — columnRef's call branch reads the first argument itself and hands it
// over only once a PLACING has shown this is the keyword form; see there.
function parseOverlay(ctx: ParseContext<SqlTokenType>, value: Expr, start: Position): Expr {
  ctx.parse(kw("placing"));
  const placing = ctx.parse(expression);
  ctx.parse(kw("from"));
  const from = ctx.parse(expression);
  const for_ = ctx.eat("ident", "for") !== null ? ctx.parse(expression) : null;
  expectClose(ctx);
  return { kind: "overlay", value, placing, from, for_, span: ctx.spanFrom(start) };
}

const SPECIAL_CALLS: Record<string, (ctx: ParseContext<SqlTokenType>, start: Position) => Expr> = {
  extract: parseExtract,
  position: parsePosition,
  trim: parseTrim,
  row: parseRow,
  substring: parseSubstring,
};

// --- window functions ---
// `fn(…)` may carry, in order, `WITHIN GROUP (ORDER BY …)`, `IGNORE|RESPECT
// NULLS`, `FILTER (WHERE …)`, and `OVER (…)` / `OVER name`. These are attached
// in columnRef's call branch (so the keywords stay unreserved and are only
// recognised right after a call's `)`),
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

// The frame exclusion after `EXCLUDE`. `group` is reserved and `current`/`row`/
// `ties`/`no`/`others` are not, but nothing else can follow `EXCLUDE` here, so
// all four forms are matched by value with no guard.
const frameExclusion = oneOf(
  kwseq("current", "row").map((): WindowFrameExclusion => "currentRow"),
  kw("group").map((): WindowFrameExclusion => "group"),
  kw("ties").map((): WindowFrameExclusion => "ties"),
  kwseq("no", "others").map((): WindowFrameExclusion => "noOthers"),
);

// `{ROWS|RANGE|GROUPS} bound` or `… BETWEEN start AND end`, then an optional
// `EXCLUDE …`. Entered positioned on the mode word. A bound always ends on a
// keyword (`preceding`/`following`/`row`), so an `exclude` after it cannot be
// part of an offset expression — the unreserved word is safe to commit on.
function parseFrame(ctx: ParseContext<SqlTokenType>): WindowFrame {
  const mode = ctx.next()!.value as "rows" | "range" | "groups";
  let start: WindowFrameBound;
  let end: WindowFrameBound | null = null;
  if (ctx.eat("ident", "between") !== null) {
    start = parseFrameBound(ctx);
    ctx.parse(kw("and"));
    end = parseFrameBound(ctx);
  } else {
    start = parseFrameBound(ctx);
  }
  const exclude = ctx.eat("ident", "exclude") !== null ? ctx.parse(frameExclusion) : null;
  return { mode, start, end, ...(exclude && { exclude }) };
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

// Attach any trailing WITHIN GROUP / IGNORE|RESPECT NULLS / FILTER / OVER
// modifiers to a freshly-parsed call node, in that order. PG has no null
// treatment at all, so its position here is the SQL-standard one — straight
// after the argument list, inside FILTER and OVER. Each modifier is optional and
// guarded by a peek so the unreserved lead words (`within`, `ignore`, `respect`,
// `filter`, `over`) still work as plain aliases / names when they are not
// actually starting a modifier
// (`count(*) filter` reads `filter` as an alias, and so does `lag(x) ignore`).
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
  // `IGNORE NULLS` / `RESPECT NULLS`. Both lead words are unreserved and read as
  // an alias on their own, so the guard requires a following `nulls` — itself
  // unreserved, and a different word from the reserved `null`.
  const nullsNext = ctx.peekAhead(1);
  if (ctx.is("ident", ["ignore", "respect"]) && nullsNext?.type === "ident" && nullsNext.value === "nulls") {
    const treatment = ctx.next()!.value as "ignore" | "respect";
    ctx.next(); // nulls
    result = { kind: "nullTreatment", fn: result, treatment, span: ctx.spanFrom(start) };
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
// for `INTERVAL 'literal' [field]` and `DATE / TIME / TIMESTAMP 'literal'`
// (unreserved words that lead a literal), the keyword-argument functions in
// SPECIAL_CALLS, and OVERLAY's PLACING form.
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
    // DATE / TIME / TIMESTAMP 'literal' — the same idiom, for the same reason:
    // all three words are unreserved, so they lead a literal only when the
    // whole type spelling is followed by a string, and are names otherwise.
    if (startsTypedLiteral(ctx)) {
      const type = ctx.parse(typeRef);
      const value = ctx.next()!.value; // the string literal
      return { kind: "typedLiteral", type, value, span: ctx.spanFrom(start) };
    }
    // Only a bare OVERLAY has the PLACING form; a quoted `"overlay"` is an
    // ordinary function name to PG.
    const bareLead = ctx.peek()?.type === "ident";
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
      // `Object.hasOwn` for the reason `lookup` gives: `constructor(1)` and
      // `__proto__(1)` would otherwise find an inherited "handler".
      const special =
        parts.length === 1 && Object.hasOwn(SPECIAL_CALLS, parts[0]!) ? SPECIAL_CALLS[parts[0]!] : undefined;
      if (special !== undefined) return special(ctx, start);
      // The aggregate modifiers that live inside the argument list: a leading
      // DISTINCT and a trailing `ORDER BY …` (`array_agg(a ORDER BY b)`). Both
      // `distinct` and `order` are reserved, so neither can be an argument name
      // and neither needs a guard. The keys are omitted when absent, so an
      // ordinary call keeps exactly its prior shape.
      const distinct = ctx.eat("ident", "distinct") !== null;
      const args: Expr[] = [];
      let orderBy: OrderItem[] = [];
      if (!ctx.is("punc", ")")) {
        args.push(ctx.parse(functionArg));
        // OVERLAY's keyword form is told apart from its comma form only by a
        // PLACING after the first argument, so unlike the SPECIAL_CALLS it
        // cannot claim the call up front: the comma form stays on this path and
        // so parses exactly as it did before the keyword form existed. That
        // includes the modifiers every call here accepts (DISTINCT, ORDER BY,
        // OVER, …), which PG would reject on OVERLAY's comma form — no narrower
        // than this grammar is for any other call. `placing` is reserved, so
        // no first argument can end in one — before this check, it was a
        // syntax error here, and it still is after a bare `*` or a named
        // argument, which PG's keyword form does not take either (a `t.*` is an
        // ordinary operand to it, as to SUBSTRING's FROM form).
        const value = args[0]!;
        if (
          bareLead &&
          parts.length === 1 &&
          parts[0] === "overlay" &&
          !distinct &&
          !(value.kind === "star" && value.table === null) &&
          value.kind !== "namedArg" &&
          ctx.is("ident", "placing")
        ) {
          return parseOverlay(ctx, value, start);
        }
        while (ctx.is("punc", ",")) {
          ctx.next(); // ","
          args.push(ctx.parse(functionArg));
        }
        if (ctx.is("ident", "order")) orderBy = ctx.parse(orderByClause);
      }
      if (!ctx.is("punc", ")")) ctx.croak(`Expected ")" but found ${describeFound(ctx.peek())}`);
      ctx.next(); // ")"
      const call: Expr = {
        kind: "call",
        name: parts.join("."),
        args,
        ...(distinct && { distinct: true }),
        ...(orderBy.length > 0 && { orderBy }),
        span: ctx.spanFrom(start),
      };
      // Trailing WITHIN GROUP / IGNORE|RESPECT NULLS / FILTER / OVER modifiers.
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
// expression. The `add` ALTER action (below) is the peekAhead template. A comma
// after the first item makes it an implicit row constructor `(a, b, …)` instead,
// which may lead OVERLAPS. A lone `(a)` keeps the bare inner expression — span
// and all — exactly as before; it only becomes a row long enough to report a
// wrong OVERLAPS arity.
const subqueryExpr = parenQuery.map((q, span): Expr => ({ kind: "subquery", query: q, span }));
const parenOrSubquery = custom<Expr, SqlTokenType>(
  (ctx) => {
    if (isSubqueryParen(ctx)) return ctx.parse(subqueryExpr);
    const start = ctx.position();
    ctx.next(); // "("
    const items = parseRowItems(ctx, false);
    const row: RowExpr = { kind: "row", items, implicit: true, span: ctx.spanFrom(start) };
    if (startsOverlaps(ctx)) return parseOverlaps(ctx, row);
    return items.length === 1 ? items[0]! : row;
  },
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

// CURRENT_DATE, CURRENT_TIMESTAMP[(p)], USER, … — the niladic keyword
// functions. Each is reserved, so it can be a value-specific atom key without
// taking a name from anyone. Only the four time-valued ones accept a precision,
// and PG spells it as a bare integer: `current_date()` and `current_user()` are
// syntax errors there, and the stray `(` is left for the caller to reject here.
const PRECISION_FUNCTIONS: ReadonlySet<string> = new Set([
  "current_time",
  "current_timestamp",
  "localtime",
  "localtimestamp",
]);
// An integer constant, as PG lexes one: decimal or hex digits (the lexer has
// already dropped any `_` separators) that fit in an int4 — PG lexes `1.5` and
// `3e0` as floats, and a wider integer as a numeric, and its precision slots take
// neither. The value itself is not range-checked: PG only warns above 6, and
// clamps.
const isIntegerConstant = (tok: Token<SqlTokenType> | null): boolean =>
  tok !== null &&
  tok.type === "number" &&
  /^(?:[0-9]+|0[xX][0-9a-fA-F]+)$/.test(tok.value) &&
  Number(tok.value) <= 2147483647;

const sqlValueFunction = custom<Expr, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    const name = ctx.next()!.value as SqlValueFunctionName;
    let precision: number | null = null;
    if (PRECISION_FUNCTIONS.has(name) && ctx.is("punc", "(")) {
      ctx.next(); // "("
      const tok = ctx.peek();
      if (!isIntegerConstant(tok)) ctx.croak(`Expected an integer precision but found ${describeFound(tok)}`);
      precision = Number(ctx.next()!.value);
      expectClose(ctx);
    }
    // `!== null`, not truthiness: `current_timestamp(0)` is a real precision.
    return { kind: "sqlValueFunction", name, ...(precision !== null && { precision }), span: ctx.spanFrom(start) };
  },
  {
    expected: 'a keyword like "current_date"',
    first: SQL_VALUE_FUNCTIONS.map((value): FirstEntry<SqlTokenType> => ({ type: "ident", value })),
  },
);

const atom = oneOf(
  numberLit,
  stringLit,
  bitStringLit,
  hexStringLit,
  boolLit,
  nullLit,
  paramLit,
  caseExpr,
  existsExpr,
  castExpr,
  arrayExpr,
  sqlValueFunction,
  parenOrSubquery,
  columnRef,
);

// --- data types ---
// A type name with optional `(args)` (varchar(10), numeric(10,2)) and an array
// suffix (`int[]`, `text[][]`). Array dims are collapsed to a boolean. The name
// may be several words (`double precision`, `timestamp with time zone`) — see
// MULTI_WORD_TYPES below.
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
const typeArgs = delimited(P("("), P(")"), P(","), typeArg, { interleaved: true });

// PG spells a good many types with more than one word, and the datetime ones
// carry their precision *inside* the name (`timestamp(3) with time zone`). The
// tails are keyed by lead word and listed longest-first, so a greedy match never
// stops short of a longer valid spelling (`national character varying` before
// `national character`).
//
// INTERVAL's field spec is enumerated rather than generated: PG allows only
// these thirteen combinations, not every `<field> TO <field>` pair.
const INTERVAL_TAILS: readonly (readonly string[])[] = [
  ["year", "to", "month"],
  ["day", "to", "hour"],
  ["day", "to", "minute"],
  ["day", "to", "second"],
  ["hour", "to", "minute"],
  ["hour", "to", "second"],
  ["minute", "to", "second"],
  ["year"],
  ["month"],
  ["day"],
  ["hour"],
  ["minute"],
  ["second"],
];

// A Map, not an object literal: identifiers fold to lowercase, so a column of
// type `constructor` or `__proto__` would otherwise find a tail list on
// Object.prototype — and `?? []` does not fire for a non-nullish inherited value.
const MULTI_WORD_TYPES: ReadonlyMap<string, readonly (readonly string[])[]> = new Map([
  ["double", [["precision"]]],
  ["character", [["varying"]]],
  ["char", [["varying"]]],
  ["national", [["character", "varying"], ["char", "varying"], ["character"], ["char"]]],
  ["bit", [["varying"]]],
  [
    "timestamp",
    [
      ["with", "time", "zone"],
      ["without", "time", "zone"],
    ],
  ],
  [
    "time",
    [
      ["with", "time", "zone"],
      ["without", "time", "zone"],
    ],
  ],
  ["interval", INTERVAL_TAILS],
]);

// The two types whose precision PG spells *before* the rest of the name. For
// every other multi-word type the args trail the whole name (`character
// varying(10)`, `interval day to second(3)`), so reading them early would accept
// the PG-invalid `character(10) varying`.
//
// This fixes where the one arg list may sit, not whether the type takes one:
// `double precision(10)` is accepted, exactly as the single-word `text(5)` is.
// Rejecting it is a property of the *tail* rather than the lead — `varying` and
// `second` take a precision where `precision` and `with time zone` do not — and
// no other type in this grammar has its arity checked.
const ARGS_BEFORE_TAIL: ReadonlySet<string> = new Set(["timestamp", "time"]);

// A peek `index` tokens past the cursor that treats input which does not lex
// as no token at all. Lexing is lazy, so a peek past the cursor can raise the
// *next* token's lex error. Two things have to happen to it. Input that does not
// lex cannot complete a lookahead pattern, so the candidate fails rather than
// the whole rule — otherwise `diagnose("CREATE TABLE t (c timestamp with é);")`
// reports the bad character and loses the column-definition error. But filling
// the lookahead buffer consumes the offending character, so simply discarding
// the error would drop it for good, and `c interval day é` would parse clean.
// Hence report() — which records it in diagnose() and returns false under
// strict parse(), where there is no collector and rethrowing is the only honest
// answer.
function peekOrReport(ctx: ParseContext<SqlTokenType>, index: number): Token<SqlTokenType> | null {
  try {
    return ctx.peekAhead(index);
  } catch (error) {
    if (!(error instanceof ParseError) || !ctx.report(error)) throw error;
    return null;
  }
}

// The longest continuation of `lead` sitting `offset` tokens past the cursor, or
// null. Pure lookahead: nothing is consumed, so the caller decides. Every word
// must be a bare `ident` — `readers.string("qident", …)` yields the *inner*
// text, so a quoted `"precision"` is otherwise indistinguishable from the
// keyword by value alone, and PG treats it as an ordinary name.
function findTypeTail(ctx: ParseContext<SqlTokenType>, lead: string, offset: number): readonly string[] | null {
  const tails = MULTI_WORD_TYPES.get(lead);
  if (tails === undefined) return null;
  const word = (index: number): string | null => {
    const ahead = peekOrReport(ctx, offset + index);
    return ahead !== null && ahead.type === "ident" ? ahead.value : null;
  };
  for (const tail of tails) {
    if (tail.every((expected, index) => word(index) === expected)) return tail;
  }
  return null;
}

// True when the token at the cursor opens a multi-word type name that actually
// completes. parseFunctionArg needs that decision one token before typeRef is
// entered, to tell `f(double precision)` (one unnamed two-word argument) from
// `f(a integer)` (an argument named `a`) — and asking for the whole tail, not
// just the pair, keeps the two in step: `f(timestamp without)` has no completable
// tail, so `timestamp` is a name again, exactly as typeRef would have it.
const startsMultiWordType = (ctx: ParseContext<SqlTokenType>, lead: Token<SqlTokenType> | null): boolean =>
  lead !== null && lead.type === "ident" && findTypeTail(ctx, lead.value, 1) !== null;

// The type words that may prefix a string literal (`DATE '2024-01-01'`).
// INTERVAL is the fourth, but has its own branch and node — its unit spec
// trails the literal rather than leading it.
const TYPED_LITERAL_LEADS: ReadonlySet<string> = new Set(["date", "time", "timestamp"]);

// True when the cursor sits on a typed datetime literal: a bare lead word, the
// pre-tail precision and the multi-word tail where its type has them, then a
// string. Every token is checked before columnRef commits, and nothing else
// may sit between them — so `date(x)` and `timestamp(3)` stay calls, and a
// type with an array suffix or a trailing arg list is never a literal's.
//
// The token straight after the lead is peeked plainly, as INTERVAL's is, and so
// is a `(n)` behind it together with the two tokens past its `)`: the name or
// call these otherwise become peeks all of them anyway (a call's modifier checks
// read two past its `)`), so a lex error there surfaces exactly as it always
// did. Everything further out is lookahead the old parse need not have done,
// and goes through peekOrReport — under diagnose() the syntax error that
// follows (`SELECT time with time zone é;` still reports `with`) is kept.
function startsTypedLiteral(ctx: ParseContext<SqlTokenType>): boolean {
  const lead = ctx.peek();
  if (lead === null || lead.type !== "ident" || !TYPED_LITERAL_LEADS.has(lead.value)) return false;
  const isPunc = (ahead: Token<SqlTokenType> | null, value: string) =>
    ahead !== null && ahead.type === "punc" && ahead.value === value;
  const next = ctx.peekAhead(1);
  let offset = 1;
  if (
    ARGS_BEFORE_TAIL.has(lead.value) &&
    isPunc(next, "(") &&
    isIntegerConstant(ctx.peekAhead(2)) &&
    isPunc(ctx.peekAhead(3), ")")
  ) {
    ctx.peekAhead(5);
    offset = 4;
  }
  offset += findTypeTail(ctx, lead.value, offset)?.length ?? 0;
  return peekOrReport(ctx, offset)?.type === "string";
}

// Consume the longest continuation of `lead` that is present, or nothing. The
// whole candidate is checked before a single token is consumed — `phrase()`
// commits after one word with no rollback, which would eat the `WITH` of
// `CREATE MATERIALIZED VIEW mv AS SELECT now()::timestamp WITH NO DATA`.
function eatTypeTail(ctx: ParseContext<SqlTokenType>, lead: string): readonly string[] {
  const tail = findTypeTail(ctx, lead, 0);
  if (tail === null) return [];
  for (let index = 0; index < tail.length; index++) ctx.next();
  return tail;
}

// The args are hoisted out of wherever PG puts them, so the name is always the
// words alone: `timestamp(3) with time zone` is
// `{ name: "timestamp with time zone", args: [3] }`.
const typeRef = custom<ColType, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    // Only a bare, unqualified lead word can open a multi-word spelling: a
    // quoted `"double"` or a dotted `pg_catalog.double` is an ordinary name.
    const bare = ctx.peek()?.type === "ident";
    const parts = ctx.parse(qualName);
    const words = [parts.join(".")];
    let args: number[] | null = null;
    if (bare && parts.length === 1) {
      const lead = parts[0]!;
      if (ARGS_BEFORE_TAIL.has(lead) && ctx.is("punc", "(")) args = ctx.parse(typeArgs);
      words.push(...eatTypeTail(ctx, lead));
    }
    if (args === null && ctx.is("punc", "(")) args = ctx.parse(typeArgs);
    const array = ctx.parse(arraySuffix);
    return { name: words.join(" "), args: args ?? [], array, span: ctx.spanFrom(start) };
  },
  { expected: "a name", first: qualName.first() },
);

// --- pratt operator table ---
// Binding powers follow PG (highest binds tightest): :: cast, ^, unary + -,
// * / %, + -, other operators (|| @> & | # << >> -> @?), BETWEEN/IN/LIKE,
// comparisons (nonassoc), IS, NOT, AND, OR — with one deliberate departure
// among those tiers, at `^`, documented where that group is declared. Keyword operators
// are plain `ident`-typed matches thanks to folding; multi-word ones (NOT
// LIKE, BETWEEN … AND) use match-based groups.
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

// `[NOT] BETWEEN [SYMMETRIC | ASYMMETRIC] lo AND hi`, entered just past BETWEEN.
// The internal AND is recursed past at bp 11 (above AND's own bp) and then
// consumed explicitly, so no ambiguity machinery. Both modifier words are
// reserved, so neither can be the start of `lo` and they need no guard.
const betweenTail = (ctx: ParseContext<SqlTokenType>, left: Expr, h: PrattHelpers<Expr>, negated: boolean): Expr => {
  const mode = ctx.eat("ident", ["symmetric", "asymmetric"]);
  const lo = h.parseRhs(11);
  ctx.parse(kw("and"));
  const hi = h.parseRhs(11);
  return {
    kind: "between",
    expr: left,
    lo,
    hi,
    negated,
    ...(mode !== null && { symmetric: mode.value === "symmetric" }),
    span: closeSpan(left, ctx.lastEnd()),
  };
};

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
// Unary sign. PG accepts a leading `+` wherever it accepts a leading `-`, and
// both produce a `unary` node carrying the operator verbatim — `+a` is not
// folded away, so the AST keeps what was written.
const unarySignPrefix = {
  ops: ["-", "+"],
  type: "op" as const,
  bp: 16,
  map: (op: string, operand: Expr, span: Span): Expr => ({ kind: "unary", op, operand, span }),
};

// The tight arithmetic / concat / bitwise / JSON-and-regex tier (bp ≥ 12) —
// everything above the comparison/logical forms. Shared verbatim with the
// b-expression.
const arithInfix = [
  // Exponentiation, left-associative (`a ^ b ^ c` is `(a ^ b) ^ c`) and tighter
  // than the unary sign, so `-2 ^ 2` reads as `-(2 ^ 2)`. That is where the
  // table departs from PG, which declares UMINUS *above* `^` and so reads the
  // same input as `(-2) ^ 2`; the usual reading of `-2 ^ 2` wins here instead.
  // (Only the sign relationship diverges — the left-associativity above is
  // PG's own `%left '^'`, not the right-associativity maths would give it.)
  // The departure has a tail: a sign on the *right* re-enters at the prefix's
  // own bp 16, which is below 17, so `2 ^ -3 ^ 4` is `2 ^ (-(3 ^ 4))` rather
  // than left-nesting. bp 17 also sits below the bp-18 postfixes, which is what
  // keeps `a ^ b::int` casting the right operand alone instead of the power.
  binary(["^"], 17),
  binary(["*", "/", "%"], 14),
  binary(["+", "-"], 13),
  binary(["||"], 12),
  binary(["@>"], 12),
  // Bitwise and shift operators (`& | # << >>`). PG has no tier of its own for
  // these: they fall into the catch-all "any other operator" level, below the
  // arithmetic it names explicitly and above the comparisons, which is this
  // grammar's bp 12 — so `a | b + c` is `a | (b + c)` and `a | b = c` is
  // `(a | b) = c`. `#` is bitwise XOR here; the JSON `#>`/`#>>`/`#-` spellings
  // are separate tokens the lexer takes whole, not a `#` followed by anything.
  binary(["&", "|", "#", "<<", ">>"], 12),
  // JSON/JSONB access & containment (`-> ->> #> #>> #-`, existence `? ?| ?&`,
  // `<@`), jsonpath existence (`@?`), full-text and jsonpath predicate match
  // (`@@`), POSIX regex (`~ !~ ~* !~*`). All lex as single `op` tokens already;
  // they share the bp-12 "other operators" tier with `||`/`@>` and are
  // left-associative, so `a -> 'k' ->> 'j'` nests left.
  binary(["->", "->>", "#>", "#>>", "#-", "?", "?|", "?&", "<@", "~", "!~", "~*", "!~*", "@?", "@@"], 12),
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
    unarySignPrefix,
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
      // BETWEEN [SYMMETRIC | ASYMMETRIC] lo AND hi — see betweenTail.
      match: kw("between"),
      bp: 10,
      parse: (ctx, left, h): Expr => {
        ctx.parse(kw("between"));
        return betweenTail(ctx, left, h, false);
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
          return betweenTail(ctx, left, h, true);
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
          // `(subquery)` or `(array expr)` — not the parenOrSubquery atom, whose
          // implicit row PG does not allow here: `x = ANY (a, b)` is a syntax
          // error there, and only `x = ANY ((a, b))` reaches the row.
          const right = isSubqueryParen(ctx) ? ctx.parse(subqueryExpr) : ctx.parse(parenExpr);
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
        // IS [NOT] JSON [VALUE | SCALAR | ARRAY | OBJECT] [{WITH | WITHOUT}
        // UNIQUE [KEYS]]. Nothing else may follow IS, so `json` needs no guard.
        // The words after it are taken unconditionally, as PG's grammar takes
        // them: `x IS JSON value` is the VALUE form, never an alias, and a WITH
        // or WITHOUT there must open the uniqueness clause — so `x IS JSON
        // without` and a materialized view's trailing `… IS JSON WITH NO DATA`
        // are errors, exactly as in PG. Only KEYS, which follows UNIQUE, is
        // optional and stays an alias anywhere else (`x IS JSON keys`).
        if (ctx.eat("ident", "json") !== null) {
          const itemType = (ctx.eat("ident", ["value", "scalar", "array", "object"])?.value ?? null) as
            | "value"
            | "scalar"
            | "array"
            | "object"
            | null;
          let uniqueKeys: boolean | null = null;
          const uniqueness = ctx.eat("ident", ["with", "without"]);
          if (uniqueness !== null) {
            uniqueKeys = uniqueness.value === "with";
            ctx.parse(kw("unique"));
            ctx.eat("ident", "keys");
          }
          return { kind: "isJson", expr: left, itemType, uniqueKeys, negated, span: closeSpan(left, ctx.lastEnd()) };
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
// forms — see `bExpression` above. (OVERLAPS lives in the shared atom, so it is
// the one predicate that still reaches it.) Used for the first operand of POSITION so its
// `IN` separator is left for the special-call parser instead of the `in` postfix.
const bExprRule = pratt<Expr, SqlTokenType>({
  atom,
  prefix: [unarySignPrefix],
  infix: arithInfix,
  postfix: [castPostfix, subscriptPostfix],
});

// --- keyword dispatch maps ---
// Six rules below (column constraints, a foreign key's referential actions,
// table constraints, ALTER TABLE actions and the CREATE and ALTER targets) all
// answer the same question — "which keyword leads here?" — and all grow one
// entry at a time. Each keeps that answer in a plain record keyed by the lead
// word instead of an `oneOf` chain or a ladder of `if`s, so extending one is a
// single entry and the `expected` string is *derived* from the record rather
// than restated alongside it.
//
// Dispatch peeks; every handler consumes its own lead word, and every one that
// builds a node captures its own `start` unless one is handed in, so the nodes
// keep opening their spans on the keyword.
type DispatchEntry<T, A extends unknown[]> = {
  // How this branch names itself in an "Expected …" message. Defaults to the
  // quoted key, so it is spelled out only where the two differ — a multi-word
  // lead (`primary` → `"primary key"`) or two keys sharing one label.
  expected?: string;
  parse: (ctx: ParseContext<SqlTokenType>, ...args: A) => T;
};
type DispatchMap<T, A extends unknown[] = []> = Record<string, DispatchEntry<T, A>>;

// The two expected-string derivations, which are NOT interchangeable.
//
// `joinExpected` is for a rule whose message is composed by an enclosing oneOf
// (`a or b or c`); it mirrors oneOf's own join, dedupe included, so nesting the
// rule in a oneOf reads exactly as the hand-written alternation did.
const joinExpected = (map: Record<string, { expected?: string }>): string => {
  const parts: string[] = [];
  for (const [key, entry] of Object.entries(map)) {
    const part = entry.expected ?? renderLiteral(key);
    if (!parts.includes(part)) parts.push(part);
  }
  return parts.join(" or ");
};

// `quoteList(Object.keys(map))` is for a rule that croaks by hand, in the comma
// form (`"a", "b" or "c"`). It quotes the KEYS, ignoring entry labels entirely:
// a handler that goes on to consume `OWNER TO` still announces itself as
// "owner", which is the one word that actually selects it.
const keyList = (map: Record<string, unknown>): string => quoteList(Object.keys(map));

const dispatchFirst = (map: Record<string, unknown>): FirstEntry<SqlTokenType>[] =>
  Object.keys(map).map((value) => ({ type: "ident", value }));

// The lead word's entry, or undefined when the word leads nothing here.
//
// `Object.hasOwn`, not a bare `!== undefined`: a record literal inherits
// `constructor` and `__proto__` from Object.prototype, so `ALTER TABLE t
// constructor;` would otherwise find an "entry" carrying no `parse` and throw a
// TypeError clear of the grammar instead of croaking like any other unknown
// word. The `ident` check is what keeps a quoted `"add"` (a `qident`) out.
function lookup<T, A extends unknown[]>(
  map: DispatchMap<T, A>,
  tok: Token<SqlTokenType> | null,
): DispatchEntry<T, A> | undefined {
  if (tok === null || tok.type !== "ident" || !Object.hasOwn(map, tok.value)) return undefined;
  return map[tok.value];
}

// Peek at the lead word and hand off to its entry, or croak with `expected`.
function dispatch<T, A extends unknown[]>(
  map: DispatchMap<T, A>,
  expected: string,
  ctx: ParseContext<SqlTokenType>,
  ...args: A
): T {
  const entry = lookup(map, ctx.peek());
  if (entry !== undefined) return entry.parse(ctx, ...args);
  return ctx.croak(`Expected ${expected} but found ${describeFound(ctx.peek())}`);
}

// --- constraints ---

const columnList = delimited(P("("), P(")"), P(","), nameWord, { interleaved: true });

const optColumnList = optional(columnList);

// A foreign key's referential actions. `set` leads two of them, so these could
// not be oneOf branches (their first sets would overlap); the map lets the `set`
// entry read the word after it instead.
const setActionTarget = oneOf(kw("null"), kw("default"));
const REF_ACTIONS: DispatchMap<RefAction> = {
  no: {
    expected: '"no action"',
    parse: (ctx) => {
      ctx.parse(kwseq("no", "action"));
      return "no action";
    },
  },
  restrict: {
    parse: (ctx) => {
      ctx.parse(kw("restrict"));
      return "restrict";
    },
  },
  cascade: {
    parse: (ctx) => {
      ctx.parse(kw("cascade"));
      return "cascade";
    },
  },
  set: {
    expected: '"set null" or "set default"',
    parse: (ctx) => {
      ctx.parse(kw("set"));
      return ctx.parse(setActionTarget).value === "null" ? "set null" : "set default";
    },
  },
};

// The join form although dispatch() croaks by hand: it is what the oneOf this
// replaced produced, and it spells out the two-word actions in full.
const REF_ACTION_EXPECTED = joinExpected(REF_ACTIONS);

// PARTIAL is accepted on purpose: PG's grammar rejects it ("MATCH PARTIAL not
// yet implemented"), but that is a missing executor feature, not a syntax rule.
const matchType = oneOf(kw("full"), kw("partial"), kw("simple"));

// `[MATCH FULL | PARTIAL | SIMPLE]`, then ON DELETE and ON UPDATE in either
// order, each at most once — PG's `key_match key_actions`. The two ON clauses
// share one loop rather than being two `optional(phrase)`s: phrase() commits on
// `on` with no rollback, so whichever came first would croak on the other's
// verb. A repeated verb croaks naming the one still open, as PG rejects it too;
// once both are filled the loop stops, and a third ON is left to the caller.
function parseForeignKeyTail(ctx: ParseContext<SqlTokenType>): ForeignKeyTail {
  const match =
    ctx.eat("ident", "match") !== null ? (ctx.parse(matchType).value as "full" | "partial" | "simple") : null;
  let onDelete: RefAction | null = null;
  let onUpdate: RefAction | null = null;
  while ((onDelete === null || onUpdate === null) && ctx.is("ident", "on")) {
    ctx.next(); // ON
    if (onDelete === null && ctx.eat("ident", "delete") !== null) {
      onDelete = dispatch(REF_ACTIONS, REF_ACTION_EXPECTED, ctx);
    } else if (onUpdate === null && ctx.eat("ident", "update") !== null) {
      onUpdate = dispatch(REF_ACTIONS, REF_ACTION_EXPECTED, ctx);
    } else {
      const open = [...(onDelete === null ? ["delete"] : []), ...(onUpdate === null ? ["update"] : [])];
      return ctx.croak(`Expected ${quoteList(open)} but found ${describeFound(ctx.peek())}`);
    }
  }
  return { ...(match && { match }), onDelete, ...(onUpdate && { onUpdate }) };
}

const initiallyWhen = oneOf(kw("deferred"), kw("immediate"));

// True when the cursor sits on `NOT DEFERRABLE`. Lexing is lazy, so the peek
// past `not` is taken only on a `not`: peeking on every token would raise the
// lex error of a token two on from inside the constraint handler, and
// diagnose() would drop the constraint — and the column — over a character the
// column never reaches. After a `not` in a column constraint there is nothing
// to save: NOT NULL would raise the same error on the same token. (At table
// level the tail meets a bad token inside the constraint rather than between
// items, so diagnose() keeps the table around it.)
function atNotDeferrable(ctx: ParseContext<SqlTokenType>): boolean {
  if (!ctx.is("ident", "not")) return false;
  const next = ctx.peekAhead(1);
  return next !== null && next.type === "ident" && next.value === "deferrable";
}

// `[NOT] DEFERRABLE` and `INITIALLY DEFERRED | IMMEDIATE`, in either order. Only
// UNIQUE, PRIMARY KEY, foreign keys and EXCLUDE read this tail, so PG's "misplaced
// DEFERRABLE clause" (`a int NOT NULL DEFERRABLE`) never parses.
//
// `not` is shared with a following column constraint's NOT NULL, so it is taken
// here only when `deferrable` comes next; a bare `ctx.eat("not")` would steal
// `a int UNIQUE NOT NULL`.
//
// A second clause of either kind is still read, rather than falling out of the
// loop to be misread as the start of the next constraint, and is then judged as
// PG judges it — which differs by level. A column constraint's attributes are
// separate list items checked after parsing (`transformConstraintAttrs`), where
// any repeat is an error. A table constraint's are one `ConstraintAttributeSpec`
// checked in its grammar action, which lets an identical repeat
// through and reports only a contradiction. Both levels reject a constraint that
// can never be deferred starting out deferred; the column check looks for a
// repeat first, the table check for that case first, and so do these.
function parseConstraintAttrs(ctx: ParseContext<SqlTokenType>, level: "column" | "table"): ConstraintAttrs {
  let deferrable: boolean | null = null;
  let initially: "deferred" | "immediate" | null = null;
  while (true) {
    const start = ctx.position();
    const negated = atNotDeferrable(ctx);
    let repeated: string;
    let conflicting: boolean;
    if (negated || ctx.is("ident", "deferrable")) {
      ctx.parse(negated ? kwseq("not", "deferrable") : kw("deferrable"));
      repeated = "multiple DEFERRABLE/NOT DEFERRABLE clauses not allowed";
      conflicting = deferrable !== null && (level === "column" || deferrable === negated);
      deferrable = !negated;
    } else if (ctx.eat("ident", "initially") !== null) {
      const when = ctx.parse(initiallyWhen).value as "deferred" | "immediate";
      repeated = "multiple INITIALLY IMMEDIATE/DEFERRED clauses not allowed";
      conflicting = initially !== null && (level === "column" || initially !== when);
      initially = when;
    } else {
      break;
    }
    const neverDeferred = deferrable === false && initially === "deferred";
    if (conflicting && (level === "column" || !neverDeferred)) {
      return ctx.croak(level === "column" ? repeated : "conflicting constraint properties", start, ctx.lastEnd());
    }
    if (neverDeferred) {
      return ctx.croak("constraint declared INITIALLY DEFERRED must be DEFERRABLE", start, ctx.lastEnd());
    }
  }
  return { ...(deferrable !== null && { deferrable }), ...(initially && { initially }) };
}

const COLUMN_CONSTRAINTS: DispatchMap<ColConstraint> = {
  not: {
    expected: '"not null"',
    parse: (ctx) => {
      const start = ctx.position();
      ctx.parse(kwseq("not", "null"));
      return { kind: "notNull", span: ctx.spanFrom(start) };
    },
  },
  null: {
    parse: (ctx) => {
      const start = ctx.position();
      ctx.parse(kw("null"));
      return { kind: "nullable", span: ctx.spanFrom(start) };
    },
  },
  default: {
    parse: (ctx) => {
      const start = ctx.position();
      ctx.parse(kw("default"));
      return { kind: "default", expr: ctx.parse(expression), span: ctx.spanFrom(start) };
    },
  },
  primary: {
    expected: '"primary key"',
    parse: (ctx) => {
      const start = ctx.position();
      ctx.parse(kwseq("primary", "key"));
      const attrs = parseConstraintAttrs(ctx, "column");
      return { kind: "primaryKey", ...attrs, span: ctx.spanFrom(start) };
    },
  },
  unique: {
    parse: (ctx) => {
      const start = ctx.position();
      ctx.parse(kw("unique"));
      const attrs = parseConstraintAttrs(ctx, "column");
      return { kind: "unique", ...attrs, span: ctx.spanFrom(start) };
    },
  },
  references: {
    parse: (ctx) => {
      const start = ctx.position();
      ctx.parse(kw("references"));
      const table = ctx.parse(qualName);
      const columns = ctx.parse(optColumnList);
      const tail = parseForeignKeyTail(ctx);
      const attrs = parseConstraintAttrs(ctx, "column");
      return { kind: "references", table, columns, ...tail, ...attrs, span: ctx.spanFrom(start) };
    },
  },
  check: {
    parse: (ctx) => {
      const start = ctx.position();
      ctx.parse(kw("check"));
      return { kind: "check", expr: ctx.parse(parenExpr), span: ctx.spanFrom(start) };
    },
  },
  // `GENERATED {ALWAYS | BY DEFAULT} AS IDENTITY [(options)]` or `GENERATED
  // ALWAYS AS (expr) STORED`. The handler owns all of its lookahead, so one key
  // covers both forms. As in PG, BY DEFAULT is only for identity columns, and
  // STORED is required (PG 18's VIRTUAL and bare form are not parsed); PG's
  // identity-only `SEQUENCE NAME` option is not parsed yet. GENERATED, ALWAYS,
  // IDENTITY and STORED stay unreserved: they are matched only here, in a
  // column's constraint list.
  generated: {
    parse: (ctx) => {
      const start = ctx.position();
      ctx.parse(kw("generated"));
      const whenStart = ctx.position();
      let generated: "always" | "by default";
      if (ctx.eat("ident", "always") !== null) {
        generated = "always";
      } else if (ctx.is("ident", "by")) {
        ctx.parse(kwseq("by", "default"));
        generated = "by default";
      } else {
        return ctx.croak(`Expected ${quoteList(["always", "by default"])} but found ${describeFound(ctx.peek())}`);
      }
      const whenEnd = ctx.lastEnd();
      ctx.parse(kw("as"));
      if (ctx.eat("ident", "identity") !== null) {
        if (ctx.eat("punc", "(") === null) return { kind: "identity", generated, span: ctx.spanFrom(start) };
        // At least one option, as in PG: an empty `IDENTITY ()` is an error.
        const options = parseSequenceOptions(ctx);
        if (options.length === 0) ctx.croak(`Expected a sequence option but found ${describeFound(ctx.peek())}`);
        expectClose(ctx);
        return { kind: "identity", generated, options, span: ctx.spanFrom(start) };
      }
      if (!ctx.is("punc", "(")) {
        return ctx.croak(`Expected ${quoteList(["identity", "("])} but found ${describeFound(ctx.peek())}`);
      }
      const expr = ctx.parse(parenExpr);
      ctx.parse(kw("stored"));
      // Judged once the clause is whole and pinned to the BY DEFAULT, as PG does.
      if (generated !== "always") {
        return ctx.croak("for a generated column, GENERATED ALWAYS must be specified", whenStart, whenEnd);
      }
      return { kind: "generated", expr, span: ctx.spanFrom(start) };
    },
  },
  // Column-level `COLLATE name`. `collate` is reserved, so it cannot be a type
  // word and, straight after the type, it can only be this. After a DEFAULT,
  // though, the expression's COLLATE postfix takes it first: `DEFAULT 'a'
  // COLLATE "C"` collates the default, where PG (whose DEFAULT operand has no
  // COLLATE) would collate the column. Write the COLLATE before the DEFAULT.
  collate: {
    parse: (ctx) => {
      const start = ctx.position();
      ctx.parse(kw("collate"));
      return { kind: "collate", collation: ctx.parse(qualName), span: ctx.spanFrom(start) };
    },
  },
};

const COLUMN_CONSTRAINT_EXPECTED = joinExpected(COLUMN_CONSTRAINTS);

const columnConstraint = custom<ColConstraint, SqlTokenType>(
  (ctx) => dispatch(COLUMN_CONSTRAINTS, COLUMN_CONSTRAINT_EXPECTED, ctx),
  { expected: COLUMN_CONSTRAINT_EXPECTED, first: dispatchFirst(COLUMN_CONSTRAINTS) },
);

// The keyword-led table constraints. Every entry here joins `tableItem`'s
// first set (via tableConstraint), where it competes with a column definition's
// bare name — so a key added here takes that name away from columns.
const TABLE_CONSTRAINTS: DispatchMap<TableConstraint> = {
  primary: {
    expected: '"primary key"',
    parse: (ctx) => {
      const start = ctx.position();
      ctx.parse(kwseq("primary", "key"));
      const columns = ctx.parse(columnList);
      const attrs = parseConstraintAttrs(ctx, "table");
      return { kind: "primaryKey", name: null, columns, ...attrs, span: ctx.spanFrom(start) };
    },
  },
  unique: {
    parse: (ctx) => {
      const start = ctx.position();
      ctx.parse(kw("unique"));
      const columns = ctx.parse(columnList);
      const attrs = parseConstraintAttrs(ctx, "table");
      return { kind: "unique", name: null, columns, ...attrs, span: ctx.spanFrom(start) };
    },
  },
  check: {
    parse: (ctx) => {
      const start = ctx.position();
      ctx.parse(kw("check"));
      return { kind: "check", name: null, expr: ctx.parse(parenExpr), span: ctx.spanFrom(start) };
    },
  },
  foreign: {
    expected: '"foreign key"',
    parse: (ctx) => {
      const start = ctx.position();
      ctx.parse(kwseq("foreign", "key"));
      const columns = ctx.parse(columnList);
      ctx.parse(kw("references"));
      const refTable = ctx.parse(qualName);
      const refColumns = ctx.parse(optColumnList);
      const tail = parseForeignKeyTail(ctx);
      const attrs = parseConstraintAttrs(ctx, "table");
      return {
        kind: "foreignKey",
        name: null,
        columns,
        refTable,
        refColumns,
        ...tail,
        ...attrs,
        span: ctx.spanFrom(start),
      };
    },
  },
};

const TABLE_CONSTRAINT_EXPECTED = joinExpected(TABLE_CONSTRAINTS);

const tableConstraintBody = custom<TableConstraint, SqlTokenType>(
  (ctx) => dispatch(TABLE_CONSTRAINTS, TABLE_CONSTRAINT_EXPECTED, ctx),
  { expected: TABLE_CONSTRAINT_EXPECTED, first: dispatchFirst(TABLE_CONSTRAINTS) },
);

// `element WITH operator`. PG's element is a column, a call or a parenthesised
// expression; this takes any expression, more loosely. The expression grammar
// never consumes the WITH. Per-element opclass / ASC / NULLS options and
// `WITH OPERATOR(…)` are not parsed yet.
const exclusionElement = seq(
  field("expr", expression),
  skip(kw("with")),
  field(
    "operator",
    token("op").map((node) => node.value),
  ),
).map(({ expr, operator }, span): ExclusionElement => ({ expr, operator, span }));

// At least one entry, as in PG: an empty `EXCLUDE ()` or `INCLUDE ()` is a
// syntax error.
const exclusionElements = sepBy(exclusionElement, P(","));
const includeColumns = sepBy(nameWord, P(","));

// True when the cursor sits on `EXCLUDE USING` or `EXCLUDE (` — neither of
// which can begin a column definition, as `using` is reserved and `(` cannot
// begin a type. The ident test keeps `exclude "using"` (a column of quoted type
// "using") a column. The token after `exclude` is peeked plainly: a column
// definition reads it next anyway, so a lex error there surfaces exactly as it
// does after any other column name.
function atExcludeConstraint(ctx: ParseContext<SqlTokenType>): boolean {
  if (!ctx.is("ident", "exclude")) return false;
  const next = ctx.peekAhead(1);
  return (
    next !== null && ((next.type === "ident" && next.value === "using") || (next.type === "punc" && next.value === "("))
  );
}

// `EXCLUDE [USING method] (element WITH operator, …) [INCLUDE (cols)] [WHERE
// (pred)]` plus the DEFERRABLE/INITIALLY tail. Kept out of TABLE_CONSTRAINTS on
// purpose: `exclude` is unreserved, and a key there would join tableItem's
// value-specific first set and take the word away from columns (see tableItem).
// PG's index parameters (`WITH (…)`, `USING INDEX TABLESPACE`) are not parsed
// yet.
const excludeBody = custom<ExcludeConstraint, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    ctx.parse(kw("exclude"));
    const using = ctx.eat("ident", "using") !== null ? ctx.parse(nameWord) : null;
    ctx.parse(punc("("));
    const elements = ctx.parse(exclusionElements);
    expectClose(ctx);
    let include: string[] | null = null;
    if (ctx.eat("ident", "include") !== null) {
      ctx.parse(punc("("));
      include = ctx.parse(includeColumns);
      expectClose(ctx);
    }
    const where = ctx.eat("ident", "where") !== null ? ctx.parse(parenExpr) : null;
    const attrs = parseConstraintAttrs(ctx, "table");
    return {
      kind: "exclude",
      name: null,
      using,
      elements,
      ...(include && { include }),
      ...(where && { where }),
      ...attrs,
      span: ctx.spanFrom(start),
    };
  },
  { expected: '"exclude"', first: [{ type: "ident", value: "exclude" }] },
);

// What follows `CONSTRAINT name`: a keyword-led constraint or EXCLUDE. Both may
// commit here, as no column definition competes after CONSTRAINT.
const constraintBody = oneOf(tableConstraintBody, excludeBody);

const namedConstraint = seq(skip(kw("constraint")), field("name", nameWord), field("body", constraintBody)).map(
  ({ name, body }): TableConstraint => ({ ...body, name }),
);

const tableConstraint = oneOf(namedConstraint, tableConstraintBody);

const columnDef = seq(
  field("name", nameWord),
  field("dataType", typeRef),
  field("constraints", many(columnConstraint)),
).map(({ name, dataType, constraints }, span): ColumnDef => ({ kind: "column", name, dataType, constraints, span }));

// A table item led by `exclude`: an EXCLUDE constraint when the lookahead says
// so, else a column called `exclude`. Decided by peeking rather than by
// `attempt`, so a malformed EXCLUDE reports its own error — a backtrack would
// drop it, and a lex error inside it for good, then blame the column instead.
const excludeItem = custom<ExcludeConstraint | ColumnDef, SqlTokenType>(
  (ctx) => (atExcludeConstraint(ctx) ? ctx.parse(excludeBody) : ctx.parse(columnDef)),
  { expected: '"exclude"', first: [{ type: "ident", value: "exclude" }] },
);

// The properties a LIKE option may copy, in the order PG's TableLikeOption
// lists them — which is also the order the "Expected …" message names them in.
const likeProperty = token("ident", {
  values: [
    "comments",
    "compression",
    "constraints",
    "defaults",
    "identity",
    "generated",
    "indexes",
    "statistics",
    "storage",
    "all",
  ],
}).map((node) => node.value as LikeOption["property"]);

// `LIKE source [{INCLUDING | EXCLUDING} property …]`. The options are optional,
// so `LIKE src` and a column `like text` are the same two tokens and no
// lookahead can tell them apart: in a table body, `like` always leads this
// clause (see tableItem). The option words need no reservation: after the
// source name only `,` or `)` could otherwise follow.
const likeBody = custom<LikeTable, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    ctx.parse(kw("like"));
    const table = ctx.parse(qualName);
    const options: LikeOption[] = [];
    while (ctx.is("ident", ["including", "excluding"])) {
      const mode = ctx.next()!.value as LikeOption["mode"];
      options.push({ mode, property: ctx.parse(likeProperty) });
    }
    return { kind: "likeTable", table, options, span: ctx.spanFrom(start) };
  },
  { expected: '"like"', first: [{ type: "ident", value: "like" }] },
);

// A table body item: a table constraint, a LIKE clause or an `exclude`-led item
// (an EXCLUDE, or a column of that name) — all keyword-led, a value-specific
// first set — or a column definition (name-led, type-only). oneOf's
// value-specific-first dispatch picks the constraint on `primary`/`unique`/…,
// LIKE on `like`, excludeItem on `exclude`, and the column on any other name. A
// value-specific key wins even over a word that could be a column name, so a
// key ahead of `columnDef` takes its word away from columns. For the
// constraint and LIKE keys that is harmless only because each is reserved
// anyway — `like` for exactly this reason (see RESERVED). A key that is a legal
// column name must parse that column itself, as excludeItem does for `exclude
// text` and `exclude "using"`.
//
// Branch order is load-bearing: oneOf joins its `expected` in declaration order,
// which the diagnostics golden pins.
const tableItem = oneOf(tableConstraint, likeBody, excludeItem, columnDef);

// --- statements ---

// `WITH [NO] DATA` — the trailing materialization flag on CREATE TABLE AS /
// MATERIALIZED VIEW. Returns true (WITH DATA), false (WITH NO DATA), or null when
// no clause follows. The preceding query does not usually consume it (WITH DATA
// is not a query continuation, and typeRef takes a WITH only as `WITH TIME
// ZONE`), so a bare `ctx.is("with")` peek is enough here. Two query endings do
// take a WITH unconditionally, and so leave none for this clause: a trailing
// `IS JSON` (its uniqueness clause, as in PG) and a FETCH clause not closed by
// ONLY (its WITH TIES).
function parseWithData(ctx: ParseContext<SqlTokenType>): boolean | null {
  if (!ctx.is("ident", "with")) return null;
  ctx.next(); // WITH
  if (ctx.eat("ident", "no") !== null) {
    ctx.parse(kw("data"));
    return false;
  }
  ctx.parse(kw("data"));
  return true;
}

// `([namespace.]name [[=] value], …)` — PG's generic option list: the storage
// parameters of `CREATE TABLE … WITH (…)`, and the same shape its index, view,
// COPY, EXPLAIN, ALTER TABLE SET/RESET and partition-bound options take, which
// is why it is a shared rule rather than local to CREATE TABLE. Both halves of
// the value are optional: a bare name is a boolean option set to true
// (`security_barrier`), and the `=` may be left out (`MODULUS 4`, `FORMAT csv`).
// That makes `WITH (fillfactor 70)` legal here although PG's reloption grammar
// wants the `=`; one shape for every list is the trade. The same goes for the
// `toast.` namespace, which only reloptions take, and for COPY's `*` and list
// values. (RESET's values-free form is PG's to police too: its grammar takes the
// same list and rejects a value only in analysis.)
//
// Option names are PG's ColLabel, so a reserved word is a name here too
// (`EXPLAIN (ANALYZE)`, COPY's `NULL '…'`). A word value may also be reserved
// (`= on`), and `true`/`false` are read as booleans, as they are everywhere.
// A list whose entries are not parenthesised (CREATE DATABASE's `WITH OWNER = x
// TEMPLATE t0`) can reuse `relationOption`, the single entry — all but its
// two-word `CONNECTION LIMIT`, which PG's grammar special-cases too.
function optionName(ctx: ParseContext<SqlTokenType>): string {
  const tok = ctx.peek();
  if (tok === null || (tok.type !== "ident" && tok.type !== "qident")) {
    return ctx.croak(`Expected an option name but found ${describeFound(tok)}`);
  }
  ctx.next();
  return tok.value;
}

// A value that is not itself a list: a number (a sign included), a string, a
// boolean or a word.
function optionScalar(ctx: ParseContext<SqlTokenType>): RelationOptionScalar {
  const start = ctx.position();
  const tok = ctx.peek();
  // A signed number is one value, its sign included in the span.
  const sign = tok?.type === "op" && (tok.value === "-" || tok.value === "+") ? tok.value : null;
  if (sign !== null && ctx.peekAhead(1)?.type === "number") {
    ctx.next(); // the sign
    const value = Number(ctx.next()!.value);
    return { kind: "number", value: sign === "-" ? -value : value, span: ctx.spanFrom(start) };
  }
  if (tok?.type === "number") return { kind: "number", value: Number(ctx.next()!.value), span: ctx.spanFrom(start) };
  if (tok?.type === "string") return { kind: "string", value: ctx.next()!.value, span: ctx.spanFrom(start) };
  if (tok?.type === "ident" && (tok.value === "true" || tok.value === "false")) {
    ctx.next();
    return { kind: "bool", value: tok.value === "true", span: ctx.spanFrom(start) };
  }
  if (tok?.type === "ident" || tok?.type === "qident") {
    ctx.next();
    return { kind: "name", parts: [tok.value], span: ctx.spanFrom(start) };
  }
  return ctx.croak(`Expected an option value but found ${describeFound(tok)}`);
}

function optionValue(ctx: ParseContext<SqlTokenType>): RelationOptionValue {
  const start = ctx.position();
  if (ctx.is("op", "*")) {
    ctx.next();
    return { kind: "star", table: null, span: ctx.spanFrom(start) };
  }
  if (ctx.eat("punc", "(") !== null) {
    const items: RelationOptionScalar[] = [];
    do {
      items.push(optionScalar(ctx));
    } while (ctx.eat("punc", ",") !== null);
    expectClose(ctx);
    return { kind: "optionList", items, span: ctx.spanFrom(start) };
  }
  return optionScalar(ctx);
}

const relationOption = custom<RelationOption, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    const first = optionName(ctx);
    const namespace = ctx.eat("punc", ".") !== null ? first : null;
    const name = namespace !== null ? optionName(ctx) : first;
    // With `=` a value must follow; without it, one does unless the entry ends.
    const hasEq = ctx.eat("op", "=") !== null;
    const value = hasEq || !(ctx.is("punc", ",") || ctx.is("punc", ")")) ? optionValue(ctx) : null;
    return { ...(namespace !== null && { namespace }), name, value, span: ctx.spanFrom(start) };
  },
  { expected: "an option name", first: [{ type: "ident" }, { type: "qident" }] },
);

const relationOptions = custom<RelationOption[], SqlTokenType>(
  (ctx) => {
    if (!ctx.is("punc", "(")) ctx.croak(`Expected "(" but found ${describeFound(ctx.peek())}`);
    ctx.next(); // "("
    const options: RelationOption[] = [];
    do {
      options.push(ctx.parse(relationOption));
    } while (ctx.eat("punc", ",") !== null);
    expectClose(ctx);
    return options;
  },
  { expected: '"("', first: [{ type: "punc", value: "(" }] },
);

// The storage clauses, in the fixed order PG's CreateStmt gives them: `[WITH
// (option, …)] [ON COMMIT {PRESERVE ROWS | DELETE ROWS | DROP}] [TABLESPACE
// name]`. CREATE TABLE takes them last — after its element list, INHERITS and
// PARTITION BY (below), or after a partition's bound and PARTITION BY — and
// CREATE TABLE AS ahead of its AS. Written out of order they are an error, as
// in PG. Every key is set only when its clause is written, so a table with none
// of them keeps exactly the node it had before they existed.
//
// The lead words take no name away: `with` and `on` are reserved, and in any of
// these positions nothing else but `;` or `AS` could follow. PG accepts ON
// COMMIT on any table in its grammar and rejects it on a permanent one only in
// analysis; this parser has no analysis pass, so it accepts it everywhere.
type StorageClauses = Pick<CreateTableAs, "options" | "onCommit" | "tablespace">;
type TableClauses = Pick<Extract<Stmt, { kind: "createTable" }>, "inherits" | "partitionBy"> & StorageClauses;

const onCommitAction = oneOf(
  kwseq("preserve", "rows").map(() => "preserveRows" as const),
  kwseq("delete", "rows").map(() => "deleteRows" as const),
  kw("drop").map(() => "drop" as const),
);

function parseStorageClauses(ctx: ParseContext<SqlTokenType>): StorageClauses {
  const clauses: StorageClauses = {};
  if (ctx.eat("ident", "with") !== null) clauses.options = ctx.parse(relationOptions);
  if (ctx.is("ident", "on")) {
    ctx.parse(kwseq("on", "commit"));
    clauses.onCommit = ctx.parse(onCommitAction);
  }
  if (ctx.eat("ident", "tablespace") !== null) clauses.tablespace = ctx.parse(nameWord);
  return clauses;
}

// --- declarative partitioning ---
//
// Every word here is matched by value where no name could stand — past a
// table's name or its element list's `)`, or inside a clause already begun —
// so none of them is reserved, and each stays a name everywhere else.

// PG reads the strategy as a ColId and compares it ignoring case, so a quoted
// `"RANGE"` names it too.
const PARTITION_STRATEGIES = ["range", "list", "hash"] as const;

function partitionStrategy(ctx: ParseContext<SqlTokenType>): PartitionSpec["strategy"] {
  const tok = ctx.peek();
  const word = tok?.type === "ident" || tok?.type === "qident" ? tok.value.toLowerCase() : null;
  const strategy = PARTITION_STRATEGIES.find((s) => s === word);
  if (strategy === undefined) {
    return ctx.croak(`Expected ${quoteList([...PARTITION_STRATEGIES])} but found ${describeFound(tok)}`);
  }
  ctx.next();
  return strategy;
}

// The expression forms PG's `part_elem` takes unparenthesised: a column (its
// ColId, so one part) or a function call, the special-syntax ones (EXTRACT,
// CURRENT_DATE, …) included, as PG's func_expr_windowless includes them. CAST
// is one of those too, but its node is a `::` cast's as well, so partitionKey
// tells the two apart by the lead word instead.
const BARE_PARTITION_KEYS = new Set<Expr["kind"]>([
  "name",
  "call",
  "extract",
  "substring",
  "position",
  "trim",
  "overlay",
  "sqlValueFunction",
]);

// `column | func(…) | (expr)`, then `[COLLATE collation] [opclass]`. A bare key
// goes through the full expression rule, whose COLLATE postfix takes the
// collation; it is lifted off the node here, since in PG it belongs to the key,
// not the expression. Anything else unparenthesised — `a + b`, `t.a`, `a::int`
// — is PG's syntax error, and so is it here. A `CAST(…)` key is a cast node led
// by `cast` whose operand starts after it: `CAST(a AS int)::text` is led by
// `cast` too, but its outer cast's operand starts where it does.
function partitionKey(ctx: ParseContext<SqlTokenType>): PartitionKey {
  const start = ctx.position();
  let expr: Expr;
  let collate: string[] | null = null;
  if (ctx.is("punc", "(")) {
    expr = ctx.parse(parenExpr);
    if (ctx.eat("ident", "collate") !== null) collate = ctx.parse(qualName);
  } else {
    const castCall = ctx.is("ident", "cast");
    expr = ctx.parse(expression);
    if (expr.kind === "collate") {
      collate = expr.collation;
      expr = expr.expr;
    }
    const bare =
      expr.kind === "cast"
        ? castCall &&
          (expr.expr.span.start.row !== expr.span.start.row || expr.expr.span.start.col !== expr.span.start.col)
        : BARE_PARTITION_KEYS.has(expr.kind) && !(expr.kind === "name" && expr.parts.length > 1);
    if (!bare) {
      return ctx.croak("a partition key expression must be parenthesised", start, ctx.lastEnd());
    }
  }
  // An opclass is a name, so a reserved word (a stray `DESC`, say) is left for
  // the list's own "Expected …" rather than read as one.
  const next = ctx.peek();
  const opclass =
    next?.type === "qident" || (next?.type === "ident" && !RESERVED.has(next.value)) ? ctx.parse(qualName) : null;
  return { expr, ...(collate && { collate }), ...(opclass && { opclass }), span: ctx.spanFrom(start) };
}

// `[PARTITION BY {RANGE | LIST | HASH} (key, …)]`. `partition` can only lead
// this clause here: after the element list (or a partition's bound) nothing
// but a clause or `;` follows.
function parsePartitionBy(ctx: ParseContext<SqlTokenType>): Pick<TableClauses, "partitionBy"> {
  if (!ctx.is("ident", "partition")) return {};
  const start = ctx.position();
  ctx.parse(kwseq("partition", "by"));
  const strategy = partitionStrategy(ctx);
  if (!ctx.is("punc", "(")) ctx.croak(`Expected "(" but found ${describeFound(ctx.peek())}`);
  ctx.next(); // "("
  const keys: PartitionKey[] = [];
  do {
    keys.push(partitionKey(ctx));
  } while (ctx.eat("punc", ",") !== null);
  expectClose(ctx);
  // PG's analysis-time check, made here as hashBound's are.
  if (strategy === "list" && keys.length > 1) {
    ctx.croak('cannot use "list" partition strategy with more than one column', start, ctx.lastEnd());
  }
  return { partitionBy: { strategy, keys, span: ctx.spanFrom(start) } };
}

// `(datum, …)` of a range bound. MINVALUE / MAXVALUE are read the way PG reads
// them: as a one-part column reference, recognised by name afterwards. As in
// PG's validateInfiniteBounds, only the same word may follow either one.
function rangeDatums(ctx: ParseContext<SqlTokenType>): PartitionRangeDatum[] {
  if (!ctx.is("punc", "(")) ctx.croak(`Expected "(" but found ${describeFound(ctx.peek())}`);
  ctx.next(); // "("
  const datums: PartitionRangeDatum[] = [];
  do {
    const e = ctx.parse(expression);
    const word = e.kind === "name" && e.parts.length === 1 ? e.parts[0] : null;
    const datum: PartitionRangeDatum = word === "minvalue" || word === "maxvalue" ? { kind: word, span: e.span } : e;
    const prev = datums[datums.length - 1];
    if ((prev?.kind === "minvalue" || prev?.kind === "maxvalue") && datum.kind !== prev.kind) {
      const label = prev.kind.toUpperCase();
      ctx.croak(`every bound following ${label} must also be ${label}`, e.span.start, e.span.end);
    }
    datums.push(datum);
  } while (ctx.eat("punc", ",") !== null);
  expectClose(ctx);
  return datums;
}

// `WITH (MODULUS n, REMAINDER m)` — read as a generic option list, then held to
// what PG's PartitionBoundSpec action enforces for a hash bound: both names,
// each once, nothing else. The value checks, `remainder < modulus` among them, are PG's
// analysis-time ones; with no analysis pass, this is the only place they can be
// made. PG takes each value as an unsigned int4 literal; the option list keeps
// only the number, so `4.0` and `4e0` pass for 4 here, but the int4 range holds.
const INT4_MAX = 2 ** 31 - 1;

function hashBound(ctx: ParseContext<SqlTokenType>, start: Position): PartitionBound {
  const options = ctx.parse(relationOptions);
  const seen: { modulus?: number; remainder?: number } = {};
  for (const opt of options) {
    const label = opt.namespace !== undefined ? `${opt.namespace}.${opt.name}` : opt.name;
    if (opt.namespace !== undefined || (opt.name !== "modulus" && opt.name !== "remainder")) {
      return ctx.croak(`unrecognized hash partition bound specification "${label}"`, opt.span.start, opt.span.end);
    }
    if (seen[opt.name] !== undefined) {
      return ctx.croak(`${opt.name} for hash partition provided more than once`, opt.span.start, opt.span.end);
    }
    const value = opt.value?.kind === "number" ? opt.value.value : null;
    // What stands in for PG's Iconst syntax is checked here, in source order;
    // a zero modulus is an analysis-time error, so it waits for the loop's end.
    if (value === null || !Number.isInteger(value) || value < 0) {
      const bound = opt.name === "modulus" ? "greater than zero" : "greater than or equal to zero";
      return ctx.croak(
        `${opt.name} for hash partition must be an integer value ${bound}`,
        opt.span.start,
        opt.span.end,
      );
    }
    if (value > INT4_MAX) {
      return ctx.croak(`${opt.name} for hash partition is out of range for type integer`, opt.span.start, opt.span.end);
    }
    seen[opt.name] = value + 0; // `-0` is 0
  }
  for (const key of ["modulus", "remainder"] as const) {
    if (seen[key] === undefined) ctx.croak(`${key} for hash partition must be specified`, start, ctx.lastEnd());
  }
  if (seen.modulus === 0) {
    ctx.croak("modulus for hash partition must be an integer value greater than zero", start, ctx.lastEnd());
  }
  if (seen.remainder! >= seen.modulus!) {
    ctx.croak("remainder for hash partition must be less than modulus", start, ctx.lastEnd());
  }
  return { kind: "hash", modulus: seen.modulus!, remainder: seen.remainder!, span: ctx.spanFrom(start) };
}

// `FOR VALUES {IN (…) | FROM (…) TO (…) | WITH (…)} | DEFAULT`. The WITH here
// is the bound's own, read before any storage clause could claim it.
function parsePartitionBound(ctx: ParseContext<SqlTokenType>): PartitionBound {
  const start = ctx.position();
  if (ctx.eat("ident", "default") !== null) return { kind: "default", span: ctx.spanFrom(start) };
  if (!ctx.is("ident", "for")) {
    return ctx.croak(`Expected ${quoteList(["for values", "default"])} but found ${describeFound(ctx.peek())}`);
  }
  ctx.parse(kwseq("for", "values"));
  if (ctx.eat("ident", "in") !== null) {
    if (!ctx.is("punc", "(")) ctx.croak(`Expected "(" but found ${describeFound(ctx.peek())}`);
    ctx.next(); // "("
    const values: Expr[] = [];
    do {
      values.push(ctx.parse(expression));
    } while (ctx.eat("punc", ",") !== null);
    expectClose(ctx);
    return { kind: "list", values, span: ctx.spanFrom(start) };
  }
  if (ctx.eat("ident", "from") !== null) {
    const from = rangeDatums(ctx);
    ctx.parse(kw("to"));
    return { kind: "range", from, to: rangeDatums(ctx), span: ctx.spanFrom(start) };
  }
  if (ctx.eat("ident", "with") !== null) return hashBound(ctx, start);
  return ctx.croak(`Expected ${quoteList(["in", "from", "with"])} but found ${describeFound(ctx.peek())}`);
}

// A `PARTITION OF` element: a table constraint, or a column the parent already
// types, given `[WITH OPTIONS]` and constraints only. Dispatched as tableItem
// is — the constraint's lead words first, any other name a column.
const columnOptions = custom<ColumnOptions, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    const name = ctx.parse(nameWord);
    // `with` is reserved and leads no column constraint, so it can only be this.
    const withOptions = ctx.is("ident", "with");
    if (withOptions) ctx.parse(kwseq("with", "options"));
    const constraints = ctx.parse(many(columnConstraint));
    return { kind: "columnOptions", name, ...(withOptions && { withOptions }), constraints, span: ctx.spanFrom(start) };
  },
  { expected: nameWord.expected(), first: nameWord.first() },
);

const partitionItem = oneOf(tableConstraint, columnOptions);

// `[INHERITS (parent, …)] [PARTITION BY …]` and then the storage clauses — what
// this grammar takes after a table's element list. PG also allows `USING
// method` between PARTITION BY and WITH; that is not parsed yet.
function parseTableClauses(ctx: ParseContext<SqlTokenType>): TableClauses {
  const clauses: TableClauses = {};
  if (ctx.eat("ident", "inherits") !== null) {
    if (!ctx.is("punc", "(")) ctx.croak(`Expected "(" but found ${describeFound(ctx.peek())}`);
    ctx.next(); // "("
    const parents: string[][] = [];
    do {
      parents.push(ctx.parse(qualName));
    } while (ctx.eat("punc", ",") !== null);
    expectClose(ctx);
    clauses.inherits = parents;
  }
  return { ...clauses, ...parsePartitionBy(ctx), ...parseStorageClauses(ctx) };
}

// A CTAS column-name list `(a, b) [storage clauses] AS` — bare names, ending in
// AS. attempt() so a real column-definition list (`(id int, …)`) rolls back to
// the table-item path.
const ctasColumns = attempt(
  custom<{ cols: string[]; storage: StorageClauses }, SqlTokenType>(
    (ctx) => {
      const cols = ctx.parse(columnList);
      const storage = parseStorageClauses(ctx);
      ctx.parse(kw("as"));
      return { cols, storage };
    },
    { expected: columnList.expected(), first: columnList.first() },
  ),
);

// CREATE TABLE — the ordinary `(items)` form or the query-backed `AS query`
// (CREATE TABLE AS). A handler rather than a rule so the CTAS branches (`name
// AS …` and `name (cols) AS …`) share the leading IF-NOT-EXISTS / name with the
// classic form, and so PLAIN_CREATE can hand it the span start and the prefix
// modifiers it collected between CREATE and here.
function createTableRest(ctx: ParseContext<SqlTokenType>, start: Position, modifiers: string[]): Stmt {
  ctx.parse(kw("table"));
  // attempt() so a typo'd `IF NOT EXIST` backtracks to try a table name rather
  // than hard-committing — the vector the farthest-failure test exploits.
  const ifNotExists = ctx.parse(optional(attempt(kwseq("if", "not", "exists")))) !== null;
  const name = ctx.parse(qualName);
  // `CREATE TABLE name [storage clauses] AS query [WITH [NO] DATA]`. A storage
  // clause straight after the name can only lead into AS: the classic form
  // writes its clauses after the element list.
  const storage = parseStorageClauses(ctx);
  if (Object.keys(storage).length > 0 || ctx.is("ident", "as")) {
    ctx.parse(kw("as"));
    const q = ctx.parse(query);
    return {
      kind: "createTableAs",
      ifNotExists,
      name,
      columns: null,
      query: q,
      withData: parseWithData(ctx),
      ...storage,
      ...(modifiers.length > 0 && { modifiers }),
      span: ctx.spanFrom(start),
    };
  }
  // `CREATE TABLE name PARTITION OF parent [(items)] bound [PARTITION BY …]
  // [storage clauses]`. The element list is optional, and INHERITS is not
  // allowed, as in PG.
  if (ctx.is("ident", "partition")) {
    ctx.parse(kwseq("partition", "of"));
    const parent = ctx.parse(qualName);
    // Unlike the classic form's, this list may not be empty: `()` croaks as the
    // missing first item.
    // The peek goes through peekOrReport, and only on a `(`: lexing is lazy, and
    // a bad first item must reach delimited()'s recovery rather than escape it.
    const close = ctx.is("punc", "(") ? peekOrReport(ctx, 1) : null;
    if (close?.type === "punc" && close.value === ")") {
      ctx.next(); // "("
      ctx.parse(partitionItem);
    }
    const items = ctx.is("punc", "(")
      ? ctx.parse(delimited(P("("), P(")"), P(","), partitionItem, { interleaved: true, recover: true }))
      : [];
    const partitionOf = { parent, bound: parsePartitionBound(ctx) };
    return {
      kind: "createTable",
      ifNotExists,
      name,
      items,
      partitionOf,
      ...parsePartitionBy(ctx),
      ...parseStorageClauses(ctx),
      ...(modifiers.length > 0 && { modifiers }),
      span: ctx.spanFrom(start),
    };
  }
  // `CREATE TABLE name (cols) [storage clauses] AS query` — the `(cols) … AS`
  // prefix backtracks (via ctasColumns) when the `(` really opens a
  // column-definition list.
  const ctas = ctx.parse(optional(ctasColumns));
  if (ctas !== null) {
    const q = ctx.parse(query);
    return {
      kind: "createTableAs",
      ifNotExists,
      name,
      columns: ctas.cols,
      query: q,
      withData: parseWithData(ctx),
      ...ctas.storage,
      ...(modifiers.length > 0 && { modifiers }),
      span: ctx.spanFrom(start),
    };
  }
  const items = ctx.parse(delimited(P("("), P(")"), P(","), tableItem, { interleaved: true, recover: true }));
  return {
    kind: "createTable",
    ifNotExists,
    name,
    items,
    ...parseTableClauses(ctx),
    ...(modifiers.length > 0 && { modifiers }),
    span: ctx.spanFrom(start),
  };
}

// `NULLS FIRST | NULLS LAST`. Only a `nulls` with one of the two after it starts
// the clause, so `nulls` alone stays an operator-class name, as in PG.
function isNullsOrder(ctx: ParseContext<SqlTokenType>): boolean {
  const after = ctx.peekAhead(1);
  return ctx.is("ident", "nulls") && after?.type === "ident" && (after.value === "first" || after.value === "last");
}

const nullsPosition = oneOf(kw("first"), kw("last")).map((n) => n.value as "first" | "last");

// One index column (see IndexColumn). A local rule rather than an edit to
// exprList, which other statements share. The operator class is any unreserved
// or quoted name after the expression: `asc` and `desc` are reserved, so they
// can never be read as one, and `nulls` is not one only when FIRST or LAST
// follows it (see isNullsOrder).
const indexColumn = custom<IndexColumn, SqlTokenType>(
  (ctx) => {
    const expr = ctx.parse(expression);
    const tok = ctx.peek();
    const hasOpclass =
      tok !== null &&
      (tok.type === "qident" || (tok.type === "ident" && !RESERVED.has(tok.value) && !isNullsOrder(ctx)));
    const opclass = hasOpclass ? ctx.parse(qualName) : null;
    const opclassOptions = opclass !== null && ctx.is("punc", "(") ? ctx.parse(relationOptions) : null;
    const dir = ctx.eat("ident", "asc") !== null ? "asc" : ctx.eat("ident", "desc") !== null ? "desc" : null;
    let nulls: "first" | "last" | null = null;
    if (ctx.eat("ident", "nulls") !== null) {
      nulls = ctx.parse(nullsPosition);
    }
    return {
      expr,
      ...(opclass !== null && { opclass }),
      ...(opclassOptions !== null && { opclassOptions }),
      ...(dir !== null && { dir }),
      ...(nulls !== null && { nulls }),
    };
  },
  { expected: expression.expected(), first: expression.first() },
);
const indexColumns = delimited(P("("), P(")"), P(","), indexColumn, { interleaved: true });

const createIndexRest = seq(
  field(
    "unique",
    optional(kw("unique")).map((x) => x !== null),
  ),
  skip(kw("index")),
  field(
    "concurrently",
    optional(kw("concurrently")).map((x) => x !== null),
  ),
  // `IF NOT EXISTS` precedes the (still optional) index name. attempt() so a
  // typo'd `IF NOT EXIST` backtracks to try a name/ON instead of hard-committing.
  field(
    "ifNotExists",
    optional(attempt(kwseq("if", "not", "exists"))).map((x) => x !== null),
  ),
  // The index name is optional; `attempt` lets it backtrack when `on` follows
  // instead (an `on` ident matches the type-only first set but is reserved).
  field("name", optional(attempt(nameWord))),
  skip(kw("on")),
  field("table", qualName),
  field("using", optional(seq(skip(kw("using")), field("m", nameWord)).map((s) => s.m))),
  field("columns", indexColumns),
  // `INCLUDE (col, …)` covering columns — plain names, kept null when absent.
  field("include", optional(seq(skip(kw("include")), field("cols", columnList)).map((s) => s.cols))),
  // `WITH (storage_parameter = value, …)`, omitted when absent. `with` is
  // reserved, so it cannot be the start of anything else here.
  field("options", optional(seq(skip(kw("with")), field("o", relationOptions)).map((s) => s.o))),
  field("where", optional(seq(skip(kw("where")), field("e", expression)).map((s) => s.e))),
).map(
  ({ unique, concurrently, ifNotExists, name, table, using, columns, include, options, where }, span): Stmt => ({
    kind: "createIndex",
    unique,
    concurrently,
    ifNotExists,
    name,
    table,
    using,
    columns,
    include,
    ...(options !== null && { options }),
    where,
    span,
  }),
);

// The three CREATE TYPE bodies share the `AS` lead then branch on the next word.
const enumValues = delimited(
  P("("),
  P(")"),
  P(","),
  token("string").map((n) => n.value),
  { interleaved: true },
);
// One `field type` attribute of a composite type.
const compositeAttr = seq(field("name", nameWord), field("type", typeRef)).map(
  ({ name, type }): CompositeAttr => ({ name, type }),
);
const compositeAttrs = delimited(P("("), P(")"), P(","), compositeAttr, { interleaved: true });

// `( name = value, … )` — the option list of a RANGE type. Entered on the `(`;
// each value is a (possibly qualified) name / type on the right of the `=`.
function parseRangeOptions(ctx: ParseContext<SqlTokenType>): RangeOption[] {
  if (!ctx.is("punc", "(")) ctx.croak(`Expected "(" but found ${describeFound(ctx.peek())}`);
  ctx.next(); // "("
  const options: RangeOption[] = [];
  do {
    const name = ctx.parse(nameWord);
    if (ctx.eat("op", "=") === null) ctx.croak(`Expected "=" but found ${describeFound(ctx.peek())}`);
    options.push({ name, value: ctx.parse(qualName).join(".") });
  } while (ctx.eat("punc", ",") !== null);
  expectClose(ctx);
  return options;
}

const createTypeRest = custom<Stmt, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    ctx.parse(kw("type"));
    const name = ctx.parse(qualName);
    ctx.parse(kw("as"));
    if (ctx.eat("ident", "enum") !== null) {
      return { kind: "createType", form: "enum", name, values: ctx.parse(enumValues), span: ctx.spanFrom(start) };
    }
    if (ctx.eat("ident", "range") !== null) {
      return { kind: "createType", form: "range", name, options: parseRangeOptions(ctx), span: ctx.spanFrom(start) };
    }
    // `AS ( field type, … )` — a composite type.
    return {
      kind: "createType",
      form: "composite",
      name,
      attributes: ctx.parse(compositeAttrs),
      span: ctx.spanFrom(start),
    };
  },
  { expected: '"type"', first: [{ type: "ident", value: "type" }] },
);

// CREATE SEQUENCE options: a repeatable, order-free list. Numeric operands are
// full expressions (so `MINVALUE -100` / `INCREMENT BY -1` parse); the flag and
// ownership forms carry their own shape. All option words stay unreserved.
function parseSequenceOptions(ctx: ParseContext<SqlTokenType>): SequenceOption[] {
  const options: SequenceOption[] = [];
  while (true) {
    if (ctx.eat("ident", "as") !== null) {
      options.push({ kind: "as", type: ctx.parse(typeRef) });
    } else if (ctx.eat("ident", "increment") !== null) {
      ctx.eat("ident", "by"); // optional BY
      options.push({ kind: "increment", value: ctx.parse(expression) });
    } else if (ctx.eat("ident", "minvalue") !== null) {
      options.push({ kind: "minValue", value: ctx.parse(expression) });
    } else if (ctx.eat("ident", "maxvalue") !== null) {
      options.push({ kind: "maxValue", value: ctx.parse(expression) });
    } else if (ctx.eat("ident", "start") !== null) {
      ctx.eat("ident", "with"); // optional WITH
      options.push({ kind: "start", value: ctx.parse(expression) });
    } else if (ctx.eat("ident", "restart") !== null) {
      // RESTART, RESTART n, or RESTART WITH n. A bare RESTART (no value) is
      // followed by another option word (an ident) or the end, so only a numeric
      // start (a number, or a signed `-`/`+`) counts as the restart value —
      // otherwise `RESTART CACHE 5` would read `CACHE` as an expression.
      const withKw = ctx.eat("ident", "with") !== null;
      const hasValue = withKw || ctx.is("number") || ctx.is("op", "-") || ctx.is("op", "+");
      options.push({ kind: "restart", value: hasValue ? ctx.parse(expression) : null });
    } else if (ctx.eat("ident", "cache") !== null) {
      options.push({ kind: "cache", value: ctx.parse(expression) });
    } else if (ctx.eat("ident", "cycle") !== null) {
      options.push({ kind: "cycle", value: true });
    } else if (ctx.is("ident", "no")) {
      const after = ctx.peekAhead(1)?.value;
      if (after === "minvalue") {
        ctx.parse(kwseq("no", "minvalue"));
        options.push({ kind: "minValue", value: null });
      } else if (after === "maxvalue") {
        ctx.parse(kwseq("no", "maxvalue"));
        options.push({ kind: "maxValue", value: null });
      } else if (after === "cycle") {
        ctx.parse(kwseq("no", "cycle"));
        options.push({ kind: "cycle", value: false });
      } else {
        break; // some other NO … — not a sequence option
      }
    } else if (ctx.is("ident", "owned")) {
      ctx.parse(kwseq("owned", "by"));
      options.push({ kind: "ownedBy", owner: ctx.eat("ident", "none") !== null ? null : ctx.parse(qualName) });
    } else {
      break;
    }
  }
  return options;
}

const createSequenceRest = custom<Stmt, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    ctx.parse(kw("sequence"));
    const ifNotExists = ctx.parse(optional(attempt(kwseq("if", "not", "exists")))) !== null;
    const name = ctx.parse(qualName);
    return { kind: "createSequence", ifNotExists, name, options: parseSequenceOptions(ctx), span: ctx.spanFrom(start) };
  },
  { expected: '"sequence"', first: [{ type: "ident", value: "sequence" }] },
);

// CREATE DOMAIN constraints: DEFAULT / COLLATE (never named) and the optionally
// `CONSTRAINT name`-prefixed NOT NULL / NULL / CHECK. All words stay unreserved.
function parseDomainConstraints(ctx: ParseContext<SqlTokenType>): DomainConstraint[] {
  const constraints: DomainConstraint[] = [];
  while (true) {
    let name: string | null = null;
    if (ctx.eat("ident", "constraint") !== null) name = ctx.parse(nameWord);
    if (ctx.is("ident", "not")) {
      ctx.parse(kwseq("not", "null"));
      constraints.push({ kind: "notNull", name });
    } else if (ctx.eat("ident", "null") !== null) {
      constraints.push({ kind: "null", name });
    } else if (ctx.eat("ident", "check") !== null) {
      constraints.push({ kind: "check", name, expr: ctx.parse(parenExpr) });
    } else if (name !== null) {
      // A `CONSTRAINT name` must be followed by NOT NULL / NULL / CHECK.
      return ctx.croak(`Expected "not", "null" or "check" but found ${describeFound(ctx.peek())}`);
    } else if (ctx.eat("ident", "default") !== null) {
      constraints.push({ kind: "default", expr: ctx.parse(expression) });
    } else if (ctx.eat("ident", "collate") !== null) {
      constraints.push({ kind: "collate", collation: ctx.parse(qualName) });
    } else {
      break;
    }
  }
  return constraints;
}

const createDomainRest = custom<Stmt, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    ctx.parse(kw("domain"));
    const name = ctx.parse(qualName);
    ctx.eat("ident", "as"); // optional AS
    const dataType = ctx.parse(typeRef);
    return {
      kind: "createDomain",
      name,
      dataType,
      constraints: parseDomainConstraints(ctx),
      span: ctx.spanFrom(start),
    };
  },
  { expected: '"domain"', first: [{ type: "ident", value: "domain" }] },
);

// The handlers below parse their own lead word and span from it, as the three
// above do. None takes `IF NOT EXISTS` by attempt(): DATABASE and TABLESPACE
// have none in PG, and SCHEMA / EXTENSION peek for `not` after `if`, which is
// reserved, so no name can be read there in its place — a schema or extension
// called `if` costs no backtrack.
function parseIfNotExists(ctx: ParseContext<SqlTokenType>): boolean {
  const next = ctx.peekAhead(1);
  const ifNotExists = ctx.is("ident", "if") && next?.type === "ident" && next.value === "not";
  if (ifNotExists) ctx.parse(kwseq("if", "not", "exists"));
  return ifNotExists;
}

// A role: a name, or one of the CURRENT_ / SESSION_ pseudo-roles, which are
// reserved and so matched by value ahead of `nameWord` (as parseGrantee does).
const ROLE_KEYWORDS: ReadonlySet<string> = new Set(["current_user", "current_role", "session_user"]);
function parseRoleSpec(ctx: ParseContext<SqlTokenType>): string {
  const tok = ctx.peek();
  if (tok !== null && tok.type === "ident" && ROLE_KEYWORDS.has(tok.value)) {
    ctx.next();
    return tok.value;
  }
  return ctx.parse(nameWord);
}

// One CREATE DATABASE option: the entry `relationOption` parses inside a
// parenthesised `WITH (…)` list, or PG's two-word `CONNECTION LIMIT [=] n`,
// which it cannot (see optionName). Reusing the entry takes its shape whole, so
// the namespace form and the `*` and list values pass here too, as PG's grammar
// would not have them; one shape for every list is the trade relationOption
// already makes. So is a lone `CONNECTION = n`, read as an ordinary option
// named `connection`. The list has no delimiter, so it runs while a name leads:
// an unreserved word or a quoted one, as PG's own option names are IDENT bar a
// few.
function isDatabaseOptionStart(ctx: ParseContext<SqlTokenType>): boolean {
  const tok = ctx.peek();
  return tok !== null && (tok.type === "qident" || (tok.type === "ident" && !RESERVED.has(tok.value)));
}

function parseDatabaseOption(ctx: ParseContext<SqlTokenType>): RelationOption {
  const next = ctx.peekAhead(1);
  if (!(ctx.is("ident", "connection") && next?.type === "ident" && next.value === "limit")) {
    return ctx.parse(relationOption);
  }
  const start = ctx.position();
  ctx.parse(kwseq("connection", "limit"));
  ctx.eat("op", "=");
  return { name: "connection limit", value: optionScalar(ctx), span: ctx.spanFrom(start) };
}

function createDatabaseRest(ctx: ParseContext<SqlTokenType>): Stmt {
  const start = ctx.position();
  ctx.parse(kw("database"));
  const name = ctx.parse(nameWord);
  // `with` is reserved, so it can only open the list; PG lets the list after it
  // be empty too.
  ctx.eat("ident", "with");
  const options: RelationOption[] = [];
  while (isDatabaseOptionStart(ctx)) options.push(parseDatabaseOption(ctx));
  return { kind: "createDatabase", name, options, span: ctx.spanFrom(start) };
}

// One schema element: a GRANT of privileges ON an object, or a CREATE of one of
// the kinds PG's schema_stmt list has — TABLE / [UNIQUE] INDEX / SEQUENCE / VIEW
// / TRIGGER, only the last two after OR REPLACE. CREATE and OR REPLACE are
// consumed here so that a wrong target croaks at the target word itself, and
// the entry is then entered straight from createStmt's two maps, with the same
// two starts createStmt gives it. A nested CREATE SCHEMA can therefore never
// swallow the elements after it. CREATE TABLE AS and a role GRANT share their
// lead words with an admitted form, so only the finished node tells them apart.
const SCHEMA_ELEMENT_TARGETS = ["table", "unique", "index", "sequence", "view", "trigger"];
const SCHEMA_REPLACEABLE_TARGETS = ["view", "trigger"];
function parseSchemaElement(ctx: ParseContext<SqlTokenType>): Stmt {
  if (ctx.is("ident", "grant")) {
    const grant = ctx.parse(grantStmt);
    if (grant.kind === "grant" && grant.on === null) {
      const message = "A schema element GRANT must grant privileges ON an object, not a role";
      return ctx.croak(message, grant.span.start, grant.span.end);
    }
    return grant;
  }
  const start = ctx.position();
  ctx.parse(kw("create"));
  const tailStart = ctx.position();
  const orReplace = ctx.is("ident", "or");
  if (orReplace) ctx.parse(kwseq("or", "replace"));
  const allowed = orReplace ? SCHEMA_REPLACEABLE_TARGETS : SCHEMA_ELEMENT_TARGETS;
  const tok = ctx.peek();
  if (tok === null || tok.type !== "ident" || !allowed.includes(tok.value)) {
    return ctx.croak(`Expected ${quoteList(allowed)} but found ${describeFound(tok)}`);
  }
  if (SCHEMA_REPLACEABLE_TARGETS.includes(tok.value)) {
    ctx.next(); // the target's lead word, as createStmt consumes it
    return REPLACEABLE_CREATE[tok.value]!.parse(ctx, start, orReplace);
  }
  const element = PLAIN_CREATE[tok.value]!.parse(ctx, tailStart, []);
  if (element.kind === "createTableAs") {
    return ctx.croak("A schema element CREATE TABLE cannot be CREATE TABLE AS", element.span.start, element.span.end);
  }
  return element;
}

function createSchemaRest(ctx: ParseContext<SqlTokenType>): Stmt {
  const start = ctx.position();
  ctx.parse(kw("schema"));
  const ifNotExists = parseIfNotExists(ctx);
  // `authorization` is reserved in PG and leads the role-only form there; this
  // parser keeps it a name everywhere else and reads it as the clause only here.
  const name = ctx.is("ident", "authorization") ? null : ctx.parse(nameWord);
  let authorization: string | null = null;
  if (name === null || ctx.is("ident", "authorization")) {
    ctx.parse(kw("authorization"));
    authorization = parseRoleSpec(ctx);
  }
  // Schema elements follow with no `;` between them. PG's grammar takes none
  // after IF NOT EXISTS.
  const elements: Stmt[] = [];
  while (ctx.is("ident", "create") || ctx.is("ident", "grant")) {
    if (ifNotExists) return ctx.croak("CREATE SCHEMA IF NOT EXISTS cannot include schema elements");
    elements.push(parseSchemaElement(ctx));
  }
  return { kind: "createSchema", ifNotExists, name, authorization, elements, span: ctx.spanFrom(start) };
}

// `SCHEMA s`, `VERSION v` and `CASCADE`, in any order, after an optional WITH.
// A version is a string or a word (PG's NonReservedWord_or_Sconst).
function parseExtensionOptions(ctx: ParseContext<SqlTokenType>): ExtensionOption[] {
  ctx.eat("ident", "with");
  const options: ExtensionOption[] = [];
  while (true) {
    if (ctx.eat("ident", "schema") !== null) {
      options.push({ kind: "schema", schema: ctx.parse(nameWord) });
    } else if (ctx.eat("ident", "version") !== null) {
      const tok = ctx.peek();
      const version = tok?.type === "string" ? ctx.next()!.value : ctx.parse(nameWord);
      options.push({ kind: "version", version });
    } else if (ctx.eat("ident", "cascade") !== null) {
      options.push({ kind: "cascade" });
    } else {
      return options;
    }
  }
}

function createExtensionRest(ctx: ParseContext<SqlTokenType>): Stmt {
  const start = ctx.position();
  ctx.parse(kw("extension"));
  const ifNotExists = parseIfNotExists(ctx);
  const name = ctx.parse(nameWord);
  return { kind: "createExtension", ifNotExists, name, options: parseExtensionOptions(ctx), span: ctx.spanFrom(start) };
}

function createTablespaceRest(ctx: ParseContext<SqlTokenType>): Stmt {
  const start = ctx.position();
  ctx.parse(kw("tablespace"));
  const name = ctx.parse(nameWord);
  const owner = ctx.eat("ident", "owner") !== null ? parseRoleSpec(ctx) : null;
  ctx.parse(kw("location"));
  const tok = ctx.peek();
  if (tok?.type !== "string") return ctx.croak(`Expected a string but found ${describeFound(tok)}`);
  ctx.next();
  // `with` is reserved, so it can only open the option list here.
  const options = ctx.eat("ident", "with") !== null ? ctx.parse(relationOptions) : [];
  return { kind: "createTablespace", name, owner, location: tok.value, options, span: ctx.spanFrom(start) };
}

// The single-word role attributes. Each is negated by its `NO`-prefixed
// spelling (`NOLOGIN`), which PG lexes as one word too.
const ROLE_FLAGS: ReadonlySet<string> = new Set([
  "superuser",
  "createdb",
  "createrole",
  "inherit",
  "login",
  "replication",
  "bypassrls",
]);

// PG's SignedIconst: an integer constant with an optional sign.
function parseSignedInt(ctx: ParseContext<SqlTokenType>): number {
  const tok = ctx.peek();
  const sign = tok?.type === "op" && (tok.value === "-" || tok.value === "+") ? tok.value : null;
  if (!isIntegerConstant(sign === null ? tok : ctx.peekAhead(1))) {
    return ctx.croak(`Expected an integer but found ${describeFound(sign === null ? tok : ctx.peekAhead(1))}`);
  }
  if (sign !== null) ctx.next();
  const value = Number(ctx.next()!.value);
  return sign === "-" ? -value : value;
}

// One CREATE ROLE option, or null when the next token leads none. Every option
// word is matched by value and stays unreserved (bar `in`, `group`, `limit`,
// `null` and `user`, reserved already); the list has no delimiter, so it simply
// runs until a word leads no option. PG's legacy spellings `IN GROUP` and
// `USER` read as `IN ROLE` and `ROLE`; its SYSID is not taken.
function parseRoleOption(ctx: ParseContext<SqlTokenType>): RoleOption | null {
  const tok = ctx.peek();
  if (tok === null || tok.type !== "ident") return null;
  const flag = tok.value.startsWith("no") ? tok.value.slice(2) : tok.value;
  if (ROLE_FLAGS.has(flag)) {
    ctx.next();
    return { kind: "flag", name: flag as Extract<RoleOption, { kind: "flag" }>["name"], value: flag === tok.value };
  }
  switch (tok.value) {
    case "connection":
      ctx.parse(kwseq("connection", "limit"));
      return { kind: "connectionLimit", limit: parseSignedInt(ctx) };
    case "encrypted":
      // PG takes no `ENCRYPTED PASSWORD NULL`: only a bare PASSWORD may be null.
      ctx.parse(kwseq("encrypted", "password"));
      return { kind: "password", encrypted: true, password: ctx.parse(strValue) };
    case "password":
      ctx.next();
      return { kind: "password", encrypted: false, password: ctx.eat("ident", "null") ? null : ctx.parse(strValue) };
    case "valid":
      ctx.parse(kwseq("valid", "until"));
      return { kind: "validUntil", timestamp: ctx.parse(strValue) };
    case "in":
      ctx.next();
      if (ctx.eat("ident", "role") === null && ctx.eat("ident", "group") === null) {
        return ctx.croak(`Expected ${quoteList(["role", "group"])} but found ${describeFound(ctx.peek())}`);
      }
      return { kind: "inRole", roles: commaList(ctx, parseRoleSpec) };
    case "role":
    case "user":
      ctx.next();
      return { kind: "role", roles: commaList(ctx, parseRoleSpec) };
    case "admin":
      ctx.next();
      return { kind: "admin", roles: commaList(ctx, parseRoleSpec) };
    default:
      return null;
  }
}

// `CREATE {ROLE|USER} name [[WITH] option …]` — the lead word is consumed here,
// as every PLAIN_CREATE handler's is.
function createRoleRest(ctx: ParseContext<SqlTokenType>, user: boolean): Stmt {
  const start = ctx.position();
  ctx.parse(kw(user ? "user" : "role"));
  const name = ctx.parse(nameWord);
  // `with` is reserved, so it can only open the list.
  ctx.eat("ident", "with");
  const options: RoleOption[] = [];
  for (let option = parseRoleOption(ctx); option !== null; option = parseRoleOption(ctx)) options.push(option);
  return { kind: "createRole", user, name, options, span: ctx.spanFrom(start) };
}

// The body of a (MATERIALIZED) VIEW after the VIEW keyword: `[IF NOT EXISTS] name
// [(cols)] AS query [WITH [NO] DATA]`. The query reuses the shared `query` rule.
function parseViewBody(
  ctx: ParseContext<SqlTokenType>,
  start: Position,
  materialized: boolean,
  orReplace: boolean,
): Stmt {
  const ifNotExists = materialized && ctx.parse(optional(attempt(kwseq("if", "not", "exists")))) !== null;
  const name = ctx.parse(qualName);
  const columns = ctx.is("punc", "(") ? ctx.parse(columnList) : null;
  ctx.parse(kw("as"));
  const q = ctx.parse(query);
  const withData = materialized ? parseWithData(ctx) : null;
  return {
    kind: "createView",
    materialized,
    orReplace,
    ifNotExists,
    name,
    columns,
    query: q,
    withData,
    span: ctx.spanFrom(start),
  };
}

// --- Phase 8: CREATE FUNCTION / AGGREGATE / TRIGGER ---

// A bare `string` token's inner text — the AS body (`'…'` or a dollar-quoted
// `$$…$$`, both lexed as one `string`), a LANGUAGE literal, etc. (`stringLit`
// above yields an Expr node; here we want the raw text.)
const strValue = token("string").map((n) => n.value);

// The argument-mode words that may lead a function/aggregate argument.
const ARG_MODES: ReadonlySet<string> = new Set(["in", "out", "inout", "variadic"]);

// One `[mode] [name] type [DEFAULT expr]` argument. See `FunctionArg` for the
// mode/name recovery heuristic.
// `allowDefault` is false for DROP, whose signatures name types only: PG
// refuses a default there, so one is croaked at its own DEFAULT / `=`.
function parseFunctionArg(ctx: ParseContext<SqlTokenType>, allowDefault = true): FunctionArg {
  let mode: FunctionArg["mode"] = null;
  const cur = ctx.peek();
  if (cur !== null && cur.type === "ident" && ARG_MODES.has(cur.value)) {
    const after = ctx.peekAhead(1);
    // A mode word is a mode only when a further name/type word follows; alone
    // (`(out)`) it is itself the argument's unnamed type.
    if (after !== null && (after.type === "ident" || after.type === "qident")) {
      mode = cur.value as FunctionArg["mode"];
      ctx.next();
    }
  }
  // An argument name precedes the type only when two name-ish tokens run together
  // (the second one starting the type). `numeric(10,2)` / a dotted type / a bare
  // `integer` therefore has no leading name — and neither does a multi-word type
  // name, whose two words would otherwise read as `name type`: `f(double
  // precision)` is one unnamed argument, not a `double` of type `precision`.
  // Keyed on the word pair rather than a `tryParse(typeRef)`, which cannot
  // decide it: typeRef succeeds on any bare identifier, so `f(a integer)` would
  // take `a` for the type and then croak on `integer`.
  let name: string | null = null;
  const c2 = ctx.peek();
  const n2 = ctx.peekAhead(1);
  if (
    c2 !== null &&
    (c2.type === "ident" || c2.type === "qident") &&
    n2 !== null &&
    (n2.type === "ident" || n2.type === "qident") &&
    !startsMultiWordType(ctx, c2)
  ) {
    name = ctx.parse(nameWord);
  }
  const type = ctx.parse(typeRef);
  let defaultValue: Expr | null = null;
  if (!allowDefault && (ctx.is("ident", "default") || ctx.is("op", "="))) {
    ctx.croak(`A DROP signature takes no argument defaults, but found ${describeFound(ctx.peek())}`);
  }
  if (ctx.eat("ident", "default") !== null || ctx.eat("op", "=") !== null) {
    defaultValue = ctx.parse(expression);
  }
  return { mode, name, type, defaultValue };
}

// The parenthesised argument signature — possibly empty `()`. CREATE takes
// argument defaults; DROP's `dropFunctionArgs` does not.
const signatureArgs = (allowDefault: boolean) =>
  delimited(
    P("("),
    P(")"),
    P(","),
    custom<FunctionArg, SqlTokenType>((ctx) => parseFunctionArg(ctx, allowDefault), {
      expected: "a function argument",
      first: [{ type: "ident" }, { type: "qident" }],
    }),
    { interleaved: true },
  );
const functionArgs = signatureArgs(true);
const dropFunctionArgs = signatureArgs(false);

// `RETURNS [SETOF] type` | `RETURNS TABLE (col type, …)`, or null when absent.
function parseFunctionReturns(ctx: ParseContext<SqlTokenType>): FunctionReturns | null {
  if (ctx.eat("ident", "returns") === null) return null;
  if (ctx.eat("ident", "table") !== null) {
    return { kind: "table", columns: ctx.parse(compositeAttrs) };
  }
  const setof = ctx.eat("ident", "setof") !== null;
  return { kind: "type", setof, type: ctx.parse(typeRef) };
}

// `[EXTERNAL] SECURITY {DEFINER|INVOKER}` — returns whether it is a definer.
function parseSecurityKind(ctx: ParseContext<SqlTokenType>): boolean {
  if (ctx.eat("ident", "definer") !== null) return true;
  if (ctx.eat("ident", "invoker") !== null) return false;
  return ctx.croak(`Expected "definer" or "invoker" but found ${describeFound(ctx.peek())}`);
}

// The order-free characteristic loop of CREATE FUNCTION. Stops at the first token
// that is not an option lead-word (the trailing `;`), or, given `only`, at the
// first that `only` does not name. All option words stay unreserved and are
// matched by value.
function parseFunctionOptions(ctx: ParseContext<SqlTokenType>, only?: ReadonlySet<string>): FunctionOption[] {
  const options: FunctionOption[] = [];
  while (true) {
    const tok = ctx.peek();
    if (tok === null || tok.type !== "ident") break;
    if (only !== undefined && !only.has(tok.value)) break;
    switch (tok.value) {
      case "language": {
        ctx.next();
        options.push({ kind: "language", name: ctx.is("string") ? ctx.parse(strValue) : ctx.parse(nameWord) });
        break;
      }
      case "as": {
        ctx.next();
        const parts = [ctx.parse(strValue)];
        if (ctx.eat("punc", ",") !== null) parts.push(ctx.parse(strValue));
        options.push({ kind: "as", parts });
        break;
      }
      case "immutable":
      case "stable":
      case "volatile":
        ctx.next();
        options.push({ kind: "volatility", value: tok.value });
        break;
      case "leakproof":
        ctx.next();
        options.push({ kind: "leakproof", value: true });
        break;
      case "not":
        // `NOT LEAKPROOF` — any other NOT is not a function option; stop.
        if (ctx.peekAhead(1)?.value !== "leakproof") return options;
        ctx.parse(kwseq("not", "leakproof"));
        options.push({ kind: "leakproof", value: false });
        break;
      case "strict":
        ctx.next();
        options.push({ kind: "strictness", value: "strict" });
        break;
      case "called":
        ctx.parse(kwseq("called", "on", "null", "input"));
        options.push({ kind: "strictness", value: "calledOnNullInput" });
        break;
      case "returns":
        // In the option loop `RETURNS` can only be `RETURNS NULL ON NULL INPUT`
        // (the return type was consumed before the loop).
        ctx.parse(kwseq("returns", "null", "on", "null", "input"));
        options.push({ kind: "strictness", value: "returnsNullOnNullInput" });
        break;
      case "external":
        ctx.parse(kwseq("external", "security"));
        options.push({ kind: "security", external: true, definer: parseSecurityKind(ctx) });
        break;
      case "security":
        ctx.next();
        options.push({ kind: "security", external: false, definer: parseSecurityKind(ctx) });
        break;
      case "parallel": {
        ctx.next();
        const value = ctx.eat("ident", "unsafe")
          ? "unsafe"
          : ctx.eat("ident", "restricted")
            ? "restricted"
            : ctx.eat("ident", "safe")
              ? "safe"
              : ctx.croak(`Expected "unsafe", "restricted" or "safe" but found ${describeFound(ctx.peek())}`);
        options.push({ kind: "parallel", value });
        break;
      }
      case "cost":
        ctx.next();
        options.push({ kind: "cost", value: ctx.parse(expression) });
        break;
      case "rows":
        ctx.next();
        options.push({ kind: "rows", value: ctx.parse(expression) });
        break;
      case "window":
        ctx.next();
        options.push({ kind: "window" });
        break;
      case "set": {
        ctx.next();
        const parameter = ctx.parse(qualName).join(".");
        if (ctx.eat("ident", "from") !== null) {
          ctx.parse(kw("current"));
          options.push({ kind: "set", parameter, value: { kind: "fromCurrent" } });
        } else {
          if (ctx.eat("ident", "to") === null && ctx.eat("op", "=") === null) {
            ctx.croak(`Expected "to" or "=" but found ${describeFound(ctx.peek())}`);
          }
          const values = ctx.parse(sepBy(expression, P(",")));
          options.push({ kind: "set", parameter, value: { kind: "list", values } });
        }
        break;
      }
      default:
        return options;
    }
  }
  return options;
}

// `CREATE [OR REPLACE] FUNCTION` — the `FUNCTION` keyword is consumed by the
// caller (like `parseViewBody`).
function parseFunctionBody(ctx: ParseContext<SqlTokenType>, start: Position, orReplace: boolean): Stmt {
  const name = ctx.parse(qualName);
  const args = ctx.parse(functionArgs);
  const returns = parseFunctionReturns(ctx);
  const options = parseFunctionOptions(ctx);
  return { kind: "createFunction", orReplace, name, args, returns, options, span: ctx.spanFrom(start) };
}

// The option words of parseFunctionOptions that PG also admits on a procedure
// (its TRANSFORM and RESET are not parsed for a function either). The rest
// (volatility, strictness, COST, ROWS, …) describe a value-returning call, so
// the loop stops before them and the statement then croaks on the word.
const PROCEDURE_OPTIONS: ReadonlySet<string> = new Set(["language", "as", "external", "security", "set"]);

// `CREATE [OR REPLACE] PROCEDURE` — `PROCEDURE` consumed by the caller. As
// FUNCTION's body, with no RETURNS.
function parseProcedureBody(ctx: ParseContext<SqlTokenType>, start: Position, orReplace: boolean): Stmt {
  const name = ctx.parse(qualName);
  const args = ctx.parse(functionArgs);
  const options = parseFunctionOptions(ctx, PROCEDURE_OPTIONS);
  return { kind: "createProcedure", orReplace, name, args, options, span: ctx.spanFrom(start) };
}

// `( NAME [= value] , … )` — the aggregate definition list. `value` is a type/
// function-name (typeRef) or a literal (string/number), or null for a bare flag.
function parseAggregateOptions(ctx: ParseContext<SqlTokenType>): AggregateOption[] {
  if (!ctx.is("punc", "(")) ctx.croak(`Expected "(" but found ${describeFound(ctx.peek())}`);
  ctx.next(); // "("
  const options: AggregateOption[] = [];
  do {
    const name = ctx.parse(nameWord);
    let value: AggregateOptionValue | null = null;
    if (ctx.eat("op", "=") !== null) {
      value =
        ctx.is("string") || ctx.is("number")
          ? { kind: "literal", expr: ctx.parse(expression) }
          : { kind: "type", type: ctx.parse(typeRef) };
    }
    options.push({ name, value });
  } while (ctx.eat("punc", ",") !== null);
  expectClose(ctx);
  return options;
}

// `CREATE [OR REPLACE] AGGREGATE` — `AGGREGATE` consumed by the caller. The first
// paren is the argument signature (`(*)`, or a type list) UNLESS it opens the
// legacy single-paren definition list, detected by an `ident =` right after `(`.
function parseAggregateBody(ctx: ParseContext<SqlTokenType>, start: Position, orReplace: boolean): Stmt {
  const name = ctx.parse(qualName);
  if (!ctx.is("punc", "(")) ctx.croak(`Expected "(" but found ${describeFound(ctx.peek())}`);
  const legacy =
    ctx.peekAhead(1)?.type === "ident" && ctx.peekAhead(2)?.type === "op" && ctx.peekAhead(2)?.value === "=";
  if (legacy) {
    return {
      kind: "createAggregate",
      orReplace,
      name,
      star: false,
      args: [],
      options: parseAggregateOptions(ctx),
      span: ctx.spanFrom(start),
    };
  }
  const { star, args } = parseAggregateSignature(ctx);
  return {
    kind: "createAggregate",
    orReplace,
    name,
    star,
    args,
    options: parseAggregateOptions(ctx),
    span: ctx.spanFrom(start),
  };
}

// An aggregate's `( * )` or `( type, … )` signature, its `(` not yet consumed.
// DROP passes its default-free `dropFunctionArgs` as `args`.
function parseAggregateSignature(ctx: ParseContext<SqlTokenType>, args = functionArgs): DropSignature {
  if (ctx.is("punc", "(") && ctx.peekAhead(1)?.type === "op" && ctx.peekAhead(1)?.value === "*") {
    ctx.next(); // "("
    ctx.next(); // "*"
    expectClose(ctx);
    return { star: true, args: [] };
  }
  return { star: false, args: ctx.parse(args) };
}

// One trigger event: INSERT / DELETE / TRUNCATE, or UPDATE with an optional
// `OF col, …` list. Event words stay unreserved and are matched by value.
function parseTriggerEvent(ctx: ParseContext<SqlTokenType>): TriggerEvent {
  if (ctx.eat("ident", "insert") !== null) return { event: "insert", columns: null };
  if (ctx.eat("ident", "delete") !== null) return { event: "delete", columns: null };
  if (ctx.eat("ident", "truncate") !== null) return { event: "truncate", columns: null };
  if (ctx.eat("ident", "update") !== null) {
    const columns = ctx.eat("ident", "of") !== null ? ctx.parse(sepBy(nameWord, P(","))) : null;
    return { event: "update", columns };
  }
  return ctx.croak(`Expected "insert", "update", "delete" or "truncate" but found ${describeFound(ctx.peek())}`);
}

// `CREATE [OR REPLACE] TRIGGER` — `TRIGGER` consumed by the caller.
function parseTriggerBody(ctx: ParseContext<SqlTokenType>, start: Position, orReplace: boolean): Stmt {
  const name = ctx.parse(nameWord);
  let timing: CreateTrigger["timing"];
  if (ctx.eat("ident", "before") !== null) timing = "before";
  else if (ctx.eat("ident", "after") !== null) timing = "after";
  else if (ctx.is("ident", "instead")) {
    ctx.parse(kwseq("instead", "of"));
    timing = "insteadOf";
  } else {
    return ctx.croak(`Expected "before", "after" or "instead" but found ${describeFound(ctx.peek())}`);
  }
  const events = [parseTriggerEvent(ctx)];
  while (ctx.eat("ident", "or") !== null) events.push(parseTriggerEvent(ctx));
  ctx.parse(kw("on"));
  const table = ctx.parse(qualName);
  let forEach: CreateTrigger["forEach"] = null;
  if (ctx.eat("ident", "for") !== null) {
    ctx.eat("ident", "each"); // optional EACH
    if (ctx.eat("ident", "row") !== null) forEach = "row";
    else if (ctx.eat("ident", "statement") !== null) forEach = "statement";
    else return ctx.croak(`Expected "row" or "statement" but found ${describeFound(ctx.peek())}`);
  }
  const when = ctx.eat("ident", "when") !== null ? ctx.parse(parenExpr) : null;
  ctx.parse(kw("execute"));
  let routine: "function" | "procedure";
  if (ctx.eat("ident", "function") !== null) routine = "function";
  else if (ctx.eat("ident", "procedure") !== null) routine = "procedure";
  else return ctx.croak(`Expected "function" or "procedure" but found ${describeFound(ctx.peek())}`);
  const execName = ctx.parse(qualName);
  const execArgs = ctx.parse(exprList);
  return {
    kind: "createTrigger",
    orReplace,
    name,
    timing,
    events,
    table,
    forEach,
    when,
    execute: { routine, name: execName, args: execArgs },
    span: ctx.spanFrom(start),
  };
}

// The words PG's `OptTemp` puts between CREATE and TABLE, and its
// `OptTempTableName` between SELECT's INTO and the target. Both allow at most one
// of `temp`/`temporary`/`unlogged`, with the scope words `global`/`local` legal
// only ahead of a `temp`/`temporary`, never on their own and never repeated.
const TEMP_SCOPE_WORDS: ReadonlySet<string> = new Set(["global", "local"]);
const TEMP_WORDS: ReadonlySet<string> = new Set(["temp", "temporary"]);
const TABLE_STORAGE_WORDS: ReadonlySet<string> = new Set(["temp", "temporary", "unlogged"]);

// `[{GLOBAL | LOCAL} {TEMP | TEMPORARY} | TEMP | TEMPORARY | UNLOGGED]` after
// CREATE, returned in source order. No CREATE target leads with one of these
// words, so they are claimed without looking past them; a scope word must be
// followed by a temp word, and a second storage word is left for the caller's
// `"table"` check to reject.
function parseTempPrefix(ctx: ParseContext<SqlTokenType>): string[] {
  const head = ctx.peek();
  if (head?.type !== "ident") return [];
  if (TEMP_SCOPE_WORDS.has(head.value)) {
    ctx.next();
    const temp = ctx.peek();
    if (temp?.type !== "ident" || !TEMP_WORDS.has(temp.value)) {
      return ctx.croak(`Expected ${quoteList([...TEMP_WORDS])} but found ${describeFound(temp)}`);
    }
    ctx.next();
    return [head.value, temp.value];
  }
  if (TABLE_STORAGE_WORDS.has(head.value)) {
    ctx.next();
    return [head.value];
  }
  return [];
}

// The CREATE targets split in two, because only some of them accept `OR
// REPLACE` and the two halves consume their lead word at different moments.
//
// PLAIN_CREATE dispatch PEEKS: each handler parses its own lead keyword, so its
// node's span still opens on `TABLE` / `INDEX` / …. Every handler is offered the
// position just after CREATE and the prefix-modifier bag, but only `table` reads
// them — the others build their own span from their own keyword and drop the
// bag, which is safe only because createStmt refuses modifiers ahead of any
// target but TABLE. Widen that check along with any handler that learns them.
const PLAIN_CREATE: DispatchMap<Stmt, [Position, string[]]> = {
  table: { parse: createTableRest },
  // `[UNIQUE] INDEX` can lead with either word, so it takes two keys. They share
  // one label, which joinExpected's dedupe then folds back into a single part.
  unique: { parse: (ctx) => ctx.parse(createIndexRest) },
  index: { expected: '"unique"', parse: (ctx) => ctx.parse(createIndexRest) },
  type: { parse: (ctx) => ctx.parse(createTypeRest) },
  sequence: { parse: (ctx) => ctx.parse(createSequenceRest) },
  domain: { parse: (ctx) => ctx.parse(createDomainRest) },
  database: { parse: createDatabaseRest },
  schema: { parse: createSchemaRest },
  extension: { parse: createExtensionRest },
  tablespace: { parse: createTablespaceRest },
  role: { parse: (ctx) => createRoleRest(ctx, false) },
  user: { parse: (ctx) => createRoleRest(ctx, true) },
};

// REPLACEABLE_CREATE dispatch CONSUMES the lead word: these bodies are entered
// past it, and they span from before CREATE rather than after it. Key order is
// the order the OR-REPLACE croak lists them in.
const REPLACEABLE_CREATE: DispatchMap<Stmt, [Position, boolean]> = {
  view: { parse: (ctx, start, orReplace) => parseViewBody(ctx, start, false, orReplace) },
  materialized: {
    parse: (ctx, start, orReplace) => {
      ctx.parse(kw("view"));
      return parseViewBody(ctx, start, true, orReplace);
    },
  },
  function: { parse: (ctx, start, orReplace) => parseFunctionBody(ctx, start, orReplace) },
  procedure: { parse: (ctx, start, orReplace) => parseProcedureBody(ctx, start, orReplace) },
  aggregate: { parse: (ctx, start, orReplace) => parseAggregateBody(ctx, start, orReplace) },
  trigger: { parse: (ctx, start, orReplace) => parseTriggerBody(ctx, start, orReplace) },
};

// PLAIN_CREATE is reached through an `oneOf`-shaped message, REPLACEABLE_CREATE
// through a hand-written croak — hence the two derivations (see joinExpected).
const PLAIN_CREATE_EXPECTED = joinExpected(PLAIN_CREATE);
const REPLACEABLE_CREATE_EXPECTED = keyList(REPLACEABLE_CREATE);

// PLAIN_CREATE is only consulted once the lead word has missed
// REPLACEABLE_CREATE, so a word in both would leave the plain target
// unreachable with nothing to show for it. The `oneOf` these records replaced
// rejected overlapping first sets at module-eval (combinators.ts `validate`);
// records have no such check of their own, so this is it.
for (const key of Object.keys(PLAIN_CREATE)) {
  if (Object.hasOwn(REPLACEABLE_CREATE, key)) {
    throw new Error(`CREATE target "${key}" is in both dispatch maps - the PLAIN_CREATE entry is unreachable`);
  }
}

// Every admitted target must lead an entry in the map parseSchemaElement looks
// it up in, or its `!` would find nothing, and an OR REPLACE target must be
// admitted without it too; checked at load, as the overlap above is.
for (const target of SCHEMA_ELEMENT_TARGETS) {
  const map: Record<string, unknown> = SCHEMA_REPLACEABLE_TARGETS.includes(target) ? REPLACEABLE_CREATE : PLAIN_CREATE;
  if (!Object.hasOwn(map, target)) throw new Error(`Schema element target "${target}" leads no CREATE entry`);
}
for (const target of SCHEMA_REPLACEABLE_TARGETS) {
  if (!SCHEMA_ELEMENT_TARGETS.includes(target)) throw new Error(`Schema element target "${target}" is not admitted`);
}

// After CREATE: an optional `OR REPLACE`, then one of the objects that permit it
// (VIEW / MATERIALIZED VIEW / FUNCTION / PROCEDURE / AGGREGATE / TRIGGER) — or,
// with no such prefix, one of the remaining keyword-led targets (TABLE /
// [UNIQUE] INDEX / TYPE / SEQUENCE / DOMAIN / DATABASE / SCHEMA / EXTENSION /
// TABLESPACE / ROLE / USER), TABLE alone taking the TEMP / UNLOGGED prefix. `OR
// REPLACE` before a non-replaceable object croaks, as does a prefix before
// anything but TABLE — PG's TEMP VIEW and TEMP SEQUENCE are not parsed.
const createStmt = custom<Stmt, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    ctx.parse(kw("create"));
    // Two starts, and the difference is visible in every span: the replaceable
    // bodies open theirs before CREATE, the keyword-led targets after it.
    const tailStart = ctx.position();
    const orReplace = ctx.is("ident", "or");
    if (orReplace) ctx.parse(kwseq("or", "replace"));
    const replaceable = lookup(REPLACEABLE_CREATE, ctx.peek());
    if (replaceable !== undefined) {
      ctx.next(); // the target's lead word
      return replaceable.parse(ctx, start, orReplace);
    }
    if (orReplace) {
      return ctx.croak(`Expected ${REPLACEABLE_CREATE_EXPECTED} but found ${describeFound(ctx.peek())}`);
    }
    // Nothing was consumed since `tailStart` — OR REPLACE never reaches here —
    // so a target with no modifiers spans exactly as it did before, and one with
    // them spans from its first modifier.
    const modifiers = parseTempPrefix(ctx);
    if (modifiers.length > 0 && !ctx.is("ident", "table")) {
      return ctx.croak(`Expected "table" but found ${describeFound(ctx.peek())}`);
    }
    return dispatch(PLAIN_CREATE, PLAIN_CREATE_EXPECTED, ctx, tailStart, modifiers);
  },
  { expected: '"create"', first: [{ type: "ident", value: "create" }] },
);

// `[IF NOT EXISTS] column-def`, the tail of `ADD [COLUMN]`. Decided by peeking
// rather than by `attempt`, so a column that happens to be called `if` costs no
// backtrack: `not` is reserved, so an unquoted one can never be the type of such
// a column. The `ident` test is what keeps a quoted `"not"`, which can, out.
function parseAddColumn(ctx: ParseContext<SqlTokenType>): AlterAction {
  const next = ctx.peekAhead(1);
  const ifNotExists = ctx.is("ident", "if") && next?.type === "ident" && next.value === "not";
  if (ifNotExists) ctx.parse(kwseq("if", "not", "exists"));
  return { kind: "addColumn", ifNotExists, column: ctx.parse(columnDef) };
}

// `OWNER TO role` — ALTER TABLE's action, and the same words on every other
// ALTER target that has an owner.
function parseOwnerTo(ctx: ParseContext<SqlTokenType>): AlterOwnerTo {
  ctx.parse(kwseq("owner", "to"));
  return { kind: "ownerTo", owner: ctx.parse(nameWord) };
}

// The ALTER TABLE actions. Dispatch peeks; each handler consumes its own lead
// word and owns whatever lookahead its own shapes need — `ADD [COLUMN] …` vs
// `ADD [CONSTRAINT name] …` vs a bare table constraint all begin with `add`, and
// looking at the word *after* it decides the shape before anything is consumed.
const ALTER_ACTIONS: DispatchMap<AlterAction> = {
  add: {
    parse: (ctx) => {
      const after = ctx.peekAhead(1);
      ctx.next(); // ADD
      if (after?.value === "column") {
        ctx.next(); // COLUMN
        return parseAddColumn(ctx);
      }
      if (after?.value === "constraint") {
        ctx.next(); // CONSTRAINT
        const name = ctx.parse(nameWord);
        return { kind: "addConstraint", name, constraint: ctx.parse(constraintBody) };
      }
      // A bare value test, not a rule: these four are reserved, so an *unquoted*
      // one is never the name of a column being added. A quoted `"primary"` is a
      // legal column name and still lands here — a pre-existing misroute, shared
      // with the `column`/`constraint` tests above, that this keeps as it was.
      if (after !== null && Object.hasOwn(TABLE_CONSTRAINTS, after.value)) {
        return { kind: "addConstraint", name: null, constraint: ctx.parse(tableConstraintBody) };
      }
      // `exclude` is unreserved, so it joins the list above only through a
      // lookahead (see atExcludeConstraint); `ADD exclude text` stays a column.
      if (atExcludeConstraint(ctx)) {
        return { kind: "addConstraint", name: null, constraint: ctx.parse(excludeBody) };
      }
      return parseAddColumn(ctx);
    },
  },
  drop: {
    parse: (ctx) => {
      ctx.next(); // DROP
      ctx.eat("ident", "column"); // optional COLUMN
      return { kind: "dropColumn", name: ctx.parse(nameWord) };
    },
  },
  alter: {
    parse: (ctx) => {
      ctx.next(); // ALTER
      ctx.eat("ident", "column"); // optional COLUMN
      const column = ctx.parse(nameWord);
      // `TYPE t` — shorthand for `SET DATA TYPE t`.
      if (ctx.eat("ident", "type") !== null) {
        return { kind: "setDataType", column, dataType: ctx.parse(typeRef) };
      }
      if (ctx.is("ident", "set")) {
        ctx.next(); // SET
        if (ctx.eat("ident", "default") !== null) {
          return { kind: "setDefault", column, expr: ctx.parse(expression) };
        }
        if (ctx.is("ident", "not")) {
          ctx.parse(kwseq("not", "null"));
          return { kind: "setNotNull", column };
        }
        ctx.parse(kwseq("data", "type"));
        return { kind: "setDataType", column, dataType: ctx.parse(typeRef) };
      }
      ctx.parse(kw("drop"));
      if (ctx.eat("ident", "default") !== null) return { kind: "dropDefault", column };
      ctx.parse(kwseq("not", "null"));
      return { kind: "dropNotNull", column };
    },
  },
  // `RENAME [COLUMN] old TO new` / `RENAME CONSTRAINT old TO new` /
  // `RENAME TO new` (the table itself). `to`/`constraint`/`column` are matched
  // by value regardless of their reserved status.
  rename: {
    parse: (ctx) => {
      ctx.next(); // RENAME
      if (ctx.eat("ident", "to") !== null) {
        return { kind: "renameTable", to: ctx.parse(nameWord) };
      }
      if (ctx.eat("ident", "constraint") !== null) {
        const from = ctx.parse(nameWord);
        ctx.parse(kw("to"));
        return { kind: "renameConstraint", from, to: ctx.parse(nameWord) };
      }
      ctx.eat("ident", "column"); // optional COLUMN
      const from = ctx.parse(nameWord);
      ctx.parse(kw("to"));
      return { kind: "renameColumn", from, to: ctx.parse(nameWord) };
    },
  },
  owner: { parse: parseOwnerTo },
  // `REPLICA IDENTITY {DEFAULT | FULL | NOTHING | USING INDEX name}`.
  replica: {
    parse: (ctx) => {
      ctx.parse(kwseq("replica", "identity"));
      if (ctx.eat("ident", "full") !== null) return { kind: "replicaIdentity", mode: "full", index: null };
      if (ctx.eat("ident", "nothing") !== null) return { kind: "replicaIdentity", mode: "nothing", index: null };
      if (ctx.is("ident", "using")) {
        ctx.parse(kwseq("using", "index"));
        return { kind: "replicaIdentity", mode: "usingIndex", index: ctx.parse(nameWord) };
      }
      ctx.parse(kw("default"));
      return { kind: "replicaIdentity", mode: "default", index: null };
    },
  },
};

// Hand-written croak, so the comma form over the KEYS — `owner` and `replica`
// would otherwise announce themselves as "owner to" / "replica identity". One
// expression, used for both the croak and the rule's own `expected`.
const ALTER_ACTION_EXPECTED = keyList(ALTER_ACTIONS);

const alterAction = custom<AlterAction, SqlTokenType>((ctx) => dispatch(ALTER_ACTIONS, ALTER_ACTION_EXPECTED, ctx), {
  expected: ALTER_ACTION_EXPECTED,
  first: dispatchFirst(ALTER_ACTIONS),
});

// The actions PG parses as a statement of their own rather than as an entry in
// the action list, keyed by kind and labelled for the croak. Such an action is
// fine alone and is rejected beside any other, on either side of it.
const SOLO_ALTER_ACTIONS: Partial<Record<AlterAction["kind"], string>> = {
  renameColumn: "RENAME",
  renameConstraint: "RENAME",
  renameTable: "RENAME",
};

// An optional `IF EXISTS`, decided by peeking like ADD's IF NOT EXISTS: `exists`
// leads no action, so an object called `if` is never followed by it.
function parseIfExists(ctx: ParseContext<SqlTokenType>): boolean {
  const next = ctx.peekAhead(1);
  const ifExists = ctx.is("ident", "if") && next?.type === "ident" && next.value === "exists";
  if (ifExists) ctx.parse(kwseq("if", "exists"));
  return ifExists;
}

// `TABLE [IF EXISTS] name action[, …]` — TABLE consumed here, ALTER by the
// caller, whose `start` the node spans from.
function alterTableRest(ctx: ParseContext<SqlTokenType>, start: Position): Stmt {
  ctx.next(); // TABLE
  const ifExists = parseIfExists(ctx);
  const name = ctx.parse(qualName);
  const actions = parseActionList(ctx, "TABLE", (c) => c.parse(alterAction), ALTER_ACTIONS, SOLO_ALTER_ACTIONS);
  return { kind: "alterTable", ifExists, name, actions, span: ctx.spanFrom(start) };
}

// The `action[, …]` list of ALTER TABLE, INDEX and [MATERIALIZED] VIEW, whose
// lead words are `map`'s keys. A `solo` kind is fine alone and rejected beside
// any other.
function parseActionList<A extends { kind: string }>(
  ctx: ParseContext<SqlTokenType>,
  target: string,
  parseAction: (ctx: ParseContext<SqlTokenType>) => A,
  map: DispatchMap<A>,
  solo: Partial<Record<A["kind"], string>>,
): A[] {
  const actions: A[] = [];
  do {
    const actionStart = ctx.position();
    const action = parseAction(ctx);
    const label = solo[action.kind as A["kind"]];
    if (label !== undefined) {
      // Rejected beside another action: one already parsed, or one whose lead
      // word follows the comma after it. A comma followed by no action word is
      // no second action, so it is left to fail as the stray comma it is.
      const leadsOn = ctx.is("punc", ",") && lookup(map, ctx.peekAhead(1)) !== undefined;
      if (actions.length > 0 || leadsOn) {
        const { end } = ctx.spanFrom(actionStart);
        ctx.croak(`${label} cannot be combined with other ALTER ${target} actions`, actionStart, end);
      }
      actions.push(action);
      break;
    }
    actions.push(action);
  } while (ctx.eat("punc", ",") !== null);
  return actions;
}

// The `TO name` of a RENAME whose RENAME has been consumed. `others` are the
// words the caller already tried there, named in the croak beside TO.
function parseTo(ctx: ParseContext<SqlTokenType>, ...others: string[]): AlterRenameTo {
  if (ctx.eat("ident", "to") === null) {
    ctx.croak(`Expected ${quoteList([...others, "to"])} but found ${describeFound(ctx.peek())}`);
  }
  return { kind: "rename", to: ctx.parse(nameWord) };
}

// `RENAME TO name` and `SET SCHEMA name`, the actions most ALTER targets share.
// SET SCHEMA is entered past its SET, which leads other actions too.
function parseRenameTo(ctx: ParseContext<SqlTokenType>): AlterRenameTo {
  ctx.next(); // RENAME
  return parseTo(ctx);
}

function parseSetSchema(ctx: ParseContext<SqlTokenType>): AlterSetSchema {
  ctx.parse(kw("schema"));
  return { kind: "setSchema", schema: ctx.parse(nameWord) };
}

// SET SCHEMA from its SET, for a target whose SET leads nothing else.
function parseSetSchemaAction(ctx: ParseContext<SqlTokenType>): AlterSetSchema {
  ctx.next(); // SET
  return parseSetSchema(ctx);
}

// A map per target; only INDEX and VIEW take a list, as ALTER TABLE does. Each croak is
// the comma form over its own keys, as ALTER_ACTIONS' is.
const SCHEMA_ACTIONS: DispatchMap<AlterSchemaAction> = {
  rename: { parse: parseRenameTo },
  owner: { parse: parseOwnerTo },
};

// After a DOMAIN action's lead word, choices fall on reserved words or a fixed
// slot, bar DROP CONSTRAINT's IF EXISTS, which is peeked as ALTER INDEX's is.
const DOMAIN_ACTIONS: DispatchMap<AlterDomainAction> = {
  set: {
    parse: (ctx) => {
      ctx.next(); // SET
      if (ctx.eat("ident", "default") !== null) return { kind: "setDefault", expr: ctx.parse(expression) };
      if (ctx.is("ident", "not")) {
        ctx.parse(kwseq("not", "null"));
        return { kind: "setNotNull" };
      }
      if (!ctx.is("ident", "schema")) {
        ctx.croak(`Expected ${quoteList(["default", "not", "schema"])} but found ${describeFound(ctx.peek())}`);
      }
      return parseSetSchema(ctx);
    },
  },
  drop: {
    parse: (ctx) => {
      ctx.next(); // DROP
      if (ctx.eat("ident", "default") !== null) return { kind: "dropDefault" };
      if (ctx.is("ident", "not")) {
        ctx.parse(kwseq("not", "null"));
        return { kind: "dropNotNull" };
      }
      if (ctx.eat("ident", "constraint") === null) {
        ctx.croak(`Expected ${quoteList(["default", "not", "constraint"])} but found ${describeFound(ctx.peek())}`);
      }
      const ifExists = parseIfExists(ctx);
      const name = ctx.parse(nameWord);
      return { kind: "dropConstraint", ifExists, name, behavior: ctx.parse(dropBehavior) };
    },
  },
  add: {
    parse: (ctx) => {
      ctx.next(); // ADD
      const name = ctx.eat("ident", "constraint") !== null ? ctx.parse(nameWord) : null;
      ctx.parse(kw("check"));
      const constraint = { kind: "check" as const, name, expr: ctx.parse(parenExpr) };
      const notValid = ctx.is("ident", "not");
      if (notValid) ctx.parse(kwseq("not", "valid"));
      return { kind: "addConstraint", constraint, notValid };
    },
  },
  rename: {
    parse: (ctx) => {
      ctx.next(); // RENAME
      if (ctx.eat("ident", "constraint") === null) return parseTo(ctx, "constraint");
      const from = ctx.parse(nameWord);
      ctx.parse(kw("to"));
      return { kind: "renameConstraint", from, to: ctx.parse(nameWord) };
    },
  },
  owner: { parse: parseOwnerTo },
  validate: {
    parse: (ctx) => {
      ctx.parse(kwseq("validate", "constraint"));
      return { kind: "validateConstraint", name: ctx.parse(nameWord) };
    },
  },
};

// No choice after a TYPE action's lead word is against a bare name: RENAME's
// VALUE vs TO included, since no RENAME form takes one there.
const TYPE_ACTIONS: DispatchMap<AlterTypeAction> = {
  add: {
    parse: (ctx) => {
      ctx.parse(kwseq("add", "value"));
      const ifNotExists = ctx.is("ident", "if");
      if (ifNotExists) ctx.parse(kwseq("if", "not", "exists"));
      const value = ctx.parse(strValue);
      const placement = ctx.eat("ident", "before") ?? ctx.eat("ident", "after");
      const position =
        placement === null ? null : { placement: placement.value as "before" | "after", value: ctx.parse(strValue) };
      return { kind: "addValue", ifNotExists, value, position };
    },
  },
  rename: {
    parse: (ctx) => {
      ctx.next(); // RENAME
      if (ctx.eat("ident", "value") === null) return parseTo(ctx, "value");
      const from = ctx.parse(strValue);
      ctx.parse(kw("to"));
      return { kind: "renameValue", from, to: ctx.parse(strValue) };
    },
  },
  owner: { parse: parseOwnerTo },
  set: { parse: parseSetSchemaAction },
};

// `RESET (name, …)`, ALTER INDEX's and ALTER VIEW's. It shares SET's option-list
// rule and, as PG does, refuses a value in it.
function parseResetOptions(ctx: ParseContext<SqlTokenType>): Extract<AlterIndexAction, { kind: "resetOptions" }> {
  ctx.next(); // RESET
  const options = ctx.parse(relationOptions);
  const valued = options.find((option) => option.value !== null);
  if (valued !== undefined) {
    ctx.croak("RESET must not include values for parameters", valued.span.start, valued.span.end);
  }
  return { kind: "resetOptions", options };
}

const INDEX_ACTIONS: DispatchMap<AlterIndexAction> = {
  rename: { parse: parseRenameTo },
  set: {
    parse: (ctx) => {
      ctx.next(); // SET
      if (ctx.is("punc", "(")) return { kind: "setOptions", options: ctx.parse(relationOptions) };
      if (ctx.eat("ident", "tablespace") === null) {
        ctx.croak(`Expected ${quoteList(["(", "tablespace"])} but found ${describeFound(ctx.peek())}`);
      }
      return { kind: "setTablespace", tablespace: ctx.parse(nameWord) };
    },
  },
  reset: { parse: parseResetOptions },
};

// The function attributes ALTER FUNCTION takes: CREATE FUNCTION's, bar the
// LANGUAGE, AS and WINDOW that only a definition can carry.
const ALTER_FUNCTION_OPTIONS: ReadonlySet<string> = new Set([
  "immutable",
  "stable",
  "volatile",
  "leakproof",
  "not",
  "strict",
  "called",
  "returns",
  "external",
  "security",
  "parallel",
  "cost",
  "rows",
  "set",
]);
// Only a NOT that does not lead NOT LEAKPROOF stops the loop at once.
function parseAlterFunctionOptions(ctx: ParseContext<SqlTokenType>): AlterFunctionAction {
  const options = parseFunctionOptions(ctx, ALTER_FUNCTION_OPTIONS);
  if (options.length === 0) ctx.parse(kwseq("not", "leakproof"));
  return { kind: "options", options };
}

// SET leads both SET SCHEMA and an attribute's `SET parameter {TO | =} value`.
// It is SET SCHEMA only when a name follows `schema`, as in PG, where `SET
// schema = …` and `SET schema TO …` set a parameter of that name; TO and FROM
// are reserved, so an unquoted one is never the new schema.
const FUNCTION_ACTIONS: DispatchMap<AlterFunctionAction> = {
  rename: { parse: parseRenameTo },
  owner: { parse: parseOwnerTo },
  set: {
    parse: (ctx) => {
      const word = ctx.peekAhead(1);
      const after = ctx.peekAhead(2);
      const setSchema =
        word?.type === "ident" &&
        word.value === "schema" &&
        (after?.type === "qident" || (after?.type === "ident" && !RESERVED.has(after.value)));
      if (!setSchema) return parseAlterFunctionOptions(ctx);
      ctx.next(); // SET
      return parseSetSchema(ctx);
    },
  },
};
for (const word of ALTER_FUNCTION_OPTIONS) {
  if (!Object.hasOwn(FUNCTION_ACTIONS, word)) FUNCTION_ACTIONS[word] = { parse: parseAlterFunctionOptions };
}

const AGGREGATE_ACTIONS: DispatchMap<AlterAggregateAction> = {
  rename: { parse: parseRenameTo },
  owner: { parse: parseOwnerTo },
  set: { parse: parseSetSchemaAction },
};

// After RENAME, TO is tried before a column name, as ALTER TABLE's RENAME does.
const MATERIALIZED_VIEW_ACTIONS: DispatchMap<AlterViewAction> = {
  rename: {
    parse: (ctx) => {
      ctx.next(); // RENAME
      if (ctx.eat("ident", "to") !== null) return { kind: "rename", to: ctx.parse(nameWord) };
      ctx.eat("ident", "column"); // optional COLUMN
      const from = ctx.parse(nameWord);
      ctx.parse(kw("to"));
      return { kind: "renameColumn", from, to: ctx.parse(nameWord) };
    },
  },
  owner: { parse: parseOwnerTo },
  set: {
    parse: (ctx) => {
      ctx.next(); // SET
      if (ctx.is("punc", "(")) return { kind: "setOptions", options: ctx.parse(relationOptions) };
      if (!ctx.is("ident", "schema")) {
        ctx.croak(`Expected ${quoteList(["(", "schema"])} but found ${describeFound(ctx.peek())}`);
      }
      return parseSetSchema(ctx);
    },
  },
  reset: { parse: parseResetOptions },
};
// A materialized view has no column defaults to set or drop.
const VIEW_ACTIONS: DispatchMap<AlterViewAction> = {
  ...MATERIALIZED_VIEW_ACTIONS,
  alter: {
    parse: (ctx) => {
      ctx.next(); // ALTER
      ctx.eat("ident", "column"); // optional COLUMN
      const column = ctx.parse(nameWord);
      if (ctx.eat("ident", "set") !== null) {
        ctx.parse(kw("default"));
        return { kind: "setDefault", column, expr: ctx.parse(expression) };
      }
      if (ctx.eat("ident", "drop") === null) {
        ctx.croak(`Expected ${quoteList(["set", "drop"])} but found ${describeFound(ctx.peek())}`);
      }
      ctx.parse(kw("default"));
      return { kind: "dropDefault", column };
    },
  },
};
const SOLO_VIEW_ACTIONS: Partial<Record<AlterViewAction["kind"], string>> = {
  rename: "RENAME",
  renameColumn: "RENAME",
  setSchema: "SET SCHEMA",
};

// Every sequence option leads an `options` action, which takes the whole run.
// Only a NO that leads none of NO {MINVALUE | MAXVALUE | CYCLE} stops it at once.
function parseAlterSequenceOptions(ctx: ParseContext<SqlTokenType>): AlterSequenceAction {
  const options = parseSequenceOptions(ctx);
  if (options.length === 0) {
    ctx.next(); // NO
    ctx.croak(`Expected ${quoteList(["minvalue", "maxvalue", "cycle"])} but found ${describeFound(ctx.peek())}`);
  }
  return { kind: "options", options };
}
// parseSequenceOptions' lead words, which it matches by hand and so cannot list.
const SEQUENCE_OPTIONS = [
  "as",
  "increment",
  "minvalue",
  "maxvalue",
  "start",
  "restart",
  "cache",
  "cycle",
  "no",
  "owned",
];
const SEQUENCE_ACTIONS: DispatchMap<AlterSequenceAction> = {
  rename: { parse: parseRenameTo },
  owner: { parse: parseOwnerTo },
  set: { parse: parseSetSchemaAction },
};
for (const word of SEQUENCE_OPTIONS) SEQUENCE_ACTIONS[word] = { parse: parseAlterSequenceOptions };

const SCHEMA_ACTION_EXPECTED = keyList(SCHEMA_ACTIONS);
const DOMAIN_ACTION_EXPECTED = keyList(DOMAIN_ACTIONS);
const TYPE_ACTION_EXPECTED = keyList(TYPE_ACTIONS);
const INDEX_ACTION_EXPECTED = keyList(INDEX_ACTIONS);
const FUNCTION_ACTION_EXPECTED = keyList(FUNCTION_ACTIONS);
const AGGREGATE_ACTION_EXPECTED = keyList(AGGREGATE_ACTIONS);
const VIEW_ACTION_EXPECTED = keyList(VIEW_ACTIONS);
const MATERIALIZED_VIEW_ACTION_EXPECTED = keyList(MATERIALIZED_VIEW_ACTIONS);
const SEQUENCE_ACTION_EXPECTED = keyList(SEQUENCE_ACTIONS);

// `[IF EXISTS] name action[, …]`, the rest of ALTER [MATERIALIZED] VIEW once VIEW
// is consumed.
function alterViewRest(ctx: ParseContext<SqlTokenType>, start: Position, materialized: boolean): Stmt {
  const ifExists = parseIfExists(ctx);
  const name = ctx.parse(qualName);
  const [map, expected] = materialized
    ? [MATERIALIZED_VIEW_ACTIONS, MATERIALIZED_VIEW_ACTION_EXPECTED]
    : [VIEW_ACTIONS, VIEW_ACTION_EXPECTED];
  const parseAction = (c: ParseContext<SqlTokenType>) => dispatch(map, expected, c);
  const target = materialized ? "MATERIALIZED VIEW" : "VIEW";
  const actions = parseActionList(ctx, target, parseAction, map, SOLO_VIEW_ACTIONS);
  return { kind: "alterView", materialized, ifExists, name, actions, span: ctx.spanFrom(start) };
}

// The ALTER targets. Dispatch peeks, as PLAIN_CREATE's does: each handler
// consumes its own lead word, and is handed the position before ALTER so its
// node spans the whole statement. The croak is hand-written and replaces no
// oneOf, so it takes the comma form over the keys, as ALTER_ACTIONS' does.
const ALTER_TARGETS: DispatchMap<Stmt, [Position]> = {
  table: { parse: alterTableRest },
  schema: {
    parse: (ctx, start) => {
      ctx.next(); // SCHEMA
      const name = ctx.parse(nameWord);
      const action = dispatch(SCHEMA_ACTIONS, SCHEMA_ACTION_EXPECTED, ctx);
      return { kind: "alterSchema", name, action, span: ctx.spanFrom(start) };
    },
  },
  domain: {
    parse: (ctx, start) => {
      ctx.next(); // DOMAIN
      const name = ctx.parse(qualName);
      const action = dispatch(DOMAIN_ACTIONS, DOMAIN_ACTION_EXPECTED, ctx);
      return { kind: "alterDomain", name, action, span: ctx.spanFrom(start) };
    },
  },
  type: {
    parse: (ctx, start) => {
      ctx.next(); // TYPE
      const name = ctx.parse(qualName);
      const action = dispatch(TYPE_ACTIONS, TYPE_ACTION_EXPECTED, ctx);
      return { kind: "alterType", name, action, span: ctx.spanFrom(start) };
    },
  },
  index: {
    parse: (ctx, start) => {
      ctx.next(); // INDEX
      const ifExists = parseIfExists(ctx);
      const name = ctx.parse(qualName);
      const parseAction = (c: ParseContext<SqlTokenType>) => dispatch(INDEX_ACTIONS, INDEX_ACTION_EXPECTED, c);
      const actions = parseActionList(ctx, "INDEX", parseAction, INDEX_ACTIONS, { rename: "RENAME" });
      return { kind: "alterIndex", ifExists, name, actions, span: ctx.spanFrom(start) };
    },
  },
  function: {
    parse: (ctx, start) => {
      ctx.next(); // FUNCTION
      const name = ctx.parse(qualName);
      const args = ctx.is("punc", "(") ? ctx.parse(functionArgs) : null;
      const action = dispatch(FUNCTION_ACTIONS, FUNCTION_ACTION_EXPECTED, ctx);
      return { kind: "alterFunction", name, args, action, span: ctx.spanFrom(start) };
    },
  },
  aggregate: {
    parse: (ctx, start) => {
      ctx.next(); // AGGREGATE
      const name = ctx.parse(qualName);
      const { star, args } = parseAggregateSignature(ctx);
      const action = dispatch(AGGREGATE_ACTIONS, AGGREGATE_ACTION_EXPECTED, ctx);
      return { kind: "alterAggregate", name, star, args, action, span: ctx.spanFrom(start) };
    },
  },
  view: {
    parse: (ctx, start) => {
      ctx.next(); // VIEW
      return alterViewRest(ctx, start, false);
    },
  },
  materialized: {
    parse: (ctx, start) => {
      ctx.parse(kwseq("materialized", "view"));
      return alterViewRest(ctx, start, true);
    },
  },
  sequence: {
    parse: (ctx, start) => {
      ctx.next(); // SEQUENCE
      const ifExists = parseIfExists(ctx);
      const name = ctx.parse(qualName);
      const action = dispatch(SEQUENCE_ACTIONS, SEQUENCE_ACTION_EXPECTED, ctx);
      return { kind: "alterSequence", ifExists, name, action, span: ctx.spanFrom(start) };
    },
  },
};
const ALTER_TARGET_EXPECTED = keyList(ALTER_TARGETS);

const alterStmt = custom<Stmt, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    ctx.parse(kw("alter"));
    return dispatch(ALTER_TARGETS, ALTER_TARGET_EXPECTED, ctx, start);
  },
  { expected: '"alter"', first: [{ type: "ident", value: "alter" }] },
);

// CASCADE / RESTRICT drop behavior, shared by DROP, TRUNCATE and ALTER DOMAIN (null when absent).
const dropBehavior = optional(oneOf(kw("cascade"), kw("restrict"))).map(
  (n) => (n?.value ?? null) as "cascade" | "restrict" | null,
);

// `DROP <object> …`, dispatched on the object keyword like ALTER. Every lead
// word is matched by value, so none of them stops being usable as a name;
// `table` and `user` are reserved but match here all the same.
type DropStmt = Extract<Stmt, { kind: "drop" }>;
type DropEntry = DispatchEntry<Stmt, [Position]>;

// The `[IF EXISTS] item[, …]` run shared by every DROP form, with each item
// already shaped into a `names` entry by `item`.
function parseDropNames<T>(ctx: ParseContext<SqlTokenType>, item: Rule<T, SqlTokenType>) {
  const ifExists = parseIfExists(ctx);
  return { ifExists, items: ctx.parse(sepBy(item, P(","))) };
}

// The node every DROP form builds; `extra` carries the per-kind keys, which are
// omitted when absent so the original object kinds keep their shape.
const dropNode = (
  ctx: ParseContext<SqlTokenType>,
  start: Position,
  objectType: string,
  fields: Pick<DropStmt, "concurrently" | "ifExists" | "names" | "behavior">,
  extra: Pick<DropStmt, "signatures" | "table" | "force"> = {},
): Stmt => ({ kind: "drop", objectType, ...fields, ...extra, span: ctx.spanFrom(start) });

const unqualName = nameWord.map((n) => [n]);

// `DROP kind [CONCURRENTLY] [IF EXISTS] name[, …] [CASCADE|RESTRICT]`. `lead`
// is the object keyword(s) consumed before the list. CONCURRENTLY is meant for
// INDEX but stays accepted on the original six kinds, as it always was.
const listDrop = (
  objectType: string,
  name: Rule<string[], SqlTokenType>,
  opts: { lead?: Rule<unknown, SqlTokenType>; concurrently?: boolean; behavior?: boolean } = {},
): DropEntry => ({
  parse: (ctx, start) => {
    if (opts.lead !== undefined) ctx.parse(opts.lead);
    else ctx.next(); // the object keyword
    const concurrently = opts.concurrently === true && ctx.eat("ident", "concurrently") !== null;
    const { ifExists, items: names } = parseDropNames(ctx, name);
    const behavior = opts.behavior === false ? null : ctx.parse(dropBehavior);
    return dropNode(ctx, start, objectType, { concurrently, ifExists, names, behavior });
  },
});

type RoutineRef = { name: string[]; signature: DropSignature | null };

// A function or procedure name, with its argument list when one is written.
const routineRef = custom<RoutineRef, SqlTokenType>(
  (ctx) => {
    const name = ctx.parse(qualName);
    const signature = ctx.is("punc", "(") ? { star: false, args: ctx.parse(dropFunctionArgs) } : null;
    return { name, signature };
  },
  { expected: "a name", first: [{ type: "ident" }, { type: "qident" }] },
);

// An aggregate name and its required `(*)` / `(type, …)` signature, which PG
// never lets be empty: a zero-argument aggregate is spelled `(*)`.
const aggregateRef = custom<{ name: string[]; signature: DropSignature }, SqlTokenType>(
  (ctx) => {
    const name = ctx.parse(qualName);
    const close = ctx.peekAhead(1);
    if (ctx.is("punc", "(") && close?.type === "punc" && close.value === ")") {
      ctx.next(); // "("
      ctx.croak(`Expected "*" or a function argument but found ${describeFound(close)}`);
    }
    return { name, signature: parseAggregateSignature(ctx, dropFunctionArgs) };
  },
  { expected: "a name", first: [{ type: "ident" }, { type: "qident" }] },
);

// `DROP {FUNCTION|PROCEDURE|AGGREGATE} [IF EXISTS] name [(args)][, …]
// [CASCADE|RESTRICT]`; `signatures` runs parallel to `names`.
const routineDrop = (objectType: string, ref: Rule<RoutineRef, SqlTokenType>): DropEntry => ({
  parse: (ctx, start) => {
    ctx.next(); // the object keyword
    const { ifExists, items } = parseDropNames(ctx, ref);
    const behavior = ctx.parse(dropBehavior);
    const names = items.map((i) => i.name);
    const signatures = items.map((i) => i.signature);
    return dropNode(ctx, start, objectType, { concurrently: false, ifExists, names, behavior }, { signatures });
  },
});

const DROP_TARGETS: DispatchMap<Stmt, [Position]> = {
  table: listDrop("table", qualName, { concurrently: true }),
  view: listDrop("view", qualName, { concurrently: true }),
  index: listDrop("index", qualName, { concurrently: true }),
  type: listDrop("type", qualName, { concurrently: true }),
  sequence: listDrop("sequence", qualName, { concurrently: true }),
  schema: listDrop("schema", qualName, { concurrently: true }),
  materialized: listDrop("materialized view", qualName, { lead: kwseq("materialized", "view") }),
  function: routineDrop("function", routineRef),
  procedure: routineDrop("procedure", routineRef),
  aggregate: routineDrop("aggregate", aggregateRef),
  // `DROP TRIGGER [IF EXISTS] name ON table [CASCADE|RESTRICT]` — one trigger.
  trigger: {
    parse: (ctx, start) => {
      ctx.next(); // TRIGGER
      const ifExists = parseIfExists(ctx);
      const name = ctx.parse(nameWord);
      ctx.parse(kw("on"));
      const table = ctx.parse(qualName);
      const behavior = ctx.parse(dropBehavior);
      return dropNode(ctx, start, "trigger", { concurrently: false, ifExists, names: [[name]], behavior }, { table });
    },
  },
  domain: listDrop("domain", qualName),
  extension: listDrop("extension", unqualName),
  // `DROP DATABASE [IF EXISTS] name [[WITH] (FORCE[, …])]` — one database, and
  // no CASCADE / RESTRICT. FORCE is PG's only option, so the list holds just it.
  database: {
    parse: (ctx, start) => {
      ctx.next(); // DATABASE
      const ifExists = parseIfExists(ctx);
      const name = ctx.parse(nameWord);
      const force = ctx.eat("ident", "with") !== null || ctx.is("punc", "(");
      if (force) {
        if (ctx.eat("punc", "(") === null) ctx.croak(`Expected "(" but found ${describeFound(ctx.peek())}`);
        ctx.parse(sepBy(kw("force"), P(",")));
        expectClose(ctx);
      }
      const fields = { concurrently: false, ifExists, names: [[name]], behavior: null };
      return dropNode(ctx, start, "database", fields, force ? { force } : {});
    },
  },
  role: listDrop("role", unqualName, { behavior: false }),
  // USER only; `DROP USER MAPPING` is not supported and reads as a user named
  // `mapping` followed by stray words.
  user: listDrop("user", unqualName, { behavior: false }),
};
const DROP_TARGET_EXPECTED = keyList(DROP_TARGETS);

const dropStmt = custom<Stmt, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    ctx.parse(kw("drop"));
    return dispatch(DROP_TARGETS, DROP_TARGET_EXPECTED, ctx, start);
  },
  { expected: '"drop"', first: [{ type: "ident", value: "drop" }] },
);

const truncateStmt = seq(
  skip(kw("truncate")),
  skip(optional(kw("table"))), // optional TABLE noise word
  field("names", sepBy(qualName, P(","))),
  field(
    "identity",
    optional(
      seq(field("m", oneOf(kw("restart"), kw("continue"))), skip(kw("identity"))).map(
        (s) => s.m.value as "restart" | "continue",
      ),
    ),
  ),
  field("behavior", dropBehavior),
).map(({ names, identity, behavior }, span): Stmt => ({ kind: "truncate", names, identity, behavior, span }));

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

// --- Phase 9: DCL / TCL / session ---
//
// Every lead word here (revoke/begin/start/commit/rollback/savepoint/release/
// show/reset/deallocate and the various option words) stays UNRESERVED — matched
// by value via `kw()`/`ctx.eat` — so they remain usable as identifiers elsewhere.
// (`grant`, `do`, and `set` are already reserved for other reasons.)

// One or more `parseItem` results, comma-separated. A hand loop rather than
// `sepBy` because the callers run inside a `custom` closure over raw `ctx`.
function commaList<T>(ctx: ParseContext<SqlTokenType>, parseItem: (c: ParseContext<SqlTokenType>) => T): T[] {
  const items = [parseItem(ctx)];
  while (ctx.eat("punc", ",") !== null) items.push(parseItem(ctx));
  return items;
}

// The privilege keywords a GRANT/REVOKE may name (folded, so all lowercase). A
// word outside this set is read as a role name instead (role grants).
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
]);

// Object kinds a privilege may target (default TABLE when omitted).
const GRANT_OBJECT_TYPES: ReadonlySet<string> = new Set([
  "table",
  "sequence",
  "database",
  "schema",
  "function",
  "procedure",
  "routine",
  "type",
  "domain",
  "language",
  "tablespace",
]);

// Plural → singular for the `ALL {TABLES|…} IN SCHEMA` object form.
const ALL_IN_SCHEMA: Record<string, string> = {
  tables: "table",
  sequences: "sequence",
  functions: "function",
  procedures: "procedure",
  routines: "routine",
};

// One privilege keyword (or, in a role grant, a role name) with an optional
// `(col, …)` column list. `nameWord` excludes reserved words, so privilege
// keywords — several of which are reserved — are matched by value first.
function parsePrivilege(ctx: ParseContext<SqlTokenType>): Privilege {
  const cur = ctx.peek();
  let n: string;
  if (cur !== null && cur.type === "ident" && PRIVILEGE_WORDS.has(cur.value)) {
    n = cur.value;
    ctx.next();
  } else {
    n = ctx.parse(nameWord);
  }
  const columns = ctx.is("punc", "(") ? ctx.parse(columnList) : null;
  return { name: n, columns };
}

// The `ON …` object target (the `ON` keyword already consumed by the caller).
function parseGrantObject(ctx: ParseContext<SqlTokenType>): GrantObject {
  // `ALL {TABLES|SEQUENCES|FUNCTIONS|PROCEDURES|ROUTINES} IN SCHEMA s[, …]`.
  // A bare word, checked with `Object.hasOwn`, as in `lookup`: so neither
  // `ALL constructor` nor a quoted `ALL "tables"` is taken for a plural.
  const next = ctx.is("ident", "all") ? ctx.peekAhead(1) : null;
  if (next?.type === "ident" && Object.hasOwn(ALL_IN_SCHEMA, next.value)) {
    ctx.next(); // ALL
    const plural = ctx.next()!.value; // tables / sequences / …
    ctx.parse(kwseq("in", "schema"));
    return { objectType: ALL_IN_SCHEMA[plural]!, names: [], inSchema: commaList(ctx, (c) => c.parse(qualName)) };
  }
  // `[objectType] name[, …]` — objectType defaults to TABLE when omitted.
  let objectType = "table";
  const cur = ctx.peek();
  if (cur !== null && cur.type === "ident" && GRANT_OBJECT_TYPES.has(cur.value)) {
    objectType = cur.value;
    ctx.next();
  }
  return { objectType, names: commaList(ctx, (c) => c.parse(qualName)), inSchema: null };
}

// A single grantee: `[GROUP] role`, PUBLIC, or a CURRENT_/SESSION_ pseudo-role
// (those are reserved words, so they are matched by value before `nameWord`).
const GRANTEE_KEYWORDS: ReadonlySet<string> = new Set(["public", "current_user", "current_role", "session_user"]);
function parseGrantee(ctx: ParseContext<SqlTokenType>): string {
  ctx.eat("ident", "group"); // optional GROUP noise word
  const cur = ctx.peek();
  if (cur !== null && cur.type === "ident" && GRANTEE_KEYWORDS.has(cur.value)) {
    ctx.next();
    return cur.value;
  }
  return ctx.parse(nameWord);
}

// The shared `{privileges | ALL} [ON object] {TO|FROM} grantees` middle of
// GRANT and REVOKE. `granteeKw` is "to" for GRANT, "from" for REVOKE.
function parseGrantBody(
  ctx: ParseContext<SqlTokenType>,
  granteeKw: string,
): { privileges: Privilege[] | "all"; on: GrantObject | null; grantees: string[] } {
  let privileges: Privilege[] | "all";
  if (ctx.is("ident", "all")) {
    ctx.next(); // ALL
    ctx.eat("ident", "privileges"); // optional PRIVILEGES
    privileges = "all";
  } else {
    privileges = commaList(ctx, parsePrivilege);
  }
  const on = ctx.eat("ident", "on") !== null ? parseGrantObject(ctx) : null;
  ctx.parse(kw(granteeKw));
  return { privileges, on, grantees: commaList(ctx, parseGrantee) };
}

const grantStmt = custom<Stmt, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    const revoke = ctx.eat("ident", "revoke") !== null;
    if (!revoke) ctx.parse(kw("grant"));
    // REVOKE [{GRANT|ADMIN} OPTION FOR] …
    let grantOptionFor = false;
    if (revoke) {
      const w = ctx.peek();
      if (
        w !== null &&
        w.type === "ident" &&
        (w.value === "grant" || w.value === "admin") &&
        ctx.peekAhead(1)?.value === "option"
      ) {
        ctx.next(); // GRANT / ADMIN
        ctx.next(); // OPTION
        ctx.parse(kw("for"));
        grantOptionFor = true;
      }
    }
    const { privileges, on, grantees } = parseGrantBody(ctx, revoke ? "from" : "to");
    if (revoke) {
      const behavior = ctx.parse(dropBehavior);
      return { kind: "revoke", grantOptionFor, privileges, on, grantees, behavior, span: ctx.spanFrom(start) };
    }
    // GRANT: WITH GRANT OPTION (object) or WITH ADMIN OPTION (role).
    let withGrantOption = false;
    if (ctx.eat("ident", "with") !== null) {
      if (ctx.eat("ident", "grant") === null) ctx.parse(kw("admin"));
      ctx.parse(kw("option"));
      withGrantOption = true;
    }
    return { kind: "grant", privileges, on, grantees, withGrantOption, span: ctx.spanFrom(start) };
  },
  {
    expected: '"grant" or "revoke"',
    first: [
      { type: "ident", value: "grant" },
      { type: "ident", value: "revoke" },
    ],
  },
);

// One transaction characteristic: ISOLATION LEVEL …, READ WRITE|ONLY,
// [NOT] DEFERRABLE.
function parseTransactionMode(ctx: ParseContext<SqlTokenType>): TransactionMode {
  if (ctx.is("ident", "isolation")) {
    ctx.parse(kwseq("isolation", "level"));
    if (ctx.eat("ident", "serializable") !== null) return { kind: "isolation", level: "serializable" };
    if (ctx.is("ident", "repeatable")) {
      ctx.parse(kwseq("repeatable", "read"));
      return { kind: "isolation", level: "repeatableRead" };
    }
    if (ctx.is("ident", "read") && ctx.peekAhead(1)?.value === "committed") {
      ctx.parse(kwseq("read", "committed"));
      return { kind: "isolation", level: "readCommitted" };
    }
    ctx.parse(kwseq("read", "uncommitted"));
    return { kind: "isolation", level: "readUncommitted" };
  }
  if (ctx.is("ident", "read")) {
    if (ctx.peekAhead(1)?.value === "only") {
      ctx.parse(kwseq("read", "only"));
      return { kind: "readWrite", value: false };
    }
    ctx.parse(kwseq("read", "write"));
    return { kind: "readWrite", value: true };
  }
  if (ctx.eat("ident", "not") !== null) {
    ctx.parse(kw("deferrable"));
    return { kind: "deferrable", value: false };
  }
  ctx.parse(kw("deferrable"));
  return { kind: "deferrable", value: true };
}

const TRANSACTION_MODE_LEADS: ReadonlySet<string> = new Set(["isolation", "read", "not", "deferrable"]);
// Zero or more transaction modes (commas between them are optional in PG).
function parseTransactionModes(ctx: ParseContext<SqlTokenType>): TransactionMode[] {
  const modes: TransactionMode[] = [];
  while (true) {
    const t = ctx.peek();
    if (t === null || t.type !== "ident" || !TRANSACTION_MODE_LEADS.has(t.value)) break;
    modes.push(parseTransactionMode(ctx));
    ctx.eat("punc", ","); // optional separator
  }
  return modes;
}

// `AND [NO] CHAIN` on COMMIT / ROLLBACK — returns whether CHAIN (not NO CHAIN).
function parseAndChain(ctx: ParseContext<SqlTokenType>): boolean {
  if (ctx.eat("ident", "and") === null) return false;
  const no = ctx.eat("ident", "no") !== null;
  ctx.parse(kw("chain"));
  return !no;
}

const transactionStmt = custom<Stmt, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    const head = ctx.peek()!; // guaranteed an ident lead by the first set
    if (head.value === "begin") {
      ctx.next();
      ctx.eat("ident", "work") ?? ctx.eat("ident", "transaction"); // optional WORK|TRANSACTION
      return { kind: "begin", start: false, modes: parseTransactionModes(ctx), span: ctx.spanFrom(start) };
    }
    if (head.value === "start") {
      ctx.parse(kwseq("start", "transaction"));
      return { kind: "begin", start: true, modes: parseTransactionModes(ctx), span: ctx.spanFrom(start) };
    }
    if (head.value === "commit") {
      ctx.next();
      ctx.eat("ident", "work") ?? ctx.eat("ident", "transaction");
      return { kind: "commit", chain: parseAndChain(ctx), span: ctx.spanFrom(start) };
    }
    if (head.value === "rollback") {
      ctx.next();
      ctx.eat("ident", "work") ?? ctx.eat("ident", "transaction");
      // `ROLLBACK TO [SAVEPOINT] name` and `ROLLBACK AND CHAIN` are exclusive.
      if (ctx.eat("ident", "to") !== null) {
        ctx.eat("ident", "savepoint"); // optional SAVEPOINT
        return { kind: "rollback", chain: false, savepoint: ctx.parse(nameWord), span: ctx.spanFrom(start) };
      }
      return { kind: "rollback", chain: parseAndChain(ctx), savepoint: null, span: ctx.spanFrom(start) };
    }
    if (head.value === "savepoint") {
      ctx.next();
      return { kind: "savepoint", name: ctx.parse(nameWord), span: ctx.spanFrom(start) };
    }
    ctx.parse(kw("release"));
    ctx.eat("ident", "savepoint"); // optional SAVEPOINT
    return { kind: "releaseSavepoint", name: ctx.parse(nameWord), span: ctx.spanFrom(start) };
  },
  {
    expected: "a transaction statement",
    first: [
      { type: "ident", value: "begin" },
      { type: "ident", value: "start" },
      { type: "ident", value: "commit" },
      { type: "ident", value: "rollback" },
      { type: "ident", value: "savepoint" },
      { type: "ident", value: "release" },
    ],
  },
);

// A dotted config parameter name (`search_path`, `my.custom.guc`) → one string.
const configName = sepBy(nameWord, P(".")).map((parts) => parts.join("."));
// The single-value SET forms that take no `=`/`TO` operator.
const SET_SINGLE_FORMS: ReadonlySet<string> = new Set(["role", "schema", "names"]);

const sessionStmt = custom<Stmt, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    if (ctx.eat("ident", "show") !== null) {
      const name = ctx.eat("ident", "all") !== null ? "all" : ctx.parse(configName);
      return { kind: "show", name, span: ctx.spanFrom(start) };
    }
    if (ctx.eat("ident", "reset") !== null) {
      const name = ctx.eat("ident", "all") !== null ? "all" : ctx.parse(configName);
      return { kind: "reset", name, span: ctx.spanFrom(start) };
    }
    ctx.parse(kw("set"));
    let scope: "session" | "local" | null = null;
    if (ctx.eat("ident", "session") !== null) scope = "session";
    else if (ctx.eat("ident", "local") !== null) scope = "local";
    // `SET TIME ZONE value` — a single value, no operator.
    if (ctx.is("ident", "time")) {
      ctx.parse(kwseq("time", "zone"));
      const values: Expr[] | "default" = ctx.eat("ident", "default") !== null ? "default" : [ctx.parse(expression)];
      return { kind: "set", scope, name: "time zone", values, span: ctx.spanFrom(start) };
    }
    // `SET {ROLE|SCHEMA|NAMES} value` — likewise operator-less.
    const lead = ctx.peek();
    if (lead !== null && lead.type === "ident" && SET_SINGLE_FORMS.has(lead.value)) {
      ctx.next();
      const values: Expr[] | "default" = ctx.eat("ident", "default") !== null ? "default" : [ctx.parse(expression)];
      return { kind: "set", scope, name: lead.value, values, span: ctx.spanFrom(start) };
    }
    // Generic `SET name {=|TO} value[, …]`.
    const name = ctx.parse(configName);
    if (ctx.eat("op", "=") === null) ctx.parse(kw("to"));
    const values: Expr[] | "default" =
      ctx.eat("ident", "default") !== null ? "default" : commaList(ctx, (c) => c.parse(expression));
    return { kind: "set", scope, name, values, span: ctx.spanFrom(start) };
  },
  {
    expected: "a SET / SHOW / RESET statement",
    first: [
      { type: "ident", value: "set" },
      { type: "ident", value: "show" },
      { type: "ident", value: "reset" },
    ],
  },
);

const doStmt = custom<Stmt, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    ctx.parse(kw("do"));
    // LANGUAGE and the code body may appear in either order.
    let language: string | null = null;
    let body: string | null = null;
    while (true) {
      if (ctx.is("ident", "language")) {
        ctx.next();
        language = ctx.is("string") ? ctx.parse(strValue) : ctx.parse(nameWord);
      } else if (ctx.is("string")) {
        body = ctx.parse(strValue);
      } else break;
    }
    if (body === null) return ctx.croak(`Expected a code body but found ${describeFound(ctx.peek())}`);
    return { kind: "do", language, body, span: ctx.spanFrom(start) };
  },
  { expected: '"do"', first: [{ type: "ident", value: "do" }] },
);

const deallocateStmt = custom<Stmt, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    ctx.parse(kw("deallocate"));
    ctx.eat("ident", "prepare"); // optional PREPARE noise word
    const name = ctx.eat("ident", "all") !== null ? null : ctx.parse(nameWord);
    return { kind: "deallocate", name, span: ctx.spanFrom(start) };
  },
  { expected: '"deallocate"', first: [{ type: "ident", value: "deallocate" }] },
);

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
const assignment = seq(field("column", nameWord), skip(eq), field("value", expression)).map(
  ({ column, value }): Assignment => ({ column, value }),
);
const setAssignments = seq(skip(kw("set")), field("items", sepBy(assignment, P(",")))).map((s) => s.items);

const whereClause = seq(skip(kw("where")), field("e", expression)).map((s) => s.e);

// One grouping element inside ROLLUP/CUBE/GROUPING SETS: a parenthesised column
// group `( a, b )` (possibly the empty `()`) or a bare expression (→ `[expr]`).
function parseGroupingElement(ctx: ParseContext<SqlTokenType>): Expr[] {
  if (ctx.is("punc", "(")) {
    ctx.next(); // "("
    const exprs: Expr[] = [];
    if (!ctx.is("punc", ")")) {
      exprs.push(ctx.parse(expression));
      while (ctx.eat("punc", ",") !== null) exprs.push(ctx.parse(expression));
    }
    expectClose(ctx);
    return exprs;
  }
  return [ctx.parse(expression)];
}

// The parenthesised element list shared by ROLLUP / CUBE / GROUPING SETS:
// `( element, … )`. Entered positioned on the opening `(`.
function parseGroupingList(ctx: ParseContext<SqlTokenType>): Expr[][] {
  if (!ctx.is("punc", "(")) ctx.croak(`Expected "(" but found ${describeFound(ctx.peek())}`);
  ctx.next(); // "("
  const elements: Expr[][] = [parseGroupingElement(ctx)];
  while (ctx.eat("punc", ",") !== null) elements.push(parseGroupingElement(ctx));
  expectClose(ctx);
  return elements;
}

// A GROUP BY item: `ROLLUP (…)`, `CUBE (…)`, `GROUPING SETS (…)`, the empty
// grouping `()`, or a plain expression. The three construct keywords stay
// unreserved — each is recognised only when the tell-tale token follows (`(` for
// rollup/cube, `sets` for grouping), so `GROUP BY cube` (a column) and
// `GROUP BY grouping(x)` (a function) still parse as ordinary expressions. The
// empty grouping has no keyword to protect: `()` is not a valid expression, so
// claiming it takes nothing away from the expression fallthrough below.
const groupByItem = custom<GroupByItem, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    const head = ctx.peek();
    if (head?.type === "punc" && head.value === "(") {
      const after = ctx.peekAhead(1);
      // Only the empty pair: `(a)` and `(SELECT …)` fall through untouched.
      if (after?.type === "punc" && after.value === ")") {
        ctx.next(); // "("
        ctx.next(); // ")"
        return { kind: "emptyGrouping", span: ctx.spanFrom(start) };
      }
    }
    if (head?.type === "ident" && (head.value === "rollup" || head.value === "cube")) {
      const after = ctx.peekAhead(1);
      if (after?.type === "punc" && after.value === "(") {
        const kind = head.value as "rollup" | "cube";
        ctx.next(); // rollup / cube
        return { kind, args: parseGroupingList(ctx), span: ctx.spanFrom(start) };
      }
    }
    if (head?.type === "ident" && head.value === "grouping" && ctx.peekAhead(1)?.value === "sets") {
      ctx.parse(kwseq("grouping", "sets"));
      return { kind: "groupingSets", sets: parseGroupingList(ctx), span: ctx.spanFrom(start) };
    }
    return ctx.parse(expression);
  },
  { expected: "a grouping element or expression", first: expression.first() },
);

// `GROUP BY [ALL | DISTINCT] element, …`. ALL is the default, so only DISTINCT
// is recorded — the same convention `distinctClause` follows for `SELECT ALL`.
// Both words are reserved, so neither can be a grouping expression of its own.
const groupByClause = seq(
  skip(kwseq("group", "by")),
  field(
    "distinct",
    optional(oneOf(kw("distinct"), kw("all"))).map((node) => node?.value === "distinct"),
  ),
  field("items", sepBy(groupByItem, P(","))),
);
const havingClause = seq(skip(kw("having")), field("e", expression)).map((s) => s.e);

// `WINDOW w AS (spec), … ` — named window definitions. `overSpecRule` (declared
// with the window helpers above) parses each `(…)` body.
const namedWindowDef = seq(field("name", nameWord), skip(kw("as")), field("spec", overSpecRule)).map(
  ({ name, spec }): NamedWindow => ({ name, spec }),
);
const windowClause = seq(skip(kw("window")), field("defs", sepBy(namedWindowDef, P(",")))).map((s) => s.defs);

// The operator after `USING`: any operator token except `=>`, which PG lexes
// as its own named-argument token rather than an operator (see `functionArg`).
// PG's `OPERATOR(schema.op)` spelling is deliberately not taken — no other
// position in this grammar parses it either.
const sortOperator = custom<string, SqlTokenType>(
  (ctx) => {
    const tok = ctx.peek();
    if (tok === null || tok.type !== "op" || tok.value === "=>") {
      return ctx.croak(`Expected an operator but found ${describeFound(tok)}`);
    }
    ctx.next();
    return tok.value;
  },
  { expected: "an operator", first: [{ type: "op" }] },
);

// ASC / DESC, or PG's `USING op` (`ORDER BY a USING <`) — one optional slot,
// since PG's sortby takes either but never both. `using` is reserved, so no
// valid input has it after a sort key for the slot to steal.
const sortOrder = oneOf(
  kw("asc").map(() => ({ dir: "asc" as const, using: null })),
  kw("desc").map(() => ({ dir: "desc" as const, using: null })),
  seq(skip(kw("using")), field("op", sortOperator)).map((s) => ({ dir: null, using: s.op })),
);
const orderItem = seq(
  field("expr", expression),
  field("order", optional(sortOrder)),
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
).map(
  ({ expr, order, nulls }): OrderItem => ({
    expr,
    dir: order?.dir ?? null,
    ...(order?.using && { using: order.using }),
    nulls: nulls ?? null,
  }),
);
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

// LIMIT / OFFSET / FETCH, in any order. `LIMIT ALL` is a null limit; the
// SQL-standard `FETCH { FIRST | NEXT } [count] { ROW | ROWS } { ONLY | WITH
// TIES }` sets `limit` to its count (the ROW/ROWS/ONLY/WITH-TIES noise words are
// consumed and dropped), and `OFFSET n [ROW | ROWS]` accepts the standard
// trailing row word. `first`/`next`/`row`/`rows`/`only`/`ties` stay unreserved.
const limitOffset = custom<{ limit: Expr | null; offset: Expr | null }, SqlTokenType>(
  (ctx) => {
    let limit: Expr | null = null;
    let offset: Expr | null = null;
    for (let i = 0; i < 3; i++) {
      if (ctx.eat("ident", "limit") !== null) {
        limit = ctx.eat("ident", "all") !== null ? null : ctx.parse(expression);
      } else if (ctx.eat("ident", "offset") !== null) {
        offset = ctx.parse(expression);
        ctx.eat("ident", ["row", "rows"]); // optional trailing ROW / ROWS
      } else if (ctx.eat("ident", "fetch") !== null) {
        ctx.eat("ident", ["first", "next"]); // FIRST | NEXT
        // The count is optional (`FETCH FIRST ROW ONLY` ≡ 1); when omitted the
        // next token is the ROW/ROWS word, so only read a count before it.
        if (!ctx.is("ident", ["row", "rows"])) limit = ctx.parse(expression);
        ctx.eat("ident", ["row", "rows"]); // ROW | ROWS
        if (ctx.eat("ident", "with") !== null) ctx.parse(kw("ties"));
        else ctx.eat("ident", "only"); // ONLY (optional)
      } else {
        break;
      }
    }
    return { limit, offset };
  },
  {
    expected: '"limit", "offset" or "fetch"',
    first: [
      { type: "ident", value: "limit" },
      { type: "ident", value: "offset" },
      { type: "ident", value: "fetch" },
    ],
  },
);

// `FOR { UPDATE | SHARE | NO KEY UPDATE | KEY SHARE } [OF table, …]
// [NOWAIT | SKIP LOCKED]`, repeatable. `for` is reserved (so it never reads as an
// alias); the strength / wait words are matched by value.
const lockingClause = custom<LockingClause[], SqlTokenType>(
  (ctx) => {
    const clauses: LockingClause[] = [];
    do {
      ctx.parse(kw("for"));
      let strength: LockingClause["strength"];
      if (ctx.eat("ident", "update") !== null) {
        strength = "update";
      } else if (ctx.eat("ident", "share") !== null) {
        strength = "share";
      } else if (ctx.is("ident", "no")) {
        ctx.parse(kwseq("no", "key", "update"));
        strength = "noKeyUpdate";
      } else if (ctx.is("ident", "key")) {
        ctx.parse(kwseq("key", "share"));
        strength = "keyShare";
      } else {
        return ctx.croak(`Expected "update", "share", "no" or "key" but found ${describeFound(ctx.peek())}`);
      }
      const of = ctx.eat("ident", "of") !== null ? ctx.parse(sepBy(qualName, P(","))) : [];
      let wait: LockingClause["wait"] = null;
      if (ctx.eat("ident", "nowait") !== null) {
        wait = "nowait";
      } else if (ctx.is("ident", "skip")) {
        ctx.parse(kwseq("skip", "locked"));
        wait = "skipLocked";
      }
      clauses.push({ strength, of, wait });
    } while (ctx.is("ident", "for"));
    return clauses;
  },
  { expected: '"for"', first: [{ type: "ident", value: "for" }] },
);

const selectItem = oneOf(
  bareStar.map((expr): SelectItem => ({ expr, alias: null })),
  seq(field("expr", expression), field("alias", asAlias)).map(({ expr, alias }): SelectItem => ({ expr, alias })),
);
const returningClause = seq(skip(kw("returning")), field("items", sepBy(selectItem, P(",")))).map((s) => s.items);

// --- DML: FROM items and joins ---

// `TABLESAMPLE method (arg, …) [REPEATABLE (seed)]`. Entered positioned on the
// `tablesample` word; `method` (system / bernoulli / …) is an unreserved name.
function parseTableSample(ctx: ParseContext<SqlTokenType>): TableSample {
  ctx.parse(kw("tablesample"));
  const method = ctx.parse(nameWord);
  if (!ctx.is("punc", "(")) ctx.croak(`Expected "(" but found ${describeFound(ctx.peek())}`);
  ctx.next(); // "("
  const args: Expr[] = [ctx.parse(expression)];
  while (ctx.eat("punc", ",") !== null) args.push(ctx.parse(expression));
  expectClose(ctx);
  let repeatable: Expr | null = null;
  if (ctx.eat("ident", "repeatable") !== null) {
    if (!ctx.is("punc", "(")) ctx.croak(`Expected "(" but found ${describeFound(ctx.peek())}`);
    ctx.next(); // "("
    repeatable = ctx.parse(expression);
    expectClose(ctx);
  }
  return { method, args, repeatable };
}

// `[AS] alias [(column, …)]` — PG's `alias_clause`. The column list is read only
// once an alias has been read: PG's grammar has no alias-less spelling of it,
// and a bare `t (a, b)` is a table-function call (see tableRef). Unlike the
// shared `columnList`, the list must name at least one column, as PG's does.
const aliasColumns = sepBy(nameWord, P(","));
function parseAliasClause(ctx: ParseContext<SqlTokenType>): { alias: string | null; columns: string[] | null } {
  const alias = ctx.parse(asAlias);
  if (alias === null || !ctx.is("punc", "(")) return { alias, columns: null };
  ctx.next(); // "("
  const columns = ctx.parse(aliasColumns);
  expectClose(ctx);
  return { alias, columns };
}

// The rest of a table FROM item once its name is read: the alias clause, then an
// optional TABLESAMPLE — PG's order, so an alias list always comes before the
// sample (`t [AS] x (a) TABLESAMPLE …`).
function tableTail(ctx: ParseContext<SqlTokenType>, name: string[], only: boolean): FromItem {
  const { alias, columns } = parseAliasClause(ctx);
  const tablesample = ctx.is("ident", "tablesample") ? parseTableSample(ctx) : null;
  return {
    kind: "table",
    name,
    alias,
    ...(columns !== null && { columns }),
    ...(tablesample !== null && { tablesample }),
    ...(only && { only: true }),
  };
}

// A table-function call in FROM — `name(arg, …)`, positioned on the name.
function parseFromCall(ctx: ParseContext<SqlTokenType>): Expr {
  const start = ctx.position();
  const nameParts = ctx.parse(qualName);
  return parseFromCallArgs(ctx, nameParts, start);
}
// The argument list of a FROM call whose name is read. The call's span runs
// from `start`, which tableRef passes so a plain item's span keeps covering a
// leading LATERAL.
function parseFromCallArgs(ctx: ParseContext<SqlTokenType>, nameParts: string[], start: Position): Expr {
  const args = parseCallArgList(ctx);
  return { kind: "call", name: nameParts.join("."), args, span: ctx.spanFrom(start) };
}
// `( [functionArg, …] )` — a call's argument list, possibly empty, without the
// modifiers a SELECT-list call takes. Shared by FROM calls and CALL.
function parseCallArgList(ctx: ParseContext<SqlTokenType>): Expr[] {
  if (!ctx.is("punc", "(")) ctx.croak(`Expected "(" but found ${describeFound(ctx.peek())}`);
  ctx.next(); // "("
  const args: Expr[] = [];
  if (!ctx.is("punc", ")")) {
    args.push(ctx.parse(functionArg));
    while (ctx.eat("punc", ",") !== null) args.push(ctx.parse(functionArg));
  }
  expectClose(ctx);
  return args;
}

// `WITH ORDINALITY` after a table function. Keyed on the word pair, since a
// bare `with` after a FROM item can also open an enclosing materialized view's
// `WITH [NO] DATA`; `ordinality` itself stays unreserved.
const eatOrdinality = (ctx: ParseContext<SqlTokenType>): boolean => {
  if (!ctx.is("ident", "with")) return false;
  const after = ctx.peekAhead(1);
  if (after === null || after.type !== "ident" || after.value !== "ordinality") return false;
  ctx.next(); // "with"
  ctx.next(); // "ordinality"
  return true;
};

// `ROWS FROM (f(…), …) [WITH ORDINALITY] [alias clause]`, positioned on `rows`.
function parseRowsFrom(ctx: ParseContext<SqlTokenType>, lateral: boolean): FromItem {
  ctx.next(); // "rows"
  ctx.next(); // "from"
  ctx.next(); // "("
  const calls: Expr[] = [parseFromCall(ctx)];
  while (ctx.eat("punc", ",") !== null) calls.push(parseFromCall(ctx));
  expectClose(ctx);
  const ordinality = eatOrdinality(ctx);
  const { alias, columns } = parseAliasClause(ctx);
  return {
    kind: "rowsFrom",
    calls,
    alias,
    ...(columns !== null && { columns }),
    ...(lateral && { lateral: true }),
    ...(ordinality && { ordinality: true }),
  };
}

// `rows` is unreserved, so it opens ROWS FROM only ahead of `from (` — a table
// named `rows` is never followed by the reserved `from`.
const startsRowsFrom = (ctx: ParseContext<SqlTokenType>): boolean => {
  if (!ctx.is("ident", "rows")) return false;
  const from = ctx.peekAhead(1);
  const open = ctx.peekAhead(2);
  return from?.type === "ident" && from.value === "from" && open?.type === "punc" && open.value === "(";
};

// `(query) [alias clause]`, positioned on the `(` — a FROM subquery, LATERAL
// or not.
function parseParenSubquery(ctx: ParseContext<SqlTokenType>, lateral: boolean): FromItem {
  ctx.next(); // "("
  const q = ctx.parse(query);
  expectClose(ctx);
  const { alias, columns } = parseAliasClause(ctx);
  return { kind: "subquery", query: q, alias, ...(columns !== null && { columns }), ...(lateral && { lateral: true }) };
}

const QUERY_WORDS: ReadonlySet<string> = new Set(["select", "with", "values"]);
// The reserved words a FROM item can open with.
const FROM_LEAD_WORDS: ReadonlySet<string> = new Set(["lateral", "only"]);
// The words that continue a parenthesised query in PG — set-ops and the
// trailing clauses of `select_with_parens`. All reserved, so never an alias.
const QUERY_TAIL_WORDS: ReadonlySet<string> = new Set([
  "union",
  "intersect",
  "except",
  "order",
  "limit",
  "offset",
  "fetch",
  "for",
]);

const isPuncToken = (tok: Token<SqlTokenType> | null, value: string): boolean =>
  tok?.type === "punc" && tok.value === value;

// Whether a run of `depth` `(` ahead of a query word opens a query (see
// parenFromItem). A level whose `)` never arrives before the statement's `;`
// reads as a query, keeping the query reading's error.
function parenRunIsQuery(ctx: ParseContext<SqlTokenType>, depth: number): boolean {
  const closeAt: number[] = [];
  const open: number[] = [];
  for (let i = 0, tok = ctx.peekAhead(0); tok !== null; tok = ctx.peekAhead(++i)) {
    if (isPuncToken(tok, ";")) break;
    if (isPuncToken(tok, "(")) open.push(i);
    else if (isPuncToken(tok, ")")) {
      const at = open.pop();
      if (at === undefined) break;
      if (at < depth) closeAt[at] = i;
      if (at === 0) break;
    }
  }
  if (closeAt[0] === undefined) return true;
  for (let level = depth - 1; level >= 1; level--) {
    const close = closeAt[level];
    if (close === undefined) return true;
    const after = ctx.peekAhead(close + 1);
    if (after !== null && !isPuncToken(after, ")") && !(after.type === "ident" && QUERY_TAIL_WORDS.has(after.value))) {
      return false;
    }
  }
  return true;
}

// A `(` in FROM opens either a subquery or a parenthesised join, and a run of
// them can stack either way: `((SELECT 1) UNION (SELECT 2)) x` is a subquery,
// `((SELECT 1) s JOIN t ON …)` a join. So the dispatch scans past the run: with
// no query word (select/with/values, all reserved) after it, only a join can
// follow. With one, the innermost group is a query, and each enclosing group is
// one too only while the group it holds is a query followed by `)`, a set-op
// word or a trailing query clause — anything else there follows a FROM item,
// which makes it and every group around it a join. One bracket-matching pass
// finds each level's closing `)`. A token scan rather than a tryParse, which
// would re-read every nested level on the fallback (exponential in the nesting)
// and leave its failures behind for preferFarthest to report. A run ahead of a
// token that starts neither a query nor a FROM item — not a name, or a reserved
// word other than `lateral`/`only` — goes to the query reading, for its error.
function parenFromItem(ctx: ParseContext<SqlTokenType>): FromItem {
  let depth = 1;
  while (isPuncToken(ctx.peekAhead(depth), "(")) depth++;
  const word = ctx.peekAhead(depth);
  if (word?.type === "ident" && QUERY_WORDS.has(word.value)) {
    if (depth === 1 || parenRunIsQuery(ctx, depth)) return parseParenSubquery(ctx, false);
  } else if (
    word === null ||
    (word.type !== "qident" &&
      (word.type !== "ident" || (RESERVED.has(word.value) && !FROM_LEAD_WORDS.has(word.value))))
  ) {
    return parseParenSubquery(ctx, false);
  }
  ctx.next(); // "("
  const inner = ctx.parse(joinTail);
  // PG's `joined_table`: the parentheses must hold a join, and one that is not
  // itself aliased — `((a JOIN b) x)` is rejected, as PG rejects it.
  if (inner.kind !== "join") ctx.croak(`Expected a join but found ${describeFound(ctx.peek())}`);
  if (inner.alias !== undefined) {
    ctx.croak(`Expected a join without an alias but found ${describeFound(ctx.peek())}`);
  }
  expectClose(ctx);
  const { alias, columns } = parseAliasClause(ctx);
  if (alias === null) return inner;
  return { ...inner, alias, ...(columns !== null && { columns }) };
}

// A single FROM entry: a (LATERAL) subquery, a (LATERAL) table function or ROWS
// FROM, a parenthesised join, or a table name — optionally ONLY — with an
// optional TABLESAMPLE. A leading `(` is a subquery or a parenthesised join (see
// parenFromItem); after a dotted name, a `(` opens a table-function call.
// `lateral` and `only` are reserved, so a preceding table never eats either as
// an alias. ONLY takes only a table name, bare or parenthesised (`ONLY (t)`) —
// PG's `relation_expr` — so a `(` right after the word is that name's
// parenthesis, never a subquery, and no call parenthesis is read after the
// name. LATERAL takes no parenthesised join, so its `(` is always a subquery.
// The `only`/`columns`/`lateral`/`tablesample`/`ordinality` keys are omitted
// when absent so ordinary items keep their prior shape.
const tableRef = custom<FromItem, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    const lateral = ctx.eat("ident", "lateral") !== null;
    const only = !lateral && ctx.eat("ident", "only") !== null;
    if (only) {
      const parenthesised = ctx.eat("punc", "(") !== null;
      const nameParts = ctx.parse(qualName);
      if (parenthesised) expectClose(ctx);
      return tableTail(ctx, nameParts, true);
    }
    if (ctx.is("punc", "(")) {
      return lateral ? parseParenSubquery(ctx, true) : parenFromItem(ctx);
    }
    if (startsRowsFrom(ctx)) return parseRowsFrom(ctx, lateral);
    const nameParts = ctx.parse(qualName);
    if (ctx.is("punc", "(")) {
      const call = parseFromCallArgs(ctx, nameParts, start);
      const ordinality = eatOrdinality(ctx);
      const { alias, columns } = parseAliasClause(ctx);
      return {
        kind: "function",
        call,
        alias,
        ...(columns !== null && { columns }),
        ...(lateral && { lateral: true }),
        ...(ordinality && { ordinality: true }),
      };
    }
    if (lateral) {
      return ctx.croak(`Expected a subquery or function after "lateral" but found ${describeFound(ctx.peek())}`);
    }
    return tableTail(ctx, nameParts, false);
  },
  {
    expected: "a table reference",
    first: [{ type: "punc", value: "(" }, { type: "ident" }, { type: "qident" }],
  },
);

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

// None of the TEMP_SCOPE_WORDS / TABLE_STORAGE_WORDS is reserved, so after INTO
// one counts as a modifier only when the token past it can still start the
// target: an unreserved name, a quoted one, or the reserved `table` noise word.
const startsIntoTarget = (tok: Token<SqlTokenType> | null): boolean =>
  tok !== null &&
  (tok.type === "qident" || (tok.type === "ident" && (!RESERVED.has(tok.value) || tok.value === "table")));

// `INTO [[GLOBAL | LOCAL] {TEMP | TEMPORARY} | UNLOGGED] [TABLE] target` — SELECT
// INTO, which writes the result rows into a new table. It sits between the
// select list and FROM, where `into`'s own reservation is what stops `asAlias`
// from reading it as the last column's alias.
//
// The two shapes are taken whole rather than in a loop, so the clause accepts
// exactly what `OptTempTableName` does: `INTO GLOBAL t` and `INTO TEMP TEMP t`
// are errors here as they are in PG. Since the words double as ordinary names,
// each shape is claimed only when a target still follows it —
// `SELECT a INTO temp FROM t` targets a table called `temp`, and
// `SELECT a INTO temp.t FROM x` reads a schema called `temp`.
const intoClause = custom<SelectInto, SqlTokenType>(
  (ctx) => {
    ctx.parse(kw("into"));
    const modifiers: string[] = [];
    const head = ctx.peek();
    const second = ctx.peekAhead(1);
    if (
      head?.type === "ident" &&
      second?.type === "ident" &&
      TEMP_SCOPE_WORDS.has(head.value) &&
      TEMP_WORDS.has(second.value) &&
      startsIntoTarget(ctx.peekAhead(2))
    ) {
      modifiers.push(head.value, second.value);
      ctx.next(); // global / local
      ctx.next(); // temp / temporary
    } else if (head?.type === "ident" && TABLE_STORAGE_WORDS.has(head.value) && startsIntoTarget(second)) {
      modifiers.push(head.value);
      ctx.next(); // the storage word
    }
    ctx.eat("ident", "table"); // the optional noise word
    return { name: ctx.parse(qualName), ...(modifiers.length > 0 && { modifiers }) };
  },
  { expected: '"into"', first: [{ type: "ident", value: "into" }] },
);

const selectCore = seq(
  skip(kw("select")),
  field("distinct", distinctClause),
  field("columns", sepBy(selectItem, P(","))),
  field("into", optional(intoClause)),
  field("from", optional(seq(skip(kw("from")), field("f", fromClause)).map((s) => s.f))),
  field("where", optional(whereClause)),
  field("groupBy", optional(groupByClause)),
  field("having", optional(havingClause)),
  field("window", optional(windowClause)),
  field("orderBy", optional(orderByClause)),
  field("limitOffset", limitOffset),
  field("locking", optional(lockingClause)),
).map(
  (
    { distinct, columns, into, from, where, groupBy, having, window: windowDefs, orderBy, limitOffset: lo, locking },
    span,
  ): SelectStmt => ({
    kind: "select",
    with_: null,
    recursive: false,
    distinct,
    columns,
    ...(into && { into }),
    from: from ?? null,
    where: where ?? null,
    groupBy: groupBy?.items ?? null,
    ...(groupBy?.distinct && { groupByDistinct: true }),
    having: having ?? null,
    window: windowDefs ?? null,
    orderBy: orderBy ?? null,
    limit: lo.limit,
    offset: lo.offset,
    locking: locking ?? null,
    span,
  }),
);

// A CTE body is a full query or a data-modifying statement. Dispatch on the
// leading keyword (INSERT/UPDATE/DELETE take their dedicated rules); anything
// else — SELECT / VALUES / `(` / a nested WITH — is an ordinary query.
const cteBody = custom<Query | Insert | Update | Delete, SqlTokenType>(
  (ctx) => {
    if (ctx.is("ident", "insert")) return ctx.parse(insertStmt);
    if (ctx.is("ident", "update")) return ctx.parse(updateStmt);
    if (ctx.is("ident", "delete")) return ctx.parse(deleteStmt);
    return ctx.parse(query);
  },
  {
    expected: "a query, INSERT, UPDATE or DELETE",
    first: [
      { type: "ident", value: "insert" },
      { type: "ident", value: "update" },
      { type: "ident", value: "delete" },
      { type: "ident", value: "with" },
      { type: "ident", value: "select" },
      { type: "ident", value: "values" },
      { type: "punc", value: "(" },
    ],
  },
);
// PG's `opt_materialized`, between AS and the body's `(`. Nothing but `(` could
// follow AS before, so neither word takes anything away from a name.
const cteMaterialized = oneOf(
  kw("materialized").map(() => true),
  kwseq("not", "materialized").map(() => false),
);
// The CTE's trailing clauses come after the body's `)`, where only `,` or the
// statement the WITH leads could follow before — and neither `search` nor
// `cycle` begins a statement — so they too are matched by value with no guard.
// The new words (`search`, `depth`, `breadth`, `cycle`) stay ordinary names
// everywhere else; `set` / `to` / `default` / `using` were already reserved.
const cteSearch = seq(
  skip(kw("search")),
  field(
    "order",
    oneOf(kw("depth"), kw("breadth")).map((n) => n.value as "depth" | "breadth"),
  ),
  skip(kwseq("first", "by")),
  field("by", sepBy(nameWord, P(","))),
  skip(kw("set")),
  field("set", nameWord),
).map(({ order, by, set }): CteSearch => ({ order, by, set }));
// The mark values are PG's `AexprConst`: a literal, never an expression. The
// typed-literal forms of AexprConst (`DATE '…'`, `INTERVAL '…'`) are not
// accepted here.
const cycleMarkValue = oneOf(numberLit, stringLit, bitStringLit, hexStringLit, boolLit, nullLit).describe("a constant");
const cteCycle = seq(
  skip(kw("cycle")),
  field("columns", sepBy(nameWord, P(","))),
  skip(kw("set")),
  field("set", nameWord),
  field(
    "mark",
    optional(seq(skip(kw("to")), field("to", cycleMarkValue), skip(kw("default")), field("default", cycleMarkValue))),
  ),
  skip(kw("using")),
  field("using", nameWord),
).map(({ columns, set, mark, using }): CteCycle => ({ columns, set, mark: mark ?? null, using }));
const cte = seq(
  field("name", nameWord),
  field("columns", optional(columnList)),
  skip(kw("as")),
  field("materialized", optional(cteMaterialized)),
  skip(punc("(")),
  field("query", cteBody),
  skip(punc(")")),
  field("search", optional(cteSearch)),
  field("cycle", optional(cteCycle)),
).map(
  ({ name, columns, materialized, query: q, search, cycle }): Cte => ({
    name,
    columns: columns ?? null,
    ...(materialized !== null && { materialized }),
    query: q,
    ...(search && { search }),
    ...(cycle && { cycle }),
  }),
);
const withPrefix = seq(
  skip(kw("with")),
  field(
    "recursive",
    optional(kw("recursive")).map((x) => x !== null),
  ),
  field("ctes", sepBy(cte, P(","))),
).map(({ recursive, ctes }) => ({ recursive, ctes }));

// Attach a parsed WITH prefix to the statement it leads: for a set-op query the
// CTEs bind to the leftmost SELECT; an INSERT/UPDATE/DELETE takes them directly.
// A bare VALUES query has nowhere to hang CTEs, so croak rather than drop them.
const attachWith = (
  ctx: ParseContext<SqlTokenType>,
  node: Query | Insert | Update | Delete,
  w: { recursive: boolean; ctes: Cte[] },
): void => {
  let target: Query | Insert | Update | Delete = node;
  while (target.kind === "setOp") target = target.left;
  if (target.kind === "values") ctx.croak("WITH must attach to a SELECT, INSERT, UPDATE or DELETE");
  target.with_ = w.ctes;
  target.recursive = w.recursive;
};

// `VALUES (…), (…) [ORDER BY …] [LIMIT/OFFSET …]` as a query — a peer of the
// SELECT core. Reuses the same row list as INSERT … VALUES plus the shared
// trailing clauses, so it slots straight into a set-op term or a FROM subquery.
const valuesQuery = seq(
  skip(kw("values")),
  field("rows", sepBy(exprList, P(","))),
  field("orderBy", optional(orderByClause)),
  field("limitOffset", limitOffset),
).map(
  ({ rows, orderBy, limitOffset: lo }, span): ValuesQuery => ({
    kind: "values",
    rows,
    orderBy: orderBy ?? null,
    limit: lo.limit,
    offset: lo.offset,
    span,
  }),
);

// A set-op term: a plain SELECT core, a VALUES query, or a parenthesised query.
const selectTerm: Rule<Query, SqlTokenType> = oneOf(
  selectCore,
  valuesQuery,
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
      { type: "ident", value: "values" },
      { type: "punc", value: "(" },
    ],
  },
);

// A leading WITH attaches to the leftmost SELECT of the set-op tree (see
// attachWith). A VALUES query as the target isn't supported (WITH before VALUES
// is rare), so croak rather than silently drop the CTEs.
const queryRule = custom<Query, SqlTokenType>(
  (ctx) => {
    const w = ctx.is("ident", "with") ? ctx.parse(withPrefix) : null;
    const q = ctx.parse(setOpQuery);
    if (w !== null) attachWith(ctx, q, w);
    return q;
  },
  {
    expected: "a query",
    first: [
      { type: "ident", value: "with" },
      { type: "ident", value: "select" },
      { type: "ident", value: "values" },
      { type: "punc", value: "(" },
    ],
  },
);

// --- INSERT / UPDATE / DELETE ---

// One item of an INSERT VALUES row: an expression or a bare DEFAULT. A local
// row rule rather than `exprList`, whose other consumers must not take DEFAULT.
// `default` is reserved, so the keyword branch never shadows an expression.
const insertValue = oneOf(
  kw("default").map((_, span): DefaultValue => ({ kind: "default", span })),
  expression,
);
const insertValuesRow = delimited(P("("), P(")"), P(","), insertValue, { interleaved: true });
const valuesSource = seq(skip(kw("values")), field("rows", sepBy(insertValuesRow, P(",")))).map(({ rows }) => ({
  kind: "values" as const,
  rows,
}));
// A dedicated dispatch (not oneOf) because `query` now claims `values` in its
// first set too — a bare `VALUES …` is the INSERT-local rows source (no ORDER
// BY / LIMIT tail), everything else (`SELECT …`, `(…)`, `WITH …`) is a query.
const insertSource = custom<Insert["source"], SqlTokenType>(
  (ctx) => (ctx.is("ident", "values") ? ctx.parse(valuesSource) : { kind: "select", query: ctx.parse(query) }),
  {
    expected: '"values" or a query',
    first: [
      { type: "ident", value: "values" },
      { type: "ident", value: "select" },
      { type: "ident", value: "with" },
      { type: "punc", value: "(" },
    ],
  },
);
const insertSourceFirst = insertSource.first();
const defaultValues = kwseq("default", "values").map(() => ({ kind: "defaultValues" as const }));
// `OVERRIDING {SYSTEM | USER} VALUE`. `overriding`, `system` and `value` are
// unreserved and matched by value, here after the optional column list (`user` is
// reserved anyway).
const overridingClause = seq(
  skip(kw("overriding")),
  field("kind", oneOf(kw("system"), kw("user"))),
  skip(kw("value")),
).map(({ kind }) => kind.value as InsertOverriding);

// What follows the target: PG's insert_rest. DEFAULT VALUES stands alone — no
// column list or OVERRIDING may precede it — so it is dispatched up front and
// a `(a) DEFAULT VALUES` fails on `default` where a source was expected. That
// failure, and any other where the source should start, is reported here with
// the insert_rest forms still open at that point (DEFAULT VALUES only up front,
// OVERRIDING until it is read), rather than as the query's narrower message.
const insertColumns = optional(attempt(columnList));
const insertOverriding = optional(overridingClause);
type InsertRest = Pick<Insert, "columns" | "overriding" | "source">;
const insertRest = custom<InsertRest, SqlTokenType>(
  (ctx) => {
    if (ctx.is("ident", "default")) return { columns: null, source: ctx.parse(defaultValues) };
    // A `(` here is a column list unless it opens a parenthesised query source;
    // attempt() rolls the column-list read back when the `(` is really a SELECT.
    const columns = ctx.parse(insertColumns) ?? null;
    const overriding = ctx.parse(insertOverriding) ?? null;
    if (!matchesFirst(ctx.peek(), insertSourceFirst)) {
      const open =
        overriding !== null ? "" : columns === null ? '"default values" or "overriding" or ' : '"overriding" or ';
      return ctx.croak(`Expected ${open}"values" or a query but found ${describeFound(ctx.peek())}`);
    }
    const source = ctx.parse(insertSource);
    return { columns, ...(overriding && { overriding }), source };
  },
  {
    expected: '"default values" or "overriding" or "values" or a query',
    first: [{ type: "ident", value: "default" }, { type: "ident", value: "overriding" }, ...insertSourceFirst],
  },
);

// `ON CONSTRAINT name` names the arbiter constraint in place of a column list.
const conflictConstraint = seq(skip(kwseq("on", "constraint")), field("name", nameWord)).map((s) => s.name);

const onConflict = seq(
  skip(kwseq("on", "conflict")),
  field(
    "target",
    optional(
      oneOf(
        columnList.map((columns) => ({ columns })),
        conflictConstraint.map((name) => ({ name })),
      ),
    ),
  ),
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
).map(
  ({ target, action }): OnConflict => ({
    target: target && "columns" in target ? target.columns : null,
    ...(target && "name" in target && { constraint: target.name }),
    action,
  }),
);

// `INSERT INTO t AS a`: PG requires the AS here (its insert_target notes that
// a bare alias would make `VALUES` a shift/reduce conflict), so no asAlias.
const insertAlias = optional(seq(skip(kw("as")), field("name", nameWord)).map((s) => s.name));

const insertStmt = seq(
  skip(kw("insert")),
  skip(kw("into")),
  field("table", qualName),
  field("alias", insertAlias),
  field("rest", insertRest),
  field("onConflict", optional(onConflict)),
  field("returning", optional(returningClause)),
).map(
  ({ table, alias, rest, onConflict: oc, returning }, span): Insert => ({
    kind: "insert",
    table,
    ...(typeof alias === "string" && { alias }),
    columns: rest.columns,
    ...(rest.overriding && { overriding: rest.overriding }),
    source: rest.source,
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

// A DML statement, optionally led by a WITH prefix: `[WITH …]
// SELECT|VALUES|(…)|INSERT|UPDATE|DELETE`. The CTE list can precede any of these,
// so it must be consumed before dispatch, then attached to the head statement.
// The no-WITH query path goes straight to setOpQuery (queryRule's own WITH
// handling would be redundant here).
const dmlStatement = custom<Stmt, SqlTokenType>(
  (ctx) => {
    const w = ctx.is("ident", "with") ? ctx.parse(withPrefix) : null;
    let node: Query | Insert | Update | Delete;
    if (ctx.is("ident", "insert")) node = ctx.parse(insertStmt);
    else if (ctx.is("ident", "update")) node = ctx.parse(updateStmt);
    else if (ctx.is("ident", "delete")) node = ctx.parse(deleteStmt);
    else node = ctx.parse(setOpQuery);
    if (w !== null) attachWith(ctx, node, w);
    return node;
  },
  {
    expected: "a statement",
    first: [
      { type: "ident", value: "with" },
      { type: "ident", value: "insert" },
      { type: "ident", value: "update" },
      { type: "ident", value: "delete" },
      { type: "ident", value: "select" },
      { type: "ident", value: "values" },
      { type: "punc", value: "(" },
    ],
  },
);

// --- PREPARE / EXECUTE ---
//
// Both lead words stay UNRESERVED, matched by value like the Phase 9 utility
// words. The list rules are local rather than exprList, which accepts the empty
// `()` a function call needs: in PG a written list here must hold at least one item.
const prepareTypes = sepBy(typeRef, P(","));
const executeArgs = sepBy(expression, P(","));
// An optional `( list )`: null when no `(` follows; the list itself is non-empty.
function optParenList<T>(ctx: ParseContext<SqlTokenType>, list: Rule<T[], SqlTokenType>): T[] | null {
  if (!ctx.is("punc", "(")) return null;
  ctx.next(); // "("
  const items = ctx.parse(list);
  expectClose(ctx);
  return items;
}

// PG's PreparableStmt: a query or INSERT/UPDATE/DELETE, each with an optional
// WITH prefix — exactly dmlStatement's first set (PG's MERGE and `TABLE name`
// aside, which sql-lite doesn't parse; PREPARE should take them once it does).
// Checked up front so a DDL or utility body reports what PREPARE accepts rather
// than dmlStatement's generic "a statement" (which CREATE TABLE is).
const PREPARABLE = "a SELECT, VALUES, INSERT, UPDATE or DELETE statement";
const PREPARABLE_FIRST = dmlStatement.first();
const prepareStmt = custom<Stmt, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    ctx.parse(kw("prepare"));
    const name = ctx.parse(nameWord);
    const types = optParenList(ctx, prepareTypes);
    ctx.parse(kw("as"));
    if (!matchesFirst(ctx.peek(), PREPARABLE_FIRST)) {
      return ctx.croak(`Expected ${PREPARABLE} but found ${describeFound(ctx.peek())}`);
    }
    const query = ctx.parse(dmlStatement) as Prepare["query"];
    return { kind: "prepare", name, types, query, span: ctx.spanFrom(start) };
  },
  { expected: '"prepare"', first: [{ type: "ident", value: "prepare" }] },
);

const executeStmt = custom<Stmt, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    ctx.parse(kw("execute"));
    const name = ctx.parse(nameWord);
    const args = optParenList(ctx, executeArgs);
    return { kind: "execute", name, args, span: ctx.spanFrom(start) };
  },
  { expected: '"execute"', first: [{ type: "ident", value: "execute" }] },
);

// --- LOCK and CALL ---
// Both lead words stay UNRESERVED, matched by value, as do the lock-mode words.

// One LOCK target: PG's relation_expr — `[ONLY] name [*]` or `ONLY (name)`.
// `only` and `table` are reserved, so neither can begin a name.
const lockTarget = custom<LockTarget, SqlTokenType>(
  (ctx) => {
    const only = ctx.eat("ident", "only") !== null;
    if (only && ctx.eat("punc", "(") !== null) {
      const name = ctx.parse(qualName);
      expectClose(ctx);
      return { name, only };
    }
    const name = ctx.parse(qualName);
    if (!only) ctx.eat("op", "*");
    return { name, only };
  },
  { expected: '"only" or a name', first: [{ type: "ident", value: "only" }, ...nameWord.first()] },
);

// The mode words share leads (SHARE / SHARE UPDATE EXCLUSIVE / SHARE ROW
// EXCLUSIVE; ROW SHARE / ROW EXCLUSIVE), and phrase() cannot roll back, so the
// ladder is walked by hand. Every branch is decided by the token in hand, so a
// half-written mode (`SHARE ROW MODE`) fails at the word that breaks it.
function parseLockMode(ctx: ParseContext<SqlTokenType>): LockMode {
  const either = (share: LockMode, exclusive: LockMode): LockMode => {
    if (ctx.eat("ident", "share") !== null) return share;
    if (ctx.eat("ident", "exclusive") !== null) return exclusive;
    return ctx.croak(`Expected ${quoteList(["share", "exclusive"])} but found ${describeFound(ctx.peek())}`);
  };
  if (ctx.eat("ident", "access") !== null) return either("accessShare", "accessExclusive");
  if (ctx.eat("ident", "row") !== null) return either("rowShare", "rowExclusive");
  if (ctx.eat("ident", "exclusive") !== null) return "exclusive";
  if (ctx.eat("ident", "share") === null) {
    return ctx.croak(
      `Expected ${quoteList(["access", "row", "share", "exclusive"])} but found ${describeFound(ctx.peek())}`,
    );
  }
  if (ctx.eat("ident", "update") !== null) {
    ctx.parse(kw("exclusive"));
    return "shareUpdateExclusive";
  }
  if (ctx.eat("ident", "row") !== null) {
    ctx.parse(kw("exclusive"));
    return "shareRowExclusive";
  }
  if (!ctx.is("ident", "mode")) {
    return ctx.croak(`Expected ${quoteList(["update", "row", "mode"])} but found ${describeFound(ctx.peek())}`);
  }
  return "share";
}

const lockStmt = custom<Stmt, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    ctx.parse(kw("lock"));
    ctx.eat("ident", "table"); // optional TABLE noise word
    const tables = ctx.parse(sepBy(lockTarget, P(",")));
    let mode: LockMode | null = null;
    if (ctx.eat("ident", "in") !== null) {
      mode = parseLockMode(ctx);
      ctx.parse(kw("mode"));
    }
    const nowait = ctx.eat("ident", "nowait") !== null;
    return { kind: "lock", tables, mode, nowait, span: ctx.spanFrom(start) };
  },
  { expected: '"lock"', first: [{ type: "ident", value: "lock" }] },
);

// CALL's arguments are a FROM call's — functionArg, not expression, so
// `p(a => 1)` takes named arguments — and, as for a call, the list may be empty.
const callStmt = custom<Stmt, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    ctx.parse(kw("call"));
    const name = ctx.parse(qualName);
    const args = parseCallArgList(ctx);
    return { kind: "callProcedure", name, args, span: ctx.spanFrom(start) };
  },
  { expected: '"call"', first: [{ type: "ident", value: "call" }] },
);

// --- cursors: DECLARE / FETCH / MOVE / CLOSE ---
//
// Every lead and option word stays UNRESERVED, matched by value — `fetch`
// aside, which is already reserved (as in PG) for the SELECT clause. The cursor
// name is a plain name, as PG's is, and the body is a full query.

// The cursor options between the name and CURSOR, in any order. A repeated
// option is accepted, as PG's grammar does; a contradictory pair is an error,
// as PG's parse analysis makes it. That analysis's other checks (WITH HOLD,
// SCROLL or INSENSITIVE beside FOR UPDATE/SHARE; a data-modifying CTE in the
// body) are not mirrored.
function cursorOptions(ctx: ParseContext<SqlTokenType>): Pick<DeclareCursor, "binary" | "sensitivity" | "scroll"> {
  let binary = false;
  let sensitivity: DeclareCursor["sensitivity"] = null;
  let scroll: boolean | null = null;
  while (true) {
    const start = ctx.position();
    if (ctx.eat("ident", "binary") !== null) binary = true;
    else if (ctx.is("ident", ["asensitive", "insensitive"])) {
      const word = ctx.next()!.value as "asensitive" | "insensitive";
      if (sensitivity !== null && sensitivity !== word) {
        return ctx.croak("cannot specify both ASENSITIVE and INSENSITIVE", start, ctx.lastEnd());
      }
      sensitivity = word;
    } else if (ctx.is("ident", ["scroll", "no"])) {
      const on = ctx.next()!.value === "scroll";
      if (!on) ctx.parse(kw("scroll"));
      if (scroll !== null && scroll !== on) {
        return ctx.croak("cannot specify both SCROLL and NO SCROLL", start, ctx.lastEnd());
      }
      scroll = on;
    } else return { binary, sensitivity, scroll };
  }
}

const QUERY_FIRST = query.first();
const declareCursorStmt = custom<Stmt, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    ctx.parse(kw("declare"));
    const name = ctx.parse(nameWord);
    const options = cursorOptions(ctx);
    ctx.parse(kw("cursor"));
    let hold: boolean | null = null;
    if (ctx.is("ident", ["with", "without"])) {
      hold = ctx.next()!.value === "with";
      ctx.parse(kw("hold"));
    }
    ctx.parse(kw("for"));
    // Checked up front, as PREPARE's body is, so a non-query body reports what
    // DECLARE accepts rather than setOpQuery's narrower first set (no `with`).
    // PG's `TABLE name` body aside, which sql-lite doesn't parse yet.
    if (!matchesFirst(ctx.peek(), QUERY_FIRST)) {
      return ctx.croak(`Expected a query but found ${describeFound(ctx.peek())}`);
    }
    const body = ctx.parse(query);
    return { kind: "declare", name, ...options, hold, query: body, span: ctx.spanFrom(start) };
  },
  { expected: '"declare"', first: [{ type: "ident", value: "declare" }] },
);

// PG's SignedIconst: an integer constant with an optional sign of its own.
const isSign = (tok: Token<SqlTokenType> | null): boolean =>
  tok !== null && tok.type === "op" && (tok.value === "-" || tok.value === "+");
const startsCount = (ctx: ParseContext<SqlTokenType>): boolean =>
  ctx.is("number") || (isSign(ctx.peek()) && ctx.peekAhead(1)?.type === "number");
function signedCount(ctx: ParseContext<SqlTokenType>): number {
  const sign = isSign(ctx.peek()) ? ctx.next()!.value : null;
  const tok = ctx.peek();
  if (!isIntegerConstant(tok)) return ctx.croak(`Expected an integer count but found ${describeFound(tok)}`);
  const value = Number(ctx.next()!.value);
  return sign === "-" ? -value : value;
}

const DIRECTION_WORDS: ReadonlySet<string> = new Set([
  "next",
  "prior",
  "first",
  "last",
  "absolute",
  "relative",
  "forward",
  "backward",
]);

// The optional direction. Every direction word is also a legal cursor name, so
// one is the direction only when something follows it: `FETCH next;` reads from
// a cursor named `next` (PG's LR parse settles it the same way), while `FETCH
// next FROM c` and `FETCH next c` take the direction. `all` is reserved, so it
// is never the name.
function cursorDirection(ctx: ParseContext<SqlTokenType>): CursorDirection | null {
  if (startsCount(ctx)) return { kind: "count", count: signedCount(ctx) };
  if (ctx.eat("ident", "all") !== null) return { kind: "all" };
  const tok = ctx.peek();
  if (tok?.type !== "ident" || !DIRECTION_WORDS.has(tok.value)) return null;
  const after = ctx.peekAhead(1);
  if (after === null || (after.type === "punc" && after.value === ";")) return null;
  ctx.next();
  switch (tok.value) {
    case "absolute":
    case "relative":
      return { kind: tok.value, count: signedCount(ctx) };
    case "forward":
    case "backward": {
      let count: number | "all" | null = null;
      if (ctx.eat("ident", "all") !== null) count = "all";
      else if (startsCount(ctx)) count = signedCount(ctx);
      return { kind: tok.value, count };
    }
    default:
      return { kind: tok.value as "next" | "prior" | "first" | "last" };
  }
}

// FETCH and MOVE share PG's fetch_args.
const cursorFetchStmt = (lead: "fetch" | "move") =>
  custom<Stmt, SqlTokenType>(
    (ctx) => {
      const start = ctx.position();
      ctx.parse(kw(lead));
      const direction = cursorDirection(ctx);
      ctx.eat("ident", ["from", "in"]); // optional FROM / IN noise word
      const cursor = ctx.parse(nameWord);
      return { kind: lead, direction, cursor, span: ctx.spanFrom(start) };
    },
    { expected: `"${lead}"`, first: [{ type: "ident", value: lead }] },
  );
const fetchStmt = cursorFetchStmt("fetch");
const moveStmt = cursorFetchStmt("move");

const closeStmt = custom<Stmt, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    ctx.parse(kw("close"));
    const name = ctx.eat("ident", "all") !== null ? null : ctx.parse(nameWord);
    return { kind: "close", name, span: ctx.spanFrom(start) };
  },
  { expected: '"close"', first: [{ type: "ident", value: "close" }] },
);

// --- COPY ---
//
// `copy`, `program`, `stdin` and `stdout` stay UNRESERVED, matched by value; so
// do the option names, which relationOptions reads as any word. A `(` straight
// after COPY opens a query (PG has no parenthesised table name here); the query
// goes through dmlStatement, as PREPARE's body does. Only the parenthesised
// option list is taken — PG's pre-9.0 bare-word options (`WITH CSV HEADER`), and
// the bare `WITH` an empty one leaves, are not.

function copyLocation(ctx: ParseContext<SqlTokenType>, direction: "from" | "to"): CopyLocation {
  if (ctx.is("string")) return { kind: "file", path: ctx.parse(strValue) };
  if (ctx.eat("ident", "program") !== null) return { kind: "program", command: ctx.parse(strValue) };
  const client = direction === "from" ? "stdin" : "stdout";
  if (ctx.eat("ident", client) !== null) return { kind: client };
  return ctx.croak(`Expected a file name, "program" or "${client}" but found ${describeFound(ctx.peek())}`);
}

const copyStmt = custom<Stmt, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    ctx.parse(kw("copy"));
    let table: string[] | null = null;
    let columns: string[] | null = null;
    let query: Copy["query"] = null;
    if (ctx.eat("punc", "(") !== null) {
      if (!matchesFirst(ctx.peek(), PREPARABLE_FIRST)) {
        return ctx.croak(`Expected ${PREPARABLE} but found ${describeFound(ctx.peek())}`);
      }
      query = ctx.parse(dmlStatement) as Copy["query"];
      expectClose(ctx);
    } else {
      table = ctx.parse(qualName);
      columns = optParenList(ctx, aliasColumns); // non-empty, as PG's opt_column_list is
    }
    // A query can only be copied out.
    let direction: Copy["direction"] = "to";
    if (query === null && ctx.eat("ident", "from") !== null) direction = "from";
    else if (ctx.eat("ident", "to") === null) {
      const expected = query === null ? '"from" or "to"' : '"to"';
      return ctx.croak(`Expected ${expected} but found ${describeFound(ctx.peek())}`);
    }
    const location = copyLocation(ctx, direction);
    const hasWith = ctx.eat("ident", "with") !== null;
    const options = hasWith || ctx.is("punc", "(") ? ctx.parse(relationOptions) : null;
    const where = direction === "from" && ctx.is("ident", "where") ? ctx.parse(whereClause) : null;
    return { kind: "copy", table, columns, query, direction, location, options, where, span: ctx.spanFrom(start) };
  },
  { expected: '"copy"', first: [{ type: "ident", value: "copy" }] },
);

// First-sets: the DDL and utility rules each dispatch on their own lead keyword;
// dmlStatement owns `with`/`select`/`values`/`(`/`insert`/`update`/`delete`.
//
// Three named groups rather than one flat list, so each family has its own place
// to grow. Nesting is dispatch- and validation-equivalent to the flat form —
// oneOf's first() is a flatMap, and the inner groups catch collisions within a
// family — and the composed `expected` is overridden by describe() anyway.
const ddlStmt = oneOf(createStmt, alterStmt, dropStmt, truncateStmt, commentStmt);
const utilityStmt = oneOf(
  grantStmt,
  transactionStmt,
  sessionStmt,
  doStmt,
  deallocateStmt,
  prepareStmt,
  executeStmt,
  lockStmt,
  callStmt,
  declareCursorStmt,
  fetchStmt,
  moveStmt,
  closeStmt,
  copyStmt,
);
const statementBody = oneOf(ddlStmt, utilityStmt, dmlStatement).describe("a statement");
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
