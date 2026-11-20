import { describe, expect, it } from "vitest";
import type { Column, PartialInjection, Table, TablePartial } from "../src/index";
import { elements, id, only, parse, parseError, qn, span } from "./helpers";

const partial = (text: string): TablePartial => only(text, "tablePartial");
const table = (text: string): Table => only(text, "table");
const col = (name: string, type: string) => ({
  type: "column" as const,
  name: id(name),
  dataType: { name: qn(type), args: null, arraySizes: [] },
  settings: [],
});
const inject = (name: string, quoted = false) => ({ type: "partialInjection" as const, name: id(name, quoted) });

describe("TablePartial", () => {
  it("parses settings and the items a table body takes", () => {
    expect(
      partial("TablePartial base [headercolor: #fff, note: 'Shared'] {\n  id int [pk]\n  Note: 'Base columns'\n}"),
    ).toEqual({
      type: "tablePartial",
      name: id("base"),
      settings: [
        { kind: "property", key: id("headercolor"), value: { kind: "color", value: "#fff" } },
        { kind: "note", value: { kind: "string", value: "Shared" } },
      ],
      items: [
        { ...col("id", "int"), settings: [{ kind: "pk", spelling: "pk" }] },
        { type: "note", value: { kind: "string", value: "Base columns" }, form: "inline" },
      ],
    });
  });

  it("matches the keyword in any case and takes a quoted name, an empty body and empty settings", () => {
    expect(partial('tablepartial "my partial" [] {}')).toEqual({
      type: "tablePartial",
      name: id("my partial", true),
      settings: [],
      items: [],
    });
    expect(partial("TABLEPARTIAL P { id int }").name).toEqual(id("P"));
  });

  it("lets line breaks separate the header's parts", () => {
    expect(partial("TablePartial\np \n[note: 'x']\n{\n  id int\n}")).toEqual(
      partial("TablePartial p [note: 'x'] { id int }"),
    );
  });

  it("parses alongside the other elements", () => {
    const text = "TablePartial p { id int }\nTable t {\n  ~p\n}";
    expect(elements(text).map((element) => element.type)).toEqual(["tablePartial", "table"]);
  });
});

describe("Partial injection", () => {
  it("keeps injections in source order among a table's items", () => {
    expect(table("Table users {\n  ~base\n  name text\n  ~audit\n  Note: 'x'\n}").items).toEqual([
      inject("base"),
      col("name", "text"),
      inject("audit"),
      { type: "note", value: { kind: "string", value: "x" }, form: "inline" },
    ]);
  });

  it("takes a quoted name, a space or a line break after `~`, and a body on one line", () => {
    expect(table('Table t {\n  ~"my partial"\n  ~ a\n  ~\n  b\n}').items).toEqual([
      inject("my partial", true),
      inject("a"),
      inject("b"),
    ]);
    expect(table("Table t { ~p }").items).toEqual([inject("p")]);
  });

  it("keeps a repeated or unknown injection: which partial it names is not checked", () => {
    expect(table("Table t {\n  ~p\n  ~p\n}").items).toEqual([inject("p"), inject("p")]);
  });
});

describe("TablePartial keywords", () => {
  const words = ["tablepartial", "TablePartial", "headercolor", "note", "records", "table"];

  for (const word of words) {
    it(`keeps ${word} usable as a name`, () => {
      expect(partial(`TablePartial ${word} {\n  ${word} ${word}\n}`)).toEqual({
        type: "tablePartial",
        name: id(word),
        settings: [],
        items: [col(word, word)],
      });
      expect(table(`Table ${word} {\n  ~${word}\n}`).items).toEqual([inject(word)]);
    });
  }

  it("keeps records usable as a column name in a partial", () => {
    expect(partial("TablePartial p {\n  records int\n  records records\n}").items).toEqual([
      col("records", "int"),
      col("records", "records"),
    ]);
  });
});

describe("TablePartial spans", () => {
  it("spans every node of a multi-line partial and its injection", () => {
    const text = ["TablePartial p [note: 'x'] {", "  id int", "}", "Table t {", "  ~ p", '  ~"q"', "}"].join("\n");
    const [p, t] = parse(text).elements as [TablePartial, Table];
    expect(p.span).toEqual(span(1, 0, 3, 1));
    expect(p.name.span).toEqual(span(1, 13, 1, 14));
    expect(p.settings[0]!.span).toEqual(span(1, 16, 1, 25));
    expect((p.items[0] as Column).span).toEqual(span(2, 2, 2, 8));
    const [first, second] = t.items as [PartialInjection, PartialInjection];
    expect(first.span).toEqual(span(5, 2, 5, 5));
    expect(first.name.span).toEqual(span(5, 4, 5, 5));
    expect(second.span).toEqual(span(6, 2, 6, 6));
    expect(second.name.span).toEqual(span(6, 3, 6, 6));
  });
});

describe("TablePartial errors", () => {
  const cases: [string, string, number, number][] = [
    ["TablePartial {\n  id int\n}", 'Expected a table partial name but found "{"', 1, 13],
    ["TablePartial s.p {\n  id int\n}", 'Expected "[" or "{" but found "."', 1, 14],
    ["TablePartial p as P {\n  id int\n}", 'Expected "[" or "{" but found "as"', 1, 15],
    ["TablePartial p [foo: 'x'] {\n  id int\n}", 'Expected "note" or "headercolor" but found "foo"', 1, 16],
    ["TablePartial p[note: 'x'] {\n  id int\n}", 'Expected a space but found "["', 1, 14],
    ["TablePartial p\n[note: 'x'] {\n  id int\n}", 'Expected "{" but found "["', 2, 0],
    ["TablePartial p {\n  ~q\n}", 'Expected a column or a note but found "~"', 2, 2],
    ["TablePartial p {\n  records (a) {\n    1\n  }\n}", 'Expected a column or a note but found "records"', 2, 2],
    ["TablePartial p {\n  [pk]\n}", 'Expected a column or a note but found "["', 2, 2],
    ["TablePartial p {\n  id int\n", 'Expected "}" but found end of input', 3, 0],
    ["Table t {\n  ~p [x]\n}", 'Expected a new line or "}" but found "["', 2, 5],
    ["Table t {\n  ~p ~q\n}", 'Expected a new line or "}" but found "~"', 2, 5],
    ["Table t {\n  ~s.p\n}", 'Expected a new line or "}" but found "."', 2, 4],
    ["Table t {\n  ~\n}", 'Expected a table partial name but found "}"', 3, 0],
    ["Table t {\n  ~'p'\n}", "Expected a table partial name but found a string", 2, 3],
    ["Table t {\n  id int ~p\n}", 'Expected "pk", "unique", "[", a new line or "}" but found "~"', 2, 9],
  ];

  for (const [text, msg, row, col] of cases) {
    it(`rejects ${JSON.stringify(text)}`, () => {
      expect(parseError(text)).toEqual({ msg, start: { row, col } });
    });
  }
});
