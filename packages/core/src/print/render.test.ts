import { readdirSync, readFileSync } from "node:fs";
import { join as joinPath, sep } from "node:path";
import { describe, expect, it } from "vitest";
import * as entry from "./index";
import { block, type Doc, group, hardline, ifBreak, indent, join, line, list, nbsp, softline } from "./index";
import { render } from "./render";

const INF = Number.POSITIVE_INFINITY;

// `name(a, b, c)` that breaks into one argument per line.
const call = (name: string, args: Doc[]): Doc =>
  group([name, "(", indent([softline, join([",", line], args)]), softline, ")"]);

describe("builders", () => {
  it("builds plain IR values", () => {
    expect(line).toEqual({ type: "line" });
    expect(softline).toEqual({ type: "line", soft: true });
    expect(hardline).toEqual({ type: "line", hard: true });
    expect(nbsp).toBe(" ");
    expect(indent("x")).toEqual({ type: "indent", contents: "x" });
    expect(ifBreak("a", "b")).toEqual({ type: "ifBreak", breakContents: "a", flatContents: "b" });
    expect(ifBreak("a")).toEqual({ type: "ifBreak", breakContents: "a", flatContents: "" });
    expect(group(["a", line, "b"])).toEqual({ type: "group", contents: ["a", line, "b"], break: false });
  });

  it("join puts the separator between items only", () => {
    expect(join(", ", [])).toEqual([]);
    expect(join(", ", ["a"])).toEqual(["a"]);
    expect(join(", ", ["a", "b", "c"])).toEqual(["a", ", ", "b", ", ", "c"]);
  });

  it("group precomputes whether it must break", () => {
    expect(group("a").break).toBe(false);
    expect(group("a", { shouldBreak: true }).break).toBe(true);
    expect(group(["a", hardline, "b"]).break).toBe(true);
    // Through arrays and indents, and through a nested group that must break.
    expect(group([["x", indent([hardline])]]).break).toBe(true);
    expect(group(["x", group("y", { shouldBreak: true })]).break).toBe(true);
    expect(group(["x", group(["y", line, "z"])]).break).toBe(false);
    // Only the flat branch of ifBreak is printed in a flat group.
    expect(group(ifBreak(hardline, "flat")).break).toBe(false);
    expect(group(ifBreak("broken", hardline)).break).toBe(true);
  });

  it("exposes the builders on the `doc` namespace too", () => {
    expect(entry.doc.group).toBe(group);
    expect(entry.doc.block).toBe(block);
    expect(entry.doc.list).toBe(list);
    expect(entry.doc.hardline).toBe(hardline);
  });
});

