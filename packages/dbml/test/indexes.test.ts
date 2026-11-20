import { describe, expect, it } from "vitest";
import type {
  Checks,
  Column,
  IndexColumn,
  IndexComposite,
  IndexEntry,
  Indexes,
  IndexOrder,
  Setting,
  Table,
} from "../src/index";
import { id, only, parse, parseError, span } from "./helpers";

const table = (text: string): Table => only(text, "table");
const items = (body: string) => table(`Table t {\n  id int\n${body}\n}`).items.slice(1);
const indexes = (body: string): IndexEntry[] => {
  const [block] = items(`  indexes {\n${body}\n  }`);
  expect(block!.type).toBe("indexes");
  return (block as Indexes).entries;
};
const entry = (line: string): IndexEntry => {
  const all = indexes(line);
  expect(all).toHaveLength(1);
  return all[0]!;
};
const checks = (body: string) => {
  const [block] = items(`  checks {\n${body}\n  }`);
  expect(block!.type).toBe("checks");
  return (block as Checks).entries;
};
const columnSettings = (line: string): Setting[] => (table(`Table t {\n  ${line}\n}`).items[0] as Column).settings;

const col = (name: string, order: IndexOrder = null, quoted = false) => ({
  kind: "column" as const,
  name: id(name, quoted),
  order,
});
const expr = (value: string, order: IndexOrder = null) => ({
  kind: "expression" as const,
  expression: { kind: "expression" as const, value },
  order,
});
const comp = (...columns: ReturnType<typeof col | typeof expr>[]) => ({ kind: "composite" as const, columns });
const str = (value: string) => ({ kind: "string" as const, value });
const fields = (line: string) => entry(line).fields;

