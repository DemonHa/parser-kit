import { describe, expect, it } from "vitest";
import type { Column, Setting, Table } from "../src/index";
import { id, only, parse, parseError, qn, span } from "./helpers";

const table = (text: string): Table => only(text, "table");
const columns = (body: string): Column[] => table(`Table t {\n${body}\n}`).items as Column[];
const column = (line: string): Column => {
  const all = columns(line);
  expect(all).toHaveLength(1);
  return all[0]!;
};
const settings = (line: string): Setting[] => column(line).settings;
const defaultValue = (text: string) => {
  const [setting] = settings(`id int [default: ${text}]`);
  expect(setting!.kind).toBe("default");
  return (setting as Extract<Setting, { kind: "default" }>).value;
};

describe("Table header", () => {
  it("parses a name, a schema, an alias and settings", () => {
    expect(table("Table s.users as U [headercolor: #3498DB, note: 'People'] {\n  id int\n}")).toEqual({
      type: "table",
      name: qn("users", "s"),
      alias: id("U"),
      settings: [
        { kind: "property", key: id("headercolor"), value: { kind: "color", value: "#3498DB" } },
        { kind: "note", value: { kind: "string", value: "People" } },
      ],
      items: [
        { type: "column", name: id("id"), dataType: { name: qn("int"), args: null, arraySizes: [] }, settings: [] },
      ],
    });
  });

  it("keeps quoted names and their decoded text", () => {
    const { name, alias } = table('Table "my schema"."order items" as "o i" {\n id int\n}');
    expect(name).toEqual({ schema: id("my schema", true), name: id("order items", true) });
    expect(alias).toEqual(id("o i", true));
  });

  it("keeps the case of names and matches keywords in any case", () => {
    const { name, alias } = table("TABLE Users AS U {\n id int\n}");
    expect(name).toEqual(qn("Users"));
    expect(alias).toEqual(id("U"));
    expect(table("table t {\n id int\n}").name).toEqual(qn("t"));
  });

  it("takes custom properties with multi-word keys, keeping their case", () => {
    expect(table("Table t [Owner Team: 'core', pii: true, rank: -2, tint: #fff] {\n id int\n}").settings).toEqual([
      { kind: "property", key: id("Owner Team"), value: { kind: "string", value: "core" } },
      { kind: "property", key: id("pii"), value: { kind: "boolean", value: true } },
      { kind: "property", key: id("rank"), value: { kind: "number", value: -2 } },
      { kind: "property", key: id("tint"), value: { kind: "color", value: "#fff" } },
    ]);
  });

  it("takes `none` as a custom property value, as @dbml/core does", () => {
    expect(table("Table t [tint: None] {\n id int [tint: none]\n}")).toMatchObject({
      settings: [{ kind: "property", key: id("tint"), value: { kind: "identifier", value: id("None") } }],
      items: [{ settings: [{ kind: "property", key: id("tint"), value: { kind: "identifier", value: id("none") } }] }],
    });
  });

  it("lowercases the key of a known color setting", () => {
    expect(table("Table t [HeaderColor: #fff] {\n id int\n}").settings).toEqual([
      { kind: "property", key: id("headercolor"), value: { kind: "color", value: "#fff" } },
    ]);
  });

  it("dedents a note setting", () => {
    expect(table("Table t [note: '''\n  a\n    b''']\n{\n id int\n}").settings).toEqual([
      { kind: "note", value: { kind: "string", value: "a\n  b", multiline: true } },
    ]);
  });

  it("lets line breaks separate the parts of the header", () => {
    expect(table("Table\ns.t\nas\nT [\n  headercolor: #fff\n]\n{\n id int\n}")).toEqual(
      table("Table s.t as T [headercolor: #fff] {\n id int\n}"),
    );
  });

  it("takes a settings list on a later line when a space or a comment ends the name's line", () => {
    const expected = table("Table a [note: 'x'] {\n id int\n}");
    expect(table("Table a \n[note: 'x'] {\n id int\n}")).toEqual(expected);
    expect(table("Table a // c\n\n[note: 'x'] {\n id int\n}")).toEqual(expected);
  });

  it("takes an empty settings list and an empty body", () => {
    expect(table("Table t [] {}")).toEqual({ type: "table", name: qn("t"), alias: null, settings: [], items: [] });
  });
});