describe("render", () => {
  it("renders strings and concatenations", () => {
    expect(render("")).toBe("");
    expect(render("abc")).toBe("abc");
    expect(render(["a", ["b", [], ["c"]], "d"])).toBe("abcd");
  });

  it("keeps a group flat when it fits and breaks it when it doesn't", () => {
    const d = call("f", ["alpha", "beta", "gamma"]);
    expect(render(d, { width: 80 })).toBe("f(alpha, beta, gamma)");
    expect(render(d, { width: 21 })).toBe("f(alpha, beta, gamma)");
    expect(render(d, { width: 20 })).toBe("f(\n  alpha,\n  beta,\n  gamma\n)");
  });

  it("counts text that follows a group on the same line", () => {
    const d = [call("f", ["a", "b"]), ";"];
    expect(render(d, { width: 8 })).toBe("f(a, b);");
    expect(render(d, { width: 7 })).toBe("f(\n  a,\n  b\n);");
    // ...but stops measuring at the next line break outside the group.
    expect(render([call("f", ["a", "b"]), hardline, "a very long tail"], { width: 7 })).toBe(
      "f(a, b)\na very long tail",
    );
  });

  it("breaks outer groups first and keeps inner groups flat when they fit", () => {
    const d = call("outer", [call("inner", ["x", "y"]), "zzzzzzzzzz"]);
    expect(render(d, { width: 80 })).toBe("outer(inner(x, y), zzzzzzzzzz)");
    expect(render(d, { width: 20 })).toBe("outer(\n  inner(x, y),\n  zzzzzzzzzz\n)");
    expect(render(d, { width: 10 })).toBe("outer(\n  inner(\n    x,\n    y\n  ),\n  zzzzzzzzzz\n)");
  });

  it("treats lines and ifBreak outside every group as broken", () => {
    expect(render(["a", line, "b", softline, "c"], { width: 80 })).toBe("a\nb\nc");
    expect(render(["a", ifBreak("B", "F")], { width: INF })).toBe("aB");
    expect(render(["a", line, "b"], { width: INF })).toBe("a\nb");
  });

  it("indents nested levels with spaces or a string unit", () => {
    const d = group(["{", indent([line, "a", indent([line, "b"])]), line, "}"], { shouldBreak: true });
    expect(render(d)).toBe("{\n  a\n    b\n}");
    expect(render(d, { indent: 4 })).toBe("{\n    a\n        b\n}");
    expect(render(d, { indent: "\t" })).toBe("{\n\ta\n\t\tb\n}");
    expect(render(d, { indent: 0 })).toBe("{\na\nb\n}");
  });

  it("measures indentation as part of the line", () => {
    const d = block("x", [call("f", ["aa", "bb"])]);
    // "    f(aa, bb)" is 13 columns with a 4-space unit.
    expect(render(d, { width: 13, indent: 4 })).toBe("x {\n    f(aa, bb)\n}");
    expect(render(d, { width: 12, indent: 4 })).toBe("x {\n    f(\n        aa,\n        bb\n    )\n}");
  });

  it("writes no indentation on blank lines", () => {
    const d = block("x", ["a", "", "b"]);
    expect(render(d)).toBe("x {\n  a\n\n  b\n}");
  });

  it("trims spaces and tabs at the end of each line", () => {
    expect(render(["a", group(["b", line]), hardline, "c"])).toBe("ab\nc");
    expect(render(["a", nbsp, "\t", hardline, "b"], { width: INF })).toBe("a\nb");
    expect(render(group([indent([hardline, group([line]), hardline]), "x"]))).toBe("\n\n  x");
    // Text before the trailing whitespace is kept, across chunks.
    expect(render(["x ", "", " ", hardline, "y"])).toBe("x\ny");
    expect(render(["a", hardline, "  ", hardline, "b"])).toBe("a\n\nb");
    // ...and at the end of the output, but not before a newline inside text.
    expect(render(group(["a", line]))).toBe("a");
    expect(render(["a ", "\nb"])).toBe("a \nb");
  });

  it("chooses the ifBreak branch from the enclosing group's mode", () => {
    const trailingComma = (items: Doc[]) =>
      group(["[", indent([softline, join([",", line], items), ifBreak(",")]), softline, "]"]);
    expect(render(trailingComma(["a", "b"]), { width: 80 })).toBe("[a, b]");
    expect(render(trailingComma(["a", "b"]), { width: 3 })).toBe("[\n  a,\n  b,\n]");
    expect(render(group(["x", ifBreak("B", "F")]), { width: 80 })).toBe("xF");
    expect(render(group(["x", ifBreak("B", "F"), hardline]), { width: 80 })).toBe("xB\n");
  });

  it("measures the flat branch of ifBreak", () => {
    const d = group(["ab", ifBreak("", "cdef"), line, "g"]);
    expect(render(d, { width: 8 })).toBe("abcdef g");
    expect(render(d, { width: 7 })).toBe("ab\ng");
  });

  it("forces enclosing groups to break on a hardline", () => {
    const d = group(["(", indent([softline, "a", hardline, "b"]), softline, ")"]);
    expect(render(d, { width: 80 })).toBe("(\n  a\n  b\n)");
    expect(render(d, { width: INF })).toBe("(\n  a\n  b\n)");
    // The break propagates out through every enclosing group.
    const outer = group(["x", line, group(["y", line, d])]);
    expect(render(outer, { width: 80 })).toBe("x\ny\n(\n  a\n  b\n)");
  });

  it("honours shouldBreak", () => {
    const d = group(["a", line, "b"], { shouldBreak: true });
    expect(render(d, { width: 80 })).toBe("a\nb");
    expect(render(d, { width: INF })).toBe("a\nb");
  });

  it("never breaks at nbsp", () => {
    const d = group(["'a'", nbsp, "'b'", line, "c"]);
    expect(render(d, { width: 1 })).toBe("'a' 'b'\nc");
  });

  it("writes newlines inside text verbatim and resets the column", () => {
    const body = "line one\nline two";
    expect(render(block("fn", [body]))).toBe("fn {\n  line one\nline two\n}");
    // The column after the text is its last line's length: "x"(1) + ", y" fits in 4.
    const d = ["abcdefghij\nx", group([",", line, "y"])];
    expect(render(d, { width: 4 })).toBe("abcdefghij\nx, y");
    expect(render(d, { width: 3 })).toBe("abcdefghij\nx,\ny");
    // A newline inside measured text ends the measurement.
    expect(render(group(["ab", line, "c\nlong long long"]), { width: 4 })).toBe("ab c\nlong long long");
  });

  it("lays everything out flat at width Infinity", () => {
    const long = Array.from({ length: 200 }, (_, i) => `item${i}`);
    const d = call("f", long);
    const flat = render(d, { width: INF });
    expect(flat).toBe(`f(${long.join(", ")})`);
    expect(flat).not.toContain("\n");
  });

  it("renders the same at width Infinity as at a huge finite width", () => {
    const samples: Doc[] = [
      call("f", [call("g", ["a", ifBreak("B", "F")]), block("h", ["x", "y"])]),
      list("[", ["a", "b"], "]"),
      ["top", line, group(["a", softline, "b"])],
      group(["x", indent([line, list(" [", ["p", "q"], "]", { empty: "omit" })])]),
    ];
    for (const d of samples) expect(render(d, { width: INF })).toBe(render(d, { width: 1e9 }));
  });

  it("defaults to width 80 and a 2-space indent", () => {
    const d = call(
      "f",
      Array.from({ length: 10 }, () => "abcdef"),
    );
    // 10 * "abcdef" + separators is 78 columns, plus "f(" and ")" is 81.
    expect(render(d)).toBe(`f(\n${Array.from({ length: 10 }, () => "  abcdef").join(",\n")}\n)`);
  });
});