describe("indexes", () => {
  it("parses a single column", () => {
    expect(entry("id")).toEqual({ fields: [col("id")], settings: [] });
  });

  it("parses a quoted column name", () => {
    expect(fields('"order id"')).toEqual([col("order id", null, true)]);
  });

  it("parses a composite index", () => {
    expect(entry("(id, name)")).toEqual({ fields: [comp(col("id"), col("name"))], settings: [] });
  });

  it("keeps the parentheses of a single-column composite", () => {
    expect(fields("(id)")).toEqual([comp(col("id"))]);
  });

  it("takes an empty composite, as @dbml/core does", () => {
    expect(fields("()")).toEqual([comp()]);
  });

  it("parses an expression index", () => {
    expect(entry("`lower(email)`")).toEqual({ fields: [expr("lower(email)")], settings: [] });
  });

  it("parses a mixed composite of expressions and columns", () => {
    expect(fields("(`id*3`, id)")).toEqual([comp(expr("id*3"), col("id"))]);
    expect(fields("(`id*2`,`getdate()`)")).toEqual([comp(expr("id*2"), expr("getdate()"))]);
  });

  it("lets a composite span lines, sort orders included", () => {
    expect(entry("(\n      id,\n      `x`\n    ) [unique]")).toEqual(entry("(id, `x`) [unique]"));
    expect(fields("(id\n      [desc])")).toEqual([comp(col("id", "desc"))]);
  });

  it("takes several fields separated by spaces, in source order", () => {
    expect(entry("id name [unique]")).toEqual({ fields: [col("id"), col("name")], settings: [{ kind: "unique" }] });
    expect(fields("(id) name `x` ()")).toEqual([comp(col("id")), col("name"), expr("x"), comp()]);
    expect(fields("id[desc] name[asc]")).toEqual([col("id", "desc"), col("name", "asc")]);
  });

  it("takes a composite glued to the field before it", () => {
    expect(fields("lower(id)")).toEqual([col("lower"), comp(col("id"))]);
    expect(fields("`x`(`y`)(id)")).toEqual([expr("x"), comp(expr("y")), comp(col("id"))]);
    expect(entry("lower(id) [unique]").settings).toEqual([{ kind: "unique" }]);
  });

  it("takes a sort order opening a later line after a bare column or expression", () => {
    expect(entry("id\n      [desc]")).toEqual({ fields: [col("id", "desc")], settings: [] });
    expect(entry("`x`\n\n      [asc] [unique, name: 'n']")).toEqual({
      fields: [expr("x", "asc")],
      settings: [{ kind: "unique" }, { kind: "property", key: id("name"), value: str("n") }],
    });
    expect(fields("id\n      [desc] name")).toEqual([col("id", "desc"), col("name")]);
    expect(fields("id name\n      [desc]")).toEqual([col("id"), col("name", "desc")]);
  });

  it("starts a new entry at a later-line [ when a space or a spaced comment ends the line before", () => {
    expect(indexes("    id \n    [unique]")).toEqual([
      { fields: [col("id")], settings: [] },
      { fields: [], settings: [{ kind: "unique" }] },
    ]);
    expect(indexes("    (id) // c\n    [unique]")).toHaveLength(2);
    expect(indexes("    id [unique] /* c */\n    [pk]")).toHaveLength(2);
  });

  it("binds a later-line [ across blank and comment-only lines", () => {
    expect(entry("id\n\n      // c\n      [desc]").fields).toEqual([col("id", "desc")]);
  });

  it("takes a line of settings alone as an index without fields", () => {
    expect(entry("[unique, name: 'x']")).toEqual({
      fields: [],
      settings: [{ kind: "unique" }, { kind: "property", key: id("name"), value: str("x") }],
    });
    expect(entry("[]")).toEqual({ fields: [], settings: [] });
    expect(items("  indexes { [pk] }")).toEqual([
      { type: "indexes", entries: [{ fields: [], settings: [{ kind: "pk", spelling: "pk" }] }] },
    ]);
  });

  it("parses every index setting, in order", () => {
    expect(entry("(id, name) [pk, unique, name: 'idx', type: hash, note: 'n']").settings).toEqual([
      { kind: "pk", spelling: "pk" },
      { kind: "unique" },
      { kind: "property", key: id("name"), value: str("idx") },
      { kind: "property", key: id("type"), value: { kind: "identifier", value: id("hash") } },
      { kind: "note", value: str("n") },
    ]);
  });

  it("matches setting keys in any case and lowercases the known keys", () => {
    expect(entry("id [PK, Name: 'x', TYPE: BTree]").settings).toEqual([
      { kind: "pk", spelling: "pk" },
      { kind: "property", key: id("name"), value: str("x") },
      { kind: "property", key: id("type"), value: { kind: "identifier", value: id("BTree") } },
    ]);
  });

  it("takes any name as the type, bare or double-quoted", () => {
    expect(entry("id [type: gin]").settings).toEqual([
      { kind: "property", key: id("type"), value: { kind: "identifier", value: id("gin") } },
    ]);
    expect(entry('id [type: "hash"]').settings).toEqual([
      { kind: "property", key: id("type"), value: { kind: "identifier", value: id("hash", true) } },
    ]);
  });

  it("takes double-quoted and multi-line strings as names and notes", () => {
    expect(entry("id [name: \"n\", note: '''x''']").settings).toEqual([
      { kind: "property", key: id("name"), value: { kind: "string", value: "n", doubleQuoted: true } },
      { kind: "note", value: { kind: "string", value: "x", multiline: true } },
    ]);
  });

  it("keeps an index note as written, without dedenting it", () => {
    expect(entry("id [note: '''\n      a\n        b''']").settings).toEqual([
      { kind: "note", value: { kind: "string", value: "\n      a\n        b", multiline: true } },
    ]);
  });

  it("keeps duplicate settings", () => {
    expect(entry("id [unique, unique]").settings).toEqual([{ kind: "unique" }, { kind: "unique" }]);
  });

  it("takes an empty settings list", () => {
    expect(entry("id []")).toEqual({ fields: [col("id")], settings: [] });
  });

  it("parses a sort order per column inside parentheses", () => {
    expect(fields("(id [asc], name [desc], `x` [DESC], y)")).toEqual([
      comp(col("id", "asc"), col("name", "desc"), expr("x", "desc"), col("y")),
    ]);
    expect(fields("(id[asc],`x`[desc])")).toEqual([comp(col("id", "asc"), expr("x", "desc"))]);
  });

  it("parses a sort order glued to a column outside parentheses, before the settings", () => {
    expect(entry("id[desc] [unique]")).toEqual({ fields: [col("id", "desc")], settings: [{ kind: "unique" }] });
    expect(fields("`x`[asc]")).toEqual([expr("x", "asc")]);
  });

  it("reads a spaced list after a composite as the settings", () => {
    expect(entry("(id [asc]) [pk]")).toEqual({
      fields: [comp(col("id", "asc"))],
      settings: [{ kind: "pk", spelling: "pk" }],
    });
  });

  it("parses every entry of a block, skipping blank lines", () => {
    expect(indexes("    id\n\n    (id, name) [pk]\n    `lower(name)` [name: 'n']")).toHaveLength(3);
  });

  it("parses empty and single-line blocks", () => {
    expect(indexes("")).toEqual([]);
    expect(items("  indexes { id }")).toEqual([{ type: "indexes", entries: [{ fields: [col("id")], settings: [] }] }]);
    expect(table("Table t { id int\n  indexes { (id) [unique] } }").items).toHaveLength(2);
  });

  it("matches the keyword in any case and keeps several blocks", () => {
    const all = items("  INDEXES { id }\n  Indexes { (id) }");
    expect(all.map((item) => item.type)).toEqual(["indexes", "indexes"]);
  });

  it("assigns spans", () => {
    const doc = parse(
      "Table t {\n  id int\n  indexes {\n    (id [desc], `x`) [pk]\n    `y`[asc] id\n    id\n    [desc]\n  }\n}",
    );
    const block = (doc.elements[0] as Table).items[1] as Indexes;
    expect(block.span).toEqual(span(3, 2, 8, 3));
    const [first, second, third] = block.entries;
    expect(first!.span).toEqual(span(4, 4, 4, 25));
    const composite = first!.fields[0] as IndexComposite;
    expect(composite.span).toEqual(span(4, 4, 4, 20));
    expect(composite.columns[0]!.span).toEqual(span(4, 5, 4, 14));
    expect((composite.columns[0] as Extract<IndexColumn, { kind: "column" }>).name.span).toEqual(span(4, 5, 4, 7));
    expect(composite.columns[1]!.span).toEqual(span(4, 16, 4, 19));
    expect(first!.settings[0]!.span).toEqual(span(4, 22, 4, 24));
    expect(second!.span).toEqual(span(5, 4, 5, 15));
    const lone = second!.fields[0] as Extract<IndexColumn, { kind: "expression" }>;
    expect(lone.span).toEqual(span(5, 4, 5, 12));
    expect(lone.expression.span).toEqual(span(5, 4, 5, 7));
    expect(second!.fields[1]!.span).toEqual(span(5, 13, 5, 15));
    expect(third!.span).toEqual(span(6, 4, 7, 10));
    expect(third!.fields[0]!.span).toEqual(span(6, 4, 7, 10));
  });
});

