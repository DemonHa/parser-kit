import { ParseError } from "@parser-kit/core";
import { describe, expect, it } from "vitest";
import { dbml } from "../src/index";
import { ELEMENTS, elements, parseError, span } from "./helpers";

describe("Document", () => {
  it("parses an empty document", () => {
    expect(dbml.parse("")).toEqual({ type: "document", elements: [], span: span(1, 0, 1, 0) });
    expect(dbml.parse("\n// nothing\n\n").elements).toEqual([]);
  });

  it("spans the first element to the last", () => {
    expect(dbml.parse("\n\nTable a { id int }\nRef: a.id > b.id\n\n").span).toEqual(span(3, 0, 4, 16));
  });

  it("parses every element kind together", () => {
    const text = "Project p { a: 'b' }\nTable a { id int }\nEnum e { x }\nRef: a.id > b.id";
    expect(elements(text).map((element) => element.type)).toEqual(["project", "table", "enum", "ref"]);
  });

  it("rejects anything else at the top level", () => {
    expect(parseError("Table a { id int } extra")).toEqual({
      msg: `Expected ${ELEMENTS} but found "extra"`,
      start: { row: 1, col: 19 },
    });
    expect(parseError("}")).toEqual({
      msg: `Expected ${ELEMENTS} but found "}"`,
      start: { row: 1, col: 0 },
    });
  });

  it("surfaces lexer errors as themselves", () => {
    expect(parseError("Table a {\n id int [note: 'x\n}")).toEqual({
      msg: "Unterminated string",
      start: { row: 2, col: 15 },
    });
    expect(parseError("Table a {\n id int [note: `x]\n}")).toEqual({
      msg: "Unterminated expression",
      start: { row: 2, col: 15 },
    });
  });

  it("diagnose keeps the elements before the first error and reports it", () => {
    const { ast, errors } = dbml.diagnose("Table a { id int }\nTable b {\n id\n}\nTable c { id int }");
    expect(ast.elements.map((element) => element.type)).toEqual(["table"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(ParseError);
    expect(errors[0]!.msg).toBe("Expected a column type but found a new line");
    expect(errors[0]!.start).toEqual({ row: 3, col: 3 });
    // Recovery skips the rest of the input, still recording lexer errors on the way.
    const later = dbml.diagnose("Table a {\n id\n}\nTable b { x int [note: 'oops }\nTable c { y int }");
    expect(later.ast.elements).toEqual([]);
    expect(later.errors.map(({ msg, start }) => ({ msg, start }))).toEqual([
      { msg: "Expected a column type but found a new line", start: { row: 2, col: 3 } },
      { msg: "Unterminated string", start: { row: 4, col: 23 } },
    ]);
    expect(dbml.diagnose("Table a { id int }")).toEqual({ ast: dbml.parse("Table a { id int }"), errors: [] });
  });
});
