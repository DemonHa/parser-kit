import { Parser } from "@dbml/core";
import { Compiler, DEFAULT_ENTRY, MemoryProjectLayout } from "@dbml/parse";

// The incumbent, measured at two depths so the comparison is like for like.
//
// `@dbml/core` 12.1.0 delegates DBML to `@dbml/parse` 12.1.0's `Compiler`, a
// lazy query engine with a per-instance cache. A fresh compiler is built for
// every call, so nothing is served from cache. Building one costs about
// 1.7 µs, around 1% of the whole-corpus time but a visible share of the
// smallest single-category groups.

/** A fresh compiler holding `source`, whose file-kind sniff is skipped (see `incumbentParse`). */
function compilerFor(source: string): Compiler {
  const layout = new MemoryProjectLayout();
  layout.setSource(DEFAULT_ENTRY, source);
  const compiler = new Compiler(layout);
  // `parseFile` asks `fileKind` whether the file is an architecture diagram,
  // which re-lexes the whole source to read its front matter: a second full
  // lex, 25-45% of the parse stage's time. Every benched document is a plain
  // DBML file (`checkFileKindStub` checks it with the shipped sniff), so
  // answer directly.
  (compiler as { fileKind: (filepath: unknown) => string }).fileKind = () => "dbml";
  return compiler;
}

/**
 * `@dbml/parse`'s lex + parse stage alone: `Compiler#parseFile` lexes the
 * source once and builds its syntax tree (tokens with trivia; it recovers, so
 * it collects syntax errors instead of throwing). This is the closest match to
 * `dbml.parse` / `dbml.diagnose`: no validation, binding or model, and the
 * front-matter re-lex skipped (see `compilerFor`).
 */
export function incumbentParse(source: string): unknown {
  return compilerFor(source).parseFile(DEFAULT_ENTRY).getValue();
}

/** Syntax errors `incumbentParse` collects for `source`. */
export function incumbentParseErrors(source: string): number {
  return compilerFor(source).parseFile(DEFAULT_ENTRY).getErrors().length;
}

/**
 * Throws unless skipping the file-kind sniff is exact for `source`: the
 * compiler as shipped classifies it as a plain DBML file, the answer
 * `compilerFor` hard-codes, so `parseFile` takes the same path either way.
 */
export function checkFileKindStub(source: string): void {
  const layout = new MemoryProjectLayout();
  layout.setSource(DEFAULT_ENTRY, source);
  const kind = new Compiler(layout).fileKind(DEFAULT_ENTRY);
  if (kind !== "dbml") throw new Error(`@dbml/parse reads this file as "${kind}", not "dbml"`);
}

/**
 * `Parser.parse(source, "dbmlv2")`, `@dbml/core`'s public entry. On top of
 * lex + parse (including the front-matter re-lex) it validates every element,
 * binds names (refs, enums, aliases, partials), interprets the tree into a raw
 * JSON database, then builds the `Database` model from it; it constructs two
 * compilers per call. It throws on any error, syntax or semantic.
 */
export function incumbentFull(source: string): unknown {
  return Parser.parse(source, "dbmlv2");
}

/** Whether `incumbentFull` accepts `source`. */
export function incumbentAccepts(source: string): boolean {
  try {
    incumbentFull(source);
    return true;
  } catch {
    return false;
  }
}
