import { describeFound, renderLiteral } from "./describe";
import { ParseError } from "./error";
import { createInputStream } from "./input-stream";
import type { Lexer } from "./lexer";
import type { Span } from "./position";
import {
  createParseContext,
  type FirstEntry,
  makeRule,
  type ParseContext,
  type Rule,
  type RuleTT,
  type SyncPoint,
} from "./rule";
import { matchesToken, type TokenMatch } from "./token";

// A keyword match: an explicit TokenMatch, or a bare string that matches any
// token with that value (keyword lexing usually makes the type unambiguous).
export type KeywordMatch<TT extends string = string> = TokenMatch<TT> | string;

const keywordEntry = <TT extends string>(keyword: KeywordMatch<TT>): FirstEntry<TT> =>
  typeof keyword === "string" ? { value: keyword } : keyword;

const keywordMatches = <TT extends string>(ctx: ParseContext<TT>, keyword: KeywordMatch<TT>) => {
  const token = ctx.peek();
  if (token === null) return false;
  if (typeof keyword === "string") return token.value === keyword;
  return matchesToken(token, keyword);
};

const keywordLabel = <TT extends string>(keyword: KeywordMatch<TT>) =>
  typeof keyword === "string" ? keyword : (keyword.value ?? keyword.type);

export interface ExpressionRule<Out, TT extends string = string> extends Rule<Out, TT> {
  readonly keyword: KeywordMatch<TT>;
  readonly display: string;
}

// A keyword-led top-level construct: the keyword is consumed, doubles as the
// error-recovery sync point, and stamps the `type` discriminant on the output.
export function defineExpression<const Ty extends string, R extends Rule<object, any>>(def: {
  keyword: KeywordMatch<RuleTT<R>>;
  type: Ty;
  rule: R;
  display?: string;
}): ExpressionRule<{ type: Ty } & R["_out"], RuleTT<R>> {
  type TT = RuleTT<R>;
  type Out = { type: Ty } & R["_out"];
  const display = def.display ?? keywordLabel(def.keyword);

  const base = makeRule<Out, TT>({
    parse: (ctx) => {
      const start = ctx.position();
      if (!keywordMatches(ctx, def.keyword)) {
        ctx.croak(`Expected ${renderLiteral(keywordLabel(def.keyword))} but found ${describeFound(ctx.peek())}`);
      }
      ctx.next();
      const body = def.rule.parse(ctx) as object;
      const span: Span = ctx.spanFrom(start);
      return { type: def.type, ...body, span } as Out;
    },
    first: () => [keywordEntry(def.keyword)],
    expected: () => renderLiteral(keywordLabel(def.keyword)),
  });

  return { ...base, keyword: def.keyword, display };
}

export interface Grammar<Out, TT extends string = string> {
  /** Parse the whole input, throwing the first ParseError. */
  parse(text: string): Out;
  /** Parse with error recovery: partial AST plus every collected diagnostic. */
  diagnose(text: string): { ast: Out; errors: ParseError[] };
  /** Run any sub-rule standalone against fresh input (tests, tooling). */
  parseValue<T>(rule: Rule<T, TT>, text: string): T;
}

interface GrammarCommon<TT extends string> {
  lexer: Lexer<TT>;
  trivia?: { between: readonly TokenMatch<TT>[] };
  /**
   * preferFarthest: report the croak that consumed the most tokens instead of
   * the one that happened to propagate — standard PEG farthest-failure. The
   * substituted error may point into an abandoned backtracking branch; that
   * is usually the better message, and the flag scopes the risk (off = every
   * message byte-identical to today).
   */
  errorReporting?: { preferFarthest?: boolean };
}

export interface RootGrammarDef<R extends Rule<unknown, TT>, TT extends string> extends GrammarCommon<TT> {
  root: R;
  recovery?: { sync: readonly SyncPoint<TT>[] };
}

export interface ExpressionsGrammarDef<Es extends readonly ExpressionRule<object, TT>[], TT extends string>
  extends GrammarCommon<TT> {
  expressions: Es;
}

