import { describe, expect, it } from "vitest";
import { block, type Doc, hardline, join, list, quoting, render } from "./index";

// A genericity guard: a tiny printer for a DBML-shaped schema language, written
// against the public IR only. Its layout is fixed (tabs, one column per line,
// settings lists in brackets). DBML reads newlines as meaningful and `list()`
// is a group that can break, so the printer always renders at width Infinity:
// only the hard lines inside blocks break.

type ColumnSetting =
  | { kind: "pk" }
  | { kind: "increment" }
  | { kind: "unique" }
  | { kind: "notNull" }
  | { kind: "default"; value: string }
  | { kind: "note"; text: string };

interface Column {
  name: string;
  /** The source quoted the name. Kept where still valid, so editor text round-trips. */
  quoted?: true;
  type: string;
  settings: ColumnSetting[];
}

interface Index {
  columns: string[];
  settings: ("pk" | "unique")[];
}

interface Table {
  name: string;
  alias?: string;
  headerColor?: string;
  columns: Column[];
  indexes: Index[];
  note?: string;
}

// Names are bare words when they can be, else double-quoted. Strings are
// single-quoted. Both use backslash escapes. Quoting is decided from the value,
// so a hand-built tree with a bad hint still prints valid text.
const quoteName = quoting({
  quote: '"',
  escape: "backslash",
  start: /[A-Za-z_]/,
  part: /[A-Za-z0-9_]/,
  reserved: (w) => ["table", "enum", "ref", "note", "indexes", "project"].includes(w.toLowerCase()),
});
const name = (n: string, quoted?: true): string => quoteName(n, "preserve-if-valid", quoted);
const str = quoting({ quote: "'", escape: "backslash" });

const columnSetting = (s: ColumnSetting): Doc => {
  switch (s.kind) {
    case "pk":
      return "pk";
    case "increment":
      return "increment";
    case "unique":
      return "unique";
    case "notNull":
      return "not null";
    case "default":
      return ["default: ", s.value];
    case "note":
      return ["note: ", str(s.text)];
  }
};

const settings = (items: Doc[]): Doc => list(" [", items, "]", { empty: "omit" });

const column = (c: Column): Doc => [name(c.name, c.quoted), " ", c.type, settings(c.settings.map(columnSetting))];

const index = (i: Index): Doc => {
  const names = i.columns.map((c) => name(c));
  const cols = names.length === 1 ? names[0]! : ["(", join(", ", names), ")"];
  return [cols, settings(i.settings)];
};

const table = (t: Table): Doc => {
  const header: Doc = [
    "Table ",
    name(t.name),
    t.alias ? [" as ", name(t.alias)] : "",
    settings(t.headerColor ? [["headercolor: ", t.headerColor]] : []),
  ];
  const body: Doc[] = t.columns.map(column);
  if (t.indexes.length > 0) body.push("", block("Indexes", t.indexes.map(index)));
  if (t.note !== undefined) body.push("", ["Note: ", str(t.note)]);
  return block(header, body);
};

const schema = (tables: Table[]): Doc => join([hardline, hardline], tables.map(table));

const print = (tables: Table[]) => render(schema(tables), { width: Number.POSITIVE_INFINITY, indent: "\t" });

const users: Table = {
  name: "users",
  alias: "U",
  headerColor: "#3498DB",
  columns: [
    { name: "id", type: "int", settings: [{ kind: "pk" }, { kind: "increment" }] },
    { name: "email", type: "varchar", settings: [{ kind: "unique" }, { kind: "notNull" }] },
    { name: "First Name", type: "varchar", settings: [{ kind: "note", text: "it's what they're called" }] },
    { name: "created_at", type: "timestamp", settings: [{ kind: "default", value: "`now()`" }] },
  ],
  indexes: [
    { columns: ["email"], settings: ["unique"] },
    { columns: ["id", "created_at"], settings: [] },
  ],
  note: "Everyone who signed up",
};

const tags: Table = {
  name: "tags",
  columns: [{ name: "label", type: "text", settings: [] }],
  indexes: [],
};

describe("a DBML-shaped printer on the doc IR", () => {
  it("prints tables with tab indentation, nested blocks and settings lists", () => {
    expect(print([users, tags])).toBe(
      [
        "Table users as U [headercolor: #3498DB] {",
        "\tid int [pk, increment]",
        "\temail varchar [unique, not null]",
        "\t\"First Name\" varchar [note: 'it\\'s what they\\'re called']",
        "\tcreated_at timestamp [default: `now()`]",
        "",
        "\tIndexes {",
        "\t\temail [unique]",
        "\t\t(id, created_at)",
        "\t}",
        "",
        "\tNote: 'Everyone who signed up'",
        "}",
        "",
        "Table tags {",
        "\tlabel text",
        "}",
      ].join("\n"),
    );
  });

  it("drops settings lists entirely when they are empty", () => {
    const out = print([tags]);
    expect(out).not.toContain("[");
    expect(out).toBe("Table tags {\n\tlabel text\n}");
  });

  it("prints an empty table body as {}", () => {
    expect(print([{ name: "empty", columns: [], indexes: [] }])).toBe("Table empty {}");
  });

  it("prints every table field it is given, not just every node kind", () => {
    const out = print([users]);
    for (const needle of ["as U", "headercolor: #3498DB", "Indexes {", "Note: 'Everyone who signed up'"]) {
      expect(out).toContain(needle);
    }
  });

  it("escapes quotes from the value, so hand-built trees stay valid", () => {
    const out = print([
      { name: 'say "hi"', columns: [{ name: "a b", type: "int", settings: [] }], indexes: [], note: "\\'" },
    ]);
    expect(out).toBe('Table "say \\"hi\\"" {\n\t"a b" int\n\n\tNote: \'\\\\\\\'\'\n}');
  });

  it("keeps a quoted hint, quotes reserved words and ignores a bare hint that would be invalid", () => {
    const out = print([
      {
        name: "Note",
        columns: [
          { name: "id", quoted: true, type: "int", settings: [] },
          { name: "table", type: "int", settings: [] },
          { name: "9lives", type: "int", settings: [] },
        ],
        indexes: [],
      },
    ]);
    expect(out).toBe('Table "Note" {\n\t"id" int\n\t"table" int\n\t"9lives" int\n}');
  });

  it("keeps settings lists on one line however long they get", () => {
    const longNote = "x".repeat(200);
    const out = print([
      {
        name: "t",
        columns: [{ name: "c", type: "int", settings: [{ kind: "pk" }, { kind: "note", text: longNote }] }],
        indexes: [],
      },
    ]);
    expect(out).toBe(`Table t {\n\tc int [pk, note: '${longNote}']\n}`);
  });

  it("would break a settings list at a finite width, which is why it renders at Infinity", () => {
    const d = column({ name: "c", type: "int", settings: [{ kind: "pk" }, { kind: "unique" }] });
    expect(render(d, { width: 10 })).toBe("c int [\n  pk,\n  unique\n]");
  });
});