describe("block", () => {
  it("prints a header, one indented item per line, and the closing brace", () => {
    expect(render(block("Table users", ["id int", "name text"]))).toBe("Table users {\n  id int\n  name text\n}");
    expect(render(block(["Enum ", "status"], ["active"]), { width: INF, indent: "\t" })).toBe(
      "Enum status {\n\tactive\n}",
    );
  });

  it("prints an empty body as {}", () => {
    expect(render(block("Table t", []))).toBe("Table t {}");
  });

  it("takes custom delimiters and omits the space for an empty header", () => {
    expect(render(block("BEGIN", ["a;", "b;"], { open: "ATOMIC", close: "END" }))).toBe(
      "BEGIN ATOMIC\n  a;\n  b;\nEND",
    );
    expect(render(block("", ["x;"]))).toBe("{\n  x;\n}");
    expect(render(block([], []))).toBe("{}");
    expect(render(block([""], ["x;"]))).toBe("{\n  x;\n}");
    expect(render(block([[], ""], []))).toBe("{}");
  });

  it("nests", () => {
    const d = block("a", [block("b", ["c"]), "d"]);
    expect(render(d, { indent: "\t" })).toBe("a {\n\tb {\n\t\tc\n\t}\n\td\n}");
  });

  it("breaks the groups around it", () => {
    const d = group(["x(", block("", ["y"]), ")"]);
    expect(d.break).toBe(true);
  });
});

describe("list", () => {
  it("prints flat when it fits and one item per line otherwise", () => {
    const d = list("[", ["pk", "unique", "not null"], "]");
    expect(render(d, { width: 80 })).toBe("[pk, unique, not null]");
    expect(render(d, { width: 10 })).toBe("[\n  pk,\n  unique,\n  not null\n]");
  });

  it("takes a custom separator", () => {
    expect(render(list("(", ["a", "b"], ")", { separator: " |" }))).toBe("(a | b)");
  });

  it("keeps the brackets of an empty list by default", () => {
    expect(render(list("[", [], "]"))).toBe("[]");
    expect(render(list("[", [], "]", { empty: "keep" }))).toBe("[]");
  });

  it("disappears entirely when empty and empty is omit", () => {
    const column = (settings: Doc[]) => ["id int", list(" [", settings, "]", { empty: "omit" })];
    expect(render(column([]))).toBe("id int");
    expect(render(column(["pk"]))).toBe("id int [pk]");
    expect(render(column(["pk", "increment"]))).toBe("id int [pk, increment]");
  });
});

describe("deep documents", () => {
  it("renders 100,000 levels of nesting without overflowing the stack", () => {
    const depth = 100_000;
    let groups: Doc = "x";
    let indents: Doc = "x";
    let arrays: Doc = "x";
    for (let i = 0; i < depth; i++) {
      groups = group(["(", groups, ")"]);
      indents = indent([line, indents]);
      arrays = [arrays];
    }
    expect(render(groups, { width: INF })).toBe(`${"(".repeat(depth)}x${")".repeat(depth)}`);
    expect(render(groups, { width: 80 })).toHaveLength(2 * depth + 1);
    expect(render(arrays, { width: 80 })).toBe("x");
    const indented = render(indents, { indent: 0 });
    expect(indented).toBe(`${"\n".repeat(depth)}x`);
  });

  it("keeps the group break check linear in nesting depth", () => {
    // Each group only looks inside down to the nearest nested group.
    let d: Doc = hardline;
    for (let i = 0; i < 100_000; i++) d = group(["a", d]);
    expect((d as entry.Group).break).toBe(true);
  });
});

describe("packaging", () => {
  it("is not imported by the parse path", () => {
    const src = joinPath(import.meta.dirname, "..");
    const offenders = (readdirSync(src, { recursive: true }) as string[])
      .filter((f) => f.endsWith(".ts") && !f.startsWith(`print${sep}`))
      .filter((f) => /["'][./]*\/print(\/|["'])/.test(readFileSync(joinPath(src, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});
