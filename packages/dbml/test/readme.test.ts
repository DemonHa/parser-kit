import { readFileSync } from "node:fs";
import { Parser } from "@dbml/core";
import { createInputStream, ParseError, stripSpans } from "@parser-kit/core";
import { describe, expect, it } from "vitest";
import { dbml, dbmlLexer } from "../src/index";
import { parseError } from "./helpers";

// Keeps README.md honest. The code examples are read out of the README itself
// (the DBML they parse and the output their comments promise), so editing an
// example without updating the parser, or the reverse, fails here. The claims
// in the prose sections (supported syntax, AST conventions, differences from
// @dbml/core, what isn't supported yet) are checked with equivalent inputs.

const README = readFileSync(new URL("../README.md", import.meta.url), "utf8");

/** The README's ```ts code blocks, in order. */
const blocks = [...README.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1]!);

/** The one ```ts block that contains `marker`. */
const block = (marker: string): string => {
  const found = blocks.filter((code) => code.includes(marker));
  expect(found, `one README block containing ${marker}`).toHaveLength(1);
  return found[0]!;
};

/** The text of the first template literal in `code`. */
const template = (code: string): string => /`([\s\S]*?)`\)/.exec(code)![1]!;

/** The first double-quoted string literal in `code` that follows `call`, decoded. */
const stringAfter = (code: string, call: string): string => {
  const rest = code.slice(code.indexOf(call) + call.length);
  return JSON.parse(/"(?:[^"\\]|\\.)*"/.exec(rest)![0]) as string;
};

/** The `// ` comment lines of `code` after the line containing `marker`, comment markers removed. */
const commentAfter = (code: string, marker: string): string[] =>
  code
    .slice(code.indexOf(marker))
    .split("\n")
    .slice(1)
    .filter((line) => line.startsWith("//"))
    .map((line) => line.replace(/^\/\/ ?/, ""));

const accepts = (text: string): boolean => dbml.diagnose(text).errors.length === 0;

describe("README examples", () => {
  it("quick start: parses the two tables and prints their column counts", () => {
    const code = block("for (const element of doc.elements)");
    const doc = dbml.parse(template(code));
    const printed: string[] = [];
    for (const element of doc.elements) {
      if (element.type === "table") printed.push(`${element.name.name.value} ${element.items.length}`);
    }
    expect(printed).toEqual(commentAfter(code, "console.log"));
    expect(printed).toEqual(["users 2", "posts 3"]);
  });

  it("parse throws a ParseError whose message carries the position", () => {
    const code = block('uniq]\\n}");');
    const source = stringAfter(code, "dbml.parse(");
    expect(() => dbml.parse(source)).toThrow(ParseError);
    try {
      dbml.parse(source);
    } catch (error) {
      expect(`ParseError: ${(error as ParseError).message}`).toBe(commentAfter(code, "dbml.parse(")[0]);
      expect((error as ParseError).msg).toBe('Expected ":" but found "]"');
      expect((error as ParseError).start).toEqual({ row: 2, col: 22 });
    }
  });

  it("diagnose reports both errors and keeps the rest", () => {
    const code = block("dbml.diagnose(");
    const { ast, errors } = dbml.diagnose(template(code));
    const comments = commentAfter(code, "`);");
    expect(errors.map((error) => error.message)).toEqual([comments[0]!.replace(/^errors: /, ""), comments[1]!.trim()]);
    expect(comments[2]).toBe("ast.elements: the users table (columns id and email) and the status enum");
    expect(ast.elements.map((element) => element.type)).toEqual(["table", "enum"]);
    const [users] = ast.elements;
    expect(users?.type === "table" && users.items.map((item) => item.type === "column" && item.name.value)).toEqual([
      "id",
      "email",
    ]);
  });

  it("diagnose never throws and parse throws diagnose's first error", () => {
    const source = template(block("dbml.diagnose("));
    const first = dbml.diagnose(source).errors[0]!;
    expect(parseError(source)).toEqual({ msg: first.msg, start: first.start });
  });

  it("the methods work detached", () => {
    const { parse } = dbml;
    expect(["Table a { id int }", "Table b { id int }"].map(parse)).toHaveLength(2);
  });

  it("the column example matches the stripped AST in its comment", () => {
    const code = block("stripSpans(table.items[0]);");
    const source = stringAfter(code, "dbml.parse(");
    const [table] = dbml.parse(source).elements;
    expect(table?.type).toBe("table");
    const expected = new Function(`return (${commentAfter(code, "stripSpans(table.items[0]);").join("\n")});`)();
    expect(table?.type === "table" && stripSpans(table.items[0])).toEqual(expected);
  });
});

