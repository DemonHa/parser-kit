// The PostgreSQL printer: AST back to SQL text. The shared pieces are
// `context.ts` (options, keywords, names, strings), `expr.ts` and `types.ts`;
// each statement family has a module of its own (`query.ts`, `dml.ts`,
// `tables.ts`, `objects.ts`, `roles.ts`), joined here into one statement
// printer.
//
// `stringify` and `stringifyScript` are public as the `postgres` object's
// methods (`../index.ts`); the rest of this directory is internal.
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
import type { ColType, Copy, Expr, PsqlMeta, ScriptItem, Stmt } from "../ast";
import { inRoutineStatement, NotPrintableError, type StringifyOptions, withOptions } from "./context";
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

const families = {
  ...handlersOf(queryFamily),
  ...handlersOf(dmlFamily),
  ...handlersOf(tablesFamily),
  ...handlersOf(objectsFamily),
  ...handlersOf(rolesFamily),
};

/** A statement, without its `;`. A kind no family names is a compile error here. */
export const printStatement: NodePrinter<Stmt, "kind"> = definePrinter<Stmt>()("kind", {
  ...families,
  // psql reads these statements by a heuristic of their own (`inRoutineStatement`).
  createFunction: (n, print) => inRoutineStatement(() => families.createFunction(n, print)),
  createProcedure: (n, print) => inRoutineStatement(() => families.createProcedure(n, print)),
});

statementPrinter.print = printStatement;

// What tells a statement from an expression in `stringify`'s input.
const STATEMENT_KINDS: ReadonlySet<string> = new Set(Object.keys(printStatement.handlers));

/** What `stringify` takes: statements, one statement, an expression or a type. */
export type StringifyInput = Printable<Stmt> | readonly Printable<Stmt>[] | Printable<Expr> | Printable<ColType>;

/** What `stringifyScript` takes: `parseScript`'s items, statements and psql meta-commands. */
export type StringifyScriptInput = readonly Printable<ScriptItem>[];

/**
 * `stringifyScript`'s options: `stringify`'s, less `semicolons`. Every
 * statement in a script ends in `;`, since psql would otherwise run the next
 * line into it.
 */
export type StringifyScriptOptions = Omit<StringifyOptions, "semicolons">;

/** Lays a doc out for the call's width: one line through `flat`, else `render`. */
const layoutFor = (options: StringifyOptions | undefined): ((doc: Doc) => string) => {
  const width = options?.width ?? Number.POSITIVE_INFINITY;
  const indent = options?.indent ?? 2;
  return (doc) => (width === Number.POSITIVE_INFINITY ? flat(doc) : null) ?? render(doc, { width, indent });
};

/**
 * Prints an AST as PostgreSQL. Statements (one or a list) end in `;` by
 * default, one per line; an expression or a type prints alone. The output is
 * canonical: keyword case, quoting, spacing and parentheses come from the
 * options and the tree, never from the source it was parsed from, and comments
 * are not kept.
 */
export const stringify = (node: StringifyInput, options?: StringifyOptions): string =>
  withOptions(options, () => {
    const layout = layoutFor(options);
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

const isCopyIn = (stmt: Printable<Copy>): boolean => stmt.direction === "from" && stmt.location.kind === "stdin";

// A COPY's rows: verbatim lines, then the `\.` line that ends them (psql
// splits them at `\n` alone). A row that is itself `\.` would end them
// early, and rows after anything but `COPY … FROM STDIN` would be read as SQL,
// so neither can be printed.
const copyData = (stmt: Printable<Copy>, data: string): string => {
  if (!isCopyIn(stmt)) throw new TypeError("COPY data can only follow a COPY … FROM STDIN");
  const rows = data === "" || data.endsWith("\n") ? data : `${data}\n`;
  if (rows.split("\n").some((row) => row === "\\." || row === "\\.\r")) {
    throw new TypeError('COPY data holds a "\\." line, which would end it early');
  }
  return `${rows}\\.`;
};

// A meta-command line: psql reads its name up to whitespace or a backslash,
// and its arguments to the end of the line.
const psqlMeta = (meta: Printable<PsqlMeta>): string => {
  if (!/^[^\s\\]+$/.test(meta.command)) {
    throw new TypeError(`A psql meta-command needs a name with no whitespace or backslash, not "${meta.command}"`);
  }
  if (meta.args.includes("\n")) throw new TypeError("A psql meta-command must fit on one line");
  return meta.args === "" ? `\\${meta.command}` : `\\${meta.command} ${meta.args}`;
};

/**
 * Prints `parseScript`'s items back as a psql script: each statement laid out
 * as `stringify` lays it out and ended by `;`, each meta-command on a line of
 * its own, and a COPY's rows (`Copy.data`) after it, ended by a `\.` line. A
 * `COPY … FROM STDIN` with no `data` gets an empty block, as psql reads rows
 * after every one.
 */
export const stringifyScript = (items: StringifyScriptInput, options?: StringifyScriptOptions): string =>
  withOptions(options, () => {
    const layout = layoutFor(options);
    return items
      .map((item) => {
        if (item.kind === "psqlMeta") return psqlMeta(item);
        const text = layout([printStatement(item as Stmt), ";"]);
        // psql reads rows after every COPY … FROM STDIN, so one without
        // `data` (from `parse`, or last in a script) gets an empty block.
        if (item.kind !== "copy" || (item.data === undefined && !isCopyIn(item))) return text;
        return `${text}\n${copyData(item, item.data ?? "")}`;
      })
      .join("\n");
  });
