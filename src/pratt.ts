import type { Span } from "./position";
import {
  contextLabels,
  croakExpected,
  type FirstEntry,
  makeRule,
  matchesFirst,
  type ParseContext,
  type Rule,
} from "./rule";
import type { Token } from "./token";

// Declarative precedence-climbing expression parser. Binding powers are plain
// numbers: higher binds tighter; left-associative operators re-enter the loop
// at bp + 1, right-associative ones at bp. Non-associative operators re-enter
// at bp + 1 like left, then croak if another operator of the same group
// follows (`a < b < c` is an error, `(a < b) < c` parses).
/** Passed to custom infix/postfix parse callbacks. */
export interface PrattHelpers<T> {
  /**
   * Re-enter precedence climbing for an operand: parse an expression whose
   * operators all bind at least as tightly as `minBp`. This is how a custom
   * tail consumes its right-hand side without recursing through the whole
   * rule at bp 0 (BETWEEN's bounds, a ternary's branches).
   */
  parseRhs(minBp: number): T;
}

export type PrattInfix<T, TT extends string = string> =
  | {
      ops: readonly string[];
      bp: number;
      /** Restrict matching to one token type; defaults to matching by value. */
      type?: TT;
      assoc?: "left" | "right" | "nonassoc";
      map?: (op: string, left: T, right: T, span: Span) => T;
      /** Custom tail parse (ternary): consumes the operator itself. */
      parse?: (ctx: ParseContext<TT>, left: T, helpers: PrattHelpers<T>) => T;
    }
  | {
      /**
       * Dispatch on a rule's first set instead of literal op values — the hook
       * for multi-word operators (`word("ident", "between")`, `phrase("ident",
       * "not", "like")`). Groups are tried in declaration order and the first
       * match wins, so operators sharing a leading token (NOT LIKE / NOT
       * BETWEEN / NOT IN) must be one group dispatching internally.
       */
      match: Rule<unknown, TT>;
      bp: number;
      assoc?: "left" | "right" | "nonassoc";
      /** Consumes the operator (typically via the match rule) and the RHS. */
      parse: (ctx: ParseContext<TT>, left: T, helpers: PrattHelpers<T>) => T;
    };

export interface PrattDef<T, TT extends string = string> {
  atom: Rule<T, TT>;
  prefix?: readonly {
    ops: readonly string[];
    bp: number;
    /** Restrict matching to one token type; defaults to matching by value. */
    type?: TT;
    map?: (op: string, operand: T, span: Span) => T;
  }[];
  infix?: readonly PrattInfix<T, TT>[];
  postfix?: readonly {
    match: Rule<unknown, TT>;
    bp: number;
    /** Consumes the whole postfix (call args, member name, index). */
    parse: (ctx: ParseContext<TT>, left: T, helpers: PrattHelpers<T>) => T;
  }[];
}

const opMatches = <TT extends string>(token: Token<TT>, ops: readonly string[], type?: TT) =>
  ops.includes(token.value) && (type === undefined || token.type === type);

const infixMatches = <T, TT extends string>(token: Token<TT>, group: PrattInfix<T, TT>) =>
  "ops" in group ? opMatches(token, group.ops, group.type) : matchesFirst(token, group.match.first());

export function pratt<T, TT extends string = string>(def: PrattDef<T, TT>): Rule<T, TT> {
  const { atom, prefix = [], infix = [], postfix = [] } = def;

  const defaultPrefix = (op: string, operand: T, span: Span): T =>
    ({ type: "unary", op, operand, span }) as unknown as T;
  const defaultInfix = (op: string, left: T, right: T, span: Span): T =>
    ({ type: "binary", op, left, right, span }) as unknown as T;

  const parseExpression = (ctx: ParseContext<TT>, minBp: number): T => {
    const start = ctx.position();
    const helpers: PrattHelpers<T> = { parseRhs: (bp) => parseExpression(ctx, bp) };
    let left: T;

    const tok = ctx.peek();
    const prefixGroup = tok && prefix.find((group) => opMatches(tok, group.ops, group.type));
    if (tok && prefixGroup) {
      const op = ctx.next()!.value;
      const operand = parseExpression(ctx, prefixGroup.bp);
      left = (prefixGroup.map ?? defaultPrefix)(op, operand, ctx.spanFrom(start));
    } else {
      left = atom.parse(ctx);
    }

    while (true) {
      const next = ctx.peek();
      if (next === null) break;

      const postfixGroup = postfix.find((group) => group.bp >= minBp && matchesFirst(next, group.match.first()));
      if (postfixGroup) {
        left = postfixGroup.parse(ctx, left, helpers);
        continue;
      }

      const infixGroup = infix.find((group) => infixMatches(next, group));
      if (!infixGroup || infixGroup.bp < minBp) break;

      if ("match" in infixGroup || infixGroup.parse) {
        left = "ops" in infixGroup ? infixGroup.parse!(ctx, left, helpers) : infixGroup.parse(ctx, left, helpers);
      } else {
        const op = ctx.next()!.value;
        const right = parseExpression(ctx, infixGroup.assoc === "right" ? infixGroup.bp : infixGroup.bp + 1);
        left = (infixGroup.map ?? defaultInfix)(op, left, right, ctx.spanFrom(start));
      }

      // A nonassoc RHS was parsed at bp + 1, so a same-group operator here
      // would silently left-associate at this loop — reject the chain instead.
      if (infixGroup.assoc === "nonassoc") {
        const after = ctx.peek();
        if (after !== null && infixMatches(after, infixGroup)) {
          ctx.croak(`Operator "${after.value}" is non-associative`);
        }
      }
    }

    return left;
  };

  const first = (): readonly FirstEntry<TT>[] => {
    const entries: FirstEntry<TT>[] = [...atom.first()];
    for (const group of prefix) {
      for (const op of group.ops) {
        entries.push(group.type === undefined ? { value: op } : { type: group.type, value: op });
      }
    }
    return entries;
  };

  return makeRule<T, TT>({
    parse: (ctx) => {
      if (!matchesFirst(ctx.peek(), first())) {
        return croakExpected(ctx, atom.expected(contextLabels(ctx)));
      }
      return parseExpression(ctx, 0);
    },
    first,
    expected: (labels) => atom.expected(labels),
  });
}
