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
// Anything unknown errs towards parentheses, which never change a parse.
import type { Doc } from "./doc";

/** The parts of a Pratt group `precedence` reads. A `PrattDef`'s groups fit. */
export interface PrecedenceGroup {
  readonly bp: number;
  readonly ops?: readonly string[];
  readonly assoc?: "left" | "right" | "nonassoc";
  readonly parse?: unknown;
  readonly nodes?: readonly string[];
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
 * an `ops` infix group, or `{ prefix: op }` for an op of a prefix group (the
 * same op can be both, like `-`). Keys the table doesn't name are atoms.
 */
export type PrecedenceKey = string | { readonly prefix: string };

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
   * the main table has and the context's table lacks is always wrapped there.
   */
  contexts?: Readonly<Record<C, PrecedenceTable>>;
}

/** Which operand of `parent` a child is. `inner` children sit between tokens and are never wrapped. */
export type Side = "left" | "right" | "inner";

export interface Precedence<T, C extends string = never> {
  /** Prints `child`, an operand of `parent`, wrapped only if the parser needs it. */
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
}

interface Level {
  get(key: PrecedenceKey): Entry | null | undefined;
  /** The smallest operator bp >= x: two tails between the same pair of operator bps behave the same. */
  norm(x: number): number;
}

/** Marks a key the context's table can't build: always wrapped there. */
const FORBIDDEN = null;

const index = (table: PrecedenceTable, atoms: Readonly<Record<string, number>>) => {
  const nodes = new Map<string, Entry>();
  const prefixes = new Map<string, Entry>();
  const add = (map: Map<string, Entry>, key: string, entry: Entry) => {
    const seen = map.get(key);
    if (seen === undefined) map.set(key, entry);
    else if (seen.lbp !== entry.lbp || seen.rhs !== entry.rhs) {
      throw new Error(`precedence: two groups build "${key}" with different binding powers`);
    }
  };
  const rhsOf = (g: PrecedenceGroup) => (g.rhs === "none" ? Number.POSITIVE_INFINITY : g.rhs);
  for (const g of table.prefix ?? []) {
    const entry = { lbp: Number.POSITIVE_INFINITY, rhs: g.bp, chain: true };
    if (g.nodes) for (const k of g.nodes) add(nodes, k, entry);
    else for (const op of g.ops ?? []) add(prefixes, op, entry);
  }
  const bps: number[] = [];
  for (const g of table.infix ?? []) {
    bps.push(g.bp);
    const simple = g.ops !== undefined && g.parse === undefined;
    const entry: Entry = simple
      ? { lbp: g.bp, rhs: rhsOf(g) ?? (g.assoc === "right" ? g.bp : g.bp + 1), chain: g.assoc !== "nonassoc" }
      : { lbp: g.bp, rhs: rhsOf(g), chain: g.assoc === "left" || g.assoc === "right" };
    for (const k of g.nodes ?? (simple ? g.ops! : [])) add(nodes, k, entry);
  }
  for (const g of table.postfix ?? []) {
    bps.push(g.bp);
    for (const k of g.nodes ?? []) add(nodes, k, { lbp: g.bp, rhs: rhsOf(g), chain: true });
  }
  for (const k in atoms) add(nodes, k, { lbp: Number.POSITIVE_INFINITY, rhs: atoms[k], chain: true });
  bps.sort((a, b) => a - b);
  const get = (key: PrecedenceKey) => (typeof key === "string" ? nodes.get(key) : prefixes.get(key.prefix));
  const norm = (x: number) => bps.find((b) => b >= x) ?? Number.POSITIVE_INFINITY;
  return { get, norm };
};

const tail = (e: Entry) => e.rhs ?? Number.NEGATIVE_INFINITY;

/**
 * Derives parenthesisation from a Pratt table: the same groups (and binding
 * powers) the parser uses.
 *
 * ```ts
 * const prec = precedence(expressionTable, {
 *   key: (n) => (n.kind === "binary" ? n.op : n.kind),
 *   print: (n) => printExpr(n),
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
    levels.set(name, {
      get: (k) => own.get(k) ?? (main.get(k) === undefined ? undefined : FORBIDDEN),
      norm: own.norm,
    });
  }
  const level = (context?: C): Level => (context === undefined ? main : levels.get(context)!);

  const parens = (parent: T, child: T, side: Side, context?: C): boolean => {
    const at = level(context);
    const c = at.get(key(child));
    if (c === undefined || side === "inner") return false;
    const p = at.get(key(parent));
    // A parent the table doesn't know: wrap every operator child.
    if (!c || !p) return true;
    if (side === "left") {
      return p.lbp >= tail(c) || c.lbp < p.lbp || (c.lbp === p.lbp && !(c.chain && p.chain));
    }
    return c.lbp < (p.rhs ?? Number.POSITIVE_INFINITY) || at.norm(tail(c)) < at.norm(tail(p));
  };

  const operandParens = (node: T, minBp: number, context?: C): boolean => {
    const at = level(context);
    const c = at.get(key(node));
    if (c === undefined) return false;
    return !c || c.lbp < minBp || at.norm(tail(c)) < at.norm(minBp);
  };

  return {
    parens,
    child: (parent, child, side, context) => (parens(parent, child, side, context) ? wrap(print(child)) : print(child)),
    operand: (node, minBp = 0, context) => (operandParens(node, minBp, context) ? wrap(print(node)) : print(node)),
  };
};
