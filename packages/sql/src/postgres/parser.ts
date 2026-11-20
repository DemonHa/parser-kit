import type { Lexer } from "@parser-kit/core";
import type { Diagnosis } from "../dialect";
import type { ScriptItem, Stmt } from "./ast";
import { postgresGrammar, postgresScriptGrammar } from "./grammar";
import { type SqlTokenType, sqlLexer, sqlScriptLexer } from "./lexer";

// The `@parser-kit/sql/postgres/parser` entry point: the PostgreSQL dialect
// without its printer, for bundles that only parse. Its `postgres` object has
// every method of the full one (`@parser-kit/sql/postgres`) but `stringify`
// and `stringifyScript`, and the same AST types. The full object is built from
// this one, so the two share their parsing methods.

export type { Diagnosis } from "../dialect";
export type * from "./ast";

/**
 * The token types the PostgreSQL lexers use. `copydata` appears only inside the
 * script parser; `postgres.lexer` and `postgres.scriptLexer` never emit it.
 */
export type PostgresTokenType = SqlTokenType;

/**
 * The PostgreSQL dialect's parsing half: parse SQL or whole psql scripts into
 * a typed AST. The methods are plain functions (no `this`), so they can be
 * detached.
 */
export interface PostgresParser {
  /** Parse SQL as the server receives it. Throws the first `ParseError`. */
  readonly parse: (sql: string) => Stmt[];
  /** Parse SQL as the server receives it, recovering at each `;`. */
  readonly diagnose: (sql: string) => Diagnosis<Stmt[]>;
  /**
   * Parse a whole psql script, pg_dump output included: statements, `\`
   * meta-command lines (`psqlMeta` items) and `COPY … FROM stdin` rows
   * (`Copy.data`). Throws the first `ParseError`.
   */
  readonly parseScript: (text: string) => ScriptItem[];
  /** `parseScript`, recovering at each `;` and at each meta-command line. */
  readonly diagnoseScript: (text: string) => Diagnosis<ScriptItem[]>;
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
export const postgres: PostgresParser = Object.freeze({
  parse: (sql: string) => postgresGrammar.parse(sql),
  diagnose: (sql: string) => postgresGrammar.diagnose(sql),
  parseScript: (text: string) => postgresScriptGrammar.parse(text),
  diagnoseScript: (text: string) => postgresScriptGrammar.diagnose(text),
  lexer: sqlLexer,
  scriptLexer: sqlScriptLexer,
});
