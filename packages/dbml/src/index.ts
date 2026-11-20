// The package entry: `@parser-kit/dbml` resolves here. The lexer is public for
// highlighters; the parse stream, the raw-name lookup and the grammar rules
// are internals and stay out.

import { defineGrammar, type ParseError } from "@parser-kit/core";
import type { DbmlDocument } from "./ast";
import { document } from "./grammar/root";
import { dbmlParseLexer } from "./lexer";

export type * from "./ast";
export { type DbmlTokenType, dbmlLexer } from "./lexer";

const grammar = defineGrammar({
  lexer: dbmlParseLexer,
  root: document,
  strictDelimited: true,
  errorReporting: { propagateLexerErrors: true },
});

/** The DBML parser. `parse` throws at the first error; `diagnose` collects errors instead of throwing. */
export const dbml: {
  parse(text: string): DbmlDocument;
  diagnose(text: string): { ast: DbmlDocument; errors: ParseError[] };
} = Object.freeze({
  parse: (text: string): DbmlDocument => grammar.parse(text),
  diagnose: (text: string) => grammar.diagnose(text),
});
