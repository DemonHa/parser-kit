import { describe, expect, it } from "vitest";
import type { Note, TableGroup, TableGroupMember } from "../src/index";
import { elements, id, only, parse, parseError, qn, span } from "./helpers";

const group = (text: string): TableGroup => only(text, "tableGroup");
const member = (name: string, schema: string | null = null) => ({ type: "member" as const, ...qn(name, schema) });

describe("TableGroup", () => {
  it("parses settings, members and a note", () => {
    expect(
      group(
        "TableGroup billing [color: #3498DB, note: 'Money'] {\n  invoices\n  s.payments\n  Note: 'Billing tables'\n}",
      ),
    ).toEqual({
      type: "tableGroup",
      name: id("billing"),
      settings: [
        { kind: "property", key: id("color"), value: { kind: "color", value: "#3498DB" } },
        { kind: "note", value: { kind: "string", value: "Money" } },
      ],
      items: [
        member("invoices"),
        member("payments", "s"),
        { type: "note", value: { kind: "string", value: "Billing tables" }, form: "inline" },
      ],
    });
  });

  it("matches the keyword in any case and keeps the name's case", () => {
    expect(group("tablegroup G { t }").name).toEqual(id("G"));
    expect(group("TABLEGROUP g { t }").items).toEqual([member("t")]);
  });

  it("takes quoted names, an empty body and an empty settings list", () => {
    expect(group('TableGroup "my group" [] {\n  "order items"\n  "s"."t"\n}')).toEqual({
      type: "tableGroup",
      name: id("my group", true),
      settings: [],
      items: [
        { type: "member", schema: null, name: id("order items", true) },
        { type: "member", schema: id("s", true), name: id("t", true) },
      ],
    });
    expect(group("TableGroup g {}")).toEqual({ type: "tableGroup", name: id("g"), settings: [], items: [] });
  });

  it("takes a block note, dedented, and keeps every note", () => {
    expect(group("TableGroup g {\n  t\n  Note {\n    '''\n    a\n      b'''\n  }\n  note: 'again'\n}").items).toEqual([
      member("t"),
      { type: "note", value: { kind: "string", value: "a\n  b", multiline: true }, form: "block" },
      { type: "note", value: { kind: "string", value: "again" }, form: "inline" },
    ]);
  });

  it("takes custom properties and lowercases the known color key", () => {
    expect(group("TableGroup g [Color: #fff, owner team: 'core', rank: 2, headercolor: #000] { t }").settings).toEqual([
      { kind: "property", key: id("color"), value: { kind: "color", value: "#fff" } },
      { kind: "property", key: id("owner team"), value: { kind: "string", value: "core" } },
      { kind: "property", key: id("rank"), value: { kind: "number", value: 2 } },
      { kind: "property", key: id("headercolor"), value: { kind: "color", value: "#000" } },
    ]);
    expect(group("TableGroup g [tint: NONE] { t }").settings).toEqual([
      { kind: "property", key: id("tint"), value: { kind: "identifier", value: id("NONE") } },
    ]);
  });

  it("lets line breaks separate the header's parts and surround a member's dot", () => {
    expect(group("TableGroup\ng \n[color: #fff]\n{\n  s\n  .t\n}")).toEqual(
      group("TableGroup g [color: #fff] { s.t }"),
    );
  });

  it("parses alongside the other elements", () => {
    const text = "Table t { id int }\nTableGroup g { t } TableGroup h {\n  t\n}";
    expect(elements(text).map((element) => element.type)).toEqual(["table", "tableGroup", "tableGroup"]);
  });
});

