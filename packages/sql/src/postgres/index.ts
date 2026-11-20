import { type PostgresParser, postgres as parser } from "./parser";
import { type FormatOptions, format } from "./print/format";
import {
  type StringifyInput,
  type StringifyOptions,
  type StringifyScriptInput,
  type StringifyScriptOptions,
  stringify,
  stringifyScript,
} from "./print/index";

// The `@parser-kit/sql/postgres` entry point: the PostgreSQL 17 dialect object
// and every type its results are made of, unqualified. The root entry
// (`@parser-kit/sql`) re-exports the object and namespaces the AST types
// (`Postgres.Stmt`), so dialects' same-named types never collide there; the
// subpath also keeps a bundle to one dialect once there are several. The
// object's methods can't be tree-shaken apart, so bundles that only parse
// import `@parser-kit/sql/postgres/parser` instead, which leaves the printer
// out.

export type * from "./ast";
export type { Diagnosis, PostgresParser, PostgresTokenType } from "./parser";
export type { FormatOptions } from "./print/format";
export {
  NotPrintableError,
  type StringifyInput,
  type StringifyOptions,
  type StringifyScriptInput,
  type StringifyScriptOptions,
} from "./print/index";

/**
 * The PostgreSQL dialect: parse SQL or whole psql scripts into a typed AST,
 * and print an AST back as SQL. The methods are plain functions (no `this`),
 * so they can be detached.
 */
export interface PostgresDialect extends PostgresParser {
  /**
   * Print statements (one or a list), an expression or a type as SQL. The
   * output is canonical and parses back to the same tree; comments are not
   * kept (`format` keeps them). Statements end in `;` by default, one per line.
   */
  readonly stringify: (node: StringifyInput, options?: StringifyOptions) => string;
  /**
   * Print `parseScript`'s items back as a psql script: statements ended by
   * `;`, meta-command lines, and each `COPY … FROM stdin`'s rows after it.
   */
  readonly stringifyScript: (items: StringifyScriptInput, options?: StringifyScriptOptions) => string;
  /**
   * Format a psql script, text to text: parse it as `parseScript` does and
   * print it as `stringifyScript` does, keeping its comments. Comments outside
   * statements stay where they were (on their own lines, or after a `;` on the
   * same line); comments inside a statement move to just before it. Throws the
   * first `ParseError`.
   */
  readonly format: (text: string, options?: FormatOptions) => string;
}

export const postgres: PostgresDialect = Object.freeze({ ...parser, stringify, stringifyScript, format });
