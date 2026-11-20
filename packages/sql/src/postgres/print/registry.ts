// How statement families plug into the statement printer, kept apart from
// `index.ts` so a family module never imports the module that imports it.
import type { Doc, Handlers } from "@parser-kit/core/print";
import type { Stmt } from "../ast";
import { NotPrintableError } from "./context";

/** Handlers for some of the statement kinds: what a family prints. */
export type StatementHandlers = Partial<Handlers<Stmt, "kind">>;

/** One statement family: the kinds it prints, and the kinds it will print but doesn't yet. */
export interface Family<S extends StatementHandlers, P extends readonly Stmt["kind"][]> {
  readonly name: string;
  readonly statements: S;
  readonly pending: P;
}

/**
 * Declares a statement family. A kind both printed and listed as pending is a
 * compile error; `index.ts` makes one missing from every family an error too.
 * Printing a kind means moving it from `pending` to `statements`.
 */
export const defineFamily = <S extends StatementHandlers, const P extends readonly Stmt["kind"][]>(
  name: string,
  statements: S & { readonly [K in P[number]]?: never },
  pending: P,
): Family<S, P> => ({ name, statements, pending });

/**
 * The statement printer, for a family that prints a statement nested in
 * another (a data-modifying CTE body). `index.ts` installs the real one; until
 * it is loaded, every statement reads as not yet printable.
 */
export const statementPrinter: { print: (stmt: Stmt) => Doc } = {
  print: (stmt) => {
    throw new NotPrintableError(stmt.kind);
  },
};
