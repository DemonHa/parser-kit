import { describe, expect, it } from "vitest";
import type { Ref } from "../src/index";
import { ELEMENTS, id, only, parse, parseError, qn, span } from "./helpers";

const ref = (text: string): Ref => only(text, "ref");
const endpoint = (table: string, columns: string[], schema: string | null = null, composite = false) => ({
  table: qn(table, schema),
  columns: columns.map((column) => id(column)),
  composite,
});

describe("Ref forms", () => {
  it("parses the short form, named or not", () => {
    expect(ref("Ref: posts.user_id > users.id")).toEqual({
      type: "ref",
      name: null,
      form: "short",
      left: endpoint("posts", ["user_id"]),
      relation: { op: ">" },
      right: endpoint("users", ["id"]),
      settings: [],
    });
    expect(ref('Ref "user posts": posts.user_id > users.id').name).toEqual(id("user posts", true));
  });

  it("parses the long form", () => {
    expect(ref("Ref fk {\n  posts.user_id > users.id [delete: cascade]\n}")).toEqual({
      type: "ref",
      name: id("fk"),
      form: "long",
      left: endpoint("posts", ["user_id"]),
      relation: { op: ">" },
      right: endpoint("users", ["id"]),
      settings: [{ kind: "action", on: "delete", action: "cascade" }],
    });
  });

  it("allows a long-form body on one line and surrounded by blank lines", () => {
    const expected = ref("Ref r {\n a.id < b.id\n}");
    expect(ref("Ref r { a.id < b.id }")).toEqual(expected);
    expect(ref("Ref r {\n\n a.id < b.id\n\n}")).toEqual(expected);
  });

  it("lets line breaks separate the header's parts and follow the relation", () => {
    expect(ref("Ref\nr\n{\n a.id >\n b.id\n}")).toEqual(ref("Ref r { a.id > b.id }"));
    expect(ref("Ref\n:\n a.id\n >\n b.id")).toEqual(ref("Ref: a.id > b.id"));
  });

  it("matches the keyword in any case", () => {
    expect(ref("REF: a.id - b.id").relation).toEqual({ op: "-" });
    expect(ref("ref: a.id - b.id").relation).toEqual({ op: "-" });
  });

  it("parses several refs", () => {
    const doc = parse("Ref: a.id > b.id\nRef: a.id - b.id\n\nRef r { a.x < b.y }");
    expect(doc.elements.map((element) => (element as Ref).form)).toEqual(["short", "short", "long"]);
  });
});

describe("Relations", () => {
  it("parses every operator", () => {
    for (const op of ["<", ">", "-", "<>"] as const) {
      expect(ref(`Ref: a.id ${op} b.id`).relation).toEqual({ op });
    }
  });

  it("needs no spaces around the operator", () => {
    expect(ref("Ref: a.id<b.id")).toEqual(ref("Ref: a.id < b.id"));
  });

  it("parses optional sides", () => {
    expect(ref("Ref: a.id >? b.id").relation).toEqual({ op: ">", rightOptional: true });
    expect(ref("Ref: a.id ?> b.id").relation).toEqual({ op: ">", leftOptional: true });
    expect(ref("Ref: a.id ?<>? b.id").relation).toEqual({ op: "<>", leftOptional: true, rightOptional: true });
    expect(ref("Ref: a.id -? b.id").relation).toEqual({ op: "-", rightOptional: true });
  });
});

