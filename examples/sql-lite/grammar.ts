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
  makeRule,
  matchesFirst,
  oneOf,
  optional,
  type ParseContext,
  ParseError,
  type Position,
  type PrattDef,
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
import { copyDataError, type SqlTokenType, sqlParseLexer, sqlScriptParseLexer } from "./lexer";

// SQL-lite parses a slice of PostgreSQL DDL — CREATE [TEMP | UNLOGGED] TABLE (incl. TABLE AS,
// LIKE, INHERITS and the WITH / ON COMMIT / TABLESPACE clauses) / INDEX / TYPE
// (enum, composite, RANGE) / [MATERIALIZED] VIEW / SEQUENCE / DOMAIN, ALTER
// TABLE, DROP family, TRUNCATE, COMMENT ON — plus a DML core — SELECT (with
// WITH / DISTINCT / joins / WHERE / GROUP BY / HAVING / ORDER BY / LIMIT /
// OFFSET / UNION-INTERSECT-EXCEPT) and INSERT / UPDATE / DELETE / MERGE with
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
// lead any DML statement (`WITH … INSERT/UPDATE/DELETE/MERGE`), and a CTE body
// may itself be data-modifying (`WITH x AS (DELETE … RETURNING …) …`). MERGE
// takes every PG 17 WHEN form, NOT MATCHED BY SOURCE and RETURNING included.
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

// `setof` and `quoted` are omitted when absent. `setof` is PG's `SETOF type`,
// which its Typename takes wherever a type is written (whether a cast or a
// column can use one is decided after parsing). `quoted` marks a quoted name
// that would be a keyword spelling of a built-in type unquoted (see
// KEYWORD_TYPE_NAMES): `char` is bpchar and `int` is int4, while `"char"` is
// the one-byte internal type and `"int"` is looked up as written. Any other
// name means the same quoted or not, as does every qualified one
// (`pg_catalog.char` is `"char"`), so it carries no flag.
export type ColType = {
  name: string;
  args: number[];
  array: boolean;
  setof?: true;
  quoted?: true;
  span: Span;
};

// A row constructor: the explicit `ROW(…)` (which may be empty, or hold a single
// item) and the implicit `(a, b, …)` (always two items or more — a lone `(a)` is
// just a parenthesised expression). They share a node, but `implicit` (present
// only on the bare spelling) keeps them apart, because PG does not always treat
// them alike: `GROUP BY (a, b)` groups by `a` and `b`, `GROUP BY ROW(a, b)` by
// one composite value. Named on its own so OVERLAPS can require it on both sides.
export type RowExpr = { kind: "row"; items: Expr[]; implicit?: true; span: Span };

// A Unicode normalization form, as NORMALIZE and IS NORMALIZED spell it.
export type NormalForm = "nfc" | "nfd" | "nfkc" | "nfkd";

export type Expr =
  // `raw` is the literal's text (its `_` separators dropped, its sign included
  // where the grammar folds one in), present only when `value` can't stand for
  // it: a whole number beyond `Number.isSafeInteger` (which every double from
  // 2^53 up is, so `1.5e300` has one too), or a value that overflowed to
  // ±Infinity (which JSON would write as `null`). PG keeps every digit of
  // both (as `bigint` or `numeric`); `raw` lets a caller do the same.
  | { kind: "number"; value: number; raw?: string; span: Span }
  | { kind: "string"; value: string; span: Span }
  | { kind: "bool"; value: boolean; span: Span }
  | { kind: "null"; span: Span }
  | { kind: "name"; parts: string[]; span: Span }
  // `distinct`, `all` and `orderBy` are the aggregate modifiers that live inside
  // the argument list (`count(DISTINCT x)`, `count(ALL x)`, `array_agg(a ORDER
  // BY b)`); ALL is the default, so `all` only records that it was written.
  // `variadic` marks a last argument written after VARIADIC (`f(a, VARIADIC
  // arr)`), which passes an array to a variadic parameter as a whole. Each key
  // is omitted entirely on a call that has none of these.
  | {
      kind: "call";
      name: string;
      args: Expr[];
      distinct?: true;
      all?: true;
      variadic?: true;
      orderBy?: OrderItem[];
      span: Span;
    }
  // `name => value` or `name := value` in argument position — PG's named
  // function-call notation, whose two spellings mean the same.
  | { kind: "namedArg"; name: string; value: Expr; span: Span }
  // `opSchema` is present only on the `OPERATOR(schema.op)` spelling: the
  // qualifying names, empty for an unqualified `OPERATOR(op)`.
  | { kind: "unary"; op: string; operand: Expr; opSchema?: string[]; span: Span }
  | { kind: "binary"; op: string; left: Expr; right: Expr; opSchema?: string[]; span: Span }
  | { kind: "cast"; expr: Expr; type: ColType; span: Span }
  | { kind: "is"; expr: Expr; negated: boolean; span: Span }
  // `IS [NOT] DISTINCT FROM x` and `IS [NOT] TRUE/FALSE/UNKNOWN` — companions to
  // the plain `is` node (IS [NOT] NULL), each carrying its own negation flag.
  | { kind: "isDistinct"; expr: Expr; from: Expr; negated: boolean; span: Span }
  | { kind: "isTest"; expr: Expr; test: "true" | "false" | "unknown"; negated: boolean; span: Span }
  // `IS [NOT] [NFC | NFD | NFKC | NFKD] NORMALIZED`; `form` is null when no
  // normal form is written (PG then tests NFC).
  | { kind: "isNormalized"; expr: Expr; form: NormalForm | null; negated: boolean; span: Span }
  // `IS [NOT] DOCUMENT`, the XML test.
  | { kind: "isDocument"; expr: Expr; negated: boolean; span: Span }
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
  // `x <op> ANY|ALL|SOME (array|subquery)` — an operator whose RHS is
  // quantified. `op` is any operator, or `like` / `ilike` / `not like` /
  // `not ilike`; `opSchema` is as on `binary`. `right` is a scalar subquery or a
  // parenthesised array expr (a row only with a second pair of parentheses,
  // `x = ANY ((a, b))`, as in PG).
  | {
      kind: "anyAll";
      op: string;
      quantifier: "any" | "all" | "some";
      left: Expr;
      right: Expr;
      opSchema?: string[];
      span: Span;
    }
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
  // `ARRAY[…]` constructor. `elements` may be empty (`ARRAY[]`). A
  // multidimensional one may spell its inner rows as bare brackets,
  // `ARRAY[[1, 2], [3, 4]]`: each row is an `array` node too, marked `implicit`
  // (present only on that spelling) as it has no ARRAY keyword of its own.
  | { kind: "array"; elements: Expr[]; implicit?: true; span: Span }
  // `ARRAY(SELECT …)` — an array built from a subquery's single column.
  | { kind: "arraySubquery"; query: Query; span: Span }
  // `ROW(…)` and the implicit `(a, b, …)` — see RowExpr.
  | RowExpr
  // `(start, end) OVERLAPS (start, end)` — two periods, each a two-item row
  // constructor (either spelling). PG rejects any other arity at parse time, and
  // so does this grammar.
  | { kind: "overlaps"; left: RowExpr; right: RowExpr; span: Span }
  // Array subscript / slice postfix: `a[i]` (no `upper` key) or `a[lo:hi]`
  // (`upper` present, either bound possibly null for `a[:hi]` / `a[lo:]`).
  | { kind: "subscript"; base: Expr; index: Expr | null; upper?: Expr | null; span: Span }
  // `(row).field` and `(row).*` — a composite value's field, or all of them
  // (`field` null). PG takes these after a parenthesised expression or
  // subquery, and after a column reference's subscript (`a[1].f`); a plain
  // `t.c` stays a dotted `name`, as which of its parts is the column is only
  // known once the tables are. (PG also takes them after a parameter, `$1.f`,
  // which this grammar does not yet.)
  | { kind: "fieldSelect"; expr: Expr; field: string | null; span: Span }
  // `INTERVAL 'literal' [field]` — `fields` is the trailing unit spec (e.g.
  // "day", "hour to minute"), absent when only the literal is given.
  // `precision` is the fractional-seconds precision, written either before the
  // literal (`INTERVAL(3) '1 s'`) or on a trailing SECOND field (`SECOND(3)`,
  // `DAY TO SECOND(3)`), and omitted when none is written.
  | { kind: "interval"; value: string; fields?: string; precision?: number; span: Span }
  // `EXTRACT(field FROM source)` — `field` is the unit keyword/string.
  | { kind: "extract"; field: string; source: Expr; span: Span }
  // `SUBSTRING(value FROM from FOR for_)`; either keyword tail may be null.
  | { kind: "substring"; value: Expr; from: Expr | null; for_: Expr | null; span: Span }
  // `SUBSTRING(value SIMILAR pattern ESCAPE escape)`, the SQL-standard regex form.
  | { kind: "substringSimilar"; value: Expr; pattern: Expr; escape: Expr; span: Span }
  // `NORMALIZE(value, form)`. Without a form it is an ordinary call node.
  | { kind: "normalize"; value: Expr; form: NormalForm; span: Span }
  // `COLLATION FOR (expr)`: the collation of an expression.
  | { kind: "collationFor"; expr: Expr; span: Span }
  // `POSITION(substring IN string)`.
  | { kind: "position"; substring: Expr; string: Expr; span: Span }
  // `TRIM([LEADING|TRAILING|BOTH] [characters] FROM source)`.
  | { kind: "trim"; side: "leading" | "trailing" | "both" | null; characters: Expr | null; source: Expr; span: Span }
  // `x COLLATE collation` — `collation` is the (possibly qualified) collation name.
  | { kind: "collate"; expr: Expr; collation: string[]; span: Span }
  // `x AT TIME ZONE zone`.
  | { kind: "atTimeZone"; expr: Expr; zone: Expr; span: Span }
  // `x AT LOCAL`: x in the session time zone.
  | { kind: "atLocal"; expr: Expr; span: Span }
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
  // --- niladic keyword functions, typed literals and OVERLAY ---
  // `CURRENT_DATE`, `CURRENT_TIMESTAMP(3)`, `USER`, … — the reserved keywords PG
  // evaluates as functions without an argument list (its SQLValueFunction).
  // `precision` is the optional fractional-seconds precision that the four
  // time-valued ones take, omitted when none is written.
  | { kind: "sqlValueFunction"; name: SqlValueFunctionName; precision?: number; span: Span }
  // `DATE '2024-01-01'`, `TIMESTAMP(3) WITH TIME ZONE '…'`, `jsonb '{}'`,
  // `varchar(3) 'abc'` — a string literal prefixed by the type it is read as,
  // which may be any type name. `type` is a typeRef node, so the multi-word
  // spellings and the hoisted precision come out exactly as they do in a cast.
  // INTERVAL keeps its own node: its field spec trails the literal.
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

// The table-level attributes PG reads alongside DEFERRABLE / INITIALLY: `NOT
// VALID` (CHECK and foreign keys) and `NO INHERIT` (CHECK only). Each is
// present only when written.
export type TableConstraintAttrs = ConstraintAttrs & { notValid?: true; noInherit?: true };

// `NULLS [NOT] DISTINCT` on a UNIQUE constraint or index, as written; omitted
// when absent (PG's default, NULLS DISTINCT).
export type NullsTreatment = "distinct" | "not distinct";

// The index parameters of a PRIMARY KEY, UNIQUE or EXCLUDE constraint: `INCLUDE
// (cols)` (table level only), `WITH (storage parameters)` and `USING INDEX
// TABLESPACE name`. Each is omitted when absent.
export type IndexParams = {
  include?: string[];
  options?: Omit<RelationOption, "namespace">[];
  indexTablespace?: string;
};

export type RefAction = "no action" | "restrict" | "cascade" | "set null" | "set default";

// What follows `REFERENCES t [(cols)]`. `onDelete` predates the rest, so it is
// always present (null when absent); `match`, `onUpdate` and `onDeleteColumns`
// (the column list of `ON DELETE SET NULL | SET DEFAULT (cols)`) are omitted
// when absent.
export type ForeignKeyTail = {
  match?: "full" | "partial" | "simple";
  onDelete: RefAction | null;
  onDeleteColumns?: string[];
  onUpdate?: RefAction;
};

// A column constraint that `CONSTRAINT name` may lead; `name` is present only
// when it does.
export type ColConstraintElem = (
  | { kind: "notNull"; span: Span }
  | { kind: "nullable"; span: Span }
  | { kind: "default"; expr: Expr; span: Span }
  | ({ kind: "primaryKey"; span: Span } & Omit<IndexParams, "include"> & ConstraintAttrs)
  | ({ kind: "unique"; nulls?: NullsTreatment; span: Span } & Omit<IndexParams, "include"> & ConstraintAttrs)
  | ({ kind: "references"; table: string[]; columns: string[] | null; span: Span } & ForeignKeyTail & ConstraintAttrs)
  | { kind: "check"; expr: Expr; noInherit?: true; span: Span }
  // `GENERATED {ALWAYS | BY DEFAULT} AS IDENTITY [(sequence options)]`;
  // `options` is present only when the parenthesised list is.
  | { kind: "identity"; generated: "always" | "by default"; options?: SequenceOption[]; span: Span }
  // `GENERATED ALWAYS AS (expr) STORED | VIRTUAL`; `virtual` is present only
  // for VIRTUAL (PG 18).
  | { kind: "generated"; expr: Expr; virtual?: true; span: Span }
) & { name?: string };

export type ColConstraint = ColConstraintElem | { kind: "collate"; collation: string[]; span: Span };

export type ColumnDef = {
  kind: "column";
  name: string;
  dataType: ColType;
  constraints: ColConstraint[];
  span: Span;
};

export type TableConstraint =
  | ({ kind: "primaryKey"; name: string | null; columns: string[]; span: Span } & IndexParams & ConstraintAttrs)
  | ({ kind: "unique"; name: string | null; nulls?: NullsTreatment; columns: string[]; span: Span } & IndexParams &
      ConstraintAttrs)
  // A CHECK can never be deferred, so of the deferral attributes only their
  // defaults (NOT DEFERRABLE, INITIALLY IMMEDIATE) can appear.
  | {
      kind: "check";
      name: string | null;
      expr: Expr;
      deferrable?: false;
      initially?: "immediate";
      notValid?: true;
      noInherit?: true;
      span: Span;
    }
  | ({
      kind: "foreignKey";
      name: string | null;
      columns: string[];
      refTable: string[];
      refColumns: string[] | null;
      span: Span;
    } & ForeignKeyTail &
      Omit<TableConstraintAttrs, "noInherit">)
  | ExcludeConstraint;

// One `element WITH operator` pair of an EXCLUDE constraint. `operator` is the
// operator's text (`=`, `&&`).
export type ExclusionElement = { expr: Expr; operator: string; span: Span };

// `EXCLUDE [USING method] (element WITH operator, …) [INCLUDE (cols)] [WITH
// (params)] [USING INDEX TABLESPACE name] [WHERE (pred)]`. `using` is null when
// PG's default (btree) applies, as on createIndex; the index parameters and
// `where` are omitted when absent.
export type ExcludeConstraint = {
  kind: "exclude";
  name: string | null;
  using: string | null;
  elements: ExclusionElement[];
  where?: Expr;
  span: Span;
} & IndexParams &
  ConstraintAttrs;

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

// `ifExists` and `behavior` on dropColumn, and `collate` and `using` on
// setDataType, are present only when written. A `null` storage, compression,
// statistics target or access method is the DEFAULT keyword.
export type AlterAction =
  | { kind: "addColumn"; ifNotExists: boolean; column: ColumnDef }
  | { kind: "dropColumn"; name: string; ifExists?: true; behavior?: "cascade" | "restrict" }
  | { kind: "addConstraint"; name: string | null; constraint: TableConstraint }
  | { kind: "setDefault"; column: string; expr: Expr }
  | { kind: "dropDefault"; column: string }
  | { kind: "setNotNull"; column: string }
  | { kind: "dropNotNull"; column: string }
  | { kind: "setDataType"; column: string; dataType: ColType; collate?: string[]; using?: Expr }
  | { kind: "setExpression"; column: string; expr: Expr }
  | { kind: "dropExpression"; column: string; ifExists?: true }
  | { kind: "addIdentity"; column: string; generated: "always" | "by default"; options?: SequenceOption[] }
  | { kind: "alterIdentity"; column: string; options: IdentityOption[] }
  | { kind: "dropIdentity"; column: string; ifExists?: true }
  | { kind: "setStatistics"; column: string; value: number | null }
  | { kind: "setStorage"; column: string; storage: "plain" | "external" | "extended" | "main" | null }
  | { kind: "setCompression"; column: string; method: string | null }
  | { kind: "setColumnOptions"; column: string; options: RelationOption[] }
  | { kind: "resetColumnOptions"; column: string; options: RelationOption[] }
  | { kind: "alterConstraint"; name: string; attrs: ConstraintAttrs }
  | { kind: "renameColumn"; from: string; to: string }
  | { kind: "renameConstraint"; from: string; to: string }
  | { kind: "renameTable"; to: string }
  | { kind: "ownerTo"; owner: string }
  | { kind: "replicaIdentity"; mode: "default" | "full" | "nothing" | "usingIndex"; index: string | null }
  | AlterDropConstraint
  | AlterValidateConstraint
  | AlterSetSchema
  | Extract<AlterIndexAction, { kind: "setTablespace" | "setOptions" | "resetOptions" }>
  | { kind: "enableTrigger"; mode: null; trigger: AlterTriggerTarget }
  | { kind: "enableTrigger"; mode: "replica" | "always"; trigger: Extract<AlterTriggerTarget, { kind: "name" }> }
  | { kind: "disableTrigger"; trigger: AlterTriggerTarget }
  | { kind: "attachPartition"; partition: string[]; bound: PartitionBound }
  | { kind: "detachPartition"; partition: string[]; mode: "concurrently" | "finalize" | null }
  | { kind: "clusterOn"; index: string }
  | { kind: "setWithoutCluster" }
  | { kind: "setWithoutOids" }
  | { kind: "setLogged" }
  | { kind: "setUnlogged" }
  | { kind: "setAccessMethod"; method: string | null }
  | { kind: "enableRule"; mode?: "replica" | "always"; rule: string }
  | { kind: "disableRule"; rule: string }
  | { kind: "rowSecurity"; action: "enable" | "disable" | "force" | "noForce" }
  | { kind: "inherit"; parent: string[] }
  | { kind: "noInherit"; parent: string[] }
  | { kind: "of"; type: string[] }
  | { kind: "notOf" };
// One step of an identity column's `ALTER c {SET GENERATED … | SET option |
// RESTART …} …` run: a SET's sequence option, a RESTART (a `restart` option,
// which takes no SET), or the new GENERATED mode. AS, OWNED BY and SEQUENCE
// NAME are refused there.
export type IdentityOption =
  | Exclude<SequenceOption, { kind: "as" | "ownedBy" | "sequenceName" }>
  | { kind: "generated"; generated: "always" | "by default" };
// The trigger an ENABLE / DISABLE TRIGGER names: one by name, or ALL / USER.
export type AlterTriggerTarget = { kind: "all" | "user" } | { kind: "name"; name: string };

// The actions of the ALTER targets other than TABLE. `rename` is the object's
// own (ALTER TABLE's is `renameTable`); a domain's `addConstraint` keeps its name
// inside `constraint`, not beside it as ALTER TABLE's does.
type AlterRenameTo = { kind: "rename"; to: string };
type AlterOwnerTo = Extract<AlterAction, { kind: "ownerTo" }>;
type AlterSetSchema = { kind: "setSchema"; schema: string };
// ALTER TABLE's and ALTER DOMAIN's, the same words and shape on both.
type AlterDropConstraint = {
  kind: "dropConstraint";
  ifExists: boolean;
  name: string;
  behavior: "cascade" | "restrict" | null;
};
type AlterValidateConstraint = { kind: "validateConstraint"; name: string };
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
  | AlterDropConstraint
  | { kind: "renameConstraint"; from: string; to: string }
  | AlterValidateConstraint;
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
// An index's `setStatistics` names its column by position (1-based), as PG's
// ALTER INDEX does; `null` is DEFAULT.
export type AlterIndexAction =
  | AlterRenameTo
  | { kind: "setTablespace"; tablespace: string }
  | { kind: "setOptions"; options: RelationOption[] }
  | { kind: "resetOptions"; options: RelationOption[] }
  | { kind: "attachPartition"; partition: string[] }
  | { kind: "setStatistics"; column: number; value: number | null };
// ALTER FUNCTION's and ALTER SEQUENCE's `options` hold the run of attributes or
// sequence options written in place of a named action, in source order.
export type AlterFunctionAction =
  | AlterRenameTo
  | AlterOwnerTo
  | AlterSetSchema
  | { kind: "options"; options: FunctionOption[] };
export type AlterAggregateAction = AlterRenameTo | AlterOwnerTo | AlterSetSchema;
// The column actions are ALTER TABLE's shapes, the option lists ALTER INDEX's;
// only a materialized view takes setTablespace.
export type AlterViewAction =
  | AlterRenameTo
  | AlterOwnerTo
  | AlterSetSchema
  | Extract<AlterAction, { kind: "renameColumn" | "setDefault" | "dropDefault" }>
  | Extract<AlterIndexAction, { kind: "setOptions" | "resetOptions" | "setTablespace" }>;
export type AlterSequenceAction =
  | AlterRenameTo
  | AlterOwnerTo
  | AlterSetSchema
  | { kind: "options"; options: SequenceOption[] };

// --- Phase 7: more CREATE objects ---

// `CREATE TYPE` in its body shapes, all sharing the `createType` kind and
// discriminated by `form`. The enum form keeps its original `values` payload;
// `base` is the `( definition )` of a base type, and `shell` the bare `CREATE
// TYPE name` that reserves a name for one.
export type CompositeAttr = { name: string; type: ColType };
// A `name = value` option in a `RANGE` type body (`SUBTYPE = float8`, …). `value`
// is the raw (possibly qualified) name / type on the right of the `=`.
export type RangeOption = { name: string; value: string };
export type CreateType =
  | { kind: "createType"; form: "enum"; name: string[]; values: string[]; span: Span }
  | { kind: "createType"; form: "composite"; name: string[]; attributes: CompositeAttr[]; span: Span }
  | { kind: "createType"; form: "range"; name: string[]; options: RangeOption[]; span: Span }
  | { kind: "createType"; form: "base"; name: string[]; definition: DefinitionElem[]; span: Span }
  | { kind: "createType"; form: "shell"; name: string[]; span: Span };

// One value in a definition list (PG's `def_arg`): a type or plain word
// (`int4`, `btree`, `icu`), a word in RESERVED (`true`, `null`, `default`, …,
// kept as written rather than read as a boolean or null), an operator (`<>`, or
// `OPERATOR(pg_catalog.=)` as its dotted name), a number (with `raw` as on the
// number expression), a string, or NONE.
export type DefinitionArg =
  | { kind: "type"; type: ColType }
  | { kind: "keyword"; value: string }
  | { kind: "operator"; name: string[] }
  | { kind: "number"; value: number; raw?: string }
  | { kind: "string"; value: string }
  | { kind: "none" };
// One `name [= value]` element of a parenthesised definition list (PG's
// `def_elem`); `value` is omitted for a bare name (`PASSEDBYVALUE`).
export type DefinitionElem = { name: string; value?: DefinitionArg };

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
  | { kind: "ownedBy"; owner: string[] | null } // null = OWNED BY NONE
  | { kind: "sequenceName"; name: string[] }; // an identity column's SEQUENCE NAME

// A `CREATE DOMAIN` constraint. DEFAULT / COLLATE are never named; NOT NULL /
// NULL / CHECK may carry an optional `CONSTRAINT name`.
export type DomainConstraint =
  | { kind: "notNull"; name: string | null }
  | { kind: "null"; name: string | null }
  | { kind: "check"; name: string | null; expr: Expr }
  | { kind: "default"; expr: Expr }
  | { kind: "collate"; collation: string[] };

// `CREATE [OR REPLACE] [MATERIALIZED] VIEW [IF NOT EXISTS] name [(cols)] [WITH
// (option, …)] AS query [WITH [NO] DATA | WITH [CASCADED | LOCAL] CHECK OPTION]`.
// `withData` is materialized-only (`null` otherwise / when the clause is absent);
// `ifNotExists` is materialized-only in PG but stored uniformly. `options` (a
// view's `security_barrier`, a materialized view's storage parameters) and the
// plain-view-only `checkOption` are present only when written; a bare WITH CHECK
// OPTION is CASCADED, as in PG.
export type CreateView = {
  kind: "createView";
  materialized: boolean;
  orReplace: boolean;
  ifNotExists: boolean;
  name: string[];
  columns: string[] | null;
  query: Query;
  withData: boolean | null;
  options?: RelationOption[];
  checkOption?: "cascaded" | "local";
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

// `CREATE {ROLE|USER|GROUP} name [[WITH] option …]`. `user` marks the USER
// spelling, which PG reads as ROLE with LOGIN defaulted on; `group` marks the
// GROUP one, a plain ROLE to PG, and is omitted otherwise.
export type CreateRole = {
  kind: "createRole";
  user: boolean;
  group?: true;
  name: string;
  options: RoleOption[];
  span: Span;
};

// A row-security policy's clauses, as CREATE POLICY and ALTER POLICY share
// them: `TO role, …`, `USING (expr)` and `WITH CHECK (expr)`, each omitted when
// absent. Absent roles are PUBLIC on CREATE POLICY, and left as they were on
// ALTER POLICY.
export type PolicyClauses = { roles?: string[]; using?: Expr; withCheck?: Expr };

// `CREATE POLICY name ON table [AS {PERMISSIVE | RESTRICTIVE}] [FOR command]
// [TO role, …] [USING (expr)] [WITH CHECK (expr)]`. `as` and `command` are
// omitted when absent, which PG reads as PERMISSIVE and ALL.
export type CreatePolicy = {
  kind: "createPolicy";
  name: string;
  table: string[];
  as?: "permissive" | "restrictive";
  command?: "all" | "select" | "insert" | "update" | "delete";
  span: Span;
} & PolicyClauses;

// One entry of a publication's object list: `TABLE [ONLY] t [*] [(cols)]
// [WHERE (expr)]`, or `TABLES IN SCHEMA s`, whose `schema` is null for
// CURRENT_SCHEMA. An entry that leaves its lead words off takes the previous
// entry's, as in PG. `only`, `columns` and `where` are omitted when absent; a
// trailing `*` spells the default and is not recorded.
export type PublicationObject =
  | { kind: "table"; name: string[]; only?: true; columns?: string[]; where?: Expr }
  | { kind: "tablesInSchema"; schema: string | null };

// `CREATE PUBLICATION name [FOR ALL TABLES | FOR object, …] [WITH (option, …)]`.
// `allTables`, `objects` and `options` are omitted when absent.
export type CreatePublication = {
  kind: "createPublication";
  name: string;
  allTables?: true;
  objects?: PublicationObject[];
  options?: RelationOption[];
  span: Span;
};

// `CREATE SUBSCRIPTION name CONNECTION 'conninfo' PUBLICATION p, … [WITH
// (option, …)]`; `options` is omitted when absent.
export type CreateSubscription = {
  kind: "createSubscription";
  name: string;
  connection: string;
  publications: string[];
  options?: RelationOption[];
  span: Span;
};

// ALTER PUBLICATION's actions bar RENAME TO and OWNER TO, which build the
// alterObject node, as on the kinds the generic ALTER takes: ADD / SET / DROP
// of an object list, and `SET (option, …)`.
export type AlterPublicationAction =
  | { kind: "add" | "set" | "drop"; objects: PublicationObject[] }
  | { kind: "setOptions"; options: RelationOption[] };

// ALTER SUBSCRIPTION's actions bar RENAME TO and OWNER TO (as above).
// `options` is the trailing `WITH (…)`, omitted when absent; `SET (…)` and
// SKIP take a list of their own, which is not optional.
export type AlterSubscriptionAction =
  | { kind: "connection"; connection: string }
  | {
      kind: "setPublication" | "addPublication" | "dropPublication";
      publications: string[];
      options?: RelationOption[];
    }
  | { kind: "refreshPublication"; options?: RelationOption[] }
  | { kind: "enable" | "disable" }
  | { kind: "setOptions" | "skip"; options: RelationOption[] };

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

// One existing object as COMMENT ON, SECURITY LABEL, ALTER EXTENSION ADD / DROP
// and the generic ALTER name it (see OBJECT_KINDS). `objectType` is the folded
// keyword(s): `"text search dictionary"`, `"large object"`, and `"language"`
// with or without PROCEDURAL. `name` is dotted where PG takes a qualified name,
// ends in the symbol for an operator (`["pg_catalog", "+"]`), and is omitted
// for CAST, TRANSFORM and LARGE OBJECT, which other keys name. Those keys belong to
// a few kinds each and are omitted elsewhere:
// - `signature`: an AGGREGATE's, always; a FUNCTION's, PROCEDURE's or
//   ROUTINE's when it writes an argument list;
// - `operands`: an OPERATOR's `(left, right)` types, null where NONE stands;
// - `table`: the `ON table` of a CONSTRAINT, POLICY, RULE or TRIGGER;
// - `domain`: the `ON DOMAIN d` of a domain's CONSTRAINT, in place of `table`;
// - `using`: an OPERATOR CLASS's or FAMILY's index access method;
// - `source` and `target`: a CAST's two types;
// - `type` and `language`: a TRANSFORM's;
// - `oid`: a LARGE OBJECT's number.
export type ObjectRef = {
  objectType: string;
  name?: string[];
  signature?: DropSignature;
  operands?: [ColType | null, ColType | null];
  table?: string[];
  domain?: string[];
  using?: string;
  source?: ColType;
  target?: ColType;
  type?: ColType;
  language?: string;
  oid?: number;
};

// ALTER EXTENSION's actions. `add` and `drop` move a member object in or out;
// `version` is omitted from an UPDATE with no `TO`.
export type AlterExtensionAction =
  | { kind: "add" | "drop"; object: ObjectRef }
  | AlterSetSchema
  | { kind: "update"; version?: string };

// The SET / RESET of a role's or database's parameter defaults: SET as the SET
// statement's `name` and `values`, RESET as the RESET statement's `name` ("all"
// for RESET ALL).
export type AlterConfigAction =
  | { kind: "set"; name: string; values: Expr[] | "default" | "fromCurrent" }
  | { kind: "reset"; name: string };
// ALTER ROLE's `options` are CREATE ROLE's, bar the membership ones (IN ROLE,
// ROLE, ADMIN, and the undocumented USER that PG keeps for ALTER GROUP), which
// are not taken; PG lets the run be empty.
export type AlterRoleAction = { kind: "options"; options: RoleOption[] } | AlterRenameTo | AlterConfigAction;
// ALTER DATABASE's `options` are CREATE DATABASE's entries; RENAME TO and
// OWNER TO build the generic `alterObject` node instead.
export type AlterDatabaseAction =
  | { kind: "options"; options: RelationOption[] }
  | Extract<AlterIndexAction, { kind: "setTablespace" }>
  | { kind: "refreshCollationVersion" }
  | AlterConfigAction;
// ALTER TABLESPACE's; RENAME TO and OWNER TO build `alterObject`, as on ALTER DATABASE.
export type AlterTablespaceAction = Extract<AlterIndexAction, { kind: "setOptions" | "resetOptions" }>;

// `RETURNS [SETOF] type` or `RETURNS TABLE (col type, …)`.
export type FunctionReturns =
  | { kind: "type"; setof: boolean; type: ColType }
  | { kind: "table"; columns: CompositeAttr[] };

// A `SET config = value` value: an ordered value list, `DEFAULT`, or `FROM CURRENT`.
export type FunctionSetValue = { kind: "list"; values: Expr[] } | { kind: "default" } | { kind: "fromCurrent" };

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

// --- long-tail objects: casts, collations, operators, text search, … ---

// `CREATE CAST (source AS target) {WITH FUNCTION f[(args)] | WITHOUT FUNCTION |
// WITH INOUT} [AS ASSIGNMENT | AS IMPLICIT]`. `function` is present only for
// the `function` method, its `signature` only when an argument list is written;
// `context` is omitted for an explicit-only cast.
export type CreateCast = {
  kind: "createCast";
  source: ColType;
  target: ColType;
  method: "function" | "withoutFunction" | "inout";
  function?: { name: string[]; signature?: DropSignature };
  context?: "assignment" | "implicit";
  span: Span;
};

// `CREATE COLLATION [IF NOT EXISTS] name {( definition ) | FROM existing}`;
// exactly one of `definition` and `from` is present.
export type CreateCollation = {
  kind: "createCollation";
  ifNotExists: boolean;
  name: string[];
  definition?: DefinitionElem[];
  from?: string[];
  span: Span;
};

// `CREATE [DEFAULT] CONVERSION name FOR 'source' TO 'target' FROM function`.
export type CreateConversion = {
  kind: "createConversion";
  default?: true;
  name: string[];
  source: string;
  target: string;
  function: string[];
  span: Span;
};

// `CREATE STATISTICS [IF NOT EXISTS] [name] [(kind, …)] ON item, … FROM t, …`.
// Each `on` item is a column name, a function call or a parenthesised
// expression, as PG's grammar allows; `name` and `kinds` are omitted when absent.
export type CreateStatistics = {
  kind: "createStatistics";
  ifNotExists: boolean;
  name?: string[];
  kinds?: string[];
  on: Expr[];
  from: string[][];
  span: Span;
};

// `CREATE EVENT TRIGGER name ON event [WHEN var IN ('v', …) [AND …]] EXECUTE
// {FUNCTION | PROCEDURE} f()`; `when` is omitted when absent.
export type CreateEventTrigger = {
  kind: "createEventTrigger";
  name: string;
  event: string;
  when?: { variable: string; values: string[] }[];
  execute: { routine: "function" | "procedure"; name: string[] };
  span: Span;
};

// `CREATE [OR REPLACE] [TRUSTED] [PROCEDURAL] LANGUAGE name [HANDLER h [INLINE
// i] [VALIDATOR v | NO VALIDATOR]]`. The flags and handlers are omitted when
// not written; `validator` is null for NO VALIDATOR.
export type CreateLanguage = {
  kind: "createLanguage";
  orReplace: boolean;
  trusted?: true;
  procedural?: true;
  name: string;
  handler?: string[];
  inline?: string[];
  validator?: string[] | null;
  span: Span;
};

// `CREATE ACCESS METHOD name TYPE {TABLE | INDEX} HANDLER handler`.
export type CreateAccessMethod = {
  kind: "createAccessMethod";
  name: string;
  type: "table" | "index";
  handler: string[];
  span: Span;
};

// `CREATE TEXT SEARCH {PARSER | DICTIONARY | TEMPLATE | CONFIGURATION} name (
// definition )`.
export type CreateTextSearch = {
  kind: "createTextSearch";
  objectType: "parser" | "dictionary" | "template" | "configuration";
  name: string[];
  definition: DefinitionElem[];
  span: Span;
};

// `CREATE OPERATOR [schema.]op ( definition )`; `name` ends in the symbol.
export type CreateOperator = { kind: "createOperator"; name: string[]; definition: DefinitionElem[]; span: Span };

// One item of an operator class's `AS` list. An OPERATOR's `operands` are
// present when written, null where NONE stands; `purpose` is omitted when no
// FOR clause is written (PG's default, FOR SEARCH). A FUNCTION's `types` are
// the optional `(left, right)` before its name, and its `signature` is present
// when written.
export type OpClassItem =
  | {
      kind: "operator";
      strategy: number;
      operator: string[];
      operands?: [ColType | null, ColType | null];
      purpose?: { kind: "search" } | { kind: "orderBy"; family: string[] };
    }
  | { kind: "function"; support: number; types?: ColType[]; name: string[]; signature?: DropSignature }
  | { kind: "storage"; type: ColType };

// `CREATE OPERATOR CLASS name [DEFAULT] FOR TYPE type USING method [FAMILY f]
// AS item, …`; `default` and `family` are omitted when absent.
export type CreateOperatorClass = {
  kind: "createOperatorClass";
  name: string[];
  default?: true;
  type: ColType;
  using: string;
  family?: string[];
  items: OpClassItem[];
  span: Span;
};

// `CREATE OPERATOR FAMILY name USING method`.
export type CreateOperatorFamily = { kind: "createOperatorFamily"; name: string[]; using: string; span: Span };

// --- Phase 9: DCL / TCL / session ---

// A single privilege in GRANT/REVOKE: a keyword like SELECT/INSERT/USAGE with an
// optional column list (`UPDATE (a, b)`), or the two-word `"alter system"`. For a
// role grant the same shape carries the granted role name (columns null).
export type Privilege = { name: string; columns: string[] | null };

// The `ON objectType name[, …]` target of an object-privilege grant. `objectType`
// is the folded object keyword(s) (default "table"; `"foreign data wrapper"`,
// `"foreign server"`, `"large object"`); `names` lists the objects — or is empty
// for the `ALL {TABLES|SEQUENCES|FUNCTIONS|PROCEDURES|ROUTINES} IN SCHEMA s[, …]`
// form, whose schemas live in `inSchema` (null otherwise), and for a LARGE
// OBJECT, whose numbers live in `oids`. Two keys belong to a few kinds each and
// are omitted elsewhere:
// - `signatures` (FUNCTION / PROCEDURE / ROUTINE): one entry per name, null
//   where a name carries no argument list, present when one does;
// - `oids` (LARGE OBJECT): the objects' numbers.
export type GrantObject = {
  objectType: string;
  names: string[][];
  inSchema: string[][] | null;
  signatures?: (DropSignature | null)[];
  oids?: number[];
};

// One entry of a role grant's `WITH` list: `ADMIN`, `INHERIT` or `SET`, each
// `OPTION` / `TRUE` (true) or `FALSE`.
export type RoleGrantOption = { name: "admin" | "inherit" | "set"; value: boolean };

// `GRANT { privilege[, …] | ALL [PRIVILEGES] [(col, …)] } ON … TO grantee[, …]
// [WITH GRANT OPTION] [GRANTED BY role]`, or the role form `GRANT role[, …] TO
// role[, …] [WITH option[, …]] [GRANTED BY role]`. `on` is null for a role
// grant; then `privileges` carries the granted role names (each with columns
// null). `"all"` = ALL PRIVILEGES, and `allColumns` its column list, omitted
// when none is written. `withGrantOption` is WITH GRANT OPTION on an object, and
// on a role whether the WITH list grants ADMIN. `options` is that list, omitted
// when it is a lone `ADMIN OPTION` / `ADMIN TRUE` (or absent); `grantedBy` is
// omitted when absent.
export type Grant = {
  kind: "grant";
  privileges: Privilege[] | "all";
  allColumns?: string[];
  on: GrantObject | null;
  grantees: string[];
  withGrantOption: boolean;
  options?: RoleGrantOption[];
  grantedBy?: string;
  span: Span;
};

// `REVOKE [GRANT OPTION FOR] … ON … FROM …` or the role form `REVOKE [{ADMIN |
// INHERIT | SET} OPTION FOR] role[, …] FROM …`, then `[GRANTED BY role]
// [CASCADE | RESTRICT]`. `grantOptionFor` marks GRANT / ADMIN OPTION FOR;
// `option` names INHERIT or SET OPTION FOR and is omitted otherwise.
export type Revoke = {
  kind: "revoke";
  grantOptionFor: boolean; // GRANT OPTION FOR / ADMIN OPTION FOR
  option?: "inherit" | "set";
  privileges: Privilege[] | "all";
  allColumns?: string[];
  on: GrantObject | null;
  grantees: string[];
  grantedBy?: string;
  behavior: "cascade" | "restrict" | null;
  span: Span;
};

// One `FOR {ROLE | USER} role[, …]` or `IN SCHEMA schema[, …]` clause of ALTER
// DEFAULT PRIVILEGES, in the order written (PG lets each appear more than once
// and only refuses that at execution).
export type DefaultPrivilegesOption = { kind: "forRole"; roles: string[] } | { kind: "inSchema"; schemas: string[] };

// The GRANT or REVOKE an ALTER DEFAULT PRIVILEGES applies: a `grant` / `revoke`
// node's fields bar GRANTED BY, which PG takes none of here, and a role grant's
// options; in place of `on`, `objectType` is the singular of TABLES / SEQUENCES
// / FUNCTIONS / ROUTINES / TYPES / SCHEMAS.
export type DefaultPrivilegesAction =
  | (Omit<Grant, "on" | "options" | "grantedBy" | "span"> & { objectType: string })
  | (Omit<Revoke, "on" | "option" | "grantedBy" | "span"> & { objectType: string });

// `ALTER DEFAULT PRIVILEGES [option …] {GRANT | REVOKE} … ON {TABLES | …} …`.
export type AlterDefaultPrivileges = {
  kind: "alterDefaultPrivileges";
  options: DefaultPrivilegesOption[];
  action: DefaultPrivilegesAction;
  span: Span;
};

// `DROP OWNED BY role[, …] [CASCADE | RESTRICT]` and `REASSIGN OWNED BY role[,
// …] TO role`.
export type DropOwned = { kind: "dropOwned"; roles: string[]; behavior: "cascade" | "restrict" | null; span: Span };
export type ReassignOwned = { kind: "reassignOwned"; roles: string[]; newRole: string; span: Span };

export type TransactionMode =
  | { kind: "isolation"; level: "serializable" | "repeatableRead" | "readCommitted" | "readUncommitted" }
  | { kind: "readWrite"; value: boolean } // true = READ WRITE, false = READ ONLY
  | { kind: "deferrable"; value: boolean }; // true = DEFERRABLE, false = NOT DEFERRABLE

// BEGIN / START TRANSACTION / COMMIT / ROLLBACK / SAVEPOINT / RELEASE SAVEPOINT.
// END is COMMIT and ABORT is ROLLBACK (without TO SAVEPOINT), as in PG, so each
// gives the node of the word it stands for. The two-phase forms carry the
// transaction's string identifier: `PREPARE TRANSACTION 'gid'`, `COMMIT
// PREPARED 'gid'` and `ROLLBACK PREPARED 'gid'`.
export type Transaction =
  | { kind: "begin"; start: boolean; modes: TransactionMode[]; span: Span } // start = `START TRANSACTION`
  | { kind: "commit"; chain: boolean; span: Span } // chain = AND CHAIN
  | { kind: "rollback"; chain: boolean; savepoint: string | null; span: Span } // savepoint = ROLLBACK TO [SAVEPOINT] name
  | { kind: "savepoint"; name: string; span: Span }
  | { kind: "releaseSavepoint"; name: string; span: Span }
  | { kind: "prepareTransaction" | "commitPrepared" | "rollbackPrepared"; gid: string; span: Span };

// SET [SESSION|LOCAL] { name {=|TO} value[, …] | name FROM CURRENT | TIME ZONE
// value | ROLE|SCHEMA|NAMES|… value | SESSION AUTHORIZATION value }. `name` is
// the dotted config parameter, or the special form's words ("time zone",
// "session authorization", …); `values` is the value list, "default" for the
// DEFAULT keyword (and for `TIME ZONE LOCAL` or a bare `NAMES`, which PG treats
// the same way), or "fromCurrent".
export type SetStmt = {
  kind: "set";
  scope: "session" | "local" | null;
  name: string;
  values: Expr[] | "default" | "fromCurrent";
  span: Span;
};

// `SET [SESSION|LOCAL] TRANSACTION mode[, …]` sets the current transaction's
// characteristics; `SET SESSION CHARACTERISTICS AS TRANSACTION mode[, …]`
// (`characteristics` true) sets the session's defaults. `modes` is never empty.
export type SetTransaction = {
  kind: "setTransaction";
  scope: "session" | "local" | null;
  characteristics: boolean;
  modes: TransactionMode[];
  span: Span;
};

// `SET CONSTRAINTS {ALL | name[, …]} {DEFERRED | IMMEDIATE}`.
export type SetConstraints = {
  kind: "setConstraints";
  constraints: string[][] | "all";
  mode: "deferred" | "immediate";
  span: Span;
};

// SHOW {name | ALL | TIME ZONE | TRANSACTION ISOLATION LEVEL | SESSION
// AUTHORIZATION} — `name` is "all" for SHOW ALL, and the words of a multi-word
// form joined by spaces ("time zone", …).
export type Show = { kind: "show"; name: string; span: Span };
// RESET, with the same targets as SHOW.
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
  query: Preparable;
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
// MERGE, UPDATE, DELETE, TRUNCATE, ALTER TABLE and CREATE INDEX … ON targets
// are read by the same rule (relationExpr).
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
// `variadic` is as on that node: present only when the last argument follows
// VARIADIC.
export type CallProcedure = { kind: "callProcedure"; name: string[]; args: Expr[]; variadic?: true; span: Span };

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

// One `table [(column, …)]` target of ANALYZE or VACUUM — `columns` is null when
// no list is written.
export type MaintenanceTarget = { name: string[]; columns: string[] | null };

// `EXPLAIN [(option, …) | [ANALYZE] [VERBOSE]] statement`. As in PG, the legacy
// keywords are options too: `EXPLAIN ANALYZE VERBOSE q` and `EXPLAIN (ANALYZE,
// VERBOSE) q` both carry two bare options (`value: null`), spelt as written.
// `options` is `[]` when neither form is.
export type Explain = {
  kind: "explain";
  options: RelationOption[];
  statement: Preparable | CreateTableAs | CreateView | DeclareCursor | Execute;
  span: Span;
};
// `ANALYZE [(option, …) | VERBOSE] [target, …]` and `VACUUM [(option, …) |
// [FULL] [FREEZE] [VERBOSE] [ANALYZE]] [target, …]`, with `options` as on
// EXPLAIN. `tables` is `[]` when none is named (the whole database).
export type Analyze = { kind: "analyze"; options: RelationOption[]; tables: MaintenanceTarget[]; span: Span };
export type Vacuum = { kind: "vacuum"; options: RelationOption[]; tables: MaintenanceTarget[]; span: Span };

// `CLUSTER [(option, …) | VERBOSE] [table [USING index]]`, and the pre-8.3
// `CLUSTER [VERBOSE] index ON table`, with `options` as on EXPLAIN. `table` is
// omitted when none is named (every previously clustered table), `index` when
// neither USING nor the old ON form names one.
export type Cluster = { kind: "cluster"; options: RelationOption[]; table?: string[]; index?: string; span: Span };
// `REINDEX [(option, …)] {INDEX | TABLE | SCHEMA | DATABASE | SYSTEM}
// [CONCURRENTLY] name`. The name is qualified for INDEX and TABLE, a single
// part otherwise, and may be left off (omitted) for DATABASE and SYSTEM, which
// then mean the current database. `concurrently` is present only when written.
export type Reindex = {
  kind: "reindex";
  options: RelationOption[];
  target: "index" | "table" | "schema" | "database" | "system";
  concurrently?: true;
  name?: string[];
  span: Span;
};
// CHECKPOINT; LOAD 'file'; DISCARD {ALL | PLANS | SEQUENCES | TEMP |
// TEMPORARY}, the two spellings of the last both "temp".
export type Checkpoint = { kind: "checkpoint"; span: Span };
export type Load = { kind: "load"; file: string; span: Span };
export type Discard = { kind: "discard"; target: "all" | "plans" | "sequences" | "temp"; span: Span };
// LISTEN channel; NOTIFY channel [, 'payload'] (`payload` present only when
// written); UNLISTEN {channel | *}, `channel` null for `*`.
export type Listen = { kind: "listen"; channel: string; span: Span };
export type Notify = { kind: "notify"; channel: string; payload?: string; span: Span };
export type Unlisten = { kind: "unlisten"; channel: string | null; span: Span };

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
//
// `data` is set by `sqlLiteScript` alone, on a `FROM STDIN` copy whose rows
// follow it in the script: the lines up to the `\.` terminator, verbatim and
// undecoded. The span stays the statement's own; it doesn't cover the rows.
export type Copy = {
  kind: "copy";
  table: string[] | null;
  columns: string[] | null;
  query: Preparable | null;
  direction: "from" | "to";
  location: CopyLocation;
  options: RelationOption[] | null;
  where: Expr | null;
  data?: string;
  span: Span;
};

// A psql meta-command line in a script (`\connect db`, `\restrict key`), as
// `sqlLiteScript` returns it. `command` is the name without its backslash, up
// to the first space or backslash as psql reads it (`connect`, `.`, `dt+`);
// `args` is the rest of the line, trimmed and unparsed — psql's own argument
// syntax (quoting, `:var` interpolation, backticks) is not modelled.
export type PsqlMeta = {
  kind: "psqlMeta";
  command: string;
  args: string;
  span: Span;
};

/** What `sqlLiteScript` returns, in source order. */
export type ScriptItem = Stmt | PsqlMeta;

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
  // `options` (WITH (…)), `only` (ON ONLY t), `nulls` (NULLS [NOT] DISTINCT) and
  // `tablespace` are present only when written; the older `include` and `where`
  // keys stay null when absent.
  | {
      kind: "createIndex";
      unique: boolean;
      concurrently: boolean;
      ifNotExists: boolean;
      name: string | null;
      table: string[];
      only?: true;
      using: string | null;
      columns: IndexColumn[];
      include: string[] | null;
      nulls?: NullsTreatment;
      options?: RelationOption[];
      tablespace?: string;
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
  | CreatePolicy
  | CreatePublication
  | CreateSubscription
  | CreateTableAs
  | CreateFunction
  | CreateProcedure
  | CreateAggregate
  | CreateTrigger
  | CreateCast
  | CreateCollation
  | CreateConversion
  | CreateStatistics
  | CreateEventTrigger
  | CreateLanguage
  | CreateAccessMethod
  | CreateTextSearch
  | CreateOperator
  | CreateOperatorClass
  | CreateOperatorFamily
  // `REFRESH MATERIALIZED VIEW [CONCURRENTLY] name [WITH [NO] DATA]`; `withData`
  // is null when the clause is absent, as on createView.
  | { kind: "refreshMaterializedView"; concurrently: boolean; name: string[]; withData: boolean | null; span: Span }
  // `ALTER TABLE [IF EXISTS] [ONLY] name [*] action[, …]`. `actions` is never
  // empty, and a RENAME is always its only element — PG keeps those out of the
  // action list. `only` is present only when ONLY is written.
  | { kind: "alterTable"; ifExists: boolean; name: string[]; only?: true; actions: AlterAction[]; span: Span }
  | { kind: "alterSchema"; name: string; action: AlterSchemaAction; span: Span }
  | { kind: "alterDomain"; name: string[]; action: AlterDomainAction; span: Span }
  | { kind: "alterType"; name: string[]; action: AlterTypeAction; span: Span }
  // As on alterTable, `actions` is never empty and a RENAME or ATTACH PARTITION stands alone.
  | { kind: "alterIndex"; ifExists: boolean; name: string[]; actions: AlterIndexAction[]; span: Span }
  // `ALTER {TABLE | INDEX | MATERIALIZED VIEW} ALL IN TABLESPACE from [OWNED BY
  // role, …] SET TABLESPACE to [NOWAIT]`. `ownedBy` and `nowait` are present
  // only when written.
  | {
      kind: "alterAllInTablespace";
      objectType: "table" | "index" | "materialized view";
      tablespace: string;
      ownedBy?: string[];
      newTablespace: string;
      nowait?: true;
      span: Span;
    }
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
  | { kind: "alterExtension"; name: string; action: AlterExtensionAction; span: Span }
  // `ALTER {ROLE | USER} role …`; `user` marks the USER spelling. `name` is null
  // for ALL, which only SET and RESET take, and `database` is the IN DATABASE
  // they may scope to, omitted when absent.
  | {
      kind: "alterRole";
      user: boolean;
      name: string | null;
      database?: string;
      action: AlterRoleAction;
      span: Span;
    }
  | { kind: "alterDatabase"; name: string; action: AlterDatabaseAction; span: Span }
  | { kind: "alterTablespace"; name: string; action: AlterTablespaceAction; span: Span }
  // `ALTER POLICY name ON table [TO role, …] [USING (expr)] [WITH CHECK (expr)]`;
  // PG's grammar takes all three clauses as optional, so none may be written.
  // `ALTER POLICY … RENAME TO` is an alterObject node, as TRIGGER's is.
  | ({ kind: "alterPolicy"; name: string; table: string[]; span: Span } & PolicyClauses)
  | { kind: "alterPublication"; name: string; action: AlterPublicationAction; span: Span }
  | { kind: "alterSubscription"; name: string; action: AlterSubscriptionAction; span: Span }
  // `ALTER kind object {RENAME TO | OWNER TO | SET SCHEMA} …` for the object
  // kinds with no ALTER target of their own; which of the three a kind takes
  // follows PG (OBJECT_KINDS). The ALTER targets of POLICY, PUBLICATION and
  // SUBSCRIPTION build it for RENAME TO, and PUBLICATION's and SUBSCRIPTION's
  // for OWNER TO too. `ifExists` is
  // ALTER POLICY IF EXISTS … RENAME's, and omitted elsewhere.
  | {
      kind: "alterObject";
      ifExists?: true;
      object: ObjectRef;
      action: AlterRenameTo | AlterOwnerTo | AlterSetSchema;
      span: Span;
    }
  // Generalized DROP: `DROP <object> [CONCURRENTLY] [IF EXISTS] name[, …]
  // [CASCADE|RESTRICT]`. `objectType` is the folded keyword (`"materialized
  // view"` for the two-word one); `behavior` is the trailing CASCADE/RESTRICT
  // (null when absent, and always null where PG takes none: DATABASE, ROLE,
  // USER, TABLESPACE). CONCURRENTLY is only accepted on the original six object kinds.
  // The remaining keys belong to one object kind each and are omitted elsewhere:
  // - `signatures` (FUNCTION / PROCEDURE / AGGREGATE): one entry per name, null
  //   where a function or procedure name carries no argument list;
  // - `table` (TRIGGER, POLICY): the `ON table` the object belongs to;
  // - `force` (DATABASE): present, as true, only when `(FORCE)` is written;
  // - `operands` (OPERATOR): one `(left, right)` pair per name, null where NONE
  //   stands;
  // - `using` (OPERATOR CLASS / FAMILY): the index access method;
  // - `source` and `target` (CAST): its two types, with `names` empty.
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
      operands?: [ColType | null, ColType | null][];
      using?: string;
      source?: ColType;
      target?: ColType;
      span: Span;
    }
  // `TRUNCATE [TABLE] {[ONLY] name [*] | ONLY (name)}[, …]
  // [RESTART|CONTINUE IDENTITY] [CASCADE|RESTRICT]`. `only` runs parallel to
  // `names` (true where that table is ONLY) and is present only when some table
  // is; a trailing `*` spells the default and is not recorded.
  | {
      kind: "truncate";
      names: string[][];
      only?: boolean[];
      identity: "restart" | "continue" | null;
      behavior: "cascade" | "restrict" | null;
      span: Span;
    }
  // `COMMENT ON object IS text`; `comment` is null for `IS NULL`.
  | ({ kind: "comment" } & ObjectRef & { comment: string | null; span: Span })
  // `SECURITY LABEL [FOR provider] ON object IS label`; `provider` is omitted
  // when absent, and `label` is null for `IS NULL`.
  | ({ kind: "securityLabel"; provider?: string } & ObjectRef & { label: string | null; span: Span })
  // DCL / TCL / session (Phase 9).
  | Grant
  | Revoke
  | AlterDefaultPrivileges
  | DropOwned
  | ReassignOwned
  | Transaction
  | SetStmt
  | SetTransaction
  | SetConstraints
  | Show
  | Reset
  | Do
  | Deallocate
  | Prepare
  | Execute
  | Explain
  | Analyze
  | Vacuum
  | Cluster
  | Reindex
  | Checkpoint
  | Load
  | Discard
  | Listen
  | Notify
  | Unlisten
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
  | Delete
  | Merge;

// --- DML AST (the `{ kind }` idiom, mutually recursive with Expr via lazy) ---

export type SetOpKind = "union" | "unionAll" | "intersect" | "intersectAll" | "except" | "exceptAll";

// `VALUES (…), (…)` as a query — usable standalone, as a set-op term, and as a
// parenthesised FROM source. Carries the same query-level ORDER BY / LIMIT /
// OFFSET / locking tail a SELECT does when one is written after it. `locking`
// is present only when written: PG's grammar admits it on VALUES and rejects it
// in parse analysis, so it is recorded rather than refused.
export type ValuesQuery = {
  kind: "values";
  rows: Expr[][];
  // A leading WITH (`WITH c AS (…) VALUES …`); present only when one attaches,
  // as on Insert.
  with_?: Cte[];
  recursive?: boolean;
  orderBy: OrderItem[] | null;
  limit: Expr | null;
  // `FETCH … WITH TIES`; present (and true) only when written.
  withTies?: true;
  offset: Expr | null;
  locking?: LockingClause[];
  span: Span;
};

// `left op right`. INTERSECT binds tighter than UNION and EXCEPT, which are
// left-associative among themselves, as in PG. An ORDER BY / LIMIT / OFFSET /
// FETCH / locking tail written after the whole set operation belongs to this
// node, never to the right-hand arm; each tail field is present only when
// written (a `LIMIT ALL` records nothing, as it does on a SELECT).
export type SetOperation = {
  kind: "setOp";
  op: SetOpKind;
  left: Query;
  right: Query;
  // A WITH written over a set operation whose leftmost arm already has one of
  // its own — `WITH a … (WITH b … SELECT 1) UNION SELECT 2`; any other WITH
  // over a set operation goes on its leftmost arm. Present only then.
  with_?: Cte[];
  recursive?: boolean;
  orderBy?: OrderItem[];
  limit?: Expr;
  withTies?: true;
  offset?: Expr;
  locking?: LockingClause[];
  span: Span;
};

// `TABLE name` — PG's shorthand for `SELECT * FROM name`, a query in its own
// right wherever a SELECT may stand: a statement, a set-op arm, a subquery, a
// CTE body or an INSERT source. The name is a `relation_expr`, so it may carry
// ONLY (`only`, present only when written) or the inheritance star, which
// spells the default and records nothing. `with_` / `recursive` are present
// only when a WITH prefix attaches, and each tail field only when written, as
// on SetOperation.
export type TableQuery = {
  kind: "tableCmd";
  name: string[];
  only?: true;
  with_?: Cte[];
  recursive?: boolean;
  orderBy?: OrderItem[];
  limit?: Expr;
  withTies?: true;
  offset?: Expr;
  locking?: LockingClause[];
  span: Span;
};

export type Query = SelectStmt | ValuesQuery | TableQuery | SetOperation;

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
  // Empty for PG's empty target list (`SELECT;`, `SELECT FROM t`), which only
  // a SELECT without DISTINCT may have.
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
  // `FETCH … WITH TIES`; present (and true) only when written.
  withTies?: true;
  offset: Expr | null;
  // Row-locking clauses (`FOR UPDATE …`), before or after LIMIT/OFFSET; null
  // when absent, and for `FOR READ ONLY`, which PG's grammar also reduces to no
  // clause at all.
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

// One `name type [COLLATE collation]` entry of a column definition list — PG's
// `TableFuncElement`, which spells out the result columns of a function
// returning `record` (`f() AS x (a int, b text)`). `collate` is present only
// when written.
export type ColumnDefinition = { name: string; type: ColType; collate?: string[] };

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
  // `columnDefinitions` is present only for a column definition list
  // (`f() AS x (a int)`, `f() AS (a int)`), which takes the place of `columns`.
  | {
      kind: "function";
      call: Expr;
      alias: string | null;
      columns?: string[];
      columnDefinitions?: ColumnDefinition[];
      lateral?: boolean;
      ordinality?: boolean;
    }
  // `ROWS FROM (f(…), g(…))` — several table functions zipped side by side,
  // optionally LATERAL. `calls` are the underlying `call` expression nodes.
  // `callColumnDefinitions` is present only when some call carries its own
  // `AS (col type, …)` list; it runs parallel to `calls`, with null for a call
  // without one. `columnDefinitions` is a list after the whole item, as on a
  // `function` item.
  | {
      kind: "rowsFrom";
      calls: Expr[];
      callColumnDefinitions?: (ColumnDefinition[] | null)[];
      alias: string | null;
      columns?: string[];
      columnDefinitions?: ColumnDefinition[];
      lateral?: boolean;
      ordinality?: boolean;
    }
  // `alias` and `columns` are present only on a parenthesised join that carries
  // an alias clause — `(a JOIN b ON …) AS x (c, d)`. A parenthesised join
  // without one is the bare join node: the parentheses only group. `natural`
  // is present (and true) only for a NATURAL join, and `usingAlias` only for
  // `USING (…) AS name`.
  | {
      kind: "join";
      joinType: FromItemJoinType;
      natural?: true;
      left: FromItem;
      right: FromItem;
      on: Expr | null;
      using: string[] | null;
      usingAlias?: string;
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
  query: Preparable;
  search?: CteSearch;
  cycle?: CteCycle;
};

// One item of a SET list, shared by UPDATE, ON CONFLICT DO UPDATE and MERGE's
// UPDATE SET: either `column = value`, or PG's multi-column `(a, b) = source`.
// The multi-column source is a row constructor (`(1, 2)` / `ROW(1, 2)`, whose
// top-level items may be a bare DEFAULT) or a `(SELECT …)` subquery — the only
// sources PG accepts.
// A single column's value may be a bare DEFAULT too (`SET a = DEFAULT`).
// A target may assign into part of a column (`SET a[1] = …`, `SET c.f = …`):
// `indirection` holds those steps, and is present only when written. For the
// multi-column form it runs parallel to `columns`, an empty list standing for a
// column assigned whole, and is present only when some column has steps.
export type Assignment =
  | { column: string; indirection?: Indirection; value: Expr | DefaultValue }
  | {
      columns: string[];
      indirection?: Indirection[];
      value: AssignmentRow | Extract<Expr, { kind: "row" | "subquery" }>;
    };

// The steps after an assigned or inserted column's name (PG's opt_indirection on
// set_target / insert_column_item): `.field` or a `[i]` / `[lo:hi]` subscript,
// whose bounds read as the `subscript` expression's do. PG's grammar also takes
// `.*`, which its analysis then rejects; it is rejected here outright.
export type IndirectionStep =
  | { kind: "field"; name: string; span: Span }
  | { kind: "subscript"; index: Expr | null; upper?: Expr | null; span: Span };
export type Indirection = IndirectionStep[];

// The row-constructor source of a multi-column assignment: RowExpr's shape, but
// its items may be a bare DEFAULT. A `((1, 2))` source keeps the inner RowExpr
// (listed in Assignment's union for that reason).
export type AssignmentRow = { kind: "row"; items: (Expr | DefaultValue)[]; implicit?: true; span: Span };

// `constraint` is present only for `ON CONFLICT ON CONSTRAINT name`, which
// names the arbiter instead of listing its columns (`target` is then null).
// `inference` is present only for an arbiter list that plain column names
// cannot hold — an element with an expression, COLLATE or operator class, or a
// `WHERE` predicate after the list — and `target` is then null too.
export type OnConflict = {
  target: string[] | null;
  constraint?: string;
  inference?: ConflictInference;
  action: { kind: "nothing" } | { kind: "update"; set: Assignment[]; where: Expr | null };
};

// `ON CONFLICT (element, …) [WHERE predicate]`: PG's opt_conf_expr. Each element
// is an index_elem as arbiter inference reads it — `column | func(…) | (expr)`,
// then `[COLLATE collation] [opclass]` — which is the partition key's shape.
// ASC / DESC and NULLS, which PG's grammar takes and its analysis rejects here,
// are not accepted, nor are operator-class options (`ops (…)`), which its
// grammar also takes. `where` is present only when written.
export type ConflictInference = { elements: PartitionKey[]; where?: Expr };

// A bare DEFAULT standing for a column's default: an INSERT VALUES row item, or
// the value of a SET assignment (`SET a = DEFAULT`, `SET (a, b) = (1, DEFAULT)`).
// It is not an expression: PG's a_expr admits DEFAULT only to reject it in parse
// analysis everywhere else, and this grammar accepts it only in those places.
export type DefaultValue = { kind: "default"; span: Span };

// Which value wins for an identity column: `OVERRIDING {SYSTEM | USER} VALUE`.
export type InsertOverriding = "system" | "user";

// The DML statements (MERGE too) each accept a leading `WITH …` prefix. `with_` /
// `recursive` are present only when one attaches (like FromItem's optional
// `lateral`), so WITH-less DML keeps its original AST shape. INSERT's `alias`
// (`INSERT INTO t AS a`) and `overriding` follow the same rule, as does
// `indirection`, which runs parallel to `columns` as on a multi-column Assignment
// (`INSERT INTO t (a[1], c.f) …`).
export type Insert = {
  kind: "insert";
  table: string[];
  alias?: string;
  columns: string[] | null;
  indirection?: Indirection[];
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

// `UPDATE target …` / `DELETE FROM target …`, where a target is `[ONLY] name
// [*]` or `ONLY (name)` (relationExpr). `only` is present only when written; a
// trailing `*` spells the default and is not recorded. `currentOf` names the
// cursor of `WHERE CURRENT OF cursor` and is present only for that form
// (`where` is then null).
export type Update = {
  kind: "update";
  table: string[];
  only?: true;
  alias: string | null;
  set: Assignment[];
  from: FromItem[] | null;
  where: Expr | null;
  currentOf?: string;
  returning: SelectItem[] | null;
  with_?: Cte[];
  recursive?: boolean;
  span: Span;
};

// See Update for `only` and `currentOf`.
export type Delete = {
  kind: "delete";
  table: string[];
  only?: true;
  alias: string | null;
  using: FromItem[] | null;
  where: Expr | null;
  currentOf?: string;
  returning: SelectItem[] | null;
  with_?: Cte[];
  recursive?: boolean;
  span: Span;
};

// What a MERGE WHEN clause does. INSERT's `source` is INSERT's own union,
// narrowed to the two forms MERGE admits: one VALUES row (`rows` then holds
// exactly one) or DEFAULT VALUES. `overriding` and `indirection` are present
// only when written, as on Insert.
export type MergeAction =
  | { kind: "update"; set: Assignment[] }
  | { kind: "delete" }
  | { kind: "nothing" }
  | {
      kind: "insert";
      columns: string[] | null;
      indirection?: Indirection[];
      overriding?: InsertOverriding;
      source: Extract<Insert["source"], { kind: "values" | "defaultValues" }>;
    };

// `WHEN [NOT] MATCHED [BY {SOURCE | TARGET}] [AND condition] THEN action`.
// `NOT MATCHED` and `NOT MATCHED BY TARGET` are one form, `notMatched`. The
// parser admits INSERT only for `notMatched`, and UPDATE and DELETE only for
// the other two forms, as PG does.
export type MergeWhen = {
  match: "matched" | "notMatched" | "notMatchedBySource";
  condition: Expr | null;
  action: MergeAction;
};

// `[WITH …] MERGE INTO [ONLY] target [[AS] alias] USING source ON condition
// when_clause … [RETURNING …]`. `source` is a FROM item, joins included, as
// PG's table_ref is. `only` is present only when written and `with_` /
// `recursive` only when a WITH prefix attaches, as on Insert; `when` is never
// empty.
export type Merge = {
  kind: "merge";
  table: string[];
  only?: true;
  alias: string | null;
  source: FromItem;
  on: Expr;
  when: MergeWhen[];
  returning: SelectItem[] | null;
  with_?: Cte[];
  recursive?: boolean;
  span: Span;
};

// The statements PG's PreparableStmt admits, as far as sql-lite parses them:
// what PREPARE, EXPLAIN and COPY (…) take as their query.
export type Preparable = Query | Insert | Update | Delete | Merge;

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
// A "b-expression" (PG's `b_expr`): the same operator sublanguage minus NOT,
// AND / OR, IN, LIKE, BETWEEN, ANY / ALL, COLLATE, AT TIME ZONE / LOCAL and the
// IS tests other than DISTINCT FROM and DOCUMENT. PG uses it where a keyword
// that one of those forms would swallow marks the operand's end: the `IN`
// inside `POSITION(sub IN str)`, and the `NOT NULL` or `COLLATE` after a column
// or domain DEFAULT.
const bExpression: Rule<Expr, SqlTokenType> = lazy(() => bExprRule);
// The expr↔query cycle: exactly one Rule<Query> annotation, resolved lazily —
// the same one-boundary rule js-lite's expr/statement cycle follows. Declared
// here because the expression atom (scalar subquery, EXISTS, IN (SELECT …))
// reaches into it.
const query: Rule<Query, SqlTokenType> = lazy(() => queryRule);
// A parenthesised, comma-separated list of one item or more. An empty `()` is
// rejected by reading the item at its `)`, so the error is the one a missing
// item reports anywhere else in the list. That relies on `item` never matching
// a `)`, which holds for an expression and an INSERT value.
const nonEmptyList = <T>(item: Rule<T, SqlTokenType>): Rule<T[], SqlTokenType> => {
  const list = delimited(P("("), P(")"), P(","), item, { interleaved: true });
  return custom<T[], SqlTokenType>(
    (ctx) => {
      if (ctx.is("punc", "(") && isPuncToken(ctx.peekAhead(1), ")")) {
        ctx.next(); // "("
        ctx.parse(item); // croaks on the ")"
      }
      return ctx.parse(list);
    },
    { expected: list.expected(), first: list.first() },
  );
};
// PG has no empty `()` in any of its users (IN, VALUES, DISTINCT ON).
const exprList = nonEmptyList(expression);

// `*` lexes as an operator token; introduced only in select-list / function-arg
// positions, so the pratt `*` multiply is untouched.
const bareStar = token("op", { values: ["*"] }).map((_node, span): Expr => ({ kind: "star", table: null, span }));

// `(` opens both `(expr)` and `(SELECT …)`; they share the first token, so the
// atom peeks past it — a query word there (select/with/values/table, all
// reserved, so never a column) means a subquery. No attempt() cost.
// (`peekAhead` doesn't skip trivia, but `sqlParseLexer` has already dropped
// comments, so `( /* c */ SELECT` is still a subquery.) A run of `(` before the
// word holds a query only when a set operation or trailing query clause
// continues one of the inner groups — `((SELECT 1) UNION (SELECT 2))`; anything
// else is a parenthesised expression around a subquery, `((SELECT 1))` and
// `((SELECT 1) + 1)` alike, read as before (see parenRunIsQuery).
const startsQuery = (ctx: ParseContext<SqlTokenType>): boolean => {
  let depth = 1;
  while (isPuncToken(ctx.peekAhead(depth), "(")) depth++;
  const word = ctx.peekAhead(depth);
  if (word?.type !== "ident" || !QUERY_WORDS.has(word.value)) return false;
  return depth === 1 || parenRunIsQuery(ctx, depth, true);
};
const isSubqueryParen = (ctx: ParseContext<SqlTokenType>): boolean => ctx.is("punc", "(") && startsQuery(ctx);
const parenQuery = seq(skip(punc("(")), field("q", query), skip(punc(")"))).map((s) => s.q);

// The number node for a literal's text and any sign the grammar folds into it,
// `raw` attached only when `value` loses the text (see the `number` member of
// `Expr`). The sign is applied after decoding: `Number("-0x10")` is NaN.
const numberNode = (text: string, span: Span, sign = ""): Extract<Expr, { kind: "number" }> => {
  const magnitude = Number(text);
  const value = sign === "-" ? -magnitude : magnitude;
  const lossy = !Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value));
  return { kind: "number", value, ...(lossy && { raw: sign + text }), span };
};
const numberLit = token("number").map((node, span): Expr => numberNode(node.value, span));
const stringLit = token("string").map((node, span): Expr => ({ kind: "string", value: node.value, span }));
// The expression atom's string constant: a plain `'…'` (any of the forms that
// lex to a `string` token) or `N'abc'`, PG's national character string. The
// national form is a `bpchar`-typed literal, which is what PG's grammar makes of
// the NCHAR its scanner emits before the string; the lexer reads it as one
// token spanning the `N` too, so the type's span is that one character. It is
// accepted in expressions only, as in PG — where a bare string constant is
// required (`COMMENT ON … IS`, option values) it is not one. One rule rather
// than a `oneOf` of two: this sits on the path of every string in every
// expression, and the nested dispatch measurably slowed string-heavy input.
// Its `expected` is the plain string's, so no "Expected …" message gains an
// entry for the national form.
const stringConstant = custom<Expr, SqlTokenType>(
  (ctx) => {
    const tok = ctx.next()!;
    const span = { ...tok.position };
    if (tok.type === "string") return { kind: "string", value: tok.value, span };
    const prefix = { start: span.start, end: { row: span.start.row, col: span.start.col + 1 } };
    return {
      kind: "typedLiteral",
      type: { name: "bpchar", args: [], array: false, span: prefix },
      value: tok.value,
      span,
    };
  },
  { expected: "a string", first: [{ type: "string" }, { type: "nstring" }] },
);
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

// A function argument: `*` (for `count(*)`), a named argument (`a => 1` or `a
// := 1`), or an ordinary expression. The named form is picked out by a
// two-token peek rather than a backtracking branch: `=>` appears in no operator
// table and `:=` lexes as a token of its own (so a spaced `a : = 1` is no named
// argument, as in PG), so an argument that is *not* named can never have
// consumed either. Widening this rule widens every position that reaches it — a
// plain call, a FROM table function, and SUBSTRING's comma form from its second
// argument on (`parseSubstring` reads the first through `expression`, to tell
// the FROM/FOR form from the comma one, so `substring(str => 'abc', from => 2)`
// is still rejected). That is deliberate as far as it goes: PG accepts named
// arguments in all of those positions.
const plainFunctionArg = oneOf(bareStar, expression);
const isNamedArgMark = (tok: Token<SqlTokenType> | null): boolean =>
  tok !== null && ((tok.type === "op" && tok.value === "=>") || (tok.type === "punc" && tok.value === ":="));
// The argument itself, its value read by `value`: `plainFunctionArg`, or just
// `expression` after VARIADIC, which takes no `*` (PG's func_arg_expr).
function parseCallArg(ctx: ParseContext<SqlTokenType>, value: Rule<Expr, SqlTokenType>): Expr {
  const head = ctx.peek();
  if (head !== null && (head.type === "ident" || head.type === "qident") && isNamedArgMark(ctx.peekAhead(1))) {
    const start = ctx.position();
    const argName = ctx.parse(nameWord);
    ctx.next(); // "=>" or ":="
    return { kind: "namedArg", name: argName, value: ctx.parse(expression), span: ctx.spanFrom(start) };
  }
  return ctx.parse(value);
}
// lazy() so the first set and expected string stay verbatim the ones above;
// custom() takes them eagerly, and evaluating them at module scope would enter
// `expression`'s lazy() before `expressionRule` exists.
const functionArg: Rule<Expr, SqlTokenType> = lazy(() =>
  custom<Expr, SqlTokenType>((ctx) => parseCallArg(ctx, plainFunctionArg), {
    expected: plainFunctionArg.expected(),
    first: plainFunctionArg.first(),
  }),
);

// The argument list of an ordinary call, PG's func_application, entered just
// past its `(` and stopping at its `)`. Ahead of the arguments, DISTINCT or
// ALL; then the arguments, of which the last may follow VARIADIC (but not
// after DISTINCT or ALL, and no argument may follow it); then an aggregate's
// `ORDER BY`. All four words are reserved, so none can be an argument and none
// needs a guard. A FROM call or CALL passes `aggregate: false` and takes
// VARIADIC alone: PG's grammar reads the other three there too, but its
// analysis rejects DISTINCT and ORDER BY outside an aggregate, and this
// grammar has never read them there (nor the no-op ALL). `afterFirst` sees
// the first argument as soon as it is read and may take the call over from
// there, returning its node as `taken` (OVERLAY's PLACING form, see columnRef),
// or decline with null.
type CallArgs = {
  args: Expr[];
  quantifier: "distinct" | "all" | null;
  variadic: boolean;
  orderBy: OrderItem[];
  // Whether every argument opened on an integer constant: with each one a plain
  // number node, the list could be a typmod (see columnRef). Only the token an
  // argument starts on is checked, which it peeks anyway.
  integerArgs: boolean;
  taken?: Expr;
};
function parseCallArgs(
  ctx: ParseContext<SqlTokenType>,
  opts: { aggregate: boolean; afterFirst?: (first: Expr, call: CallArgs) => Expr | null },
): CallArgs {
  const quantifier = opts.aggregate
    ? ((ctx.eat("ident", ["distinct", "all"])?.value ?? null) as CallArgs["quantifier"])
    : null;
  const call: CallArgs = { args: [], quantifier, variadic: false, orderBy: [], integerArgs: true };
  // DISTINCT and ALL qualify an argument list, so one must follow.
  if (ctx.is("punc", ")") && quantifier === null) return call;
  const readArg = (): void => {
    // No bare `*` after DISTINCT, ALL or VARIADIC: PG's `count(*)` is a form
    // of its own, and none of them takes it.
    if (quantifier !== null || ctx.eat("ident", "variadic") !== null) {
      call.variadic = quantifier === null;
      call.integerArgs = false;
      call.args.push(parseCallArg(ctx, expression));
      return;
    }
    call.integerArgs &&= isIntegerConstant(ctx.peek());
    call.args.push(ctx.parse(functionArg));
  };
  readArg();
  const taken = opts.afterFirst?.(call.args[0]!, call) ?? null;
  if (taken !== null) return { ...call, taken };
  while (!call.variadic && ctx.is("punc", ",")) {
    ctx.next(); // ","
    readArg();
  }
  if (opts.aggregate && ctx.is("ident", "order")) call.orderBy = ctx.parse(orderByClause);
  return call;
}

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
// `row OVERLAPS row`. `overlaps` is not in RESERVED — PG reserves it from
// names, but this grammar never did — though as an AS_LABEL keyword it is an
// alias only after AS (see asAlias). The operator stays out of the pratt table:
// it applies to rows alone, so the row constructors that may lead it (the implicit
// `(a, b)` in parenOrSubquery, and ROW(…) above) look for the tail themselves,
// and only claim `overlaps` when a row can follow it: a `(` or a `ROW (`.
// Consuming the tail at atom level gives OVERLAPS the tightest precedence there
// is, so a trailing `::` binds to the whole predicate rather than to the
// right-hand row. That is PG's reading too: both of its operands are rows, not
// expressions, so `(c, d)::text` cannot be one, and the cast can only apply to
// the finished predicate. Two over-acceptances come with the atom: a trailing
// `[…]` binds the same way, where PG would reject it (as `ROW(a, b)[1]` already
// was), and the b-expression shares the atom, so OVERLAPS also reaches positions
// PG's b_expr does not admit, such as a column DEFAULT. Everything
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

// SUBSTRING(value FROM from FOR for_), SUBSTRING(value SIMILAR pattern ESCAPE
// escape) — or the ordinary comma form SUBSTRING(x, y, z), which falls through
// to a plain call node. A `similar` after the value is never SIMILAR TO's: the
// infix declines unless TO follows it.
function parseSubstring(ctx: ParseContext<SqlTokenType>, start: Position): Expr {
  const value = ctx.parse(expression);
  if (ctx.eat("ident", "similar") !== null) {
    const pattern = ctx.parse(expression);
    ctx.parse(kw("escape"));
    const esc = ctx.parse(expression);
    expectClose(ctx);
    return { kind: "substringSimilar", value, pattern, escape: esc, span: ctx.spanFrom(start) };
  }
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

const NORMAL_FORMS: readonly NormalForm[] = ["nfc", "nfd", "nfkc", "nfkd"];

// NORMALIZE(value [, form]). The form is one of the four keywords, never an
// expression, so PG takes no other second argument. Without one this gives the
// plain call node it always did, but only for that one-argument form: as PG's
// col_name_keyword, NORMALIZE takes no OVER, FILTER, DISTINCT, VARIADIC or
// named argument.
function parseNormalize(ctx: ParseContext<SqlTokenType>, start: Position): Expr {
  const value = ctx.parse(expression);
  if (ctx.eat("punc", ",") === null) {
    expectClose(ctx);
    return { kind: "call", name: "normalize", args: [value], span: ctx.spanFrom(start) };
  }
  const form = ctx.eat("ident", NORMAL_FORMS);
  if (form === null) ctx.croak(`Expected "nfc", "nfd", "nfkc" or "nfkd" but found ${describeFound(ctx.peek())}`);
  expectClose(ctx);
  return { kind: "normalize", value, form: form.value as NormalForm, span: ctx.spanFrom(start) };
}

// The keyword-argument functions columnRef's call branch hands a single-part
// callee over to, entered just past the `(`.
const SPECIAL_CALLS: Record<string, (ctx: ParseContext<SqlTokenType>, start: Position) => Expr> = {
  extract: parseExtract,
  position: parsePosition,
  trim: parseTrim,
  row: parseRow,
  substring: parseSubstring,
  normalize: parseNormalize,
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
// for `INTERVAL 'literal' [field]` and `type 'literal'` (any type name
// leading a string literal), the keyword-argument functions in
// SPECIAL_CALLS, and OVERLAY's PLACING form.
const columnRef = custom<Expr, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    // INTERVAL 'literal' [field] — only when a string literal follows;
    // otherwise `interval` is an ordinary (unreserved) name and falls through
    // below. The INTERVAL(p) 'literal' form is picked up on the call path.
    if (ctx.is("ident", "interval") && ctx.peekAhead(1)?.type === "string") {
      ctx.next(); // interval
      return parseIntervalLiteral(ctx, start, null);
    }
    // A multi-word or pre-tail-precision type spelling followed by a string.
    // No type word is reserved, so it leads a literal only when the whole
    // spelling is followed by one; a one-word or dotted type name is handled
    // once it has been read (typeNameLiteral, below).
    if (startsMultiWordTypedLiteral(ctx)) {
      const type = ctx.parse(typeRef);
      const value = ctx.next()!.value; // the string literal
      return { kind: "typedLiteral", type, value, span: ctx.spanFrom(start) };
    }
    // COLLATION FOR (expr). Only a `(` after FOR makes it one, so a column
    // named `collation` still ends a select item before `FOR UPDATE`.
    if (ctx.is("ident", "collation") && isWordAhead(ctx, 1, "for") && isPuncToken(ctx.peekAhead(2), "(")) {
      ctx.next(); // collation
      ctx.next(); // for
      const expr = ctx.parse(parenExpr);
      return { kind: "collationFor", expr, span: ctx.spanFrom(start) };
    }
    // Only a bare OVERLAY has the PLACING form; a quoted `"overlay"` is an
    // ordinary function name to PG.
    const lead = ctx.peek()!;
    const bareLead = lead.type === "ident";
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
      // A keyword-argument function (EXTRACT / POSITION / TRIM / ROW /
      // SUBSTRING / NORMALIZE) owns the rest of the call; a plain name falls
      // through to a normal call.
      // `Object.hasOwn` for the reason `lookup` gives: `constructor(1)` and
      // `__proto__(1)` would otherwise find an inherited "handler".
      // NORMALIZE is a keyword only when bare: a quoted `"normalize"(x, 'NFC')`
      // is an ordinary call to PG.
      const special =
        parts.length === 1 && Object.hasOwn(SPECIAL_CALLS, parts[0]!) && (bareLead || parts[0] !== "normalize")
          ? SPECIAL_CALLS[parts[0]!]
          : undefined;
      if (special !== undefined) return special(ctx, start);
      // OVERLAY's keyword form is told apart from its comma form only by a
      // PLACING after the first argument, so unlike the SPECIAL_CALLS it cannot
      // claim the call up front: the comma form stays on this path and so
      // parses exactly as it did before the keyword form existed. That includes
      // the modifiers every call here accepts (DISTINCT, ORDER BY, OVER, …),
      // which PG would reject on OVERLAY's comma form — no narrower than this
      // grammar is for any other call. `placing` is reserved, so no first
      // argument can end in one — before this check, it was a syntax error
      // here, and it still is after a bare `*`, a named or VARIADIC argument,
      // none of which PG's keyword form takes either (a `t.*` is an ordinary
      // operand to it, as to SUBSTRING's FROM form).
      const overlay =
        bareLead && parts.length === 1 && parts[0] === "overlay"
          ? (value: Expr, call: CallArgs): Expr | null =>
              call.quantifier === null &&
              !call.variadic &&
              !(value.kind === "star" && value.table === null) &&
              value.kind !== "namedArg" &&
              ctx.is("ident", "placing")
                ? parseOverlay(ctx, value, start)
                : null
          : undefined;
      const { args, quantifier, variadic, orderBy, integerArgs, taken } = parseCallArgs(ctx, {
        aggregate: true,
        afterFirst: overlay,
      });
      if (taken !== undefined) return taken;
      if (!ctx.is("punc", ")")) ctx.croak(`Expected ")" but found ${describeFound(ctx.peek())}`);
      ctx.next(); // ")"
      // `INTERVAL(3) '…'` and `varchar(3) 'abc'`: the call was a type's
      // precision or typmod after all.
      const typmod =
        integerArgs && args.length > 0 && quantifier === null && orderBy.length === 0
          ? args.map((arg) => (arg.kind === "number" ? arg.value : null))
          : null;
      if (typmod !== null && !typmod.includes(null) && ctx.is("string")) {
        const integers = typmod as number[];
        if (bareLead && parts.length === 1 && parts[0] === "interval" && integers.length === 1) {
          return parseIntervalLiteral(ctx, start, integers[0]!);
        }
        const literal = typeNameLiteral(ctx, start, lead, parts, integers);
        if (literal !== null) return literal;
      }
      const call: Expr = {
        kind: "call",
        name: parts.join("."),
        args,
        ...(quantifier === "distinct" && { distinct: true }),
        ...(quantifier === "all" && { all: true }),
        ...(variadic && { variadic: true }),
        ...(orderBy.length > 0 && { orderBy }),
        span: ctx.spanFrom(start),
      };
      // Trailing WITHIN GROUP / IGNORE|RESPECT NULLS / FILTER / OVER modifiers.
      return applyCallModifiers(ctx, call, start);
    }
    const literal = typeNameLiteral(ctx, start, lead, parts, null);
    if (literal !== null) return literal;
    const name: Expr = { kind: "name", parts, span: ctx.spanFrom(start) };
    // A subscript may lead a field selection here (`a[1].f`), so the name's
    // indirection is read in full rather than left to the subscript postfix.
    return ctx.is("punc", "[") ? parseIndirection(ctx, name, start) : name;
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
//
// A parenthesised expression or subquery may be followed by indirection, PG's
// `'(' a_expr ')' opt_indirection` and `select_with_parens indirection`:
// `(row).f`, `(f()).*`, `(arr)[1].f`. A row constructor takes none, as in PG.
const subqueryExpr = parenQuery.map((q, span): Expr => ({ kind: "subquery", query: q, span }));
const parenOrSubquery = custom<Expr, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    if (isSubqueryParen(ctx)) return parseIndirection(ctx, ctx.parse(subqueryExpr), start);
    ctx.next(); // "("
    const items = parseRowItems(ctx, false);
    const row: RowExpr = { kind: "row", items, implicit: true, span: ctx.spanFrom(start) };
    if (startsOverlaps(ctx)) return parseOverlaps(ctx, row);
    return items.length === 1 ? parseIndirection(ctx, items[0]!, start) : row;
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

// ARRAY[…] constructor and ARRAY(subquery). `array` is reserved, so this atom
// owns the keyword. The element list may be empty (`ARRAY[]`), and holds either
// expressions or, in a multidimensional array, bare `[…]` rows — PG's
// array_expr, which takes no mix of the two (`ARRAY[[1], 2]` is a syntax error
// there and here). A row is an array_expr too, so rows nest to any depth.
const arrayElements = delimited(P("["), P("]"), P(","), expression, { interleaved: true });
function parseArrayBody(ctx: ParseContext<SqlTokenType>): Expr[] {
  if (!ctx.is("punc", "[") || !isPuncToken(ctx.peekAhead(1), "[")) return ctx.parse(arrayElements);
  ctx.next(); // "["
  const rows: Expr[] = [];
  do {
    const start = ctx.position();
    if (!ctx.is("punc", "[")) ctx.croak(`Expected "[" but found ${describeFound(ctx.peek())}`);
    rows.push({ kind: "array", elements: parseArrayBody(ctx), implicit: true, span: ctx.spanFrom(start) });
  } while (ctx.eat("punc", ",") !== null);
  if (!ctx.is("punc", "]")) ctx.croak(`Expected "]" but found ${describeFound(ctx.peek())}`);
  ctx.next(); // "]"
  return rows;
}
const arrayExpr = custom<Expr, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    ctx.next(); // array
    if (ctx.is("punc", "(")) return { kind: "arraySubquery", query: ctx.parse(parenQuery), span: ctx.spanFrom(start) };
    return { kind: "array", elements: parseArrayBody(ctx), span: ctx.spanFrom(start) };
  },
  { expected: '"array"', first: [{ type: "ident", value: "array" }] },
);

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
// An integer constant, as PG lexes one: decimal, hex, octal or binary digits
// (the lexer has already dropped any `_` separators) that fit in an int4 — PG
// lexes `1.5`, `5.` and `3e0` as floats, and a wider integer as a numeric, and
// its precision slots take neither. The value itself is not range-checked: PG
// only warns above 6, and clamps.
const isIntegerConstant = (tok: Token<SqlTokenType> | null): boolean =>
  tok !== null &&
  tok.type === "number" &&
  /^(?:[0-9]+|0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+)$/.test(tok.value) &&
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
  stringConstant,
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
// suffix (`int[]`, `text[][]`, `int ARRAY`). Array dims are collapsed to a
// boolean. The name may be several words (`double precision`, `timestamp with
// time zone`) — see MULTI_WORD_TYPES below.
const typeArg = token("number").map((node) => Number(node.value));
// Either PG spelling: any run of `[]` / `[n]`, or the SQL-standard `ARRAY` with
// at most one `[n]`, whose bound PG requires (`int ARRAY[]` is a syntax error).
// The two do not combine. `array` is reserved, so it can follow a type nowhere
// else, and is matched with ctx.is like the other reserved words.
const arraySuffix = custom<boolean, SqlTokenType>(
  (ctx) => {
    if (ctx.is("ident", "array")) {
      ctx.next(); // array
      if (ctx.is("punc", "[")) {
        ctx.next(); // "["
        const tok = ctx.peek();
        if (!isIntegerConstant(tok)) ctx.croak(`Expected an integer array bound but found ${describeFound(tok)}`);
        ctx.next(); // the bound
        if (!ctx.is("punc", "]")) ctx.croak(`Expected "]" but found ${describeFound(ctx.peek())}`);
        ctx.next(); // "]"
        // Refused here rather than left for the caller, where a cast would
        // take it for a subscript of the cast and pass a 2-D-looking type.
        if (ctx.is("punc", "[")) ctx.croak(`Expected one array bound after ARRAY but found "["`);
      }
      return true;
    }
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
  {
    expected: '"[" or "array"',
    first: [
      { type: "punc", value: "[" },
      { type: "ident", value: "array" },
    ],
  },
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
// The same thirteen, as the strings an INTERVAL literal's `fields` holds.
const INTERVAL_FIELD_SPECS: ReadonlySet<string> = new Set(INTERVAL_TAILS.map((tail) => tail.join(" ")));

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
// the whole rule — otherwise `diagnose("CREATE TABLE t (c timestamp with \\);")`
// reports the bad character and loses the column-definition error. But filling
// the lookahead buffer consumes the offending character, so simply discarding
// the error would drop it for good, and `c interval day \` would parse clean.
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
// must be a bare `ident` — a `qident` token carries the *inner* text, so a
// quoted `"precision"` is otherwise indistinguishable from the keyword by
// value alone, and PG treats it as an ordinary name.
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

// The offset just past a `(n, …)` list of integer constants that opens at
// `offset`, `offset` itself when no `(` is there, or -1 when one is but does
// not hold such a list.
function skipTypmod(ctx: ParseContext<SqlTokenType>, offset: number): number {
  if (!isPuncToken(peekOrReport(ctx, offset), "(")) return offset;
  let index = offset + 1;
  for (;;) {
    if (!isIntegerConstant(peekOrReport(ctx, index))) return -1;
    index++;
    if (isPuncToken(peekOrReport(ctx, index), ")")) return index + 1;
    if (!isPuncToken(peekOrReport(ctx, index), ",")) return -1;
    index++;
  }
}

// True when the cursor sits on a typed literal whose type is a multi-word
// spelling (`double precision '1'`, `character varying(3) 'abc'`) or carries
// its precision before the tail (`timestamp(3) with time zone '…'`, and
// `time(3) '…'` too): the lead word, the pre-tail precision and the tail where
// its type has them, at most one trailing `(n, …)` where it does not, then a
// string. Every token is checked before columnRef commits, and nothing else may
// sit between them. A one-word or dotted type name needs none of this: columnRef
// reads it as a name or a call, as it would anyway, and only then looks for the
// string (see typeNameLiteral).
//
// The token straight after the lead is peeked plainly, as a name peeks it, and
// so is a pre-tail `(n)` together with the two tokens past its `)`: the call it
// otherwise becomes peeks them anyway, so a lex error there surfaces exactly as
// it always did. Lookahead into and past a tail is lookahead the old parse need
// not have done, and goes through peekOrReport — under diagnose() the syntax
// error that follows (`SELECT time with time zone \;` still reports `with`) is
// kept.
function startsMultiWordTypedLiteral(ctx: ParseContext<SqlTokenType>): boolean {
  const lead = ctx.peek();
  // Only a MULTI_WORD_TYPES key has a tail or a pre-tail precision, and none is
  // reserved: a reserved lead is croaked by nameWord with nothing past it read.
  if (lead === null || lead.type !== "ident" || lead.value === "interval" || !MULTI_WORD_TYPES.has(lead.value)) {
    return false;
  }
  ctx.peekAhead(1); // plainly, before findTypeTail's reporting peek reaches it
  let offset = 1;
  let preTail = false;
  if (
    ARGS_BEFORE_TAIL.has(lead.value) &&
    isPuncToken(ctx.peekAhead(1), "(") &&
    isIntegerConstant(ctx.peekAhead(2)) &&
    isPuncToken(ctx.peekAhead(3), ")")
  ) {
    ctx.peekAhead(5);
    offset = 4;
    preTail = true;
  }
  const tail = findTypeTail(ctx, lead.value, offset);
  if (tail === null) {
    if (!preTail) return false;
  } else {
    offset += tail.length;
    // TIME and TIMESTAMP spell their precision before the tail or not at all.
    if (!ARGS_BEFORE_TAIL.has(lead.value)) offset = skipTypmod(ctx, offset);
  }
  return offset !== -1 && peekOrReport(ctx, offset)?.type === "string";
}

// The column-name keywords PG's grammar never reads as a type name on their
// own: its col_name_keyword list less the ConstTypename words. A bare,
// undotted one of these is no `func_name`, so it cannot lead `name 'string'`
// (`coalesce 'x'`, `setof 'x'`); `national` and `precision` still can as part
// of a multi-word spelling, and any of them can as part of a dotted name.
const NON_TYPE_NAME_KEYWORDS: ReadonlySet<string> = new Set([
  "between",
  "coalesce",
  "exists",
  "extract",
  "greatest",
  "grouping",
  "inout",
  "json_array",
  "json_arrayagg",
  "json_exists",
  "json_object",
  "json_objectagg",
  "json_query",
  "json_scalar",
  "json_serialize",
  "json_table",
  "json_value",
  "least",
  "merge_action",
  "national",
  "none",
  "normalize",
  "nullif",
  "out",
  "overlay",
  "position",
  "precision",
  "row",
  "setof",
  "substring",
  "treat",
  "trim",
  "values",
  "xmlattributes",
  "xmlconcat",
  "xmlelement",
  "xmlexists",
  "xmlforest",
  "xmlnamespaces",
  "xmlparse",
  "xmlpi",
  "xmlroot",
  "xmlserialize",
  "xmltable",
]);

// When columnRef has read a name (`typmod` null) or a call whose arguments are
// all integer constants (`typmod` their values), and a string follows, the
// typed literal they make — PG's `func_name 'string'` and `func_name (args)
// 'string'`, a qualified or quoted name included (`s.t 'x'`, `"char" 'a'`,
// `varchar(3) 'abc'`) — or null when the name cannot lead one. Deciding after
// the fact needs no lookahead: the name and the call both peek the token past
// their end anyway.
//
// The typmod is narrower than PG's, which takes any expression list here:
// this grammar's type node holds integers only. INTERVAL's precision form has
// its own node, and TIME / TIMESTAMP have theirs read by
// startsMultiWordTypedLiteral, so a bare `timestamp(1.5) 'x'` is left to fail.
// Only a plain string follows the type: `N'…'` lexes as a token of its own,
// and PG reads a type before one as a syntax error. CURRENT_CATALOG and
// SYSTEM_USER are reserved to PG, though not in RESERVED here (they read as
// plain names), so a bare one is refused as well, alone or at the head of a
// dotted name.
function typeNameLiteral(
  ctx: ParseContext<SqlTokenType>,
  start: Position,
  lead: Token<SqlTokenType>,
  parts: string[],
  typmod: number[] | null,
): Expr | null {
  const literal = ctx.peek();
  if (literal === null || literal.type !== "string") return null;
  const bare = lead.type === "ident";
  if (bare && (parts[0] === "current_catalog" || parts[0] === "system_user")) return null;
  if (bare && parts.length === 1) {
    const word = parts[0]!;
    if (NON_TYPE_NAME_KEYWORDS.has(word)) return null;
    if (typmod !== null && (word === "interval" || ARGS_BEFORE_TAIL.has(word))) return null;
  }
  const type: ColType = {
    name: parts.join("."),
    args: typmod ?? [],
    array: false,
    ...(!bare && parts.length === 1 && KEYWORD_TYPE_NAMES.has(parts[0]!) && { quoted: true }),
    span: ctx.spanFrom(start),
  };
  ctx.next(); // the string literal
  return { kind: "typedLiteral", type, value: literal.value, span: ctx.spanFrom(start) };
}

// Entered on an INTERVAL literal's string, `precision` already read when it
// was written before the literal (`INTERVAL(3) '…'`, from columnRef's call
// path). PG takes either that leading precision or a trailing field spec,
// never both: after `INTERVAL(3) '…'` a unit word is not a field (this grammar
// takes it for an alias, as it does after `x::interval(3)`; PG rejects both).
// A field spec must be one of INTERVAL_TAILS — `day to year` is a syntax error
// to PG — and only a trailing SECOND takes a precision.
function parseIntervalLiteral(ctx: ParseContext<SqlTokenType>, start: Position, leading: number | null): Expr {
  let precision = leading;
  const value = ctx.next()!.value; // the string literal
  const units: string[] = [];
  const fieldsStart = ctx.position();
  if (leading === null) {
    while (ctx.peek()?.type === "ident" && INTERVAL_FIELDS.has(ctx.peek()!.value)) {
      units.push(ctx.next()!.value);
    }
  }
  const fields = units.join(" ");
  if (units.length > 0 && !INTERVAL_FIELD_SPECS.has(fields)) {
    ctx.croak(`Expected an interval field spec like "day to second" but found "${fields}"`, fieldsStart);
  }
  if (units.at(-1) === "second" && ctx.is("punc", "(")) {
    ctx.next(); // "("
    const tok = ctx.peek();
    if (!isIntegerConstant(tok)) ctx.croak(`Expected an integer precision but found ${describeFound(tok)}`);
    precision = Number(ctx.next()!.value);
    expectClose(ctx);
  }
  return {
    kind: "interval",
    value,
    ...(units.length > 0 && { fields }),
    ...(precision !== null && { precision }),
    span: ctx.spanFrom(start),
  };
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

// The keyword type spellings whose quoted form means something else: PG reads
// each bare word as a built-in of another name (`int` is int4, `boolean` is
// bool, `char` is bpchar) or with a default length (`bit` is bit(1)), while the
// quoted word is looked up as written. `numeric`, `varchar`, `time`,
// `timestamp` and `interval` are not among them — each names its own type, so
// quoting changes nothing — and neither are `double` and `national`, which are
// no type without their tail.
const KEYWORD_TYPE_NAMES: ReadonlySet<string> = new Set([
  "int",
  "integer",
  "smallint",
  "bigint",
  "real",
  "float",
  "decimal",
  "dec",
  "boolean",
  "bit",
  "character",
  "char",
  "nchar",
]);

// The args are hoisted out of wherever PG puts them, so the name is always the
// words alone: `timestamp(3) with time zone` is
// `{ name: "timestamp with time zone", args: [3] }`.
//
// A leading SETOF is taken whenever a non-reserved word or a quoted name follows
// it (`c setof generated …` is a SETOF of `generated` now, which PG rejects
// either way). Otherwise `setof` is read as the type name itself, as it was
// before SETOF was recognised here — more lenient than PG, where SETOF is a
// column-name keyword and so no type name on its own (`x::setof` is a syntax
// error there).
const typeRef = custom<ColType, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    let setof = false;
    if (ctx.is("ident", "setof")) {
      const after = ctx.peekAhead(1);
      if (after !== null && (after.type === "qident" || (after.type === "ident" && !RESERVED.has(after.value)))) {
        ctx.next(); // setof
        setof = true;
      }
    }
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
    return {
      name: words.join(" "),
      args: args ?? [],
      array,
      ...(setof && { setof: true }),
      ...(!bare && parts.length === 1 && KEYWORD_TYPE_NAMES.has(parts[0]!) && { quoted: true }),
      span: ctx.spanFrom(start),
    };
  },
  { expected: "a name", first: qualName.first() },
);

// --- pratt operator table ---
// Binding powers follow PG's gram.y (highest binds tightest): :: cast and
// [ ] subscript (19), unary + - (18), COLLATE (17), AT TIME ZONE (16), ^ (15),
// * / % (14), + - (13), every other operator (|| @> & | # << >> -> @? and the
// open-ended rest, see genericInfix) (12), BETWEEN/IN/LIKE (10), comparisons
// (9, nonassoc), IS / ISNULL / NOTNULL (8), NOT (6), AND (4), OR (2). Keyword
// operators are plain `ident`-typed matches thanks to folding; multi-word ones
// (NOT LIKE, BETWEEN … AND) use match-based groups.
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

// A pratt match rule whose first set is built once. Pratt reads a match group's
// first set on every operator lookup — at each token that might continue an
// expression — and `token()` / `word()` build a fresh one per call, so the
// groups added after the original table use this to stay off the hot path.
const fixedFirst = <T>(rule: Rule<T, SqlTokenType>): Rule<T, SqlTokenType> => {
  const first = rule.first();
  return makeRule<T, SqlTokenType>({
    parse: (ctx) => rule.parse(ctx),
    first: () => first,
    expected: (labels) => rule.expected(labels),
  });
};

// --- quantified operators ---
// PG's `a_expr subquery_Op sub_type (…)`: ANY / SOME / ALL may follow any
// operator — a comparison, arithmetic, a generic operator, `OPERATOR(…)`, and
// [NOT] LIKE / ILIKE. All three words are reserved, so after an operator they
// can only open the quantifier.
const QUANTIFIERS = ["any", "all", "some"];
const isQuantifier = (tok: Token<SqlTokenType> | null): boolean =>
  tok !== null && tok.type === "ident" && QUANTIFIERS.includes(tok.value);

// Entered on the quantifier word, the operator already consumed. The operand is
// a `(subquery)` or a `(array expr)` — not the parenOrSubquery atom, whose
// implicit row PG does not allow here: `x = ANY (a, b)` is a syntax error there,
// and only `x = ANY ((a, b))` reaches the row.
const quantifiedTail = (ctx: ParseContext<SqlTokenType>, op: string, left: Expr, opSchema?: string[]): Expr => {
  const quantifier = ctx.next()!.value as "any" | "all" | "some";
  const right = isSubqueryParen(ctx) ? ctx.parse(subqueryExpr) : ctx.parse(parenExpr);
  return {
    kind: "anyAll",
    op,
    quantifier,
    left,
    right,
    ...(opSchema !== undefined && { opSchema }),
    span: closeSpan(left, ctx.lastEnd()),
  };
};

// The quantified twin of an operator group: listed ahead of it, it claims the
// operator only when a quantifier follows and otherwise declines, so the plain
// group (and its span) is untouched. It keeps the group's bp, which decides how
// much of the left operand the operator takes, as in PG.
const quantifiedTwin = (group: { ops: readonly string[]; bp: number }) => ({
  ops: group.ops,
  bp: group.bp,
  type: "op" as const,
  when: (ctx: ParseContext<SqlTokenType>) => isQuantifier(ctx.peekAhead(1)),
  parse: (ctx: ParseContext<SqlTokenType>, left: Expr): Expr => quantifiedTail(ctx, ctx.next()!.value, left),
});

// --- generic operators ---
// PG's scanner reads any run of operator characters as one operator (`&&`,
// `<->`, `-|-`, `^@`, the `~~` that pg_dump writes for LIKE, …), and its grammar
// gives every operator outside the named tiers one precedence, `Op` — bp 12
// here, left-associative. `=>` is the one run that is not an operator: PG lexes
// it as its own named-argument token (see functionArg), so it ends an expression.
const anyOperator = fixedFirst(token("op"));
const isGenericOp = (tok: Token<SqlTokenType> | null): boolean => tok !== null && tok.value !== "=>";

// The catch-all. It must stay last among the infix groups: groups are tried in
// order and it matches every operator token, so anywhere earlier it would take
// `=`, `+` or `||` away from the group that gives them their own precedence.
const genericInfix = {
  match: anyOperator,
  bp: 12,
  when: (ctx: ParseContext<SqlTokenType>) => isGenericOp(ctx.peek()),
  parse: (ctx: ParseContext<SqlTokenType>, left: Expr, h: PrattHelpers<Expr>): Expr => {
    const op = ctx.next()!.value;
    const right = h.parseRhs(13);
    return { kind: "binary", op, left, right, span: closeSpan(left, ctx.lastEnd()) };
  },
};

// The quantified twin of every bp-12 operator (see quantifiedTwin), fixed or
// generic, ahead of the bp-12 groups. Comparisons have their own quantified
// form at their own bp, so they are left to it.
const quantifiedGeneric = {
  match: anyOperator,
  bp: 12,
  when: (ctx: ParseContext<SqlTokenType>) => {
    const tok = ctx.peek();
    return isQuantifier(ctx.peekAhead(1)) && isGenericOp(tok) && !COMPARISON_OPS.includes(tok!.value);
  },
  parse: (ctx: ParseContext<SqlTokenType>, left: Expr): Expr => quantifiedTail(ctx, ctx.next()!.value, left),
};

// PG's prefix operators. Any operator may lead an operand in its grammar, but
// a prefix group matches by value only, so the built-in ones are listed: `~`
// (bitwise NOT), `@` (absolute value), `|/` and `||/` (square and cube root),
// `!!` (tsquery NOT), and the geometric `@-@` (length), `@@` (centre), `#`
// (number of points), `?-` (horizontal) and `?|` (vertical). They take PG's
// `Op` precedence: the operand runs on through `+ -` and tighter (`@ a + b` is
// `@ (a + b)`) but stops at another bp-12 operator (`@ a <-> b` is
// `(@ a) <-> b`), hence bp 13.
const genericPrefix = {
  ops: ["~", "@", "|/", "||/", "!!", "@-@", "@@", "#", "?-", "?|"],
  type: "op" as const,
  bp: 13,
  map: (op: string, operand: Expr, span: Span): Expr => ({ kind: "unary", op, operand, span }),
};

// --- OPERATOR(schema.op) ---
// PG's explicit operator spelling, `OPERATOR(op)` or `OPERATOR(a.b.op)`, which
// always binds at the generic `Op` level, whatever the operator. `operator` is
// unreserved, so it is taken only once the whole `( [name .]… op )` has been
// seen: `SELECT a operator FROM t` keeps `operator` as an alias, and any other
// `operator(x)` stays a call. That is lenient: where an operand starts, PG reads
// every `operator (` as this spelling and rejects `SELECT operator(1)`, but in
// an index, exclusion or partition element (`func_expr_windowless`) the same
// text is a call there too, and all three reach `expression` here. The one
// spelling read the other way round is `operator(<op>)`: always the operator
// here, so `operator(*)` in those elements, a call to PG, is rejected.
// The `(` is a plain peek, which reading `operator` as an alias or a call
// would do too; anything further goes through peekOrReport.
//
// The answer is kept for the token it was asked about: pratt may ask its infix
// guard again for the same token, and a lex error the first lookahead reported
// (and so consumed) must not let a second one see a different spelling.
let operatorRefAsked: Token<SqlTokenType> | null = null;
let operatorRefAnswer = false;
function startsOperatorRef(ctx: ParseContext<SqlTokenType>): boolean {
  if (!ctx.is("ident", "operator")) return false;
  const lead = ctx.peek();
  if (lead !== operatorRefAsked) {
    const answer = scanOperatorRef(ctx);
    operatorRefAsked = lead;
    operatorRefAnswer = answer;
  }
  return operatorRefAnswer;
}
function scanOperatorRef(ctx: ParseContext<SqlTokenType>): boolean {
  const open = ctx.peekAhead(1);
  if (open === null || open.type !== "punc" || open.value !== "(") return false;
  let index = 2;
  let tok = peekOrReport(ctx, index);
  while (tok !== null && (tok.type === "qident" || (tok.type === "ident" && !RESERVED.has(tok.value)))) {
    const dot = peekOrReport(ctx, index + 1);
    if (dot === null || dot.type !== "punc" || dot.value !== ".") return false;
    index += 2;
    tok = peekOrReport(ctx, index);
  }
  if (tok === null || tok.type !== "op" || !isGenericOp(tok)) return false;
  const close = peekOrReport(ctx, index + 1);
  return close !== null && close.type === "punc" && close.value === ")";
}

// Consumes an `OPERATOR(…)` that startsOperatorRef has vouched for.
function readOperatorSpelling(ctx: ParseContext<SqlTokenType>): { op: string; opSchema: string[] } {
  ctx.next(); // operator
  ctx.next(); // "("
  const opSchema: string[] = [];
  while (!ctx.is("op")) {
    opSchema.push(ctx.parse(nameWord));
    ctx.next(); // "."
  }
  const op = ctx.next()!.value;
  ctx.next(); // ")"
  return { op, opSchema };
}

// `quantified` is false for the b-expression, which has no ANY / ALL form.
const operatorRefInfix = (quantified: boolean) => ({
  match: fixedFirst(kw("operator")),
  bp: 12,
  when: startsOperatorRef,
  parse: (ctx: ParseContext<SqlTokenType>, left: Expr, h: PrattHelpers<Expr>): Expr => {
    const { op, opSchema } = readOperatorSpelling(ctx);
    if (quantified && isQuantifier(ctx.peek())) return quantifiedTail(ctx, op, left, opSchema);
    const right = h.parseRhs(13);
    return { kind: "binary", op, left, right, opSchema, span: closeSpan(left, ctx.lastEnd()) };
  },
});

// The atom, with the prefix `OPERATOR(…) operand` in front of it. A prefix group
// cannot peek past its operator, so the spelling is read here, and its operand
// is parsed by `operand`: the same pratt table cut down to the groups that bind
// tighter than `Op` (bp ≥ 13), which is what a bp-13 prefix would have read
// (see cutTable for the one prefix the cut has to treat specially, NOT).
// The atom's first set is built once, on first use (pratt asks for it at every
// expression it enters, and `oneOf` would rebuild it from every branch each time).
const withOperatorRefPrefix = (operand: () => Rule<Expr, SqlTokenType>): Rule<Expr, SqlTokenType> => {
  let first: readonly FirstEntry<SqlTokenType>[] | undefined;
  return makeRule<Expr, SqlTokenType>({
    parse: (ctx) => {
      if (!startsOperatorRef(ctx)) return atom.parse(ctx);
      const start = ctx.position();
      const { op, opSchema } = readOperatorSpelling(ctx);
      const value = ctx.parse(operand());
      return { kind: "unary", op, operand: value, opSchema, span: ctx.spanFrom(start) };
    },
    first: () => (first ??= atom.first()),
    expected: (labels) => atom.expected(labels),
  });
};

// The groups of a pratt table that an operand parsed at `minBp` can reach. For
// the infix and postfix groups this is equivalent to re-entering the table at
// `minBp`: every operator a dropped group could take is either one no kept
// group accepts (where the loop stops either way) or one a kept group ahead of
// it takes first — the bp-12 catch-alls only ever see what the kept groups
// decline. Prefixes are different: pratt applies one wherever an operand
// starts, whatever the bp, and parses its operand in the same table, so a
// looser prefix (NOT, bp 6) cannot stay — its operand would lose the
// comparisons the cut drops. The cut keeps only the prefixes that bind at least
// as tightly, and the bp-13 operand reads NOT at atom level instead (notAtom).
type PrattTable = Required<Omit<PrattDef<Expr, SqlTokenType>, "atom">>;
const cutTable = (table: PrattTable, minBp: number): PrattTable => ({
  prefix: table.prefix.filter((group) => group.bp >= minBp),
  infix: table.infix.filter((group) => group.bp >= minBp),
  postfix: table.postfix.filter((group) => group.bp >= minBp),
});

// --- shared pratt groups (reused by the full expression rule and the b-expr) ---
// Unary sign. PG accepts a leading `+` wherever it accepts a leading `-`, and
// both produce a `unary` node carrying the operator verbatim — `+a` is not
// folded away, so the AST keeps what was written.
const unarySignPrefix = {
  ops: ["-", "+"],
  type: "op" as const,
  bp: 18,
  map: (op: string, operand: Expr, span: Span): Expr => ({ kind: "unary", op, operand, span }),
};

// The tight arithmetic / concat / bitwise / JSON-and-regex tier (bp ≥ 12) —
// everything above the comparison/logical forms. Shared verbatim with the
// b-expression.
const arithInfix = [
  // Exponentiation, left-associative as in PG's `%left '^'` (`a ^ b ^ c` is
  // `(a ^ b) ^ c`, not the right-associativity maths would give it) and looser
  // than the unary sign, so `-2 ^ 2` is `(-2) ^ 2` and `2 ^ -3 ^ 4` is
  // `(2 ^ (-3)) ^ 4`. The `::`, `[ ]`, COLLATE and AT TIME ZONE postfixes all
  // sit above it, so `a ^ b::int` casts the right operand alone and
  // `a ^ b AT TIME ZONE z` converts it.
  binary(["^"], 15),
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

// `::` cast and `[…]` subscript bind tightest (bp 19), above the unary sign:
// `-x::int` is `-(x::int)`. Both are shared with the b-expression so
// `POSITION(a[1]::text IN b)` parses its first operand fully.
const castPostfix = {
  match: punc("::"),
  bp: 19,
  parse: (ctx: ParseContext<SqlTokenType>, left: Expr): Expr => {
    ctx.next(); // "::"
    const type = ctx.parse(typeRef);
    return { kind: "cast", expr: left, type, span: closeSpan(left, ctx.lastEnd()) };
  },
};

// `a[i]` element access and `a[lo:hi]` slice. A `:` marks a slice; either bound
// may be omitted (`a[:hi]`, `a[lo:]`). The non-slice form omits the `upper` key.
// subscriptBounds reads the bracketed part, `[` to `]`; `upper` is undefined for
// the non-slice form. An assignment target's subscript step reads it too. An
// empty `a[]` is PG's syntax error, and so is it here.
function subscriptBounds(ctx: ParseContext<SqlTokenType>): { index: Expr | null; upper: Expr | null | undefined } {
  ctx.next(); // "["
  // `a[]` names no element: PG's indirection_el needs an index or a `:`.
  if (ctx.is("punc", "]")) ctx.croak('Expected an expression or ":" but found "]"');
  const hasIndex = !ctx.is("punc", ":");
  const index = hasIndex ? ctx.parse(expression) : null;
  let upper: Expr | null | undefined;
  if (ctx.is("punc", ":")) {
    ctx.next(); // ":"
    upper = ctx.is("punc", "]") ? null : ctx.parse(expression);
  }
  if (!ctx.is("punc", "]")) ctx.croak(`Expected "]" but found ${describeFound(ctx.peek())}`);
  ctx.next(); // "]"
  return { index, upper };
}
function subscriptNode(ctx: ParseContext<SqlTokenType>, left: Expr): Expr {
  const { index, upper } = subscriptBounds(ctx);
  return upper === undefined
    ? { kind: "subscript", base: left, index, span: closeSpan(left, ctx.lastEnd()) }
    : { kind: "subscript", base: left, index, upper, span: closeSpan(left, ctx.lastEnd()) };
}
const subscriptPostfix = {
  match: punc("["),
  bp: 19,
  parse: (ctx: ParseContext<SqlTokenType>, left: Expr): Expr => subscriptNode(ctx, left),
};

// PG's opt_indirection: any run of `[…]` subscripts and `.field` / `.*` field
// selections after `base`, an atom opened at `start`. Only the atoms that PG
// gives indirection read it here — a parenthesised expression or subquery,
// and a column reference — which is what lets a field follow a subscript
// (`(arr)[1].f`, `a[1].f`). A subscript builds the node the postfix does, span
// and all; a field selection spans from `start`, the `(` included. A field name
// is read as a dotted name's parts are, so a reserved one must be quoted.
function parseIndirection(ctx: ParseContext<SqlTokenType>, base: Expr, start: Position): Expr {
  let expr = base;
  for (;;) {
    if (ctx.is("punc", "[")) {
      expr = subscriptNode(ctx, expr);
    } else if (ctx.eat("punc", ".") !== null) {
      const field = ctx.eat("op", "*") !== null ? null : ctx.parse(nameWord);
      expr = { kind: "fieldSelect", expr, field, span: ctx.spanFrom(start) };
    } else {
      return expr;
    }
  }
}

// `x COLLATE collation` (bp 17) and `x AT TIME ZONE zone` / `x AT LOCAL` (bp 16)
// sit below the unary sign, so `-x COLLATE "C"` is `(-x) COLLATE "C"`, and above
// `^`. The zone is read at bp 17: it takes a COLLATE but not another AT, so a
// chain of AT TIME ZONE nests to the left as PG's `%left AT` does. `at` is a
// bare label in PG, so the postfix declines unless TIME or LOCAL follows it,
// and `SELECT x at FROM t` keeps `at` as the alias. AT TIME commits to the
// zone, as in PG, where no alias is followed by TIME.
const collatePostfix = {
  match: kw("collate"),
  bp: 17,
  parse: (ctx: ParseContext<SqlTokenType>, left: Expr): Expr => {
    ctx.parse(kw("collate"));
    const collation = ctx.parse(qualName);
    return { kind: "collate", expr: left, collation, span: closeSpan(left, ctx.lastEnd()) };
  },
};
const atTimeZonePostfix = {
  match: kw("at"),
  bp: 16,
  when: (ctx: ParseContext<SqlTokenType>): boolean => isWordAhead(ctx, 1, "local") || isWordAhead(ctx, 1, "time"),
  parse: (ctx: ParseContext<SqlTokenType>, left: Expr, h: PrattHelpers<Expr>): Expr => {
    if (isWordAhead(ctx, 1, "local")) {
      ctx.parse(kwseq("at", "local"));
      return { kind: "atLocal", expr: left, span: closeSpan(left, ctx.lastEnd()) };
    }
    ctx.parse(kwseq("at", "time", "zone"));
    const zone = h.parseRhs(17);
    return { kind: "atTimeZone", expr: left, zone, span: closeSpan(left, ctx.lastEnd()) };
  },
};

// The comparison operators (`!=` is PG's spelling of `<>`), shared by the full
// expression's quantifiable comparison group and the b-expression's plain one.
const COMPARISON_OPS = ["<", ">", "<=", ">=", "=", "<>", "!="];

// `DISTINCT FROM x`, entered just past `IS [NOT]`. The RHS binds like a
// comparison operand (bp 9), so it stops before AND / OR but past tighter
// operators.
const isDistinctTail = (ctx: ParseContext<SqlTokenType>, left: Expr, h: PrattHelpers<Expr>, negated: boolean): Expr => {
  ctx.parse(kwseq("distinct", "from"));
  const from = h.parseRhs(9);
  return { kind: "isDistinct", expr: left, from, negated, span: closeSpan(left, ctx.lastEnd()) };
};

const notPrefix = {
  ops: ["not"],
  type: "ident" as const,
  bp: 6,
  // `NOT EXISTS (…)` folds into the exists node's `negated` flag rather than
  // wrapping it — mirroring how NOT IN / NOT LIKE carry their own negation.
  map: (_op: string, operand: Expr, span: Span): Expr =>
    operand.kind === "exists"
      ? { kind: "exists", query: operand.query, negated: !operand.negated, span }
      : { kind: "unary", op: "not", operand, span },
};

const expressionTable: PrattTable = {
  prefix: [unarySignPrefix, genericPrefix, notPrefix],
  infix: [
    // The quantified twins go first, so each plain group below still sees every
    // operator that no quantifier follows.
    ...arithInfix.filter((group) => group.bp > 12).map(quantifiedTwin),
    quantifiedGeneric,
    ...arithInfix,
    {
      // LIKE / ILIKE / SIMILAR TO. RHS at bp 11 keeps it out of the looser
      // comparison level; an optional `ESCAPE x` tail follows the pattern, or
      // the pattern is quantified (`LIKE ANY (…)`, which takes no ESCAPE).
      match: token("ident", { values: ["like", "ilike", "similar"] }),
      bp: 10,
      // `similar` is a bare label in PG, and SUBSTRING's SIMILAR form follows
      // its value with one: without TO it is no operator here.
      when: (ctx) => ctx.peek()!.value !== "similar" || isWordAhead(ctx, 1, "to"),
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
        if (isQuantifier(ctx.peek())) return quantifiedTail(ctx, op, left);
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
          if (isQuantifier(ctx.peek())) return quantifiedTail(ctx, `not ${op}`, left);
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
    // Same-precedence comparisons in one group: `a < b < c` errors, `(a < b) <
    // c` parses. A custom parse so the RHS can be quantified with ANY / ALL /
    // SOME (`x = ANY (array|subquery)`); otherwise it builds the ordinary binary
    // node with a bp-10 RHS. The chain check is done here rather than by
    // `assoc: "nonassoc"`, which would run after the quantified form too and
    // reject `x = ANY (a) = y` — legal in PG, since that form ends in its `)`.
    {
      ops: COMPARISON_OPS,
      bp: 9,
      type: "op",
      parse: (ctx, left, h): Expr => {
        const op = ctx.next()!.value;
        if (isQuantifier(ctx.peek())) return quantifiedTail(ctx, op, left);
        const right = h.parseRhs(10);
        const after = ctx.peek();
        if (after !== null && after.type === "op" && COMPARISON_OPS.includes(after.value)) {
          ctx.croak(`Operator "${after.value}" is non-associative`);
        }
        return { kind: "binary", op, left, right, span: closeSpan(left, ctx.lastEnd()) };
      },
    },
    kwBinary("and", 4),
    kwBinary("or", 2),
    operatorRefInfix(true),
    // Last, see genericInfix.
    genericInfix,
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
        if (ctx.is("ident", "distinct")) return isDistinctTail(ctx, left, h, negated);
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
        // IS [NOT] DOCUMENT and IS [NOT] [form] NORMALIZED. Like JSON, none of
        // these words may otherwise follow IS, so they need no guard.
        if (ctx.eat("ident", "document") !== null) {
          return { kind: "isDocument", expr: left, negated, span: closeSpan(left, ctx.lastEnd()) };
        }
        if (ctx.is("ident", ["normalized", ...NORMAL_FORMS])) {
          const form = (ctx.eat("ident", NORMAL_FORMS)?.value ?? null) as NormalForm | null;
          ctx.parse(kw("normalized"));
          return { kind: "isNormalized", expr: left, form, negated, span: closeSpan(left, ctx.lastEnd()) };
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
      // PG's postfix ISNULL / NOTNULL, spellings of IS [NOT] NULL at IS's own
      // precedence. Both words are AS_LABEL keywords in PG, so asAlias leaves
      // them alone and `SELECT a isnull FROM t` is the test, never an alias.
      match: fixedFirst(token("ident", { values: ["isnull", "notnull"] })),
      bp: 8,
      parse: (ctx, left): Expr => {
        const negated = ctx.next()!.value === "notnull";
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
};
const expressionAtom = withOperatorRefPrefix(() => tightExpression);
// In the bp-13 operand of a prefix `OPERATOR(…)`, a NOT anywhere an operand
// starts (`OPERATOR(-) NOT a = b`, `OPERATOR(-) a * NOT b`) is read here, its
// own operand by the table cut at NOT's bp 6 — exactly what the NOT prefix
// reads in the full table. `not` is reserved, so it never starts a name.
const notAtom = makeRule<Expr, SqlTokenType>({
  parse: (ctx) => {
    if (!ctx.is("ident", "not")) return expressionAtom.parse(ctx);
    const start = ctx.position();
    ctx.next(); // not
    return notPrefix.map("not", ctx.parse(notOperandExpression), ctx.spanFrom(start));
  },
  first: () => expressionAtom.first(),
  expected: (labels) => expressionAtom.expected(labels),
});
const tightExpression = pratt<Expr, SqlTokenType>({ atom: notAtom, ...cutTable(expressionTable, 13) });
const notOperandExpression = pratt<Expr, SqlTokenType>({ atom: expressionAtom, ...cutTable(expressionTable, 6) });
const expressionRule = pratt<Expr, SqlTokenType>({ atom: expressionAtom, ...expressionTable });

// The b-expression, PG's `b_expr`: the tight sublanguage (arithmetic / concat /
// JSON / cast / subscript), the plain comparisons, `IS [NOT] DISTINCT FROM` and
// `IS [NOT] DOCUMENT`, with none of NOT, AND / OR, IN, LIKE, BETWEEN, COLLATE,
// AT TIME ZONE / LOCAL, ANY / ALL or the other IS tests — see `bExpression`
// above. (OVERLAPS lives in the shared atom, so it is the one predicate that
// still reaches it.) A parenthesised operand is a full expression again, as in
// PG.
const bExprTable: PrattTable = {
  prefix: [unarySignPrefix, genericPrefix],
  infix: [
    ...arithInfix,
    {
      ops: COMPARISON_OPS,
      bp: 9,
      type: "op",
      assoc: "nonassoc",
      map: (op, left, right, span): Expr => ({ kind: "binary", op, left, right, span }),
    },
    operatorRefInfix(false),
    // Last, see genericInfix.
    genericInfix,
  ],
  postfix: [
    castPostfix,
    subscriptPostfix,
    {
      // IS takes only DISTINCT FROM and DOCUMENT here, so `5 IS NULL` stops at
      // NULL with an error, as PG's grammar does.
      match: kw("is"),
      bp: 8,
      parse: (ctx, left, h): Expr => {
        ctx.parse(kw("is"));
        const negated = ctx.eat("ident", "not") !== null;
        if (ctx.eat("ident", "document") !== null) {
          return { kind: "isDocument", expr: left, negated, span: closeSpan(left, ctx.lastEnd()) };
        }
        return isDistinctTail(ctx, left, h, negated);
      },
    },
  ],
};
const bExprAtom = withOperatorRefPrefix(() => tightBExpr);
const tightBExpr = pratt<Expr, SqlTokenType>({ atom: bExprAtom, ...cutTable(bExprTable, 13) });
const bExprRule = pratt<Expr, SqlTokenType>({ atom: bExprAtom, ...bExprTable });

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
//
// SET NULL and SET DEFAULT may name the columns they set, `(cols)`; nothing
// else can follow them with a `(`. PG's grammar reads the list after either
// verb and then rejects it on ON UPDATE, so this does too.
function parseForeignKeyTail(ctx: ParseContext<SqlTokenType>): ForeignKeyTail {
  const match =
    ctx.eat("ident", "match") !== null ? (ctx.parse(matchType).value as "full" | "partial" | "simple") : null;
  let onDelete: RefAction | null = null;
  let onDeleteColumns: string[] | null = null;
  let onUpdate: RefAction | null = null;
  while ((onDelete === null || onUpdate === null) && ctx.is("ident", "on")) {
    const start = ctx.position();
    ctx.next(); // ON
    if (onDelete === null && ctx.eat("ident", "delete") !== null) {
      onDelete = dispatch(REF_ACTIONS, REF_ACTION_EXPECTED, ctx);
      if (isSetAction(onDelete) && ctx.is("punc", "(")) onDeleteColumns = parseColumnNames(ctx);
    } else if (onUpdate === null && ctx.eat("ident", "update") !== null) {
      onUpdate = dispatch(REF_ACTIONS, REF_ACTION_EXPECTED, ctx);
      if (isSetAction(onUpdate) && ctx.is("punc", "(")) {
        parseColumnNames(ctx);
        return ctx.croak(
          `a column list with ${onUpdate.toUpperCase()} is only supported for ON DELETE actions`,
          start,
          ctx.lastEnd(),
        );
      }
    } else {
      const open = [...(onDelete === null ? ["delete"] : []), ...(onUpdate === null ? ["update"] : [])];
      return ctx.croak(`Expected ${quoteList(open)} but found ${describeFound(ctx.peek())}`);
    }
  }
  return {
    ...(match && { match }),
    onDelete,
    ...(onDeleteColumns && { onDeleteColumns }),
    ...(onUpdate && { onUpdate }),
  };
}

const isSetAction = (action: RefAction) => action === "set null" || action === "set default";

const initiallyWhen = oneOf(kw("deferred"), kw("immediate"));

// True when the cursor sits on `NOT <word>` — `NOT DEFERRABLE`, or at table
// level `NOT VALID`. Lexing is lazy, so the peek past `not` is taken only on a
// `not`: peeking on every token would raise the lex error of a token two on
// from inside the constraint handler, and diagnose() would drop the constraint
// — and the column — over a character the column never reaches. After a `not`
// in a column constraint there is nothing to save: NOT NULL would raise the
// same error on the same token. (At table level the tail meets a bad token
// inside the constraint rather than between items, so diagnose() keeps the
// table around it.)
function atNot(ctx: ParseContext<SqlTokenType>, word: string): boolean {
  if (!ctx.is("ident", "not")) return false;
  const next = ctx.peekAhead(1);
  return next !== null && next.type === "ident" && next.value === word;
}

// The constraint a table-level attribute list belongs to, spelled as PG's
// "%s constraints cannot be marked …" messages name it.
// ALTER TABLE's ALTER CONSTRAINT reads the same list, and PG names it "ALTER
// CONSTRAINT statement" there, refusing NOT VALID and NO INHERIT.
type ConstraintType = "PRIMARY KEY" | "UNIQUE" | "EXCLUDE" | "FOREIGN KEY" | "CHECK" | "ALTER CONSTRAINT statement";

// `[NOT] DEFERRABLE` and `INITIALLY DEFERRED | IMMEDIATE`, in either order. At
// column level only UNIQUE, PRIMARY KEY and REFERENCES read this tail, so PG's
// "misplaced DEFERRABLE clause" (`a int NOT NULL DEFERRABLE`) never parses.
//
// At table level every constraint reads PG's whole `ConstraintAttributeSpec`,
// which adds `NOT VALID` and `NO INHERIT`, and then judges it by the
// constraint's `type` as PG's processCASbits does: CHECK takes NOT VALID and NO
// INHERIT but nothing that makes it deferrable (NOT DEFERRABLE and INITIALLY
// IMMEDIATE are its defaults, so those pass); a foreign key takes NOT VALID;
// the index-backed ones take neither. NOT VALID and NO INHERIT may repeat, as
// in PG. That judgement comes after the whole list is read, so a contradiction
// within it is reported first, as in PG. Unlike PG, which points at the start
// of the list, the error sits on the clause refused.
//
// `not` is shared with a following column constraint's NOT NULL, so it is taken
// here only when `deferrable` (or, at table level, `valid`) comes next; a bare
// `ctx.eat("not")` would steal `a int UNIQUE NOT NULL`.
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
function parseConstraintAttrs(ctx: ParseContext<SqlTokenType>, level: "column"): ConstraintAttrs;
// A CHECK's attributes, which the CHECK judgement below keeps from deferring.
function parseConstraintAttrs(
  ctx: ParseContext<SqlTokenType>,
  level: "table",
  type: "CHECK",
): Omit<Extract<TableConstraint, { kind: "check" }>, "kind" | "name" | "expr" | "span">;
function parseConstraintAttrs(
  ctx: ParseContext<SqlTokenType>,
  level: "table",
  type: ConstraintType,
): TableConstraintAttrs;
function parseConstraintAttrs(
  ctx: ParseContext<SqlTokenType>,
  level: "column" | "table",
  type?: ConstraintType,
): TableConstraintAttrs {
  let deferrable: boolean | null = null;
  let initially: "deferred" | "immediate" | null = null;
  // Where each clause the constraint type may refuse was first written.
  let deferredAt: [Position, Position] | null = null;
  let notValidAt: [Position, Position] | null = null;
  let noInheritAt: [Position, Position] | null = null;
  while (true) {
    const start = ctx.position();
    if (level === "table" && atNot(ctx, "valid")) {
      ctx.parse(kwseq("not", "valid"));
      notValidAt ??= [start, ctx.lastEnd()];
      continue;
    }
    if (level === "table" && ctx.is("ident", "no")) {
      ctx.parse(kwseq("no", "inherit"));
      noInheritAt ??= [start, ctx.lastEnd()];
      continue;
    }
    const negated = atNot(ctx, "deferrable");
    let repeated: string;
    let conflicting: boolean;
    if (negated || ctx.is("ident", "deferrable")) {
      ctx.parse(negated ? kwseq("not", "deferrable") : kw("deferrable"));
      repeated = "multiple DEFERRABLE/NOT DEFERRABLE clauses not allowed";
      conflicting = deferrable !== null && (level === "column" || deferrable === negated);
      deferrable = !negated;
      if (!negated) deferredAt ??= [start, ctx.lastEnd()];
    } else if (ctx.eat("ident", "initially") !== null) {
      const when = ctx.parse(initiallyWhen).value as "deferred" | "immediate";
      repeated = "multiple INITIALLY IMMEDIATE/DEFERRED clauses not allowed";
      conflicting = initially !== null && (level === "column" || initially !== when);
      initially = when;
      if (when === "deferred") deferredAt ??= [start, ctx.lastEnd()];
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
  if (deferredAt !== null && type === "CHECK") {
    return ctx.croak(`${type} constraints cannot be marked DEFERRABLE`, ...deferredAt);
  }
  if (notValidAt !== null && type !== "CHECK" && type !== "FOREIGN KEY") {
    return ctx.croak(`${type} constraints cannot be marked NOT VALID`, ...notValidAt);
  }
  if (noInheritAt !== null && type !== "CHECK") {
    return ctx.croak(`${type} constraints cannot be marked NO INHERIT`, ...noInheritAt);
  }
  return {
    ...(deferrable !== null && { deferrable }),
    ...(initially && { initially }),
    ...(notValidAt && { notValid: true }),
    ...(noInheritAt && { noInherit: true }),
  };
}

// `NULLS [NOT] DISTINCT`, after UNIQUE or after an index's column list and
// INCLUDE. Nothing else may start with `nulls` in either place, so the word
// commits.
const nullsTreatment = seq(skip(kw("nulls")), field("not", optional(kw("not"))), skip(kw("distinct"))).map(
  (s): NullsTreatment => (s.not !== null ? "not distinct" : "distinct"),
);

const parseNullsTreatment = (ctx: ParseContext<SqlTokenType>): NullsTreatment | null =>
  ctx.is("ident", "nulls") ? ctx.parse(nullsTreatment) : null;

// A parenthesised list of at least one column, as PG's columnList: unlike
// the shared `columnList`, an empty `()` is a syntax error. INCLUDE and the
// ON DELETE SET NULL / SET DEFAULT list read it.
const nonEmptyColumnNames = sepBy(nameWord, P(","));

function parseColumnNames(ctx: ParseContext<SqlTokenType>): string[] {
  ctx.parse(punc("("));
  const columns = ctx.parse(nonEmptyColumnNames);
  expectClose(ctx);
  return columns;
}

// The index parameters of PRIMARY KEY, UNIQUE and EXCLUDE, in PG's fixed order
// (see IndexParams). INCLUDE exists only at table level. None of the lead
// words takes a name away: `with` and `using` are reserved, and after a
// constraint nothing else may follow with `include`.
function parseIndexParams(ctx: ParseContext<SqlTokenType>, level: "column" | "table"): IndexParams {
  const include = level === "table" && ctx.eat("ident", "include") !== null ? parseColumnNames(ctx) : null;
  const options = ctx.eat("ident", "with") !== null ? ctx.parse(relationOptions) : null;
  // PG reads these as a plain definition list, not reloptions, so an option
  // has no `namespace.` prefix here, though relationOptions, which other lists
  // share, accepts one. Its other leniencies (a missing `=`, list values) stay.
  const namespaced = options?.find((option) => option.namespace !== undefined);
  if (namespaced !== undefined) {
    return ctx.croak(
      `a constraint's index parameters take no namespace, but found "${namespaced.namespace}.${namespaced.name}"`,
      namespaced.span.start,
      namespaced.span.end,
    );
  }
  let indexTablespace: string | null = null;
  if (ctx.is("ident", "using")) {
    ctx.parse(kwseq("using", "index", "tablespace"));
    indexTablespace = ctx.parse(nameWord);
  }
  return {
    ...(include && { include }),
    ...(options && { options }),
    ...(indexTablespace !== null && { indexTablespace }),
  };
}

const generatedKind = oneOf(kw("stored"), kw("virtual"));

// The column constraints `CONSTRAINT name` may lead — every one but COLLATE.
const COLUMN_CONSTRAINT_ELEMS: DispatchMap<ColConstraintElem> = {
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
      return { kind: "default", expr: ctx.parse(bExpression), span: ctx.spanFrom(start) };
    },
  },
  primary: {
    expected: '"primary key"',
    parse: (ctx) => {
      const start = ctx.position();
      ctx.parse(kwseq("primary", "key"));
      const params = parseIndexParams(ctx, "column");
      const attrs = parseConstraintAttrs(ctx, "column");
      return { kind: "primaryKey", ...params, ...attrs, span: ctx.spanFrom(start) };
    },
  },
  unique: {
    parse: (ctx) => {
      const start = ctx.position();
      ctx.parse(kw("unique"));
      const nulls = parseNullsTreatment(ctx);
      const params = parseIndexParams(ctx, "column");
      const attrs = parseConstraintAttrs(ctx, "column");
      return { kind: "unique", ...(nulls && { nulls }), ...params, ...attrs, span: ctx.spanFrom(start) };
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
  // `CHECK (expr) [NO INHERIT]`. A column-level CHECK takes no other
  // attribute: NOT VALID exists only at table level, and NOT NULL takes no NO
  // INHERIT before PG 18.
  check: {
    parse: (ctx) => {
      const start = ctx.position();
      ctx.parse(kw("check"));
      const expr = ctx.parse(parenExpr);
      const noInherit = ctx.is("ident", "no");
      if (noInherit) ctx.parse(kwseq("no", "inherit"));
      return { kind: "check", expr, ...(noInherit && { noInherit: true as const }), span: ctx.spanFrom(start) };
    },
  },
  // `GENERATED {ALWAYS | BY DEFAULT} AS IDENTITY [(options)]` or `GENERATED
  // ALWAYS AS (expr) {STORED | VIRTUAL}`. The handler owns all of its
  // lookahead, so one key covers both forms. As in PG, BY DEFAULT is only for
  // identity columns. VIRTUAL is PG 18's, taken because schemas (pagila's
  // among them) write it; PG 18's bare form (no STORED or VIRTUAL) is still
  // rejected, as PG 17 does. The options take PG's identity-only `SEQUENCE
  // NAME`. GENERATED, ALWAYS, IDENTITY, STORED and VIRTUAL stay unreserved:
  // they are matched by value only, here and in ALTER COLUMN's identity actions.
  generated: {
    parse: (ctx) => {
      const start = ctx.position();
      ctx.parse(kw("generated"));
      const whenStart = ctx.position();
      const generated = parseGeneratedWhen(ctx);
      const whenEnd = ctx.lastEnd();
      ctx.parse(kw("as"));
      if (ctx.eat("ident", "identity") !== null) {
        const options = parseIdentityOptions(ctx);
        if (options === null) return { kind: "identity", generated, span: ctx.spanFrom(start) };
        return { kind: "identity", generated, options, span: ctx.spanFrom(start) };
      }
      if (!ctx.is("punc", "(")) {
        return ctx.croak(`Expected ${quoteList(["identity", "("])} but found ${describeFound(ctx.peek())}`);
      }
      const expr = ctx.parse(parenExpr);
      const virtual = ctx.parse(generatedKind).value === "virtual";
      // Judged once the clause is whole and pinned to the BY DEFAULT, as PG does.
      if (generated !== "always") {
        return ctx.croak("for a generated column, GENERATED ALWAYS must be specified", whenStart, whenEnd);
      }
      return { kind: "generated", expr, ...(virtual && { virtual: true as const }), span: ctx.spanFrom(start) };
    },
  },
};

// `ALWAYS | BY DEFAULT`, after GENERATED: a column's identity or generation
// clause, and ALTER TABLE's ADD GENERATED and SET GENERATED.
function parseGeneratedWhen(ctx: ParseContext<SqlTokenType>): "always" | "by default" {
  if (ctx.eat("ident", "always") !== null) return "always";
  if (!ctx.is("ident", "by")) {
    return ctx.croak(`Expected ${quoteList(["always", "by default"])} but found ${describeFound(ctx.peek())}`);
  }
  ctx.parse(kwseq("by", "default"));
  return "by default";
}

// The optional `(option …)` after AS IDENTITY, null when no `(` follows. At
// least one option, as in PG: an empty `IDENTITY ()` is an error.
function parseIdentityOptions(ctx: ParseContext<SqlTokenType>): SequenceOption[] | null {
  if (ctx.eat("punc", "(") === null) return null;
  const options = parseSequenceOptions(ctx, true);
  if (options.length === 0) ctx.croak(`Expected a sequence option but found ${describeFound(ctx.peek())}`);
  expectClose(ctx);
  return options;
}

const COLUMN_CONSTRAINT_ELEM_EXPECTED = joinExpected(COLUMN_CONSTRAINT_ELEMS);

const COLUMN_CONSTRAINTS: DispatchMap<ColConstraint> = {
  ...COLUMN_CONSTRAINT_ELEMS,
  // Column-level `COLLATE name`. `collate` is reserved, so it cannot be a type
  // word and, straight after the type, it can only be this. A DEFAULT's operand
  // is a b-expression, which has no COLLATE, so `DEFAULT 'a' COLLATE "C"`
  // collates the column, as in PG; `DEFAULT ('a' COLLATE "C")` collates the
  // default.
  collate: {
    parse: (ctx) => {
      const start = ctx.position();
      ctx.parse(kw("collate"));
      return { kind: "collate", collation: ctx.parse(qualName), span: ctx.spanFrom(start) };
    },
  },
  // `CONSTRAINT name` then any constraint but COLLATE. `constraint` is
  // reserved, so it takes no name away; after a column's type it can only lead
  // this. The span runs from CONSTRAINT.
  constraint: {
    parse: (ctx) => {
      const start = ctx.position();
      ctx.parse(kw("constraint"));
      const name = ctx.parse(nameWord);
      const elem = dispatch(COLUMN_CONSTRAINT_ELEMS, COLUMN_CONSTRAINT_ELEM_EXPECTED, ctx);
      return { ...elem, name, span: ctx.spanFrom(start) };
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
      const params = parseIndexParams(ctx, "table");
      const attrs = parseConstraintAttrs(ctx, "table", "PRIMARY KEY");
      return { kind: "primaryKey", name: null, columns, ...params, ...attrs, span: ctx.spanFrom(start) };
    },
  },
  unique: {
    parse: (ctx) => {
      const start = ctx.position();
      ctx.parse(kw("unique"));
      const nulls = parseNullsTreatment(ctx);
      const columns = ctx.parse(columnList);
      const params = parseIndexParams(ctx, "table");
      const attrs = parseConstraintAttrs(ctx, "table", "UNIQUE");
      return {
        kind: "unique",
        name: null,
        ...(nulls && { nulls }),
        columns,
        ...params,
        ...attrs,
        span: ctx.spanFrom(start),
      };
    },
  },
  check: {
    parse: (ctx) => {
      const start = ctx.position();
      ctx.parse(kw("check"));
      const expr = ctx.parse(parenExpr);
      const attrs = parseConstraintAttrs(ctx, "table", "CHECK");
      return { kind: "check", name: null, expr, ...attrs, span: ctx.spanFrom(start) };
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
      const attrs = parseConstraintAttrs(ctx, "table", "FOREIGN KEY");
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

// At least one entry, as in PG: an empty `EXCLUDE ()` is a syntax error.
const exclusionElements = sepBy(exclusionElement, P(","));

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

// `EXCLUDE [USING method] (element WITH operator, …)`, the index parameters,
// `[WHERE (pred)]` and the attribute tail. Kept out of TABLE_CONSTRAINTS on
// purpose: `exclude` is unreserved, and a key there would join tableItem's
// value-specific first set and take the word away from columns (see tableItem).
const excludeBody = custom<ExcludeConstraint, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    ctx.parse(kw("exclude"));
    const using = ctx.eat("ident", "using") !== null ? ctx.parse(nameWord) : null;
    ctx.parse(punc("("));
    const elements = ctx.parse(exclusionElements);
    expectClose(ctx);
    const params = parseIndexParams(ctx, "table");
    const where = ctx.eat("ident", "where") !== null ? ctx.parse(parenExpr) : null;
    const attrs = parseConstraintAttrs(ctx, "table", "EXCLUDE");
    return {
      kind: "exclude",
      name: null,
      using,
      elements,
      ...params,
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

// An element led by `exclude`: an EXCLUDE constraint when the lookahead says
// so, else `column` — the column definition of a table body, or the column
// options of a PARTITION OF list — for a column called `exclude`. Decided by
// peeking rather than by `attempt`, so a malformed EXCLUDE reports its own error
// — a backtrack would drop it, and a lex error inside it for good, then blame
// the column instead.
const excludeOr = <T>(column: Rule<T, SqlTokenType>) =>
  custom<ExcludeConstraint | T, SqlTokenType>(
    (ctx) => (atExcludeConstraint(ctx) ? ctx.parse(excludeBody) : ctx.parse(column)),
    { expected: '"exclude"', first: [{ type: "ident", value: "exclude" }] },
  );
const excludeItem = excludeOr(columnDef);

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
// MATERIALIZED VIEW and on REFRESH MATERIALIZED VIEW. Returns true (WITH DATA),
// false (WITH NO DATA), or null when no clause follows. The preceding query
// does not usually consume it (WITH DATA is not a query continuation, and
// typeRef takes a WITH only as `WITH TIME ZONE`), so a bare `ctx.is("with")`
// peek is enough here. Two query endings do take a WITH unconditionally, and so
// leave none for this clause: a trailing `IS JSON` (its uniqueness clause, as in
// PG) and a FETCH clause not closed by ONLY (its WITH TIES).
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
// same list and rejects a value only in analysis.) A constraint's index
// parameters refuse the namespace afterwards (see parseIndexParams).
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
    const text = ctx.next()!.value;
    return numberNode(text, ctx.spanFrom(start), sign);
  }
  if (tok?.type === "number") return numberNode(ctx.next()!.value, ctx.spanFrom(start));
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
// is one of those too, but its node is a `::` cast's as well, so
// isBareFuncExpr tells the two apart by the lead word instead.
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

// Whether `expr`, read unparenthesised, is one of the forms BARE_PARTITION_KEYS
// describes: CREATE STATISTICS's items take the same ones. `castCall` says the
// expression was led by `cast`; a `CAST(…)` is then a cast node whose operand
// starts after it, where `CAST(a AS int)::text`'s outer cast has its operand
// start where it does.
function isBareFuncExpr(expr: Expr, castCall: boolean): boolean {
  if (expr.kind === "cast") {
    const operand = expr.expr.span.start;
    return castCall && (operand.row !== expr.span.start.row || operand.col !== expr.span.start.col);
  }
  return BARE_PARTITION_KEYS.has(expr.kind) && !(expr.kind === "name" && expr.parts.length > 1);
}

// `column | func(…) | (expr)`, then `[COLLATE collation] [opclass]`. A bare key
// goes through the full expression rule, whose COLLATE postfix takes the
// collation; it is lifted off the node here, since in PG it belongs to the key,
// not the expression. Anything else unparenthesised — `a + b`, `t.a`, `a::int`
// — is PG's syntax error, and so is it here (see isBareFuncExpr).
// ON CONFLICT's arbiter elements share this reader, under their own `what`.
function partitionKey(ctx: ParseContext<SqlTokenType>, what = "a partition key"): PartitionKey {
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
    if (!isBareFuncExpr(expr, castCall)) {
      return ctx.croak(`${what} expression must be parenthesised`, start, ctx.lastEnd());
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

const partitionItem = oneOf(tableConstraint, excludeOr(columnOptions), columnOptions);

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
  // PG's relation_expr: `[ONLY] name [*]` or `ONLY (name)`. lazy() because the
  // rule is defined further down.
  field(
    "table",
    lazy(() => relationExpr),
  ),
  field("using", optional(seq(skip(kw("using")), field("m", nameWord)).map((s) => s.m))),
  field("columns", indexColumns),
  // `INCLUDE (col, …)` covering columns — plain names, kept null when absent.
  field("include", optional(seq(skip(kw("include")), field("cols", columnList)).map((s) => s.cols))),
  field("nulls", optional(nullsTreatment)),
  // `WITH (storage_parameter = value, …)`, omitted when absent. `with` is
  // reserved, so it cannot be the start of anything else here.
  field("options", optional(seq(skip(kw("with")), field("o", relationOptions)).map((s) => s.o))),
  // `TABLESPACE name`; no table clause can follow an index's column list, so
  // the word commits.
  field("tablespace", optional(seq(skip(kw("tablespace")), field("t", nameWord)).map((s) => s.t))),
  field("where", optional(seq(skip(kw("where")), field("e", expression)).map((s) => s.e))),
).map(
  (
    { unique, concurrently, ifNotExists, name, table, using, columns, include, nulls, options, tablespace, where },
    span,
  ): Stmt => ({
    kind: "createIndex",
    unique,
    concurrently,
    ifNotExists,
    name,
    table: table.name,
    ...(table.only && { only: true }),
    using,
    columns,
    include,
    ...(nulls !== null && { nulls }),
    ...(options !== null && { options }),
    ...(tablespace !== null && { tablespace }),
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
    // `( definition )` is a base type; nothing at all, a shell type.
    if (ctx.is("punc", "(")) {
      return { kind: "createType", form: "base", name, definition: parseDefinition(ctx), span: ctx.spanFrom(start) };
    }
    if (ctx.peek() === null || ctx.is("punc", ";")) {
      return { kind: "createType", form: "shell", name, span: ctx.spanFrom(start) };
    }
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
// `SEQUENCE NAME name` is taken only where `identity` says so: PG writes it
// for an identity column's sequence, and refuses it on CREATE / ALTER
// SEQUENCE.
function parseSequenceOptions(ctx: ParseContext<SqlTokenType>, identity = false): SequenceOption[] {
  const options: SequenceOption[] = [];
  for (let option = parseSequenceOption(ctx, identity); option !== null; option = parseSequenceOption(ctx, identity)) {
    options.push(option);
  }
  return options;
}

// One sequence option, or null — consuming nothing — when none starts here.
function parseSequenceOption(ctx: ParseContext<SqlTokenType>, identity: boolean): SequenceOption | null {
  if (ctx.eat("ident", "as") !== null) return { kind: "as", type: ctx.parse(typeRef) };
  if (ctx.eat("ident", "increment") !== null) {
    ctx.eat("ident", "by"); // optional BY
    return { kind: "increment", value: ctx.parse(expression) };
  }
  if (ctx.eat("ident", "minvalue") !== null) return { kind: "minValue", value: ctx.parse(expression) };
  if (ctx.eat("ident", "maxvalue") !== null) return { kind: "maxValue", value: ctx.parse(expression) };
  if (ctx.eat("ident", "start") !== null) {
    ctx.eat("ident", "with"); // optional WITH
    return { kind: "start", value: ctx.parse(expression) };
  }
  if (ctx.eat("ident", "restart") !== null) return parseRestartValue(ctx);
  if (ctx.eat("ident", "cache") !== null) return { kind: "cache", value: ctx.parse(expression) };
  if (ctx.eat("ident", "cycle") !== null) return { kind: "cycle", value: true };
  if (ctx.is("ident", "no")) {
    const after = ctx.peekAhead(1)?.value;
    if (after === "minvalue") {
      ctx.parse(kwseq("no", "minvalue"));
      return { kind: "minValue", value: null };
    }
    if (after === "maxvalue") {
      ctx.parse(kwseq("no", "maxvalue"));
      return { kind: "maxValue", value: null };
    }
    if (after === "cycle") {
      ctx.parse(kwseq("no", "cycle"));
      return { kind: "cycle", value: false };
    }
    return null; // some other NO … — not a sequence option
  }
  if (ctx.is("ident", "owned")) {
    ctx.parse(kwseq("owned", "by"));
    return { kind: "ownedBy", owner: ctx.eat("ident", "none") !== null ? null : ctx.parse(qualName) };
  }
  if (identity && ctx.is("ident", "sequence")) {
    ctx.parse(kwseq("sequence", "name"));
    return { kind: "sequenceName", name: ctx.parse(qualName) };
  }
  return null;
}

// The rest of a RESTART once the word is consumed: RESTART, RESTART n, or
// RESTART WITH n. A bare RESTART (no value) is followed by another option word
// (an ident) or the end, so only a numeric start (a number, or a signed
// `-`/`+`) counts as the restart value — otherwise `RESTART CACHE 5` would read
// `CACHE` as an expression.
function parseRestartValue(ctx: ParseContext<SqlTokenType>): Extract<SequenceOption, { kind: "restart" }> {
  const withKw = ctx.eat("ident", "with") !== null;
  const hasValue = withKw || ctx.is("number") || ctx.is("op", "-") || ctx.is("op", "+");
  return { kind: "restart", value: hasValue ? ctx.parse(expression) : null };
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
      constraints.push({ kind: "default", expr: ctx.parse(bExpression) });
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
// reserved and so matched by value ahead of `nameWord`. OWNER TO and GRANT's
// grantees take it too.
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
// few — and bar the words that lead ALTER DATABASE's other actions, which are
// keywords to PG and never an option's name. OWNER is an option name, but never
// before TO, which is reserved and so no value.
const DATABASE_ACTION_WORDS: ReadonlySet<string> = new Set(["rename", "set", "reset", "refresh"]);
function isDatabaseOptionStart(ctx: ParseContext<SqlTokenType>): boolean {
  const tok = ctx.peek();
  if (tok?.type === "qident") return true;
  return tok?.type === "ident" && !RESERVED.has(tok.value) && !DATABASE_ACTION_WORDS.has(tok.value);
}

function parseDatabaseOption(ctx: ParseContext<SqlTokenType>): RelationOption {
  const next = ctx.peekAhead(1);
  if (ctx.is("ident", "owner") && isWordAhead(ctx, 1, "to")) {
    ctx.next(); // OWNER
    return ctx.croak(`Expected an option value but found ${describeFound(ctx.peek())}`);
  }
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

// A string or a word, PG's NonReservedWord_or_Sconst: an extension version, a
// security label provider.
function parseWordOrString(ctx: ParseContext<SqlTokenType>): string {
  return ctx.is("string") ? ctx.next()!.value : ctx.parse(nameWord);
}

// `SCHEMA s`, `VERSION v` and `CASCADE`, in any order, after an optional WITH.
function parseExtensionOptions(ctx: ParseContext<SqlTokenType>): ExtensionOption[] {
  ctx.eat("ident", "with");
  const options: ExtensionOption[] = [];
  while (true) {
    if (ctx.eat("ident", "schema") !== null) {
      options.push({ kind: "schema", schema: ctx.parse(nameWord) });
    } else if (ctx.eat("ident", "version") !== null) {
      options.push({ kind: "version", version: parseWordOrString(ctx) });
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

// PG's SignedIconst: an integer constant with an optional sign of its own —
// CREATE ROLE's CONNECTION LIMIT, and a cursor's FETCH / MOVE count, which
// names itself `what` in the croak.
const isSign = (tok: Token<SqlTokenType> | null): boolean =>
  tok !== null && tok.type === "op" && (tok.value === "-" || tok.value === "+");
function parseSignedInt(ctx: ParseContext<SqlTokenType>, what = "an integer"): number {
  const sign = isSign(ctx.peek()) ? ctx.next()!.value : null;
  const tok = ctx.peek();
  if (!isIntegerConstant(tok)) return ctx.croak(`Expected ${what} but found ${describeFound(tok)}`);
  const value = Number(ctx.next()!.value);
  return sign === "-" ? -value : value;
}

// One CREATE ROLE option, or null when the next token leads none. Every option
// word is matched by value and stays unreserved (bar `in`, `group`, `limit`,
// `null` and `user`, reserved already); the list has no delimiter, so it simply
// runs until a word leads no option. PG's legacy spellings `IN GROUP` and
// `USER` read as `IN ROLE` and `ROLE`; its SYSID is not taken. With `alter`,
// the membership options (IN ROLE, ROLE, USER, ADMIN) lead none: ALTER ROLE
// takes none of them in PG bar an undocumented USER, which is not taken here.
const MEMBERSHIP_OPTIONS: ReadonlySet<string> = new Set(["in", "role", "user", "admin"]);
function parseRoleOption(ctx: ParseContext<SqlTokenType>, alter = false): RoleOption | null {
  const tok = ctx.peek();
  if (tok === null || tok.type !== "ident" || (alter && MEMBERSHIP_OPTIONS.has(tok.value))) return null;
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

// `CREATE {ROLE|USER|GROUP} name [[WITH] option …]` — the lead word is consumed
// here, as every PLAIN_CREATE handler's is.
function createRoleRest(ctx: ParseContext<SqlTokenType>, lead: "role" | "user" | "group"): Stmt {
  const start = ctx.position();
  ctx.parse(kw(lead));
  const name = ctx.parse(nameWord);
  // `with` is reserved, so it can only open the list.
  ctx.eat("ident", "with");
  const options: RoleOption[] = [];
  for (let option = parseRoleOption(ctx); option !== null; option = parseRoleOption(ctx)) options.push(option);
  const user = lead === "user";
  const span = ctx.spanFrom(start);
  return lead === "group"
    ? { kind: "createRole", user, group: true, name, options, span }
    : { kind: "createRole", user, name, options, span };
}

// `WITH [CASCADED | LOCAL] CHECK OPTION` after a plain view's query, or null.
// The query leaves a trailing WITH alone (see parseWithData), and nothing else
// can follow it there, so a WITH commits; the word after it is peeked first,
// so one that leads no check option croaks where it stands.
const CHECK_OPTION_WORDS = ["cascaded", "local", "check"];
function parseCheckOption(ctx: ParseContext<SqlTokenType>): "cascaded" | "local" | null {
  if (!ctx.is("ident", "with")) return null;
  const word = ctx.peekAhead(1);
  ctx.next(); // WITH
  if (word?.type !== "ident" || !CHECK_OPTION_WORDS.includes(word.value)) {
    return ctx.croak(`Expected ${quoteList(CHECK_OPTION_WORDS)} but found ${describeFound(word)}`);
  }
  const level = word.value === "check" ? "cascaded" : (ctx.next()!.value as "cascaded" | "local");
  ctx.parse(kw("check"));
  ctx.parse(kw("option"));
  return level;
}

// The body of a (MATERIALIZED) VIEW after the VIEW keyword: `[IF NOT EXISTS] name
// [(cols)] [WITH (option, …)] AS query`, then WITH [NO] DATA on a materialized
// view or a check option on a plain one. The query reuses the shared `query`
// rule. `with` is reserved, so before AS it can only open the option list.
function parseViewBody(
  ctx: ParseContext<SqlTokenType>,
  start: Position,
  materialized: boolean,
  orReplace: boolean,
): Stmt {
  const ifNotExists = materialized && ctx.parse(optional(attempt(kwseq("if", "not", "exists")))) !== null;
  const name = ctx.parse(qualName);
  const columns = ctx.is("punc", "(") ? ctx.parse(columnList) : null;
  const options = ctx.eat("ident", "with") !== null ? ctx.parse(relationOptions) : null;
  ctx.parse(kw("as"));
  const q = ctx.parse(query);
  const withData = materialized ? parseWithData(ctx) : null;
  const checkOption = materialized ? null : parseCheckOption(ctx);
  return {
    kind: "createView",
    materialized,
    orReplace,
    ifNotExists,
    name,
    columns,
    query: q,
    withData,
    ...(options !== null && { options }),
    ...(checkOption !== null && { checkOption }),
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
// `allowDefault` is false for a reference to an existing routine (DROP, ALTER),
// whose signature names types only: PG refuses a default there, so one is
// croaked at its own DEFAULT / `=`.
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
  // take `a` for the type and then croak on `integer`. A leading SETOF is never
  // a name either: PG's argument names exclude its column-name keywords, so
  // `f(setof int)` is one unnamed argument of type `setof int`.
  let name: string | null = null;
  const c2 = ctx.peek();
  const n2 = ctx.peekAhead(1);
  if (
    c2 !== null &&
    (c2.type === "ident" || c2.type === "qident") &&
    n2 !== null &&
    (n2.type === "ident" || n2.type === "qident") &&
    !(c2.type === "ident" && c2.value === "setof") &&
    !startsMultiWordType(ctx, c2)
  ) {
    name = ctx.parse(nameWord);
  }
  const type = ctx.parse(typeRef);
  let defaultValue: Expr | null = null;
  if (!allowDefault && (ctx.is("ident", "default") || ctx.is("op", "="))) {
    ctx.croak(`A routine reference takes no argument defaults, but found ${describeFound(ctx.peek())}`);
  }
  if (ctx.eat("ident", "default") !== null || ctx.eat("op", "=") !== null) {
    defaultValue = ctx.parse(expression);
  }
  return { mode, name, type, defaultValue };
}

// The parenthesised argument signature — possibly empty `()`. CREATE takes
// argument defaults; DROP's and ALTER's `refFunctionArgs` does not.
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
const refFunctionArgs = signatureArgs(false);

// `RETURNS [SETOF] type` | `RETURNS TABLE (col type, …)`, or null when absent.
function parseFunctionReturns(ctx: ParseContext<SqlTokenType>): FunctionReturns | null {
  if (ctx.eat("ident", "returns") === null) return null;
  if (ctx.eat("ident", "table") !== null) {
    return { kind: "table", columns: ctx.parse(compositeAttrs) };
  }
  const setof = ctx.eat("ident", "setof") !== null;
  // typeRef takes a SETOF of its own, but PG's Typename has room for one; a
  // second is refused before typeRef reads it (peeking only what it would).
  if (setof && ctx.is("ident", "setof")) {
    const after = ctx.peekAhead(1);
    if (after !== null && (after.type === "qident" || (after.type === "ident" && !RESERVED.has(after.value)))) {
      ctx.croak(`Expected a type name but found "setof"`);
    }
  }
  return { kind: "type", setof, type: ctx.parse(typeRef) };
}

// `[EXTERNAL] SECURITY {DEFINER|INVOKER}` — returns whether it is a definer.
function parseSecurityKind(ctx: ParseContext<SqlTokenType>): boolean {
  if (ctx.eat("ident", "definer") !== null) return true;
  if (ctx.eat("ident", "invoker") !== null) return false;
  return ctx.croak(`Expected "definer" or "invoker" but found ${describeFound(ctx.peek())}`);
}

// --- configuration parameters (SET / SHOW / RESET, and a routine's SET) ---

// A dotted config parameter name (`search_path`, `my.custom.guc`) → one string.
const configName = sepBy(nameWord, P(".")).map((parts) => parts.join("."));

// Whether the token `n` ahead is the bare (unquoted) word `value`.
const isWordAhead = (ctx: ParseContext<SqlTokenType>, n: number, value: string): boolean => {
  const tok = ctx.peekAhead(n);
  return tok !== null && tok.type === "ident" && tok.value === value;
};

// The words RESERVED holds that PG does not reserve (its type_func_name
// keywords, plus SET and VALUES), so PG's NonReservedWord still admits them as
// a SET value.
const CONFIG_VALUE_WORDS: ReadonlySet<string> = new Set([
  "cross",
  "full",
  "inner",
  "is",
  "join",
  "left",
  "like",
  "natural",
  "right",
  "set",
  "tablesample",
  "values",
]);

// PG reserved words RESERVED lacks, kept out of a SET value.
const CONFIG_RESERVED_WORDS: ReadonlySet<string> = new Set(["current_catalog", "system_user"]);

// A string, or a word (→ a name) of the kind `mode` allows:
// - "word": PG's NonReservedWord_or_Sconst, a non-reserved or quoted word;
// - "value": also ON (a name, like OFF) and TRUE / FALSE (bool nodes), which
//   PG's opt_boolean_or_string adds because all three are reserved;
// - "zone": zone_value's IDENT, so not the CONFIG_VALUE_WORDS keywords either.
// Null when the next token is none of these.
function configWordOrString(ctx: ParseContext<SqlTokenType>, mode: "word" | "value" | "zone"): Expr | null {
  const start = ctx.position();
  const tok = ctx.peek();
  if (tok?.type === "string") return ctx.parse(stringLit);
  const booleans = mode === "value";
  if (booleans && tok?.type === "ident" && (tok.value === "true" || tok.value === "false")) return ctx.parse(boolLit);
  const word =
    tok?.type === "qident" ||
    (tok?.type === "ident" &&
      !CONFIG_RESERVED_WORDS.has(tok.value) &&
      (!RESERVED.has(tok.value) ||
        (mode !== "zone" && CONFIG_VALUE_WORDS.has(tok.value)) ||
        (booleans && tok.value === "on")));
  if (!word) return null;
  ctx.next();
  return { kind: "name", parts: [tok.value], span: ctx.spanFrom(start) };
}

// PG's NumericOnly: a number, a leading sign included (kept as a `unary` node,
// as an expression would). Null when no number follows.
function configNumber(ctx: ParseContext<SqlTokenType>): Expr | null {
  const start = ctx.position();
  const tok = ctx.peek();
  if (tok?.type === "op" && (tok.value === "-" || tok.value === "+") && ctx.peekAhead(1)?.type === "number") {
    ctx.next(); // the sign
    const operand = ctx.parse(numberLit);
    return { kind: "unary", op: tok.value, operand, span: ctx.spanFrom(start) };
  }
  return tok?.type === "number" ? ctx.parse(numberLit) : null;
}

// One value of a SET list, as PG's var_value: a number, a string, ON / OFF /
// TRUE / FALSE, or a word. Never a general expression: PG rejects `SET x = 1 +
// 2` and `SET x = a.b`.
const varValue = (ctx: ParseContext<SqlTokenType>): Expr =>
  configNumber(ctx) ??
  configWordOrString(ctx, "value") ??
  ctx.croak(`Expected a parameter value but found ${describeFound(ctx.peek())}`);

// The value of SET ROLE and SET SESSION AUTHORIZATION.
const configWord = (ctx: ParseContext<SqlTokenType>): Expr =>
  configWordOrString(ctx, "word") ?? ctx.croak(`Expected a name or a string but found ${describeFound(ctx.peek())}`);

// A bare string, for the forms PG writes as `Sconst`.
const configString = (ctx: ParseContext<SqlTokenType>): Expr => {
  if (!ctx.is("string")) return ctx.croak(`Expected a string but found ${describeFound(ctx.peek())}`);
  return ctx.parse(stringLit);
};

// The value of `SET TIME ZONE`, PG's zone_value: LOCAL and DEFAULT (both mean
// the default, so both → "default"), `INTERVAL 'value' [HOUR [TO MINUTE]]`, or
// a number, string or word. (The `INTERVAL(p) 'value'` spelling is not parsed.)
// The interval goes through columnRef's INTERVAL-literal branch, which an
// `interval` followed by a string always takes.
function zoneValue(ctx: ParseContext<SqlTokenType>): Expr[] | "default" {
  if (ctx.eat("ident", "local") !== null || ctx.eat("ident", "default") !== null) return "default";
  if (ctx.is("ident", "interval") && ctx.peekAhead(1)?.type === "string") {
    const start = ctx.position();
    const interval = ctx.parse(columnRef);
    if (interval.kind === "interval" && interval.fields !== undefined && !/^hour( to minute)?$/.test(interval.fields)) {
      ctx.croak(
        `A time zone interval must be HOUR or HOUR TO MINUTE, but found ${interval.fields.toUpperCase()}`,
        start,
      );
    }
    return [interval];
  }
  const value = configNumber(ctx) ?? configWordOrString(ctx, "zone");
  return value !== null ? [value] : ctx.croak(`Expected a time zone but found ${describeFound(ctx.peek())}`);
}

// Whether the token after the current one (or after the one `at` tokens on) is
// `=`, `.`, TO or FROM — what follows (part of) a parameter name in a generic
// SET, and never a special form's second word. PG reads `SET session TO 1` and
// `SET role.x = 1` that way.
const isGenericSet = (ctx: ParseContext<SqlTokenType>, at = 0): boolean => {
  const tok = ctx.peekAhead(at + 1);
  return (
    (tok?.type === "op" && tok.value === "=") ||
    (tok?.type === "punc" && tok.value === ".") ||
    isWordAhead(ctx, at + 1, "to") ||
    isWordAhead(ctx, at + 1, "from")
  );
};

type ConfigSet = { name: string; values: Expr[] | "default" | "fromCurrent" };

// PG's set_rest_more, shared by the SET statement and a routine's SET option:
// `name {= | TO} {value[, …] | DEFAULT}`, `name FROM CURRENT`, or one of the
// operator-less special forms (TIME ZONE, SCHEMA, NAMES, ROLE, SESSION
// AUTHORIZATION, XML OPTION, TRANSACTION SNAPSHOT). A form's lead word is a
// parameter name too, read as one when isGenericSet says so (`SET role TO x`).
function parseConfigSet(ctx: ParseContext<SqlTokenType>): ConfigSet {
  const lead = ctx.peek();
  const generic = isGenericSet(ctx);
  if (lead?.type === "ident" && !generic) {
    switch (lead.value) {
      case "time":
        if (!isWordAhead(ctx, 1, "zone")) break;
        ctx.parse(kwseq("time", "zone"));
        return { name: "time zone", values: zoneValue(ctx) };
      case "schema":
        ctx.next();
        return { name: "schema", values: [configString(ctx)] };
      case "names":
        // `NAMES` alone, like `NAMES DEFAULT`, resets the client encoding.
        ctx.next();
        if (ctx.is("string")) return { name: "names", values: [ctx.parse(stringLit)] };
        ctx.eat("ident", "default");
        return { name: "names", values: "default" };
      case "role":
        ctx.next();
        return { name: "role", values: [configWord(ctx)] };
      case "session":
        if (!isWordAhead(ctx, 1, "authorization")) break;
        ctx.parse(kwseq("session", "authorization"));
        if (ctx.eat("ident", "default") !== null) return { name: "session authorization", values: "default" };
        return { name: "session authorization", values: [configWord(ctx)] };
      case "xml": {
        if (!isWordAhead(ctx, 1, "option")) break;
        ctx.parse(kwseq("xml", "option"));
        const start = ctx.position();
        const tok = ctx.peek();
        if (tok?.type !== "ident" || (tok.value !== "document" && tok.value !== "content")) {
          return ctx.croak(`Expected "document" or "content" but found ${describeFound(tok)}`);
        }
        ctx.next();
        return { name: "xml option", values: [{ kind: "name", parts: [tok.value], span: ctx.spanFrom(start) }] };
      }
      case "transaction":
        if (!isWordAhead(ctx, 1, "snapshot")) break;
        ctx.parse(kwseq("transaction", "snapshot"));
        return { name: "transaction snapshot", values: [configString(ctx)] };
    }
  }
  const name = ctx.parse(configName);
  if (ctx.eat("ident", "from") !== null) {
    ctx.parse(kw("current"));
    return { name, values: "fromCurrent" };
  }
  if (ctx.eat("op", "=") === null && ctx.eat("ident", "to") === null) {
    ctx.croak(`Expected "to" or "=" but found ${describeFound(ctx.peek())}`);
  }
  if (ctx.eat("ident", "default") !== null) return { name, values: "default" };
  return { name, values: commaList(ctx, varValue) };
}

// The target of SHOW and RESET: ALL, one of the multi-word forms (TIME ZONE,
// TRANSACTION ISOLATION LEVEL, SESSION AUTHORIZATION, joined by spaces), or a
// parameter name. Each form's lead word is also a parameter name, so the form
// is taken only when its second word follows.
function parseConfigTarget(ctx: ParseContext<SqlTokenType>): string {
  if (ctx.eat("ident", "all") !== null) return "all";
  if (ctx.is("ident", "time") && isWordAhead(ctx, 1, "zone")) {
    ctx.parse(kwseq("time", "zone"));
    return "time zone";
  }
  if (ctx.is("ident", "transaction") && isWordAhead(ctx, 1, "isolation")) {
    ctx.parse(kwseq("transaction", "isolation", "level"));
    return "transaction isolation level";
  }
  if (ctx.is("ident", "session") && isWordAhead(ctx, 1, "authorization")) {
    ctx.parse(kwseq("session", "authorization"));
    return "session authorization";
  }
  return ctx.parse(configName);
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
        const { name, values } = parseConfigSet(ctx);
        const value: FunctionSetValue =
          values === "default" || values === "fromCurrent" ? { kind: values } : { kind: "list", values };
        options.push({ kind: "set", parameter: name, value });
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
// DROP and ALTER pass the default-free `refFunctionArgs` as `args`.
function parseAggregateSignature(ctx: ParseContext<SqlTokenType>, args = functionArgs): DropSignature {
  if (ctx.is("punc", "(") && ctx.peekAhead(1)?.type === "op" && ctx.peekAhead(1)?.value === "*") {
    ctx.next(); // "("
    ctx.next(); // "*"
    expectClose(ctx);
    return { star: true, args: [] };
  }
  return { star: false, args: ctx.parse(args) };
}

type RoutineRef = { name: string[]; signature: DropSignature | null };

// A function or procedure name, with its argument list when one is written:
// how DROP and ALTER name an existing routine, so its argument types take no
// defaults (see refFunctionArgs).
const routineRef = custom<RoutineRef, SqlTokenType>(
  (ctx) => {
    const name = ctx.parse(qualName);
    const signature = ctx.is("punc", "(") ? { star: false, args: ctx.parse(refFunctionArgs) } : null;
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
    return { name, signature: parseAggregateSignature(ctx, refFunctionArgs) };
  },
  { expected: "a name", first: [{ type: "ident" }, { type: "qident" }] },
);

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
  // PG's TriggerFuncArgs may be empty, unlike exprList's other users.
  let execArgs: Expr[] = [];
  if (ctx.is("punc", "(") && isPuncToken(ctx.peekAhead(1), ")")) {
    ctx.next(); // "("
    ctx.next(); // ")"
  } else {
    execArgs = ctx.parse(exprList);
  }
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
  role: { parse: (ctx) => createRoleRest(ctx, "role") },
  user: { parse: (ctx) => createRoleRest(ctx, "user") },
  group: { parse: (ctx) => createRoleRest(ctx, "group") },
  policy: { parse: createPolicyRest },
  publication: { parse: createPublicationRest },
  subscription: { parse: createSubscriptionRest },
  cast: { parse: createCastRest },
  collation: { parse: createCollationRest },
  default: { parse: createConversionRest },
  conversion: { parse: createConversionRest },
  statistics: { parse: createStatisticsRest },
  event: { parse: createEventTriggerRest },
  access: { parse: createAccessMethodRest },
  text: { parse: createTextSearchRest },
  operator: { parse: createOperatorRest },
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
  language: { parse: (ctx, start, orReplace) => parseLanguageBody(ctx, start, orReplace, "language") },
  trusted: { parse: (ctx, start, orReplace) => parseLanguageBody(ctx, start, orReplace, "trusted") },
  procedural: { parse: (ctx, start, orReplace) => parseLanguageBody(ctx, start, orReplace, "procedural") },
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
// (VIEW / MATERIALIZED VIEW / FUNCTION / PROCEDURE / AGGREGATE / TRIGGER /
// [TRUSTED] [PROCEDURAL] LANGUAGE) — or, with no such prefix, one of the
// remaining keyword-led targets (TABLE / [UNIQUE] INDEX / TYPE / SEQUENCE /
// DOMAIN / DATABASE / SCHEMA / EXTENSION / TABLESPACE / ROLE / USER / POLICY /
// PUBLICATION / SUBSCRIPTION, and CAST, COLLATION, CONVERSION, OPERATOR and the
// other PLAIN_CREATE keys), TABLE alone taking the TEMP / UNLOGGED prefix. `OR
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

// `[IF NOT EXISTS] column-def`, the tail of `ADD [COLUMN]`. IF NOT EXISTS is
// peeked by parseIfNotExists rather than tried by `attempt`, so a column that
// happens to be called `if` costs no backtrack: `not` is reserved, so an
// unquoted one can never be the type of such a column.
function parseAddColumn(ctx: ParseContext<SqlTokenType>): AlterAction {
  return { kind: "addColumn", ifNotExists: parseIfNotExists(ctx), column: ctx.parse(columnDef) };
}

// `OWNER TO role` — ALTER TABLE's action, and the same words on every other
// ALTER target that has an owner. The new owner is a role spec, as CREATE
// SCHEMA's AUTHORIZATION and CREATE TABLESPACE's OWNER are.
function parseOwnerTo(ctx: ParseContext<SqlTokenType>): AlterOwnerTo {
  ctx.parse(kwseq("owner", "to"));
  return { kind: "ownerTo", owner: parseRoleSpec(ctx) };
}

// `DROP CONSTRAINT [IF EXISTS] name [CASCADE | RESTRICT]` once its CONSTRAINT
// is consumed, and `VALIDATE CONSTRAINT name` from its VALIDATE: ALTER TABLE's
// and ALTER DOMAIN's.
function parseDropConstraint(ctx: ParseContext<SqlTokenType>): AlterDropConstraint {
  const ifExists = parseIfExists(ctx);
  const name = ctx.parse(nameWord);
  return { kind: "dropConstraint", ifExists, name, behavior: ctx.parse(dropBehavior) };
}

function parseValidateConstraint(ctx: ParseContext<SqlTokenType>): AlterValidateConstraint {
  ctx.parse(kwseq("validate", "constraint"));
  return { kind: "validateConstraint", name: ctx.parse(nameWord) };
}

// `TRIGGER {name | ALL | USER}`, the tail of ENABLE / DISABLE TRIGGER; ENABLE
// REPLICA and ENABLE ALWAYS take a name only. ALL and USER are reserved, so an
// unquoted one never names a trigger.
function parseTriggerTarget(ctx: ParseContext<SqlTokenType>): AlterTriggerTarget {
  ctx.parse(kw("trigger"));
  if (ctx.eat("ident", "all") !== null) return { kind: "all" };
  if (ctx.eat("ident", "user") !== null) return { kind: "user" };
  const tok = ctx.peek();
  if (tok?.type !== "qident" && (tok?.type !== "ident" || RESERVED.has(tok.value))) {
    ctx.croak(`Expected "all", "user" or a name but found ${describeFound(tok)}`);
  }
  return { kind: "name", name: ctx.parse(nameWord) };
}

// `ROW LEVEL SECURITY` after ENABLE, DISABLE, FORCE or NO FORCE.
function parseRowSecurity(
  ctx: ParseContext<SqlTokenType>,
  action: Extract<AlterAction, { kind: "rowSecurity" }>["action"],
): AlterAction {
  ctx.parse(kwseq("row", "level", "security"));
  return { kind: "rowSecurity", action };
}

// The rest of `[SET DATA] TYPE t [COLLATE c] [USING expr]` once TYPE is
// consumed. Each tail is present only when written.
function parseSetDataType(ctx: ParseContext<SqlTokenType>, column: string): AlterAction {
  const dataType = ctx.parse(typeRef);
  const collate = ctx.eat("ident", "collate") !== null ? ctx.parse(qualName) : null;
  const using = ctx.eat("ident", "using") !== null ? ctx.parse(expression) : null;
  return { kind: "setDataType", column, dataType, ...(collate && { collate }), ...(using && { using }) };
}

// An optional `IF EXISTS` straight after a word, as DROP EXPRESSION and DROP
// IDENTITY end: nothing else can follow either there, so `if` commits.
function parseTrailingIfExists(ctx: ParseContext<SqlTokenType>): boolean {
  if (!ctx.is("ident", "if")) return false;
  ctx.parse(kwseq("if", "exists"));
  return true;
}

// Whether `tok` leads one step of an identity column's option run after SET:
// GENERATED, or a sequence option's word, SEQUENCE NAME's included.
const isIdentitySetWord = (tok: Token<SqlTokenType> | null): boolean =>
  tok !== null &&
  tok.type === "ident" &&
  (tok.value === "generated" || tok.value === "sequence" || SEQUENCE_OPTIONS.includes(tok.value));

// The sequence options refused after an identity column's SET. PG's grammar
// refuses the first three, by these names; SEQUENCE NAME fails only once the
// statement runs, and is refused here under a name in the same style.
const IDENTITY_REFUSED: Partial<Record<SequenceOption["kind"], string>> = {
  as: "as",
  restart: "restart",
  ownedBy: "owned_by",
  sequenceName: "sequence_name",
};

// `{SET GENERATED when | SET option | RESTART [[WITH] n]} …`, PG's
// alter_identity_column_option_list: one or more steps, with no commas
// between them, each SET taking a single option. The run ends at anything but
// SET or RESTART; a SET there that leads no step is an error at its next word.
function parseAlterIdentity(ctx: ParseContext<SqlTokenType>, column: string): AlterAction {
  const options: IdentityOption[] = [];
  for (;;) {
    if (ctx.eat("ident", "restart") !== null) {
      options.push(parseRestartValue(ctx));
      continue;
    }
    if (!ctx.is("ident", "set")) break;
    ctx.next(); // SET
    if (!isIdentitySetWord(ctx.peek())) {
      ctx.croak(`Expected "generated" or a sequence option but found ${describeFound(ctx.peek())}`);
    }
    if (ctx.eat("ident", "generated") !== null) {
      options.push({ kind: "generated", generated: parseGeneratedWhen(ctx) });
      continue;
    }
    const start = ctx.position();
    const option = parseSequenceOption(ctx, true);
    if (option === null) {
      ctx.next(); // NO
      ctx.croak(`Expected ${quoteList(["minvalue", "maxvalue", "cycle"])} but found ${describeFound(ctx.peek())}`);
    }
    const refused = IDENTITY_REFUSED[option.kind];
    if (refused !== undefined) ctx.croak(`sequence option "${refused}" not supported here`, start, ctx.lastEnd());
    options.push(option as IdentityOption); // AS, OWNED BY and SEQUENCE NAME were refused
  }
  return { kind: "alterIdentity", column, options };
}

// The `STORAGE` modes. DEFAULT, the type's own, is reserved and read apart;
// a quoted "default" names it too.
const STORAGE_MODES: ReadonlySet<string> = new Set(["plain", "external", "extended", "main"]);

// What follows `ALTER [COLUMN] name`, keyed by its lead word and handed the
// column. Each handler consumes its own lead word.
const ALTER_COLUMN_ACTIONS: DispatchMap<AlterAction, [string]> = {
  // `TYPE t` — shorthand for `SET DATA TYPE t`.
  type: {
    parse: (ctx, column) => {
      ctx.next(); // TYPE
      return parseSetDataType(ctx, column);
    },
  },
  // SET leads a fixed word, or an identity column's option run, which owns its
  // SETs and so is told apart by the word after this one before anything is
  // consumed.
  set: {
    parse: (ctx, column) => {
      if (isIdentitySetWord(ctx.peekAhead(1))) return parseAlterIdentity(ctx, column);
      ctx.next(); // SET
      if (ctx.is("punc", "(")) return { kind: "setColumnOptions", column, options: ctx.parse(relationOptions) };
      if (ctx.eat("ident", "default") !== null) return { kind: "setDefault", column, expr: ctx.parse(expression) };
      if (ctx.is("ident", "not")) {
        ctx.parse(kwseq("not", "null"));
        return { kind: "setNotNull", column };
      }
      if (ctx.is("ident", "data")) {
        ctx.parse(kwseq("data", "type"));
        return parseSetDataType(ctx, column);
      }
      if (ctx.is("ident", "expression")) {
        ctx.parse(kwseq("expression", "as"));
        return { kind: "setExpression", column, expr: ctx.parse(parenExpr) };
      }
      if (ctx.eat("ident", "statistics") !== null) {
        const value = ctx.eat("ident", "default") !== null ? null : parseSignedInt(ctx);
        return { kind: "setStatistics", column, value };
      }
      if (ctx.eat("ident", "storage") !== null) {
        if (ctx.eat("ident", "default") !== null) return { kind: "setStorage", column, storage: null };
        const start = ctx.position();
        // Compared case-blind, as PG does, so a quoted "MAIN" is MAIN too.
        const written = ctx.parse(nameWord);
        const mode = written.toLowerCase();
        if (mode === "default") return { kind: "setStorage", column, storage: null };
        if (!STORAGE_MODES.has(mode)) ctx.croak(`invalid storage type "${written}"`, start, ctx.lastEnd());
        return { kind: "setStorage", column, storage: mode as "plain" | "external" | "extended" | "main" };
      }
      if (ctx.eat("ident", "compression") !== null) {
        // PG matches DEFAULT by its exact lowercase spelling, so a quoted
        // "default" is DEFAULT too, and "DEFAULT" a method name.
        const method = ctx.eat("ident", "default") !== null ? null : ctx.parse(nameWord);
        return { kind: "setCompression", column, method: method === "default" ? null : method };
      }
      const words = ["(", "default", "not", "data", "expression", "statistics", "storage", "compression", "generated"];
      const expected = `${words.map((w) => `"${w}"`).join(", ")} or a sequence option`;
      return ctx.croak(`Expected ${expected} but found ${describeFound(ctx.peek())}`);
    },
  },
  reset: {
    parse: (ctx, column) => {
      const { options } = parseResetOptions(ctx);
      return { kind: "resetColumnOptions", column, options };
    },
  },
  drop: {
    parse: (ctx, column) => {
      ctx.next(); // DROP
      if (ctx.eat("ident", "default") !== null) return { kind: "dropDefault", column };
      if (ctx.is("ident", "not")) {
        ctx.parse(kwseq("not", "null"));
        return { kind: "dropNotNull", column };
      }
      if (ctx.eat("ident", "expression") !== null) {
        return { kind: "dropExpression", column, ...(parseTrailingIfExists(ctx) && { ifExists: true }) };
      }
      if (ctx.eat("ident", "identity") === null) {
        const words = ["default", "not", "expression", "identity"];
        ctx.croak(`Expected ${quoteList(words)} but found ${describeFound(ctx.peek())}`);
      }
      return { kind: "dropIdentity", column, ...(parseTrailingIfExists(ctx) && { ifExists: true }) };
    },
  },
  // `ADD GENERATED {ALWAYS | BY DEFAULT} AS IDENTITY [(option …)]`.
  add: {
    parse: (ctx, column) => {
      ctx.parse(kwseq("add", "generated"));
      const generated = parseGeneratedWhen(ctx);
      ctx.parse(kwseq("as", "identity"));
      const options = parseIdentityOptions(ctx);
      return { kind: "addIdentity", column, generated, ...(options && { options }) };
    },
  },
  restart: { parse: parseAlterIdentity },
};
const ALTER_COLUMN_ACTION_EXPECTED = keyList(ALTER_COLUMN_ACTIONS);

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
  // `DROP [COLUMN] [IF EXISTS] name [CASCADE | RESTRICT]`. `constraint` is
  // reserved, so an unquoted one never names the column dropped.
  drop: {
    parse: (ctx) => {
      ctx.next(); // DROP
      if (ctx.eat("ident", "constraint") !== null) return parseDropConstraint(ctx);
      ctx.eat("ident", "column"); // optional COLUMN
      const ifExists = parseIfExists(ctx);
      const name = ctx.parse(nameWord);
      const behavior = ctx.parse(dropBehavior);
      return { kind: "dropColumn", name, ...(ifExists && { ifExists: true }), ...(behavior && { behavior }) };
    },
  },
  // `ALTER [COLUMN] name …` or `ALTER CONSTRAINT name …`. `column` and
  // `constraint` are reserved, so an unquoted one never names the column.
  alter: {
    parse: (ctx) => {
      ctx.next(); // ALTER
      if (ctx.eat("ident", "constraint") !== null) {
        const name = ctx.parse(nameWord);
        return {
          kind: "alterConstraint",
          name,
          attrs: parseConstraintAttrs(ctx, "table", "ALTER CONSTRAINT statement"),
        };
      }
      ctx.eat("ident", "column"); // optional COLUMN
      const column = ctx.parse(nameWord);
      return dispatch(ALTER_COLUMN_ACTIONS, ALTER_COLUMN_ACTION_EXPECTED, ctx, column);
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
  // `SET {SCHEMA name | TABLESPACE name | (option, …) | WITHOUT {CLUSTER |
  // OIDS} | LOGGED | UNLOGGED | ACCESS METHOD {name | DEFAULT}}`. The word
  // after SET is a fixed slot, never a name.
  set: {
    parse: (ctx) => {
      ctx.next(); // SET
      if (ctx.is("punc", "(")) return { kind: "setOptions", options: ctx.parse(relationOptions) };
      if (ctx.is("ident", "schema")) return parseSetSchema(ctx);
      if (ctx.is("ident", "tablespace")) return parseSetTablespace(ctx);
      if (ctx.eat("ident", "logged") !== null) return { kind: "setLogged" };
      if (ctx.eat("ident", "unlogged") !== null) return { kind: "setUnlogged" };
      if (ctx.is("ident", "access")) {
        ctx.parse(kwseq("access", "method"));
        return { kind: "setAccessMethod", method: ctx.eat("ident", "default") !== null ? null : ctx.parse(nameWord) };
      }
      if (ctx.eat("ident", "without") === null) {
        const words = ["(", "schema", "tablespace", "logged", "unlogged", "access", "without"];
        ctx.croak(`Expected ${quoteList(words)} but found ${describeFound(ctx.peek())}`);
      }
      if (ctx.eat("ident", "oids") !== null) return { kind: "setWithoutOids" };
      if (!ctx.is("ident", "cluster")) {
        ctx.croak(`Expected ${quoteList(["cluster", "oids"])} but found ${describeFound(ctx.peek())}`);
      }
      ctx.next(); // CLUSTER
      return { kind: "setWithoutCluster" };
    },
  },
  reset: { parse: parseResetOptions },
  validate: { parse: parseValidateConstraint },
  // `ENABLE [REPLICA | ALWAYS] {TRIGGER … | RULE name}` / `ENABLE ROW LEVEL
  // SECURITY`, and DISABLE's TRIGGER, RULE and ROW LEVEL SECURITY.
  enable: {
    parse: (ctx) => {
      ctx.next(); // ENABLE
      const mode = ctx.eat("ident", "replica") ?? ctx.eat("ident", "always");
      if (mode !== null) {
        const modeValue = mode.value as "replica" | "always";
        if (ctx.eat("ident", "rule") !== null) {
          return { kind: "enableRule", mode: modeValue, rule: ctx.parse(nameWord) };
        }
        if (!ctx.is("ident", "trigger")) {
          ctx.croak(`Expected ${quoteList(["trigger", "rule"])} but found ${describeFound(ctx.peek())}`);
        }
        ctx.next(); // TRIGGER
        const trigger = { kind: "name" as const, name: ctx.parse(nameWord) };
        return { kind: "enableTrigger", mode: modeValue, trigger };
      }
      if (ctx.eat("ident", "rule") !== null) return { kind: "enableRule", rule: ctx.parse(nameWord) };
      if (ctx.is("ident", "row")) return parseRowSecurity(ctx, "enable");
      if (!ctx.is("ident", "trigger")) {
        const words = ["replica", "always", "trigger", "rule", "row"];
        ctx.croak(`Expected ${quoteList(words)} but found ${describeFound(ctx.peek())}`);
      }
      return { kind: "enableTrigger", mode: null, trigger: parseTriggerTarget(ctx) };
    },
  },
  disable: {
    parse: (ctx) => {
      ctx.next(); // DISABLE
      if (ctx.eat("ident", "rule") !== null) return { kind: "disableRule", rule: ctx.parse(nameWord) };
      if (ctx.is("ident", "row")) return parseRowSecurity(ctx, "disable");
      if (!ctx.is("ident", "trigger")) {
        ctx.croak(`Expected ${quoteList(["trigger", "rule", "row"])} but found ${describeFound(ctx.peek())}`);
      }
      return { kind: "disableTrigger", trigger: parseTriggerTarget(ctx) };
    },
  },
  force: {
    parse: (ctx) => {
      ctx.next(); // FORCE
      return parseRowSecurity(ctx, "force");
    },
  },
  // `NO FORCE ROW LEVEL SECURITY` / `NO INHERIT parent`.
  no: {
    parse: (ctx) => {
      ctx.next(); // NO
      if (ctx.eat("ident", "force") !== null) return parseRowSecurity(ctx, "noForce");
      if (ctx.eat("ident", "inherit") === null) {
        ctx.croak(`Expected ${quoteList(["force", "inherit"])} but found ${describeFound(ctx.peek())}`);
      }
      return { kind: "noInherit", parent: ctx.parse(qualName) };
    },
  },
  inherit: {
    parse: (ctx) => {
      ctx.next(); // INHERIT
      return { kind: "inherit", parent: ctx.parse(qualName) };
    },
  },
  // `OF type` / `NOT OF`: make the table typed, or untyped again.
  of: {
    parse: (ctx) => {
      ctx.next(); // OF
      return { kind: "of", type: ctx.parse(qualName) };
    },
  },
  not: {
    parse: (ctx) => {
      ctx.parse(kwseq("not", "of"));
      return { kind: "notOf" };
    },
  },
  cluster: {
    parse: (ctx) => {
      ctx.parse(kwseq("cluster", "on"));
      return { kind: "clusterOn", index: ctx.parse(nameWord) };
    },
  },
  // `ATTACH PARTITION name {FOR VALUES … | DEFAULT}`, CREATE TABLE … PARTITION
  // OF's bound.
  attach: {
    parse: (ctx) => {
      ctx.parse(kwseq("attach", "partition"));
      const partition = ctx.parse(qualName);
      return { kind: "attachPartition", partition, bound: parsePartitionBound(ctx) };
    },
  },
  detach: {
    parse: (ctx) => {
      ctx.parse(kwseq("detach", "partition"));
      const partition = ctx.parse(qualName);
      const mode = ctx.eat("ident", "concurrently") ?? ctx.eat("ident", "finalize");
      return { kind: "detachPartition", partition, mode: (mode?.value ?? null) as "concurrently" | "finalize" | null };
    },
  },
};

// Hand-written croak, so the comma form over the KEYS — `owner`, `cluster` and
// the other keys whose handlers consume a phrase would otherwise announce
// themselves as "owner to", "cluster on" and so on. One
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
  setSchema: "SET SCHEMA",
  attachPartition: "ATTACH PARTITION",
  detachPartition: "DETACH PARTITION",
};

// An optional `IF EXISTS`, decided by peeking like ADD's IF NOT EXISTS: `exists`
// leads no action, so an object called `if` is never followed by it.
function parseIfExists(ctx: ParseContext<SqlTokenType>): boolean {
  const next = ctx.peekAhead(1);
  const ifExists = ctx.is("ident", "if") && next?.type === "ident" && next.value === "exists";
  if (ifExists) ctx.parse(kwseq("if", "exists"));
  return ifExists;
}

// `TABLE [IF EXISTS] relation action[, …]` — TABLE consumed here, ALTER by the
// caller, whose `start` the node spans from. The relation is PG's relation_expr
// (`[ONLY] name [*]`, `ONLY (name)`), which pg_dump writes as ALTER TABLE ONLY.
function alterTableRest(ctx: ParseContext<SqlTokenType>, start: Position): Stmt {
  ctx.next(); // TABLE
  if (ctx.is("ident", "all")) return alterAllInTablespaceRest(ctx, start, "table");
  const ifExists = parseIfExists(ctx);
  const { name, only } = ctx.parse(relationExpr);
  const actions = parseActionList(ctx, "TABLE", (c) => c.parse(alterAction), ALTER_ACTIONS, SOLO_ALTER_ACTIONS);
  return { kind: "alterTable", ifExists, name, ...(only && { only: true }), actions, span: ctx.spanFrom(start) };
}

// `ALL IN TABLESPACE name [OWNED BY role, …] SET TABLESPACE name [NOWAIT]`,
// once the target's own word(s) are consumed. `all` is reserved, so it never
// starts the name of the object altered.
function alterAllInTablespaceRest(
  ctx: ParseContext<SqlTokenType>,
  start: Position,
  objectType: Extract<Stmt, { kind: "alterAllInTablespace" }>["objectType"],
): Stmt {
  ctx.parse(kwseq("all", "in", "tablespace"));
  const tablespace = ctx.parse(nameWord);
  let ownedBy: string[] | null = null;
  if (ctx.is("ident", "owned")) {
    ctx.parse(kwseq("owned", "by"));
    ownedBy = [];
    do ownedBy.push(parseRoleSpec(ctx));
    while (ctx.eat("punc", ",") !== null);
  }
  ctx.parse(kwseq("set", "tablespace"));
  const newTablespace = ctx.parse(nameWord);
  const nowait = ctx.eat("ident", "nowait") !== null;
  return {
    kind: "alterAllInTablespace",
    objectType,
    tablespace,
    ...(ownedBy && { ownedBy }),
    newTablespace,
    ...(nowait && { nowait: true }),
    span: ctx.spanFrom(start),
  };
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
      return parseDropConstraint(ctx);
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
  validate: { parse: parseValidateConstraint },
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

// `RESET (name, …)`, ALTER TABLE's, INDEX's and VIEW's. It shares SET's option-list
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

// `TABLESPACE name` once its SET is consumed, ALTER INDEX's, TABLE's and
// MATERIALIZED VIEW's.
function parseSetTablespace(ctx: ParseContext<SqlTokenType>): Extract<AlterIndexAction, { kind: "setTablespace" }> {
  ctx.parse(kw("tablespace"));
  return { kind: "setTablespace", tablespace: ctx.parse(nameWord) };
}

const INDEX_ACTIONS: DispatchMap<AlterIndexAction> = {
  rename: { parse: parseRenameTo },
  // `ATTACH PARTITION index`: a partition's index joins the partitioned one.
  attach: {
    parse: (ctx) => {
      ctx.parse(kwseq("attach", "partition"));
      return { kind: "attachPartition", partition: ctx.parse(qualName) };
    },
  },
  // `ALTER [COLUMN] n SET STATISTICS {k | DEFAULT}`, where an index names its
  // column by position, as PG requires of an index (an expression column has
  // no name to give).
  alter: {
    parse: (ctx) => {
      ctx.next(); // ALTER
      ctx.eat("ident", "column"); // optional COLUMN
      const tok = ctx.peek();
      if (!isIntegerConstant(tok)) ctx.croak(`Expected a column number but found ${describeFound(tok)}`);
      const column = Number(ctx.next()!.value);
      ctx.parse(kwseq("set", "statistics"));
      const value = ctx.eat("ident", "default") !== null ? null : parseSignedInt(ctx);
      return { kind: "setStatistics", column, value };
    },
  },
  set: {
    parse: (ctx) => {
      ctx.next(); // SET
      if (ctx.is("punc", "(")) return { kind: "setOptions", options: ctx.parse(relationOptions) };
      if (!ctx.is("ident", "tablespace")) {
        ctx.croak(`Expected ${quoteList(["(", "tablespace"])} but found ${describeFound(ctx.peek())}`);
      }
      return parseSetTablespace(ctx);
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

// `SET {(option, …) | SCHEMA name}`, and for a materialized view `SET
// TABLESPACE name` too.
function parseViewSet(ctx: ParseContext<SqlTokenType>, materialized: boolean): AlterViewAction {
  ctx.next(); // SET
  if (ctx.is("punc", "(")) return { kind: "setOptions", options: ctx.parse(relationOptions) };
  if (materialized && ctx.is("ident", "tablespace")) return parseSetTablespace(ctx);
  if (!ctx.is("ident", "schema")) {
    const words = materialized ? ["(", "schema", "tablespace"] : ["(", "schema"];
    ctx.croak(`Expected ${quoteList(words)} but found ${describeFound(ctx.peek())}`);
  }
  return parseSetSchema(ctx);
}

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
  set: { parse: (ctx) => parseViewSet(ctx, true) },
  reset: { parse: parseResetOptions },
};
// A materialized view has no column defaults to set or drop, and only it has
// storage to move to another tablespace.
const VIEW_ACTIONS: DispatchMap<AlterViewAction> = {
  ...MATERIALIZED_VIEW_ACTIONS,
  set: { parse: (ctx) => parseViewSet(ctx, false) },
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

// --- object references ---
//
// COMMENT ON, SECURITY LABEL, ALTER EXTENSION ADD / DROP and the generic ALTER
// all name one existing object as `kind reference`. OBJECT_KINDS is the one
// list of those kinds: PG 17's CommentStmt, whose kinds cover the others' (bar
// RenameStmt's GROUP and USER, which take a grammar of their own), with what each statement takes flagged per kind. Its keyword(s)
// select the kind, and its `shape` says how the reference that follows reads.
// A statement builds a trie over the kinds it takes (objectKindTrie) and hands
// it to parseObjectRef. Every kind word is matched by value, so none of them
// stops being usable as a name; `table`, `column`, `constraint`, `foreign` and
// `cast` are reserved and match here all the same.

// The generic ALTER's actions, keyed by lead word: RENAME TO, OWNER TO, SET SCHEMA.
type AlterObjectVerb = "rename" | "owner" | "set";

type ObjectKind = {
  objectType: string;
  // The keywords that select the kind, when they are not `objectType`'s words.
  words?: readonly string[];
  shape: ObjectRefShape;
  // SECURITY LABEL takes the kind.
  label?: true;
  // ALTER EXTENSION ADD / DROP takes the kind.
  member?: true;
  // The generic ALTER's actions on the kind, for a kind with no ALTER target of
  // its own; absent where PG has none, a dedicated target owns the ALTER (as
  // for TABLE, POLICY or PUBLICATION), or one is to (FOREIGN TABLE).
  alter?: readonly AlterObjectVerb[];
};

const ALTER_ALL: readonly AlterObjectVerb[] = ["rename", "owner", "set"];
const RENAME_OWNER: readonly AlterObjectVerb[] = ["rename", "owner"];
const RENAME_SCHEMA: readonly AlterObjectVerb[] = ["rename", "set"];

// Grouped as gram.y groups them; the order is the order an "Expected …" croak
// lists the lead words in. FOREIGN TABLE takes no generic ALTER: it is left
// for a dedicated target that will own its whole ALTER, as ROLE, DATABASE,
// TABLESPACE, POLICY, PUBLICATION and SUBSCRIPTION already have.
const OBJECT_KINDS: readonly ObjectKind[] = [
  // object_type_any_name
  { objectType: "table", shape: "qualName", label: true, member: true },
  { objectType: "sequence", shape: "qualName", label: true, member: true },
  { objectType: "view", shape: "qualName", label: true, member: true },
  { objectType: "materialized view", shape: "qualName", label: true, member: true },
  { objectType: "index", shape: "qualName", label: true, member: true },
  { objectType: "foreign table", shape: "qualName", label: true, member: true },
  { objectType: "collation", shape: "qualName", label: true, member: true, alter: ALTER_ALL },
  { objectType: "conversion", shape: "qualName", label: true, member: true, alter: ALTER_ALL },
  { objectType: "statistics", shape: "qualName", label: true, member: true, alter: ALTER_ALL },
  { objectType: "text search parser", shape: "qualName", label: true, member: true, alter: RENAME_SCHEMA },
  { objectType: "text search dictionary", shape: "qualName", label: true, member: true, alter: ALTER_ALL },
  { objectType: "text search template", shape: "qualName", label: true, member: true, alter: RENAME_SCHEMA },
  { objectType: "text search configuration", shape: "qualName", label: true, member: true, alter: ALTER_ALL },
  { objectType: "column", shape: "qualName", label: true },
  // object_type_name
  { objectType: "access method", shape: "name", label: true, member: true },
  { objectType: "event trigger", shape: "name", label: true, member: true, alter: RENAME_OWNER },
  // ALTER EXTENSION is a target of its own.
  { objectType: "extension", shape: "name", label: true, member: true },
  { objectType: "foreign data wrapper", shape: "name", label: true, member: true, alter: RENAME_OWNER },
  { objectType: "language", shape: "name", label: true, member: true, alter: RENAME_OWNER },
  {
    objectType: "language",
    words: ["procedural", "language"],
    shape: "name",
    label: true,
    member: true,
    alter: RENAME_OWNER,
  },
  { objectType: "publication", shape: "name", label: true, member: true },
  { objectType: "schema", shape: "name", label: true, member: true },
  { objectType: "server", shape: "name", label: true, member: true, alter: RENAME_OWNER },
  // DATABASE and TABLESPACE have ALTER targets of their own, which hand RENAME
  // TO and OWNER TO back to the generic node (see alterRenameOwner).
  { objectType: "database", shape: "name", label: true, member: true },
  { objectType: "role", shape: "name", label: true, member: true },
  { objectType: "subscription", shape: "name", label: true, member: true },
  { objectType: "tablespace", shape: "name", label: true, member: true },
  // The kinds with a reference shape of their own.
  { objectType: "type", shape: "qualName", label: true, member: true },
  { objectType: "domain", shape: "qualName", label: true, member: true },
  { objectType: "aggregate", shape: "aggregate", label: true, member: true },
  { objectType: "function", shape: "routine", label: true, member: true },
  { objectType: "operator", shape: "operator", member: true, alter: ["owner", "set"] },
  { objectType: "constraint", shape: "constraint" },
  { objectType: "policy", shape: "onTable" },
  { objectType: "rule", shape: "onTable", alter: ["rename"] },
  { objectType: "trigger", shape: "onTable", alter: ["rename"] },
  { objectType: "procedure", shape: "routine", label: true, member: true, alter: ALTER_ALL },
  { objectType: "routine", shape: "routine", label: true, member: true, alter: ALTER_ALL },
  { objectType: "transform", shape: "transform", member: true },
  { objectType: "operator class", shape: "opClass", member: true, alter: ALTER_ALL },
  { objectType: "operator family", shape: "opClass", member: true, alter: ALTER_ALL },
  { objectType: "large object", shape: "largeObject", label: true, alter: ["owner"] },
  { objectType: "cast", shape: "cast", member: true },
];

// One node per keyword prefix: `kind` when the words so far spell a kind,
// `next` keyed by the word that may follow, and the croak over `next`'s keys.
type ObjectKindTrie = { kind?: ObjectKind; next: Map<string, ObjectKindTrie>; expected: string };

// The trie over the kinds `take` keeps, in `kinds` order.
function objectKindTrie(
  take: (kind: ObjectKind) => boolean,
  kinds: readonly ObjectKind[] = OBJECT_KINDS,
): ObjectKindTrie {
  const root: ObjectKindTrie = { next: new Map(), expected: "" };
  for (const kind of kinds) {
    if (!take(kind)) continue;
    let node = root;
    for (const w of kind.words ?? kind.objectType.split(" ")) {
      let child = node.next.get(w);
      if (child === undefined) {
        child = { next: new Map(), expected: "" };
        node.next.set(w, child);
      }
      node = child;
    }
    node.kind = kind;
  }
  const setExpected = (node: ObjectKindTrie) => {
    node.expected = quoteList([...node.next.keys()]);
    for (const child of node.next.values()) setExpected(child);
  };
  setExpected(root);
  return root;
}

const COMMENT_OBJECTS = objectKindTrie(() => true);
const LABEL_OBJECTS = objectKindTrie((k) => k.label === true);
const MEMBER_OBJECTS = objectKindTrie((k) => k.member === true);
const ALTER_OBJECTS = objectKindTrie((k) => k.alter !== undefined);

// Whether `tok` can start a name: a quoted word, or an unreserved one.
const isNameToken = (tok: Token<SqlTokenType> | null) =>
  tok !== null && (tok.type === "qident" || (tok.type === "ident" && !RESERVED.has(tok.value)));

// The kind keyword(s), as long a run as the trie spells. Where the words so far
// already spell a kind, a further kind word is one only when a name follows it,
// as in PG: `OPERATOR CLASS c USING btree` is an operator class, but
// `OPERATOR class.+ (int, int)` is an operator in a schema called `class`.
function parseObjectKind(ctx: ParseContext<SqlTokenType>, trie: ObjectKindTrie): ObjectKind {
  let node = trie;
  for (;;) {
    const tok = ctx.peek();
    const child = tok?.type === "ident" ? node.next.get(tok.value) : undefined;
    if (child !== undefined && (node.kind === undefined || isNameToken(ctx.peekAhead(1)))) {
      ctx.next();
      node = child;
    } else if (node.kind !== undefined) {
      return node.kind;
    } else {
      return ctx.croak(`Expected ${node.expected} but found ${describeFound(tok)}`);
    }
  }
}

// An OPERATOR reference: `[schema.]op`, then `(left, right)` where NONE stands
// for the missing side of a prefix operator. PG has no `(type)` form, and no
// operator lacks both sides.
function parseOperatorRef(ctx: ParseContext<SqlTokenType>): Required<Pick<ObjectRef, "name" | "operands">> {
  const name = parseAnyOperator(ctx);
  return { name, operands: parseOperandTypes(ctx) };
}

// PG's any_operator, `[schema.]op`: the dotted name ends in the symbol, which is
// any operator but `=>`, as in PG.
function parseAnyOperator(ctx: ParseContext<SqlTokenType>): string[] {
  const name: string[] = [];
  while (!ctx.is("op")) {
    if (!isNameToken(ctx.peek())) ctx.croak(`Expected an operator but found ${describeFound(ctx.peek())}`);
    name.push(ctx.parse(nameWord));
    ctx.parse(punc("."));
  }
  name.push(ctx.parse(sortOperator));
  return name;
}

// PG's oper_argtypes, `(left, right)`, with NONE for the missing side of a
// prefix operator.
function parseOperandTypes(ctx: ParseContext<SqlTokenType>): [ColType | null, ColType | null] {
  ctx.parse(punc("("));
  const operand = () => (ctx.eat("ident", "none") !== null ? null : ctx.parse(typeRef));
  const left = operand();
  ctx.parse(punc(","));
  const right = operand();
  expectClose(ctx);
  if (left === null && right === null) ctx.croak("An operator takes at least one operand type, not NONE twice");
  return [left, right];
}

// A cast's `(source AS target)`, as CREATE, DROP and COMMENT ON name it.
function parseCastTypes(ctx: ParseContext<SqlTokenType>): { source: ColType; target: ColType } {
  ctx.parse(punc("("));
  const source = ctx.parse(typeRef);
  ctx.parse(kw("as"));
  const target = ctx.parse(typeRef);
  expectClose(ctx);
  return { source, target };
}

// `name ON table`, and for a CONSTRAINT `name ON DOMAIN domain`. DOMAIN is the
// keyword only when a name follows it; otherwise it is the table's name.
function parseOnTableRef(
  ctx: ParseContext<SqlTokenType>,
  domain: boolean,
): Pick<ObjectRef, "name" | "table" | "domain"> {
  const name = [ctx.parse(nameWord)];
  ctx.parse(kw("on"));
  if (domain && ctx.is("ident", "domain") && isNameToken(ctx.peekAhead(1))) {
    ctx.next(); // DOMAIN
    return { name, domain: ctx.parse(qualName) };
  }
  return { name, table: ctx.parse(qualName) };
}

// How a kind's reference reads once its keyword(s) are consumed, keyed by the
// kind's `shape`: `name` is PG's `name`, `qualName` its `any_name` (and, here,
// TYPE's and DOMAIN's `Typename`); the rest are as ObjectRef describes them.
type ObjectRefShape = keyof typeof OBJECT_REF_SHAPES;
const OBJECT_REF_SHAPES = {
  name: (ctx) => ({ name: [ctx.parse(nameWord)] }),
  qualName: (ctx) => ({ name: ctx.parse(qualName) }),
  routine: (ctx) => {
    const { name, signature } = ctx.parse(routineRef);
    return signature === null ? { name } : { name, signature };
  },
  aggregate: (ctx) => ctx.parse(aggregateRef),
  operator: parseOperatorRef,
  cast: parseCastTypes,
  transform: (ctx) => {
    ctx.parse(kw("for"));
    const type = ctx.parse(typeRef);
    ctx.parse(kw("language"));
    return { type, language: ctx.parse(nameWord) };
  },
  opClass: (ctx) => {
    const name = ctx.parse(qualName);
    ctx.parse(kw("using"));
    return { name, using: ctx.parse(nameWord) };
  },
  largeObject: (ctx) => {
    // PG's NumericOnly: a number, signed or not.
    const negate = ctx.eat("op", "-") !== null;
    if (!negate) ctx.eat("op", "+");
    if (!ctx.is("number")) ctx.croak(`Expected a number but found ${describeFound(ctx.peek())}`);
    const oid = Number(ctx.next()!.value);
    return { oid: negate ? -oid : oid };
  },
  onTable: (ctx) => parseOnTableRef(ctx, false),
  constraint: (ctx) => parseOnTableRef(ctx, true),
} satisfies Record<string, (ctx: ParseContext<SqlTokenType>) => Omit<ObjectRef, "objectType">>;

// `kind reference` over the kinds in `trie`. The kind comes back beside the
// reference for a caller that checks what the kind allows next.
function parseObjectRef(ctx: ParseContext<SqlTokenType>, trie: ObjectKindTrie): { kind: ObjectKind; ref: ObjectRef } {
  const kind = parseObjectKind(ctx, trie);
  return { kind, ref: { objectType: kind.objectType, ...OBJECT_REF_SHAPES[kind.shape](ctx) } };
}

// The generic ALTER's actions; each kind takes the subset its `alter` names.
const ALTER_OBJECT_ACTIONS: Record<
  AlterObjectVerb,
  DispatchEntry<AlterRenameTo | AlterOwnerTo | AlterSetSchema, []>
> = {
  rename: { parse: parseRenameTo },
  owner: { parse: parseOwnerTo },
  set: { parse: parseSetSchemaAction },
};
const ALTER_OBJECT_ACTION_MAPS = new Map(
  OBJECT_KINDS.filter((k) => k.alter !== undefined).map((k) => {
    const map = Object.fromEntries(k.alter!.map((verb) => [verb, ALTER_OBJECT_ACTIONS[verb]]));
    return [k, { map, expected: keyList(map) }] as const;
  }),
);

// `kind reference action` — ALTER consumed by the caller, whose `start` the
// node spans from — for a kind with no ALTER target of its own.
function alterObjectRest(ctx: ParseContext<SqlTokenType>, start: Position): Stmt {
  const { kind, ref } = parseObjectRef(ctx, ALTER_OBJECTS);
  const { map, expected } = ALTER_OBJECT_ACTION_MAPS.get(kind)!;
  const action = dispatch(map, expected, ctx);
  return { kind: "alterObject", object: ref, action, span: ctx.spanFrom(start) };
}

// ALTER EXTENSION's actions. ADD and DROP take any member kind; UPDATE's
// `TO version` is optional.
const extensionMember =
  (kind: "add" | "drop") =>
  (ctx: ParseContext<SqlTokenType>): AlterExtensionAction => {
    ctx.next(); // ADD / DROP
    return { kind, object: parseObjectRef(ctx, MEMBER_OBJECTS).ref };
  };
const EXTENSION_ACTIONS: DispatchMap<AlterExtensionAction> = {
  add: { parse: extensionMember("add") },
  drop: { parse: extensionMember("drop") },
  set: { parse: parseSetSchemaAction },
  update: {
    parse: (ctx) => {
      ctx.next(); // UPDATE
      return ctx.eat("ident", "to") !== null ? { kind: "update", version: parseWordOrString(ctx) } : { kind: "update" };
    },
  },
};
const EXTENSION_ACTION_EXPECTED = keyList(EXTENSION_ACTIONS);

// `SET …` (a parseConfigSet form) or `RESET target` (parseConfigTarget's), the
// parameter defaults ALTER ROLE and ALTER DATABASE set, or null when neither
// leads. Of PG's SET forms there, only the parameter ones are taken, not SET
// TRANSACTION or SESSION CHARACTERISTICS.
function parseAlterConfig(ctx: ParseContext<SqlTokenType>): AlterConfigAction | null {
  if (ctx.eat("ident", "set") !== null) return { kind: "set", ...parseConfigSet(ctx) };
  if (ctx.eat("ident", "reset") !== null) return { kind: "reset", name: parseConfigTarget(ctx) };
  return null;
}

// `ALTER {ROLE | USER} …` once ALTER is consumed: `{role | ALL} [IN DATABASE
// db] {SET … | RESET …}`, `role RENAME TO name`, or `role [WITH] option …`.
// The role is a role spec, bar RENAME's, which PG will not take as one of the
// pseudo-roles; ALL is reserved, so an unquoted one never names a role.
function alterRoleRest(ctx: ParseContext<SqlTokenType>, start: Position, lead: "role" | "user"): Stmt {
  ctx.next(); // ROLE / USER
  const user = lead === "user";
  const roleStart = ctx.position();
  const tok = ctx.peek();
  const name = ctx.eat("ident", "all") !== null ? null : parseRoleSpec(ctx);
  const node = (action: AlterRoleAction, database?: string): Stmt => ({
    kind: "alterRole",
    user,
    name,
    ...(database !== undefined && { database }),
    action,
    span: ctx.spanFrom(start),
  });
  // `in` is reserved, so it can only open IN DATABASE here.
  let database: string | undefined;
  if (ctx.eat("ident", "in") !== null) {
    ctx.parse(kw("database"));
    database = ctx.parse(nameWord);
  }
  const config = parseAlterConfig(ctx);
  if (config !== null) return node(config, database);
  if (name === null || database !== undefined) {
    const expected = database === undefined ? ["in", "set", "reset"] : ["set", "reset"];
    return ctx.croak(`Expected ${quoteList(expected)} but found ${describeFound(ctx.peek())}`);
  }
  if (ctx.is("ident", "rename")) {
    if (tok?.type === "ident" && ROLE_KEYWORDS.has(tok.value)) {
      ctx.croak(`${tok.value.toUpperCase()} cannot be used as a role name here`, roleStart);
    }
    checkRoleName(ctx, tok, roleStart);
    ctx.next(); // RENAME
    if (ctx.eat("ident", "to") === null) ctx.croak(`Expected "to" but found ${describeFound(ctx.peek())}`);
    const toStart = ctx.position();
    const toTok = ctx.peek();
    const to = ctx.parse(nameWord);
    checkRoleName(ctx, toTok, toStart);
    return node({ kind: "rename", to });
  }
  // `with` is reserved, so it can only open the list.
  ctx.eat("ident", "with");
  const options: RoleOption[] = [];
  for (let option = parseRoleOption(ctx, true); option !== null; option = parseRoleOption(ctx, true)) {
    options.push(option);
  }
  return node({ kind: "options", options });
}

// PG reserves the role names `public` and `none`, quoted or not, wherever a
// role is named rather than specified: RENAME's two names here.
function checkRoleName(ctx: ParseContext<SqlTokenType>, tok: Token<SqlTokenType> | null, at: Position): void {
  const word = tok?.type === "ident" || tok?.type === "qident" ? tok.value : null;
  if (word === "public" || word === "none") {
    ctx.croak(`Role name "${word}" is reserved`, at);
  }
}

// RENAME TO and OWNER TO on ALTER DATABASE and ALTER TABLESPACE, which build
// the generic `alterObject` node these two kinds have always had, or null when
// neither leads. With `ownerOption`, OWNER leads OWNER TO only before TO, as it
// is a database option name too (`OWNER = role`).
function alterRenameOwner(
  ctx: ParseContext<SqlTokenType>,
  start: Position,
  objectType: string,
  name: string,
  ownerOption = false,
): Stmt | null {
  let action: AlterRenameTo | AlterOwnerTo;
  if (ctx.is("ident", "rename")) action = parseRenameTo(ctx);
  else if (ctx.is("ident", "owner") && (!ownerOption || isWordAhead(ctx, 1, "to"))) action = parseOwnerTo(ctx);
  else return null;
  return { kind: "alterObject", object: { objectType, name: [name] }, action, span: ctx.spanFrom(start) };
}

// `ALTER DATABASE name …` once ALTER is consumed: RENAME TO, OWNER TO, SET
// TABLESPACE, REFRESH COLLATION VERSION, SET / RESET, or `[WITH] option …`, a
// run of CREATE DATABASE's entries that PG lets be empty. RENAME, SET, RESET
// and REFRESH are keywords to PG and never an option's name, so each commits
// where it leads, and ends the option run elsewhere (see isDatabaseOptionStart).
function alterDatabaseRest(ctx: ParseContext<SqlTokenType>, start: Position): Stmt {
  ctx.next(); // DATABASE
  const name = ctx.parse(nameWord);
  const renameOwner = alterRenameOwner(ctx, start, "database", name, true);
  if (renameOwner !== null) return renameOwner;
  const node = (action: AlterDatabaseAction): Stmt => ({
    kind: "alterDatabase",
    name,
    action,
    span: ctx.spanFrom(start),
  });
  // SET TABLESPACE, unless isGenericSet reads a parameter named `tablespace`.
  if (ctx.is("ident", "set") && isWordAhead(ctx, 1, "tablespace") && !isGenericSet(ctx, 1)) {
    ctx.next(); // SET
    return node(parseSetTablespace(ctx));
  }
  const config = parseAlterConfig(ctx);
  if (config !== null) return node(config);
  if (ctx.is("ident", "refresh")) {
    ctx.parse(kwseq("refresh", "collation", "version"));
    return node({ kind: "refreshCollationVersion" });
  }
  // `with` is reserved, so it can only open the list.
  ctx.eat("ident", "with");
  const options: RelationOption[] = [];
  while (isDatabaseOptionStart(ctx)) options.push(parseDatabaseOption(ctx));
  return node({ kind: "options", options });
}

// `ALTER TABLESPACE name {RENAME TO | OWNER TO | SET (option, …) | RESET
// (name, …)}` once ALTER is consumed.
function alterTablespaceRest(ctx: ParseContext<SqlTokenType>, start: Position): Stmt {
  ctx.next(); // TABLESPACE
  const name = ctx.parse(nameWord);
  const renameOwner = alterRenameOwner(ctx, start, "tablespace", name);
  if (renameOwner !== null) return renameOwner;
  let action: AlterTablespaceAction;
  if (ctx.eat("ident", "set") !== null) action = { kind: "setOptions", options: ctx.parse(relationOptions) };
  else if (ctx.is("ident", "reset")) action = parseResetOptions(ctx);
  else {
    const expected = quoteList(["rename", "owner", "set", "reset"]);
    return ctx.croak(`Expected ${expected} but found ${describeFound(ctx.peek())}`);
  }
  return { kind: "alterTablespace", name, action, span: ctx.spanFrom(start) };
}

// --- policies, publications and subscriptions ---
//
// CREATE / ALTER POLICY, PUBLICATION and SUBSCRIPTION. Every lead and clause
// word is matched by value, so none of them stops being usable as a name; `on`,
// `as`, `for`, `all`, `select`, `to`, `using`, `with`, `check`, `table`, `only`,
// `in` and `where` are reserved and match here all the same. RENAME TO and
// OWNER TO build the alterObject node, as they do on the kinds the generic
// ALTER takes.

const POLICY_COMMANDS = ["all", "select", "insert", "update", "delete"] as const;

// A policy's `name ON table`.
function parsePolicyHead(ctx: ParseContext<SqlTokenType>): { name: string; table: string[] } {
  const name = ctx.parse(nameWord);
  ctx.parse(kw("on"));
  return { name, table: ctx.parse(qualName) };
}

// `[TO role, …] [USING (expr)] [WITH CHECK (expr)]`, in the order PG's grammar
// fixes. The roles are role specs, PUBLIC among them as a plain name.
function parsePolicyClauses(ctx: ParseContext<SqlTokenType>): PolicyClauses {
  const clauses: PolicyClauses = {};
  if (ctx.eat("ident", "to") !== null) {
    const roles: string[] = [];
    do {
      roles.push(parseRoleSpec(ctx));
    } while (ctx.eat("punc", ",") !== null);
    clauses.roles = roles;
  }
  if (ctx.eat("ident", "using") !== null) clauses.using = ctx.parse(parenExpr);
  if (ctx.eat("ident", "with") !== null) {
    ctx.parse(kw("check"));
    clauses.withCheck = ctx.parse(parenExpr);
  }
  return clauses;
}

// `AS {PERMISSIVE | RESTRICTIVE}` once AS is consumed. PG reads an identifier
// there and compares its text, so a quoted "permissive" counts too.
function parsePolicyAs(ctx: ParseContext<SqlTokenType>): NonNullable<CreatePolicy["as"]> {
  const tok = ctx.peek();
  if (
    (tok?.type === "ident" || tok?.type === "qident") &&
    (tok.value === "permissive" || tok.value === "restrictive")
  ) {
    ctx.next();
    return tok.value;
  }
  return ctx.croak(`Expected "permissive" or "restrictive" but found ${describeFound(tok)}`);
}

// `FOR command` once FOR is consumed; the commands are keywords, so a quoted
// one is no command.
function parsePolicyCommand(ctx: ParseContext<SqlTokenType>): NonNullable<CreatePolicy["command"]> {
  const tok = ctx.peek();
  const command = POLICY_COMMANDS.find((c) => tok?.type === "ident" && tok.value === c);
  if (command === undefined) {
    return ctx.croak(`Expected ${quoteList(POLICY_COMMANDS)} but found ${describeFound(tok)}`);
  }
  ctx.next();
  return command;
}

function createPolicyRest(ctx: ParseContext<SqlTokenType>): Stmt {
  const start = ctx.position();
  ctx.parse(kw("policy"));
  const { name, table } = parsePolicyHead(ctx);
  const as = ctx.eat("ident", "as") !== null ? parsePolicyAs(ctx) : null;
  const command = ctx.eat("ident", "for") !== null ? parsePolicyCommand(ctx) : null;
  return {
    kind: "createPolicy",
    name,
    table,
    ...(as !== null && { as }),
    ...(command !== null && { command }),
    ...parsePolicyClauses(ctx),
    span: ctx.spanFrom(start),
  };
}

// `POLICY [IF EXISTS] name ON table {RENAME TO new | clauses}`, ALTER consumed
// by the caller. IF EXISTS is PG's on the RENAME form only.
function alterPolicyRest(ctx: ParseContext<SqlTokenType>, start: Position): Stmt {
  ctx.next(); // POLICY
  const ifExists = parseIfExists(ctx);
  const { name, table } = parsePolicyHead(ctx);
  if (ifExists || ctx.is("ident", "rename")) {
    if (!ctx.is("ident", "rename")) ctx.croak(`Expected "rename" but found ${describeFound(ctx.peek())}`);
    const action = parseRenameTo(ctx);
    const object = { objectType: "policy", name: [name], table };
    return { kind: "alterObject", ...(ifExists && { ifExists: true }), object, action, span: ctx.spanFrom(start) };
  }
  return { kind: "alterPolicy", name, table, ...parsePolicyClauses(ctx), span: ctx.spanFrom(start) };
}

// An optional `WITH (option, …)`, PG's opt_definition. It is read as a
// relation's options are, so what PG's definition lacks (the `ns.name` form, an
// entry with a value but no `=`, a list value) passes here too: the
// one-shape-for-every-list trade relationOption already makes.
function parseOptDefinition(ctx: ParseContext<SqlTokenType>): { options?: RelationOption[] } {
  return ctx.eat("ident", "with") !== null ? { options: ctx.parse(relationOptions) } : {};
}

// A publication's `object, …`. The first entry must say TABLE or TABLES IN
// SCHEMA; a later one that leaves its lead words off takes the previous
// entry's. `tables` is TABLES IN SCHEMA only before `in`, which is reserved and
// so can never follow a table called `tables`. `others` are the words the
// caller also takes where the first entry belongs, named in its croak.
function parsePublicationObjects(ctx: ParseContext<SqlTokenType>, others: readonly string[]): PublicationObject[] {
  const objects: PublicationObject[] = [];
  let lead: "table" | "schema" | null = null;
  do {
    const after = ctx.peekAhead(1);
    if (ctx.eat("ident", "table") !== null) {
      lead = "table";
    } else if (ctx.is("ident", "tables") && (lead === null || (after?.type === "ident" && after.value === "in"))) {
      ctx.parse(kwseq("tables", "in", "schema"));
      lead = "schema";
    } else if (lead === null) {
      return ctx.croak(`Expected ${quoteList([...others, "table", "tables"])} but found ${describeFound(ctx.peek())}`);
    }
    objects.push(lead === "table" ? parsePublicationTable(ctx) : parsePublicationSchema(ctx));
  } while (ctx.eat("punc", ",") !== null);
  return objects;
}

// `[ONLY] t [*] [(cols)] [WHERE (expr)]`. PG takes CURRENT_SCHEMA for no table
// name, so an unquoted one is refused here, after ONLY or `ONLY (` too, though
// it is a name elsewhere. The column list may not be empty, as in PG; the
// shared columnList takes `()`, so that is checked here.
function parsePublicationTable(ctx: ParseContext<SqlTokenType>): PublicationObject {
  let at = 0;
  if (ctx.is("ident", "only")) at = isPuncToken(ctx.peekAhead(1), "(") ? 2 : 1;
  const head = ctx.peekAhead(at);
  if (head?.type === "ident" && head.value === "current_schema") {
    ctx.croak(`Expected a name but found ${describeFound(head)}`, head.position.start, head.position.end);
  }
  const { name, only } = ctx.parse(relationExpr);
  const table: PublicationObject = { kind: "table", name, ...(only && { only: true }) };
  if (ctx.is("punc", "(")) {
    const close = ctx.peekAhead(1);
    if (close !== null && isPuncToken(close, ")")) {
      ctx.croak(`Expected a name but found ${describeFound(close)}`, close.position.start, close.position.end);
    }
    table.columns = ctx.parse(columnList);
  }
  if (ctx.eat("ident", "where") !== null) table.where = ctx.parse(parenExpr);
  return table;
}

function parsePublicationSchema(ctx: ParseContext<SqlTokenType>): PublicationObject {
  const schema = ctx.eat("ident", "current_schema") !== null ? null : ctx.parse(nameWord);
  return { kind: "tablesInSchema", schema };
}

function createPublicationRest(ctx: ParseContext<SqlTokenType>): Stmt {
  const start = ctx.position();
  ctx.parse(kw("publication"));
  const name = ctx.parse(nameWord);
  let target: Pick<CreatePublication, "allTables" | "objects"> = {};
  if (ctx.eat("ident", "for") !== null) {
    if (ctx.eat("ident", "all") !== null) {
      ctx.parse(kw("tables"));
      target = { allTables: true };
    } else {
      target = { objects: parsePublicationObjects(ctx, ["all"]) };
    }
  }
  return { kind: "createPublication", name, ...target, ...parseOptDefinition(ctx), span: ctx.spanFrom(start) };
}

// ALTER PUBLICATION's actions. SET leads both an object list and `(option, …)`;
// an object list never opens on `(`, so one token tells them apart.
const PUBLICATION_ACTIONS: DispatchMap<AlterPublicationAction | AlterRenameTo | AlterOwnerTo> = {
  add: {
    parse: (ctx) => {
      ctx.next(); // ADD
      return { kind: "add", objects: parsePublicationObjects(ctx, []) };
    },
  },
  set: {
    parse: (ctx) => {
      ctx.next(); // SET
      if (ctx.is("punc", "(")) return { kind: "setOptions", options: ctx.parse(relationOptions) };
      return { kind: "set", objects: parsePublicationObjects(ctx, ["("]) };
    },
  },
  drop: {
    parse: (ctx) => {
      ctx.next(); // DROP
      return { kind: "drop", objects: parsePublicationObjects(ctx, []) };
    },
  },
  rename: { parse: parseRenameTo },
  owner: { parse: parseOwnerTo },
};
const PUBLICATION_ACTION_EXPECTED = keyList(PUBLICATION_ACTIONS);

function alterPublicationRest(ctx: ParseContext<SqlTokenType>, start: Position): Stmt {
  ctx.next(); // PUBLICATION
  const name = ctx.parse(nameWord);
  const action = dispatch(PUBLICATION_ACTIONS, PUBLICATION_ACTION_EXPECTED, ctx);
  if (action.kind === "rename" || action.kind === "ownerTo") {
    const object = { objectType: "publication", name: [name] };
    return { kind: "alterObject", object, action, span: ctx.spanFrom(start) };
  }
  return { kind: "alterPublication", name, action, span: ctx.spanFrom(start) };
}

const publicationNames = sepBy(nameWord, P(","));

function createSubscriptionRest(ctx: ParseContext<SqlTokenType>): Stmt {
  const start = ctx.position();
  ctx.parse(kw("subscription"));
  const name = ctx.parse(nameWord);
  ctx.parse(kw("connection"));
  const connection = sconstString(ctx);
  ctx.parse(kw("publication"));
  const publications = ctx.parse(publicationNames);
  const options = parseOptDefinition(ctx);
  return { kind: "createSubscription", name, connection, publications, ...options, span: ctx.spanFrom(start) };
}

// `p, … [WITH (…)]`, the tail of SET / ADD / DROP PUBLICATION.
const publicationList = (
  ctx: ParseContext<SqlTokenType>,
  kind: "setPublication" | "addPublication" | "dropPublication",
): AlterSubscriptionAction => ({ kind, publications: ctx.parse(publicationNames), ...parseOptDefinition(ctx) });

// ALTER SUBSCRIPTION's actions. SET leads both `(option, …)` and SET
// PUBLICATION, told apart by the token after it.
const SUBSCRIPTION_ACTIONS: DispatchMap<AlterSubscriptionAction | AlterRenameTo | AlterOwnerTo> = {
  connection: {
    parse: (ctx) => {
      ctx.next(); // CONNECTION
      return { kind: "connection", connection: sconstString(ctx) };
    },
  },
  set: {
    parse: (ctx) => {
      ctx.next(); // SET
      if (ctx.is("punc", "(")) return { kind: "setOptions", options: ctx.parse(relationOptions) };
      if (ctx.eat("ident", "publication") === null) {
        ctx.croak(`Expected "(" or "publication" but found ${describeFound(ctx.peek())}`);
      }
      return publicationList(ctx, "setPublication");
    },
  },
  add: {
    parse: (ctx) => {
      ctx.parse(kwseq("add", "publication"));
      return publicationList(ctx, "addPublication");
    },
  },
  drop: {
    parse: (ctx) => {
      ctx.parse(kwseq("drop", "publication"));
      return publicationList(ctx, "dropPublication");
    },
  },
  refresh: {
    parse: (ctx) => {
      ctx.parse(kwseq("refresh", "publication"));
      return { kind: "refreshPublication", ...parseOptDefinition(ctx) };
    },
  },
  enable: {
    parse: (ctx) => {
      ctx.next(); // ENABLE
      return { kind: "enable" };
    },
  },
  disable: {
    parse: (ctx) => {
      ctx.next(); // DISABLE
      return { kind: "disable" };
    },
  },
  skip: {
    parse: (ctx) => {
      ctx.next(); // SKIP
      return { kind: "skip", options: ctx.parse(relationOptions) };
    },
  },
  rename: { parse: parseRenameTo },
  owner: { parse: parseOwnerTo },
};
const SUBSCRIPTION_ACTION_EXPECTED = keyList(SUBSCRIPTION_ACTIONS);

function alterSubscriptionRest(ctx: ParseContext<SqlTokenType>, start: Position): Stmt {
  ctx.next(); // SUBSCRIPTION
  const name = ctx.parse(nameWord);
  const action = dispatch(SUBSCRIPTION_ACTIONS, SUBSCRIPTION_ACTION_EXPECTED, ctx);
  if (action.kind === "rename" || action.kind === "ownerTo") {
    const object = { objectType: "subscription", name: [name] };
    return { kind: "alterObject", object, action, span: ctx.spanFrom(start) };
  }
  return { kind: "alterSubscription", name, action, span: ctx.spanFrom(start) };
}

// --- long-tail objects: casts, collations, operators, text search, … ---
//
// Most of these objects are created from PG's `definition`, a parenthesised
// `name [= value]` list whose names are ColLabels and whose values are
// parseDefinition's to read. Every lead and clause word is matched by value, so
// none of them stops being usable as a name.

// A number in a definition list, a sign folded in. The node carries no span,
// so numberNode's is dropped.
function definitionNumber(ctx: ParseContext<SqlTokenType>, start: Position, sign: string): DefinitionArg {
  const text = ctx.next()!.value;
  const { value, raw } = numberNode(text, ctx.spanFrom(start), sign);
  return { kind: "number", value, ...(raw !== undefined && { raw }) };
}

// One definition value, PG's def_arg: a string, a signed number, an operator
// (bare, or as `OPERATOR(schema.op)`), NONE, a reserved keyword, or else a type
// name, which covers every plain word (`btree`, `icu`, `int4`).
function parseDefinitionArg(ctx: ParseContext<SqlTokenType>): DefinitionArg {
  const start = ctx.position();
  const tok = ctx.peek();
  if (tok?.type === "string") {
    ctx.next();
    return { kind: "string", value: tok.value };
  }
  if (tok?.type === "number") return definitionNumber(ctx, start, "");
  if (tok?.type === "op") {
    if ((tok.value === "-" || tok.value === "+") && ctx.peekAhead(1)?.type === "number") {
      ctx.next(); // the sign
      return definitionNumber(ctx, start, tok.value);
    }
    return { kind: "operator", name: [ctx.parse(sortOperator)] };
  }
  if (tok?.type === "ident") {
    if (tok.value === "operator" && isPuncToken(ctx.peekAhead(1), "(")) {
      ctx.next(); // OPERATOR
      ctx.next(); // "("
      const name = parseAnyOperator(ctx);
      expectClose(ctx);
      return { kind: "operator", name };
    }
    if (tok.value === "none") {
      ctx.next();
      return { kind: "none" };
    }
    if (RESERVED.has(tok.value)) {
      ctx.next();
      return { kind: "keyword", value: tok.value };
    }
  }
  if (tok?.type === "ident" || tok?.type === "qident") return { kind: "type", type: ctx.parse(typeRef) };
  return ctx.croak(`Expected a name, a number, a string or an operator but found ${describeFound(tok)}`);
}

// PG's `definition`, `( name [= value], … )`, entered on the `(`.
function parseDefinition(ctx: ParseContext<SqlTokenType>): DefinitionElem[] {
  if (!ctx.is("punc", "(")) ctx.croak(`Expected "(" but found ${describeFound(ctx.peek())}`);
  ctx.next(); // "("
  const elements = commaList(ctx, (c): DefinitionElem => {
    const name = optionName(c);
    return c.eat("op", "=") === null ? { name } : { name, value: parseDefinitionArg(c) };
  });
  expectClose(ctx);
  return elements;
}

// A bare string, PG's Sconst.
function stringConst(ctx: ParseContext<SqlTokenType>): string {
  if (!ctx.is("string")) return ctx.croak(`Expected a string but found ${describeFound(ctx.peek())}`);
  return ctx.next()!.value;
}

// A plain integer, PG's Iconst.
function integerConst(ctx: ParseContext<SqlTokenType>): number {
  if (!isIntegerConstant(ctx.peek())) ctx.croak(`Expected an integer but found ${describeFound(ctx.peek())}`);
  return Number(ctx.next()!.value);
}

// A function named with its optional argument list, as a routine reference
// reads it, the list omitted when not written.
function routineWithArgs(ctx: ParseContext<SqlTokenType>): { name: string[]; signature?: DropSignature } {
  const { name, signature } = ctx.parse(routineRef);
  return signature === null ? { name } : { name, signature };
}

function createCastRest(ctx: ParseContext<SqlTokenType>): Stmt {
  const start = ctx.position();
  ctx.parse(kw("cast"));
  const { source, target } = parseCastTypes(ctx);
  let method: CreateCast["method"];
  let fn: CreateCast["function"];
  if (ctx.eat("ident", "without") !== null) {
    ctx.parse(kw("function"));
    method = "withoutFunction";
  } else {
    if (ctx.eat("ident", "with") === null) {
      return ctx.croak(`Expected "with" or "without" but found ${describeFound(ctx.peek())}`);
    }
    if (ctx.eat("ident", "inout") !== null) {
      method = "inout";
    } else if (ctx.eat("ident", "function") !== null) {
      method = "function";
      fn = routineWithArgs(ctx);
    } else {
      return ctx.croak(`Expected "function" or "inout" but found ${describeFound(ctx.peek())}`);
    }
  }
  let context: CreateCast["context"];
  if (ctx.eat("ident", "as") !== null) {
    if (ctx.eat("ident", "assignment") !== null) context = "assignment";
    else if (ctx.eat("ident", "implicit") !== null) context = "implicit";
    else return ctx.croak(`Expected "assignment" or "implicit" but found ${describeFound(ctx.peek())}`);
  }
  return {
    kind: "createCast",
    source,
    target,
    method,
    ...(fn !== undefined && { function: fn }),
    ...(context !== undefined && { context }),
    span: ctx.spanFrom(start),
  };
}

function createCollationRest(ctx: ParseContext<SqlTokenType>): Stmt {
  const start = ctx.position();
  ctx.parse(kw("collation"));
  const ifNotExists = parseIfNotExists(ctx);
  const name = ctx.parse(qualName);
  if (ctx.eat("ident", "from") !== null) {
    return { kind: "createCollation", ifNotExists, name, from: ctx.parse(qualName), span: ctx.spanFrom(start) };
  }
  if (!ctx.is("punc", "(")) ctx.croak(`Expected "(" or "from" but found ${describeFound(ctx.peek())}`);
  return { kind: "createCollation", ifNotExists, name, definition: parseDefinition(ctx), span: ctx.spanFrom(start) };
}

// `[DEFAULT] CONVERSION …`; DEFAULT is the dispatch key of the DEFAULT form.
function createConversionRest(ctx: ParseContext<SqlTokenType>): Stmt {
  const start = ctx.position();
  const isDefault = ctx.eat("ident", "default") !== null;
  ctx.parse(kw("conversion"));
  const name = ctx.parse(qualName);
  ctx.parse(kw("for"));
  const source = stringConst(ctx);
  ctx.parse(kw("to"));
  const target = stringConst(ctx);
  ctx.parse(kw("from"));
  const fn = ctx.parse(qualName);
  return {
    kind: "createConversion",
    ...(isDefault && { default: true }),
    name,
    source,
    target,
    function: fn,
    span: ctx.spanFrom(start),
  };
}

// One item after CREATE STATISTICS … ON: a column, a function call, or a
// parenthesised expression, as PG's stats_param admits; any other expression
// must be parenthesised.
function parseStatsParam(ctx: ParseContext<SqlTokenType>): Expr {
  if (ctx.eat("punc", "(") !== null) {
    const expr = ctx.parse(expression);
    expectClose(ctx);
    return expr;
  }
  const start = ctx.position();
  const castCall = ctx.is("ident", "cast");
  const expr = ctx.parse(expression);
  if (isBareFuncExpr(expr, castCall)) return expr;
  const message = "A statistics expression other than a column or a function call must be parenthesised";
  return ctx.croak(message, start, ctx.lastEnd());
}

// The name is optional unless IF NOT EXISTS is written; `on` is reserved, so it
// can never be read as one.
function createStatisticsRest(ctx: ParseContext<SqlTokenType>): Stmt {
  const start = ctx.position();
  ctx.parse(kw("statistics"));
  const ifNotExists = parseIfNotExists(ctx);
  const name = ifNotExists || isNameToken(ctx.peek()) ? ctx.parse(qualName) : undefined;
  let kinds: string[] | undefined;
  if (ctx.eat("punc", "(") !== null) {
    kinds = commaList(ctx, (c) => c.parse(nameWord));
    expectClose(ctx);
  }
  ctx.parse(kw("on"));
  const on = commaList(ctx, parseStatsParam);
  ctx.parse(kw("from"));
  const from = commaList(ctx, (c) => c.parse(qualName));
  return {
    kind: "createStatistics",
    ifNotExists,
    ...(name !== undefined && { name }),
    ...(kinds !== undefined && { kinds }),
    on,
    from,
    span: ctx.spanFrom(start),
  };
}

// `EXECUTE {FUNCTION | PROCEDURE} name()` — the empty argument list is required.
function createEventTriggerRest(ctx: ParseContext<SqlTokenType>): Stmt {
  const start = ctx.position();
  ctx.parse(kwseq("event", "trigger"));
  const name = ctx.parse(nameWord);
  ctx.parse(kw("on"));
  const event = ctx.parse(nameWord);
  let when: CreateEventTrigger["when"];
  if (ctx.eat("ident", "when") !== null) {
    when = [];
    do {
      const variable = ctx.parse(nameWord);
      ctx.parse(kw("in"));
      ctx.parse(punc("("));
      const values = commaList(ctx, stringConst);
      expectClose(ctx);
      when.push({ variable, values });
    } while (ctx.eat("ident", "and") !== null);
  }
  ctx.parse(kw("execute"));
  let routine: "function" | "procedure";
  if (ctx.eat("ident", "function") !== null) routine = "function";
  else if (ctx.eat("ident", "procedure") !== null) routine = "procedure";
  else return ctx.croak(`Expected "function" or "procedure" but found ${describeFound(ctx.peek())}`);
  const fn = ctx.parse(qualName);
  ctx.parse(punc("("));
  expectClose(ctx);
  return {
    kind: "createEventTrigger",
    name,
    event,
    ...(when !== undefined && { when }),
    execute: { routine, name: fn },
    span: ctx.spanFrom(start),
  };
}

// `[TRUSTED] [PROCEDURAL] LANGUAGE …`, entered past `lead`, the first of those
// words, which REPLACEABLE_CREATE consumes.
function parseLanguageBody(
  ctx: ParseContext<SqlTokenType>,
  start: Position,
  orReplace: boolean,
  lead: "trusted" | "procedural" | "language",
): Stmt {
  const trusted = lead === "trusted";
  const procedural = lead === "procedural" || (trusted && ctx.eat("ident", "procedural") !== null);
  if (lead !== "language" && ctx.eat("ident", "language") === null) {
    const expected = trusted && !procedural ? '"procedural" or "language"' : '"language"';
    return ctx.croak(`Expected ${expected} but found ${describeFound(ctx.peek())}`);
  }
  const name = ctx.parse(nameWord);
  const handlers: Pick<CreateLanguage, "handler" | "inline" | "validator"> = {};
  if (ctx.eat("ident", "handler") !== null) {
    handlers.handler = ctx.parse(qualName);
    if (ctx.eat("ident", "inline") !== null) handlers.inline = ctx.parse(qualName);
    if (ctx.eat("ident", "validator") !== null) {
      handlers.validator = ctx.parse(qualName);
    } else if (ctx.is("ident", "no")) {
      ctx.parse(kwseq("no", "validator"));
      handlers.validator = null;
    }
  }
  return {
    kind: "createLanguage",
    orReplace,
    ...(trusted && { trusted: true }),
    ...(procedural && { procedural: true }),
    name,
    ...handlers,
    span: ctx.spanFrom(start),
  };
}

function createAccessMethodRest(ctx: ParseContext<SqlTokenType>): Stmt {
  const start = ctx.position();
  ctx.parse(kwseq("access", "method"));
  const name = ctx.parse(nameWord);
  ctx.parse(kw("type"));
  let type: CreateAccessMethod["type"];
  if (ctx.eat("ident", "table") !== null) type = "table";
  else if (ctx.eat("ident", "index") !== null) type = "index";
  else return ctx.croak(`Expected "table" or "index" but found ${describeFound(ctx.peek())}`);
  ctx.parse(kw("handler"));
  return { kind: "createAccessMethod", name, type, handler: ctx.parse(qualName), span: ctx.spanFrom(start) };
}

// The word after TEXT SEARCH that names one of its four object kinds.
type TextSearchKind = CreateTextSearch["objectType"];
const TEXT_SEARCH_KINDS: readonly TextSearchKind[] = ["parser", "dictionary", "template", "configuration"];
const TEXT_SEARCH_KIND_EXPECTED = quoteList([...TEXT_SEARCH_KINDS]);
function parseTextSearchKind(ctx: ParseContext<SqlTokenType>): TextSearchKind {
  ctx.parse(kwseq("text", "search"));
  const tok = ctx.peek();
  const kind = TEXT_SEARCH_KINDS.find((k) => tok?.type === "ident" && tok.value === k);
  if (kind === undefined) return ctx.croak(`Expected ${TEXT_SEARCH_KIND_EXPECTED} but found ${describeFound(tok)}`);
  ctx.next();
  return kind;
}

function createTextSearchRest(ctx: ParseContext<SqlTokenType>): Stmt {
  const start = ctx.position();
  const objectType = parseTextSearchKind(ctx);
  const name = ctx.parse(qualName);
  return { kind: "createTextSearch", objectType, name, definition: parseDefinition(ctx), span: ctx.spanFrom(start) };
}

// Whether the cursor sits on `OPERATOR CLASS` or `OPERATOR FAMILY`: as in
// parseObjectKind, CLASS or FAMILY is the keyword only when a name follows it,
// so `OPERATOR class.+` is an operator in a schema called `class`.
function opClassWordAhead(ctx: ParseContext<SqlTokenType>): "class" | "family" | null {
  const word = ctx.peekAhead(1);
  if (word?.type !== "ident" || (word.value !== "class" && word.value !== "family")) return null;
  return isNameToken(ctx.peekAhead(2)) ? word.value : null;
}

// One item of an operator class's AS list (PG's opclass_item).
function parseOpClassItem(ctx: ParseContext<SqlTokenType>): OpClassItem {
  if (ctx.eat("ident", "operator") !== null) {
    const strategy = integerConst(ctx);
    const operator = parseAnyOperator(ctx);
    const operands = ctx.is("punc", "(") ? parseOperandTypes(ctx) : undefined;
    let purpose: Extract<OpClassItem, { kind: "operator" }>["purpose"];
    if (ctx.eat("ident", "for") !== null) {
      if (ctx.eat("ident", "search") !== null) {
        purpose = { kind: "search" };
      } else if (ctx.is("ident", "order")) {
        ctx.parse(kwseq("order", "by"));
        purpose = { kind: "orderBy", family: ctx.parse(qualName) };
      } else {
        return ctx.croak(`Expected "search" or "order" but found ${describeFound(ctx.peek())}`);
      }
    }
    return {
      kind: "operator",
      strategy,
      operator,
      ...(operands !== undefined && { operands }),
      ...(purpose !== undefined && { purpose }),
    };
  }
  if (ctx.eat("ident", "function") !== null) {
    const support = integerConst(ctx);
    let types: ColType[] | undefined;
    if (ctx.eat("punc", "(") !== null) {
      types = commaList(ctx, (c) => c.parse(typeRef));
      expectClose(ctx);
    }
    return { kind: "function", support, ...(types !== undefined && { types }), ...routineWithArgs(ctx) };
  }
  if (ctx.eat("ident", "storage") !== null) return { kind: "storage", type: ctx.parse(typeRef) };
  return ctx.croak(`Expected "operator", "function" or "storage" but found ${describeFound(ctx.peek())}`);
}

// `OPERATOR op (definition)`, `OPERATOR CLASS …` or `OPERATOR FAMILY …`.
function createOperatorRest(ctx: ParseContext<SqlTokenType>): Stmt {
  const start = ctx.position();
  const sub = opClassWordAhead(ctx);
  if (sub === "family") {
    ctx.parse(kwseq("operator", "family"));
    const name = ctx.parse(qualName);
    ctx.parse(kw("using"));
    return { kind: "createOperatorFamily", name, using: ctx.parse(nameWord), span: ctx.spanFrom(start) };
  }
  if (sub === "class") {
    ctx.parse(kwseq("operator", "class"));
    const name = ctx.parse(qualName);
    const isDefault = ctx.eat("ident", "default") !== null;
    ctx.parse(kw("for"));
    ctx.parse(kw("type"));
    const type = ctx.parse(typeRef);
    ctx.parse(kw("using"));
    const using = ctx.parse(nameWord);
    const family = ctx.eat("ident", "family") !== null ? ctx.parse(qualName) : undefined;
    ctx.parse(kw("as"));
    return {
      kind: "createOperatorClass",
      name,
      ...(isDefault && { default: true }),
      type,
      using,
      ...(family !== undefined && { family }),
      items: commaList(ctx, parseOpClassItem),
      span: ctx.spanFrom(start),
    };
  }
  ctx.parse(kw("operator"));
  const name = parseAnyOperator(ctx);
  return { kind: "createOperator", name, definition: parseDefinition(ctx), span: ctx.spanFrom(start) };
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
      if (ctx.is("ident", "all")) return alterAllInTablespaceRest(ctx, start, "index");
      const ifExists = parseIfExists(ctx);
      const name = ctx.parse(qualName);
      const parseAction = (c: ParseContext<SqlTokenType>) => dispatch(INDEX_ACTIONS, INDEX_ACTION_EXPECTED, c);
      const solo = { rename: "RENAME", attachPartition: "ATTACH PARTITION" } as const;
      const actionStart = ctx.position();
      const actions = parseActionList(ctx, "INDEX", parseAction, INDEX_ACTIONS, solo);
      // PG's ATTACH PARTITION form of ALTER INDEX has no IF EXISTS.
      if (ifExists && actions[0]!.kind === "attachPartition") {
        ctx.croak("ALTER INDEX IF EXISTS cannot ATTACH PARTITION", actionStart, ctx.lastEnd());
      }
      return { kind: "alterIndex", ifExists, name, actions, span: ctx.spanFrom(start) };
    },
  },
  function: {
    parse: (ctx, start) => {
      ctx.next(); // FUNCTION
      const { name, signature } = ctx.parse(routineRef);
      const action = dispatch(FUNCTION_ACTIONS, FUNCTION_ACTION_EXPECTED, ctx);
      return { kind: "alterFunction", name, args: signature?.args ?? null, action, span: ctx.spanFrom(start) };
    },
  },
  aggregate: {
    parse: (ctx, start) => {
      ctx.next(); // AGGREGATE
      const { name, signature } = ctx.parse(aggregateRef);
      const { star, args } = signature;
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
      if (ctx.is("ident", "all")) return alterAllInTablespaceRest(ctx, start, "materialized view");
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
  extension: {
    parse: (ctx, start) => {
      ctx.next(); // EXTENSION
      const name = ctx.parse(nameWord);
      const action = dispatch(EXTENSION_ACTIONS, EXTENSION_ACTION_EXPECTED, ctx);
      return { kind: "alterExtension", name, action, span: ctx.spanFrom(start) };
    },
  },
  default: { parse: alterDefaultPrivilegesRest },
  role: { parse: (ctx, start) => alterRoleRest(ctx, start, "role") },
  // USER only; `ALTER USER MAPPING` is not supported and reads as a user named
  // `mapping` followed by stray words, as on DROP.
  user: { parse: (ctx, start) => alterRoleRest(ctx, start, "user") },
  database: { parse: alterDatabaseRest },
  tablespace: { parse: alterTablespaceRest },
  policy: { parse: alterPolicyRest },
  publication: { parse: alterPublicationRest },
  subscription: { parse: alterSubscriptionRest },
};
// Every other kind the generic ALTER takes leads it here. A dedicated target
// that takes one of these lead words must hand that word's generic kinds to
// alterObjectRest itself (`FOREIGN DATA WRAPPER` beside `FOREIGN TABLE`), and
// then drop the word from this loop, which refuses to shadow it silently.
for (const word of ALTER_OBJECTS.next.keys()) {
  if (Object.hasOwn(ALTER_TARGETS, word)) throw new Error(`ALTER ${word} has a dedicated target`);
  ALTER_TARGETS[word] = { parse: alterObjectRest };
}
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
  extra: Pick<DropStmt, "signatures" | "table" | "force" | "operands" | "using" | "source" | "target"> = {},
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

// An operator and its `(left, right)` operand types, as DROP OPERATOR lists them.
const operatorWithArgtypes = custom<Required<Pick<ObjectRef, "name" | "operands">>, SqlTokenType>(parseOperatorRef, {
  expected: "an operator",
  first: [{ type: "op" }, ...nameWord.first()],
});

// `DROP kind [IF EXISTS] name ON table [CASCADE|RESTRICT]` — one object.
const onTableDrop = (objectType: string): DropEntry => ({
  parse: (ctx, start) => {
    ctx.next(); // the object keyword
    const ifExists = parseIfExists(ctx);
    const name = ctx.parse(nameWord);
    ctx.parse(kw("on"));
    const table = ctx.parse(qualName);
    const behavior = ctx.parse(dropBehavior);
    return dropNode(ctx, start, objectType, { concurrently: false, ifExists, names: [[name]], behavior }, { table });
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
  trigger: onTableDrop("trigger"),
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
  // `DROP OWNED BY role[, …] [CASCADE|RESTRICT]` — the objects the roles own.
  owned: {
    parse: (ctx, start) => {
      ctx.parse(kwseq("owned", "by"));
      const roles = commaList(ctx, parseRoleSpec);
      return { kind: "dropOwned", roles, behavior: ctx.parse(dropBehavior), span: ctx.spanFrom(start) };
    },
  },
  role: listDrop("role", unqualName, { behavior: false }),
  // USER only; `DROP USER MAPPING` is not supported and reads as a user named
  // `mapping` followed by stray words.
  user: listDrop("user", unqualName, { behavior: false }),
  // `DROP TABLESPACE [IF EXISTS] name` — one tablespace, and no CASCADE / RESTRICT.
  tablespace: {
    parse: (ctx, start) => {
      ctx.next(); // TABLESPACE
      const ifExists = parseIfExists(ctx);
      const names = [[ctx.parse(nameWord)]];
      return dropNode(ctx, start, "tablespace", { concurrently: false, ifExists, names, behavior: null });
    },
  },
  policy: onTableDrop("policy"),
  publication: listDrop("publication", unqualName),
  // `DROP SUBSCRIPTION [IF EXISTS] name [CASCADE|RESTRICT]` — one subscription.
  subscription: {
    parse: (ctx, start) => {
      ctx.next(); // SUBSCRIPTION
      const ifExists = parseIfExists(ctx);
      const name = ctx.parse(nameWord);
      const behavior = ctx.parse(dropBehavior);
      const fields = { concurrently: false, ifExists, names: [[name]], behavior };
      return dropNode(ctx, start, "subscription", fields);
    },
  },
  collation: listDrop("collation", qualName),
  conversion: listDrop("conversion", qualName),
  statistics: listDrop("statistics", qualName),
  event: listDrop("event trigger", unqualName, { lead: kwseq("event", "trigger") }),
  language: listDrop("language", unqualName),
  procedural: listDrop("language", unqualName, { lead: kwseq("procedural", "language") }),
  access: listDrop("access method", unqualName, { lead: kwseq("access", "method") }),
  // `DROP TEXT SEARCH {PARSER | DICTIONARY | TEMPLATE | CONFIGURATION} …`.
  text: {
    parse: (ctx, start) => {
      const objectType = `text search ${parseTextSearchKind(ctx)}`;
      const { ifExists, items: names } = parseDropNames(ctx, qualName);
      const fields = { concurrently: false, ifExists, names, behavior: ctx.parse(dropBehavior) };
      return dropNode(ctx, start, objectType, fields);
    },
  },
  // `DROP CAST [IF EXISTS] (source AS target) [CASCADE|RESTRICT]` — one cast,
  // named by its types alone.
  cast: {
    parse: (ctx, start) => {
      ctx.next(); // CAST
      const ifExists = parseIfExists(ctx);
      const { source, target } = parseCastTypes(ctx);
      const fields = { concurrently: false, ifExists, names: [], behavior: ctx.parse(dropBehavior) };
      return dropNode(ctx, start, "cast", fields, { source, target });
    },
  },
  // `DROP OPERATOR [IF EXISTS] op (left, right)[, …]`, and `DROP OPERATOR
  // {CLASS | FAMILY} [IF EXISTS] name USING method` — one class or family.
  operator: {
    parse: (ctx, start) => {
      const sub = opClassWordAhead(ctx);
      if (sub !== null) {
        ctx.next(); // OPERATOR
        ctx.next(); // CLASS / FAMILY
        const ifExists = parseIfExists(ctx);
        const name = ctx.parse(qualName);
        ctx.parse(kw("using"));
        const using = ctx.parse(nameWord);
        const fields = { concurrently: false, ifExists, names: [name], behavior: ctx.parse(dropBehavior) };
        return dropNode(ctx, start, `operator ${sub}`, fields, { using });
      }
      ctx.next(); // OPERATOR
      const { ifExists, items } = parseDropNames(ctx, operatorWithArgtypes);
      const names = items.map((i) => i.name);
      const fields = { concurrently: false, ifExists, names, behavior: ctx.parse(dropBehavior) };
      return dropNode(ctx, start, "operator", fields, { operands: items.map((i) => i.operands) });
    },
  },
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

// PG's relation_expr, a LOCK, MERGE, UPDATE, DELETE, TRUNCATE, ALTER TABLE or
// CREATE INDEX target, or a publication's TABLE entry — `[ONLY] name [*]` or
// `ONLY (name)`.
// `only` and `table` are reserved, so neither can begin a name.
const relationExpr = custom<LockTarget, SqlTokenType>(
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

const truncateStmt = seq(
  skip(kw("truncate")),
  skip(optional(kw("table"))), // optional TABLE noise word
  field("tables", sepBy(relationExpr, P(","))),
  field(
    "identity",
    optional(
      seq(field("m", oneOf(kw("restart"), kw("continue"))), skip(kw("identity"))).map(
        (s) => s.m.value as "restart" | "continue",
      ),
    ),
  ),
  field("behavior", dropBehavior),
).map(
  ({ tables, identity, behavior }, span): Stmt => ({
    kind: "truncate",
    names: tables.map((t) => t.name),
    ...(tables.some((t) => t.only) && { only: tables.map((t) => t.only) }),
    identity,
    behavior,
    span,
  }),
);

// `REFRESH MATERIALIZED VIEW [CONCURRENTLY] name [WITH [NO] DATA]`. Every word
// is matched by value and stays a name elsewhere. CONCURRENTLY is taken whenever
// it follows VIEW, as DROP takes it: PG ranks it a type_func_name keyword, which
// is no table name there either.
const refreshStmt = custom<Stmt, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    ctx.parse(kwseq("refresh", "materialized", "view"));
    const concurrently = ctx.eat("ident", "concurrently") !== null;
    const name = ctx.parse(qualName);
    const withData = parseWithData(ctx);
    return { kind: "refreshMaterializedView", concurrently, name, withData, span: ctx.spanFrom(start) };
  },
  { expected: '"refresh"', first: [{ type: "ident", value: "refresh" }] },
);

// A comment's or security label's text: a string — a dollar-quoted one
// (`$tag$…$tag$`) is one `string` token too — or NULL to clear it.
const commentText = oneOf(
  token("string").map((n) => n.value),
  kw("null").map((): string | null => null),
);

// `COMMENT ON object IS text`, over every kind of OBJECT_KINDS.
const commentStmt = custom<Stmt, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    ctx.parse(kw("comment"));
    ctx.parse(kw("on"));
    const { ref } = parseObjectRef(ctx, COMMENT_OBJECTS);
    ctx.parse(kw("is"));
    return { kind: "comment", ...ref, comment: ctx.parse(commentText), span: ctx.spanFrom(start) };
  },
  { expected: '"comment"', first: [{ type: "ident", value: "comment" }] },
);

// `SECURITY LABEL [FOR provider] ON object IS label`, over the kinds PG labels.
const securityLabelStmt = custom<Stmt, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    ctx.parse(kwseq("security", "label"));
    const provider = ctx.eat("ident", "for") !== null ? parseWordOrString(ctx) : null;
    ctx.parse(kw("on"));
    const { ref } = parseObjectRef(ctx, LABEL_OBJECTS);
    ctx.parse(kw("is"));
    const label = ctx.parse(commentText);
    const head = provider === null ? { kind: "securityLabel" as const } : { kind: "securityLabel" as const, provider };
    return { ...head, ...ref, label, span: ctx.spanFrom(start) };
  },
  { expected: '"security"', first: [{ type: "ident", value: "security" }] },
);

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
  // A parameter's privilege; reserved here, though not in PG.
  "set",
]);

// The kinds a privilege may name ahead of its objects (PG's privilege_target),
// read through the same kind trie and reference shapes as OBJECT_KINDS. Order
// is gram.y's. TABLE is also the kind when none is written.
const GRANT_KINDS: readonly ObjectKind[] = [
  { objectType: "table", shape: "qualName" },
  { objectType: "sequence", shape: "qualName" },
  { objectType: "foreign data wrapper", shape: "name" },
  { objectType: "foreign server", shape: "name" },
  { objectType: "function", shape: "routine" },
  { objectType: "procedure", shape: "routine" },
  { objectType: "routine", shape: "routine" },
  { objectType: "database", shape: "name" },
  { objectType: "domain", shape: "qualName" },
  { objectType: "language", shape: "name" },
  { objectType: "large object", shape: "largeObject" },
  // A dotted name: an extension's parameters are `ext.name`.
  { objectType: "parameter", shape: "qualName" },
  { objectType: "schema", shape: "name" },
  { objectType: "tablespace", shape: "name" },
  { objectType: "type", shape: "qualName" },
];
const GRANT_TABLE = GRANT_KINDS[0]!;
const GRANT_OBJECTS = objectKindTrie(() => true, GRANT_KINDS);

// Plural → singular for the `ALL {TABLES|…} IN SCHEMA` object form.
const ALL_IN_SCHEMA: Record<string, string> = {
  tables: "table",
  sequences: "sequence",
  functions: "function",
  procedures: "procedure",
  routines: "routine",
};

// Plural → singular for the `ON {TABLES|…}` of ALTER DEFAULT PRIVILEGES.
const DEFAULT_PRIVILEGE_OBJECTS: Record<string, string> = {
  tables: "table",
  functions: "function",
  routines: "routine",
  sequences: "sequence",
  types: "type",
  schemas: "schema",
};

// One privilege keyword (or, in a role grant, a role name) with an optional
// `(col, …)` column list, or the two-word ALTER SYSTEM. `nameWord` excludes
// reserved words, so privilege keywords — several of which are reserved — are
// matched by value first.
function parsePrivilege(ctx: ParseContext<SqlTokenType>): Privilege {
  const cur = ctx.peek();
  if (ctx.is("ident", "alter") && ctx.peekAhead(1)?.value === "system") {
    ctx.parse(kwseq("alter", "system"));
    return { name: "alter system", columns: null };
  }
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

// `privilege[, …]`, or `ALL [PRIVILEGES] [(col, …)]` where `allowAll` admits
// it; elsewhere the reserved ALL croaks as no name.
function parsePrivileges(
  ctx: ParseContext<SqlTokenType>,
  allowAll: boolean,
): { privileges: Privilege[] | "all"; allColumns?: string[] } {
  if (!allowAll || !ctx.is("ident", "all")) return { privileges: commaList(ctx, parsePrivilege) };
  ctx.next(); // ALL
  ctx.eat("ident", "privileges"); // optional PRIVILEGES
  return ctx.is("punc", "(") ? { privileges: "all", allColumns: ctx.parse(columnList) } : { privileges: "all" };
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
    return { objectType: ALL_IN_SCHEMA[plural]!, names: [], inSchema: commaList(ctx, (c) => [c.parse(nameWord)]) };
  }
  // `[kind] object[, …]`. An unreserved kind word is the kind only when a name
  // follows it, as in PG, so `ON function TO u` grants on a table called
  // `function`; TABLE and FOREIGN, reserved, can be nothing else.
  const tok = ctx.peek();
  const kind =
    tok?.type === "ident" &&
    GRANT_OBJECTS.next.has(tok.value) &&
    (RESERVED.has(tok.value) || isNameToken(ctx.peekAhead(1)))
      ? parseObjectKind(ctx, GRANT_OBJECTS)
      : GRANT_TABLE;
  const refs = commaList<Omit<ObjectRef, "objectType">>(ctx, OBJECT_REF_SHAPES[kind.shape]);
  const object: GrantObject = {
    objectType: kind.objectType,
    names: refs.flatMap((r) => (r.name === undefined ? [] : [r.name])),
    inSchema: null,
  };
  // Only when some routine writes its argument list, so a name-only grant keeps
  // the shape it always had.
  if (refs.some((r) => r.signature !== undefined)) object.signatures = refs.map((r) => r.signature ?? null);
  if (kind.shape === "largeObject") object.oids = refs.map((r) => r.oid!);
  return object;
}

// A single grantee: `[GROUP] role`, PUBLIC, or a role spec (see parseRoleSpec).
function parseGrantee(ctx: ParseContext<SqlTokenType>): string {
  ctx.eat("ident", "group"); // optional GROUP noise word
  if (ctx.eat("ident", "public") !== null) return "public";
  return parseRoleSpec(ctx);
}

// The shared `privileges [ON object] {TO|FROM} grantees` middle of GRANT and
// REVOKE. `granteeKw` is "to" for GRANT, "from" for REVOKE. `on` says whether
// an `ON object` is optional (a privilege or a role grant), required (after
// REVOKE GRANT OPTION FOR) or refused (after REVOKE {ADMIN|INHERIT|SET} OPTION
// FOR); ALL is only ever an object's, so it requires ON too. A role grant's
// grantees are plain roles, with no GROUP noise word.
function parseGrantBody(
  ctx: ParseContext<SqlTokenType>,
  granteeKw: string,
  on: "optional" | "required" | "refused",
): { privileges: Privilege[] | "all"; allColumns?: string[]; on: GrantObject | null; grantees: string[] } {
  const privileges = parsePrivileges(ctx, on !== "refused");
  let object: GrantObject | null = null;
  if (on === "required" || privileges.privileges === "all") {
    ctx.parse(kw("on"));
    object = parseGrantObject(ctx);
  } else if (on === "optional" && ctx.eat("ident", "on") !== null) {
    object = parseGrantObject(ctx);
  }
  ctx.parse(kw(granteeKw));
  const grantees = commaList(ctx, object === null ? parseRoleSpec : parseGrantee);
  return { ...privileges, on: object, grantees };
}

// `GRANTED BY role`, or undefined when absent.
function parseGrantedBy(ctx: ParseContext<SqlTokenType>): string | undefined {
  if (!ctx.is("ident", "granted")) return undefined;
  ctx.parse(kwseq("granted", "by"));
  return parseRoleSpec(ctx);
}

// One `{ADMIN | INHERIT | SET} {OPTION | TRUE | FALSE}` entry of a role grant's
// WITH list. PG's grammar takes any word for the name and refuses the others
// only when it runs the grant; these three, quoted or not, are all it knows.
const ROLE_GRANT_OPTIONS = ["admin", "inherit", "set"] as const;
function parseRoleGrantOption(ctx: ParseContext<SqlTokenType>): RoleGrantOption {
  const tok = ctx.peek();
  const name = ROLE_GRANT_OPTIONS.find((n) => (tok?.type === "ident" || tok?.type === "qident") && tok.value === n);
  if (name === undefined) return ctx.croak(`Expected ${quoteList(ROLE_GRANT_OPTIONS)} but found ${describeFound(tok)}`);
  ctx.next();
  if (ctx.eat("ident", "option") !== null || ctx.eat("ident", "true") !== null) return { name, value: true };
  if (ctx.eat("ident", "false") !== null) return { name, value: false };
  return ctx.croak(`Expected ${quoteList(["option", "true", "false"])} but found ${describeFound(ctx.peek())}`);
}

// The words a REVOKE's `word OPTION FOR` may open with: GRANT for an object's
// privileges, the rest for a role's.
const REVOKE_OPTION_WORDS: ReadonlySet<string> = new Set(["grant", "admin", "inherit", "set"]);

const grantStmt = custom<Stmt, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    const revoke = ctx.eat("ident", "revoke") !== null;
    if (!revoke) ctx.parse(kw("grant"));
    if (revoke) {
      // REVOKE [{GRANT|ADMIN|INHERIT|SET} OPTION FOR] …
      const w = ctx.peek();
      // A role option's name may be quoted, as any ColId may; GRANT, reserved,
      // only bare.
      const optionFor =
        w !== null &&
        (w.type === "ident" || (w.type === "qident" && w.value !== "grant")) &&
        REVOKE_OPTION_WORDS.has(w.value) &&
        ctx.peekAhead(1)?.type === "ident" &&
        ctx.peekAhead(1)?.value === "option"
          ? w.value
          : null;
      if (optionFor !== null) {
        ctx.next(); // the option name
        ctx.parse(kwseq("option", "for"));
      }
      const on = optionFor === null ? "optional" : optionFor === "grant" ? "required" : "refused";
      const body = parseGrantBody(ctx, "from", on);
      const grantedBy = parseGrantedBy(ctx);
      return {
        kind: "revoke",
        grantOptionFor: optionFor === "grant" || optionFor === "admin",
        ...(optionFor === "inherit" || optionFor === "set" ? { option: optionFor } : {}),
        privileges: body.privileges,
        ...(body.allColumns !== undefined ? { allColumns: body.allColumns } : {}),
        on: body.on,
        grantees: body.grantees,
        ...(grantedBy !== undefined ? { grantedBy } : {}),
        behavior: ctx.parse(dropBehavior),
        span: ctx.spanFrom(start),
      };
    }
    const body = parseGrantBody(ctx, "to", "optional");
    // An object grant's WITH is GRANT OPTION; a role grant's a list of options.
    let withGrantOption = false;
    let options: RoleGrantOption[] | undefined;
    if (ctx.eat("ident", "with") !== null) {
      if (body.on !== null) {
        ctx.parse(kwseq("grant", "option"));
        withGrantOption = true;
      } else {
        options = commaList(ctx, parseRoleGrantOption);
        for (const o of options) if (o.name === "admin") withGrantOption = o.value;
        // The lone ADMIN grant is what `withGrantOption` already says.
        if (options.length === 1 && options[0]!.name === "admin" && options[0]!.value) options = undefined;
      }
    }
    const grantedBy = parseGrantedBy(ctx);
    return {
      kind: "grant",
      privileges: body.privileges,
      ...(body.allColumns !== undefined ? { allColumns: body.allColumns } : {}),
      on: body.on,
      grantees: body.grantees,
      withGrantOption,
      ...(options !== undefined ? { options } : {}),
      ...(grantedBy !== undefined ? { grantedBy } : {}),
      span: ctx.spanFrom(start),
    };
  },
  {
    expected: '"grant" or "revoke"',
    first: [
      { type: "ident", value: "grant" },
      { type: "ident", value: "revoke" },
    ],
  },
);

// `ALTER DEFAULT PRIVILEGES [FOR {ROLE|USER} role[, …] | IN SCHEMA s[, …]]…
// {GRANT | REVOKE [GRANT OPTION FOR]} privileges ON {TABLES | …} {TO|FROM}
// grantee[, …] …`, entered at DEFAULT.
function alterDefaultPrivilegesRest(ctx: ParseContext<SqlTokenType>, start: Position): Stmt {
  ctx.parse(kwseq("default", "privileges"));
  const options: DefaultPrivilegesOption[] = [];
  for (;;) {
    if (ctx.eat("ident", "for") !== null) {
      if (ctx.eat("ident", "role") === null && ctx.eat("ident", "user") === null) {
        ctx.croak(`Expected ${quoteList(["role", "user"])} but found ${describeFound(ctx.peek())}`);
      }
      options.push({ kind: "forRole", roles: commaList(ctx, parseRoleSpec) });
    } else if (ctx.is("ident", "in")) {
      ctx.parse(kwseq("in", "schema"));
      options.push({ kind: "inSchema", schemas: commaList(ctx, (c) => c.parse(nameWord)) });
    } else {
      break;
    }
  }
  const revoke = ctx.eat("ident", "revoke") !== null;
  if (!revoke && ctx.eat("ident", "grant") === null) {
    ctx.croak(`Expected ${quoteList(["for", "in", "grant", "revoke"])} but found ${describeFound(ctx.peek())}`);
  }
  const grantOptionFor = revoke && ctx.is("ident", "grant") && ctx.peekAhead(1)?.value === "option";
  if (grantOptionFor) ctx.parse(kwseq("grant", "option", "for"));
  const privileges = parsePrivileges(ctx, true);
  ctx.parse(kw("on"));
  const plural = ctx.peek();
  if (plural?.type !== "ident" || !Object.hasOwn(DEFAULT_PRIVILEGE_OBJECTS, plural.value)) {
    ctx.croak(`Expected ${keyList(DEFAULT_PRIVILEGE_OBJECTS)} but found ${describeFound(plural)}`);
  }
  ctx.next();
  const objectType = DEFAULT_PRIVILEGE_OBJECTS[plural!.value]!;
  ctx.parse(kw(revoke ? "from" : "to"));
  const grantees = commaList(ctx, parseGrantee);
  let action: DefaultPrivilegesAction;
  if (revoke) {
    action = { kind: "revoke", grantOptionFor, ...privileges, objectType, grantees, behavior: ctx.parse(dropBehavior) };
  } else {
    const withGrantOption = ctx.eat("ident", "with") !== null;
    if (withGrantOption) ctx.parse(kwseq("grant", "option"));
    action = { kind: "grant", ...privileges, objectType, grantees, withGrantOption };
  }
  return { kind: "alterDefaultPrivileges", options, action, span: ctx.spanFrom(start) };
}

// `REASSIGN OWNED BY role[, …] TO role`. REASSIGN stays unreserved; nothing
// else opens a statement with it.
const reassignStmt = custom<Stmt, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    ctx.parse(kwseq("reassign", "owned", "by"));
    const roles = commaList(ctx, parseRoleSpec);
    ctx.parse(kw("to"));
    return { kind: "reassignOwned", roles, newRole: parseRoleSpec(ctx), span: ctx.spanFrom(start) };
  },
  { expected: '"reassign"', first: [{ type: "ident", value: "reassign" }] },
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
// Whether `t` (a peeked token) can open a transaction mode.
const isTransactionModeLead = (t: ReturnType<ParseContext<SqlTokenType>["peek"]>): boolean =>
  t !== null && t.type === "ident" && TRANSACTION_MODE_LEADS.has(t.value);
// Zero or more transaction modes (commas between them are optional in PG, but
// a comma must be followed by another mode).
function parseTransactionModes(ctx: ParseContext<SqlTokenType>): TransactionMode[] {
  const modes: TransactionMode[] = [];
  while (true) {
    if (!isTransactionModeLead(ctx.peek())) break;
    modes.push(parseTransactionMode(ctx));
    if (ctx.eat("punc", ",") !== null) expectTransactionMode(ctx);
  }
  return modes;
}

// Croaks unless a transaction mode follows (after a comma, or to open a list
// that must not be empty).
function expectTransactionMode(ctx: ParseContext<SqlTokenType>): void {
  if (!isTransactionModeLead(ctx.peek())) {
    ctx.croak(`Expected "isolation", "read", "not" or "deferrable" but found ${describeFound(ctx.peek())}`);
  }
}

// `AND [NO] CHAIN` on COMMIT / ROLLBACK — returns whether CHAIN (not NO CHAIN).
function parseAndChain(ctx: ParseContext<SqlTokenType>): boolean {
  if (ctx.eat("ident", "and") === null) return false;
  const no = ctx.eat("ident", "no") !== null;
  ctx.parse(kw("chain"));
  return !no;
}

// A string, PG's Sconst: a two-phase transaction's identifier, a subscription's
// conninfo.
function sconstString(ctx: ParseContext<SqlTokenType>): string {
  if (!ctx.is("string")) return ctx.croak(`Expected a string but found ${describeFound(ctx.peek())}`);
  return ctx.parse(strValue);
}

// `end` is reserved, so it is matched by value here, at a statement's head only:
// a construct that closes with END (a CASE, a `BEGIN ATOMIC … END` routine body)
// consumes its own END before statement dispatch could see it.
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
    // END [WORK | TRANSACTION] [AND [NO] CHAIN] is COMMIT's synonym; only
    // COMMIT takes PREPARED.
    if (head.value === "commit" || head.value === "end") {
      ctx.next();
      if (head.value === "commit" && ctx.eat("ident", "prepared") !== null) {
        return { kind: "commitPrepared", gid: sconstString(ctx), span: ctx.spanFrom(start) };
      }
      ctx.eat("ident", "work") ?? ctx.eat("ident", "transaction");
      return { kind: "commit", chain: parseAndChain(ctx), span: ctx.spanFrom(start) };
    }
    // ABORT [WORK | TRANSACTION] [AND [NO] CHAIN] is ROLLBACK's, without the TO
    // SAVEPOINT and PREPARED forms.
    if (head.value === "abort") {
      ctx.next();
      ctx.eat("ident", "work") ?? ctx.eat("ident", "transaction");
      return { kind: "rollback", chain: parseAndChain(ctx), savepoint: null, span: ctx.spanFrom(start) };
    }
    if (head.value === "rollback") {
      ctx.next();
      if (ctx.eat("ident", "prepared") !== null) {
        return { kind: "rollbackPrepared", gid: sconstString(ctx), span: ctx.spanFrom(start) };
      }
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
      { type: "ident", value: "end" },
      { type: "ident", value: "rollback" },
      { type: "ident", value: "abort" },
      { type: "ident", value: "savepoint" },
      { type: "ident", value: "release" },
    ],
  },
);

// `{ALL | name[, …]} {DEFERRED | IMMEDIATE}` after SET CONSTRAINTS.
function parseSetConstraints(ctx: ParseContext<SqlTokenType>, start: Position): Stmt {
  ctx.parse(kw("constraints"));
  const constraints = ctx.eat("ident", "all") !== null ? "all" : commaList(ctx, (c) => c.parse(qualName));
  const mode =
    ctx.eat("ident", "deferred") !== null
      ? "deferred"
      : ctx.eat("ident", "immediate") !== null
        ? "immediate"
        : ctx.croak(`Expected "deferred" or "immediate" but found ${describeFound(ctx.peek())}`);
  return { kind: "setConstraints", constraints, mode, span: ctx.spanFrom(start) };
}

// A transaction-mode list that must name at least one mode.
function parseTransactionModeList(ctx: ParseContext<SqlTokenType>): TransactionMode[] {
  expectTransactionMode(ctx);
  return parseTransactionModes(ctx);
}

// Whether SESSION CHARACTERISTICS AS starts here (and SESSION is not a scope).
const isSessionCharacteristics = (ctx: ParseContext<SqlTokenType>): boolean =>
  ctx.is("ident", "session") && isWordAhead(ctx, 1, "characteristics") && isWordAhead(ctx, 2, "as");

type SetRest =
  | ({ kind: "config" } & ConfigSet)
  | { kind: "transaction"; characteristics: boolean; modes: TransactionMode[] };

// PG's set_rest, what follows SET [SESSION | LOCAL]: TRANSACTION mode…,
// SESSION CHARACTERISTICS AS TRANSACTION mode…, or a parseConfigSet form
// (TRANSACTION SNAPSHOT among them).
function parseSetRest(ctx: ParseContext<SqlTokenType>): SetRest {
  if (isSessionCharacteristics(ctx)) {
    ctx.parse(kwseq("session", "characteristics", "as", "transaction"));
    return { kind: "transaction", characteristics: true, modes: parseTransactionModeList(ctx) };
  }
  if (ctx.is("ident", "transaction") && !isGenericSet(ctx) && !isWordAhead(ctx, 1, "snapshot")) {
    ctx.next(); // TRANSACTION
    return { kind: "transaction", characteristics: false, modes: parseTransactionModeList(ctx) };
  }
  return { kind: "config", ...parseConfigSet(ctx) };
}

const sessionStmt = custom<Stmt, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    if (ctx.eat("ident", "show") !== null) {
      return { kind: "show", name: parseConfigTarget(ctx), span: ctx.spanFrom(start) };
    }
    if (ctx.eat("ident", "reset") !== null) {
      return { kind: "reset", name: parseConfigTarget(ctx), span: ctx.spanFrom(start) };
    }
    ctx.parse(kw("set"));
    // A form or scope word right after SET is a parameter name when isGenericSet
    // says so (`SET constraints TO x`, `SET local = 1`). SET CONSTRAINTS takes
    // no SESSION / LOCAL.
    if (ctx.is("ident", "constraints") && !isGenericSet(ctx)) return parseSetConstraints(ctx, start);
    // SESSION is the scope unless it leads SESSION AUTHORIZATION or SESSION
    // CHARACTERISTICS AS (`SET SESSION SESSION AUTHORIZATION` has both).
    let scope: "session" | "local" | null = null;
    if (ctx.is("ident", "session") && !isGenericSet(ctx) && !isWordAhead(ctx, 1, "authorization")) {
      if (!isSessionCharacteristics(ctx)) {
        ctx.next();
        scope = "session";
      }
    } else if (ctx.is("ident", "local") && !isGenericSet(ctx)) {
      ctx.next();
      scope = "local";
    }
    const rest = parseSetRest(ctx);
    if (rest.kind === "transaction") {
      const { characteristics, modes } = rest;
      return { kind: "setTransaction", scope, characteristics, modes, span: ctx.spanFrom(start) };
    }
    return { kind: "set", scope, name: rest.name, values: rest.values, span: ctx.spanFrom(start) };
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

// --- LISTEN / NOTIFY / UNLISTEN, LOAD, DISCARD ---
//
// Every lead word stays UNRESERVED, matched by value; so do DISCARD's targets.

const listenStmt = custom<Stmt, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    ctx.parse(kw("listen"));
    return { kind: "listen", channel: ctx.parse(nameWord), span: ctx.spanFrom(start) };
  },
  { expected: '"listen"', first: [{ type: "ident", value: "listen" }] },
);

const notifyStmt = custom<Stmt, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    ctx.parse(kw("notify"));
    const channel = ctx.parse(nameWord);
    if (ctx.eat("punc", ",") === null) return { kind: "notify", channel, span: ctx.spanFrom(start) };
    if (!ctx.is("string")) return ctx.croak(`Expected a payload string but found ${describeFound(ctx.peek())}`);
    return { kind: "notify", channel, payload: ctx.parse(strValue), span: ctx.spanFrom(start) };
  },
  { expected: '"notify"', first: [{ type: "ident", value: "notify" }] },
);

const unlistenStmt = custom<Stmt, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    ctx.parse(kw("unlisten"));
    const channel = ctx.eat("op", "*") !== null ? null : ctx.parse(nameWord);
    return { kind: "unlisten", channel, span: ctx.spanFrom(start) };
  },
  { expected: '"unlisten"', first: [{ type: "ident", value: "unlisten" }] },
);

const loadStmt = custom<Stmt, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    ctx.parse(kw("load"));
    if (!ctx.is("string")) return ctx.croak(`Expected a file name but found ${describeFound(ctx.peek())}`);
    return { kind: "load", file: ctx.parse(strValue), span: ctx.spanFrom(start) };
  },
  { expected: '"load"', first: [{ type: "ident", value: "load" }] },
);

const DISCARD_TARGETS: Readonly<Record<string, Discard["target"]>> = {
  all: "all",
  plans: "plans",
  sequences: "sequences",
  temp: "temp",
  temporary: "temp",
};
const discardStmt = custom<Stmt, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    ctx.parse(kw("discard"));
    const tok = ctx.peek();
    if (tok?.type !== "ident" || !Object.hasOwn(DISCARD_TARGETS, tok.value)) {
      return ctx.croak(`Expected ${keyList(DISCARD_TARGETS)} but found ${describeFound(tok)}`);
    }
    ctx.next();
    return { kind: "discard", target: DISCARD_TARGETS[tok.value]!, span: ctx.spanFrom(start) };
  },
  { expected: '"discard"', first: [{ type: "ident", value: "discard" }] },
);

// --- DML: shared clause pieces ---

// The AS_LABEL words of PG's kwlist.h that continue an expression (`a ISNULL`,
// `a NOTNULL`, `(a, b) OVERLAPS (c, d)`): an alias only after AS, as in PG,
// whose grammar cannot take them as a bare alias — `SELECT a overlaps FROM t` is
// a syntax error there, and here. PG marks more words AS_LABEL (`day`, `over`,
// `filter`, `without`, …); this grammar still takes those bare. PG also keeps
// these three out of table aliases altogether (they are not ColIds), even after
// AS; that is not checked here.
const AS_LABEL_KEYWORDS: ReadonlySet<string> = new Set(["isnull", "notnull", "overlaps"]);

// `[AS] alias`. A custom rule rather than optional(seq(...)) because the
// alias's first set is a bare `ident`, which also matches every following
// clause keyword — so it checks RESERVED directly and stops at a clause/join
// word (that is why `set`, `values`, and the join leads are reserved). A
// quoted identifier is always a name; a bare word only when unreserved, and
// not one of AS_LABEL_KEYWORDS unless AS precedes it.
const asAlias = custom<string | null, SqlTokenType>(
  (ctx) => {
    const hasAs = ctx.eat("ident", "as") !== null;
    const tok = ctx.peek();
    const isName =
      tok !== null &&
      (tok.type === "qident" ||
        (tok.type === "ident" && !RESERVED.has(tok.value) && (hasAs || !AS_LABEL_KEYWORDS.has(tok.value))));
    if (isName) return ctx.parse(nameWord);
    if (hasAs) return ctx.croak(`Expected an alias but found ${describeFound(ctx.peek())}`);
    return null;
  },
  { expected: "an alias", first: [{ type: "ident" }, { type: "qident" }] },
);

// One item of an INSERT VALUES row or an assigned value: an expression or a
// bare DEFAULT. A local rule rather than `exprList`, whose other consumers must
// not take DEFAULT. `default` is reserved, so the keyword branch never shadows
// an expression.
const insertValue = oneOf(
  kw("default").map((_, span): DefaultValue => ({ kind: "default", span })),
  expression,
);

// An assigned or inserted column: PG's `ColId opt_indirection` (see
// Indirection). A field step's name is read as a qualified name's parts are, so
// unlike PG's ColLabel a reserved word there must be quoted (`SET c."from"`).
type SetTarget = { name: string; indirection: Indirection };
const setTarget = custom<SetTarget, SqlTokenType>(
  (ctx) => {
    const name = ctx.parse(nameWord);
    const indirection: Indirection = [];
    for (;;) {
      const start = ctx.position();
      if (ctx.eat("punc", ".") !== null) {
        if (ctx.is("op", "*")) {
          return ctx.croak('Expected a field name but found "*"; a row cannot be expanded in an assignment target');
        }
        indirection.push({ kind: "field", name: ctx.parse(nameWord), span: ctx.spanFrom(start) });
      } else if (ctx.is("punc", "[")) {
        const { index, upper } = subscriptBounds(ctx);
        indirection.push(
          upper === undefined
            ? { kind: "subscript", index, span: ctx.spanFrom(start) }
            : { kind: "subscript", index, upper, span: ctx.spanFrom(start) },
        );
      } else {
        return { name, indirection };
      }
    }
  },
  { expected: nameWord.expected(), first: nameWord.first() },
);
// A column list of set targets, for INSERT and MERGE's INSERT: a local rule, as
// the shared `columnList` serves DDL too, where a name takes no steps. Unlike
// columnList's, the list may not be empty: PG's insert_column_list.
const insertColumnList = seq(skip(punc("(")), field("items", sepBy(setTarget, P(","))), skip(punc(")"))).map(
  (s) => s.items,
);
// Split a list of targets into the `columns` / `indirection` pair (see Insert).
function splitTargets(targets: SetTarget[]): { columns: string[]; indirection?: Indirection[] } {
  const columns = targets.map((t) => t.name);
  return targets.some((t) => t.indirection.length > 0)
    ? { columns, indirection: targets.map((t) => t.indirection) }
    : { columns };
}

const eq = token("op", { values: ["="] });
const singleAssignment = seq(field("target", setTarget), skip(eq), field("value", insertValue)).map(
  ({ target, value }): Assignment => ({
    column: target.name,
    ...(target.indirection.length > 0 && { indirection: target.indirection }),
    value,
  }),
);
// `(a, b, …) = source`. The row items are read locally (not via `expression`)
// so they may be a bare DEFAULT, as in an INSERT VALUES row. `row` is matched
// by value only when `(` follows, so a bare `row` source is reported rather
// than consumed (inside the items, `expression` reads it as a name). A lone
// parenthesised item is a row only if it already is one (`((1, 2))`) or is a
// subquery; PG rejects any other single-item source. A row's item count must
// match the columns (a subquery's is left to PG's analysis). DEFAULT one paren
// deeper (`((1, DEFAULT))`), which PG also takes, is not accepted here.
type MultiAssignmentSource = Extract<Assignment, { columns: string[] }>["value"];
// `subqueryExpr`, typed as the narrow source it is rather than any Expr.
const assignmentSubquery = parenQuery.map((query, span): MultiAssignmentSource => ({ kind: "subquery", query, span }));
const multiAssignment = custom<Assignment, SqlTokenType>(
  (ctx) => {
    ctx.next(); // "("
    const targets = [ctx.parse(setTarget)];
    while (ctx.eat("punc", ",") !== null) targets.push(ctx.parse(setTarget));
    expectClose(ctx);
    ctx.parse(eq);
    const named = splitTargets(targets);
    const { columns } = named;
    if (isSubqueryParen(ctx)) return { ...named, value: ctx.parse(assignmentSubquery) };
    const start = ctx.position();
    const after = ctx.peekAhead(1);
    const explicit = ctx.is("ident", "row") && after?.type === "punc" && after.value === "(";
    if (explicit) ctx.next();
    if (!ctx.is("punc", "(")) {
      return ctx.croak(`Expected a row constructor or a subquery but found ${describeFound(ctx.peek())}`);
    }
    ctx.next(); // "("
    const items: (Expr | DefaultValue)[] = [];
    if (!(explicit && ctx.is("punc", ")"))) {
      items.push(ctx.parse(insertValue));
      while (ctx.eat("punc", ",") !== null) items.push(ctx.parse(insertValue));
    }
    expectClose(ctx);
    let value: MultiAssignmentSource = {
      kind: "row",
      items,
      ...(!explicit && { implicit: true }),
      span: ctx.spanFrom(start),
    };
    if (!explicit && items.length === 1) {
      const only = items[0]!;
      if (only.kind !== "row" && only.kind !== "subquery") {
        return ctx.croak(
          "Expected a row constructor or a subquery as a multi-column assignment source",
          start,
          ctx.position(),
        );
      }
      value = only;
    }
    if (value.kind === "row" && value.items.length !== columns.length) {
      return ctx.croak(
        `Expected ${columns.length} values for ${columns.length} assigned columns but found ${value.items.length}`,
        value.span.start,
        value.span.end,
      );
    }
    return { ...named, value };
  },
  { expected: '"("', first: [{ type: "punc", value: "(" }] },
);
const assignment = oneOf(multiAssignment, singleAssignment);
const setAssignments = seq(skip(kw("set")), field("items", sepBy(assignment, P(",")))).map((s) => s.items);

const whereClause = seq(skip(kw("where")), field("e", expression)).map((s) => s.e);

// PG's where_or_current_clause, for UPDATE and DELETE: `WHERE condition` or
// `WHERE CURRENT OF cursor`. `current` and `of` are matched by value and only
// as a pair, so `WHERE current` still reads a column named current.
type WhereOrCurrent = { where: Expr } | { currentOf: string };
const whereOrCurrent = custom<WhereOrCurrent, SqlTokenType>(
  (ctx) => {
    ctx.parse(kw("where"));
    if (ctx.is("ident", "current")) {
      const after = peekOrReport(ctx, 1);
      if (after !== null && after.type === "ident" && after.value === "of") {
        ctx.next(); // "current"
        ctx.next(); // "of"
        return { currentOf: ctx.parse(nameWord) };
      }
    }
    return { where: ctx.parse(expression) };
  },
  { expected: '"where"', first: [{ type: "ident", value: "where" }] },
);
// The `where` / `currentOf` fields an optional where_or_current_clause adds.
function whereFields(clause: WhereOrCurrent | null): { where: Expr | null; currentOf?: string } {
  if (clause === null) return { where: null };
  return "currentOf" in clause ? { where: null, currentOf: clause.currentOf } : { where: clause.where };
}

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
// PG's `OPERATOR(schema.op)` spelling is taken only inside expressions and
// definition values (parseDefinitionArg); here, as after an exclusion
// constraint's WITH, it is not supported yet.
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

// `FOR { UPDATE | SHARE | NO KEY UPDATE | KEY SHARE } [OF table, …]
// [NOWAIT | SKIP LOCKED]`, repeatable, or PG's lone `FOR READ ONLY`, which its
// grammar reduces to no clause at all (an empty list here). `for` is reserved
// (so it never reads as an alias); the strength / wait words are matched by
// value.
const lockingClause = custom<LockingClause[], SqlTokenType>(
  (ctx) => {
    if (ctx.peekAhead(1)?.type === "ident" && ctx.peekAhead(1)?.value === "read") {
      ctx.parse(kwseq("for", "read", "only"));
      return [];
    }
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

// A query-level tail as written, before it is merged into the query it
// follows. Each clause keeps its span, so a merge conflict can point at it.
type QueryTail = {
  orderBy: { items: OrderItem[]; span: Span } | null;
  // `value` is null for `LIMIT ALL` and a count-less FETCH.
  limit: { value: Expr | null; withTies: boolean; span: Span } | null;
  offset: { value: Expr; span: Span } | null;
  locking: LockingClause[] | null;
};

// `LIMIT { n | ALL }` or the SQL-standard `FETCH { FIRST | NEXT } [count]
// { ROW | ROWS } { ONLY | WITH TIES }`, positioned on its lead word. The FETCH
// count is optional (`FETCH FIRST ROW ONLY` ≡ 1); when omitted, the next token
// is the ROW/ROWS word, so a count is read only before one.
// `first`/`next`/`row`/`rows`/`only`/`ties` stay unreserved.
function parseLimitClause(ctx: ParseContext<SqlTokenType>): NonNullable<QueryTail["limit"]> {
  const start = ctx.position();
  if (ctx.eat("ident", "limit") !== null) {
    const value = ctx.eat("ident", "all") !== null ? null : ctx.parse(expression);
    return { value, withTies: false, span: ctx.spanFrom(start) };
  }
  ctx.parse(kw("fetch"));
  if (ctx.eat("ident", ["first", "next"]) === null) {
    ctx.croak(`Expected "first" or "next" but found ${describeFound(ctx.peek())}`);
  }
  const value = ctx.is("ident", ["row", "rows"]) ? null : ctx.parse(expression);
  if (ctx.eat("ident", ["row", "rows"]) === null) {
    ctx.croak(`Expected "row" or "rows" but found ${describeFound(ctx.peek())}`);
  }
  let withTies = false;
  if (ctx.is("ident", "with")) {
    ctx.parse(kwseq("with", "ties"));
    withTies = true;
  } else if (ctx.eat("ident", "only") === null) {
    ctx.croak(`Expected "only" or "with ties" but found ${describeFound(ctx.peek())}`);
  }
  return { value, withTies, span: ctx.spanFrom(start) };
}

// PG's `select_no_parens` tail: `[ORDER BY …]`, then at most one LIMIT (or
// FETCH) and one OFFSET in either order, with the locking clauses before or
// after that pair but not on both sides of it. `OFFSET n [ROW | ROWS]` takes the
// standard trailing row word. A second LIMIT or OFFSET is refused here, with
// the wording insertSelectOptions uses for one repeated across parentheses (PG
// itself reports a plain syntax error within one tail); anything else out of
// place just ends the tail, and fails where the query was meant to stop. Null
// when no tail is written.
function parseQueryTail(ctx: ParseContext<SqlTokenType>): QueryTail | null {
  if (!ctx.is("ident", ["order", "limit", "offset", "fetch", "for"])) return null;
  const tail: QueryTail = { orderBy: null, limit: null, offset: null, locking: null };
  if (ctx.is("ident", "order")) {
    const start = ctx.position();
    const items = ctx.parse(orderByClause);
    tail.orderBy = { items, span: ctx.spanFrom(start) };
  }
  const lockingFirst = ctx.is("ident", "for");
  if (lockingFirst) tail.locking = ctx.parse(lockingClause);
  while (ctx.is("ident", ["limit", "fetch", "offset"])) {
    if (!ctx.is("ident", "offset")) {
      if (tail.limit !== null) ctx.croak("multiple LIMIT clauses not allowed");
      tail.limit = parseLimitClause(ctx);
    } else {
      if (tail.offset !== null) ctx.croak("multiple OFFSET clauses not allowed");
      const start = ctx.position();
      ctx.next(); // offset
      const value = ctx.parse(expression);
      ctx.eat("ident", ["row", "rows"]); // optional trailing ROW / ROWS
      tail.offset = { value, span: ctx.spanFrom(start) };
    }
  }
  if (!lockingFirst && ctx.is("ident", "for")) tail.locking = ctx.parse(lockingClause);
  if (tail.locking?.length === 0) tail.locking = null; // FOR READ ONLY
  return tail;
}

// Queries whose LIMIT was written, `LIMIT ALL` and a count-less FETCH included
// — the AST alone can't tell those from no LIMIT, but PG's duplicate check can.
const writtenLimit = new WeakSet<Query>();

// Merge a query-level tail into the query it follows, as PG's
// `insertSelectOptions` does: onto the SELECT or VALUES itself when the query is
// one, and onto the set-operation node otherwise — so in `(SELECT 1) UNION
// SELECT 2 ORDER BY 1` the ORDER BY sorts the union, not the right-hand arm. A
// parenthesised query takes the tail written after its `)` the same way, and a
// clause it already carries can't be given twice. Locking clauses accumulate.
// PG's other checks here are mirrored too: WITH TIES needs an ORDER BY and
// can't be combined with SKIP LOCKED.
// The node's span is stretched to the tail's end, keeping its start.
function insertQueryTail(ctx: ParseContext<SqlTokenType>, node: Query, tail: QueryTail): Query {
  let orderBy = node.orderBy ?? null;
  let limit = node.limit ?? null;
  let withTies = node.withTies === true;
  let offset = node.offset ?? null;
  let locking = node.locking ?? null;
  const limitWritten = writtenLimit.has(node);
  if (tail.orderBy !== null) {
    if (orderBy !== null) {
      ctx.croak("multiple ORDER BY clauses not allowed", tail.orderBy.span.start, tail.orderBy.span.end);
    }
    orderBy = tail.orderBy.items;
  }
  if (tail.locking !== null) locking = locking === null ? tail.locking : [...locking, ...tail.locking];
  if (tail.offset !== null) {
    if (offset !== null) ctx.croak("multiple OFFSET clauses not allowed", tail.offset.span.start, tail.offset.span.end);
    offset = tail.offset.value;
  }
  if (tail.limit !== null) {
    if (limitWritten) ctx.croak("multiple LIMIT clauses not allowed", tail.limit.span.start, tail.limit.span.end);
    if (tail.limit.withTies && orderBy === null) {
      ctx.croak("WITH TIES cannot be specified without ORDER BY clause", tail.limit.span.start, tail.limit.span.end);
    }
    // Checked against every locking clause merged so far, but only when this
    // tail brings the WITH TIES, as PG does.
    if (tail.limit.withTies && locking?.some((clause) => clause.wait === "skipLocked")) {
      ctx.croak(
        "SKIP LOCKED and WITH TIES options cannot be used together",
        tail.limit.span.start,
        tail.limit.span.end,
      );
    }
    limit = tail.limit.value;
    withTies = tail.limit.withTies;
  }
  const span: Span = { start: node.span.start, end: ctx.lastEnd() };
  let out: Query;
  if (node.kind === "select") {
    const { orderBy: _o, limit: _l, withTies: _w, offset: _f, locking: _k, span: _s, ...head } = node;
    out = { ...head, orderBy, limit, ...(withTies && { withTies: true }), offset, locking, span };
  } else if (node.kind === "values") {
    const { kind, rows, with_, recursive } = node;
    out = {
      kind,
      rows,
      orderBy,
      limit,
      ...(withTies && { withTies: true }),
      offset,
      ...(locking !== null && { locking }),
      span,
      ...(with_ !== undefined && { with_, recursive }),
    };
  } else if (node.kind === "tableCmd") {
    const { kind, name, only, with_, recursive } = node;
    out = {
      kind,
      name,
      ...(only && { only }),
      ...(orderBy !== null && { orderBy }),
      ...(limit !== null && { limit }),
      ...(withTies && { withTies: true }),
      ...(offset !== null && { offset }),
      ...(locking !== null && { locking }),
      span,
      ...(with_ !== undefined && { with_, recursive }),
    };
  } else {
    const { kind, op, left, right, with_, recursive } = node;
    out = {
      kind,
      op,
      left,
      right,
      ...(orderBy !== null && { orderBy }),
      ...(limit !== null && { limit }),
      ...(withTies && { withTies: true }),
      ...(offset !== null && { offset }),
      ...(locking !== null && { locking }),
      span,
      ...(with_ !== undefined && { with_, recursive }),
    };
  }
  if (limitWritten || tail.limit !== null) writtenLimit.add(out);
  if (withOwners.has(node)) withOwners.add(out);
  return out;
}

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

// One `name type [COLLATE collation]` entry of a column definition list. Not
// the composite type's `compositeAttr`, which takes no COLLATE here.
const columnDefinition = custom<ColumnDefinition, SqlTokenType>(
  (ctx) => {
    const name = ctx.parse(nameWord);
    const type = ctx.parse(typeRef);
    const collate = ctx.eat("ident", "collate") !== null ? ctx.parse(qualName) : null;
    return { name, type, ...(collate !== null && { collate }) };
  },
  { expected: "a name", first: nameWord.first() },
);
// `( name type, … )`, positioned on the `(` — at least one entry, as in PG.
function parseColumnDefinitions(ctx: ParseContext<SqlTokenType>): ColumnDefinition[] {
  ctx.next(); // "("
  const defs = [ctx.parse(columnDefinition)];
  while (ctx.eat("punc", ",") !== null) defs.push(ctx.parse(columnDefinition));
  expectClose(ctx);
  return defs;
}

// Whether the cursor sits on `AS (` — a column definition list with no alias.
// A bare `as` there could open nothing else: an alias is a name, never a `(`.
const atBareColumnDefinitions = (ctx: ParseContext<SqlTokenType>): boolean =>
  ctx.is("ident", "as") && isPuncToken(peekOrReport(ctx, 1), "(");

// PG's `func_alias_clause`, after a table function or ROWS FROM: an alias
// clause, or a column definition list — `AS (a int)`, `[AS] x (a int)`. After
// an alias, the `(` holds alias columns when its first name is followed by `,`
// or `)` (`x (a, b)`), and column definitions otherwise (`x (a int)`): a
// definition always has a type after its name. Pure token lookahead rather than
// a backtracking attempt.
function parseFuncAliasClause(ctx: ParseContext<SqlTokenType>): {
  alias: string | null;
  columns: string[] | null;
  columnDefinitions: ColumnDefinition[] | null;
} {
  if (atBareColumnDefinitions(ctx)) {
    ctx.next(); // "as"
    return { alias: null, columns: null, columnDefinitions: parseColumnDefinitions(ctx) };
  }
  const alias = ctx.parse(asAlias);
  if (alias === null || !ctx.is("punc", "(")) return { alias, columns: null, columnDefinitions: null };
  const first = peekOrReport(ctx, 1);
  const isName = first !== null && (first.type === "qident" || (first.type === "ident" && !RESERVED.has(first.value)));
  const after = isName ? peekOrReport(ctx, 2) : null;
  if (after !== null && !isPuncToken(after, ",") && !isPuncToken(after, ")")) {
    return { alias, columns: null, columnDefinitions: parseColumnDefinitions(ctx) };
  }
  ctx.next(); // "("
  const columns = ctx.parse(aliasColumns);
  expectClose(ctx);
  return { alias, columns, columnDefinitions: null };
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
  const { args, variadic } = parseCallArgList(ctx);
  return {
    kind: "call",
    name: nameParts.join("."),
    args,
    ...(variadic && { variadic: true }),
    span: ctx.spanFrom(start),
  };
}
// `( [functionArg, …] )` — a call's argument list, possibly empty and its last
// argument possibly VARIADIC, without the aggregate modifiers a SELECT-list
// call takes. Shared by FROM calls and CALL.
function parseCallArgList(ctx: ParseContext<SqlTokenType>): { args: Expr[]; variadic: boolean } {
  if (!ctx.is("punc", "(")) ctx.croak(`Expected "(" but found ${describeFound(ctx.peek())}`);
  ctx.next(); // "("
  const { args, variadic } = parseCallArgs(ctx, { aggregate: false });
  expectClose(ctx);
  return { args, variadic };
}

// `WITH ORDINALITY` after a table function. Keyed on the word pair, since a
// bare `with` after a FROM item can also open an enclosing materialized view's
// `WITH [NO] DATA` or a view's `WITH [CASCADED | LOCAL] CHECK OPTION`;
// `ordinality` itself stays unreserved.
const eatOrdinality = (ctx: ParseContext<SqlTokenType>): boolean => {
  if (!ctx.is("ident", "with")) return false;
  const after = ctx.peekAhead(1);
  if (after === null || after.type !== "ident" || after.value !== "ordinality") return false;
  ctx.next(); // "with"
  ctx.next(); // "ordinality"
  return true;
};

// `ROWS FROM (f(…) [AS (col type, …)], …) [WITH ORDINALITY] [func alias clause]`,
// positioned on `rows`.
function parseRowsFrom(ctx: ParseContext<SqlTokenType>, lateral: boolean): FromItem {
  ctx.next(); // "rows"
  ctx.next(); // "from"
  ctx.next(); // "("
  const calls: Expr[] = [];
  const callColumnDefinitions: (ColumnDefinition[] | null)[] = [];
  do {
    calls.push(parseFromCall(ctx));
    // PG's `opt_col_def_list`: only the `AS (…)` spelling, with no alias.
    if (ctx.is("ident", "as")) {
      ctx.next(); // "as"
      if (!ctx.is("punc", "(")) ctx.croak(`Expected "(" but found ${describeFound(ctx.peek())}`);
      callColumnDefinitions.push(parseColumnDefinitions(ctx));
    } else {
      callColumnDefinitions.push(null);
    }
  } while (ctx.eat("punc", ",") !== null);
  expectClose(ctx);
  const ordinality = eatOrdinality(ctx);
  const { alias, columns, columnDefinitions } = parseFuncAliasClause(ctx);
  return {
    kind: "rowsFrom",
    calls,
    ...(callColumnDefinitions.some((defs) => defs !== null) && { callColumnDefinitions }),
    alias,
    ...(columns !== null && { columns }),
    ...(columnDefinitions !== null && { columnDefinitions }),
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

// The reserved words a query can open with.
const QUERY_WORDS: ReadonlySet<string> = new Set(["select", "with", "values", "table"]);
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
// reads as a query, keeping the query reading's error. With `continued`, a
// query also needs some inner group followed by a set-op word or a trailing
// query clause rather than by `)` alone, and an unclosed level ends the scan
// with that verdict (see startsQuery).
function parenRunIsQuery(ctx: ParseContext<SqlTokenType>, depth: number, continued = false): boolean {
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
  if (closeAt[0] === undefined && !continued) return true;
  let sawTail = false;
  for (let level = depth - 1; level >= 1; level--) {
    const close = closeAt[level];
    if (close === undefined) return !continued || sawTail;
    const after = ctx.peekAhead(close + 1);
    if (after?.type === "ident" && QUERY_TAIL_WORDS.has(after.value)) sawTail = true;
    else if (after !== null && !isPuncToken(after, ")")) return false;
  }
  return !continued || sawTail;
}

// A `(` in FROM opens either a subquery or a parenthesised join, and a run of
// them can stack either way: `((SELECT 1) UNION (SELECT 2)) x` is a subquery,
// `((SELECT 1) s JOIN t ON …)` a join. So the dispatch scans past the run: with
// no query word (select/with/values/table, all reserved) after it, only a join can
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
// A plain table name may carry PG's inheritance star (`t *`), which ONLY may
// not. The `only`/`columns`/`columnDefinitions`/`lateral`/`tablesample`/
// `ordinality` keys are omitted when absent so ordinary items keep their prior
// shape.
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
      const { alias, columns, columnDefinitions } = parseFuncAliasClause(ctx);
      return {
        kind: "function",
        call,
        alias,
        ...(columns !== null && { columns }),
        ...(columnDefinitions !== null && { columnDefinitions }),
        ...(lateral && { lateral: true }),
        ...(ordinality && { ordinality: true }),
      };
    }
    if (lateral) {
      return ctx.croak(`Expected a subquery or function after "lateral" but found ${describeFound(ctx.peek())}`);
    }
    // `t *` — PG's explicit spelling of "t and its inheritance children", which
    // is what a bare `t` already means, so it records nothing.
    ctx.eat("op", "*");
    return tableTail(ctx, nameParts, false);
  },
  {
    expected: "a table reference",
    first: [{ type: "punc", value: "(" }, { type: "ident" }, { type: "qident" }],
  },
);

// Reads an optional join lead — `[NATURAL] [INNER | LEFT|RIGHT|FULL [OUTER]] JOIN`
// or `CROSS JOIN` — consuming the keywords and returning the type, or null (consuming
// nothing) when no JOIN follows. All lead-words are reserved, so this never
// collides with a preceding table's alias.
const readJoin = (ctx: ParseContext<SqlTokenType>): { joinType: FromItemJoinType; natural: boolean } | null => {
  const lead = ctx.peek();
  const leads = ["join", "inner", "left", "right", "full", "cross", "natural"];
  if (lead === null || lead.type !== "ident" || !leads.includes(lead.value)) return null;
  const natural = ctx.eat("ident", "natural") !== null;
  // PG's `join_type` excludes CROSS, so `NATURAL CROSS JOIN` is not a join.
  if (natural && ctx.is("ident", "cross")) {
    ctx.croak(`Expected "join", "inner", "left", "right" or "full" but found ${describeFound(ctx.peek())}`);
  }
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

// The joins that follow `left`, folded left-associatively. A CROSS or NATURAL
// join is complete once its right item is read; every other join must close
// with `ON expr` or `USING (cols) [AS name]` — PG's mandatory `join_qual`. So
// a join lead met before that qualifier opens a join nested on the right, which
// takes the first qualifier that follows: `a JOIN b JOIN c ON p ON q` is
// `a JOIN (b JOIN c ON p) ON q`, as in PG, while `a CROSS JOIN b JOIN c ON p`
// stays `(a CROSS JOIN b) JOIN c ON p`.
function parseJoins(ctx: ParseContext<SqlTokenType>, left: FromItem): FromItem {
  while (true) {
    const join = readJoin(ctx);
    if (join === null) return left;
    let right = ctx.parse(tableRef);
    let on: Expr | null = null;
    let using: string[] | null = null;
    let usingAlias: string | null = null;
    if (!join.natural && join.joinType !== "cross") {
      right = parseJoins(ctx, right);
      if (ctx.eat("ident", "on") !== null) {
        on = ctx.parse(expression);
      } else if (ctx.eat("ident", "using") !== null) {
        using = ctx.parse(columnList);
        // PG's `join_using_alias`: the AS is required.
        if (ctx.is("ident", "as")) usingAlias = ctx.parse(asAlias);
      } else {
        ctx.croak(`Expected "on" or "using" but found ${describeFound(ctx.peek())}`);
      }
    }
    left = {
      kind: "join",
      joinType: join.joinType,
      ...(join.natural && { natural: true }),
      left,
      right,
      on,
      using,
      ...(usingAlias !== null && { usingAlias }),
    };
  }
}

// One FROM entry and its chain of joins (see parseJoins).
const joinTail = custom<FromItem, SqlTokenType>((ctx) => parseJoins(ctx, ctx.parse(tableRef)), {
  expected: "a table reference",
  first: [{ type: "punc", value: "(" }, { type: "ident" }, { type: "qident" }],
});
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

// PG's `opt_target_list`: after SELECT [ALL] the list may be empty —
// `SELECT;`, `SELECT FROM t`, `SELECT 1 UNION SELECT` — while DISTINCT takes a
// non-empty `target_list`. The list is empty when the token after the
// quantifier ends the query or opens a clause that follows the list; all of
// those words are reserved, so none of them starts a select item.
const TARGET_LIST_FOLLOW_WORDS: ReadonlySet<string> = new Set([
  "into",
  "from",
  "where",
  "group",
  "having",
  "window",
  ...QUERY_TAIL_WORDS,
  // What may follow a whole query: INSERT's ON CONFLICT and RETURNING, and the
  // WITH [NO] DATA / WITH CHECK OPTION after CREATE … AS.
  "on",
  "returning",
  "with",
]);
const selectItems = sepBy(selectItem, P(","));
const selectHead = custom<{ distinct: boolean | Expr[]; columns: SelectItem[] }, SqlTokenType>(
  (ctx) => {
    const distinct = ctx.parse(distinctClause);
    const next = ctx.peek();
    const empty =
      distinct === false &&
      (next === null ||
        isPuncToken(next, ";") ||
        isPuncToken(next, ")") ||
        (next.type === "ident" && TARGET_LIST_FOLLOW_WORDS.has(next.value)));
    return { distinct, columns: empty ? [] : ctx.parse(selectItems) };
  },
  { expected: selectItems.expected(), first: [...distinctClause.first(), ...selectItems.first()] },
);

// PG's `simple_select` SELECT: everything up to the WINDOW clause. The ORDER BY
// / LIMIT / OFFSET / FETCH / locking tail is a query-level clause — read once
// after the set operations (see setOpQuery) — so that a set-op arm never takes
// it. The tail fields start out empty and are filled in by insertQueryTail.
const selectCore = seq(
  skip(kw("select")),
  field("head", selectHead),
  field("into", optional(intoClause)),
  field("from", optional(seq(skip(kw("from")), field("f", fromClause)).map((s) => s.f))),
  field("where", optional(whereClause)),
  field("groupBy", optional(groupByClause)),
  field("having", optional(havingClause)),
  field("window", optional(windowClause)),
).map(
  ({ head: { distinct, columns }, into, from, where, groupBy, having, window: windowDefs }, span): SelectStmt => ({
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
    orderBy: null,
    limit: null,
    offset: null,
    locking: null,
    span,
  }),
);

// A CTE body is a full query or a data-modifying statement. Dispatch on the
// leading keyword (INSERT/UPDATE/DELETE/MERGE take their dedicated rules);
// anything else — SELECT / VALUES / TABLE / `(` / a nested WITH — is an
// ordinary query.
const cteBody = custom<Preparable, SqlTokenType>(
  (ctx) => {
    if (ctx.is("ident", "insert")) return ctx.parse(insertStmt);
    if (ctx.is("ident", "update")) return ctx.parse(updateStmt);
    if (ctx.is("ident", "delete")) return ctx.parse(deleteStmt);
    if (ctx.is("ident", "merge")) return ctx.parse(mergeStmt);
    return ctx.parse(query);
  },
  {
    expected: "a query, INSERT, UPDATE, DELETE or MERGE",
    first: [
      { type: "ident", value: "insert" },
      { type: "ident", value: "update" },
      { type: "ident", value: "delete" },
      { type: "ident", value: "merge" },
      { type: "ident", value: "with" },
      { type: "ident", value: "select" },
      { type: "ident", value: "values" },
      { type: "ident", value: "table" },
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
).map(({ recursive, ctes }, span) => ({ recursive, ctes, span }));

// Attach a parsed WITH prefix to the statement it leads: for a set-op query the
// CTEs bind to the leftmost arm — a SELECT, VALUES or TABLE query; an
// INSERT/UPDATE/DELETE/MERGE takes them directly. A parenthesised query that
// was written with a WITH of its own can't take a second one, as in PG's
// insertSelectOptions — whatever node its WITH landed on, so the queries a WITH
// was written over are tracked in `withOwners`. Under a set operation PG's WITH
// belongs to the set-op node, so an arm's own WITH is no conflict there: when
// the leftmost path already holds one, the outer WITH goes on the set-op node
// itself rather than replacing it.
const withOwners = new WeakSet<Preparable>();
const hasWith = (node: Preparable): boolean => node.with_ !== null && node.with_ !== undefined;
const attachWith = (
  ctx: ParseContext<SqlTokenType>,
  node: Preparable,
  w: { recursive: boolean; ctes: Cte[]; span: Span },
): void => {
  if (withOwners.has(node)) ctx.croak("multiple WITH clauses not allowed", w.span.start, w.span.end);
  withOwners.add(node);
  let target: Preparable = node;
  let taken = false;
  while (target.kind === "setOp") {
    taken ||= hasWith(target);
    target = target.left;
  }
  if (taken || hasWith(target)) target = node;
  target.with_ = w.ctes;
  target.recursive = w.recursive;
};

// `VALUES (…), (…)` as a query — a peer of the SELECT core. Reuses the same row
// list as INSERT … VALUES, so it slots straight into a set-op term or a FROM
// subquery; like the SELECT core it takes no tail of its own.
const valuesQuery = seq(skip(kw("values")), field("rows", sepBy(exprList, P(",")))).map(
  ({ rows }, span): ValuesQuery => ({
    kind: "values",
    rows,
    orderBy: null,
    limit: null,
    offset: null,
    span,
  }),
);

// `TABLE [ONLY] name [*]` / `TABLE ONLY (name)` — PG's `TABLE relation_expr`.
// `table` is reserved, and no statement or clause that reaches a query reads
// it there for anything else, so it opens this form wherever a query starts.
const tableQuery = custom<TableQuery, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    ctx.parse(kw("table"));
    const only = ctx.eat("ident", "only") !== null;
    const parenthesised = only && ctx.eat("punc", "(") !== null;
    const name = ctx.parse(qualName);
    if (parenthesised) expectClose(ctx);
    else if (!only) ctx.eat("op", "*"); // the inheritance star spells the default
    return { kind: "tableCmd", name, ...(only && { only: true }), span: ctx.spanFrom(start) };
  },
  { expected: '"table"', first: [{ type: "ident", value: "table" }] },
);

// A set-op term: a plain SELECT core, a VALUES or TABLE query, or a
// parenthesised query (which, being a full query, may carry a tail of its own
// inside the parens).
const selectTerm: Rule<Query, SqlTokenType> = oneOf(
  selectCore,
  valuesQuery,
  tableQuery,
  seq(skip(punc("(")), field("q", query), skip(punc(")"))).map((s) => s.q),
);

// The set-operation word at the cursor, when it is one of `words`, consumed
// together with its optional ALL / DISTINCT quantifier. DISTINCT is the default
// spelling and records nothing.
const SET_OP_KINDS: Record<string, [SetOpKind, SetOpKind]> = {
  union: ["union", "unionAll"],
  intersect: ["intersect", "intersectAll"],
  except: ["except", "exceptAll"],
};
function eatSetOp(ctx: ParseContext<SqlTokenType>, words: readonly string[]): SetOpKind | null {
  const t = ctx.peek();
  if (t === null || t.type !== "ident" || !words.includes(t.value)) return null;
  ctx.next();
  const [plain, all] = SET_OP_KINDS[t.value]!;
  if (ctx.eat("ident", "all") !== null) return all;
  ctx.eat("ident", "distinct");
  return plain;
}

// One left-associative level of set operations over `operand`. Each node spans
// from its left operand's start to the end of its right one.
function parseSetOpLevel(
  ctx: ParseContext<SqlTokenType>,
  words: readonly string[],
  operand: (ctx: ParseContext<SqlTokenType>) => Query,
): Query {
  let left = operand(ctx);
  for (let op = eatSetOp(ctx, words); op !== null; op = eatSetOp(ctx, words)) {
    const right = operand(ctx);
    left = { kind: "setOp", op, left, right, span: { start: left.span.start, end: ctx.lastEnd() } };
  }
  return left;
}
const INTERSECT_WORDS = ["intersect"] as const;
const UNION_EXCEPT_WORDS = ["union", "except"] as const;
const intersectLevel = (ctx: ParseContext<SqlTokenType>): Query =>
  parseSetOpLevel(ctx, INTERSECT_WORDS, (c) => c.parse(selectTerm));

// A query without its WITH prefix: the set operations over select-terms —
// INTERSECT binding tighter than UNION / EXCEPT, per PG's precedences — then
// the query-level tail, merged into the result. Keeping it here — rather than
// as a separate statement — leaves the `(`-dispatch in exactly one place.
const setOpQuery = custom<Query, SqlTokenType>(
  (ctx) => {
    const body = parseSetOpLevel(ctx, UNION_EXCEPT_WORDS, intersectLevel);
    const tail = parseQueryTail(ctx);
    return tail === null ? body : insertQueryTail(ctx, body, tail);
  },
  {
    expected: "a query",
    first: [
      { type: "ident", value: "select" },
      { type: "ident", value: "values" },
      { type: "ident", value: "table" },
      { type: "punc", value: "(" },
    ],
  },
);

// A leading WITH attaches to the leftmost arm of the set-op tree (see
// attachWith).
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
      { type: "ident", value: "table" },
      { type: "punc", value: "(" },
    ],
  },
);

// --- INSERT / UPDATE / DELETE ---

// One `( … )` row of INSERT's or MERGE's VALUES, holding one item or more.
const insertValuesRow = nonEmptyList(insertValue);
const valuesSource = seq(skip(kw("values")), field("rows", sepBy(insertValuesRow, P(",")))).map(({ rows }) => ({
  kind: "values" as const,
  rows,
}));
// A dedicated dispatch (not oneOf) because `query` now claims `values` in its
// first set too — a bare `VALUES …` is the INSERT-local rows source (no ORDER
// BY / LIMIT tail), everything else (`SELECT …`, `TABLE …`, `(…)`, `WITH …`)
// is a query.
const insertSource = custom<Insert["source"], SqlTokenType>(
  (ctx) => (ctx.is("ident", "values") ? ctx.parse(valuesSource) : { kind: "select", query: ctx.parse(query) }),
  {
    expected: '"values" or a query',
    first: [
      { type: "ident", value: "values" },
      { type: "ident", value: "select" },
      { type: "ident", value: "table" },
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
const insertColumns = optional(attempt(insertColumnList));
const insertOverriding = optional(overridingClause);
type InsertRest = Pick<Insert, "columns" | "indirection" | "overriding" | "source">;
// The forms still open where a source should start, as an `Expected …` prefix.
const insertRestOpen = (hasColumns: boolean, overriding: InsertOverriding | null): string =>
  overriding !== null ? "" : !hasColumns ? '"default values" or "overriding" or ' : '"overriding" or ';
const insertRest = custom<InsertRest, SqlTokenType>(
  (ctx) => {
    if (ctx.is("ident", "default")) return { columns: null, source: ctx.parse(defaultValues) };
    // `()` is neither an (empty) column list nor a query; reported as the list's.
    const next = ctx.peekAhead(1);
    if (ctx.is("punc", "(") && next?.type === "punc" && next.value === ")") {
      ctx.next(); // "("
      return ctx.croak(`Expected a name but found ")"`);
    }
    // A `(` here is a column list unless it opens a parenthesised query source;
    // attempt() rolls the column-list read back when the `(` is really a SELECT.
    const targets = ctx.parse(insertColumns) ?? null;
    const overriding = ctx.parse(insertOverriding) ?? null;
    if (!matchesFirst(ctx.peek(), insertSourceFirst)) {
      const open = insertRestOpen(targets !== null, overriding);
      return ctx.croak(`Expected ${open}"values" or a query but found ${describeFound(ctx.peek())}`);
    }
    const source = ctx.parse(insertSource);
    const named = targets === null ? { columns: null } : splitTargets(targets);
    return { ...named, ...(overriding && { overriding }), source };
  },
  {
    expected: '"default values" or "overriding" or "values" or a query',
    first: [{ type: "ident", value: "default" }, { type: "ident", value: "overriding" }, ...insertSourceFirst],
  },
);

// `ON CONSTRAINT name` names the arbiter constraint in place of a column list.
const conflictConstraint = seq(skip(kwseq("on", "constraint")), field("name", nameWord)).map((s) => s.name);

// `(element, …) [WHERE predicate]` (see ConflictInference). A list of bare
// column names with no WHERE keeps the plain `target` shape.
type ConflictTarget = Pick<OnConflict, "target" | "inference">;
// The list may not be empty: PG's index_params.
const conflictElement = custom<PartitionKey, SqlTokenType>((ctx) => partitionKey(ctx, "an ON CONFLICT index"), {
  expected: expression.expected(),
  first: expression.first(),
});
const conflictElements = seq(skip(punc("(")), field("items", sepBy(conflictElement, P(","))), skip(punc(")"))).map(
  (s) => s.items,
);
const conflictInference = seq(field("elements", conflictElements), field("where", optional(whereClause))).map(
  ({ elements, where }): ConflictTarget => {
    const columns: string[] = [];
    for (const e of elements) {
      if (e.expr.kind !== "name" || e.expr.parts.length !== 1 || e.collate || e.opclass) break;
      columns.push(e.expr.parts[0]!);
    }
    if (columns.length === elements.length && where === null) return { target: columns };
    return { target: null, inference: { elements, ...(where !== null && { where }) } };
  },
);

const onConflict = seq(
  skip(kwseq("on", "conflict")),
  field(
    "target",
    optional(
      oneOf(
        conflictInference,
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
    target: target && "target" in target ? target.target : null,
    ...(target && "name" in target && { constraint: target.name }),
    ...(target && "inference" in target && { inference: target.inference }),
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
    ...(rest.indirection && { indirection: rest.indirection }),
    ...(rest.overriding && { overriding: rest.overriding }),
    source: rest.source,
    onConflict: oc ?? null,
    returning: returning ?? null,
    span,
  }),
);

const updateStmt = seq(
  skip(kw("update")),
  field("target", relationExpr),
  field("alias", asAlias),
  field("set", setAssignments),
  field("from", optional(seq(skip(kw("from")), field("f", fromClause)).map((s) => s.f))),
  field("where", optional(whereOrCurrent)),
  field("returning", optional(returningClause)),
).map(
  ({ target, alias, set, from, where, returning }, span): Update => ({
    kind: "update",
    table: target.name,
    ...(target.only && { only: true as const }),
    alias,
    set,
    from: from ?? null,
    ...whereFields(where),
    returning: returning ?? null,
    span,
  }),
);

const deleteStmt = seq(
  skip(kw("delete")),
  skip(kw("from")),
  field("target", relationExpr),
  field("alias", asAlias),
  field("using", optional(seq(skip(kw("using")), field("f", fromClause)).map((s) => s.f))),
  field("where", optional(whereOrCurrent)),
  field("returning", optional(returningClause)),
).map(
  ({ target, alias, using, where, returning }, span): Delete => ({
    kind: "delete",
    table: target.name,
    ...(target.only && { only: true as const }),
    alias,
    using: using ?? null,
    ...whereFields(where),
    returning: returning ?? null,
    span,
  }),
);

// --- MERGE ---
//
// `merge`, `matched`, `by`, `source`, `target` and `nothing` stay UNRESERVED,
// matched by value: each is read only where a keyword is the sole option (the
// lead word, past WHEN or NOT, past BY, past DO). The pieces are INSERT's and
// UPDATE's own: setAssignments, INSERT's DEFAULT VALUES, OVERRIDING and VALUES
// row rules, and the FROM machinery for the source.

const mergeUpdate = seq(skip(kw("update")), field("set", setAssignments)).map(
  ({ set }): MergeAction => ({ kind: "update", set }),
);
const mergeColumns = optional(insertColumnList);

// PG's merge_insert: `INSERT [(cols)] [OVERRIDING … VALUE] VALUES (row)` or
// `INSERT DEFAULT VALUES`. Unlike INSERT's, the source is one row, never a
// query, so a `(` here is always the column list.
const mergeInsert = custom<MergeAction, SqlTokenType>(
  (ctx) => {
    ctx.parse(kw("insert"));
    if (ctx.is("ident", "default")) return { kind: "insert", columns: null, source: ctx.parse(defaultValues) };
    const targets = ctx.parse(mergeColumns) ?? null;
    const overriding = ctx.parse(insertOverriding) ?? null;
    if (ctx.eat("ident", "values") === null) {
      const open = insertRestOpen(targets !== null, overriding);
      return ctx.croak(`Expected ${open}"values" but found ${describeFound(ctx.peek())}`);
    }
    const row = ctx.parse(insertValuesRow);
    const named = targets === null ? { columns: null } : splitTargets(targets);
    return { kind: "insert", ...named, ...(overriding && { overriding }), source: { kind: "values", rows: [row] } };
  },
  { expected: '"insert"', first: [{ type: "ident", value: "insert" }] },
);

// The action after THEN, by the WHEN form: a NOT MATCHED row has no target row
// to UPDATE or DELETE, and only it can INSERT one.
function mergeAction(ctx: ParseContext<SqlTokenType>, match: MergeWhen["match"]): MergeAction {
  if (ctx.is("ident", "do")) {
    ctx.parse(kwseq("do", "nothing"));
    return { kind: "nothing" };
  }
  if (match === "notMatched") {
    if (ctx.is("ident", "insert")) return ctx.parse(mergeInsert);
    return ctx.croak(`Expected "insert" or "do nothing" but found ${describeFound(ctx.peek())}`);
  }
  if (ctx.is("ident", "update")) return ctx.parse(mergeUpdate);
  if (ctx.eat("ident", "delete") !== null) return { kind: "delete" };
  return ctx.croak(`Expected "update" or "delete" or "do nothing" but found ${describeFound(ctx.peek())}`);
}

const mergeWhen = custom<MergeWhen, SqlTokenType>(
  (ctx) => {
    ctx.parse(kw("when"));
    let match: MergeWhen["match"] = "matched";
    if (ctx.eat("ident", "not") !== null) {
      ctx.parse(kw("matched"));
      match = "notMatched";
      if (ctx.eat("ident", "by") !== null) {
        if (ctx.eat("ident", "source") !== null) match = "notMatchedBySource";
        else if (ctx.eat("ident", "target") === null) {
          return ctx.croak(`Expected "source" or "target" but found ${describeFound(ctx.peek())}`);
        }
      }
    } else if (ctx.eat("ident", "matched") === null) {
      return ctx.croak(`Expected "matched" or "not" but found ${describeFound(ctx.peek())}`);
    }
    const condition = ctx.eat("ident", "and") !== null ? ctx.parse(expression) : null;
    ctx.parse(kw("then"));
    return { match, condition, action: mergeAction(ctx, match) };
  },
  { expected: '"when"', first: [{ type: "ident", value: "when" }] },
);
const mergeWhens = many(mergeWhen);
const mergeReturning = optional(returningClause);

// `MERGE INTO target [[AS] alias] USING source ON condition when_clause …`.
// `using` and `on` are reserved, so neither alias reader takes them; the source
// is a FROM item with its joins (joinTail), whose own ON belongs to a join.
const mergeStmt = custom<Merge, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    ctx.parse(kwseq("merge", "into"));
    const target = ctx.parse(relationExpr);
    const alias = ctx.parse(asAlias);
    ctx.parse(kw("using"));
    const source = ctx.parse(joinTail);
    ctx.parse(kw("on"));
    const on = ctx.parse(expression);
    if (!ctx.is("ident", "when")) return ctx.croak(`Expected "when" but found ${describeFound(ctx.peek())}`);
    const when = ctx.parse(mergeWhens);
    const returning = ctx.parse(mergeReturning) ?? null;
    return {
      kind: "merge",
      table: target.name,
      ...(target.only && { only: true as const }),
      alias,
      source,
      on,
      when,
      returning,
      span: ctx.spanFrom(start),
    };
  },
  { expected: '"merge"', first: [{ type: "ident", value: "merge" }] },
);

// A DML statement, optionally led by a WITH prefix: `[WITH …]
// SELECT|VALUES|TABLE|(…)|INSERT|UPDATE|DELETE|MERGE`. The CTE list can precede
// any of these, so it must be consumed before dispatch, then attached to the
// head statement.
// The no-WITH query path goes straight to setOpQuery (queryRule's own WITH
// handling would be redundant here).
const dmlStatement = custom<Stmt, SqlTokenType>(
  (ctx) => {
    const w = ctx.is("ident", "with") ? ctx.parse(withPrefix) : null;
    let node: Preparable;
    if (ctx.is("ident", "insert")) node = ctx.parse(insertStmt);
    else if (ctx.is("ident", "update")) node = ctx.parse(updateStmt);
    else if (ctx.is("ident", "delete")) node = ctx.parse(deleteStmt);
    else if (ctx.is("ident", "merge")) node = ctx.parse(mergeStmt);
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
      { type: "ident", value: "merge" },
      { type: "ident", value: "select" },
      { type: "ident", value: "values" },
      { type: "ident", value: "table" },
      { type: "punc", value: "(" },
    ],
  },
);

// --- PREPARE / EXECUTE ---
//
// Both lead words stay UNRESERVED, matched by value like the Phase 9 utility
// words. In PG a written list here must hold at least one item: PREPARE's
// holds types, and EXECUTE's is optional, so each reads its own list.
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

// PG's PreparableStmt: a query or INSERT/UPDATE/DELETE/MERGE, each with an
// optional WITH prefix — exactly dmlStatement's first set (the message counts
// `TABLE name` among the SELECTs, as PG's grammar does). Checked up front so a
// DDL or utility body reports what PREPARE accepts rather than dmlStatement's
// generic "a statement" (which CREATE TABLE is).
const PREPARABLE = "a SELECT, VALUES, INSERT, UPDATE, DELETE or MERGE statement";
const PREPARABLE_FIRST = dmlStatement.first();
// `PREPARE TRANSACTION 'gid'` (two-phase commit) shares the lead word, and
// `transaction` is unreserved, so a statement may be named it: the string after
// the word tells the two apart, as in PG.
const prepareStmt = custom<Stmt, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    ctx.parse(kw("prepare"));
    if (ctx.is("ident", "transaction") && peekOrReport(ctx, 1)?.type === "string") {
      ctx.next(); // TRANSACTION
      return { kind: "prepareTransaction", gid: sconstString(ctx), span: ctx.spanFrom(start) };
    }
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

// --- EXPLAIN / ANALYZE / VACUUM ---
//
// The lead words are matched by value. `analyze` (and `analyse`) is reserved
// already, as in PG; `explain` and `vacuum` stay names everywhere but a
// statement's head. The parenthesised options are relationOptions as it stands:
// PG's utility option list is `name [value]`, a shape that rule takes (along
// with the `=`, the `namespace.` prefix and the `*` and list values this list
// does not need, the trade that rule's comment describes).

// The unparenthesised flags, in PG's fixed order: each a set of spellings, read
// at most once, as a bare option. `verbose` and `freeze` are names elsewhere,
// but here they are flags, as in PG, where neither can name a table: see
// maintenanceTail for a flag written out of order.
function legacyFlags(ctx: ParseContext<SqlTokenType>, flags: readonly (readonly string[])[]): RelationOption[] {
  const options: RelationOption[] = [];
  for (const spellings of flags) {
    const tok = ctx.peek();
    if (tok === null || tok.type !== "ident" || !spellings.includes(tok.value)) continue;
    const start = ctx.position();
    ctx.next();
    options.push({ name: tok.value, value: null, span: ctx.spanFrom(start) });
  }
  return options;
}

const ANALYZE_WORDS = ["analyze", "analyse"] as const;
// The column list may not be empty, unlike columnList's: PG's `opt_name_list`.
const targetColumns = sepBy(nameWord, P(","));
const maintenanceTarget = custom<MaintenanceTarget, SqlTokenType>(
  (ctx) => ({ name: ctx.parse(qualName), columns: optParenList(ctx, targetColumns) }),
  { expected: qualName.expected(), first: qualName.first() },
);
const maintenanceTargets = sepBy(maintenanceTarget, P(","));

// Whether the statement ends at the cursor.
function atStatementEnd(ctx: ParseContext<SqlTokenType>): boolean {
  return ctx.is("punc", ";") || ctx.peek() === null;
}

// `[(option, …) | flags] [target, …]` — the tail ANALYZE and VACUUM share. PG
// takes either option form but not both; the target list ends the statement.
// A bare flag word left over after the flags (one out of order, or repeated)
// croaks rather than naming the first target, as PG's syntax error does; a
// quoted one, or one past the first target, is a name.
function maintenanceTail(ctx: ParseContext<SqlTokenType>, flags: readonly (readonly string[])[]) {
  const parenthesised = ctx.is("punc", "(");
  const options = parenthesised ? ctx.parse(relationOptions) : legacyFlags(ctx, flags);
  const tok = ctx.peek();
  if (!parenthesised && tok?.type === "ident" && flags.some((spellings) => spellings.includes(tok.value))) {
    return ctx.croak(`Expected a name but found ${describeFound(tok)}`);
  }
  const tables = atStatementEnd(ctx) ? [] : ctx.parse(maintenanceTargets);
  return { options, tables };
}

const analyzeStmt = custom<Stmt, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    ctx.next(); // ANALYZE or ANALYSE
    return { kind: "analyze", ...maintenanceTail(ctx, [["verbose"]]), span: ctx.spanFrom(start) };
  },
  { expected: '"analyze"', first: ANALYZE_WORDS.map((value) => ({ type: "ident" as const, value })) },
);

const vacuumStmt = custom<Stmt, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    ctx.parse(kw("vacuum"));
    const tail = maintenanceTail(ctx, [["full"], ["freeze"], ["verbose"], ANALYZE_WORDS]);
    return { kind: "vacuum", ...tail, span: ctx.spanFrom(start) };
  },
  { expected: '"vacuum"', first: [{ type: "ident", value: "vacuum" }] },
);

// --- CHECKPOINT, CLUSTER and REINDEX ---
//
// The lead words, REINDEX's target words and CONCURRENTLY stay UNRESERVED,
// matched by value (`table` is reserved already). VERBOSE and CONCURRENTLY
// never name the relation, index or schema here: PG reserves both from a
// name's position (type_func_name keywords), so `CLUSTER verbose` and
// `REINDEX INDEX concurrently` name none there either.
const FLAG_WORDS: readonly string[] = ["verbose", "concurrently"];
// `rule`'s name, croaking on a bare flag word where it would start.
function flagFreeName<T>(ctx: ParseContext<SqlTokenType>, rule: Rule<T, SqlTokenType>): T {
  const tok = ctx.peek();
  if (tok?.type === "ident" && FLAG_WORDS.includes(tok.value)) {
    return ctx.croak(`Expected a name but found ${describeFound(tok)}`);
  }
  return ctx.parse(rule);
}

const checkpointStmt = custom<Stmt, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    ctx.parse(kw("checkpoint"));
    return { kind: "checkpoint", span: ctx.spanFrom(start) };
  },
  { expected: '"checkpoint"', first: [{ type: "ident", value: "checkpoint" }] },
);

const clusterStmt = custom<Stmt, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    ctx.parse(kw("cluster"));
    const parenthesised = ctx.is("punc", "(");
    const options = parenthesised ? ctx.parse(relationOptions) : legacyFlags(ctx, [["verbose"]]);
    if (atStatementEnd(ctx)) return { kind: "cluster", options, span: ctx.spanFrom(start) };
    const name = flagFreeName(ctx, qualName);
    // The pre-8.3 `index ON table`, which only the unparenthesised form takes.
    if (!parenthesised && name.length === 1 && ctx.eat("ident", "on") !== null) {
      const table = flagFreeName(ctx, qualName);
      return { kind: "cluster", options, table, index: name[0]!, span: ctx.spanFrom(start) };
    }
    if (ctx.eat("ident", "using") === null) return { kind: "cluster", options, table: name, span: ctx.spanFrom(start) };
    return { kind: "cluster", options, table: name, index: flagFreeName(ctx, nameWord), span: ctx.spanFrom(start) };
  },
  { expected: '"cluster"', first: [{ type: "ident", value: "cluster" }] },
);

const REINDEX_TARGETS = ["index", "table", "schema", "database", "system"] as const;
const reindexStmt = custom<Stmt, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    ctx.parse(kw("reindex"));
    const options = ctx.is("punc", "(") ? ctx.parse(relationOptions) : [];
    const tok = ctx.peek();
    const target = REINDEX_TARGETS.find((t) => tok?.type === "ident" && tok.value === t);
    if (target === undefined) {
      return ctx.croak(`Expected ${quoteList(REINDEX_TARGETS)} but found ${describeFound(tok)}`);
    }
    ctx.next();
    const concurrently = ctx.eat("ident", "concurrently") !== null;
    // INDEX and TABLE name a relation; SCHEMA names a schema; DATABASE and
    // SYSTEM may name the current database, or leave it off.
    let name: string[] | undefined;
    if (target === "index" || target === "table") name = flagFreeName(ctx, qualName);
    else if (target === "schema" || !atStatementEnd(ctx)) name = [flagFreeName(ctx, nameWord)];
    return {
      kind: "reindex",
      options,
      target,
      ...(concurrently ? { concurrently: true as const } : {}),
      ...(name === undefined ? {} : { name }),
      span: ctx.spanFrom(start),
    };
  },
  { expected: '"reindex"', first: [{ type: "ident", value: "reindex" }] },
);

// PG's ExplainableStmt, as far as sql-lite parses it: a preparable statement
// (the same set as PREPARE's), CREATE TABLE AS, CREATE MATERIALIZED VIEW,
// DECLARE (a cursor), or EXECUTE.
const EXPLAINABLE =
  "a SELECT, VALUES, INSERT, UPDATE, DELETE, MERGE, CREATE TABLE AS, CREATE MATERIALIZED VIEW, DECLARE or EXECUTE statement";
function explainable(ctx: ParseContext<SqlTokenType>): Explain["statement"] {
  if (ctx.is("ident", "execute")) return ctx.parse(executeStmt) as Execute;
  if (ctx.is("ident", "declare")) return ctx.parse(declareCursorStmt) as DeclareCursor;
  if (ctx.is("ident", "create")) {
    // Only parsed is a CREATE TABLE told apart from CREATE TABLE AS, so the
    // croak spans the whole statement, as CREATE SCHEMA's element check does —
    // from CREATE, which a CREATE TABLE node's own span leaves out.
    const start = ctx.position();
    const stmt = ctx.parse(createStmt);
    if (stmt.kind === "createTableAs" || (stmt.kind === "createView" && stmt.materialized)) return stmt;
    return ctx.croak(
      "EXPLAIN takes CREATE TABLE AS or CREATE MATERIALIZED VIEW but no other CREATE",
      start,
      stmt.span.end,
    );
  }
  if (!matchesFirst(ctx.peek(), PREPARABLE_FIRST)) {
    return ctx.croak(`Expected ${EXPLAINABLE} but found ${describeFound(ctx.peek())}`);
  }
  return ctx.parse(dmlStatement) as Preparable;
}

// A `(` after EXPLAIN opens the option list unless a query follows it: PG reads
// `EXPLAIN (SELECT 1)` as the parenthesised query, since no option is named
// after a query word (all reserved), nor opens with a `(`.
function opensQuery(tok: Token<SqlTokenType> | null): boolean {
  if (tok === null) return false;
  if (tok.type === "punc") return tok.value === "(";
  return tok.type === "ident" && QUERY_WORDS.has(tok.value);
}

const explainStmt = custom<Stmt, SqlTokenType>(
  (ctx) => {
    const start = ctx.position();
    ctx.parse(kw("explain"));
    const options =
      ctx.is("punc", "(") && !opensQuery(peekOrReport(ctx, 1))
        ? ctx.parse(relationOptions)
        : legacyFlags(ctx, [ANALYZE_WORDS, ["verbose"]]);
    const statement = explainable(ctx);
    return { kind: "explain", options, statement, span: ctx.spanFrom(start) };
  },
  { expected: '"explain"', first: [{ type: "ident", value: "explain" }] },
);

// --- LOCK and CALL ---
// Both lead words stay UNRESERVED, matched by value, as do the lock-mode words.

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
    const tables = ctx.parse(sepBy(relationExpr, P(",")));
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
    const { args, variadic } = parseCallArgList(ctx);
    return { kind: "callProcedure", name, args, ...(variadic && { variadic: true }), span: ctx.spanFrom(start) };
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
    if (!matchesFirst(ctx.peek(), QUERY_FIRST)) {
      return ctx.croak(`Expected a query but found ${describeFound(ctx.peek())}`);
    }
    const body = ctx.parse(query);
    return { kind: "declare", name, ...options, hold, query: body, span: ctx.spanFrom(start) };
  },
  { expected: '"declare"', first: [{ type: "ident", value: "declare" }] },
);

// A count: parseSignedInt's SignedIconst, as PG's fetch_args takes it.
const startsCount = (ctx: ParseContext<SqlTokenType>): boolean =>
  ctx.is("number") || (isSign(ctx.peek()) && ctx.peekAhead(1)?.type === "number");
const signedCount = (ctx: ParseContext<SqlTokenType>): number => parseSignedInt(ctx, "an integer count");

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
// dmlStatement owns `with`/`select`/`values`/`table`/`(`/`insert`/`update`/
// `delete`/`merge`.
//
// Three named groups rather than one flat list, so each family has its own place
// to grow. Nesting is dispatch- and validation-equivalent to the flat form —
// oneOf's first() is a flatMap, and the inner groups catch collisions within a
// family — and the composed `expected` is overridden by describe() anyway.
const ddlStmt = oneOf(createStmt, alterStmt, dropStmt, truncateStmt, commentStmt, securityLabelStmt, refreshStmt);
const utilityStmt = oneOf(
  grantStmt,
  transactionStmt,
  sessionStmt,
  doStmt,
  deallocateStmt,
  prepareStmt,
  executeStmt,
  explainStmt,
  analyzeStmt,
  vacuumStmt,
  clusterStmt,
  reindexStmt,
  checkpointStmt,
  loadStmt,
  discardStmt,
  listenStmt,
  notifyStmt,
  unlistenStmt,
  lockStmt,
  callStmt,
  declareCursorStmt,
  fetchStmt,
  moveStmt,
  closeStmt,
  copyStmt,
  reassignStmt,
);
const statementBody = oneOf(ddlStmt, utilityStmt, dmlStatement).describe("a statement");
// PG's stmtmulti: `;` separates statements rather than ending them, so the
// last statement may omit it (`SELECT 1`), and an empty statement (`;;`, a
// leading `;`) yields no node — `null` here, dropped by the root. Anything
// else after a statement is an error at that token (`SELECT 1 SELECT 2`).
// `;` is also the recovery sync point.
const SEMICOLON = punc(";");
const statement = custom<Stmt | null, SqlTokenType>(
  (ctx) => {
    if (ctx.eat("punc", ";") !== null) return null;
    const stmt = ctx.parse(statementBody);
    if (!ctx.eof()) ctx.parse(SEMICOLON);
    return stmt;
  },
  { expected: statementBody.expected(), first: [...statementBody.first(), { type: "punc", value: ";" }] },
);
// Not `.map()`: it reads the start position before repeat() runs, so a lexer
// error on the first token would escape diagnose()'s recovery.
const statements = repeat(statement);
const script = custom<Stmt[], SqlTokenType>((ctx) => ctx.parse(statements).filter((stmt) => stmt !== null), {
  expected: statements.expected(),
  first: statements.first(),
});

// --- psql scripts ---
//
// `sqlLiteScript` parses a whole file as psql would run it: statements, the
// meta-command lines between them, and each `COPY … FROM STDIN`'s rows (the
// script lexer reads those, see `sqlScriptParseLexer`). Statements are read by
// the same rule as `sqlLite`'s, so a script differs from plain SQL only in what
// sits between statements.

// psql ends a command name at whitespace or another backslash, so `\\` is the
// one name that is a backslash. A line with no name after its backslash is
// psql's own `invalid command \`; the lexer leaves that error to this rule.
const psqlMetaNode = (ctx: ParseContext<SqlTokenType>, token: Token<SqlTokenType>): PsqlMeta | null => {
  const match = /^\\(\\|[^\s\\]+)(.*)$/s.exec(token.value);
  if (match !== null) return { kind: "psqlMeta", command: match[1]!, args: match[2]!.trim(), span: token.position };
  const error = new ParseError('Invalid psql meta-command "\\"', token.position.start, token.position.end);
  if (!ctx.report(error)) throw error;
  return null;
};

// A COPY data block's error, reported (diagnose) or thrown (parse). Recording
// it rather than throwing keeps the COPY's node, and the rows are behind the
// cursor either way.
const reportCopyData = (ctx: ParseContext<SqlTokenType>, token: Token<SqlTokenType>) => {
  const error = copyDataError(token);
  if (error !== undefined && !ctx.report(error)) throw error;
};

const scriptItem = custom<ScriptItem | null, SqlTokenType>(
  (ctx) => {
    const meta = ctx.eat("psqlmeta");
    if (meta !== null) return psqlMetaNode(ctx, meta);
    // Rows whose COPY failed to parse: diagnose() has reported the statement,
    // and the rows are no statement of their own.
    const orphan = ctx.eat("copydata");
    if (orphan !== null) {
      reportCopyData(ctx, orphan);
      return null;
    }
    const stmt = ctx.parse(statement);
    const data = stmt?.kind === "copy" ? ctx.eat("copydata") : null;
    if (data !== null) {
      (stmt as Copy).data = data.value;
      reportCopyData(ctx, data);
    }
    return stmt;
  },
  {
    expected: `${statement.expected()} or a psql meta-command`,
    first: [...statement.first(), { type: "psqlmeta" }, { type: "copydata" }],
  },
);
// repeat(scriptItem), but recovery may stop on a meta-command line without
// losing it. repeat() consumes the token it resynchronised on when recovery
// made no progress; a meta-command is an item of its own, so the next round
// takes it instead.
const scriptRoot = custom<ScriptItem[], SqlTokenType>(
  (ctx) => {
    const items: ScriptItem[] = [];
    for (;;) {
      try {
        if (ctx.eof()) break;
        if (!matchesFirst(ctx.peek(), scriptItem.first())) {
          ctx.croak(`Expected ${scriptItem.expected()} but found ${describeFound(ctx.peek())}`);
        }
        const item = ctx.parse(scriptItem);
        if (item !== null) items.push(item);
      } catch (error) {
        if (!(error instanceof ParseError)) throw error;
        const before = ctx.consumed();
        if (!ctx.recover(error)) throw error;
        if (ctx.consumed() === before && !ctx.eof() && !ctx.is("psqlmeta")) ctx.next();
      }
    }
    return items;
  },
  { expected: scriptItem.expected(), first: scriptItem.first() },
);

// --- grammar ---

export const sqlLite = defineGrammar({
  lexer: sqlParseLexer,
  root: script,
  recovery: { sync: [{ type: "punc", value: ";", consume: true }] },
  // Opt into PG-style farthest-failure reporting: when a discarded backtracking
  // branch (a mistyped IF NOT EXISTS) got deeper than the error that surfaced,
  // report the deeper one. Lexer errors propagate: a bad literal inside a
  // backtracking branch (`INSERT INTO t (a, X'G1')`) reports itself rather
  // than whatever the rolled-back parse trips over next.
  errorReporting: { preferFarthest: true, propagateLexerErrors: true },
  // The last statement needs no `;`, so a list still open at end of input
  // (`INSERT INTO t VALUES (1`) must fail rather than close there.
  strictDelimited: true,
});

// `sqlLite` for whole psql scripts, pg_dump output included: the same
// statements and options, plus meta-command lines (`psqlMeta` items) and COPY
// rows (`Copy.data`). Recovery also resumes at a meta-command line, which ends
// a statement left unfinished before it.
export const sqlLiteScript = defineGrammar({
  lexer: sqlScriptParseLexer,
  root: scriptRoot,
  recovery: {
    sync: [
      { type: "punc", value: ";", consume: true },
      { type: "psqlmeta", consume: false },
    ],
  },
  errorReporting: { preferFarthest: true, propagateLexerErrors: true },
  strictDelimited: true,
});
