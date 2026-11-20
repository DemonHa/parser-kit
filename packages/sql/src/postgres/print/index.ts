// The PostgreSQL printer: AST back to SQL text. One module per statement
// family (`query.ts` for SELECT / VALUES / TABLE and set operations, and the
// shared `expr.ts` and `types.ts`), joined here into one statement printer.
//
// Internal for now: `stringify` is not on the `postgres` object yet.
//
// Adding a statement family: write its printer module exporting a handler
// table (`export const dmlStatements = { insert: …, update: … } satisfies
// StatementHandlers;`), spread it into FAMILIES below, and take its kinds out
// of NOT_YET_PRINTABLE. The compiler holds the two lists to the `Stmt` union:
// a kind in neither is a missing handler, a kind in both a duplicate, and
// either fails the build.
import {
  type Doc,
  definePrinter,
  type Handlers,
  hardline,
  join,
  type NodePrinter,
  type Printable,
  render,
} from "@parser-kit/core/print";
import type { ColType, Expr, Stmt } from "../ast";
import { NotPrintableError, type StringifyOptions, statementPrinter, withOptions } from "./context";
import { expr } from "./expr";
import { flat } from "./flat";
import { queryStatements } from "./query";
import { typeName } from "./types";

export { NotPrintableError, type StringifyOptions } from "./context";

/** Handlers for some of the statement kinds: what a family module exports. */
export type StatementHandlers = Partial<Handlers<Stmt, "kind">>;

const FAMILIES = {
  ...queryStatements,
} satisfies StatementHandlers;

// Every statement kind no family prints yet. Each throws NotPrintableError.
const NOT_YET_PRINTABLE = [
  "createTable",
  "createIndex",
  "createType",
  "createView",
  "createSequence",
  "createDomain",
  "createDatabase",
  "createSchema",
  "createExtension",
  "createTablespace",
  "createRole",
  "createPolicy",
  "createPublication",
  "createSubscription",
  "createForeignDataWrapper",
  "createServer",
  "createUserMapping",
  "createForeignTable",
  "importForeignSchema",
  "createTableAs",
  "createFunction",
  "createProcedure",
  "createAggregate",
  "createTrigger",
  "createCast",
  "createCollation",
  "createConversion",
  "createStatistics",
  "createEventTrigger",
  "createLanguage",
  "createAccessMethod",
  "createTextSearch",
  "createOperator",
  "createOperatorClass",
  "createOperatorFamily",
  "refreshMaterializedView",
  "alterTable",
  "alterForeignDataWrapper",
  "alterServer",
  "alterUserMapping",
  "dropUserMapping",
  "alterSchema",
  "alterDomain",
  "alterType",
  "alterIndex",
  "alterAllInTablespace",
  "alterFunction",
  "alterAggregate",
  "alterView",
  "alterSequence",
  "alterExtension",
  "alterRole",
  "alterDatabase",
  "alterTablespace",
  "alterPolicy",
  "alterPublication",
  "alterSubscription",
  "alterObject",
  "drop",
  "truncate",
  "comment",
  "securityLabel",
  "grant",
  "revoke",
  "alterDefaultPrivileges",
  "dropOwned",
  "reassignOwned",
  "begin",
  "commit",
  "rollback",
  "savepoint",
  "releaseSavepoint",
  "prepareTransaction",
  "commitPrepared",
  "rollbackPrepared",
  "set",
  "setTransaction",
  "setConstraints",
  "show",
  "reset",
  "do",
  "deallocate",
  "prepare",
  "execute",
  "explain",
  "analyze",
  "vacuum",
  "cluster",
  "reindex",
  "checkpoint",
  "load",
  "discard",
  "listen",
  "notify",
  "unlisten",
  "lock",
  "callProcedure",
  "declare",
  "fetch",
  "move",
  "close",
  "copy",
  "insert",
  "update",
  "delete",
  "merge",
] as const satisfies readonly Stmt["kind"][];

type NotYetPrintable = (typeof NOT_YET_PRINTABLE)[number];

// A kind listed both as printable and as not yet printable fails here, naming it.
const noDuplicates: [Extract<keyof typeof FAMILIES, NotYetPrintable>] extends [never]
  ? true
  : Extract<keyof typeof FAMILIES, NotYetPrintable> = true;
void noDuplicates;

const notYet = (node: Stmt): Doc => {
  throw new NotPrintableError(node.kind);
};
const pending = Object.fromEntries(NOT_YET_PRINTABLE.map((kind) => [kind, notYet])) as Record<
  NotYetPrintable,
  typeof notYet
>;

/** A statement, without its `;`. A kind missing from both lists above is a compile error here. */
export const printStatement: NodePrinter<Stmt, "kind"> = definePrinter<Stmt>()("kind", { ...pending, ...FAMILIES });

statementPrinter.print = printStatement;

/** The kinds the statement printer handles, printable or not: what tells a statement from an expression. */
export const STATEMENT_KINDS: ReadonlySet<string> = new Set(Object.keys(printStatement.handlers));

/** What `stringify` takes: statements, one statement, an expression or a type. */
export type StringifyInput = Printable<Stmt> | readonly Printable<Stmt>[] | Printable<Expr> | Printable<ColType>;

const statements = (stmts: readonly Stmt[], semicolons: StringifyOptions["semicolons"]): Doc => {
  const docs = stmts.map(printStatement);
  if (semicolons === "never") return join(hardline, docs);
  if (semicolons === "between") return join([";", hardline], docs);
  return join(
    hardline,
    docs.map((d) => [d, ";"]),
  );
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
    let doc: Doc;
    if (Array.isArray(node)) {
      doc = statements(node as readonly Stmt[], options?.semicolons);
    } else if (typeof node === "object" && node !== null && "kind" in node) {
      if (STATEMENT_KINDS.has(node.kind)) {
        const stmt = printStatement(node as Stmt);
        doc = options?.semicolons === undefined || options.semicolons === "always" ? [stmt, ";"] : stmt;
      } else {
        doc = expr(node as Expr);
      }
    } else {
      doc = typeName(node as ColType);
    }
    const width = options?.width ?? Number.POSITIVE_INFINITY;
    return (
      (width === Number.POSITIVE_INFINITY ? flat(doc) : null) ?? render(doc, { width, indent: options?.indent ?? 2 })
    );
  });
