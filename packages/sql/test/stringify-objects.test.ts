import { describe, expect, it } from "vitest";
import { postgres } from "../src/postgres/index";
import { type StringifyOptions, stringify } from "../src/postgres/print/index";

// Spellings PostgreSQL needs that a round trip through this parser can't see:
// the parser takes both forms to one tree, PostgreSQL only one of them (or
// reads them differently). Checked against PostgreSQL 16.
const print = (sql: string, options?: StringifyOptions) => stringify(postgres.parse(sql), options);

describe("objects printer: PostgreSQL's spelling", () => {
  it("quotes argument and RETURNS TABLE column names PostgreSQL's param_name excludes", () => {
    expect(
      print(`CREATE FUNCTION f("int" int, "row" int) RETURNS TABLE ("out" int, "time" int) LANGUAGE sql AS ''`),
    ).toBe(`CREATE FUNCTION f("int" int, "row" int) RETURNS TABLE ("out" int, "time" int) LANGUAGE sql AS $$$$;`);
    expect(print(`ALTER AGGREGATE agg("coalesce" int) RENAME TO b`)).toBe(
      `ALTER AGGREGATE agg("coalesce" int) RENAME TO b;`,
    );
  });

  it("writes a SET of schema or names as PostgreSQL's SCHEMA and NAMES forms", () => {
    expect(print("ALTER DATABASE db SET SCHEMA 'x'")).toBe("ALTER DATABASE db SET SCHEMA 'x';");
    expect(print("ALTER FUNCTION f() SET NAMES 'utf8' SET NAMES")).toBe(
      "ALTER FUNCTION f() SET NAMES 'utf8' SET NAMES DEFAULT;",
    );
  });

  it("quotes a TIME ZONE name, which PostgreSQL takes as a plain identifier only", () => {
    expect(print(`ALTER FUNCTION f() SET TIME ZONE "abort" SET TIME ZONE "int" SET TIME ZONE utc`)).toBe(
      `ALTER FUNCTION f() SET TIME ZONE "abort" SET TIME ZONE "int" SET TIME ZONE "utc";`,
    );
  });

  it("opens a legacy CREATE AGGREGATE list with an unquoted word whatever the quoting", () => {
    expect(
      print("CREATE AGGREGATE agg (BASETYPE = int, SFUNC = f, STYPE = int)", {
        identifierQuote: "always",
        keywordCase: "lower",
      }),
    ).toBe(`create aggregate "agg" (basetype = int, "sfunc" = f, "stype" = int);`);
  });
});
