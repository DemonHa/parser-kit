import { describeType, quoteList, type TypeLabels } from "./describe";
import { ParseError } from "./error";
import type { Span } from "./position";
import {
  contextLabels,
  croakExpected,
  type FirstEntry,
  makeRule,
  matchesFirst,
  type ParseContext,
  type Printer,
  type Rule,
  type RuleTT,
} from "./rule";
import { matchesToken, type Token, type TokenMatch } from "./token";

// --- token() ---

export interface TokenNode<Ty extends string = string, V extends string = string> {
  type: Ty;
  value: V;
  span: Span;
}

export function token<TT extends string, Ty extends TT>(type: Ty): Rule<TokenNode<Ty>, TT>;
export function token<TT extends string, Ty extends TT, const V extends string>(
  type: Ty,
  opts: { values: readonly V[]; display?: string },
): Rule<TokenNode<Ty, V>, TT>;
export function token<TT extends string, Ty extends TT>(type: Ty, opts: { display: string }): Rule<TokenNode<Ty>, TT>;
export function token<TT extends string, Ty extends TT>(
  type: Ty,
  opts?: { values?: readonly string[]; display?: string },
): Rule<TokenNode<Ty>, TT> {
  const values = opts?.values;
  const expected = (labels?: TypeLabels) => opts?.display ?? (values ? quoteList(values) : describeType(type, labels));

  return makeRule<TokenNode<Ty>, TT>({
    parse: (ctx) => {
      const found = ctx.peek();
      if (found && found.type === type && (!values || values.includes(found.value))) {
        ctx.next();
        return { type, value: found.value, span: { ...found.position } };
      }
      return croakExpected(ctx, expected(contextLabels(ctx)));
    },
    first: () => (values ? values.map((value) => ({ type, value })) : [{ type }]),
    expected,
  });
}

// bindTokens<TT>() returns pre-parameterized factories so a grammar module
// doesn't have to repeat its token-type generic at every call site.
export function bindTokens<TT extends string>() {
  return {
    token: (<Ty extends TT>(type: Ty, opts?: { values?: readonly string[]; display?: string }) =>
      (token as (t: Ty, o?: unknown) => Rule<TokenNode<Ty>, TT>)(type, opts)) as {
      <Ty extends TT>(type: Ty): Rule<TokenNode<Ty>, TT>;
      <Ty extends TT, const V extends string>(
        type: Ty,
        opts: { values: readonly V[]; display?: string },
      ): Rule<TokenNode<Ty, V>, TT>;
      <Ty extends TT>(type: Ty, opts: { display: string }): Rule<TokenNode<Ty>, TT>;
    },
    match: (type: TT, value?: string): TokenMatch<TT> => ({ type, value }),
  };
}

// --- seq() / field() / skip() ---

export interface FieldRule<K extends string, T, TT extends string = string> {
  readonly kind: "field";
  readonly name: K;
  readonly rule: Rule<T, TT>;
}

export interface SkipRule<TT extends string = string> {
  readonly kind: "skip";
  readonly rule: Rule<unknown, TT>;
}

export type SeqItem<TT extends string = string> = FieldRule<string, unknown, TT> | SkipRule<TT>;

export function field<const K extends string, T, TT extends string = string>(
  name: K,
  rule: Rule<T, TT>,
): FieldRule<K, T, TT> {
  return { kind: "field", name, rule };
}

export function skip<TT extends string = string>(rule: Rule<unknown, TT>): SkipRule<TT> {
  return { kind: "skip", rule };
}

type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never;

type FieldsUnion<Rs extends readonly SeqItem<any>[]> = {
  [I in keyof Rs]: Rs[I] extends FieldRule<infer K, infer T, any> ? { [P in K]: T } : never;
}[number];

type MergeFields<Rs extends readonly SeqItem<any>[]> = [FieldsUnion<Rs>] extends [never]
  ? unknown
  : UnionToIntersection<FieldsUnion<Rs>>;

type Prettify<T> = { [K in keyof T]: T[K] };

// TT can't be inferred through the union-typed item constraint, so it is
// derived from the items instead of taken as a type parameter.
type ItemTT<I> = I extends FieldRule<any, any, infer TT> ? TT : I extends SkipRule<infer TT> ? TT : never;
export function seq<const Rs extends readonly SeqItem<any>[]>(
  ...rules: Rs
): Rule<Prettify<MergeFields<Rs> & { span: Span }>, ItemTT<Rs[number]>> {
  type TT = ItemTT<Rs[number]>;
  type Out = Prettify<MergeFields<Rs> & { span: Span }>;

  const first = (): readonly FirstEntry<TT>[] => {
    // The dispatch set extends across leading nullable items (an optional
    // prefix means the next item's tokens can begin the sequence too).
    const entries: FirstEntry<TT>[] = [];
    for (const item of rules) {
      entries.push(...item.rule.first());
      if (!item.rule.nullable) break;
    }
    return entries;
  };

  return makeRule<Out, TT>({
    parse: (ctx) => {
      const start = ctx.position();
      const out: Record<string, unknown> = {};
      for (const item of rules) {
        const value = item.rule.parse(ctx);
        if (item.kind === "field") {
          out[item.name] = value;
        }
      }
      out.span = ctx.spanFrom(start);
      return out as Out;
    },
    first,
    expected: (labels) => rules[0]?.rule.expected(labels) ?? "nothing",
  });
}

