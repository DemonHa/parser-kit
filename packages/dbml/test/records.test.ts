import { describe, expect, it } from "vitest";
import type { RecordField, Records, Table } from "../src/index";
import { elements, id, only, parse, parseError, qn, span } from "./helpers";

const records = (text: string): Records => only(text, "records");
const inTable = (body: string): Records => {
  const items = only(`Table t {\n  id int\n${body}\n}`, "table").items;
  expect(items).toHaveLength(2);
  return items[1] as Records;
};
const fields = (row: string): RecordField[] => {
  const { rows } = records(`records t(a) {\n  ${row}\n}`);
  expect(rows).toHaveLength(1);
  return rows[0]!.fields;
};
const empty = { kind: "empty" as const };

describe("records at the top level", () => {
  it("parses the table, the columns and the rows", () => {
    expect(records("records users(id, name) {\n  1, 'Alice'\n  2, 'Bob'\n}")).toEqual({
      type: "records",
      table: qn("users"),
      columns: [id("id"), id("name")],
      settings: [],
      rows: [
        {
          fields: [
            { kind: "number", value: 1 },
            { kind: "string", value: "Alice" },
          ],
        },
        {
          fields: [
            { kind: "number", value: 2 },
            { kind: "string", value: "Bob" },
          ],
        },
      ],
    });
  });

  it("takes a schema, quoted names, `[example]` and an empty column list or body", () => {
    expect(records('RECORDS s."my t"("first name") [Example] {}')).toEqual({
      type: "records",
      table: { schema: id("s"), name: id("my t", true) },
      columns: [id("first name", true)],
      settings: [{ kind: "example" }],
      rows: [],
    });
    expect(records("records t() {\n\n}").columns).toEqual([]);
    expect(records("records t(a) [] { 1 }").settings).toEqual([]);
    // At the top level, unlike inside a table, the `{` may touch the header.
    expect(records("records t(a){ 1 }")).toEqual(records("records t(a) { 1 }"));
    expect(records("records t(a) [example]{ 1 }").settings).toEqual([{ kind: "example" }]);
  });

  it("lets a space separate the table from its columns, and line breaks sit elsewhere in the header", () => {
    const expected = records("records t(a, b) [example] { 1, 2 }");
    expect(records("records t (a, b) [example] { 1, 2 }")).toEqual(expected);
    expect(records("records\nt(\n  a,\n  b\n) \n[example]\n{\n  1, 2\n}")).toEqual(expected);
  });

  it("parses rows on one line with the body, blank lines and comments", () => {
    expect(records("records t(a) { 1 }").rows).toHaveLength(1);
    expect(records("records t(a, b) { 1, 2\n\n  3, 4 // last\n  /* gone */ }").rows).toHaveLength(2);
  });

  it("parses alongside the other elements", () => {
    const text = "Table t { a int }\nrecords t(a) { 1 } records t(a) {\n  2\n}";
    expect(elements(text).map((element) => element.type)).toEqual(["table", "records", "records"]);
  });
});

describe("records inside a table", () => {
  it("parses a column list, settings and rows", () => {
    expect(inTable("  records (id) [example] {\n    1\n    2\n  }")).toEqual({
      type: "records",
      table: null,
      columns: [id("id")],
      settings: [{ kind: "example" }],
      rows: [{ fields: [{ kind: "number", value: 1 }] }, { fields: [{ kind: "number", value: 2 }] }],
    });
  });

  it("takes no column list, a column list touching the keyword, and a body on one line", () => {
    expect(inTable("  records {\n    1\n  }")).toEqual({
      type: "records",
      table: null,
      columns: null,
      settings: [],
      rows: [{ fields: [{ kind: "number", value: 1 }] }],
    });
    expect(inTable("  records(id) { 1 }").columns).toEqual([id("id")]);
    expect(inTable("  records [example] {}").settings).toEqual([{ kind: "example" }]);
  });

  it("keeps the block in source order among the table's items", () => {
    const { items } = only("Table t {\n  records (id) { 1 }\n  id int\n}", "table");
    expect(items.map((item) => item.type)).toEqual(["records", "column"]);
  });
});