export function defineGrammar<TT extends string, R extends Rule<unknown, TT>>(
  def: RootGrammarDef<R, TT>,
): Grammar<R["_out"], TT>;
export function defineGrammar<TT extends string, const Es extends readonly ExpressionRule<object, TT>[]>(
  def: ExpressionsGrammarDef<Es, TT>,
): Grammar<{ type: "program"; program: Es[number]["_out"][]; span: Span }, TT>;
export function defineGrammar<TT extends string>(
  def: RootGrammarDef<Rule<unknown, TT>, TT> | ExpressionsGrammarDef<readonly ExpressionRule<object, TT>[], TT>,
): Grammar<unknown, TT> {
  const trivia = def.trivia?.between ?? [];

  // The expressions-sugar form derives the root loop, the top-level error
  // message and the recovery sync set from the expression list itself.
  let root: Rule<unknown, TT>;
  let sync: readonly SyncPoint<TT>[];
  if ("expressions" in def) {
    const expressions = def.expressions;
    sync = expressions.map((expression) => {
      const entry = keywordEntry(expression.keyword);
      return { type: entry.type, value: entry.value } as SyncPoint<TT>;
    });
    const topLevelExpected = () => {
      const displays = expressions.map((expression) => renderLiteral(expression.display));
      if (displays.length <= 1) return displays[0] ?? "an expression";
      return `${displays.slice(0, -1).join(", ")} or ${displays[displays.length - 1]}`;
    };

    root = makeRule<unknown, TT>({
      parse: (ctx) => {
        const start = ctx.position();
        const program: unknown[] = [];
        while (true) {
          try {
            ctx.skipTrivia();
            if (ctx.eof()) break;
            const expression = expressions.find((candidate) => keywordMatches(ctx, candidate.keyword));
            if (!expression) {
              // Consume the offending token before croaking so the recovery
              // loop is guaranteed to make progress.
              const startPos = ctx.position();
              const found = ctx.next();
              throw new ParseError(
                `Expected ${topLevelExpected()} but found ${describeFound(found)}`,
                startPos,
                ctx.lastEnd(),
              );
            }
            program.push(expression.parse(ctx));
          } catch (error) {
            if (!(error instanceof ParseError)) throw error;
            const before = ctx.consumed();
            if (!ctx.recover(error)) throw error;
            if (ctx.consumed() === before && !ctx.eof()) ctx.next();
          }
        }
        return { type: "program", program, span: ctx.spanFrom(start) };
      },
      first: () => expressions.flatMap((expression) => expression.first()),
      expected: topLevelExpected,
    });
  } else {
    root = def.root;
    sync = def.recovery?.sync ?? [];
  }

  const preferFarthest = def.errorReporting?.preferFarthest ?? false;

  const run = (text: string, errors?: ParseError[]) => {
    const stream = def.lexer.tokenize(createInputStream(text));
    const ctx = createParseContext(stream, { labels: def.lexer.labels, trivia, sync, errors, preferFarthest });
    let ast: unknown;
    try {
      ast = root.parse(ctx);
    } catch (error) {
      // Strict-mode farthest-failure selection; diagnose applies the same
      // substitution inside the context as each error is recorded.
      if (preferFarthest && error instanceof ParseError && error.consumed !== undefined) {
        const farthest = ctx.farthestError();
        if (farthest !== null && farthest.consumed! > error.consumed) throw farthest;
      }
      throw error;
    }
    ctx.skipTrivia();
    if (!ctx.eof()) {
      const error = new ParseError(
        `Expected ${root.expected(def.lexer.labels)} but found ${describeFound(ctx.peek())}`,
        ctx.position(),
        ctx.position(),
      );
      if (errors) {
        errors.push(error);
      } else {
        throw error;
      }
    }
    return ast;
  };

  return {
    parse: (text) => run(text),
    diagnose: (text) => {
      const errors: ParseError[] = [];
      const ast = run(text, errors);
      return { ast, errors };
    },
    parseValue: (rule, text) => {
      const stream = def.lexer.tokenize(createInputStream(text));
      const ctx = createParseContext(stream, { labels: def.lexer.labels, trivia });
      ctx.skipTrivia();
      const value = rule.parse(ctx);
      ctx.skipTrivia();
      if (!ctx.eof()) {
        ctx.croak(`Expected end of input but found ${describeFound(ctx.peek())}`);
      }
      return value;
    },
  };
}
