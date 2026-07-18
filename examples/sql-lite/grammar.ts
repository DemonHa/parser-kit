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
// ALTER TABLE, DROP TABLE, COMMENT ON — plus the scalar expression sublanguage
// that DEFAULT / CHECK / index / WHERE clauses need. It is the end-to-end test
// for the PG-grade kit features: escaped/dollar strings, PG numbers, the
// operator reader, the fold-and-match keyword strategy, match-based and
// non-associative pratt operators, and farthest-failure / nested recovery.

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
  | { kind: "like"; expr: Expr; pattern: Expr; negated: boolean; ci: boolean; span: Span }
  | { kind: "between"; expr: Expr; lo: Expr; hi: Expr; negated: boolean; span: Span }
  | { kind: "in"; expr: Expr; list: Expr[]; negated: boolean; span: Span };

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
  | { kind: "comment"; objectType: string; name: string[]; comment: string | null; span: Span };

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
const argList = delimited(P("("), P(")"), P(","), expression, { interleaved: true });
const exprList = delimited(P("("), P(")"), P(","), expression, { interleaved: true });

const numberLit = token("number").map((node, span): Expr => ({ kind: "number", value: Number(node.value), span }));
const stringLit = token("string").map((node, span): Expr => ({ kind: "string", value: node.value, span }));
const boolLit = token("ident", { values: ["true", "false"] }).map(
  (node, span): Expr => ({ kind: "bool", value: node.value === "true", span }),
);
const nullLit = kw("null").map((_node, span): Expr => ({ kind: "null", span }));
const parenExpr = seq(skip(punc("(")), field("e", expression), skip(punc(")"))).map((s) => s.e);

// A qualified name, optionally applied as a call. One rule (no attempt needed):
// `count(*)`-style stars are out of scope, so `foo(a, b)` is a call and `s.t.c`
// a plain reference, dispatched by whether a `(` follows.
const nameOrCall = seq(field("parts", qualName), field("args", optional(argList))).map(
  ({ parts, args }, span): Expr =>
    args === null ? { kind: "name", parts, span } : { kind: "call", name: parts.join("."), args, span },
);

const atom = oneOf(numberLit, stringLit, boolLit, nullLit, parenExpr, nameOrCall);

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

const expressionRule = pratt<Expr, SqlTokenType>({
  atom,
  prefix: [
    { ops: ["-"], type: "op", bp: 16, map: (op, operand, span): Expr => ({ kind: "unary", op, operand, span }) },
    {
      ops: ["not"],
      type: "ident",
      bp: 6,
      map: (_op, operand, span): Expr => ({ kind: "unary", op: "not", operand, span }),
    },
  ],
  infix: [
    binary(["*", "/"], 14),
    binary(["+", "-"], 13),
    binary(["||"], 12),
    binary(["@>"], 12),
    {
      // LIKE / ILIKE. RHS at bp 11 keeps it out of the looser comparison level.
      match: token("ident", { values: ["like", "ilike"] }),
      bp: 10,
      parse: (ctx, left, h): Expr => {
        const op = ctx.next()!.value;
        const pattern = h.parseRhs(11);
        return {
          kind: "like",
          expr: left,
          pattern,
          negated: false,
          ci: op === "ilike",
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
          return {
            kind: "like",
            expr: left,
            pattern,
            negated: true,
            ci: op === "ilike",
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
          const list = ctx.parse(exprList);
          return { kind: "in", expr: left, list, negated: true, span: closeSpan(left, ctx.lastEnd()) };
        }
        return ctx.croak(
          `Expected "like", "ilike", "between" or "in" after "not" but found ${describeFound(ctx.peek())}`,
        );
      },
    },
    // Same-precedence comparisons in one nonassoc group: `a < b < c` errors,
    // `(a < b) < c` parses.
    binary(["<", ">", "<=", ">=", "=", "<>", "!="], 9, "nonassoc"),
    kwBinary("and", 4),
    kwBinary("or", 2),
  ],
  postfix: [
    {
      match: punc("::"),
      bp: 18,
      parse: (ctx, left): Expr => {
        ctx.next(); // "::"
        const type = ctx.parse(typeRef);
        return { kind: "cast", expr: left, type, span: closeSpan(left, ctx.lastEnd()) };
      },
    },
    {
      match: kw("is"),
      bp: 8,
      parse: (ctx, left): Expr => {
        ctx.parse(kw("is"));
        const negated = ctx.eat("ident", "not") !== null;
        ctx.parse(kw("null"));
        return { kind: "is", expr: left, negated, span: closeSpan(left, ctx.lastEnd()) };
      },
    },
    {
      match: kw("in"),
      bp: 10,
      parse: (ctx, left): Expr => {
        ctx.parse(kw("in"));
        const list = ctx.parse(exprList);
        return { kind: "in", expr: left, list, negated: false, span: closeSpan(left, ctx.lastEnd()) };
      },
    },
  ],
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

const statementBody = oneOf(createStmt, alterStmt, dropStmt, commentStmt).describe("a statement");
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
