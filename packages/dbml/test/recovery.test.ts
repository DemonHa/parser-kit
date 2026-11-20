import { ParseError, stripSpans } from "@parser-kit/core";
import { describe, expect, it } from "vitest";
import type { Column, Element, Table } from "../src/index";
import { dbml } from "../src/index";
import { at, ELEMENTS, parseError } from "./helpers";

// `diagnose` resynchronises at three levels: a bad setting is dropped from its
// list, a bad body line from its body, and a bad element from the document.

const diagnose = (text: string) => {
  const { ast, errors } = dbml.diagnose(text);
  for (const error of errors) expect(error).toBeInstanceOf(ParseError);
  return { elements: stripSpans(ast).elements, errors: errors.map(({ msg, start }) => ({ msg, start })) };
};

/** One line per element: its kind and name, and a table's column names. */
const outline = (elements: Element[]): string[] =>
  elements.map((element) => {
    switch (element.type) {
      case "table":
        return `table ${element.name.name.value}: ${element.items
          .map((item) => (item.type === "column" ? item.name.value : item.type))
          .join(" ")}`;
      case "enum":
        return `enum ${element.name.name.value}: ${element.values.map((value) => value.name.value).join(" ")}`;
      case "ref":
        return `ref ${element.left.table.name.value} ${element.relation.op} ${element.right.table.name.value}`;
      case "stickyNote":
        return `note ${element.name.name.value}`;
      default:
        return element.type;
    }
  });

const tableOf = (elements: Element[], index = 0): Table => elements[index] as Table;
const columnOf = (elements: Element[], name: string): Column =>
  tableOf(elements).items.find((item): item is Column => item.type === "column" && item.name.value === name)!;

const BODY_ITEMS = 'a column, a note, a partial injection, records, "indexes" or "checks"';

describe("Recovery at the top level", () => {
  it("reports an error in every element, in source order, and keeps the valid ones", () => {
    const { elements, errors } = diagnose(
      "Table {\n  id int\n}\nTable a {\n  id int\n}\nRef x\nEnum e {\n  v\n}\nTable b as {\n}\nTable c {\n  id int\n}\n",
    );
    expect(errors).toEqual([
      { msg: 'Expected a table name but found "{"', start: at(1, 6) },
      // The Ref header may continue on later lines, so the error is at the next element's keyword, which
      // is still resumed at.
      { msg: 'Expected ":" or "{" but found "Enum"', start: at(8, 0) },
      { msg: 'Expected an alias but found "{"', start: at(11, 11) },
    ]);
    expect(outline(elements)).toEqual(["table a: id", "enum e: v", "table c: id"]);
  });

  it("skips garbage between elements and a stray closing brace", () => {
    const { elements, errors } = diagnose("42 x\nTable a { id int }\n}\nfoo bar\nTable b { id int }\n");
    expect(errors).toEqual([
      { msg: `Expected ${ELEMENTS} but found "42"`, start: at(1, 0) },
      { msg: `Expected ${ELEMENTS} but found "}"`, start: at(3, 0) },
    ]);
    expect(outline(elements)).toEqual(["table a: id", "table b: id"]);
  });

  it("resumes at an element that follows a closing brace on the same line", () => {
    const { elements, errors } = diagnose("Table a [note: 1 { id int } Table b { id int }\n");
    // The list left open isn't reported again: its bad setting already was.
    expect(errors).toEqual([{ msg: 'Expected a string but found "1"', start: at(1, 15) }]);
    expect(outline(elements)).toEqual(["table a: id", "table b: id"]);
  });

  it("does not resume at a keyword in the middle of a line", () => {
    const { elements, errors } = diagnose("Table a.b.c Table d { id int }\nTable ok { id int }\n");
    expect(errors).toEqual([{ msg: 'Expected "as", "[" or "{" but found "."', start: at(1, 9) }]);
    expect(outline(elements)).toEqual(["table ok: id"]);
  });

  it("skips the body of an element whose { is missing, keywords used as names included", () => {
    const { elements, errors } = diagnose(
      "Table users\n  id int\n  note text\n  Note: 'x'\n  table varchar\n  records int\n}\nTable ok {\n  id int\n}\n",
    );
    expect(errors).toEqual([{ msg: 'Expected "as" or "{" but found "id"', start: at(2, 2) }]);
    expect(outline(elements)).toEqual(["table ok: id"]);
  });

  it("doesn't resume at block notes or records blocks of a table whose { is missing", () => {
    const { elements, errors } = diagnose(
      "Table users\n  id int\n  Note {\n    'x'\n  }\n  records (id) {\n    1\n  }\n}\nTable ok { x int [qq] }\n",
    );
    expect(errors).toEqual([
      { msg: 'Expected "as" or "{" but found "id"', start: at(2, 2) },
      { msg: 'Expected ":" but found "]"', start: at(10, 20) },
    ]);
    expect(outline(elements)).toEqual(["table ok: x"]);
  });

  it("still resumes after a lexer error on a line it read ahead", () => {
    for (const [text, row] of [
      ["garbage\nTable a $ {\n}\nTable b { x int [qq] }\n", 4],
      ["garbage\nTable a [note: 'x\nTable b { x int [qq] }\n", 3],
    ] as const) {
      const { elements, errors } = diagnose(text);
      expect(errors[0]).toEqual({ msg: `Expected ${ELEMENTS} but found "garbage"`, start: at(1, 0) });
      expect(errors.at(-1)).toEqual({ msg: 'Expected ":" but found "]"', start: at(row, 19) });
      expect(outline(elements).at(-1)).toBe("table b: x");
    }
  });

  it("resumes at every kind of element", () => {
    const { elements, errors } = diagnose(
      [
        "?",
        "Project p { a: 'b' }",
        "?",
        "Ref: a.x > b.y",
        "?",
        "Ref r { a.x - b.y }",
        "?",
        "TableGroup g { a }",
        "?",
        "Note n { 'x' }",
        "?",
        "TablePartial p { id int }",
        "?",
        "records t(a) { 1 }",
        "",
      ].join("\n"),
    );
    expect(errors).toEqual(
      [1, 3, 5, 7, 9, 11, 13].map((row) => ({ msg: `Expected ${ELEMENTS} but found "?"`, start: at(row, 0) })),
    );
    expect(elements.map((element) => element.type)).toEqual([
      "project",
      "ref",
      "ref",
      "tableGroup",
      "stickyNote",
      "tablePartial",
      "records",
    ]);
  });
});

