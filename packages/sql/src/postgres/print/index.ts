// The PostgreSQL printer: AST back to SQL text. The shared pieces are
// `context.ts` (options, keywords, names, strings), `expr.ts` and `types.ts`;
// each statement family has a module of its own (`query.ts`, `dml.ts`,
// `tables.ts`, `objects.ts`, `roles.ts`), joined here into one statement
// printer.
//
// Internal for now: `stringify` is not on the `postgres` object yet.
//
// A family module declares, with `defineFamily`, the statement kinds it prints
// and the ones it doesn't print yet, which throw NotPrintableError. Printing a
// kind means adding its handler there and dropping it from the pending list,
// with its round-trip cases in `test/stringify-cases/<family>.ts`; shared
// helpers (`context.ts`, `expr.ts`) and the grammar's printer-only Pratt
// annotations are touched only when a family needs something new from them.
// The compiler holds the families to the `Stmt` union: a kind no family names
// is a missing handler here, a kind two families name is an error here, and
// one a family both prints and lists as pending is an error in that family.
//
// The printers recurse mostly through module-level functions (`expr`,
// `printQuery`, `printStatement`) rather than each handler's `print` argument,
// so a printer built from them with `extendPrinter` would apply its overrides
// at the top level only.
import {
  type Doc,
  definePrinter,
  type Handlers,
  type NodePrinter,
  type Printable,
  render,
} from "@parser-kit/core/print";
import type { ColType, Expr, Stmt } from "../ast";
import { NotPrintableError, type StringifyOptions, withOptions } from "./context";
import { dmlFamily } from "./dml";
import { expr } from "./expr";
import { flat } from "./flat";
import { objectsFamily } from "./objects";
import { queryFamily } from "./query";
import { type Family, statementPrinter } from "./registry";
import { rolesFamily } from "./roles";
import { tablesFamily } from "./tables";
import { typeName } from "./types";

export { NotPrintableError, type StringifyOptions } from "./context";

const notYet = (node: Stmt): Doc => {
  throw new NotPrintableError(node.kind);
};
/** A family's handlers, its pending kinds throwing NotPrintableError. */
const handlersOf = <K extends Stmt["kind"], P extends readonly Stmt["kind"][]>(
  family: Family<K, P>,
): Pick<Handlers<Stmt, "kind">, K> & Record<P[number], typeof notYet> => ({
  ...(Object.fromEntries(family.pending.map((kind) => [kind, notYet])) as Record<P[number], typeof notYet>),
  ...family.statements,
});

/** Every statement family, for the tests. A new family goes here and in `printStatement` below. */
export const FAMILIES = [queryFamily, dmlFamily, tablesFamily, objectsFamily, rolesFamily] as const;

// Every kind belongs to exactly one family. Named by two (printed or pending
// in each), the later spread below would silently win: a compile error here,
// naming the kinds, and a load-time error for anything the types can't see.
type KindsOf<F> = F extends Family<infer K, infer P> ? K | P[number] : never;
type Shared<T extends readonly unknown[], Seen = never> = T extends readonly [infer H, ...infer R]
  ? (KindsOf<H> & Seen) | Shared<R, Seen | KindsOf<H>>
  : never;
const exclusive: [Shared<typeof FAMILIES>] extends [never] ? true : Shared<typeof FAMILIES> = true;
void exclusive;
{
  const owner = new Map<string, string>();
  for (const family of FAMILIES) {
    for (const kind of [...Object.keys(family.statements), ...family.pending]) {
      const seen = owner.get(kind);
      if (seen !== undefined)
        throw new Error(`Statement kind "${kind}" is in both the ${seen} and ${family.name} families`);
      owner.set(kind, family.name);
    }
  }
}

// `stringify` tells a statement from an expression by its kind, so no
// expression kind may also be a statement kind.
const distinctKinds: [Extract<Expr["kind"], Stmt["kind"]>] extends [never] ? true : never = true;
void distinctKinds;

/** A statement, without its `;`. A kind no family names is a compile error here. */
export const printStatement: NodePrinter<Stmt, "kind"> = definePrinter<Stmt>()("kind", {
  ...handlersOf(queryFamily),
  ...handlersOf(dmlFamily),
  ...handlersOf(tablesFamily),
  ...handlersOf(objectsFamily),
  ...handlersOf(rolesFamily),
});

statementPrinter.print = printStatement;

// What tells a statement from an expression in `stringify`'s input.
const STATEMENT_KINDS: ReadonlySet<string> = new Set(Object.keys(printStatement.handlers));

/** What `stringify` takes: statements, one statement, an expression or a type. */
export type StringifyInput = Printable<Stmt> | readonly Printable<Stmt>[] | Printable<Expr> | Printable<ColType>;

/**
 * Prints an AST as PostgreSQL. Statements (one or a list) end in `;` by
 * default, one per line; an expression or a type prints alone. The output is
 * canonical: keyword case, quoting, spacing and parentheses come from the
 * options and the tree, never from the source it was parsed from, and comments
 * are not kept.
 */
export const stringify = (node: StringifyInput, options?: StringifyOptions): string =>
  withOptions(options, () => {
    const width = options?.width ?? Number.POSITIVE_INFINITY;
    const indent = options?.indent ?? 2;
    const layout = (doc: Doc): string =>
      (width === Number.POSITIVE_INFINITY ? flat(doc) : null) ?? render(doc, { width, indent });
    if (typeof node !== "object" || node === null || !("kind" in node || Array.isArray(node))) {
      return layout(typeName(node as ColType));
    }
    if (!Array.isArray(node) && !STATEMENT_KINDS.has((node as { kind: string }).kind)) {
      return layout(expr(node as Expr));
    }
    // Each statement is laid out on its own, from the start of a line.
    const stmts = (Array.isArray(node) ? node : [node]) as readonly Stmt[];
    const semicolons = options?.semicolons ?? "always";
    return stmts
      .map((stmt, i) =>
        layout(
          semicolons === "always" || (semicolons === "between" && i < stmts.length - 1)
            ? [printStatement(stmt), ";"]
            : printStatement(stmt),
        ),
      )
      .join("\n");
  });
