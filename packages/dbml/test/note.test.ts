import { describe, expect, it } from "vitest";
import type { StickyNote, Table } from "../src/index";
import { elements, id, only, parse, parseError, qn, span } from "./helpers";

const sticky = (text: string): StickyNote => only(text, "stickyNote");

describe("Sticky note", () => {
  it("parses a name, settings and the text", () => {
    expect(sticky("Note reminder [color: #fff] {\n  'Remember the indexes'\n}")).toEqual({
      type: "stickyNote",
      name: qn("reminder"),
      settings: [{ kind: "property", key: id("color"), value: { kind: "color", value: "#fff" } }],
      value: { kind: "string", value: "Remember the indexes" },
    });
  });

  it("matches the keyword in any case and keeps the name's case", () => {
    expect(sticky("note N { 'x' }").name).toEqual(qn("N"));
    expect(sticky("NOTE n { 'x' }").value).toEqual({ kind: "string", value: "x" });
  });

  it("dedents a multi-line text and takes double-quoted text", () => {
    expect(sticky("Note n {\n  '''\n  hello\n    x\n  '''\n}").value).toEqual({
      kind: "string",
      value: "hello\n  x\n",
      multiline: true,
    });
    expect(sticky('Note n { "dq" }').value).toEqual({ kind: "string", value: "dq", doubleQuoted: true });
  });

  it("takes a quoted or schema-qualified name, as @dbml/core does", () => {
    expect(sticky("Note \"my note\" { 'x' }").name).toEqual({ schema: null, name: id("my note", true) });
    expect(sticky("Note s.n { 'x' }").name).toEqual(qn("n", "s"));
  });

  it("takes `color: none`, custom properties and an empty settings list", () => {
    expect(sticky("Note n [Color: None, note: 'y', pinned: true] { 'x' }").settings).toEqual([
      { kind: "property", key: id("color"), value: { kind: "identifier", value: id("None") } },
      { kind: "property", key: id("note"), value: { kind: "string", value: "y" } },
      { kind: "property", key: id("pinned"), value: { kind: "boolean", value: true } },
    ]);
    expect(sticky("Note n [] { 'x' }").settings).toEqual([]);
    expect(sticky("Note n [COLOR: NONE, tint: none] { 'x' }").settings).toEqual([
      { kind: "property", key: id("color"), value: { kind: "identifier", value: id("NONE") } },
      { kind: "property", key: id("tint"), value: { kind: "identifier", value: id("none") } },
    ]);
  });

  it("lets line breaks separate the header's parts and surround the text", () => {
    expect(sticky("Note\nn \n[color: #fff]\n{\n\n  'x'\n\n}")).toEqual(sticky("Note n [color: #fff] { 'x' }"));
    expect(sticky("Note n{ 'x' }")).toEqual(sticky("Note n { 'x' }"));
  });

  it("parses several, alongside the other elements", () => {
    const text = "Note a { 'x' } Note b { 'y' }\nTable t {\n  Note: 'table note'\n}";
    expect(elements(text).map((element) => element.type)).toEqual(["stickyNote", "stickyNote", "table"]);
  });

  it("is only a sticky note at the top level: in a table, `Note` is the note item", () => {
    const [, table] = elements("Note n { 'x' }\nTable t {\n  Note { 'y' }\n}") as [StickyNote, Table];
    expect(table.items).toEqual([{ type: "note", value: { kind: "string", value: "y" }, form: "block" }]);
  });
});

describe("Sticky note keywords", () => {
  const words = ["note", "Note", "color", "none", "table", "tablegroup"];

  for (const word of words) {
    it(`keeps ${word} usable as a name`, () => {
      expect(sticky(`Note ${word} { 'x' }`).name).toEqual(qn(word));
      expect(sticky(`Note ${word}.${word} { 'x' }`).name).toEqual(qn(word, word));
    });
  }
});

describe("Sticky note spans", () => {
  it("spans every node of a multi-line sticky note", () => {
    const text = ["Note s.n [color: #fff] {", "  '''", "  text", "  '''", "}"].join("\n");
    const [note] = parse(text).elements as StickyNote[];
    expect(note!.span).toEqual(span(1, 0, 5, 1));
    expect(note!.name.span).toEqual(span(1, 5, 1, 8));
    expect(note!.name.schema!.span).toEqual(span(1, 5, 1, 6));
    expect(note!.settings[0]!.span).toEqual(span(1, 10, 1, 21));
    expect(note!.value.span).toEqual(span(2, 2, 4, 5));
  });
});

describe("Sticky note errors", () => {
  const cases: [string, string, number, number][] = [
    ["Note {\n  'x'\n}", 'Expected a sticky note name but found "{"', 1, 5],
    ["Note: 'x'", 'Expected a sticky note name but found ":"', 1, 4],
    ["Note n: 'x'", 'Expected "[" or "{" but found ":"', 1, 6],
    ["Note n as N {\n  'x'\n}", 'Expected "[" or "{" but found "as"', 1, 7],
    ["Note a.b.c {\n  'x'\n}", 'Expected "[" or "{" but found "."', 1, 8],
    ["Note n {\n}", 'Expected a string but found "}"', 2, 0],
    ["Note n {\n  'a'\n  'b'\n}", 'Expected "}" but found a string', 3, 2],
    ["Note n {\n  `x`\n}", "Expected a string but found an expression", 2, 2],
    ["Note n {\n  'x' [color: #fff]\n}", 'Expected "}" but found "["', 2, 6],
    ["Note n [color: 'red'] {\n  'x'\n}", 'Expected a color or "none" but found a string', 1, 15],
    ["Note n [pk] {\n  'x'\n}", 'Expected ":" but found "]"', 1, 10],
    ["Note n[color: #fff] {\n  'x'\n}", 'Expected a space but found "["', 1, 6],
    ["Note n\n[color: #fff] {\n  'x'\n}", 'Expected "{" but found "["', 2, 0],
    ["Note n {\n  'x'\n", 'Expected "}" but found end of input', 3, 0],
  ];

  for (const [text, msg, row, col] of cases) {
    it(`rejects ${JSON.stringify(text)}`, () => {
      expect(parseError(text)).toEqual({ msg, start: { row, col } });
    });
  }
});
