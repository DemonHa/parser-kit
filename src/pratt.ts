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
// at bp + 1, right-associative ones at bp.
export interface PrattDef<T, TT extends string = string> {
  atom: Rule<T, TT>;
  prefix?: readonly {
    ops: readonly string[];
    bp: number;
    /** Restrict matching to one token type; defaults to matching by value. */
    type?: TT;
    map?: (op: string, operand: T, span: Span) => T;
  }[];
  infix?: readonly {
    ops: readonly string[];
    bp: number;
    type?: TT;
    assoc?: "left" | "right";
    map?: (op: string, left: T, right: T, span: Span) => T;
    /** Custom tail parse (ternary): consumes the operator itself. */
    parse?: (ctx: ParseContext<TT>, left: T) => T;
  }[];
  postfix?: readonly {
    match: Rule<unknown, TT>;
    bp: number;
    /** Consumes the whole postfix (call args, member name, index). */
    parse: (ctx: ParseContext<TT>, left: T) => T;
  }[];
}

const opMatches = <TT extends string>(token: Token<TT>, ops: readonly string[], type?: TT) =>
  ops.includes(token.value) && (type === undefined || token.type === type);

export function pratt<T, TT extends string = string>(def: PrattDef<T, TT>): Rule<T, TT> {
  const { atom, prefix = [], infix = [], postfix = [] } = def;

  const defaultPrefix = (op: string, operand: T, span: Span): T =>
    ({ type: "unary", op, operand, span }) as unknown as T;
  const defaultInfix = (op: string, left: T, right: T, span: Span): T =>
    ({ type: "binary", op, left, right, span }) as unknown as T;

  const parseExpression = (ctx: ParseContext<TT>, minBp: number): T => {
    const start = ctx.position();
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
        left = postfixGroup.parse(ctx, left);
        continue;
      }

      const infixGroup = infix.find((group) => opMatches(next, group.ops, group.type));
      if (!infixGroup || infixGroup.bp < minBp) break;

      if (infixGroup.parse) {
        left = infixGroup.parse(ctx, left);
        continue;
      }

      const op = ctx.next()!.value;
      const right = parseExpression(ctx, infixGroup.assoc === "right" ? infixGroup.bp : infixGroup.bp + 1);
      left = (infixGroup.map ?? defaultInfix)(op, left, right, ctx.spanFrom(start));
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
