import {
  attempt,
  bindTokens,
  defineGrammar,
  delimited,
  field,
  lazy,
  oneOf,
  optional,
  pratt,
  type Rule,
  repeat,
  type Span,
  seq,
  skip,
} from "../../src/index";
import { type JsTokenType, jsLexer } from "./lexer";

// --- AST ---
// Recursive types are declared by hand (the one boundary schema inference has,
// same as zod's z.lazy); everything is still produced by the rules below.

export type Expr =
  | { kind: "number"; value: number; span: Span }
  | { kind: "string"; value: string; span: Span }
  | { kind: "boolean"; value: boolean; span: Span }
  | { kind: "null"; span: Span }
  | { kind: "ident"; name: string; span: Span }
  | { kind: "array"; elements: Expr[]; span: Span }
  | { kind: "arrow"; params: string[]; body: Expr | Stmt; span: Span }
  | { kind: "unary"; op: string; operand: Expr; span: Span }
  | { kind: "binary"; op: string; left: Expr; right: Expr; span: Span }
  | { kind: "assign"; target: Expr; value: Expr; span: Span }
  | { kind: "cond"; test: Expr; consequent: Expr; alternate: Expr; span: Span }
  | { kind: "call"; callee: Expr; args: Expr[]; span: Span }
  | { kind: "member"; object: Expr; property: string; span: Span }
  | { kind: "index"; object: Expr; index: Expr; span: Span };

export type Stmt =
  | { kind: "var"; declKind: "const" | "let"; name: string; init: Expr; span: Span }
  | { kind: "function"; name: string; params: string[]; body: Stmt; span: Span }
  | { kind: "if"; test: Expr; consequent: Stmt; alternate: Stmt | null; span: Span }
  | { kind: "while"; test: Expr; body: Stmt; span: Span }
  | { kind: "return"; argument: Expr | null; span: Span }
  | { kind: "block"; body: Stmt[]; span: Span }
  | { kind: "expr"; expression: Expr; span: Span };

// --- token sugar ---

const { token, match } = bindTokens<JsTokenType>();
const punc = (value: string) => token("punc", { values: [value] });
const kw = (value: string) => token("kw", { values: [value] });
const P = (value: string) => match("punc", value);

const identName = token("ident").map((node) => node.value);

// --- expressions ---

const expression: Rule<Expr, JsTokenType> = lazy(() => expressionRule);
const statement: Rule<Stmt, JsTokenType> = lazy(() => statementRule);
const blockLazy: Rule<Stmt, JsTokenType> = lazy(() => blockStmt);

const numberLit = token("number").map((node, span): Expr => ({ kind: "number", value: Number(node.value), span }));
const stringLit = token("string").map((node, span): Expr => ({ kind: "string", value: node.value, span }));
const boolLit = token("kw", { values: ["true", "false"] }).map(
  (node, span): Expr => ({ kind: "boolean", value: node.value === "true", span }),
);
const nullLit = kw("null").map((_node, span): Expr => ({ kind: "null", span }));
const identExpr = token("ident").map((node, span): Expr => ({ kind: "ident", name: node.value, span }));
const arrayLit = delimited(P("["), P("]"), P(","), expression, { interleaved: true }).map(
  (elements, span): Expr => ({ kind: "array", elements, span }),
);
const parenExpr = seq(skip(punc("(")), field("e", expression), skip(punc(")"))).map((s) => s.e);

const paramList = delimited(P("("), P(")"), P(","), identName, { interleaved: true });

// `(a, b) => a` shares its `(` prefix with `(a + b)`, and `x => x` shares its
// identifier prefix with a plain identifier expression: attempt() backtracking
// is load-bearing here.
const arrowFn = seq(
  field(
    "params",
    oneOf(
      paramList,
      identName.map((name) => [name]),
    ),
  ),
  skip(punc("=>")),
  field("body", oneOf(blockLazy, expression)),
).map(({ params, body }, span): Expr => ({ kind: "arrow", params, body, span }));

const atom = oneOf(attempt(arrowFn), parenExpr, numberLit, stringLit, boolLit, nullLit, arrayLit, identExpr);

const argsList = delimited(P("("), P(")"), P(","), expression, { interleaved: true });

const binary = (ops: string[], bp: number) => ({
  ops,
  bp,
  type: "punc" as const,
  map: (op: string, left: Expr, right: Expr, span: Span): Expr => ({ kind: "binary", op, left, right, span }),
});