describe("checks", () => {
  it("parses expressions with and without a name", () => {
    expect(checks("    `price > 0`\n    `price < 100` [name: 'cap']")).toEqual([
      { expression: { kind: "expression", value: "price > 0" }, settings: [] },
      {
        expression: { kind: "expression", value: "price < 100" },
        settings: [{ kind: "property", key: id("name"), value: str("cap") }],
      },
    ]);
  });

  it("takes a double-quoted name and keeps duplicates", () => {
    expect(checks("    `a` [NAME: \"x\", name: 'y']")[0]!.settings).toEqual([
      { kind: "property", key: id("name"), value: { kind: "string", value: "x", doubleQuoted: true } },
      { kind: "property", key: id("name"), value: str("y") },
    ]);
  });

  it("parses empty, single-line and multi-line-expression blocks", () => {
    expect(checks("")).toEqual([]);
    expect(items("  CHECKS { `a` }")).toEqual([
      { type: "checks", entries: [{ expression: { kind: "expression", value: "a" }, settings: [] }] },
    ]);
    expect(checks("    `a >\n      b`")[0]!.expression.value).toBe("a >\n      b");
  });

  it("takes an empty settings list", () => {
    expect(checks("    `a` []")).toEqual([{ expression: { kind: "expression", value: "a" }, settings: [] }]);
  });

  it("sits beside indexes and notes in any order", () => {
    const all = items("  checks { `id > 0` }\n  Note: 'n'\n  indexes { id }\n  checks { `id < 9` }");
    expect(all.map((item) => item.type)).toEqual(["checks", "note", "indexes", "checks"]);
  });

  it("assigns spans", () => {
    const doc = parse("Table t {\n  id int\n  checks {\n    `id > 0` [name: 'c']\n  }\n}");
    const block = (doc.elements[0] as Table).items[1] as Checks;
    expect(block.span).toEqual(span(3, 2, 5, 3));
    expect(block.entries[0]!.span).toEqual(span(4, 4, 4, 24));
    expect(block.entries[0]!.expression.span).toEqual(span(4, 4, 4, 12));
    expect(block.entries[0]!.settings[0]!.span).toEqual(span(4, 14, 4, 23));
  });
});

