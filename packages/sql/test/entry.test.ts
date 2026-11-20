import { expect, expectTypeOf, it } from "vitest";
import type { Expr, PsqlMeta, Query, ScriptItem, SqlTokenType, Stmt } from "../src/index";
import * as entry from "../src/index";

// The package's public surface: `src/index.ts` is what `@parser-kit/sql`
// resolves to. A value disappearing from (or appearing in) it is an API change
// for npm consumers, so the list is pinned here. The built ESM/CJS entry points
// are checked against a packed tarball in CI's "Package" job.
it("exports the parser entry points and the lexers", () => {
  expect(Object.keys(entry).sort()).toEqual([
    "copyDataError",
    "routineDepth",
    "sqlLexer",
    "sqlLite",
    "sqlLiteScript",
    "sqlParseLexer",
    "sqlScriptLexer",
    "sqlScriptParseLexer",
  ]);
});

it("exports the AST types the entry points produce", () => {
  expectTypeOf(entry.sqlLite.parse).returns.toEqualTypeOf<Stmt[]>();
  expectTypeOf(entry.sqlLiteScript.parse).returns.toEqualTypeOf<ScriptItem[]>();
  expectTypeOf<PsqlMeta>().toMatchTypeOf<ScriptItem>();
  expectTypeOf<Extract<Stmt, { kind: "select" }>>().toMatchTypeOf<Query>();
  expectTypeOf<Extract<Expr, { kind: "number" }>["value"]>().toEqualTypeOf<number>();
  expectTypeOf<"ident">().toMatchTypeOf<SqlTokenType>();
});
