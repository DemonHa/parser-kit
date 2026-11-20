import { ParseError, stripSpans } from "@parser-kit/core";
import { expect } from "vitest";
import type { DbmlDocument, Element } from "../src/index";
import { dbml } from "../src/index";

/** The top-level elements an error message lists, in registry order. */
export const ELEMENTS = '"Project", "Table", "Ref", "Enum", "TableGroup", "Note", "TablePartial" or "records"';

/** The document's elements with spans stripped. */
export const elements = (text: string): Element[] => stripSpans(dbml.parse(text)).elements;

/** The only element of `text`, spans stripped. */
export const only = <T extends Element["type"]>(text: string, type: T): Extract<Element, { type: T }> => {
  const all = elements(text);
  expect(all).toHaveLength(1);
  expect(all[0]!.type).toBe(type);
  return all[0] as Extract<Element, { type: T }>;
};

/** The full tree, spans included. */
export const parse = (text: string): DbmlDocument => dbml.parse(text);

/** The error `dbml.parse` throws for `text`: its message and where it starts. */
export const parseError = (text: string): { msg: string; start: { row: number; col: number } } => {
  try {
    dbml.parse(text);
  } catch (error) {
    expect(error).toBeInstanceOf(ParseError);
    const { msg, start } = error as ParseError;
    return { msg, start };
  }
  throw new Error(`expected ${JSON.stringify(text)} to fail`);
};

export const at = (row: number, col: number) => ({ row, col });
export const span = (startRow: number, startCol: number, endRow: number, endCol: number) => ({
  start: at(startRow, startCol),
  end: at(endRow, endCol),
});

/** The ident a test expects: `id("x")`, or `id("x", true)` for a quoted one. */
export const id = (value: string, quoted = false) => (quoted ? { value, quoted: true as const } : { value });

/** A qualified name: `qn("t")` or `qn("t", "s")`. */
export const qn = (name: string, schema: string | null = null) => ({
  schema: schema === null ? null : id(schema),
  name: id(name),
});
