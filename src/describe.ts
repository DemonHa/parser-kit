import type { Token } from "./token";

// Error-message rendering. Unlike the parser this grew out of, the labels are
// not hardcoded: they come from the `display` fields of the lexer definition,
// so messages say "a number" instead of leaking internal type names.
export type TypeLabels = Record<string, string>;

export const describeType = (type: string, labels?: TypeLabels) => labels?.[type] ?? type;

// What actually turned up where we expected something else.
export const describeFound = (token: Token | null) => {
  if (token === null) return "end of input";
  if (token.value === "\n") return "a new line";
  return `"${token.value}"`;
};

// Render a literal we were expecting. Whitespace has no visible glyph, so spell
// it out instead of dropping a raw control character into the message.
export const renderLiteral = (value: string) => (value === "\n" ? "a new line" : `"${value}"`);

// Format the set of literals we were expecting as a readable list:
// `":"`, or `"pk", "unique" or "note"`.
export const quoteList = (value: string | readonly string[]) => {
  const values: readonly string[] = typeof value === "string" ? [value] : value;
  const literals = values.map(renderLiteral);
  if (literals.length <= 1) {
    return literals[0] ?? "";
  }
  return `${literals.slice(0, -1).join(", ")} or ${literals[literals.length - 1]}`;
};