// --- oneOf() / attempt() ---

type InferOut<R> = R extends Rule<infer T, any> ? T : never;

// Like seq(), TT is derived from the branches rather than taken as a type
// parameter, so it survives inference.
export function oneOf<const Rs extends readonly Rule<any, any>[]>(
  ...rules: Rs
): Rule<InferOut<Rs[number]>, RuleTT<Rs[number]>> {
  type TT = RuleTT<Rs[number]>;
  type Out = InferOut<Rs[number]>;

  // Validation: two committed (non-attempt) branches may not claim the same
  // first entry, which would make dispatch order-dependent. Duplicates within
  // one branch (e.g. nested alternatives sharing a prefix behind attempt())
  // are fine and deduped before the check.
  const validate = () => {
    const seen = new Set<string>();
    for (const rule of rules) {
      if (rule.backtracks) continue;
      const branchKeys = new Set(rule.first().map((entry) => `${entry.type ?? "*"}:${entry.value ?? "(any value)"}`));
      for (const key of branchKeys) {
        if (seen.has(key)) {
          throw new Error(`oneOf: overlapping first sets on ${key} - wrap one branch in attempt() if intentional`);
        }
        seen.add(key);
      }
    }
  };

  // Run the check at definition time when possible. A branch behind lazy()
  // may reference a rule that doesn't exist yet (recursive grammars) — its
  // first() throws a TDZ ReferenceError, so the check reruns on first parse.
  let validated = false;
  try {
    validate();
    validated = true;
  } catch (error) {
    if (!(error instanceof ReferenceError)) throw error;
  }

  const branchMatches = (rule: Rule<unknown, TT>, tok: Token<TT>, valueSpecific: boolean) =>
    rule
      .first()
      .some(
        (entry) =>
          (entry.value !== undefined) === valueSpecific &&
          (entry.type === undefined || entry.type === tok.type) &&
          (entry.value === undefined || entry.value === tok.value),
      );

  const expected = (labels?: TypeLabels) => {
    const parts: string[] = [];
    for (const rule of rules) {
      const part = rule.expected(labels);
      if (!parts.includes(part)) parts.push(part);
    }
    return parts.join(" or ");
  };

  return makeRule<Out, TT>({
    parse: (ctx) => {
      if (!validated) {
        validate();
        validated = true;
      }
      const tok = ctx.peek();
      if (tok !== null) {
        // Value-specific entries beat type-only entries (a branch matching the
        // literal `"null"` wins over one accepting any keyword), branches in
        // declaration order within each pass. attempt() branches roll back on
        // failure and let later branches have a go.
        for (const valueSpecific of [true, false]) {
          for (const rule of rules) {
            if (!branchMatches(rule as Rule<unknown, TT>, tok, valueSpecific)) continue;
            if (rule.backtracks) {
              const result = ctx.tryParse(rule as Rule<Out, TT>);
              if (result !== null) return result;
            } else {
              return (rule as Rule<Out, TT>).parse(ctx);
            }
          }
        }
      }
      return croakExpected(ctx, expected(contextLabels(ctx)));
    },
    first: () => rules.flatMap((rule) => rule.first()),
    expected,
    nullable: rules.some((rule) => rule.nullable),
  });
}

// attempt(rule): oneOf/optional try the branch with full backtracking instead
// of committing on its first set. Needed when branches share a prefix, e.g.
// `(a, b) => a` vs `(a + b)`.
export function attempt<T, TT extends string>(rule: Rule<T, TT>): Rule<T, TT> {
  return makeRule<T, TT>({
    parse: (ctx) => rule.parse(ctx),
    first: () => rule.first(),
    expected: (labels) => rule.expected(labels),
    nullable: rule.nullable,
    backtracks: true,
  });
}

// --- optional() ---

export function optional<T, TT extends string>(rule: Rule<T, TT>): Rule<T | null, TT>;
export function optional<T, const D, TT extends string>(rule: Rule<T, TT>, opts: { default: D }): Rule<T | D, TT>;
export function optional<T, TT extends string>(rule: Rule<T, TT>, opts?: { default: unknown }): Rule<unknown, TT> {
  const fallback = opts ? opts.default : null;
  return makeRule<unknown, TT>({
    parse: (ctx) => {
      if (!matchesFirst(ctx.peek(), rule.first())) return fallback;
      if (rule.backtracks) {
        const result = ctx.tryParse(rule);
        return result === null ? fallback : result;
      }
      return rule.parse(ctx);
    },
    first: () => rule.first(),
    expected: (labels) => rule.expected(labels),
    nullable: true,
  });
}