describe("column check setting", () => {
  it("parses a check expression", () => {
    expect(columnSettings("price int [check: `price > 0`]")).toEqual([
      { kind: "check", expression: { kind: "expression", value: "price > 0" } },
    ]);
  });

  it("repeats and mixes with other settings, in order, in any case", () => {
    expect(columnSettings("p int [check: `p > 0`, note: 'x', CHECK: `p < 9`, not null]")).toEqual([
      { kind: "check", expression: { kind: "expression", value: "p > 0" } },
      { kind: "note", value: str("x") },
      { kind: "check", expression: { kind: "expression", value: "p < 9" } },
      { kind: "null", not: true },
    ]);
  });

  it("assigns spans", () => {
    const doc = parse("Table t {\n  p int [check: `p > 0`]\n}");
    const [setting] = ((doc.elements[0] as Table).items[0] as Column).settings;
    expect(setting!.span).toEqual(span(2, 9, 2, 23));
    expect((setting as Extract<Setting, { kind: "check" }>).expression.span).toEqual(span(2, 16, 2, 23));
  });
});

describe("indexes and checks as names", () => {
  it("keeps indexes and checks usable as column names", () => {
    const all = table("Table t {\n  indexes int\n  checks varchar [note: 'x']\n  Indexes int\n}").items as Column[];
    expect(all.map((column) => [column.type, column.name.value])).toEqual([
      ["column", "indexes"],
      ["column", "checks"],
      ["column", "Indexes"],
    ]);
  });

  it("reads indexes followed by { on a later line as a column", () => {
    expect(parseError("Table t {\n  indexes\n  { id }\n}")).toEqual({
      msg: "Expected a column type but found a new line",
      start: { row: 2, col: 9 },
    });
  });

  it("reads checks followed by { on a later line as a column", () => {
    expect(parseError("Table t {\n  checks\n  { `a` }\n}")).toEqual({
      msg: "Expected a column type but found a new line",
      start: { row: 2, col: 8 },
    });
  });

  it("keeps indexes and checks usable as table, index column and alias names", () => {
    const t = table('Table indexes as checks {\n  checks int\n  indexes { checks\n  (indexes, "checks") }\n}');
    expect(t.name.name.value).toBe("indexes");
    expect(t.alias?.value).toBe("checks");
    expect((t.items[1] as Indexes).entries.map((e) => e.fields)).toEqual([
      [col("checks")],
      [comp(col("indexes"), col("checks", null, true))],
    ]);
  });

  it("keeps asc, desc, name and type usable as index column names", () => {
    expect(fields("(asc [desc], desc, name, type)")).toEqual([
      comp(col("asc", "desc"), col("desc"), col("name"), col("type")),
    ]);
  });
});