describe("TableGroup keywords", () => {
  const words = ["tablegroup", "TableGroup", "note", "Note", "color", "table", "records"];

  for (const word of words) {
    it(`keeps ${word} usable as a name`, () => {
      expect(group(`TableGroup ${word} {\n  ${word}\n  ${word}.${word}\n}`)).toEqual({
        type: "tableGroup",
        name: id(word),
        settings: [],
        items: [member(word), member(word, word)],
      });
    });
  }

  it("keeps a table named tablegroup", () => {
    expect(only("Table tablegroup {\n  tablegroup tablegroup\n}", "table").name).toEqual(qn("tablegroup"));
  });

  it("reads `note` as a member unless `:` or `{` follows it", () => {
    expect(group("TableGroup g {\n  note\n  Note\n  : 'x'\n}").items).toEqual([
      member("note"),
      { type: "note", value: { kind: "string", value: "x" }, form: "inline" },
    ]);
  });
});

describe("TableGroup spans", () => {
  it("spans every node of a multi-line group", () => {
    const text = ["TableGroup g [color: #fff] {", "  users", '  s."t"', "  Note: 'x'", "}"].join("\n");
    const [g] = parse(text).elements as TableGroup[];
    expect(g!.span).toEqual(span(1, 0, 5, 1));
    expect(g!.name.span).toEqual(span(1, 11, 1, 12));
    expect(g!.settings[0]!.span).toEqual(span(1, 14, 1, 25));
    const [users, st, note] = g!.items as [TableGroupMember, TableGroupMember, Note];
    expect(users.span).toEqual(span(2, 2, 2, 7));
    expect(users.name.span).toEqual(span(2, 2, 2, 7));
    expect(st.span).toEqual(span(3, 2, 3, 7));
    expect(st.schema!.span).toEqual(span(3, 2, 3, 3));
    expect(st.name.span).toEqual(span(3, 4, 3, 7));
    expect(note.span).toEqual(span(4, 2, 4, 11));
  });
});

describe("TableGroup errors", () => {
  const cases: [string, string, number, number][] = [
    ["TableGroup {\n  t\n}", 'Expected a table group name but found "{"', 1, 11],
    ["TableGroup s.g {\n  t\n}", 'Expected "[" or "{" but found "."', 1, 12],
    ["TableGroup g as G {\n  t\n}", 'Expected "[" or "{" but found "as"', 1, 13],
    ["TableGroup g\n[color: #fff] {\n  t\n}", 'Expected "{" but found "["', 2, 0],
    ["TableGroup g[color: #fff] {\n  t\n}", 'Expected a space but found "["', 1, 12],
    ["TableGroup g [color: 'red'] {\n  t\n}", "Expected a color but found a string", 1, 21],
    ["TableGroup g [note: #fff] {\n  t\n}", 'Expected a string but found "#fff"', 1, 20],
    ["TableGroup g [color: none] {\n  t\n}", 'Expected a color but found "none"', 1, 21],
    ["TableGroup g [pk] {\n  t\n}", 'Expected ":" but found "]"', 1, 16],
    ["TableGroup g {\n  t, u\n}", 'Expected a new line or "}" but found ","', 2, 3],
    ["TableGroup g {\n  t u\n}", 'Expected a new line or "}" but found "u"', 2, 4],
    ["TableGroup g {\n  a.b.c\n}", 'Expected a new line or "}" but found "."', 2, 5],
    ["TableGroup g {\n  t [note: 'x']\n}", 'Expected a new line or "}" but found "["', 2, 4],
    ["TableGroup g {\n  t\n  Note n { 'x' }\n}", 'Expected a new line or "}" but found "n"', 3, 7],
    ["TableGroup g {\n  Note 'x'\n}", 'Expected a new line or "}" but found a string', 2, 7],
    ["TableGroup g {\n  [t]\n}", 'Expected a table name or a note but found "["', 2, 2],
    ["TableGroup g {\n  t\n", 'Expected "}" but found end of input', 3, 0],
  ];

  for (const [text, msg, row, col] of cases) {
    it(`rejects ${JSON.stringify(text)}`, () => {
      expect(parseError(text)).toEqual({ msg, start: { row, col } });
    });
  }
});