describe("Recovery in bodies", () => {
  it("drops a bad line and keeps the lines around it", () => {
    const { elements, errors } = diagnose(
      "Table t {\n  id int\n  42 bad\n  name text\n  email\n  age int [pk unique]\n  created_at timestamp\n}\n",
    );
    expect(errors).toEqual([
      { msg: `Expected ${BODY_ITEMS} but found "42"`, start: at(3, 2) },
      { msg: "Expected a column type but found a new line", start: at(5, 7) },
      { msg: 'Expected ":" but found "]"', start: at(6, 20) },
    ]);
    expect(outline(elements)).toEqual(["table t: id name age created_at"]);
  });

  it("keeps a complete item with junk after it, reporting the junk once", () => {
    const { elements, errors } = diagnose(
      "Table a {\n  id int pk junk\n  name text [note: 'n'] more\n}\nRef: a.id > b.id junk\nTable b { id int }\n",
    );
    expect(errors).toEqual([
      { msg: 'Expected "pk", "unique", "[", a new line or "}" but found "junk"', start: at(2, 12) },
      { msg: 'Expected a new line or "}" but found "more"', start: at(3, 24) },
      { msg: 'Expected "[" or a new line but found "junk"', start: at(5, 17) },
    ]);
    expect(outline(elements)).toEqual(["table a: id name", "ref a > b", "table b: id"]);
    expect(columnOf(elements, "id").settings).toEqual([{ kind: "pk", spelling: "pk", bare: true }]);
  });

  it("recovers on single-line bodies", () => {
    const { elements, errors } = diagnose("Table a { id int, }\nTable b { x }\nTable c { y int }\n");
    expect(errors).toEqual([
      { msg: 'Expected "pk", "unique", "[", a new line or "}" but found ","', start: at(1, 16) },
      { msg: 'Expected a column type but found "}"', start: at(2, 12) },
    ]);
    expect(outline(elements)).toEqual(["table a: id", "table b: ", "table c: y"]);
  });

  it("recovers in enum, group, project and records bodies", () => {
    const { elements, errors } = diagnose(
      [
        "enum e {\n  a,\n  b [pk]\n  c\n}",
        "TableGroup g {\n  x y\n  z\n}",
        "Project p {\n  version: 2\n  name: 'x'\n}",
        "records t(a, b) {\n  1, [2]\n  3 4\n  5, 6\n}",
        "",
      ].join("\n"),
    );
    expect(errors).toEqual([
      { msg: 'Expected "[", a new line or "}" but found ","', start: at(2, 3) },
      { msg: 'Expected "note" but found "pk"', start: at(3, 5) },
      { msg: 'Expected a new line or "}" but found "y"', start: at(7, 4) },
      { msg: 'Expected a string but found "2"', start: at(11, 11) },
      {
        msg: 'Expected a string, a number, an expression, "true", "false", "null" or an enum value but found "["',
        start: at(15, 5),
      },
      { msg: 'Expected ",", a new line or "}" but found "4"', start: at(16, 4) },
    ]);
    const [enumeration, group, project, records] = elements;
    expect(outline([enumeration!])).toEqual(["enum e: a b c"]);
    // Unlike a column, a member with more after it isn't kept: `Note n { … }` is no member.
    expect(group).toMatchObject({ items: [{ type: "member", name: { value: "z" } }] });
    expect(project).toMatchObject({ items: [{ type: "property", key: { value: "name" } }] });
    expect(records).toMatchObject({
      rows: [{ fields: [{ value: 3 }] }, { fields: [{ value: 5 }, { value: 6 }] }],
    });
  });

  it("recovers inside nested blocks and carries on after them", () => {
    const { elements, errors } = diagnose(
      "Table t {\n  a int\n  indexes {\n    a [clustered]\n    42\n    (a, b) [unique]\n  }\n  checks {\n    a > 0\n    `a > 0`\n  }\n  b int\n}\n",
    );
    expect(errors).toEqual([
      { msg: 'Expected "pk", "unique", "name", "type" or "note" but found "clustered"', start: at(4, 7) },
      { msg: 'Expected a column name, an expression, "(" or "[" but found "42"', start: at(5, 4) },
      { msg: 'Expected an expression but found "a"', start: at(9, 4) },
    ]);
    expect(outline(elements)).toEqual(["table t: a indexes checks b"]);
    const [, indexes, checks] = tableOf(elements).items;
    expect(indexes).toMatchObject({ type: "indexes", entries: [{ settings: [] }, { settings: [{ kind: "unique" }] }] });
    expect(checks).toMatchObject({ type: "checks", entries: [{ expression: { value: "a > 0" } }] });
  });

  it("keeps a long-form Ref whose body holds a second relationship", () => {
    const { elements, errors } = diagnose("Ref {\n  a.x > b.y\n  c.x > d.y\n}\nRef: e.x > f.y\n");
    expect(errors).toEqual([{ msg: 'Expected "}" but found "c"', start: at(3, 2) }]);
    expect(outline(elements)).toEqual(["ref a > b", "ref e > f"]);
  });

  it("drops a long-form Ref or a sticky note with nothing in its body, and goes on after its }", () => {
    const { elements, errors } = diagnose("Ref {\n  a.x >\n} Note n {\n} Note m { 'ok' }\n");
    expect(errors).toEqual([
      { msg: 'Expected a column reference but found "}"', start: at(3, 0) },
      { msg: 'Expected a string but found "}"', start: at(4, 0) },
    ]);
    expect(outline(elements)).toEqual(["note m"]);
  });

  it("keeps the text of a block note with junk after it, and drops an empty one", () => {
    const { elements, errors } = diagnose("Table a {\n  Note { }\n  id int\n  Note { 'x' 'y' }\n  name text\n}\n");
    expect(errors).toEqual([
      { msg: 'Expected a string but found "}"', start: at(2, 9) },
      { msg: 'Expected "}" but found a string', start: at(4, 13) },
    ]);
    expect(outline(elements)).toEqual(["table a: id note name"]);
  });

  it("reports junk after a block note it resumed after", () => {
    const { elements, errors } = diagnose("Table t {\n  Note { 42 } junk\n  id int\n}\n");
    expect(errors).toEqual([
      { msg: 'Expected a string but found "42"', start: at(2, 9) },
      { msg: 'Expected a new line or "}" but found "junk"', start: at(2, 14) },
    ]);
    expect(outline(elements)).toEqual(["table t: id"]);
  });
});

