import { expect, expectTypeOf, it } from "vitest";
import * as entry from "../src/index";

// The package's public surface: `src/index.ts` is what `@parser-kit/dbml`
// resolves to. A value disappearing from (or appearing in) it is an API change
// for npm consumers, so the list is pinned here. The built ESM/CJS entry points
// are checked against a packed tarball in CI's "Package" job.
it("exports the dbml entry point", () => {
  expect(Object.keys(entry).sort()).toEqual(["dbml"]);
  expect(Object.keys(entry.dbml).sort()).toEqual(["diagnose", "parse"]);
});

it("throws until the grammar is implemented", () => {
  expect(() => entry.dbml.parse("Table users { id int }")).toThrow(
    "@parser-kit/dbml: dbml.parse() is not implemented yet",
  );
  expect(() => entry.dbml.diagnose("Table users { id int }")).toThrow(
    "@parser-kit/dbml: dbml.diagnose() is not implemented yet",
  );
});

it("takes the DBML source text", () => {
  expectTypeOf(entry.dbml.parse).parameters.toEqualTypeOf<[text: string]>();
  expectTypeOf(entry.dbml.diagnose).parameters.toEqualTypeOf<[text: string]>();
});