describe("Endpoints", () => {
  it("parses schema-qualified endpoints", () => {
    const { left, right } = ref("Ref: s.posts.user_id > public.users.id");
    expect(left).toEqual(endpoint("posts", ["user_id"], "s"));
    expect(right).toEqual(endpoint("users", ["id"], "public"));
  });

  it("parses composite endpoints, spanning lines", () => {
    const { left, right } = ref("Ref: s.a.(x, y) > b.(\n  x,\n  y\n)");
    expect(left).toEqual(endpoint("a", ["x", "y"], "s", true));
    expect(right).toEqual(endpoint("b", ["x", "y"], null, true));
    expect(ref("Ref: a.(x) > b.(y)").left).toEqual(endpoint("a", ["x"], null, true));
  });

  it("lets line breaks surround the dots", () => {
    expect(ref("Ref: a\n.id > b.\nid")).toEqual(ref("Ref: a.id > b.id"));
  });

  it("keeps quoted parts and allows spaces around dots", () => {
    expect(ref('Ref: "my s"."my t"."my c" > b . id').left).toEqual({
      table: { schema: id("my s", true), name: id("my t", true) },
      columns: [id("my c", true)],
      composite: false,
    });
  });
});

describe("Ref settings", () => {
  it("parses actions in any case, with any spacing", () => {
    expect(
      ref(
        "Ref: a.id > b.id [delete: CASCADE, update: set  null, delete: Set Default, update: no action, delete: restrict]",
      ).settings,
    ).toEqual([
      { kind: "action", on: "delete", action: "cascade" },
      { kind: "action", on: "update", action: "set null" },
      { kind: "action", on: "delete", action: "set default" },
      { kind: "action", on: "update", action: "no action" },
      { kind: "action", on: "delete", action: "restrict" },
    ]);
  });

  it("parses color, inactive and custom properties", () => {
    expect(ref("Ref: a.id > b.id [Color: #79AD51, inactive, label: 'owns', weight: 2]").settings).toEqual([
      { kind: "property", key: id("color"), value: { kind: "color", value: "#79AD51" } },
      { kind: "inactive" },
      { kind: "property", key: id("label"), value: { kind: "string", value: "owns" } },
      { kind: "property", key: id("weight"), value: { kind: "number", value: 2 } },
    ]);
  });

  it("parses and dedents a note", () => {
    expect(ref("Ref: a.id > b.id [note: '''\n   x\n     y''']").settings).toEqual([
      { kind: "note", value: { kind: "string", value: "x\n  y", multiline: true } },
    ]);
    expect(parseError("Ref: a.id > b.id [note: 1]")).toEqual({
      msg: 'Expected a string but found "1"',
      start: { row: 1, col: 24 },
    });
  });

  it("lets the settings list span lines", () => {
    expect(ref("Ref: a.id > b.id [\n  delete: cascade\n]").settings).toHaveLength(1);
  });
});

describe("Contextual keywords in refs", () => {
  for (const word of [
    "ref",
    "note",
    "table",
    "as",
    "delete",
    "update",
    "cascade",
    "inactive",
    "enum",
    "pk",
    "null",
    "default",
    "indexes",
    "checks",
    "records",
    "project",
    "color",
    "restrict",
    "set",
    "no",
    "action",
    "true",
  ]) {
    it(`keeps ${word} usable as a name`, () => {
      expect(ref(`Ref ${word}: ${word}.${word}.${word} > ${word}.(${word}, ${word})`)).toEqual({
        type: "ref",
        name: id(word),
        form: "short",
        left: endpoint(word, [word], word),
        relation: { op: ">" },
        right: endpoint(word, [word, word], null, true),
        settings: [],
      });
    });
  }
});