describe("records fields", () => {
  it("parses every value kind", () => {
    expect(fields("'s', \"dq\", '''ml\n  x''', -1, +2.50, - 3, 1e999, true, FALSE, Null, `now()`")).toEqual([
      { kind: "string", value: "s" },
      { kind: "string", value: "dq", doubleQuoted: true },
      { kind: "string", value: "ml\n  x", multiline: true },
      { kind: "number", value: -1 },
      { kind: "number", value: 2.5, raw: "+2.50" },
      { kind: "number", value: -3 },
      { kind: "number", value: Number.POSITIVE_INFINITY, raw: "1e999" },
      { kind: "boolean", value: true },
      { kind: "boolean", value: false },
      { kind: "null" },
      { kind: "expression", value: "now()" },
    ]);
  });

  it("parses enum values, with a schema, quoted parts and line breaks around the dots", () => {
    expect(fields('status.active, s.status."on hold", e\n.a')).toEqual([
      { kind: "enumConstant", path: [id("status"), id("active")] },
      { kind: "enumConstant", path: [id("s"), id("status"), id("on hold", true)] },
      { kind: "enumConstant", path: [id("e"), id("a")] },
    ]);
  });

  it("parses empty fields: leading, in the middle, trailing and alone", () => {
    expect(fields(", 'A'")).toEqual([empty, { kind: "string", value: "A" }]);
    expect(fields("1, , 3")).toEqual([{ kind: "number", value: 1 }, empty, { kind: "number", value: 3 }]);
    expect(fields("1,")).toEqual([{ kind: "number", value: 1 }, empty]);
    expect(fields(",")).toEqual([empty, empty]);
    expect(records("records t(a, b) { 1, }").rows[0]!.fields).toEqual([{ kind: "number", value: 1 }, empty]);
  });

  it("continues a one-field row on a later line that starts with a comma, as @dbml/core does", () => {
    const rows = (body: string) => records(`records t(a, b) {\n${body}\n}`).rows.map((row) => row.fields);
    expect(rows("  1\n\n  // c\n  , 2")).toEqual([
      [
        { kind: "number", value: 1 },
        { kind: "number", value: 2 },
      ],
    ]);
    expect(rows("  1\n  ,")).toEqual([[{ kind: "number", value: 1 }, empty]]);
    // Only once, and only while the row has no comma yet.
    expect(rows("  1\n  , 2\n  , 3")).toEqual([
      [
        { kind: "number", value: 1 },
        { kind: "number", value: 2 },
      ],
      [empty, { kind: "number", value: 3 }],
    ]);
    expect(rows("  1, 2\n  , 3")).toEqual([
      [
        { kind: "number", value: 1 },
        { kind: "number", value: 2 },
      ],
      [empty, { kind: "number", value: 3 }],
    ]);
    const [row] = (parse("records t(a, b) {\n  1\n  , 2\n}").elements[0] as Records).rows;
    expect(row!.span).toEqual(span(2, 2, 3, 5));
  });

  it("takes line breaks between a sign and its number, as @dbml/core does", () => {
    expect(fields("-\n\n  3")).toEqual([{ kind: "number", value: -3 }]);
  });

  it("does not check a row's field count against the columns", () => {
    expect(records("records t(a) {\n  1, 2, 3\n}").rows[0]!.fields).toHaveLength(3);
  });
});

describe("records keywords", () => {
  const words = ["records", "Records", "example", "null", "true", "table"];

  for (const word of words) {
    it(`keeps ${word} usable as a name`, () => {
      expect(records(`records ${word}.${word}(${word}, ${word}) [example] {\n  ${word}.${word}\n}`)).toEqual({
        type: "records",
        table: qn(word, word),
        columns: [id(word), id(word)],
        settings: [{ kind: "example" }],
        rows: [{ fields: [{ kind: "enumConstant", path: [id(word), id(word)] }] }],
      });
    });
  }

  it("keeps records usable as a table and column name", () => {
    const t = only("Table records {\n  records int\n  records (records) { 1 }\n}", "table");
    expect(t.name).toEqual(qn("records"));
    expect(t.items.map((item) => item.type)).toEqual(["column", "records"]);
    expect((t.items[1] as Records).columns).toEqual([id("records")]);
  });

  it("reads `records` as a column unless `(`, `[` or `{` follows it on its line", () => {
    expect(parseError("Table t {\n  records\n  (id) { 1 }\n}")).toEqual({
      msg: "Expected a column type but found a new line",
      start: { row: 2, col: 9 },
    });
  });
});