describe("README supported syntax", () => {
  it("parses a document using every listed construct", () => {
    const doc = dbml.parse(`
Project shop {
  database_type: 'PostgreSQL'
  Note: 'The shop'
}
Project {
  owner: 'me'
  Note { 'block form' }
}
Table s."order items" as U [headercolor: #3498DB, note: 'items', owner team: 'billing'] {
  id int pk
  qty decimal(10, 2) [default: -1.5e2, check: \`qty > 0\`, check: \`qty < 100\`]
  name varchar(MAX) [not null, unique, note: 'it\\'s', pii: true]
  tags int[]
  grid int[3]
  ratio "double precision" [null, default: \`now()\`]
  state s.status [default: s.status.active]
  user_id int [
    ref: > users.id,
    ref: - profiles.id
  ]
  serial int [primary key, increment, default: true]
  Note: 'table note'
  indexes {
    (id, name) [pk]
    \`lower(name)\` [name: 'lower_name', type: hash]
    (\`id*3\`, id) [unique, note: 'mixed']
    id name
    (id [asc], name [desc])
  }
  checks {
    \`qty >= 0\` [name: 'positive_qty']
  }
  ~base
  records (id, qty) {
    1, 2
  }
}
Table a { id int }
Table users { id int }
Table profiles { id int }
Table t { a int
  b int
  c int }
Table t2 { a int
  b int
  c int }
Ref named: users.id < profiles.id
Ref { users.id - profiles.id [delete: cascade, update: set null, color: #fff, inactive, note: 'n', custom: 1] }
Ref: users.id <> profiles.id
Ref: users.id >? profiles.id
Ref: users.id ?<>? profiles.id
Ref: t.(a, b) > t2.(a, b)
Ref: s.users.id > profiles.id [update: no action, delete: set default]
Ref: users.id > profiles.id [delete: restrict]
enum v2.job_status as JobStatus {
  active
  "on hold" [note: 'paused']
}
TableGroup g [color: #abc, note: 'group', custom: 'x'] {
  users
  s.posts
  Note: 'group note'
}
Note sticky [color: #fff] { 'a sticky note' }
TablePartial base [headercolor: #000, note: 'partial'] {
  created_at timestamp
  Note: 'partial note'
  indexes { created_at }
  checks { \`created_at > 0\` }
}
records users(id, name) [example] {
  1, 'A'
  -2, , \`now()\`
  3, true, null, status.active
  4, false,
}
`);
    expect(doc.elements.map((element) => element.type)).toEqual([
      "project",
      "project",
      "table",
      "table",
      "table",
      "table",
      "table",
      "table",
      "ref",
      "ref",
      "ref",
      "ref",
      "ref",
      "ref",
      "ref",
      "ref",
      "enum",
      "tableGroup",
      "stickyNote",
      "tablePartial",
      "records",
    ]);
  });

  it("keeps keywords contextual and case-insensitive", () => {
    expect(
      accepts("TABLE note {\n  ref int\n  table text\n  indexes int\n  records int\n  pk int\n  null int\n}"),
    ).toBe(true);
    expect(accepts("table Table as Note {\n  id int\n}\nenum ref {\n  note\n  pk\n}")).toBe(true);
  });

  it("reads the listed lexical forms", () => {
    const doc = dbml.parse(
      "// line\r\nTable bảng { /* block */ 2fa_code int [note: '''\r\n  multi\r\n  line'''] }\r\n" +
        "Table t {\n  a int [note: 'tab\\t\\u00e9 \\\nend', default: `multi\nline`]\n}",
    );
    expect(doc.elements).toHaveLength(2);
    const column = doc.elements[1]!.type === "table" ? doc.elements[1]!.items[0] : undefined;
    expect(column?.type === "column" && stripSpans(column.settings)).toEqual([
      { kind: "note", value: { kind: "string", value: "tab\té end" } },
      { kind: "default", value: { kind: "expression", value: "multi\nline" } },
    ]);
  });
});

