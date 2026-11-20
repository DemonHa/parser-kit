import { createInputStream, type Lexer, ParseError } from "@parser-kit/core";
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  Expr,
  PostgresDiagnosis,
  PostgresDialect,
  PostgresTokenType,
  PsqlMeta,
  Query,
  ScriptItem,
  Stmt,
} from "../src/index";
import * as entry from "../src/index";
import * as postgresEntry from "../src/postgres/index";

// The package's public surface: `src/index.ts` is what `@parser-kit/sql`
// resolves to and `src/postgres/index.ts` is `@parser-kit/sql/postgres`. A
// value disappearing from (or appearing in) either is an API change for npm
// consumers, so the lists are pinned here. The built ESM/CJS entry points are
// checked against a packed tarball in CI's "Package" job.
it("exports one object per dialect and nothing else", () => {
  expect(Object.keys(entry).sort()).toEqual(["postgres"]);
  expect(Object.keys(postgresEntry).sort()).toEqual(["postgres"]);
  expect(entry.postgres).toBe(postgresEntry.postgres);
});

describe("postgres", () => {
  const { postgres } = entry;

  it("has the dialect methods and lexers, and is frozen", () => {
    expect(Object.keys(postgres).sort()).toEqual([
      "diagnose",
      "diagnoseScript",
      "lexer",
      "parse",
      "parseScript",
      "scriptLexer",
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
    const { parse, diagnose, parseScript, diagnoseScript } = postgres;
    expect(["SELECT 1", "SELECT 2"].map(parse)).toHaveLength(2);
    expect(diagnose("SELECT 1").errors).toEqual([]);
    expect(parseScript("\\x\n")).toHaveLength(1);
    expect(diagnoseScript("\\x\n").errors).toEqual([]);
  });

  it("tokenizes with comments kept, and psql lines in scriptLexer only", () => {
    const types = (lexer: Lexer<PostgresTokenType>, text: string) => {
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

it("types the results with the AST types", () => {
  expectTypeOf(entry.postgres).toEqualTypeOf<PostgresDialect>();
  expectTypeOf(entry.postgres.parse).returns.toEqualTypeOf<Stmt[]>();
  expectTypeOf(entry.postgres.diagnose).returns.toEqualTypeOf<PostgresDiagnosis<Stmt[]>>();
  expectTypeOf(entry.postgres.diagnose).returns.toEqualTypeOf<{ ast: Stmt[]; errors: ParseError[] }>();
  expectTypeOf(entry.postgres.parseScript).returns.toEqualTypeOf<ScriptItem[]>();
  expectTypeOf(entry.postgres.diagnoseScript).returns.toEqualTypeOf<{ ast: ScriptItem[]; errors: ParseError[] }>();
  expectTypeOf(entry.postgres.lexer).toEqualTypeOf<Lexer<PostgresTokenType>>();
  expectTypeOf<PsqlMeta>().toMatchTypeOf<ScriptItem>();
  expectTypeOf<Extract<Stmt, { kind: "select" }>>().toMatchTypeOf<Query>();
  expectTypeOf<Extract<Expr, { kind: "number" }>["value"]>().toEqualTypeOf<number>();
  expectTypeOf<"ident">().toMatchTypeOf<PostgresTokenType>();
  expectTypeOf<postgresEntry.Stmt>().toEqualTypeOf<Stmt>();
});