describe("Table body", () => {
  it("allows a body on one line and the close after the last item", () => {
    expect(table("Table a { id int }").items).toHaveLength(1);
    expect(table("Table a { id int\n name text }").items).toHaveLength(2);
  });

  it("skips blank lines, comments and carriage returns", () => {
    const text = "Table a { // users\r\n\r\n  id int // key\r\n  /* gone */\r\n\r\n  name text\r\n}\r\n";
    expect(table(text).items.map((item) => (item as Column).name.value)).toEqual(["id", "name"]);
  });

  it("parses several tables, on separate lines or sharing one", () => {
    const doc = parse("Table a {\n id int\n} Table b {\n id int\n}\n\n\nTable c { id int }");
    expect(doc.elements.map((element) => element.type)).toEqual(["table", "table", "table"]);
  });
});

describe("Column types", () => {
  it("parses arguments of every kind", () => {
    expect(column("price decimal(10, 2)").dataType).toEqual({
      name: qn("decimal"),
      args: [
        { kind: "number", value: 10 },
        { kind: "number", value: 2 },
      ],
      arraySizes: [],
    });
    expect(column("v varchar(MAX)").dataType.args).toEqual([{ kind: "identifier", value: id("MAX") }]);
    expect(column("e enum('a', \"b\", -1, 1.5)").dataType.args).toEqual([
      { kind: "string", value: "a" },
      { kind: "identifier", value: id("b", true) },
      { kind: "number", value: -1 },
      { kind: "number", value: 1.5, raw: "1.5" },
    ]);
    expect(column("v varchar()").dataType.args).toEqual([]);
    expect(column("v varchar (255)").dataType.args).toEqual([{ kind: "number", value: 255 }]);
    expect(column("v int (1) []").dataType).toEqual({
      name: qn("int"),
      args: [{ kind: "number", value: 1 }],
      arraySizes: [],
    });
  });

  it("lets type arguments span lines", () => {
    expect(column("v decimal(\n  10,\n  2\n)").dataType.args).toHaveLength(2);
  });

  it("reads array suffixes touching the type, with or without a size", () => {
    expect(column("tags text[]").dataType).toEqual({ name: qn("text"), args: null, arraySizes: [null] });
    expect(column("grid int[][3]").dataType.arraySizes).toEqual([null, { kind: "number", value: 3 }]);
    expect(column("v int[1.5]").dataType.arraySizes).toEqual([{ kind: "number", value: 1.5, raw: "1.5" }]);
    expect(column("v varchar(10)[]").dataType).toEqual({
      name: qn("varchar"),
      args: [{ kind: "number", value: 10 }],
      arraySizes: [null],
    });
  });

  it("reads `[]` after a space as an empty settings list", () => {
    expect(column("v int []")).toEqual({
      type: "column",
      name: id("v"),
      dataType: { name: qn("int"), args: null, arraySizes: [] },
      settings: [],
    });
  });

  it("reads a `[` opening a line right after the type as an array suffix, as @dbml/core does", () => {
    expect(column("v int\n[]").dataType.arraySizes).toEqual([null]);
    expect(column("v int\n\n  [3]\n  [] [pk]")).toEqual({
      type: "column",
      name: id("v"),
      dataType: { name: qn("int"), args: null, arraySizes: [{ kind: "number", value: 3 }, null] },
      settings: [{ kind: "pk", spelling: "pk" }],
    });
    expect(parseError("Table t {\n  v int\n  [pk]\n}")).toEqual({
      msg: 'Expected a number or "]" but found "pk"',
      start: { row: 3, col: 3 },
    });
    // Only when the line break directly follows the type: not after a space or a settings list.
    const item = 'Expected a column, a note, a partial injection, records, "indexes" or "checks" but found "["';
    expect(parseError("Table t {\n  v int  \n  []\n}")).toEqual({ msg: item, start: { row: 3, col: 2 } });
    expect(parseError("Table t {\n  v int [pk]\n  []\n}")).toEqual({ msg: item, start: { row: 3, col: 2 } });
  });

  it("parses quoted and schema-qualified types", () => {
    expect(column('v "double precision"').dataType.name).toEqual({ schema: null, name: id("double precision", true) });
    expect(column("status s.job_status").dataType.name).toEqual(qn("job_status", "s"));
    expect(column('status "s"."t"[]').dataType).toEqual({
      name: { schema: id("s", true), name: id("t", true) },
      args: null,
      arraySizes: [null],
    });
  });

  it("lets line breaks surround the dots of a type and a table name", () => {
    expect(column("v s\n.\nt").dataType.name).toEqual(qn("t", "s"));
    expect(table("Table s\n.a {\n id int\n}").name).toEqual(qn("a", "s"));
  });

  it("keeps the case of the type", () => {
    expect(column("id INT").dataType.name).toEqual(qn("INT"));
  });
});