describe("Spans of a recovered tree", () => {
  it("cover what was read, not what was skipped", () => {
    const { ast } = dbml.diagnose("Table t {\n  id int [note: 1, pk] junk\n  42 bad\n  name text\n}\n");
    const table = ast.elements[0] as Table;
    expect(table.span).toEqual({ start: at(1, 0), end: at(5, 1) });
    const [id, name] = table.items as Column[];
    expect(id!.span).toEqual({ start: at(2, 2), end: at(2, 22) });
    expect(id!.settings.map((setting) => setting.span)).toEqual([{ start: at(2, 19), end: at(2, 21) }]);
    expect(name!.span).toEqual({ start: at(4, 2), end: at(4, 11) });
  });
});

describe("Recovery in settings lists", () => {
  it("drops each bad setting and keeps the others", () => {
    const { elements, errors } = diagnose(
      "Table t {\n  id int [default: , note: 42, pk, ref: u.id, unique]\n  name text\n}\n",
    );
    expect(errors).toEqual([
      {
        msg: 'Expected a string, a number, an expression, "true", "false", "null" or an enum value but found ","',
        start: at(2, 19),
      },
      { msg: 'Expected a string but found "42"', start: at(2, 27) },
      { msg: 'Expected a relation (<, >, -, <>) but found "u"', start: at(2, 40) },
    ]);
    expect(columnOf(elements, "id").settings.map((setting) => setting.kind)).toEqual(["pk", "unique"]);
    expect(outline(elements)).toEqual(["table t: id name"]);
  });

  it("resumes after a missing comma and after a nested list", () => {
    const { elements, errors } = diagnose("Table t {\n  id int [default: 1 2, c: [1], pk]\n}\n");
    expect(errors).toEqual([
      { msg: 'Expected "," or "]" but found "2"', start: at(2, 21) },
      { msg: 'Expected a string, a number, a boolean, a color or "none" but found "["', start: at(2, 27) },
    ]);
    expect(columnOf(elements, "id").settings.map((setting) => setting.kind)).toEqual(["default", "pk"]);
  });

  it("recovers in nested settings: table headers, refs, indexes and enum values", () => {
    const { elements, errors } = diagnose(
      [
        "Table t [headercolor: 'red', note: 'ok'] {",
        "  a int",
        "  indexes {",
        "    a [name: 1, unique]",
        "  }",
        "}",
        "Ref: a.x > b.y [delete: explode, color: #fff]",
        "enum e {",
        "  v [note: 1, note: 'ok']",
        "}",
        "",
      ].join("\n"),
    );
    expect(errors).toEqual([
      { msg: "Expected a color but found a string", start: at(1, 22) },
      { msg: 'Expected a string but found "1"', start: at(4, 13) },
      {
        msg: 'Expected "cascade", "restrict", "set null", "set default" or "no action" but found "explode"',
        start: at(7, 24),
      },
      { msg: 'Expected a string but found "1"', start: at(9, 11) },
    ]);
    const [table, ref, enumeration] = elements;
    expect(table).toMatchObject({
      settings: [{ kind: "note" }],
      items: [{}, { entries: [{ settings: [{ kind: "unique" }] }] }],
    });
    expect(ref).toMatchObject({ settings: [{ kind: "property", key: { value: "color" } }] });
    expect(enumeration).toMatchObject({ values: [{ settings: [{ kind: "note", value: { value: "ok" } }] }] });
  });
});

