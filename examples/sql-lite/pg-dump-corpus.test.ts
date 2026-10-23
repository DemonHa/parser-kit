import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Copy, type ScriptItem, sqlLite, sqlLiteScript } from "./index";
import { type DumpOutcome, type DumpRow, PG_DUMP_EXPECTATIONS } from "./pg-dump-corpus";
import { splitPsqlScript } from "./psql-split";

// Re-parses every statement of the pg_dump files in `fixtures/pg-dump/` with
// `sqlLite.parse` and pins each outcome in `pg-dump-corpus.ts`. A statement
// that starts parsing, or stops, fails this test with an `expected -> actual`
// line; flip its row (or regenerate the file, below) and update the README.
//
//   PG_DUMP_CORPUS_REPORT=1  prints the per-file pass rates.
//   PG_DUMP_CORPUS_WRITE=1   rewrites `pg-dump-corpus.ts` from the current
//                            parser (that run still compares against the old
//                            file; re-run to check). Review the diff: no row
//                            may move to "fail".
//
// COPY data blocks and psql meta-commands (`\connect`, `\restrict`, …) are not
// SQL `sqlLite.parse` accepts, so the splitter sets them aside. Each file is
// also parsed whole, with `sqlLiteScript.diagnose`, which reads them itself:
// the statements it reports errors in must be exactly the "fail" rows, and
// its meta-command and COPY items must match what the splitter found. A file
// with no "fail" row must parse end to end with `sqlLiteScript.parse`.

const FIXTURES = new URL("./fixtures/pg-dump/", import.meta.url);
const EXPECTATIONS = new URL("./pg-dump-corpus.ts", import.meta.url);

const HEAD_LENGTH = 80;
const head = (sql: string) => {
  const flat = sql.replace(/\s+/g, " ");
  const chars = [...flat];
  return chars.length > HEAD_LENGTH ? `${chars.slice(0, HEAD_LENGTH).join("")}…` : flat;
};

const outcome = (sql: string): DumpOutcome => {
  try {
    sqlLite.parse(sql);
    return "ok";
  } catch {
    return "fail";
  }
};

const files = readdirSync(FIXTURES)
  .filter((file) => file.endsWith(".sql"))
  .sort();

const measured = files.map((file) => {
  const text = readFileSync(new URL(file, FIXTURES), "utf8");
  const split = splitPsqlScript(text);
  const rows: DumpRow[] = split.statements.map((s) => [outcome(s.sql), s.line, head(s.sql)]);
  return { file, text, rows, copyBlocks: split.copyBlocks, metaCommands: split.metaCommands };
});

// The 1-based line of the statement a line falls in: the last one starting at
// or before it, or 0 before the first statement.
const statementOf = (rows: readonly DumpRow[], at: number) => {
  let start = 0;
  for (const [, line] of rows) if (line <= at) start = line;
  return start;
};
const failingStatements = (rows: readonly DumpRow[], errorLines: readonly number[]) =>
  [...new Set(errorLines.map((line) => statementOf(rows, line)))].sort((a, b) => a - b);

const isCopyData = (item: ScriptItem): item is Copy & { data: string } =>
  item.kind === "copy" && item.data !== undefined;

