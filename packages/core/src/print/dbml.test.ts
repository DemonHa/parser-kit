import { describe, expect, it } from "vitest";
import { block, type Doc, join, list, render } from "./index";

// A genericity guard: a tiny printer for a DBML-shaped schema language, written
// against the public IR only. Its layout is fixed (tabs, one column per line,
// settings lists in brackets), so it never depends on the width.

type ColumnSetting =
  | { kind: "pk" }
  | { kind: "increment" }
  | { kind: "unique" }
  | { kind: "notNull" }
  | { kind: "default"; value: string }
  | { kind: "note"; text: string };

interface Column {
  name: string;
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
// single-quoted with backslash escapes. Quoting is decided from the value.
const name = (n: string): string => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(n) ? n : `"${n.replace(/["\\]/g, "\\$&")}"`);
const str = (s: string): string => `'${s.replace(/['\\]/g, "\\$&")}'`;

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

const column = (c: Column): Doc => [name(c.name), " ", c.type, settings(c.settings.map(columnSetting))];

const index = (i: Index): Doc => {
  const cols = i.columns.length === 1 ? name(i.columns[0]!) : ["(", join(", ", i.columns.map(name)), ")"];
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

const schema = (tables: Table[]): Doc => join(["\n", "\n"], tables.map(table));

const print = (tables: Table[], width = Number.POSITIVE_INFINITY) => render(schema(tables), { width, indent: "\t" });

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

  it("is a fixed layout: the same output at any reasonable width", () => {
    const expected = print([users, tags]);
    expect(print([users, tags], 80)).toBe(expected);
    expect(print([users, tags], 60)).toBe(expected);
  });
});
