import { readdirSync, readFileSync } from "node:fs";
import { stripSpans } from "@parser-kit/core";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as entry from "../src/index";
import * as postgresEntry from "../src/postgres/index";
import { FAMILIES } from "../src/postgres/print/index";
import { CORPUS } from "./corpus";
import { SUPPLEMENTAL } from "./parity-corpus";

// The printer through the public entries: `postgres.stringify` and
// `postgres.stringifyScript`. `stringify.test.ts` holds the internal printer to
// its round trip over every corpus; this file checks the guarantee the README
// makes at the public surface, statements and whole scripts alike, and the
// script printer's own framing (meta-command lines, COPY rows).

const { postgres, NotPrintableError } = postgresEntry;
type ScriptItem = postgresEntry.ScriptItem;

const WIDTHS = [undefined, 80, 1] as const;

const DUMPS = readdirSync(new URL("./fixtures/pg-dump/", import.meta.url))
  .filter((file) => file.endsWith(".sql"))
  .map((file) => ({ file, text: readFileSync(new URL(`./fixtures/pg-dump/${file}`, import.meta.url), "utf8") }));

describe("postgres.stringify", () => {
  it("prints every statement kind: no family has a kind left to print", () => {
    expect(FAMILIES.flatMap((family) => [...family.pending])).toEqual([]);
  });

  it("parses back to the same statements, one at a time and as a list, at the default and pretty widths", () => {
    const sources = [...CORPUS.map((sample) => sample.sql), ...SUPPLEMENTAL];
    for (const width of WIDTHS) {
      for (const source of sources) {
        const ast = postgres.parse(source);
        expect(stripSpans(postgres.parse(postgres.stringify(ast, { width })))).toStrictEqual(stripSpans(ast));
        for (const stmt of ast) {
          expect(stripSpans(postgres.parse(postgres.stringify(stmt, { width })))).toStrictEqual(stripSpans([stmt]));
        }
      }
    }
  });

  it("prints one line by default, upper-case keywords, minimal quoting, a ; after each statement", () => {
    const ast = postgres.parse('select a,"B",b as "select" from t where x=1; delete from "T"');
    expect(postgres.stringify(ast)).toBe('SELECT a, "B", b AS "select" FROM t WHERE x = 1;\nDELETE FROM "T";');
    expect(postgres.stringify(ast, { keywordCase: "lower", identifierQuote: "always", semicolons: "between" })).toBe(
      'select "a", "B", "b" as "select" from "t" where "x" = 1;\ndelete from "T"',
    );
    expect(postgres.stringify(ast[0]!, { width: 20, indent: 4 })).toBe(
      'SELECT\n    a,\n    "B",\n    b AS "select"\nFROM t\nWHERE x = 1;',
    );
  });

  it("prints an expression or a type alone, and hand-built trees without spans", () => {
    const [select] = postgres.parse("SELECT a + 1 FROM t WHERE x::numeric(10, 2) > 0");
    if (select?.kind !== "select") throw new Error("expected a select");
    expect(postgres.stringify(select.where!)).toBe("x::numeric(10, 2) > 0");
    expect(
      postgres.stringify({
        kind: "binary",
        op: "*",
        left: { kind: "number", value: 2 },
        right: { kind: "param", name: "1" },
      }),
    ).toBe("2 * $1");
    expect(postgres.stringify({ name: ["varchar"], args: [3], array: true })).toBe("varchar(3)[]");
  });

  it("works detached, from the root entry too", () => {
    const { stringify, stringifyScript } = entry.postgres;
    expect(["SELECT 1", "SELECT 2"].map((sql) => stringify(postgres.parse(sql)))).toEqual(["SELECT 1;", "SELECT 2;"]);
    expect(stringifyScript(postgres.parseScript("\\x\nSELECT 1"))).toBe("\\x\nSELECT 1;");
    expect(entry.NotPrintableError).toBe(NotPrintableError);
  });

  it("exports NotPrintableError, which names the kind it can't print", () => {
    const error = new NotPrintableError("createWidget");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("NotPrintableError");
    expect(error.kind).toBe("createWidget");
    expect(error.message).toBe('A "createWidget" statement is not yet printable');
  });
});