describe("records spans", () => {
  it("spans every node of a multi-line records block", () => {
    const text = ["records s.t(a, b, c) [example] {", "  1, , e.x", "  'two',", "}"].join("\n");
    const [r] = parse(text).elements as Records[];
    expect(r!.span).toEqual(span(1, 0, 4, 1));
    expect(r!.table!.span).toEqual(span(1, 8, 1, 11));
    expect(r!.columns!.map((column) => column.span)).toEqual([
      span(1, 12, 1, 13),
      span(1, 15, 1, 16),
      span(1, 18, 1, 19),
    ]);
    expect(r!.settings[0]!.span).toEqual(span(1, 22, 1, 29));
    const [first, second] = r!.rows;
    expect(first!.span).toEqual(span(2, 2, 2, 10));
    expect(first!.fields.map((field) => field.span)).toEqual([span(2, 2, 2, 3), span(2, 4, 2, 4), span(2, 7, 2, 10)]);
    expect(second!.span).toEqual(span(3, 2, 3, 8));
    expect(second!.fields.map((field) => field.span)).toEqual([span(3, 2, 3, 7), span(3, 8, 3, 8)]);
  });

  it("spans a leading empty field at the row's start, and a records block in a table", () => {
    const [t] = parse("Table t {\n  records (a) {\n    , 1\n  }\n}").elements as Table[];
    const r = t!.items[0] as Records;
    expect(r.span).toEqual(span(2, 2, 4, 3));
    expect(r.rows[0]!.fields[0]!.span).toEqual(span(3, 4, 3, 4));
  });
});

describe("records errors", () => {
  const cases: [string, string, number, number][] = [
    ["records t {\n  1\n}", 'Expected "(" but found "{"', 1, 10],
    ["records (a) {\n  1\n}", 'Expected a table name but found "("', 1, 8],
    ["records t\n(a) {\n  1\n}", 'Expected "(" but found a new line', 1, 9],
    ["records a.b.t(a) {\n  1\n}", 'Expected "(" but found "."', 1, 11],
    ["records t(a)[example] {\n  1\n}", 'Expected a space but found "["', 1, 12],
    ["records t(a)\n[example] {\n  1\n}", 'Expected "{" but found "["', 2, 0],
    ["records t(a) as x {\n  1\n}", 'Expected "[" or "{" but found "as"', 1, 13],
    ["records t(a) [foo: 1] {\n  1\n}", 'Expected "example" but found "foo"', 1, 14],
    ["records t(a) [example: true] {\n  1\n}", 'Expected "," or "]" but found ":"', 1, 21],
    ["records t(a b) {\n  1\n}", 'Expected "," or ")" but found "b"', 1, 12],
    ["records t(a,) {\n  1\n}", 'Expected a column name but found ")"', 1, 12],
    ["records t(t.a) {\n  1\n}", 'Expected "," or ")" but found "."', 1, 11],
    ["records t(a) {\n  1 'A'\n}", 'Expected ",", a new line or "}" but found a string', 2, 4],
    ["records t(a) {\n  1, 2 [x]\n}", 'Expected ",", a new line or "}" but found "["', 2, 7],
    ["records t(a) {\n  1 + 2\n}", 'Expected ",", a new line or "}" but found "+"', 2, 4],
    ["records t(a) {\n  a.b.c.d\n}", 'Expected ",", a new line or "}" but found "."', 2, 7],
    [
      "records t(a) {\n  abc\n}",
      'Expected a string, a number, an expression, "true", "false", "null" or an enum value but found "abc"',
      2,
      2,
    ],
    [
      "records t(a) {\n  #fff\n}",
      'Expected a string, a number, an expression, "true", "false", "null" or an enum value but found "#fff"',
      2,
      2,
    ],
    [
      "records t(a) {\n  (1)\n}",
      'Expected a string, a number, an expression, "true", "false", "null" or an enum value but found "("',
      2,
      2,
    ],
    ["records t(a) {\n  --1\n}", 'Expected a number but found "-"', 2, 3],
    ["records t(a) {\n  1\n", 'Expected "}" but found end of input', 3, 0],
    ["Table t {\n  records[example] { 1 }\n}", 'Expected a space but found "["', 2, 9],
    ["Table t {\n  records{ 1 }\n}", 'Expected a space but found "{"', 2, 9],
    ["Table t {\n  records (a)[example] { 1 }\n}", 'Expected a space but found "["', 2, 13],
    ["Table t {\n  records (a){ 1 }\n}", 'Expected a space but found "{"', 2, 13],
    ["Table t {\n  records(a){ 1 }\n}", 'Expected a space but found "{"', 2, 12],
    ["Table t {\n  records [example]{ 1 }\n}", 'Expected a space but found "{"', 2, 19],
    ["Table t {\n  records (a)\n  { 1 }\n}", 'Expected "[" or "{" but found a new line', 2, 13],
    ["Table t {\n  records (a) [example]\n  { 1 }\n}", 'Expected "{" but found a new line', 2, 23],
    ["Table t {\n  records t(a) { 1 }\n}", 'Expected "pk", "unique", "[", a new line or "}" but found "{"', 2, 15],
    ["Table t {\n  records (a) {\n    1\n  }\n", 'Expected "}" but found end of input', 5, 0],
  ];

  for (const [text, msg, row, col] of cases) {
    it(`rejects ${JSON.stringify(text)}`, () => {
      expect(parseError(text)).toEqual({ msg, start: { row, col } });
    });
  }
});
