// `@parser-kit/core/print/testing`: a test helper that finds what a printer drops. Exhaustive dispatch proves
// every variant has a handler, not that every handler prints every field: a
// table printer can handle `table` and still never read its `note`. Wrap each
// parsed tree with `track`, print the wrapped tree, and `report` lists the
// variants never printed and the fields present on some node yet never read.
// A separate entry point, so it never weighs on a printer's bundle.

export interface CoverageOptions {
  /** The discriminant that names a node's variant, e.g. `"kind"` or `"type"`. */
  key: string;
  /** Every variant the printer should handle. Listed ones never printed are reported even if the corpus lacks them. */
  kinds?: readonly string[];
  /** Fields never worth reading. Default `["span"]`. */
  ignore?: readonly string[];
}

export interface CoverageReport {
  /** Variants never printed: their discriminant was never read. */
  kinds: string[];
  /**
   * Fields present on some node and never read, as `variant.field`. A record
   * without a discriminant is named by where it sits (`select.items.alias`).
   */
  fields: string[];
}

export interface FieldCoverage {
  /** Returns a view of `tree` that records which fields are read. Print the view, not the tree. */
  track<T>(tree: T): T;
  /** What the printer never read across every tree tracked so far. */
  report(): CoverageReport;
}

const isTracked = (v: unknown): v is object =>
  typeof v === "object" &&
  v !== null &&
  (Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/**
 * Builds a field-coverage recorder.
 *
 * ```ts
 * const coverage = fieldCoverage({ key: "kind" });
 * for (const source of corpus) print(coverage.track(parse(source)));
 * expect(coverage.report()).toEqual({ kinds: [], fields: [] });
 * ```
 */
export const fieldCoverage = (options: CoverageOptions): FieldCoverage => {
  const { key } = options;
  const ignore = new Set(options.ignore ?? ["span"]);
  const seen = new Set<string>();
  const read = new Set<string>();
  const kinds = new Set(options.kinds);
  const printed = new Set<string>();
  const views = new WeakMap<object, object>();

  const view = (target: object, label: string): object => {
    const cached = views.get(target);
    if (cached) return cached;
    let name = label;
    if (!Array.isArray(target)) {
      const tag = (target as Record<string, unknown>)[key];
      if (typeof tag === "string") {
        name = tag;
        kinds.add(tag);
      }
      for (const field of Object.keys(target)) {
        if (field !== key && !ignore.has(field)) seen.add(`${name}.${field}`);
      }
    }
    const proxy = new Proxy(target, {
      get(t, prop, receiver) {
        const value = Reflect.get(t, prop, receiver);
        if (typeof prop !== "string" || !Object.hasOwn(t, prop)) return value;
        let inner = name;
        if (!Array.isArray(t)) {
          if (prop === key) printed.add(name);
          else read.add(`${name}.${prop}`);
          inner = `${name}.${prop}`;
        }
        // A frozen property must read back as itself (a proxy invariant).
        const own = Object.getOwnPropertyDescriptor(t, prop)!;
        return isTracked(value) && (own.configurable || own.writable) ? view(value, inner) : value;
      },
    });
    views.set(target, proxy);
    return proxy;
  };

  return {
    track: (tree) => (isTracked(tree) ? (view(tree, "(root)") as typeof tree) : tree),
    report: () => ({
      kinds: [...kinds].filter((k) => !printed.has(k)).sort(),
      fields: [...seen].filter((f) => !read.has(f)).sort(),
    }),
  };
};