describe("postgres.stringifyScript", () => {
  // Whole pg_dump files, meta-commands and COPY rows included.
  for (const { file, text } of DUMPS) {
    it(`parses a printed ${file} back to the same items, at the default and pretty widths`, () => {
      const items = postgres.parseScript(text);
      for (const width of WIDTHS) {
        const printed = postgres.stringifyScript(items, { width });
        expect(stripSpans(postgres.parseScript(printed))).toStrictEqual(stripSpans(items));
        expect(postgres.stringifyScript(postgres.parseScript(printed), { width })).toBe(printed);
      }
    });
  }

  it("covers meta-commands and COPY rows in the dumps", () => {
    const items = DUMPS.flatMap(({ text }) => postgres.parseScript(text));
    expect(items.some((item) => item.kind === "psqlMeta")).toBe(true);
    expect(items.some((item) => item.kind === "copy" && item.data !== undefined && item.data !== "")).toBe(true);
  });

  it("writes meta-commands on their own lines and a COPY's rows after it, ended by \\.", () => {
    const text =
      "\\connect app\nCOPY t (a, b) FROM stdin;\n1\tx\n2\t\\N\n\\.\nSELECT 1;\n\\x\nCOPY u FROM stdin;\n\\.\n";
    const items = postgres.parseScript(text);
    expect(postgres.stringifyScript(items)).toBe(
      "\\connect app\nCOPY t (a, b) FROM STDIN;\n1\tx\n2\t\\N\n\\.\nSELECT 1;\n\\x\nCOPY u FROM STDIN;\n\\.",
    );
    // `stringify` prints the statements alone, as the server receives them.
    expect(postgres.stringify(items.filter((item) => item.kind !== "psqlMeta"))).toBe(
      "COPY t (a, b) FROM STDIN;\nSELECT 1;\nCOPY u FROM STDIN;",
    );
  });

  it("ends every statement with ;, whatever the options say", () => {
    const items = postgres.parseScript("SELECT 1;\n\\x\nSELECT 2");
    // @ts-expect-error -- a script's statements always end in `;`
    expect(postgres.stringifyScript(items, { semicolons: "never" })).toBe("SELECT 1;\n\\x\nSELECT 2;");
    expect(postgres.stringifyScript(items, { keywordCase: "lower" })).toBe("select 1;\n\\x\nselect 2;");
  });

  it("ends hand-built COPY rows with a newline, and refuses rows it can't write", () => {
    const [copy] = postgres.parseScript("COPY t FROM stdin;\n\\.\n");
    if (copy?.kind !== "copy") throw new Error("expected a copy");
    const withData = (data: string): ScriptItem[] => [{ ...copy, data }];
    expect(postgres.stringifyScript(withData("1\n2"))).toBe("COPY t FROM STDIN;\n1\n2\n\\.");
    expect(stripSpans(postgres.parseScript(postgres.stringifyScript(withData("1\n2"))))).toStrictEqual(
      stripSpans(withData("1\n2\n")),
    );
    expect(() => postgres.stringifyScript(withData("1\n\\.\n2\n"))).toThrow(TypeError);
    expect(() => postgres.stringifyScript(withData("\\.\r\n"))).toThrow(TypeError);
    const [toStdout] = postgres.parse("COPY t TO stdout");
    expect(() => postgres.stringifyScript([{ ...toStdout!, data: "1\n" } as ScriptItem])).toThrow(
      "COPY data can only follow a COPY … FROM STDIN",
    );
    expect(() => postgres.stringifyScript([{ kind: "psqlMeta", command: "echo", args: "a\nSELECT 1" }])).toThrow(
      TypeError,
    );
  });

  const roundTrips = (text: string) => {
    const items = postgres.parseScript(text);
    for (const width of WIDTHS) {
      for (const identifierQuote of ["minimal", "always"] as const) {
        const printed = postgres.stringifyScript(items, { width, identifierQuote });
        expect(stripSpans(postgres.parseScript(printed)), printed).toStrictEqual(stripSpans(items));
      }
    }
  };

  it("splits COPY rows at \\n alone, as psql does", () => {
    for (const rows of ["a\r\\.\n", "\\.\rfoo\n", "a\u2028\\.\n", "\\.x\n \\.\n"]) {
      roundTrips(`COPY t FROM stdin;\n${rows}\\.\nSELECT 1;\n`);
    }
  });

  it("writes an empty block after a COPY … FROM STDIN with no rows", () => {
    expect(postgres.stringifyScript(postgres.parseScript("COPY t FROM stdin"))).toBe("COPY t FROM STDIN;\n\\.");
    const stmts = postgres.parse("COPY t FROM STDIN; COPY t TO STDOUT; SELECT 1");
    const printed = postgres.stringifyScript(stmts);
    expect(printed).toBe("COPY t FROM STDIN;\n\\.\nCOPY t TO STDOUT;\nSELECT 1;");
    expect(stripSpans(postgres.parseScript(printed))).toStrictEqual(
      stripSpans([{ ...stmts[0]!, data: "" }, stmts[1]!, stmts[2]!]),
    );
  });

  // psql counts a bare `begin` in a CREATE FUNCTION / PROCEDURE as opening a
  // BEGIN ATOMIC body; the rows of a COPY after it would then be read as SQL.
  it("quotes a name begin in a routine statement, so the statements after it frame right", () => {
    for (const routine of [
      'CREATE FUNCTION f() RETURNS int BEGIN ATOMIC SELECT "begin" FROM t; END;',
      "CREATE FUNCTION \"begin\"() RETURNS int LANGUAGE sql AS 'SELECT 1';",
      "CREATE FUNCTION \"begin\".f() RETURNS int LANGUAGE sql AS 'SELECT 1';",
      "CREATE PROCEDURE \"begin\"() LANGUAGE sql AS 'SELECT 1';",
      'CREATE FUNCTION f() RETURNS int RETURN "begin";',
      "CREATE OR REPLACE FUNCTION f() RETURNS int LANGUAGE sql SET search_path = \"begin\" AS 'SELECT 1';",
      "CREATE FUNCTION f() RETURNS \"begin\" LANGUAGE sql AS 'SELECT 1';",
      "CREATE FUNCTION f(\"begin\" int) RETURNS int LANGUAGE sql AS 'SELECT 1';",
    ]) {
      roundTrips(`${routine}\nCOPY t FROM stdin;\n1\n\\.\nSELECT 1;\n`);
    }
    // Elsewhere `begin` stays bare.
    expect(postgres.stringify(postgres.parse('SELECT "begin" FROM "begin"'))).toBe("SELECT begin FROM begin;");
  });

  it("keeps a meta-command's lone \\r, and refuses names psql would read differently", () => {
    roundTrips("\\echo a\rb\nSELECT 1;\n");
    for (const command of ["", "a b", "a\\b", "a\tb"]) {
      expect(() => postgres.stringifyScript([{ kind: "psqlMeta", command, args: "" }])).toThrow(TypeError);
    }
  });

  it("is typed with the AST types and its options", () => {
    expectTypeOf(postgres.stringify).returns.toEqualTypeOf<string>();
    expectTypeOf(postgres.stringifyScript).parameter(0).toEqualTypeOf<postgresEntry.StringifyScriptInput>();
    expectTypeOf<ScriptItem[]>().toMatchTypeOf<postgresEntry.StringifyScriptInput>();
    expectTypeOf<postgresEntry.Stmt[]>().toMatchTypeOf<postgresEntry.StringifyInput>();
    expectTypeOf<postgresEntry.Expr>().toMatchTypeOf<postgresEntry.StringifyInput>();
    expectTypeOf<postgresEntry.ColType>().toMatchTypeOf<postgresEntry.StringifyInput>();
    expectTypeOf<postgresEntry.StringifyScriptOptions>().toEqualTypeOf<
      Omit<postgresEntry.StringifyOptions, "semicolons">
    >();
  });
});