describe("Ref spans", () => {
  it("spans every node of a long-form ref", () => {
    const text = ["Ref fk {", "  s.posts.(a, b) >? users.(a, b) [delete: cascade]", "}"].join("\n");
    const [r] = parse(text).elements as Ref[];
    expect(r!.span).toEqual(span(1, 0, 3, 1));
    expect(r!.name!.span).toEqual(span(1, 4, 1, 6));
    expect(r!.left.span).toEqual(span(2, 2, 2, 16));
    expect(r!.left.table.span).toEqual(span(2, 2, 2, 9));
    expect(r!.left.columns.map((column) => column.span)).toEqual([span(2, 11, 2, 12), span(2, 14, 2, 15)]);
    expect(r!.relation.span).toEqual(span(2, 17, 2, 19));
    expect(r!.right.span).toEqual(span(2, 20, 2, 32));
    expect(r!.settings[0]!.span).toEqual(span(2, 34, 2, 49));
  });

  it("spans a short-form ref with a composite endpoint and a left optional side", () => {
    const [r] = parse("Ref: a.(x, y) ?< b.(x, y)").elements as Ref[];
    expect(r!.span).toEqual(span(1, 0, 1, 25));
    expect(r!.left.span).toEqual(span(1, 5, 1, 13));
    expect(r!.relation.span).toEqual(span(1, 14, 1, 16));
    expect(r!.right.span).toEqual(span(1, 17, 1, 25));
  });

  it("spans a short-form ref to its last token", () => {
    const [r] = parse("Ref: a.id > b.id // trailing\n").elements as Ref[];
    expect(r!.span).toEqual(span(1, 0, 1, 16));
  });
});

describe("Ref errors", () => {
  const cases: [string, string, number, number][] = [
    ["Ref {\n a.id > b.id\n a.x > b.y\n}", 'Expected "}" but found "a"', 3, 1],
    ["Ref {\n}", 'Expected a column reference but found "}"', 2, 0],
    ["Ref r {\n a.id\n > b.id\n}", "Expected a relation (<, >, -, <>) but found a new line", 2, 5],
    ["Ref: a.id > b.id\n[delete: cascade]", `Expected ${ELEMENTS} but found "["`, 2, 0],
    ["Ref: a.id > b.id Table t {\n id int\n}", 'Expected "[" or a new line but found "Table"', 1, 17],
    ["Ref: a.id < > b.id", 'Expected a column reference but found ">"', 1, 12],
    ["Ref: a.id ? > b.id", 'Expected a relation (<, >, -, <>) right after "?" but found ">"', 1, 12],
    ["Ref: a.id > ?b.id", 'Expected a column reference but found "?"', 1, 12],
    ["Ref: a > b", 'Expected "." but found ">"', 1, 7],
    ["Ref: a.() > b.id", 'Expected a column name but found ")"', 1, 8],
    ["Ref: a.(x,) > b.id", 'Expected a column name but found ")"', 1, 10],
    ["Ref: x.s.a.id > b.id", 'Expected a relation (<, >, -, <>) but found "."', 1, 10],
    ["Ref s.r: a.id > b.id", 'Expected ":" or "{" but found "."', 1, 5],
    ["Ref r a.id > b.id", 'Expected ":" or "{" but found "a"', 1, 6],
    [
      "Ref: a.id > b.id [delete: foo]",
      'Expected "cascade", "restrict", "set null", "set default" or "no action" but found "foo"',
      1,
      26,
    ],
    ["Ref: a.id > b.id [delete: set]", 'Expected "null" or "default" but found "]"', 1, 29],
    [
      "Ref: a.id > b.id [delete: 'cascade']",
      'Expected "cascade", "restrict", "set null", "set default" or "no action" but found a string',
      1,
      26,
    ],
    ["Ref: a.id > b.id [inactive: true]", 'Expected "," or "]" but found ":"', 1, 26],
    ["Ref: a.id > b.id [color: 'red']", "Expected a color but found a string", 1, 25],
    ["Ref: a.id > b.id [delete: cascade] [color: #fff]", 'Expected a new line but found "["', 1, 35],
    ["Ref r { a.id > b.id x }", 'Expected "[", a new line or "}" but found "x"', 1, 20],
    ["Ref: a.id > b.id[delete: cascade]", 'Expected a space but found "["', 1, 16],
    ["Ref r {\n a.id > b.id", 'Expected "}" but found end of input', 2, 12],
  ];

  for (const [text, msg, row, col] of cases) {
    it(`rejects ${JSON.stringify(text)}`, () => {
      expect(parseError(text)).toEqual({ msg, start: { row, col } });
    });
  }
});
