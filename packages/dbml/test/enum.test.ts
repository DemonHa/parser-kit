import { describe, expect, it } from "vitest";
import type { Enum } from "../src/index";
import { id, only, parse, parseError, qn, span } from "./helpers";

const enumOf = (text: string): Enum => only(text, "enum");

describe("Enum", () => {
  it("parses a schema, an alias, values, quoted values and value notes", () => {
    expect(
      enumOf("Enum s.job_status as JobStatus {\n  created\n  \"in progress\" [note: 'Working']\n  DONE\n}"),
    ).toEqual({
      type: "enum",
      name: qn("job_status", "s"),
      alias: id("JobStatus"),
      values: [
        { name: id("created"), settings: [] },
        { name: id("in progress", true), settings: [{ kind: "note", value: { kind: "string", value: "Working" } }] },
        { name: id("DONE"), settings: [] },
      ],
    });
  });

  it("matches the keyword in any case and allows a body on one line", () => {
    expect(enumOf("ENUM e { a }")).toEqual({
      type: "enum",
      name: qn("e"),
      alias: null,
      values: [{ name: id("a"), settings: [] }],
    });
    expect(enumOf("enum e {\n a\n}").name).toEqual(qn("e"));
  });

  it("lets line breaks separate the header's parts and settings span lines", () => {
    expect(enumOf("enum\ne\nas\nE\n{\n a [\n  note: '''\n    x\n  '''\n ]\n}")).toEqual({
      type: "enum",
      name: qn("e"),
      alias: id("E"),
      values: [
        { name: id("a"), settings: [{ kind: "note", value: { kind: "string", value: "x\n", multiline: true } }] },
      ],
    });
  });

  it("takes an empty body (an empty enum is a semantic error)", () => {
    expect(enumOf("enum e {\n}").values).toEqual([]);
  });

  for (const word of [
    "enum",
    "note",
    "as",
    "table",
    "ref",
    "pk",
    "null",
    "default",
    "indexes",
    "records",
    "project",
    "checks",
  ]) {
    it(`keeps ${word} usable as a name`, () => {
      expect(enumOf(`enum ${word}.${word} as ${word} {\n  ${word}\n  ${word} [note: 'x']\n}`)).toEqual({
        type: "enum",
        name: qn(word, word),
        alias: id(word),
        values: [
          { name: id(word), settings: [] },
          { name: id(word), settings: [{ kind: "note", value: { kind: "string", value: "x" } }] },
        ],
      });
    });
  }

  it("spans every node of a multi-line enum", () => {
    const [e] = parse("enum s.status as S {\n  active\n  \"on hold\" [note: 'x']\n}").elements as Enum[];
    expect(e!.span).toEqual(span(1, 0, 4, 1));
    expect(e!.name.span).toEqual(span(1, 5, 1, 13));
    expect(e!.alias!.span).toEqual(span(1, 17, 1, 18));
    expect(e!.values.map((value) => value.span)).toEqual([span(2, 2, 2, 8), span(3, 2, 3, 23)]);
    expect(e!.values[1]!.name.span).toEqual(span(3, 2, 3, 11));
    expect(e!.values[1]!.settings[0]!.span).toEqual(span(3, 13, 3, 22));
  });
});

describe("Enum errors", () => {
  const cases: [string, string, number, number][] = [
    ["enum e [note: 'x'] {\n a\n}", 'Expected "as" or "{" but found "["', 1, 7],
    ["enum e {\n a b\n}", 'Expected "[", a new line or "}" but found "b"', 2, 3],
    ["enum e {\n 'a'\n}", "Expected an enum value but found a string", 2, 1],
    ["enum e {\n 1\n}", 'Expected an enum value but found "1"', 2, 1],
    ["enum e {\n a.b\n}", 'Expected "[", a new line or "}" but found "."', 2, 2],
    ["enum e {\n a [color: #fff]\n}", 'Expected "note" but found "color"', 2, 4],
    ["enum e {\n a [pk]\n}", 'Expected "note" but found "pk"', 2, 4],
    ["enum e {\n a [note x]\n}", 'Expected ":" but found "x"', 2, 9],
    ["enum e {\n a [note]\n}", 'Expected ":" but found "]"', 2, 8],
    ["enum e {\n a", 'Expected "}" but found end of input', 2, 2],
    ["enum e {\n a\n Note: 'x'\n}", 'Expected "[", a new line or "}" but found ":"', 3, 5],
    ["enum e {\n a[note: 'x']\n}", 'Expected a space but found "["', 2, 2],
    ["enum {\n a\n}", 'Expected an enum name but found "{"', 1, 5],
    ["enum e {\n a\n", 'Expected "}" but found end of input', 3, 0],
  ];

  for (const [text, msg, row, col] of cases) {
    it(`rejects ${JSON.stringify(text)}`, () => {
      expect(parseError(text)).toEqual({ msg, start: { row, col } });
    });
  }
});