describe("Column settings", () => {
  it("parses every flag, in order, duplicates kept", () => {
    expect(settings("id int [pk, primary key, PRIMARY  KEY, null, not null, unique, increment, pk]")).toEqual([
      { kind: "pk", spelling: "pk" },
      { kind: "pk", spelling: "primary key" },
      { kind: "pk", spelling: "primary key" },
      { kind: "null", not: false },
      { kind: "null", not: true },
      { kind: "unique" },
      { kind: "increment" },
      { kind: "pk", spelling: "pk" },
    ]);
  });

  it("takes bare pk and unique after the type", () => {
    expect(settings("id int pk unique [note: 'x']")).toEqual([
      { kind: "pk", spelling: "pk", bare: true },
      { kind: "unique", bare: true },
      { kind: "note", value: { kind: "string", value: "x" } },
    ]);
    expect(settings("id int PK")).toEqual([{ kind: "pk", spelling: "pk", bare: true }]);
  });

  it("parses inline refs, repeated", () => {
    expect(settings("user_id int [ref: > users.id, ref: -? s.accounts.id]")).toEqual([
      {
        kind: "ref",
        relation: { op: ">" },
        target: { table: qn("users"), columns: [id("id")], composite: false },
      },
      {
        kind: "ref",
        relation: { op: "-", rightOptional: true },
        target: { table: qn("accounts", "s"), columns: [id("id")], composite: false },
      },
    ]);
  });

  it("reads double-quoted text as a string in notes and custom properties", () => {
    expect(settings('id int [note: "x", owner: "y"]')).toEqual([
      { kind: "note", value: { kind: "string", value: "x", doubleQuoted: true } },
      { kind: "property", key: id("owner"), value: { kind: "string", value: "y", doubleQuoted: true } },
    ]);
  });

  it("parses custom properties", () => {
    expect(settings("email text [pii: true, Owner: 'growth']")).toEqual([
      { kind: "property", key: id("pii"), value: { kind: "boolean", value: true } },
      { kind: "property", key: id("Owner"), value: { kind: "string", value: "growth" } },
    ]);
  });

  it("lets a settings list span lines", () => {
    expect(settings("id int [\n  pk,\n  note: 'x'\n]")).toEqual([
      { kind: "pk", spelling: "pk" },
      { kind: "note", value: { kind: "string", value: "x" } },
    ]);
  });

  it("dedents a column note", () => {
    expect(settings("id int [note: '''\n    one\n    two\n  ''']")).toEqual([
      { kind: "note", value: { kind: "string", value: "one\ntwo\n", multiline: true } },
    ]);
  });
});