describe("README AST conventions", () => {
  it("spans: 1-based rows, 0-based columns, quotes included", () => {
    const [table] = dbml.parse('Table "users" {\n  id int\n}').elements;
    expect(table?.type === "table" && table.name.name).toEqual({
      value: "users",
      quoted: true,
      span: { start: { row: 1, col: 6 }, end: { row: 1, col: 13 } },
    });
  });

  it("names keep their case; quoted names are decoded and flagged", () => {
    const [table] = dbml.parse('Table Users {\n  "full name" varchar\n}').elements;
    expect(table?.type === "table" && stripSpans(table.name.name)).toEqual({ value: "Users" });
    const column = table?.type === "table" ? table.items[0] : undefined;
    expect(column?.type === "column" && stripSpans(column.name)).toEqual({ value: "full name", quoted: true });
  });

  it("ref endpoints: column last, then table, then schema", () => {
    const [, ref] = dbml.parse("Table t { a int }\nRef: s.t.a > t.(a, b)").elements;
    expect(ref?.type === "ref" && stripSpans([ref.left, ref.right])).toEqual([
      { table: { schema: { value: "s" }, name: { value: "t" } }, columns: [{ value: "a" }], composite: false },
      { table: { schema: null, name: { value: "t" } }, columns: [{ value: "a" }, { value: "b" }], composite: true },
    ]);
  });

  it("strings: multiline, doubleQuoted, dedented notes", () => {
    const [table] = dbml.parse("Table t {\n  a int [note: \"x\"]\n  Note: '''\n    one\n      two'''\n}").elements;
    const items = table?.type === "table" ? stripSpans(table.items) : [];
    expect(items[0]).toMatchObject({ settings: [{ kind: "note", value: { value: "x", doubleQuoted: true } }] });
    expect(items[1]).toEqual({
      type: "note",
      form: "inline",
      value: { kind: "string", value: "one\n  two", multiline: true },
    });
  });

  it("numbers: raw only when value alone loses the text", () => {
    const defaults = (text: string) => {
      const [table] = dbml.parse(`Table t {\n  a int [default: ${text}]\n}`).elements;
      const column = table?.type === "table" ? table.items[0] : undefined;
      return column?.type === "column" ? stripSpans(column.settings[0]) : undefined;
    };
    expect(defaults("42")).toEqual({ kind: "default", value: { kind: "number", value: 42 } });
    expect(defaults("-7")).toEqual({ kind: "default", value: { kind: "number", value: -7 } });
    expect(defaults("1.50")).toMatchObject({ value: { value: 1.5, raw: "1.50" } });
    expect(defaults("1e5")).toMatchObject({ value: { value: 1e5, raw: "1e5" } });
    expect(defaults("007")).toMatchObject({ value: { value: 7, raw: "007" } });
    expect(defaults("-0")).toMatchObject({ value: { raw: "-0" } });
    expect(defaults("9007199254740993")).toMatchObject({ value: { raw: "9007199254740993" } });
  });

  it("settings: source order, duplicates kept, known value-only keys are properties", () => {
    const [table] = dbml.parse("Table t [headercolor: #fff] {\n  a int [unique, unique, owner: 'x']\n}").elements;
    expect(table?.type === "table" && stripSpans(table.settings)).toEqual([
      { kind: "property", key: { value: "headercolor" }, value: { kind: "color", value: "#fff" } },
    ]);
    const column = table?.type === "table" ? table.items[0] : undefined;
    expect(column?.type === "column" && column.settings.map((setting) => setting.kind)).toEqual([
      "unique",
      "unique",
      "property",
    ]);
  });

  it("inline refs are column settings, not elements", () => {
    const doc = dbml.parse("Table t {\n  a int [ref: > u.id]\n}");
    expect(doc.elements.map((element) => element.type)).toEqual(["table"]);
    const column = doc.elements[0]?.type === "table" ? doc.elements[0].items[0] : undefined;
    expect(column?.type === "column" && column.settings[0]?.kind).toBe("ref");
  });

  it("comments are not in the AST, but the lexer emits them", () => {
    const stream = dbmlLexer.tokenize(createInputStream("Table t { id int } // c"));
    const types: string[] = [];
    for (let token = stream.next(); token; token = stream.next()) types.push(token.type);
    expect(types).toContain("comment");
  });

  it("nothing is resolved: unknown targets, empty tables and duplicates parse", () => {
    expect(accepts("Table t {\n}\nTable t {\n  id int [ref: > x.id]\n}\nTable u {\n  ~missing\n}")).toBe(true);
  });
});

