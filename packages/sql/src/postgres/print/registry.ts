// How statement families plug into the statement printer, kept apart from
// `index.ts` so a family module never imports the module that imports it.
import type { Doc, Handlers } from "@parser-kit/core/print";
import type { Stmt } from "../ast";

/** Handlers for some of the statement kinds: what a family prints. */
export type StatementHandlers = Partial<Handlers<Stmt, "kind">>;

/** One statement family: the kinds it prints, and the kinds it will print but doesn't yet. */
export interface Family<K extends Stmt["kind"], P extends readonly Stmt["kind"][]> {
  readonly name: string;
  readonly statements: Pick<Handlers<Stmt, "kind">, K>;
  readonly pending: P;
}

/**
 * Declares a statement family. Each handler's node is typed from its key, a
 * key that is no statement kind is an error, and so is a kind both printed
 * and pending. `index.ts` checks the families against each other: every kind
 * must belong to exactly one. Printing a kind means moving it from `pending`
 * to `statements`.
 */
export const defineFamily = <const K extends Stmt["kind"], const P extends readonly Exclude<Stmt["kind"], K>[]>(
  name: string,
  statements: Pick<Handlers<Stmt, "kind">, K>,
  pending: P,
): Family<K, P> => ({ name, statements, pending });

/**
 * The statement printer, for a family that prints a statement nested in
 * another (a data-modifying CTE body). `index.ts` installs it when loaded.
 */
export const statementPrinter: { print: (stmt: Stmt) => Doc } = {
  print: () => {
    throw new Error("The statement printer is not installed: import it from print/index");
  },
};