describe("Column defaults", () => {
  it("parses strings, expressions, booleans and null", () => {
    expect(defaultValue("'draft'")).toEqual({ kind: "string", value: "draft" });
    expect(defaultValue("'''a\n  b'''")).toEqual({ kind: "string", value: "a\n  b", multiline: true });
    expect(defaultValue("`now()`")).toEqual({ kind: "expression", value: "now()" });
    expect(defaultValue("TRUE")).toEqual({ kind: "boolean", value: true });
    expect(defaultValue("false")).toEqual({ kind: "boolean", value: false });
    expect(defaultValue("NULL")).toEqual({ kind: "null" });
  });

  it("reads double-quoted text as a string", () => {
    expect(defaultValue('"draft"')).toEqual({ kind: "string", value: "draft", doubleQuoted: true });
  });

  it("parses enum values", () => {
    expect(defaultValue("status.active")).toEqual({ kind: "enumConstant", path: [id("status"), id("active")] });
    expect(defaultValue('s.status."in review"')).toEqual({
      kind: "enumConstant",
      path: [id("s"), id("status"), id("in review", true)],
    });
    expect(defaultValue("true.x")).toEqual({ kind: "enumConstant", path: [id("true"), id("x")] });
    expect(defaultValue("null.x")).toEqual({ kind: "enumConstant", path: [id("null"), id("x")] });
  });

  it("folds a sign into a number and keeps the text of any non-integer spelling", () => {
    expect(defaultValue("42")).toEqual({ kind: "number", value: 42 });
    expect(defaultValue("-7")).toEqual({ kind: "number", value: -7 });
    expect(defaultValue("- 7")).toEqual({ kind: "number", value: -7 });
    expect(defaultValue("+1")).toEqual({ kind: "number", value: 1, raw: "+1" });
    expect(defaultValue("-1.50")).toEqual({ kind: "number", value: -1.5, raw: "-1.50" });
    expect(defaultValue("1.0")).toEqual({ kind: "number", value: 1, raw: "1.0" });
    expect(defaultValue("5.")).toEqual({ kind: "number", value: 5, raw: "5." });
    expect(defaultValue("1e2")).toEqual({ kind: "number", value: 100, raw: "1e2" });
    expect(defaultValue("007")).toEqual({ kind: "number", value: 7, raw: "007" });
    expect(defaultValue("-0")).toEqual({ kind: "number", value: -0, raw: "-0" });
    expect(defaultValue("9007199254740993")).toEqual({
      kind: "number",
      value: 9007199254740992,
      raw: "9007199254740993",
    });
  });
});

describe("Table notes", () => {
  it("parses the inline and block forms", () => {
    expect(table("Table t {\n id int\n Note: 'inline'\n note {\n  'block'\n }\n}").items.slice(1)).toEqual([
      { type: "note", value: { kind: "string", value: "inline" }, form: "inline" },
      { type: "note", value: { kind: "string", value: "block" }, form: "block" },
    ]);
  });

  it("takes line breaks before the colon and double-quoted text", () => {
    expect(table('Table t {\n Note\n\n : "x"\n}').items).toEqual([
      { type: "note", value: { kind: "string", value: "x", doubleQuoted: true }, form: "inline" },
    ]);
  });

  it("lets the text start on the next line and closes a block on its line", () => {
    expect(table("Table t {\n Note:\n\n 'x'\n Note { 'y'\n }\n}").items).toEqual([
      { type: "note", value: { kind: "string", value: "x" }, form: "inline" },
      { type: "note", value: { kind: "string", value: "y" }, form: "block" },
    ]);
  });

  it("dedents a multi-line note", () => {
    const [note] = table("Table t {\n  Note: '''\n    # Title\n      body\n  '''\n}").items;
    expect(note).toEqual({
      type: "note",
      value: { kind: "string", value: "# Title\n  body\n", multiline: true },
      form: "inline",
    });
  });
});

