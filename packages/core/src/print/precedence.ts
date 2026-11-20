// Parenthesisation from the parser's own Pratt table. The printer asks whether a
// child must be wrapped where it sits; the answer comes from the binding powers
// the parser uses, so the two cannot drift apart.
//
// A node's entry has a left binding power (`lbp`, its operator's bp; Infinity
// for a prefix or an atom, which an enclosing operator never declines) and a
// tail (`rhs`, the bp its trailing operand is parsed at; Infinity when the node
// ends in a token of its own, undefined when unknown). Printed unwrapped:
// - as a left operand, the parent's operator must not be swallowed by the
//   child's tail (parent lbp < child rhs), and the child's own operator must
//   bind at least as tightly as the parent's (child lbp >= parent lbp);
// - as a right operand, the child's operator must be one the parent's operand
//   parse accepts (child lbp >= parent rhs), and the child's tail must stop
//   wherever the parent's does (no operator bp lies between the two tails).
// Where the table can't tell (an unknown tail, a custom parse's associativity),
// it errs towards parentheses, which never change a parse. A key the table
// doesn't name is an error, not a guess.
import type { Doc } from "./doc";

/** A first-set entry of a `match` rule, as `Rule.first()` returns it. */
interface FirstLike {
  readonly type?: string;
  readonly value?: string;
}

/** The parts of a Pratt group `precedence` reads. A `PrattDef`'s groups fit. */
export interface PrecedenceGroup {
  readonly bp: number;
  readonly ops?: readonly string[];
  readonly type?: string;
  readonly match?: { first(): readonly FirstLike[] };
  readonly assoc?: "left" | "right" | "nonassoc";
  readonly parse?: unknown;
  readonly nodes?: readonly string[] | Readonly<Record<string, number | "none">>;
  readonly rhs?: number | "none";
}

/** A Pratt table, or the operator part of a `PrattDef`. */
export interface PrecedenceTable {
  readonly prefix?: readonly PrecedenceGroup[];
  readonly infix?: readonly PrecedenceGroup[];
  readonly postfix?: readonly PrecedenceGroup[];
}

/**
 * What a node is called in the table: a key from some group's `nodes`, an op of
 * an `ops` infix group, `{ prefix: op }` for an op of a prefix group (the same
 * op can be both, like `-`), a key of the `atoms` option, or `null` for an atom
 * (a node that starts and ends with tokens of its own). Any other key throws.
 */
export type PrecedenceKey = string | { readonly prefix: string } | null;

export interface PrecedenceOptions<T, C extends string> {
  /** Names a node's table entry. */
  key: (node: T) => PrecedenceKey;
  /** Prints a child; `child` and `operand` wrap its doc when needed. */
  print: (node: T) => Doc;
  /** Wraps a doc in parentheses. Default `["(", doc, ")"]`. */
  wrap?: (doc: Doc) => Doc;
  /**
   * Nodes the atom rule builds that end in an operand rather than a token, with
   * the bp that operand is parsed at: `{ arrow: 0 }` for an arrow function whose
   * body is a full expression.
   */
  atoms?: Readonly<Record<string, number>>;
  /**
   * Restricted operator sets, by name, for positions the grammar parses with a
   * cut-down table (PG's `b_expr`). Pass the name as `context`: a node whose key
   * the main table has and the context's table lacks is wrapped there.
   */
  contexts?: Readonly<Record<C, PrecedenceTable>>;
}

/**
 * Which operand of `parent` a child is. `inner` children sit between tokens of
 * the parent and are never wrapped: use it only when the token after the child
 * can't continue an expression (a `)`, a `:`), and `right` otherwise.
 */
export type Side = "left" | "right" | "inner";

export interface Precedence<T, C extends string = never> {
  /**
   * Prints `child`, an operand of `parent`, wrapped only if the parser needs
   * it. A context applies to everything printed inside the child too, until a
   * pair of parentheses restores the full table.
   */
  child(parent: T, child: T, side: Side, context?: C): Doc;
  /** Prints `node` where the grammar parses an operand at `minBp` (default 0, a whole expression). */
  operand(node: T, minBp?: number, context?: C): Doc;
  /** Whether `child` needs wrapping as that operand of `parent`. */
  parens(parent: T, child: T, side: Side, context?: C): boolean;
}

interface Entry {
  lbp: number;
  rhs: number | undefined;
  /** False for a group that may reject a chain of itself (nonassoc, or a custom parse with no `assoc`). */
  chain: boolean;
  /** For a postfix: the highest bp of an infix group its token also starts, which takes it where the postfix declines. */
  steal: number;
}

interface Level {
  get(key: PrecedenceKey): Entry | null;
  /** The smallest operator bp >= x: two tails between the same pair of operator bps behave the same. */
  norm(x: number): number;
}

const INF = Number.POSITIVE_INFINITY;

/** Whether two first-set entries can match the same token. */
const overlap = (a: FirstLike, b: FirstLike) =>
  (a.value === undefined || b.value === undefined || a.value === b.value) &&
  (a.type === undefined || b.type === undefined || a.type === b.type);

const firstOf = (g: PrecedenceGroup): readonly FirstLike[] =>
  g.match ? g.match.first() : (g.ops ?? []).map((value) => ({ type: g.type, value }));

