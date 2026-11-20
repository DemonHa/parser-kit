import { stripSpans } from "@parser-kit/core";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as entry from "../src/index";
import * as postgresEntry from "../src/postgres/index";
import * as parserEntry from "../src/postgres/parser";
import { CORPUS } from "./corpus";
import { COMMENT_CASES, commentTexts, DUMPS, withComments } from "./format-cases";
import { LEXER_EDGE_CASES, MULTI_LINE, SUPPLEMENTAL } from "./parity-corpus";
import { PG_BATTERY } from "./pg-coverage";

// `postgres.format`: text to text, keeping comments. Over the corpus, the
// parity lists, the accepted coverage battery rows, the pg_dump fixtures and
// the comment cases — each as written and again with a comment before every
// token — and at several layouts, it must
//   1. parse back to the same script (`parseScript`, spans aside),
//   2. be idempotent, and
//   3. keep every comment, word for word.
// The libpg_query differential runs `format`'s output through PostgreSQL's own
// parser as well.

const { postgres } = postgresEntry;
type FormatOptions = postgresEntry.FormatOptions;

const LAYOUTS: FormatOptions[] = [
  {},
  { width: 80 },
  { width: 40 },
  { width: 1 },
  { width: 40, indent: "\t", keywordCase: "lower", identifierQuote: "always", strings: "escape" },
];

// A trailing `COPY … FROM STDIN` with neither `;` nor rows has `data`
// undefined; `format`, like `stringifyScript`, gives it an empty block.
const tree = (text: string) =>
  stripSpans(postgres.parseScript(text)).map((item) =>
    item.kind === "copy" && item.data === undefined && item.direction === "from" && item.location.kind === "stdin"
      ? { ...item, data: "" }
      : item,
  );

/** What is wrong with `format` on `text` at `options`, or undefined. */
const problem = (text: string, options: FormatOptions): string | undefined => {
  const out = postgres.format(text, options);
  const label = `${JSON.stringify(options)} ${JSON.stringify(text.slice(0, 300))}\n  -> ${JSON.stringify(out.slice(0, 300))}`;
  try {
    expect(tree(out)).toStrictEqual(tree(text));
  } catch {
    return `${label}\n  parses to a different script`;
  }
  if (postgres.format(out, options) !== out) return `${label}\n  is not idempotent`;
  const [before, after] = [commentTexts(text), commentTexts(out)];
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    return `${label}\n  comments ${JSON.stringify(before)} became ${JSON.stringify(after)}`;
  }
  return undefined;
};

const parses = (text: string): boolean => {
  try {
    postgres.parseScript(text);
    return true;
  } catch {
    return false;
  }
};

const SOURCES = [
  ...new Set([
    ...CORPUS.map((sample) => sample.sql),
    ...SUPPLEMENTAL,
    ...MULTI_LINE,
    ...LEXER_EDGE_CASES,
    ...PG_BATTERY.filter((row) => row.expect === "both" || row.expect === "sql-lite").map((row) => row.sql),
  ]),
].filter(parses);