describe("Contextual keywords", () => {
  const words = [
    "note",
    "ref",
    "indexes",
    "checks",
    "records",
    "table",
    "enum",
    "project",
    "pk",
    "null",
    "default",
    "as",
    "unique",
    "primary",
    "not",
    "increment",
    "Note",
    "TABLE",
    "key",
    "true",
    "false",
    "headercolor",
    "color",
  ];

  for (const word of words) {
    it(`keeps ${word} usable as a name`, () => {
      const t = table(`Table ${word}.${word} as ${word} {\n  ${word} ${word}\n  x ${word}.${word}(${word})[] pk\n}`);
      expect(t.name).toEqual(qn(word, word));
      expect(t.alias).toEqual(id(word));
      expect(t.items).toEqual([
        { type: "column", name: id(word), dataType: { name: qn(word), args: null, arraySizes: [] }, settings: [] },
        {
          type: "column",
          name: id("x"),
          dataType: { name: qn(word, word), args: [{ kind: "identifier", value: id(word) }], arraySizes: [null] },
          settings: [{ kind: "pk", spelling: "pk", bare: true }],
        },
      ]);
    });
  }

  it("reads `note` as a column when `{` follows on a later line", () => {
    expect(parseError("Table t {\n  note\n  { 'x' }\n}")).toEqual({
      msg: "Expected a column type but found a new line",
      start: { row: 2, col: 6 },
    });
  });

  it("reads `note note` and `note text` as columns", () => {
    expect(columns("note note\nnote text").map((c) => c.dataType.name.name.value)).toEqual(["note", "text"]);
  });
});

describe("Table spans", () => {
  it("spans every node of a multi-line table", () => {
    const text = [
      "Table s.users as U [note: 'x'] {",
      "  id int [pk, default: -1]",
      "  name varchar(255)",
      "  Note: 'People'",
      "  status s.st [default: s.st.on]",
      "  Note {",
      "    'x'",
      "  }",
      "}",
    ].join("\n");
    const [t] = parse(text).elements as Table[];
    expect(t!.span).toEqual(span(1, 0, 9, 1));
    expect(t!.name.span).toEqual(span(1, 6, 1, 13));
    expect(t!.name.schema!.span).toEqual(span(1, 6, 1, 7));
    expect(t!.alias!.span).toEqual(span(1, 17, 1, 18));
    expect(t!.settings[0]!.span).toEqual(span(1, 20, 1, 29));
    const [id, name, note] = t!.items as [Column, Column, Extract<Table["items"][number], { type: "note" }>];
    expect(id.span).toEqual(span(2, 2, 2, 26));
    expect(id.dataType.span).toEqual(span(2, 5, 2, 8));
    expect(id.settings.map((setting) => setting.span)).toEqual([span(2, 10, 2, 12), span(2, 14, 2, 25)]);
    const dflt = id.settings[1] as Extract<Setting, { kind: "default" }>;
    expect(dflt.value.span).toEqual(span(2, 23, 2, 25));
    expect(name.dataType.span).toEqual(span(3, 7, 3, 19));
    expect(name.dataType.args![0]!.span).toEqual(span(3, 15, 3, 18));
    expect(note.span).toEqual(span(4, 2, 4, 16));
    expect(note.value.span).toEqual(span(4, 8, 4, 16));
    const status = t!.items[3] as Column;
    expect(status.settings[0]!.span).toEqual(span(5, 15, 5, 31));
    expect((status.settings[0] as Extract<Setting, { kind: "default" }>).value.span).toEqual(span(5, 24, 5, 31));
    const block = t!.items[4]!;
    expect(block.span).toEqual(span(6, 2, 8, 3));
    expect((block as typeof note).value.span).toEqual(span(7, 4, 7, 7));
  });
});