const index = (table: PrecedenceTable, atoms: Readonly<Record<string, number>>) => {
  const nodes = new Map<string, Entry>();
  const prefixes = new Map<string, Entry>();
  const add = (map: Map<string, Entry>, key: string, entry: Entry) => {
    const seen = map.get(key);
    if (seen === undefined) map.set(key, entry);
    else if (seen.lbp !== entry.lbp || seen.rhs !== entry.rhs || seen.chain !== entry.chain) {
      throw new Error(`precedence: two groups build "${key}" with different binding powers`);
    }
  };
  const tailOf = (r: number | "none" | undefined) => (r === "none" ? INF : r);
  // Each key of `nodes` with its own tail, or the group's.
  const named = (g: PrecedenceGroup, entry: Entry, keys = g.nodes) => {
    if (Array.isArray(keys)) for (const k of keys) add(nodes, k, entry);
    else for (const k in keys) add(nodes, k, { ...entry, rhs: tailOf((keys as Record<string, number | "none">)[k]) });
  };
  for (const g of table.prefix ?? []) {
    const entry = { lbp: INF, rhs: g.bp, chain: true, steal: -INF };
    if (g.nodes) named(g, entry);
    else for (const op of g.ops ?? []) add(prefixes, op, entry);
  }
  const bps: number[] = [];
  const infix = table.infix ?? [];
  for (const g of infix) {
    bps.push(g.bp);
    const simple = g.ops !== undefined && g.parse === undefined;
    // A plain `ops` group's tail is what the parser does, whatever `rhs` says.
    const entry: Entry = simple
      ? { lbp: g.bp, rhs: g.assoc === "right" ? g.bp : g.bp + 1, chain: g.assoc !== "nonassoc", steal: -INF }
      : { lbp: g.bp, rhs: tailOf(g.rhs), chain: g.assoc === "left" || g.assoc === "right", steal: -INF };
    named(g, entry, g.nodes ?? (simple ? g.ops : []));
  }
  for (const g of table.postfix ?? []) {
    bps.push(g.bp);
    const own = firstOf(g);
    let steal = -INF;
    for (const i of infix) if (firstOf(i).some((e) => own.some((o) => overlap(e, o)))) steal = Math.max(steal, i.bp);
    named(g, { lbp: g.bp, rhs: tailOf(g.rhs), chain: true, steal });
  }
  for (const k in atoms) add(nodes, k, { lbp: INF, rhs: atoms[k], chain: true, steal: -INF });
  bps.sort((a, b) => a - b);
  return {
    has: (key: PrecedenceKey) => key === null || (typeof key === "string" ? nodes.has(key) : prefixes.has(key.prefix)),
    get: (key: PrecedenceKey) =>
      key === null ? null : ((typeof key === "string" ? nodes.get(key) : prefixes.get(key.prefix)) ?? null),
    norm: (x: number) => bps.find((b) => b >= x) ?? INF,
  };
};

const tail = (e: Entry) => e.rhs ?? -INF;
/** An entry that binds nothing and is bound by nothing: a node the context's table can't build. */
const FORBIDDEN: Entry = { lbp: -INF, rhs: undefined, chain: false, steal: INF };

/**
 * Derives parenthesisation from a Pratt table: the same groups (and binding
 * powers) the parser uses.
 *
 * ```ts
 * const prec = precedence(expressionTable, {
 *   key: (n) => (n.kind === "binary" ? n.op : n.kind === "number" ? null : n.kind),
 *   print: (n): Doc => printExpr(n),
 * });
 * prec.child(node, node.left, "left"); // the left operand, in parens only if needed
 * ```
 */
export const precedence = <T, C extends string = never>(
  table: PrecedenceTable,
  options: PrecedenceOptions<T, C>,
): Precedence<T, C> => {
  const { key, print, wrap = (d: Doc): Doc => ["(", d, ")"], atoms = {} } = options;
  const main = index(table, atoms);
  const levels = new Map<string, Level>();
  for (const name in options.contexts) {
    const own = index(options.contexts[name], atoms);
    levels.set(name, { get: (k) => (own.has(k) ? own.get(k) : FORBIDDEN), norm: own.norm });
  }
  const entry = (node: T, at: Level): Entry | null => {
    const k = key(node);
    if (!main.has(k)) {
      throw new Error(`precedence: no group builds ${JSON.stringify(k)}; name it in "nodes", or key atoms null`);
    }
    return at.get(k);
  };

  // The context of the operand being printed: set by `child` / `operand`,
  // inherited by calls inside it that name none, reset by parentheses.
  let current: C | undefined;
  const level = (context?: C): Level => {
    const name = context ?? current;
    return name === undefined ? main : levels.get(name)!;
  };

  const parens = (parent: T, child: T, side: Side, context?: C): boolean => {
    const at = level(context);
    const c = entry(child, at);
    const p = entry(parent, at);
    if (c === null || side === "inner") return false;
    if (p === null) return true;
    if (side === "left") {
      return Math.max(p.lbp, p.steal) >= tail(c) || c.lbp < p.lbp || (c.lbp === p.lbp && !(c.chain && p.chain));
    }
    return c.lbp < (p.rhs ?? INF) || at.norm(tail(c)) < at.norm(tail(p));
  };

  const operandParens = (node: T, minBp: number, context?: C): boolean => {
    const at = level(context);
    const c = entry(node, at);
    return c !== null && (c.lbp < minBp || at.norm(tail(c)) < at.norm(minBp));
  };

  const emit = (node: T, wrapped: boolean, context?: C): Doc => {
    const outer = current;
    current = wrapped ? undefined : (context ?? current);
    try {
      const d = print(node);
      return wrapped ? wrap(d) : d;
    } finally {
      current = outer;
    }
  };

  return {
    parens,
    child: (parent, child, side, context) => emit(child, parens(parent, child, side, context), context),
    operand: (node, minBp = 0, context) => emit(node, operandParens(node, minBp, context), context),
  };
};
