import { describe, expect, it } from "vitest";
import { type Doc, definePrinter, join, type NodePrinter, render } from "./index";
import { fieldCoverage } from "./testing";

type Setting = { kind: "pk" } | { kind: "note"; text: string };
interface Column {
  name: string;
  type: string;
  settings: Setting[];
}
type Node =
  | { kind: "table"; name: string; columns: Column[]; note?: string; span?: unknown }
  | { kind: "enum"; name: string; values: string[] };

const setting = definePrinter<Setting>()("kind", {
  pk: () => "pk",
  note: (s) => ["note: '", s.text, "'"],
});
const column = (c: Column): Doc => [
  c.name,
  " ",
  c.type,
  c.settings.length ? [" [", join(", ", c.settings.map(setting)), "]"] : "",
];

// Drops a table's note, the way a printer can handle every kind and still lose a field.
const lossy = definePrinter<Node>()("kind", {
  table: (t) => ["Table ", t.name, " { ", join("; ", t.columns.map(column)), " }"],
  enum: (e) => ["Enum ", e.name, " { ", join(" ", e.values), " }"],
});
const full: NodePrinter<Node, "kind"> = definePrinter<Node>()("kind", {
  ...lossy.handlers,
  table: (t) => [lossy.handlers.table(t, full), t.note ? [" Note: '", t.note, "'"] : ""],
});

const corpus: Node[] = [
  {
    kind: "table",
    name: "users",
    columns: [
      { name: "id", type: "int", settings: [{ kind: "pk" }] },
      { name: "bio", type: "text", settings: [{ kind: "note", text: "free text" }] },
    ],
    note: "people",
    span: { start: 0, end: 1 },
  },
  { kind: "table", name: "tags", columns: [] },
];

describe("fieldCoverage", () => {
  it("reports a field the printer never reads", () => {
    const coverage = fieldCoverage({ key: "kind" });
    for (const node of corpus) render(lossy(coverage.track(node)));
    expect(coverage.report()).toEqual({ kinds: [], fields: ["table.note"] });
  });

  it("is clean once the printer reads it, and ignores spans", () => {
    const coverage = fieldCoverage({ key: "kind" });
    for (const node of corpus) render(full(coverage.track(node)));
    expect(coverage.report()).toEqual({ kinds: [], fields: [] });
  });

  it("reports listed variants the corpus never printed", () => {
    const coverage = fieldCoverage({ key: "kind", kinds: ["table", "enum", "pk", "note"] });
    for (const node of corpus) render(full(coverage.track(node)));
    expect(coverage.report().kinds).toEqual(["enum"]);
  });

  it("names records without a discriminant by where they sit", () => {
    const coverage = fieldCoverage({ key: "kind", ignore: [] });
    const nameOnly = definePrinter<Node>()("kind", {
      table: (t) => t.columns.map((c) => c.name).join(","),
      enum: (e) => e.name,
    });
    render(nameOnly(coverage.track(corpus[0]!)));
    // The settings were never visited, so their kinds were never seen: list
    // them in `kinds` to have them reported. Their parent field is, though.
    expect(coverage.report()).toEqual({
      kinds: [],
      fields: ["table.columns.settings", "table.columns.type", "table.name", "table.note", "table.span"],
    });
  });

  it("tracks a list of trees, and leaves the values the printer sees unchanged", () => {
    const coverage = fieldCoverage({ key: "kind" });
    const tracked = coverage.track(corpus);
    expect(Array.isArray(tracked)).toBe(true);
    expect(tracked).toEqual(corpus);
    expect(tracked[0]).toBe(tracked[0]);
    expect(render(join("\n", tracked.map(full)))).toBe(render(join("\n", corpus.map(full))));
    expect(coverage.track("text")).toBe("text");
  });

  it("tracks deep inside frozen trees", () => {
    const coverage = fieldCoverage({ key: "kind" });
    const col: Column = Object.freeze({ name: "id", type: "int", settings: Object.freeze([]) as unknown as Setting[] });
    const deep = Object.freeze({
      kind: "table" as const,
      name: "t",
      note: "n",
      columns: Object.freeze([col]) as unknown as Column[],
    });
    render(lossy(coverage.track(deep)));
    expect(coverage.report().fields).toEqual(["table.note"]);
  });

  it("tracks prototype-less nodes and a node reached twice", () => {
    const coverage = fieldCoverage({ key: "kind" });
    const shared = Object.assign(Object.create(null) as object, { kind: "pk" as const }) as Setting;
    const column: Column = { name: "id", type: "int", settings: [shared, shared] };
    const tracked = coverage.track({ kind: "table" as const, name: "t", columns: [column] });
    expect(tracked.columns[0]!.settings[0]).toBe(tracked.columns[0]!.settings[1]);
    expect(render(lossy(tracked))).toBe("Table t { id int [pk, pk] }");
    expect(coverage.report()).toEqual({ kinds: [], fields: [] });
  });

  it("reads frozen trees without breaking proxy invariants", () => {
    const coverage = fieldCoverage({ key: "kind" });
    const frozen = Object.freeze({
      kind: "enum" as const,
      name: "e",
      values: Object.freeze(["a", "b"]) as unknown as string[],
    });
    expect(render(full(coverage.track(frozen)))).toBe("Enum e { a b }");
    expect(coverage.report().fields).toEqual([]);
  });
});