// --- delimited() / sepBy() ---

const matchLabel = (match: TokenMatch<string>) => match.value ?? match.type;

const eatMatch = <TT extends string>(ctx: ParseContext<TT>, match: TokenMatch<TT>, required: boolean) => {
  if (matchesToken(ctx.peek(), match)) {
    return ctx.next();
  }
  if (!required) return null;
  return croakExpected(ctx, quoteList(matchLabel(match)));
};

export function delimited<T, TT extends string>(
  open: TokenMatch<TT>,
  close: TokenMatch<TT>,
  separator: TokenMatch<TT>,
  item: Rule<T, TT>,
  opts: { interleaved?: boolean } = {},
): Rule<T[], TT> {
  const interleaved = opts.interleaved ?? false;

  return makeRule<T[], TT>({
    parse: (ctx) => {
      const items: T[] = [];
      let firstItem = true;

      // Non-interleaved bodies are separator-terminated lines: a run of
      // separators and trivia counts as one, so blank lines and comment lines
      // may appear between rows.
      const skipSoftSeparator = () => {
        ctx.skipTrivia();
        eatMatch(ctx, separator, true);
        while (true) {
          const tok = ctx.peek();
          if (tok === null) break;
          if (ctx.isTrivia(tok)) {
            ctx.next();
          } else if (matchesToken(tok, separator)) {
            ctx.next();
          } else {
            break;
          }
        }
      };

      eatMatch(ctx, open, true);
      if (!interleaved) skipSoftSeparator();
      while (!ctx.eof()) {
        if (matchesToken(ctx.peek(), close)) {
          ctx.next();
          break;
        }

        if (interleaved && !firstItem) eatMatch(ctx, separator, true);
        items.push(item.parse(ctx));
        if (!interleaved) skipSoftSeparator();

        firstItem = false;
      }

      return items;
    },
    first: () => [open],
    expected: () => quoteList(matchLabel(open)),
  });
}

// Bare separated list with no enclosing delimiters: `item (sep item)*`.
export function sepBy<T, TT extends string>(item: Rule<T, TT>, separator: TokenMatch<TT>): Rule<T[], TT> {
  return makeRule<T[], TT>({
    parse: (ctx) => {
      const items: T[] = [item.parse(ctx)];
      while (matchesToken(ctx.peek(), separator)) {
        ctx.next();
        items.push(item.parse(ctx));
      }
      return items;
    },
    first: () => item.first(),
    expected: (labels) => item.expected(labels),
  });
}

// --- repeat() ---

export function repeat<T, TT extends string>(
  rule: Rule<T, TT>,
  opts: { until?: readonly TokenMatch<TT>[] } = {},
): Rule<T[], TT> {
  const { until = [] } = opts;

  return makeRule<T[], TT>({
    parse: (ctx) => {
      const items: T[] = [];
      while (true) {
        try {
          ctx.skipTrivia();
          const tok = ctx.peek();
          if (tok === null) break;
          if (until.some((match) => matchesToken(tok, match))) break;
          if (!matchesFirst(tok, rule.first())) {
            croakExpected(ctx, rule.expected(contextLabels(ctx)));
          }
          items.push(rule.parse(ctx));
        } catch (error) {
          if (!(error instanceof ParseError)) throw error;
          const before = ctx.consumed();
          // Recovery mode records the diagnostic and resynchronizes; strict
          // mode rethrows on the first failure.
          if (!ctx.recover(error)) throw error;
          // Guarantee progress when the sync point is where we already stand.
          if (ctx.consumed() === before && !ctx.eof()) ctx.next();
        }
      }
      return items;
    },
    first: () => rule.first(),
    expected: (labels) => rule.expected(labels),
    nullable: true,
  });
}

// --- lazy() / custom() ---

export function lazy<T, TT extends string = string>(thunk: () => Rule<T, TT>): Rule<T, TT> {
  let cached: Rule<T, TT> | null = null;
  const resolve = () => (cached ??= thunk());
  return makeRule<T, TT>({
    parse: (ctx) => resolve().parse(ctx),
    first: () => resolve().first(),
    expected: (labels) => resolve().expected(labels),
  });
}

export function custom<T, TT extends string = string>(
  parse: (ctx: ParseContext<TT>) => T,
  meta: {
    expected: string;
    first: readonly FirstEntry<TT>[];
    print?: (value: T, out: Printer) => void;
  },
): Rule<T, TT> {
  return makeRule<T, TT>({
    parse,
    first: () => meta.first,
    expected: () => meta.expected,
    print: meta.print,
  });
}