describe("Cascading errors", () => {
  it("reports a list and a body both open at the end of input once", () => {
    const { elements, errors } = diagnose("Table t {\n  id int [pk, not null");
    expect(errors).toEqual([{ msg: 'Expected "," or "]" but found end of input', start: at(2, 22) }]);
    expect(columnOf(elements, "id").settings.map((setting) => setting.kind)).toEqual(["pk", "null"]);
  });

  it("reports nested blocks open at the end of input once", () => {
    const { elements, errors } = diagnose("Table a {\n  id int\n  indexes {\n    (id\n");
    expect(errors).toEqual([{ msg: 'Expected "[", "," or ")" but found end of input', start: at(5, 0) }]);
    expect(outline(elements)).toEqual(["table a: id indexes"]);
  });

  it("reports an unclosed body after an earlier error in it", () => {
    const { elements, errors } = diagnose("Table a {\n  42\n  id int\n");
    expect(errors).toEqual([
      { msg: `Expected ${BODY_ITEMS} but found "42"`, start: at(2, 2) },
      { msg: 'Expected "}" but found end of input', start: at(4, 0) },
    ]);
    expect(outline(elements)).toEqual(["table a: id"]);
  });

  it("reports only the lexer error when an unterminated string or comment swallows the rest", () => {
    expect(diagnose("Table t {\n  id int\n  Note: '''never closed\n}\n").errors).toEqual([
      { msg: "Unterminated multi-line string", start: at(3, 8) },
    ]);
    expect(diagnose("Table t {\n  id int\n  /* never closed\n}\n")).toEqual({
      elements: diagnose("Table t {\n  id int\n").elements,
      errors: [{ msg: "Unterminated comment", start: at(3, 2) }],
    });
  });

  it("reports an unterminated string mid-file and parses what follows", () => {
    const { elements, errors } = diagnose(
      "Table a {\n  id int [note: 'oops]\n}\nTable b {\n  Note: 'never closed\n  id int\n}\nEnum e {\n  v\n}\n",
    );
    expect(errors).toEqual([
      { msg: "Unterminated string", start: at(2, 16) },
      { msg: "Unterminated string", start: at(5, 8) },
    ]);
    expect(outline(elements)).toEqual(["table a: id", "table b: id", "enum e: v"]);
  });

  // The string ends at its line's end, but takes the list's `]` with it, so
  // the lexer goes on reading line breaks as spaces: recovery ends the list,
  // and the lines after it, at each new row.
  it("keeps the lines after a string left open in a settings list", () => {
    const { elements, errors } = diagnose(
      "Table a {\n  id int [note: 'oops]\n  name text\n  age int [pk]\n}\nTable b { id int }\n",
    );
    expect(errors).toEqual([{ msg: "Unterminated string", start: at(2, 16) }]);
    expect(outline(elements)).toEqual(["table a: id name age", "table b: id"]);
    expect(columnOf(elements, "age").settings).toEqual([{ kind: "pk", spelling: "pk" }]);
  });

  it("reads the lines after such a string as lines everywhere", () => {
    // Columns named after keywords, a note item and a block stay body lines.
    const body = diagnose(
      "Table a {\n  id int [note: 'oops]\n  ref int\n  Note: 'hi'\n  indexes {\n    id\n  }\n  c\n  d int\n}\n",
    );
    expect(body.errors).toEqual([
      { msg: "Unterminated string", start: at(2, 16) },
      { msg: "Expected a column type but found a new line", start: at(8, 3) },
    ]);
    expect(outline(body.elements)).toEqual(["table a: id ref note indexes d"]);
    // The top level resumes at the next line, and reports what is wrong there.
    const top = diagnose("Ref: a.b > c.d [note: 'x\nfoo bar\nTable c {\n  f int\n}\n");
    expect(top.errors).toEqual([
      { msg: "Unterminated string", start: at(1, 22) },
      { msg: `Expected ${ELEMENTS} but found "foo"`, start: at(2, 0) },
    ]);
    expect(outline(top.elements)).toEqual(["ref a > c", "table c: f"]);
    // A list opened later lexes its own line breaks as spaces, as usual.
    const later = diagnose("Table a {\n  id int [note: 'x\n  name text [pk,\n    unique]\n}\n");
    expect(later.errors).toEqual([{ msg: "Unterminated string", start: at(2, 16) }]);
    expect(columnOf(later.elements, "name").settings.map((setting) => setting.kind)).toEqual(["pk", "unique"]);
  });

  it("drops the closer of a multi-line list after such a string", () => {
    const { elements, errors } = diagnose("Table a {\n  id int [pk,\n    note: 'x\n  ]\n  b int\n}\n");
    expect(errors).toEqual([{ msg: "Unterminated string", start: at(3, 10) }]);
    expect(outline(elements)).toEqual(["table a: id b"]);
    expect(columnOf(elements, "id").settings.map((setting) => setting.kind)).toEqual(["pk"]);
  });

  it("reads the body of a header whose { such a string swallowed", () => {
    const { elements, errors } = diagnose(
      "Table a [headercolor: #fff, note: 'x] {\n  id int\n  y\n}\nNote n [x: 'oops {\n  'text'\n}\nTable b { id int }\n",
    );
    expect(errors).toEqual([
      { msg: "Unterminated string", start: at(1, 34) },
      { msg: "Expected a column type but found a new line", start: at(3, 3) },
      { msg: "Unterminated string", start: at(5, 11) },
    ]);
    expect(outline(elements)).toEqual(["table a: id", "note n", "table b: id"]);
  });

  it("keeps a complete item a lexer error follows on its line", () => {
    const { elements, errors } = diagnose(
      "Table a {\n  id int [pk] 'oops\n  b int\n}\nEnum e {\n  a $\n  b\n}\nRef: a.b > c.d $\n",
    );
    expect(errors).toEqual([
      { msg: "Unterminated string", start: at(2, 14) },
      { msg: 'Unexpected character "$"', start: at(6, 4) },
      { msg: 'Unexpected character "$"', start: at(9, 15) },
    ]);
    expect(outline(elements)).toEqual(["table a: id b", "enum e: a b", "ref a > c"]);
  });

  it("keeps reading a body past its block notes and records after such a string", () => {
    const { elements, errors } = diagnose(
      "Table users {\n  id int [note: 'x\n  Note {\n    'n'\n  }\n  records (id) {\n    1\n  }\n  y int [zz]\n}\n",
    );
    expect(errors).toEqual([
      { msg: "Unterminated string", start: at(2, 16) },
      { msg: 'Expected ":" but found "]"', start: at(9, 11) },
    ]);
    expect(outline(elements)).toEqual(["table users: id note records y"]);
  });

  it("reads the rows of a records block whose column list such a string left open", () => {
    const { elements, errors } = diagnose('records t(a, "b\n) {\n  1, 2\n  3 4\n}\nTable b { id int }\n');
    expect(errors).toEqual([
      { msg: "Unterminated quoted identifier", start: at(1, 13) },
      { msg: 'Expected ",", a new line or "}" but found "4"', start: at(4, 4) },
    ]);
    expect(elements[0]).toMatchObject({ type: "records", columns: [{ value: "a" }], rows: [{}, {}] });
    expect(outline(elements).at(-1)).toBe("table b: id");
  });

  it("ends a block note, a sticky note or a Ref whose } a string left open swallowed at its line", () => {
    const sticky = diagnose("Note n { 'abc }\nTable b {\n  y int\n  z\n}\n");
    expect(sticky.errors).toEqual([
      { msg: "Unterminated string", start: at(1, 9) },
      { msg: "Expected a column type but found a new line", start: at(4, 3) },
    ]);
    expect(outline(sticky.elements)).toEqual(["table b: y"]);
    const block = diagnose("Table users {\n  Note { 'abc }\n  name text\n}\nTable b { y int }\n");
    expect(block.errors).toEqual([{ msg: "Unterminated string", start: at(2, 9) }]);
    expect(outline(block.elements)).toEqual(["table users: name", "table b: y"]);
    const apostrophe = diagnose("Table users {\n  Note { 'it's' }\n  name text\n}\n");
    expect(apostrophe.errors).toEqual([
      { msg: 'Expected "}" but found "s"', start: at(2, 13) },
      { msg: "Unterminated string", start: at(2, 14) },
    ]);
    expect(outline(apostrophe.elements)).toEqual(["table users: note name"]);
    const ref = diagnose("Ref r { a.id > b.id [note: 'x] }\nTable c { f int }\n");
    expect(ref.errors).toEqual([{ msg: "Unterminated string", start: at(1, 27) }]);
    expect(outline(ref.elements)).toEqual(["ref a > b", "table c: f"]);
  });

  it("finds the } of a multi-line block note written in '…'", () => {
    const { elements, errors } = diagnose(
      "Table users {\n  id int\n  Note {\n    'Stores users.\n    Deleted rows are kept.'\n  }\n  name text\n}\nTable b {\n  q\n}\n",
    );
    expect(errors).toEqual([
      { msg: "Unterminated string", start: at(4, 4) },
      { msg: "Unterminated string", start: at(5, 26) },
      { msg: "Expected a column type but found a new line", start: at(10, 3) },
    ]);
    expect(outline(elements)).toEqual(["table users: id name", "table b: "]);
    for (const text of [
      "Note n {\n  'unclosed\n}\nTable b { f int }\n",
      "Project p {\n  Note {\n    'x\n  }\n}\nTable b { f int }\n",
    ]) {
      const { elements: others, errors: theirs } = diagnose(text);
      expect(theirs).toHaveLength(1);
      expect(outline(others).at(-1)).toBe("table b: f");
    }
  });

  it("still reports a missing } after a lexer error that took no } with it", () => {
    for (const [line, error] of [
      ["id int $", { msg: 'Unexpected character "$"', start: at(2, 9) }],
      ["id int [note: 'x]", { msg: "Unterminated string", start: at(2, 16) }],
    ] as const) {
      const { errors } = diagnose(`Table a {\n  ${line}\n  name text\nTable b {\n  x int\n}\n`);
      expect(errors).toEqual([
        error,
        { msg: 'Expected "pk", "unique", "[", a new line or "}" but found "{"', start: at(4, 8) },
        { msg: 'Expected "}" but found end of input', start: at(7, 0) },
      ]);
    }
    const ref = diagnose("Ref r {\n  a.b > c.d [note: 'x]\n  e.f > g.h\n}\n");
    expect(ref.errors).toEqual([
      { msg: "Unterminated string", start: at(2, 19) },
      { msg: 'Expected "}" but found "e"', start: at(3, 2) },
    ]);
  });

  it("resumes after a long-form Ref's own } when a string swallowed the rest of its line", () => {
    const { elements, errors } = diagnose("Ref r {\n  a.b > c.d e [note: 'x]\n}\nTable t {\n  q\n}\n");
    expect(errors).toEqual([
      { msg: 'Expected "[", a new line or "}" but found "e"', start: at(2, 12) },
      { msg: "Unterminated string", start: at(2, 21) },
      { msg: "Expected a column type but found a new line", start: at(5, 3) },
    ]);
    expect(outline(elements)).toEqual(["ref a > c", "table t: "]);
  });

  it("reads a header's { as swallowed only when its own list left a string open", () => {
    const { errors } = diagnose("Ref: a.b > c.d [note: 'x\nTable t\n  id int\n}\n");
    expect(errors).toEqual([
      { msg: "Unterminated string", start: at(1, 22) },
      { msg: 'Expected "as" or "{" but found "id"', start: at(3, 2) },
    ]);
  });

  it("ends a body whose } a string left open outside a list swallowed", () => {
    const { elements, errors } = diagnose("Table a { Note: 'x }\nTable b { f int }\n");
    expect(errors).toEqual([{ msg: "Unterminated string", start: at(1, 16) }]);
    expect(outline(elements)).toEqual(["table a: ", "table b: f"]);
  });

  it("reads the rows of a records block in a table whose { such a string swallowed", () => {
    for (const [header, error] of [
      ['records (id, "x) {', { msg: "Unterminated quoted identifier", start: at(3, 15) }],
      ["records [note: 'x] {", { msg: "Unterminated string", start: at(3, 17) }],
    ] as const) {
      const { elements, errors } = diagnose(`Table t {\n  id int\n  ${header}\n    1\n  }\n  e int\n}\n`);
      expect(errors).toEqual([error]);
      expect(outline(elements)).toEqual(["table t: id records e"]);
    }
  });

  it("ends a body whose } a string left open in a settings list swallowed", () => {
    for (const text of [
      "Table b { x int [note: 'oops }\nTable c { y int }\n",
      "Table b { x int [note: 'oops] }\nTable c { y int }\n",
    ]) {
      const { elements, errors } = diagnose(text);
      expect(errors).toEqual([{ msg: "Unterminated string", start: at(1, 23) }]);
      expect(outline(elements)).toEqual(["table b: x", "table c: y"]);
    }
    const ref = diagnose("Ref: a.x > b.y [color: 'oops\nTable c { y int }\n");
    expect(ref.errors).toEqual([{ msg: "Unterminated string", start: at(1, 23) }]);
    expect(outline(ref.elements)).toEqual(["ref a > b", "table c: y"]);
  });

  it("reports lexer errors met while skipping", () => {
    const { elements, errors } = diagnose("Table a {\n  42 $ x\n  id int\n}\n@ junk\nTable b { id int }\n");
    expect(errors).toEqual([
      { msg: `Expected ${BODY_ITEMS} but found "42"`, start: at(2, 2) },
      { msg: 'Unexpected character "$"', start: at(2, 5) },
      { msg: 'Unexpected character "@"', start: at(5, 0) },
    ]);
    expect(outline(elements)).toEqual(["table a: id", "table b: id"]);
  });
});