// A string literal the way the formatter would write it: double quotes unless
// single quotes need fewer escapes.
const literal = (text: string) => {
  const doubles = text.split('"').length;
  const singles = text.split("'").length;
  if (doubles <= singles) return JSON.stringify(text);
  return `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
};

const writeExpectations = () => {
  const source = readFileSync(EXPECTATIONS, "utf8");
  const marker = "export const PG_DUMP_EXPECTATIONS";
  const prelude = source.slice(0, source.indexOf(marker));
  const body = measured
    .map(({ file, rows }) => {
      const lines = rows.map(([o, line, text]) => `    [${JSON.stringify(o)}, ${line}, ${literal(text)}],`);
      return `  ${JSON.stringify(file)}: [\n${lines.join("\n")}\n  ],`;
    })
    .join("\n");
  writeFileSync(EXPECTATIONS, `${prelude}${marker}: Record<string, DumpRow[]> = {\n${body}\n};\n`);
};

describe("pg_dump corpus", () => {
  if (process.env.PG_DUMP_CORPUS_WRITE) writeExpectations();

  it("has recorded expectations for exactly the fixture files", () => {
    expect(Object.keys(PG_DUMP_EXPECTATIONS).sort()).toEqual(files);
  });

  for (const { file, text, rows, copyBlocks, metaCommands } of measured) {
    describe(file, () => {
      const expected = PG_DUMP_EXPECTATIONS[file] ?? [];

      it("splits into the recorded statements", () => {
        expect(rows.map(([, line, text]) => `${line}: ${text}`)).toEqual(
          expected.map(([, line, text]) => `${line}: ${text}`),
        );
      });

      it("matches the recorded outcome for every statement", () => {
        const moved = rows
          .map(([actual, line, text], index) => ({ actual, line, text, expect: expected[index]?.[0] }))
          .filter((row) => row.actual !== row.expect);
        expect(moved.map((row) => `${row.expect} -> ${row.actual}: ${file}:${row.line} ${row.text}`)).toEqual([]);
      });

      it("parses as a whole script, failing in exactly the recorded statements", () => {
        const { ast, errors } = sqlLiteScript.diagnose(text);
        const failing = expected.filter(([o]) => o === "fail").map(([, line]) => line);
        expect(
          failingStatements(
            rows,
            errors.map((error) => error.start.row),
          ),
        ).toEqual(failing);
        if (failing.length === 0) expect(() => sqlLiteScript.parse(text)).not.toThrow();
        // Every "ok" statement is an item, and any other statement item is
        // recovery's leftover from inside a failing one (a routine body cut at
        // its first `;`).
        const starts = ast.filter((item) => item.kind !== "psqlMeta").map((item) => item.span.start.row);
        const ok = expected.filter(([o]) => o === "ok").map(([, line]) => line);
        expect(ok.filter((line) => !starts.includes(line))).toEqual([]);
        const stray = starts.filter((line) => !ok.includes(line) && !failing.includes(statementOf(rows, line)));
        expect(stray).toEqual([]);
        expect(ast.filter((item) => item.kind === "psqlMeta").map((item) => item.span.start.row)).toEqual(
          metaCommands.map((meta) => meta.line),
        );
        // A row is a line of the block; the splitter doesn't count the terminator.
        expect(ast.filter(isCopyData).map((copy) => copy.data.split("\n").length - 1)).toEqual(
          copyBlocks.map((block) => block.rows),
        );
      });
    });
  }

  if (process.env.PG_DUMP_CORPUS_REPORT) {
    it("reports pass rates", () => {
      const summary = (name: string, list: typeof measured) => {
        const statements = list.reduce((n, m) => n + m.rows.length, 0);
        const parsed = list.reduce((n, m) => n + m.rows.filter(([o]) => o === "ok").length, 0);
        return {
          file: name,
          statements,
          parsed,
          rate: `${((parsed / statements) * 100).toFixed(1)}%`,
          copyBlocks: list.reduce((n, m) => n + m.copyBlocks.length, 0),
          metaCommands: list.reduce((n, m) => n + m.metaCommands.length, 0),
          // Files with no failing statement, which the test parses whole.
          parsesWhole: list.filter((m) => m.rows.every(([o]) => o === "ok")).length,
        };
      };
      // eslint-disable-next-line no-console
      console.table([...measured.map((m) => summary(m.file, [m])), summary("total", measured)]);
    });
  }
});

describe("psql-style statement splitter", () => {
  const sqls = (text: string) => splitPsqlScript(text).statements.map((s) => s.sql);

  it("splits on semicolons outside strings, quoted names and comments", () => {
    expect(sqls(`SELECT 'a;b', "c;d" FROM t; -- x;\n/* y; /* nested; */ z; */ SELECT 2;`)).toEqual([
      `SELECT 'a;b', "c;d" FROM t;`,
      "SELECT 2;",
    ]);
  });

  it("honours doubled quotes and backslash escapes only in E'' strings", () => {
    expect(sqls(`SELECT 'it''s;'; SELECT E'\\';'; SELECT 'x\\'; SELECT 1;`)).toEqual([
      `SELECT 'it''s;';`,
      `SELECT E'\\';';`,
      `SELECT 'x\\';`,
      "SELECT 1;",
    ]);
  });

  it("keeps dollar-quoted bodies whole and leaves $n parameters alone", () => {
    expect(sqls("CREATE FUNCTION f() AS $fn$ a; $$ b; $fn$; SELECT $1, a$b FROM t;")).toEqual([
      "CREATE FUNCTION f() AS $fn$ a; $$ b; $fn$;",
      "SELECT $1, a$b FROM t;",
    ]);
  });

  it("keeps a dollar quote with a long tag whole", () => {
    const tag = `$${"t".repeat(70)}$`;
    expect(sqls(`SELECT ${tag} a; ${tag}; SELECT 2;`)).toEqual([`SELECT ${tag} a; ${tag};`, "SELECT 2;"]);
  });

  it("does not split inside parentheses", () => {
    expect(sqls("SELECT (1; 2); SELECT 3;")).toEqual(["SELECT (1; 2);", "SELECT 3;"]);
  });

  it("keeps a BEGIN ATOMIC body, CASE … END included, as one statement", () => {
    const routine = "CREATE OR REPLACE PROCEDURE p() BEGIN ATOMIC SELECT CASE WHEN x THEN 1 END; DELETE FROM t; END;";
    expect(sqls(`${routine} BEGIN; SELECT CASE WHEN x THEN 1 END; END;`)).toEqual([
      routine,
      "BEGIN;",
      "SELECT CASE WHEN x THEN 1 END;",
      "END;",
    ]);
  });

  it("separates meta-commands and COPY data from the statements", () => {
    const script = [
      "\\connect db",
      "COPY t (a) FROM stdin;",
      "1;\\N",
      "it's",
      "\\.",
      "COPY t TO stdout;",
      "SELECT 1;",
    ].join("\n");
    expect(splitPsqlScript(script)).toEqual({
      statements: [
        { sql: "COPY t (a) FROM stdin;", line: 2 },
        { sql: "COPY t TO stdout;", line: 6 },
        { sql: "SELECT 1;", line: 7 },
      ],
      copyBlocks: [{ line: 3, rows: 2 }],
      metaCommands: [{ line: 1, text: "\\connect db" }],
    });
  });

  it("detects COPY-in from the words, not from text inside strings or comments", () => {
    const blocks = (text: string) => splitPsqlScript(text).copyBlocks.length;
    expect(blocks("COPY (SELECT 'from stdin') TO stdout;\nSELECT 1;\n")).toBe(0);
    expect(blocks("COPY t FROM /* x */ stdin;\n1\n\\.\n")).toBe(1);
    expect(blocks("COPY t (a) FROM STDIN WITH (FORMAT csv);\n1\n\\.\n")).toBe(1);
  });

  it("reads a dollar quote straight after a number or parameter", () => {
    expect(sqls("SELECT 1$$a;$$; SELECT $1$$b;$$;")).toEqual(["SELECT 1$$a;$$;", "SELECT $1$$b;$$;"]);
  });

  it("returns a final statement with no semicolon", () => {
    expect(sqls("SELECT 1;\nSELECT 2\n")).toEqual(["SELECT 1;", "SELECT 2"]);
  });

  it("finds the hand-written dump's COPY block and meta-commands", () => {
    const handwritten = measured.find((m) => m.file === "handwritten-pg17.sql")!;
    expect(handwritten.copyBlocks.map((b) => b.rows)).toEqual([3, 0, 0, 0]);
    expect(handwritten.metaCommands.map((m) => m.text.split(" ")[0])).toEqual([
      "\\restrict",
      "\\unrestrict",
      "\\restrict",
      "\\unrestrict",
      "\\connect",
      "\\restrict",
      "\\unrestrict",
    ]);
  });
});
