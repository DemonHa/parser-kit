import { describe, expect, it } from "vitest";
import type { Project } from "../src/index";
import { id, only, parse, parseError, span } from "./helpers";

const project = (text: string): Project => only(text, "project");

describe("Project", () => {
  it("parses properties and notes in source order", () => {
    expect(
      project(
        "Project shop {\n  database_type: 'PostgreSQL'\n  Note: 'Main schema'\n  owner: '''team'''\n  note {\n    'second'\n  }\n}",
      ),
    ).toEqual({
      type: "project",
      name: id("shop"),
      items: [
        { type: "property", key: id("database_type"), value: { kind: "string", value: "PostgreSQL" } },
        { type: "note", value: { kind: "string", value: "Main schema" }, form: "inline" },
        { type: "property", key: id("owner"), value: { kind: "string", value: "team", multiline: true } },
        { type: "note", value: { kind: "string", value: "second" }, form: "block" },
      ],
    });
  });

  it("keeps note usable as the project's name", () => {
    expect(project("Project note {\n a: 'b'\n}").name).toEqual(id("note"));
  });

  it("takes line breaks before a property's or a note's colon, and double-quoted values", () => {
    expect(project("Project p {\n  a\n  :\n  \"b\"\n  Note\n  : 'x'\n}").items).toEqual([
      { type: "property", key: id("a"), value: { kind: "string", value: "b", doubleQuoted: true } },
      { type: "note", value: { kind: "string", value: "x" }, form: "inline" },
    ]);
  });

  it("takes no name, a quoted name, and a value on the next line", () => {
    expect(project("Project {\n a: 'b'\n}").name).toBeNull();
    expect(project("PROJECT \"my p\" { a:\n  'b' }")).toEqual({
      type: "project",
      name: id("my p", true),
      items: [{ type: "property", key: id("a"), value: { kind: "string", value: "b" } }],
    });
  });

  it("dedents notes but not property values", () => {
    expect(project("Project p {\n  Note: '''\n    x\n  '''\n  a: '''\n    y'''\n}").items).toEqual([
      { type: "note", value: { kind: "string", value: "x\n", multiline: true }, form: "inline" },
      { type: "property", key: id("a"), value: { kind: "string", value: "\n    y", multiline: true } },
    ]);
  });

  for (const word of [
    "project",
    "table",
    "ref",
    "enum",
    "as",
    "default",
    "pk",
    "null",
    "indexes",
    "checks",
    "records",
  ]) {
    it(`keeps ${word} usable as a name`, () => {
      expect(project(`Project ${word} {\n  ${word}: 'x'\n}`)).toEqual({
        type: "project",
        name: id(word),
        items: [{ type: "property", key: id(word), value: { kind: "string", value: "x" } }],
      });
    });
  }

  it("spans every node of a multi-line project", () => {
    const [p] = parse("Project p {\n  database_type: 'PostgreSQL'\n  Note: 'x'\n}").elements as Project[];
    expect(p!.span).toEqual(span(1, 0, 4, 1));
    expect(p!.name!.span).toEqual(span(1, 8, 1, 9));
    expect(p!.items.map((item) => item.span)).toEqual([span(2, 2, 2, 29), span(3, 2, 3, 11)]);
    const [property] = p!.items as [Extract<Project["items"][number], { type: "property" }>];
    expect(property.key.span).toEqual(span(2, 2, 2, 15));
    expect(property.value.span).toEqual(span(2, 17, 2, 29));
  });
});

describe("Project errors", () => {
  const cases: [string, string, number, number][] = [
    ["Project p [note: 'x'] {\n a: 'b'\n}", 'Expected "{" but found "["', 1, 10],
    ["Project s.p {\n a: 'b'\n}", 'Expected "{" but found "."', 1, 9],
    ["Project p {\n a\n}", 'Expected ":" but found "}"', 3, 0],
    ["Project p {\n \"a\": 'b'\n}", "Expected a property or a note but found a quoted identifier", 2, 1],
    ["Project p {\n a: 1\n}", 'Expected a string but found "1"', 2, 4],
    ["Project p {\n foo bar: 'x'\n}", 'Expected ":" but found "bar"', 2, 5],
    ["Project p {\n a: 'b' c: 'd'\n}", 'Expected a new line or "}" but found "c"', 2, 8],
    ["Project p {\n Note { 'a'\n", 'Expected "}" but found end of input', 3, 0],
  ];

  for (const [text, msg, row, col] of cases) {
    it(`rejects ${JSON.stringify(text)}`, () => {
      expect(parseError(text)).toEqual({ msg, start: { row, col } });
    });
  }
});
