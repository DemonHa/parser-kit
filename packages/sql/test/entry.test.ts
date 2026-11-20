import { readFileSync } from "node:fs";
import { createInputStream, type Lexer, ParseError } from "@parser-kit/core";
import { describe, expect, expectTypeOf, it } from "vitest";
import type * as RootTypes from "../src/index";
import * as entry from "../src/index";
import type * as PostgresTypes from "../src/postgres/index";
import * as postgresEntry from "../src/postgres/index";
import type * as ParserTypes from "../src/postgres/parser";
import * as parserEntry from "../src/postgres/parser";

// The package's public surface: `src/index.ts` is what `@parser-kit/sql`
// resolves to, `src/postgres/index.ts` is `@parser-kit/sql/postgres` and
// `src/postgres/parser.ts` is `@parser-kit/sql/postgres/parser`. A
// value disappearing from (or appearing in) either is an API change for npm
// consumers, so the lists are pinned here. The built ESM/CJS entry points are
// checked against a packed tarball in CI's "Package" job.
it("exports one object per dialect and the printer's error, and nothing else", () => {
  expect(Object.keys(entry).sort()).toEqual(["NotPrintableError", "postgres"]);
  expect(Object.keys(postgresEntry).sort()).toEqual(["NotPrintableError", "postgres"]);
  expect(entry.postgres).toBe(postgresEntry.postgres);
  expect(entry.NotPrintableError).toBe(postgresEntry.NotPrintableError);
});

// The parse-only entry: the same object less the printer, sharing its methods.
it("exports a parse-only dialect object from /postgres/parser", () => {
  expect(Object.keys(parserEntry).sort()).toEqual(["postgres"]);
  const { postgres: parser } = parserEntry;
  const { postgres } = postgresEntry;
  expect(Object.isFrozen(parser)).toBe(true);
  expect(Object.keys(parser).sort()).toEqual(
    Object.keys(postgres)
      .filter((key) => key !== "stringify" && key !== "stringifyScript")
      .sort(),
  );
  for (const key of Object.keys(parser) as (keyof typeof parser)[]) expect(parser[key]).toBe(postgres[key]);
  expect(parser.parse("SELECT 1")).toHaveLength(1);
});

// The parse-only entry must not load the printer, or it would weigh as much as
// the full one in a bundle.
it("keeps the printer out of the parse-only entry's imports", () => {
  const imports = (file: string) =>
    [...readFileSync(new URL(file, import.meta.url), "utf8").matchAll(/^import .* from "([^"]+)";/gm)].map((m) => m[1]);
  expect(imports("../src/postgres/parser.ts").sort()).toEqual([
    "../dialect",
    "./ast",
    "./grammar",
    "./lexer",
    "@parser-kit/core",
  ]);
  for (const file of ["../src/postgres/grammar.ts", "../src/postgres/lexer.ts"]) {
    expect(imports(file).filter((path) => path?.includes("print"))).toEqual([]);
  }
});