describe("parse and diagnose agree", () => {
  const documents = [
    "Table {\n}\nTable a { 42 }\n",
    "Table t {\n  id int [default: , note: 42]\n  x\n}\n",
    "Ref {\n  a.x > b.y\n  c.x > d.y\n}\nTable t {\n",
    "Table a {\n  id int [note: 'oops]\n}\n@\n",
  ];

  it.each(documents)("parse throws diagnose's first error: %j", (text) => {
    const { errors } = dbml.diagnose(text);
    expect(errors.length).toBeGreaterThan(1);
    expect(parseError(text)).toEqual({ msg: errors[0]!.msg, start: errors[0]!.start });
  });

  it("reports errors in source order without duplicates", () => {
    for (const text of documents) {
      const starts = dbml.diagnose(text).errors.map(({ start }) => start.row * 1e6 + start.col);
      expect(starts).toEqual([...new Set(starts)].sort((a, b) => a - b));
    }
  });
});

describe("Recovery cost", () => {
  it("handles 20,000 errors in one body", () => {
    const lines = Array.from({ length: 20_000 }, (_, n) => (n % 2 === 0 ? `  c${n} int [bad 1]` : `  ${n}`));
    const { ast, errors } = dbml.diagnose(`Table t {\n${lines.join("\n")}\n}\nTable ok { id int }\n`);
    expect(errors).toHaveLength(20_000);
    expect(ast.elements.map((element) => element.type)).toEqual(["table", "table"]);
    expect((ast.elements[0] as Table).items).toHaveLength(10_000);
  });

  it("doesn't rescan a long line of keywords that ends in a { or a :", () => {
    for (const text of [`${"} Table t ".repeat(16_000)}{}\n`, `${"} Ref ".repeat(16_000)}: a.b > c.d\n`]) {
      const { errors } = dbml.diagnose(text);
      expect(errors.length).toBeGreaterThan(0);
    }
  });

  it("handles many keyword-led lines after a string left open in a list", () => {
    const { ast, errors } = dbml.diagnose(`Table t {\n  id int [note: 'x\n${"  ref int\n".repeat(16_000)}}\n`);
    expect(errors).toHaveLength(1);
    expect((ast.elements[0] as Table).items).toHaveLength(16_001);
  });

  it("doesn't rescan a long line of keywords it can't resume at", () => {
    // Each keyword after a stray `}` is a candidate, and its scan for a `{`
    // runs to the line's end; without reusing that scan this took ~35 s.
    const { ast, errors } = dbml.diagnose(`x\n${"} Table t ".repeat(16_000)}\nTable ok { id int }\n`);
    expect(errors.map(({ msg }) => msg)).toEqual([`Expected ${ELEMENTS} but found "x"`]);
    expect(ast.elements.map((element) => element.type)).toEqual(["table"]);
  });
});