describe("malformed indexes and checks", () => {
  const head = "Table t {\n  id int\n";
  const MORE = 'a column name, an expression, "(", "[", a new line or "}"';
  const UNBOUND =
    'A "[" opening the line right after an index entry is a sort order, which only a bare column or expression takes';
  const cases: [string, string, number, number][] = [
    // indexes: entries
    [`${head}  indexes { 1 }\n}`, 'Expected a column name, an expression, "(" or "[" but found "1"', 3, 12],
    [`${head}  indexes { 'id' }\n}`, 'Expected a column name, an expression, "(" or "[" but found a string', 3, 12],
    [`${head}  indexes { id, a }\n}`, `Expected ${MORE} but found ","`, 3, 14],
    [`${head}  indexes { s.id }\n}`, `Expected ${MORE} but found "."`, 3, 13],
    [`${head}  indexes { id 1 }\n}`, `Expected ${MORE} but found "1"`, 3, 15],
    [`${head}  indexes { (id)a }\n}`, 'Expected a space but found "a"', 3, 16],
    [`${head}  indexes { id\`x\` }\n}`, "Expected a space but found an expression", 3, 14],
    [`${head}  indexes { (id)\`x\` }\n}`, "Expected a space but found an expression", 3, 16],
    [`${head}  indexes { id [unique] a }\n}`, 'Expected a new line or "}" but found "a"', 3, 24],
    [`${head}  indexes { id } id2 int\n}`, 'Expected a new line or "}" but found "id2"', 3, 17],
    // indexes: composites
    [`${head}  indexes { (,id) }\n}`, 'Expected a column name or an expression but found ","', 3, 13],
    [`${head}  indexes { (id,) }\n}`, 'Expected a column name or an expression but found ")"', 3, 16],
    [`${head}  indexes { ((id)) }\n}`, 'Expected a column name or an expression but found "("', 3, 13],
    [`${head}  indexes { (id \`x\`) }\n}`, 'Expected "[", "," or ")" but found an expression', 3, 16],
    [`${head}  indexes { (id [asc] [desc]) }\n}`, 'Expected "," or ")" but found "["', 3, 22],
    [`${head}  indexes { (id a) }\n}`, 'Expected "[", "," or ")" but found "a"', 3, 16],
    [`${head}  indexes { (s.id) }\n}`, 'Expected "[", "," or ")" but found "."', 3, 14],
    [`${head}  indexes { (id\n  }\n}`, 'Expected "[", "," or ")" but found "}"', 4, 2],
    // indexes: sort orders
    [`${head}  indexes { (id []) }\n}`, 'Expected "asc" or "desc" but found "]"', 3, 17],
    [`${head}  indexes { (id [up]) }\n}`, 'Expected "asc" or "desc" but found "up"', 3, 17],
    [`${head}  indexes { (id [asc, desc]) }\n}`, 'Expected "]" but found ","', 3, 20],
    [`${head}  indexes { id[pk] }\n}`, 'Expected "asc" or "desc" but found "pk"', 3, 15],
    [`${head}  indexes { (id)[desc] }\n}`, 'Expected a space but found "["', 3, 16],
    [`${head}  indexes { a(id)[desc] }\n}`, 'Expected a space but found "["', 3, 17],
    // indexes: settings
    [`${head}  indexes { id [asc] }\n}`, 'Expected "pk", "unique", "name", "type" or "note" but found "asc"', 3, 16],
    [
      `${head}  indexes { id [owner: 'x'] }\n}`,
      'Expected "pk", "unique", "name", "type" or "note" but found "owner"',
      3,
      16,
    ],
    [`${head}  indexes { id [name: x] }\n}`, 'Expected a string but found "x"', 3, 22],
    [`${head}  indexes { id [name: 1] }\n}`, 'Expected a string but found "1"', 3, 22],
    [`${head}  indexes { id [type: 'hash'] }\n}`, "Expected an index type but found a string", 3, 22],
    [`${head}  indexes { id [type] }\n}`, 'Expected ":" but found "]"', 3, 20],
    [`${head}  indexes { id [pk: true] }\n}`, 'Expected "," or "]" but found ":"', 3, 18],
    [`${head}  indexes { id [pk unique] }\n}`, 'Expected "," or "]" but found "unique"', 3, 19],
    [`${head}  indexes { id[desc][unique] }\n}`, 'Expected a space but found "["', 3, 20],
    // indexes: a `[` opening a later line
    [`${head}  indexes { id\n    [pk]\n  }\n}`, 'Expected "asc" or "desc" but found "pk"', 4, 5],
    [`${head}  indexes { (id)\n    [unique]\n  }\n}`, UNBOUND, 4, 4],
    [`${head}  indexes { id[desc]\n    [asc]\n  }\n}`, UNBOUND, 4, 4],
    [`${head}  indexes { id\n    [desc]\n    [asc]\n  }\n}`, UNBOUND, 5, 4],
    [`${head}  indexes { id [unique]\n    [pk]\n  }\n}`, UNBOUND, 4, 4],
    [`${head}  indexes {\n    [unique]\n\n    [pk]\n  }\n}`, UNBOUND, 6, 4],
    [
      `${head}  indexes { id   \n    [desc]\n  }\n}`,
      'Expected "pk", "unique", "name", "type" or "note" but found "desc"',
      4,
      5,
    ],
    [
      `${head}  indexes { id // c\n    [desc]\n  }\n}`,
      'Expected "pk", "unique", "name", "type" or "note" but found "desc"',
      4,
      5,
    ],
    [`${head}  indexes { [unique] id }\n}`, 'Expected a new line or "}" but found "id"', 3, 21],
    [`${head}  indexes { id [unique] [pk] }\n}`, 'Expected a new line or "}" but found "["', 3, 24],
    [`${head}  indexes { [desc] }\n}`, 'Expected "pk", "unique", "name", "type" or "note" but found "desc"', 3, 13],
    // indexes: the block
    [`${head}  indexes{ id }\n}`, 'Expected a space but found "{"', 3, 9],
    [`${head}  indexes { id`, 'Expected "}" but found end of input', 3, 14],
    [`${head}  indexes {\n    id\n`, 'Expected "}" but found end of input', 5, 0],
    [`${head}  indexes [x] { id }\n}`, 'Expected a column type but found "["', 3, 10],
    // checks
    [`${head}  checks { id }\n}`, 'Expected an expression but found "id"', 3, 11],
    [`${head}  checks { 'a' }\n}`, "Expected an expression but found a string", 3, 11],
    [`${head}  checks { (\`a\`) }\n}`, 'Expected an expression but found "("', 3, 11],
    [`${head}  checks { \`a\` \`b\` }\n}`, 'Expected "[", a new line or "}" but found an expression', 3, 15],
    [`${head}  checks { \`a\`, \`b\` }\n}`, 'Expected "[", a new line or "}" but found ","', 3, 14],
    [`${head}  checks { \`a\`[name: 'x'] }\n}`, 'Expected a space but found "["', 3, 14],
    [`${head}  checks { \`a\` [note: 'x'] }\n}`, 'Expected "name" but found "note"', 3, 16],
    [`${head}  checks { \`a\` [name] }\n}`, 'Expected ":" but found "]"', 3, 20],
    [`${head}  checks { \`a\` [name: x] }\n}`, 'Expected a string but found "x"', 3, 22],
    [`${head}  checks{ \`a\` }\n}`, 'Expected a space but found "{"', 3, 8],
    [`${head}  checks {\n    \`a\`\n    [name: 'x']\n  }\n}`, 'Expected an expression but found "["', 5, 4],
    // column check
    ["Table t {\n  id int [check: `a` `b`]\n}", 'Expected "," or "]" but found an expression', 2, 21],
    ["Table t {\n  id int [check: 'x']\n}", "Expected an expression but found a string", 2, 17],
    ["Table t {\n  id int [check: x > 0]\n}", 'Expected an expression but found "x"', 2, 17],
    ["Table t {\n  id int [check]\n}", 'Expected ":" but found "]"', 2, 15],
  ];

  it.each(cases)("rejects %j", (text, msg, row, col) => {
    expect(parseError(text)).toEqual({ msg, start: { row, col } });
  });
});
