import type { Lexer, ParseError } from "@parser-kit/core";
import { expect, expectTypeOf, it } from "vitest";
import type { DbmlDocument, DbmlTokenType } from "../src/index";
import * as entry from "../src/index";

// The package's public surface: `src/index.ts` is what `@parser-kit/dbml`
// resolves to. A value disappearing from (or appearing in) it is an API change
// for npm consumers, so the list is pinned here. The built ESM/CJS entry points
// are checked against a packed tarball in CI's "Package" job.
it("exports the dbml entry point and the lexer", () => {
  expect(Object.keys(entry).sort()).toEqual(["dbml", "dbmlLexer"]);
  expect(Object.keys(entry.dbml).sort()).toEqual(["diagnose", "parse"]);
});

it("is frozen and works with its methods detached", () => {
  expect(Object.isFrozen(entry.dbml)).toBe(true);
  const { parse, diagnose } = entry.dbml;
  expect(parse("Table users { id int }").elements).toHaveLength(1);
  expect(diagnose("Table users { id int }").errors).toEqual([]);
});

it("types the lexer over the DBML token vocabulary", () => {
  expectTypeOf(entry.dbmlLexer).toEqualTypeOf<Lexer<DbmlTokenType>>();
  expectTypeOf<DbmlTokenType>().toEqualTypeOf<
    "ident" | "qident" | "string" | "blockString" | "expression" | "number" | "color" | "punc" | "comment"
  >();
});

it("takes the DBML source text and returns the document", () => {
  expectTypeOf(entry.dbml.parse).parameters.toEqualTypeOf<[text: string]>();
  expectTypeOf(entry.dbml.diagnose).parameters.toEqualTypeOf<[text: string]>();
  expectTypeOf(entry.dbml.parse).returns.toEqualTypeOf<DbmlDocument>();
  expectTypeOf(entry.dbml.diagnose).returns.toEqualTypeOf<{ ast: DbmlDocument; errors: ParseError[] }>();
});

it("exports the AST types", () => {
  expectTypeOf<entry.DbmlDocument["elements"][number]["type"]>().toEqualTypeOf<
    "project" | "table" | "ref" | "enum" | "tableGroup" | "stickyNote" | "tablePartial" | "records"
  >();
  expectTypeOf<entry.TableItem["type"]>().toEqualTypeOf<"column" | "note" | "partialInjection" | "records">();
  expectTypeOf<entry.PartialItem["type"]>().toEqualTypeOf<"column" | "note">();
  expectTypeOf<entry.Value["kind"]>().toEqualTypeOf<
    "string" | "number" | "boolean" | "null" | "expression" | "color" | "identifier" | "enumConstant"
  >();
  expectTypeOf<entry.Setting["kind"]>().toEqualTypeOf<
    "pk" | "null" | "unique" | "increment" | "inactive" | "example" | "default" | "note" | "ref" | "action" | "property"
  >();
});
