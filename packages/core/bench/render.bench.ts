import { bench, describe } from "vitest";
import { block, type Doc, group, indent, join, line, list, render, softline } from "../src/print/index";

// Rendering throughput for `@parser-kit/core/print`. The doc is built once and
// shaped like a printed program: blocks of statements holding nested calls and
// comma lists, so both the break decisions and the flat fast path get exercised.

const call = (name: string, args: Doc[]): Doc =>
  group([name, "(", indent([softline, join([",", line], args)]), softline, ")"]);

const statement = (i: number): Doc =>
  group([
    `const value${i} =`,
    indent([line, call("compute", [call("lookup", ["table", `"key${i}"`]), list("[", ["1", "2", "3", `${i}`], "]")])]),
    ";",
  ]);

const program: Doc = join(
  [line, line],
  Array.from({ length: 50 }, (_, f) =>
    block(
      ["function handler", String(f), "()"],
      Array.from({ length: 20 }, (_, s) => statement(f * 20 + s)),
    ),
  ),
);

describe("render a 1,000-statement doc", () => {
  bench("width Infinity (flat fast path)", () => {
    render(program, { width: Number.POSITIVE_INFINITY });
  });
  bench("width 80", () => {
    render(program, { width: 80 });
  });
  bench("width 40", () => {
    render(program, { width: 40 });
  });
});