describe("postgres", () => {
  const { postgres } = postgresEntry;

  it("has the dialect methods and lexers, and is frozen", () => {
    expect(Object.keys(postgres).sort()).toEqual([
      "diagnose",
      "diagnoseScript",
      "lexer",
      "parse",
      "parseScript",
      "scriptLexer",
      "stringify",
      "stringifyScript",
    ]);
    expect(Object.isFrozen(postgres)).toBe(true);
  });

  it("parses SQL strictly and with recovery", () => {
    expect(postgres.parse("SELECT 1; SELECT 2")).toHaveLength(2);
    expect(() => postgres.parse("SELECT FROM WHERE")).toThrow(ParseError);
    const { ast, errors } = postgres.diagnose("SELECT 1;\nSELECT FROM WHERE;\nSELECT 2;");
    expect(ast.map((stmt) => stmt.kind)).toEqual(["select", "select"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(ParseError);
  });

  it("keeps psql syntax out of parse and in parseScript", () => {
    const text = "\\connect db\nCOPY t FROM stdin;\n1\n\\.\nSELECT 1;\n";
    expect(() => postgres.parse(text)).toThrow(ParseError);
    const items = postgres.parseScript(text);
    expect(items.map((item) => item.kind)).toEqual(["psqlMeta", "copy", "select"]);
    expect(items[1]).toMatchObject({ kind: "copy", data: "1\n" });
    const { ast, errors } = postgres.diagnoseScript("SELECT f(;\n\\connect db\nSELECT 2;");
    expect(ast.map((item) => item.kind)).toEqual(["psqlMeta", "select"]);
    expect(errors).toHaveLength(1);
  });

  it("works with its methods detached", () => {
    const { parse, diagnose, parseScript, diagnoseScript, stringify, stringifyScript } = postgres;
    expect(stringify(parse("select 1"))).toBe("SELECT 1;");
    expect(stringifyScript(parseScript("\\x\nselect 1"))).toBe("\\x\nSELECT 1;");
    expect(["SELECT 1", "SELECT 2"].map(parse)).toHaveLength(2);
    expect(diagnose("SELECT 1").errors).toEqual([]);
    expect(parseScript("\\x\n")).toHaveLength(1);
    expect(diagnoseScript("\\x\n").errors).toEqual([]);
  });

  it("tokenizes with comments kept, and psql lines in scriptLexer only", () => {
    const types = (lexer: Lexer<PostgresTypes.PostgresTokenType>, text: string) => {
      const stream = lexer.tokenize(createInputStream(text));
      const out: string[] = [];
      for (let token = stream.next(); token !== null; token = stream.next()) out.push(token.type);
      return out;
    };
    expect(types(postgres.lexer, "SELECT 1 -- c")).toEqual(["ident", "number", "comment"]);
    expect(types(postgres.scriptLexer, "\\x\nSELECT 1")).toEqual(["psqlmeta", "ident", "number"]);
    expect(() => types(postgres.lexer, "\\x")).toThrow(ParseError);
  });
});

// `src/postgres/ast.ts` lists the AST types explicitly, so the grammar's values
// stay out of the public types. Every type `grammar.ts` exports must be on it.
it("re-exports every AST type the grammar declares", () => {
  const exportedTypes = (file: string) =>
    [...readFileSync(new URL(file, import.meta.url), "utf8").matchAll(/^export (?:type|interface) (\w+)/gm)].map(
      (m) => m[1],
    );
  const listed = (file: string) => {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    const block = /export type \{([^}]*)\} from "\.\/grammar"/.exec(source)?.[1] ?? "";
    return block
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
  };
  expect(listed("../src/postgres/ast.ts").sort()).toEqual(exportedTypes("../src/postgres/grammar.ts").sort());
});

it("types the results with the AST types", () => {
  type Stmt = PostgresTypes.Stmt;
  type ScriptItem = PostgresTypes.ScriptItem;
  const { postgres } = postgresEntry;
  expectTypeOf(postgres).toEqualTypeOf<PostgresTypes.PostgresDialect>();
  expectTypeOf(postgres.parse).returns.toEqualTypeOf<Stmt[]>();
  expectTypeOf(postgres.diagnose).returns.toEqualTypeOf<PostgresTypes.Diagnosis<Stmt[]>>();
  expectTypeOf(postgres.diagnose).returns.toEqualTypeOf<{ ast: Stmt[]; errors: ParseError[] }>();
  expectTypeOf(postgres.parseScript).returns.toEqualTypeOf<ScriptItem[]>();
  expectTypeOf(postgres.diagnoseScript).returns.toEqualTypeOf<{ ast: ScriptItem[]; errors: ParseError[] }>();
  expectTypeOf(postgres.lexer).toEqualTypeOf<Lexer<PostgresTypes.PostgresTokenType>>();
  expectTypeOf(postgres.stringify).toEqualTypeOf<
    (node: PostgresTypes.StringifyInput, options?: PostgresTypes.StringifyOptions) => string
  >();
  expectTypeOf(postgres.stringifyScript).toEqualTypeOf<
    (items: PostgresTypes.StringifyScriptInput, options?: PostgresTypes.StringifyScriptOptions) => string
  >();
  expectTypeOf<PostgresTypes.PostgresDialect>().toMatchTypeOf<PostgresTypes.PostgresParser>();
  expectTypeOf(parserEntry.postgres).toEqualTypeOf<ParserTypes.PostgresParser>();
  expectTypeOf<ParserTypes.PostgresParser>().toEqualTypeOf<PostgresTypes.PostgresParser>();
  expectTypeOf<ParserTypes.Stmt>().toEqualTypeOf<PostgresTypes.Stmt>();
  expectTypeOf<ParserTypes.Diagnosis<number>>().toEqualTypeOf<PostgresTypes.Diagnosis<number>>();
  expectTypeOf<ParserTypes.PostgresTokenType>().toEqualTypeOf<PostgresTypes.PostgresTokenType>();
  // @ts-expect-error -- the parse-only object has no printer
  expectTypeOf(parserEntry.postgres.stringify);
  expectTypeOf<PostgresTypes.PsqlMeta>().toMatchTypeOf<ScriptItem>();
  expectTypeOf<Extract<Stmt, { kind: "select" }>>().toMatchTypeOf<PostgresTypes.Query>();
  expectTypeOf<Extract<PostgresTypes.Expr, { kind: "number" }>["value"]>().toEqualTypeOf<number>();
  expectTypeOf<Extract<PostgresTypes.Expr, { kind: "number" }>["raw"]>().toEqualTypeOf<string | undefined>();
  // Qualified names keep one element per part.
  expectTypeOf<Extract<PostgresTypes.Expr, { kind: "call" }>["name"]>().toEqualTypeOf<string[]>();
  expectTypeOf<PostgresTypes.ColType["name"]>().toEqualTypeOf<string[]>();
  expectTypeOf<"ident">().toMatchTypeOf<PostgresTypes.PostgresTokenType>();
});

it("namespaces the AST types at the root and keeps the grammars private", () => {
  expectTypeOf(entry.postgres).toEqualTypeOf<RootTypes.PostgresDialect>();
  expectTypeOf<RootTypes.Postgres.Stmt>().toEqualTypeOf<PostgresTypes.Stmt>();
  expectTypeOf<RootTypes.Diagnosis<number>>().toEqualTypeOf<PostgresTypes.Diagnosis<number>>();
  expectTypeOf<RootTypes.PostgresParser>().toEqualTypeOf<PostgresTypes.PostgresParser>();
  // The printer's types are a dialect's own, so the root leaves them to the subpath.
  // @ts-expect-error -- no unqualified StringifyOptions at the root
  expectTypeOf<RootTypes.StringifyOptions>();
  // A second dialect's `Stmt` would collide with an unqualified one at the root.
  // @ts-expect-error -- the root has no unqualified AST types
  expectTypeOf<RootTypes.Stmt>();
  // @ts-expect-error -- the root grammars are not public, not even as types
  expectTypeOf<typeof PostgresTypes.postgresGrammar>();
  // @ts-expect-error -- the lexer plumbing is not public
  expectTypeOf<typeof PostgresTypes.routineDepth>();
});