describe("README differences from @dbml/core", () => {
  it.each([
    "Table a.b.c {\n  id int\n}",
    "enum a.b.c {\n  x\n}",
    "Table t {\n  id int\n}\nrecords t(id) {\n  s.e.v.w\n}",
    "Table t {\n  id int [ref: > id]\n}",
    "Table t {\n  id int [default: --1]\n}",
    "Table t {\n  id int [default: - -1]\n}",
    "Table t {\n  id int(1)(2)\n}",
    "Table t {\n  id int[](1)\n}",
    "Table t {\n  id int[1,2]\n}",
    "---\nx: 1\n---\nTable t {\n  id int\n}",
    "Table a {\n  id int\n}\nRef r {\n}",
    "Table t {\n  id int\n  indexes {\n    id// c\n[desc]\n  }\n}",
    "Table t {\n  id int\n  indexes {\n    id\r\n[desc]\n  }\n}",
    "Table t {\n  id text// c\n[]\n}",
  ])("rejects %j", (text) => {
    expect(accepts(text)).toBe(false);
  });

  it.each([
    "Table t {\n  id/**/int\n}",
    "Table a\r\n[note: 'x'] {\n  id int\n}",
    "Table t {\n  id int\n  indexes {\n    (id)// c\n[unique]\n  }\n}",
    "Project p {\n  table: 'x'\n}",
    "Table t [headercolor: #3a5x] {\n  id int\n}",
    "Table t {\n  id int\n  indexes {\n    id [unique, unique]\n  }\n}",
  ])("accepts %j", (text) => {
    expect(accepts(text)).toBe(true);
  });

  it("reads text/* c */[] as a type and an empty settings list", () => {
    const [table] = dbml.parse("Table t {\n  a text/* c */[]\n}").elements;
    const column = table?.type === "table" ? table.items[0] : undefined;
    expect(column?.type === "column" && [column.dataType.arraySizes, column.settings]).toEqual([[], []]);
  });

  it("index fields keep their source order, where @dbml/core puts composites first", () => {
    const source = "Table t {\n  a int\n  b int\n  c int\n  indexes {\n    a (b, c)\n  }\n}";
    const [table] = dbml.parse(source).elements;
    const indexes = table?.type === "table" ? table.items[3] : undefined;
    expect(indexes?.type === "indexes" && indexes.entries[0]!.fields.map((field) => field.kind)).toEqual([
      "column",
      "composite",
    ]);
    const model = Parser.parse(source, "dbmlv2").normalize() as unknown as {
      indexes: Record<string, { columnIds: number[] }>;
      indexColumns: Record<string, { value: string }>;
    };
    const [index] = Object.values(model.indexes);
    expect(index!.columnIds.map((id) => model.indexColumns[id]!.value)).toEqual(["b", "c", "a"]);
  });

  it("an empty note is the empty string, where @dbml/core has null", () => {
    const model = Parser.parse("Table t {\n  a int [note: '']\n}", "dbmlv2").normalize() as unknown as {
      fields: Record<string, { note?: string | null }>;
    };
    expect(Object.values(model.fields).map((field) => field.note)).toEqual([null]);

    const [table] = dbml.parse("Table t {\n  a int [note: '']\n}").elements;
    const column = table?.type === "table" ? table.items[0] : undefined;
    expect(column?.type === "column" && stripSpans(column.settings[0])).toEqual({
      kind: "note",
      value: { kind: "string", value: "" },
    });
  });
});

describe("README not yet supported", () => {
  it.each([
    "DiagramView v {\n  Tables { * }\n}",
    "Dep: a -> b",
    "Metadata Table t {\n  k: 'v'\n}",
    "use * from './f'",
    "reuse * from './f'",
  ])("rejects %j", (text) => {
    expect(accepts(text)).toBe(false);
  });
});