describe("postgres.format", () => {
  it("covers every source in the lists (a source that stops parsing as a script would drop out)", () => {
    expect(SOURCES.length).toBeGreaterThan(800);
    for (const text of [...COMMENT_CASES, ...DUMPS]) expect(parses(text)).toBe(true);
  });

  it("keeps the script and every comment, and is idempotent, over the corpus and the comment cases", () => {
    const failures: string[] = [];
    for (const text of [...SOURCES, ...COMMENT_CASES, ...DUMPS]) {
      for (const options of LAYOUTS) {
        const found = problem(text, options);
        if (found !== undefined) failures.push(found);
      }
    }
    expect(failures).toEqual([]);
  });

  it("does the same with a comment before every token", () => {
    const failures: string[] = [];
    let checked = 0;
    for (const source of [...SOURCES, ...COMMENT_CASES, ...DUMPS.map((dump) => dump.slice(0, 20_000))]) {
      const text = withComments(source);
      // Sources that hold COPY rows lex the rows as SQL here; skip those.
      if (text === null || !parses(text) || !parses(source)) continue;
      expect(tree(text)).toStrictEqual(tree(source));
      checked++;
      for (const options of [LAYOUTS[0]!, LAYOUTS[3]!]) {
        const found = problem(text, options);
        if (found !== undefined) failures.push(found);
      }
    }
    expect(checked).toBeGreaterThan(800);
    expect(failures).toEqual([]);
  });

  it("puts leading comments on their own lines, trailing ones after the ;, and keeps one blank line", () => {
    expect(postgres.format("-- leading\nselect 1; -- trailing\n\n\n/* next */ select 2 /* x */;\n-- end")).toBe(
      "-- leading\nSELECT 1; -- trailing\n\n/* next */\nSELECT 2; /* x */\n-- end\n",
    );
  });

  it("moves a comment inside a statement to just before it, in order", () => {
    expect(postgres.format("select a, -- first\n b /* second */ from t; -- done")).toBe(
      "-- first\n/* second */\nSELECT a, b FROM t; -- done\n",
    );
    expect(postgres.format("select a, -- first\n b /* second */ from t;", { width: 10 })).toBe(
      "-- first\n/* second */\nSELECT\n  a,\n  b\nFROM t;\n",
    );
  });

  it("never lets SQL follow a -- comment on its line", () => {
    for (const text of ["select 1 -- a\n, 2", "select - -- a\n1", "select 1; -- a\nselect 2", "select 'a' -- a\n'b'"]) {
      for (const options of LAYOUTS) {
        const out = postgres.format(text, options);
        for (const line of out.split("\n")) {
          const at = line.indexOf("--");
          if (at !== -1) expect(line.slice(at)).toMatch(/^-- a$/);
        }
      }
    }
    expect(postgres.format("select - -- a\n1")).toBe("-- a\nSELECT -1;\n");
    expect(postgres.format("select 'a' -- a\n'b'")).toBe("-- a\nSELECT 'ab';\n");
  });

  it("never puts a comment after a -- comment, even where a bare CR ended it", () => {
    expect(postgres.format("SELECT 1; -- a\r/* b */")).toBe("SELECT 1; -- a\n/* b */\n");
    expect(postgres.format("SELECT 1 -- a\r-- b\r;")).toBe("SELECT 1; -- a\n-- b\n");
  });

  it("leaves comment look-alikes inside literals alone", () => {
    expect(postgres.format("select '--', E'/*', $$ -- $$, \"--x\"")).toBe("SELECT '--', '/*', ' -- ', \"--x\";\n");
    expect(commentTexts("select '--', E'/*', $$ -- $$, \"--x\"")).toEqual([]);
  });

  it("treats a run of CRs before an LF in a block comment as one line break, so formatting twice changes nothing", () => {
    const once = postgres.format("/* a\r\r\nb\rc */ select 1");
    expect(once).toBe("/* a\nb\rc */\nSELECT 1;\n");
    expect(postgres.format(once)).toBe(once);
  });

  it("keeps nested block comments whole", () => {
    expect(postgres.format("/* a /* b */ c */ select 1")).toBe("/* a /* b */ c */\nSELECT 1;\n");
  });

  it("writes LF line endings for CRLF input", () => {
    expect(postgres.format("-- a\r\nselect 1; -- b\r\n/* c\r\n d */\r\n")).toBe("-- a\nSELECT 1; -- b\n/* c\n d */\n");
  });

  it("keeps a COPY's rows and the -- comment after its ;, and moves a block comment there", () => {
    expect(postgres.format("copy t from stdin /* b */; -- c\n1\t-- d\n\\.\n\n-- e\n\\x")).toBe(
      "/* b */\nCOPY t FROM STDIN; -- c\n1\t-- d\n\\.\n\n-- e\n\\x\n",
    );
    expect(postgres.format("select 1; /* a */ \\connect db")).toBe("SELECT 1; /* a */\n\\connect db\n");
  });

  it("returns an empty string for an empty script, and comments alone for a script of comments", () => {
    expect(postgres.format("")).toBe("");
    expect(postgres.format(" \n\t")).toBe("");
    expect(postgres.format("-- a\n\n/* b */ /* c */")).toBe("-- a\n\n/* b */\n/* c */\n");
  });

  it("throws the parse error for SQL that doesn't parse", () => {
    expect(() => postgres.format("select from where -- x")).toThrow();
  });

  it("leaves postgres.parse's trees alone", () => {
    const sql = "select 1 /* a */, 'x' -- b\n 'y'";
    const before = postgres.parse(sql);
    postgres.format(sql);
    expect(postgres.parse(sql)).toStrictEqual(before);
  });

  it("is on the full postgres objects, detached too, and not on the parse-only one", () => {
    const { format } = entry.postgres;
    expect(format("select 1")).toBe("SELECT 1;\n");
    expect(postgres.format).toBe(format);
    expect("format" in parserEntry.postgres).toBe(false);
    expectTypeOf<FormatOptions>().toEqualTypeOf<postgresEntry.StringifyScriptOptions>();
    expectTypeOf(postgres.format).toEqualTypeOf<(text: string, options?: FormatOptions) => string>();
  });
});
