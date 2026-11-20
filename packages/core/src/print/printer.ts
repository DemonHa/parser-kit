// Typed, exhaustive dispatch over one discriminated union. A printer is a table
// of handlers keyed by the union's discriminant (`kind`, `type`, …): the type
// requires one handler per variant, so a node added to the grammar's AST
// breaks the printer's build until it is handled. One printer per union:
// discriminant values repeat across unions (an expression and a FROM item can
// both be `kind: "subquery"`), so printers compose by calling each other rather
// than sharing one table.
import type { Doc } from "./doc";

/** The variant of union `T` whose discriminant `K` is `V`. */
type Variant<T, K extends keyof T, V> = T extends unknown ? (V extends T[K] ? T : never) : never;

/**
 * One handler per variant of `T`, keyed by its discriminant `K`. Each gets the
 * narrowed node and the printer it runs in, for recursion: call `print(child)`
 * rather than the printer's own name, so a printer built by `extendPrinter`
 * uses its overrides all the way down.
 */
export type Handlers<T, K extends keyof T> = {
  readonly [V in T[K] & PropertyKey]: (node: Variant<T, K, V>, print: NodePrinter<T, K>) => Doc;
};

/** A printer for union `T`: call it with a node. */
export interface NodePrinter<T, K extends keyof T> {
  (node: T): Doc;
  /** The discriminant it dispatches on. */
  readonly key: K;
  /** Its handlers, for `extendPrinter` and for spreading into a wider printer. */
  readonly handlers: Handlers<T, K>;
}

/**
 * `T` with every `span` property optional, all the way down, so a printer
 * accepts hand-built nodes as well as parsed ones. A printer never reads spans.
 */
export type Printable<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly unknown[]
    ? { [I in keyof T]: Printable<T[I]> }
    : T extends object
      ? { [P in keyof T as P extends "span" ? never : P]: Printable<T[P]> } & {
          [P in keyof T as P extends "span" ? P : never]?: T[P];
        }
      : T;

const build = <T, K extends keyof T>(key: K, handlers: Handlers<T, K>): NodePrinter<T, K> => {
  const table = handlers as unknown as Record<PropertyKey, ((node: T, print: NodePrinter<T, K>) => Doc) | undefined>;
  const print = ((node: T): Doc => {
    const tag = node[key] as PropertyKey;
    const handler = table[tag];
    if (handler === undefined) throw new TypeError(`No printer for ${String(key)} "${String(tag)}"`);
    return handler(node, print);
  }) as NodePrinter<T, K>;
  return Object.assign(print, { key, handlers });
};

/**
 * Builds a printer for the discriminated union `T`. Curried so `T` can be given
 * while the key and handlers are inferred:
 *
 * ```ts
 * const printExpr = definePrinter<Expr>()("kind", {
 *   number: (n) => String(n.value),
 *   binary: (n, print) => [print(n.left), " ", n.op, " ", print(n.right)],
 *   // leaving a kind out is a compile error
 * });
 * ```
 */
export const definePrinter =
  <T>() =>
  <K extends keyof T>(key: K, handlers: Handlers<T, K>): NodePrinter<T, K> =>
    build(key, handlers);

/**
 * A printer that reuses `base` and replaces some of its handlers, e.g. a
 * dialect that prints a few nodes differently. Handlers recurse through the
 * `print` they are given, so the overrides apply to nested nodes too.
 */
export const extendPrinter = <T, K extends keyof T>(
  base: NodePrinter<T, K>,
  overrides: Partial<Handlers<T, K>>,
): NodePrinter<T, K> => build(base.key, { ...base.handlers, ...overrides } as Handlers<T, K>);