const expressionRule = pratt<Expr, JsTokenType>({
  atom,
  prefix: [
    {
      ops: ["!", "-"],
      bp: 14,
      type: "punc",
      map: (op, operand, span): Expr => ({ kind: "unary", op, operand, span }),
    },
  ],
  infix: [
    {
      ops: ["="],
      bp: 2,
      assoc: "right",
      type: "punc",
      map: (_op, target, value, span): Expr => ({ kind: "assign", target, value, span }),
    },
    {
      ops: ["?"],
      bp: 3,
      type: "punc",
      parse: (ctx, left, h): Expr => {
        ctx.next(); // "?"
        const consequent = h.parseRhs(0);
        ctx.parse(punc(":"));
        const alternate = h.parseRhs(0);
        return {
          kind: "cond",
          test: left,
          consequent,
          alternate,
          span: { start: left.span.start, end: ctx.lastEnd() },
        };
      },
    },
    binary(["||"], 4),
    binary(["&&"], 5),
    binary(["==", "!=", "===", "!=="], 8),
    binary(["<", ">", "<=", ">="], 9),
    binary(["+", "-"], 11),
    binary(["*", "/", "%"], 12),
  ],
  postfix: [
    {
      match: punc("("),
      bp: 17,
      parse: (ctx, left): Expr => {
        const args = ctx.parse(argsList);
        return { kind: "call", callee: left, args, span: { start: left.span.start, end: ctx.lastEnd() } };
      },
    },
    {
      match: punc("."),
      bp: 17,
      parse: (ctx, left): Expr => {
        ctx.next(); // "."
        const property = ctx.parse(identName);
        return { kind: "member", object: left, property, span: { start: left.span.start, end: ctx.lastEnd() } };
      },
    },
    {
      match: punc("["),
      bp: 17,
      parse: (ctx, left): Expr => {
        ctx.next(); // "["
        const index = ctx.parse(expression);
        ctx.parse(punc("]"));
        return { kind: "index", object: left, index, span: { start: left.span.start, end: ctx.lastEnd() } };
      },
    },
  ],
});

// --- statements ---

const semi = punc(";");

const varDecl = seq(
  field(
    "declKind",
    token("kw", { values: ["const", "let"] }).map((node) => node.value),
  ),
  field("name", identName),
  skip(punc("=")),
  field("init", expression),
  skip(semi),
).map(({ declKind, name, init }, span): Stmt => ({ kind: "var", declKind, name, init, span }));

const funcDecl = seq(
  skip(kw("function")),
  field("name", identName),
  field("params", paramList),
  field("body", blockLazy),
).map(({ name, params, body }, span): Stmt => ({ kind: "function", name, params, body, span }));

const ifStmt = seq(
  skip(kw("if")),
  skip(punc("(")),
  field("test", expression),
  skip(punc(")")),
  field("consequent", statement),
  field("alternate", optional(seq(skip(kw("else")), field("s", statement)).map((s) => s.s))),
).map(({ test, consequent, alternate }, span): Stmt => ({ kind: "if", test, consequent, alternate, span }));

const whileStmt = seq(
  skip(kw("while")),
  skip(punc("(")),
  field("test", expression),
  skip(punc(")")),
  field("body", statement),
).map(({ test, body }, span): Stmt => ({ kind: "while", test, body, span }));

const returnStmt = seq(skip(kw("return")), field("argument", optional(expression)), skip(semi)).map(
  ({ argument }, span): Stmt => ({ kind: "return", argument, span }),
);

const blockStmt = seq(skip(punc("{")), field("body", repeat(statement, { until: [P("}")] })), skip(punc("}"))).map(
  ({ body }, span): Stmt => ({ kind: "block", body, span }),
);

const exprStmt = seq(field("expression", expression), skip(semi)).map(
  ({ expression: e }, span): Stmt => ({ kind: "expr", expression: e, span }),
);

const statementRule = oneOf(varDecl, funcDecl, ifStmt, whileStmt, returnStmt, blockStmt, exprStmt).describe(
  "a statement",
);

// --- grammar ---
// Root-rule form: expression statements have no leading keyword, so keyword
// dispatch can't be the model here. Sync points are explicit config.

export const jsLite = defineGrammar({
  lexer: jsLexer,
  root: repeat(statement),
  trivia: { between: [{ type: "comment" }] },
  recovery: {
    sync: [
      { type: "punc", value: ";", consume: true },
      { type: "punc", value: "}" },
    ],
  },
});