describe("Table errors", () => {
  const cases: [string, string, number, number][] = [
    ["Table t {\n  id int\n", 'Expected "}" but found end of input', 3, 0],
    ["Table {\n id int\n}", 'Expected a table name but found "{"', 1, 6],
    ["Table s.t A {\n id int\n}", 'Expected "as", "[" or "{" but found "A"', 1, 10],
    ["Table a.b.c {\n id int\n}", 'Expected "as", "[" or "{" but found "."', 1, 9],
    ["Table t as {\n id int\n}", 'Expected an alias but found "{"', 1, 11],
    ["Table t as T\n[headercolor: #fff] {\n id int\n}", 'Expected "{" but found "["', 2, 0],
    ["Table t [pk] {\n id int\n}", 'Expected ":" but found "]"', 1, 11],
    ["Table t {\n  id\n}", "Expected a column type but found a new line", 2, 4],
    ["Table t {\n  id int, name text\n}", 'Expected "pk", "unique", "[", a new line or "}" but found ","', 2, 8],
    ["Table t {\n  id int not null\n}", 'Expected "pk", "unique", "[", a new line or "}" but found "not"', 2, 9],
    ["Table t {\n  id int [pk] unique\n}", 'Expected a new line or "}" but found "unique"', 2, 14],
    ["Table t {\n  id int [pk,]\n}", 'Expected a column setting but found "]"', 2, 13],
    ["Table t {\n  id int [, pk]\n}", 'Expected a column setting but found ","', 2, 10],
    ["Table t {\n  id int [pk: true]\n}", 'Expected "," or "]" but found ":"', 2, 12],
    ["Table t {\n  id int [primary]\n}", 'Expected ":" but found "]"', 2, 17],
    ["Table t {\n  id int [pk unique]\n}", 'Expected ":" but found "]"', 2, 19],
    [
      'Table t {\n  id int "pk"\n}',
      'Expected "pk", "unique", "[", a new line or "}" but found a quoted identifier',
      2,
      9,
    ],
    ["Table a \nx {\n  id int\n}", 'Expected "as", "[" or "{" but found "x"', 2, 0],
    [
      "Table t {\n  id int [default: foo]\n}",
      'Expected a string, a number, an expression, "true", "false", "null" or an enum value but found "foo"',
      2,
      19,
    ],
    [
      "Table t {\n  id int [foo: null]\n}",
      'Expected a string, a number, a boolean, a color or "none" but found "null"',
      2,
      15,
    ],
    ["Table t [headercolor: 'red'] {\n  id int\n}", "Expected a color but found a string", 1, 22],
    ["Table t {\n  id int [note: 'a' 'b']\n}", 'Expected "," or "]" but found a string', 2, 20],
    ["Table t {\n  id int[x]\n}", 'Expected a number or "]" but found "x"', 2, 9],
    ["Table t {\n  id int[-1]\n}", 'Expected a number or "]" but found "-"', 2, 9],
    ["Table t {\n  id 'text'\n}", "Expected a column type but found a string", 2, 5],
    ["Table t {\n  id int(`x`)\n}", "Expected a number, a string or a name but found an expression", 2, 9],
    ["Table t {\n  Note { }\n}", 'Expected a string but found "}"', 2, 9],
    ["Table t {\n  Note { 'a' 'b' }\n}", 'Expected "}" but found a string', 2, 13],
    ["Table t {\n  Note: 'a' [color: #fff]\n}", 'Expected a new line or "}" but found "["', 2, 12],
    ["Table t {\n  id int [ref: > users.(id)]\n}", 'Expected a column name but found "("', 2, 23],
    [
      "Table t {\n  [pk]\n}",
      'Expected a column, a note, a partial injection, records, "indexes" or "checks" but found "["',
      2,
      2,
    ],
    ["Table t {\n  id:int\n}", 'Expected a column type but found ":"', 2, 4],
    ["Table a[note: 'x'] {\n  id int\n}", 'Expected a space but found "["', 1, 7],
    ["Table a as b[note: 'x'] {\n  id int\n}", 'Expected a space but found "["', 1, 12],
    ['Table t {\n  "id"int\n}', 'Expected a space but found "int"', 2, 6],
    ["Table t {\n  id int(1)pk\n}", 'Expected a space but found "pk"', 2, 11],
    ["Table t {\n  id int pk[note: 'x']\n}", 'Expected a space but found "["', 2, 11],
    ["Table t {\n  Note{ 'x' }\n}", 'Expected a space but found "{"', 2, 6],
    ["Table t {\n  id int [note: 'x'\n}", 'Expected "," or "]" but found "}"', 3, 0],
  ];

  for (const [text, msg, row, col] of cases) {
    it(`rejects ${JSON.stringify(text)}`, () => {
      expect(parseError(text)).toEqual({ msg, start: { row, col } });
    });
  }
});
