import type { Lexer, ParseError } from "@parser-kit/core";
import { postgresGrammar, postgresScriptGrammar, type ScriptItem, type Stmt } from "./grammar";
import { type SqlTokenType, sqlLexer, sqlScriptLexer } from "./lexer";

// The `@parser-kit/sql/postgres` entry point: the PostgreSQL 17 dialect object
// and every type its results are made of. The root entry (`@parser-kit/sql`)
// re-exports all of this; the subpath keeps a bundle that wants one dialect
// from pulling in the others once there are several.

export type * from "./grammar";

/** The token types the PostgreSQL lexers produce. */
export type PostgresTokenType = SqlTokenType;

/** A recovering parse: the partial AST and every error collected on the way. */
export type PostgresDiagnosis<T> = { ast: T; errors: ParseError[] };

/** The PostgreSQL dialect: parse SQL or whole psql scripts into a typed AST. */
export interface PostgresDialect {
  /** Parse SQL as the server receives it. Throws the first `ParseError`. */
  parse(sql: string): Stmt[];
  /** Parse SQL as the server receives it, recovering at each `;`. */
  diagnose(sql: string): PostgresDiagnosis<Stmt[]>;
  /**
   * Parse a whole psql script, pg_dump output included: statements, `\`
   * meta-command lines (`psqlMeta` items) and `COPY … FROM stdin` rows
   * (`Copy.data`). Throws the first `ParseError`.
   */
  parseScript(text: string): ScriptItem[];
  /** `parseScript`, recovering at each `;` and at each meta-command line. */
  diagnoseScript(text: string): PostgresDiagnosis<ScriptItem[]>;
  /**
   * Tokenizes SQL, comments included (`comment` tokens), for highlighters and
   * formatters. The parser reads the same tokens with the comments dropped.
   */
  readonly lexer: Lexer<PostgresTokenType>;
  /** `lexer` plus psql meta-command lines (`psqlmeta` tokens). COPY rows lex as SQL. */
  readonly scriptLexer: Lexer<PostgresTokenType>;
}

// The methods are arrow functions over the grammars, so they work detached
// (`const { parse } = postgres`, `items.map(postgres.parse)`).
export const postgres: PostgresDialect = Object.freeze({
  parse: (sql: string) => postgresGrammar.parse(sql),
  diagnose: (sql: string) => postgresGrammar.diagnose(sql),
  parseScript: (text: string) => postgresScriptGrammar.parse(text),
  diagnoseScript: (text: string) => postgresScriptGrammar.diagnose(text),
  lexer: sqlLexer,
  scriptLexer: sqlScriptLexer,
});
