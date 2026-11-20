import { Parser } from "@dbml/core";
import { createInputStream, ParseError, type Token } from "@parser-kit/core";
import { describe, expect, it } from "vitest";
import { type DbmlTokenType, dbml, dbmlLexer } from "../src/index";
import { type CoreModel, projectCoreModel } from "./core-projection";
import { CORPUS, MALFORMED, type Sample } from "./corpus";
import { type ProjectedDocument, projectDocument } from "./projection";

// --- differential test against @dbml/core ---
//
// `@dbml/core` (pinned to 12.1.0 in the workspace catalog) is the incumbent
// DBML parser and the de facto spec. This file holds this package to it:
//
//   - Every `CORPUS` document, and every `PROJECTION_CASES` document below,
//     parses with both, and both results, mapped onto the common shape in
//     `projection.ts`, are equal: tables, columns, types, settings, defaults,
//     notes, indexes, checks, refs (inline ones included), enums, table
//     groups, sticky notes, records and the project, with table partials
//     merged the way `@dbml/core` merges them.
//   - Every `MALFORMED` input is rejected by both. Error messages are not
//     compared; they differ by design.
//   - A deterministic batch of mutants of the corpus (a token dropped,
//     repeated or replaced, another token inserted, or a line break inserted)
//     gets the same verdict from both.
//
// "Rejected by `@dbml/core`" means it reports an error outside
// `SEMANTIC_CODES`. Errors in that list (unknown names, duplicates, empty
// tables, …) come from its validator; this package leaves those checks to a
// later semantic pass and must accept such a document.
//
// Where the two parsers deliberately disagree, the case is listed in
// `KNOWN_DIFFERENCES` with its reason, and the test checks that the
// difference still holds, so an entry can't go stale. Nothing is skipped
// silently: a new disagreement is either a bug to fix or a new entry.

const coreParser = new Parser();

/** `@dbml/core`'s model of `source`, mapped onto the common shape; throws what `@dbml/core` throws. */
const coreProjection = (source: string): ProjectedDocument =>
  projectCoreModel(coreParser.parse(source, "dbmlv2").normalize() as unknown as CoreModel);

/**
 * `@dbml/core` error codes that are semantic, not syntactic: name
 * resolution, duplicates, empty elements, conflicting settings, record field
 * counts, colour validation.
 */
const SEMANTIC_CODES = new Set([
  3003, // DUPLICATE_NAME
  3012, // DUPLICATE_TABLE_SETTING
  3018, // EMPTY_TABLE
  3023, // DUPLICATE_COLUMN_NAME (also a duplicate enum value)
  3024, // DUPLICATE_COLUMN_SETTING
  3031, // DUPLICATE_ENUM_ELEMENT_SETTING
  3033, // EMPTY_ENUM
  3036, // DUPLICATE_REF_SETTING
  3046, // NOTE_REDEFINED
  3050, // DUPLICATE_NOTE_SETTING
  3056, // DUPLICATE_INDEX_SETTING
  3057, // DUPLICATE_INDEX_COLUMN
  3061, // PROJECT_REDEFINED
  3070, // DUPLICATE_TABLE_PARTIAL_SETTING
  3074, // DUPLICATE_TABLE_PARTIAL_INJECTION_NAME
  3081, // DUPLICATE_CHECK_SETTING
  3086, // DUPLICATE_COLUMN_REFERENCES_IN_RECORDS
  3087, // DUPLICATE_RECORDS_FOR_TABLE
  3089, // DUPLICATE_RECORDS_SETTING
  3098, // DUPLICATE_TABLEGROUP_SETTING
  4000, // BINDING_ERROR (unknown table, column, enum or schema)
  5001, // CIRCULAR_REF (two refs with the same endpoints)
  5002, // SAME_ENDPOINT
  5007, // UNEQUAL_FIELDS_BINARY_REF
  5008, // CONFLICTING_SETTING (`null` and `not null`)
  5009, // TABLE_REAPPEAR_IN_TABLEGROUP
]);

/**
 * Whether a `@dbml/core` error is semantic. Code 3085 (INVALID_RECORDS_FIELD)
 * covers both a row with the wrong number of fields, which is semantic
 * ("Expected 2 values but got 1"), and a malformed row, which isn't ("Invalid
 * record row structure").
 */
const isSemantic = (code: number, message: string) =>
  SEMANTIC_CODES.has(code) || (code === 3085 && message.startsWith("Expected "));

/**
 * What `@dbml/core` makes of `source`: `accepts`; `invalid` when its parser
 * takes it but validation fails, with only `SEMANTIC_CODES` or errors from its
 * model (a missing column, a duplicate field, which come without a code);
 * `rejects` otherwise. `@dbml/core` wraps every exception as a diagnostic, so
 * anything else without a code is a crash inside it, and is thrown rather
 * than counted as a rejection.
 */
const coreVerdict = (source: string): "accepts" | "invalid" | "rejects" => {
  try {
    coreParser.parse(source, "dbmlv2");
    return "accepts";
  } catch (error) {
    const diags = (error as { diags?: unknown[] }).diags;
    if (!diags) throw error;
    let semantic = true;
    for (const diag of diags as { code?: unknown; message?: string }[]) {
      if (typeof diag.code === "number") semantic &&= isSemantic(diag.code, diag.message ?? "");
      else if (!(diag instanceof Error && (diag as { error?: unknown }).error === "error"))
        throw new Error(`@dbml/core crashed: ${diag.message}`, { cause: diag });
    }
    return semantic ? "invalid" : "rejects";
  }
};

/** Whether `@dbml/core`'s parser takes `source`, whatever its validator says. */
const coreParses = (source: string) => coreVerdict(source) !== "rejects";

/** Whether this package parses `source`. Anything thrown besides a `ParseError` is a crash and propagates. */
const accepts = (source: string): boolean => {
  try {
    dbml.parse(source);
    return true;
  } catch (error) {
    if (error instanceof ParseError) return false;
    throw error;
  }
};

/** Sorts the top-level lists by content, since the two models order them differently (core groups by schema). */
const canonical = (doc: ProjectedDocument): ProjectedDocument => {
  const sorted = <T>(items: T[]) =>
    items
      .map((item) => [JSON.stringify(item), item] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, item]) => item);
  return {
    ...doc,
    tables: sorted(doc.tables),
    refs: sorted(doc.refs),
    enums: sorted(doc.enums),
    tableGroups: sorted(doc.tableGroups),
    notes: sorted(doc.notes),
    records: sorted(doc.records),
  };
};

// `@dbml/core` 12.1.0 merges table partials with `Array#toReversed`, which
// Node 18 lacks, so on Node 18 it crashes on any table that injects a
// partial. There, those documents are still parsed by this package, but their
// comparison is reported as skipped and their mutants aren't generated; both
// run on every newer Node.
const coreMergesPartials = typeof (Array.prototype as { toReversed?: unknown }).toReversed === "function";
const injectsPartial = (source: string) =>
  dbml
    .parse(source)
    .elements.some(
      (element) => element.type === "table" && element.items.some((item) => item.type === "partialInjection"),
    );

// --- More documents for the projection ---

/**
 * Documents beyond the corpus that exercise the projection's model rules:
 * how partials merge, when several `pk` columns become an index, how a
 * column type naming an enum or its alias is spelled, alias resolution in
 * refs and groups. Both parsers must accept each and project it the same.
 */
const PROJECTION_CASES: { name: string; dbml: string }[] = [
  {
    name: "partials: precedence, positions, indexes, checks and inline refs",
    dbml: `TablePartial a [note: 'from a', headercolor: #111] {
  x int [note: 'a.x']
  y int [note: 'a.y']
  indexes {
    x
  }
  checks {
    \`x > 0\` [name: 'cx']
  }
}

TablePartial b [headercolor: #222] {
  y int [note: 'b.y']
  z int [ref: > other.id]
  indexes {
    (y, z) [unique]
  }
}

Table other {
  id int
}

Table s.t {
  id int [pk]
  ~a
  mid int
  ~b
  x varchar [note: 'own x']
  indexes {
    id [name: 'own']
  }
}
`,
  },
  {
    name: "partials: a block note, a shadowed partial and two partials with the same column",
    dbml: `TablePartial p {
  a int [note: 'p']
  Note: 'partial note'
}

TablePartial q {
  a int [note: 'q']
}

Table t1 {
  a int
  ~p
}

Table t2 {
  ~p
  ~q
}
`,
  },
  {
    name: "several pk columns make a composite primary key index",
    dbml: `Table u {
  a int [pk]
  b int [pk]
  indexes {
    a [unique]
  }
}
`,
  },
  {
    name: "several pk columns in a partial make its own primary key index",
    dbml: `TablePartial p {
  a int [pk]
  b int [pk]
}

Table t {
  ~p
  c int
}
`,
  },
  {
    name: "records values, and a records block naming a table by its alias",
    dbml: `enum e {
  a
}

Table s.users as U {
  id int
  score float
  status e
  label varchar
  created timestamp
}

records U(id, score, status, label, created) {
  -3, -2.5, e.a, 'x', \`now()\`
  4, 1e2, null, , '2024-01-01'
}
`,
  },
  {
    name: "column types naming an enum, its alias or another schema",
    dbml: `enum s.status as St {
  a
  b
}

enum public.e as E {
  x
}

Table t {
  w St [default: St.a]
  w2 St[]
  w3 St(2)
  x s.status
  y s.status[]
  z e
  v public.e
  u e(1)
  u2 E[3]
  p pg.uuid
  q "pg"."int 4"
}
`,
  },
  {
    name: "array suffixes opening a later line",
    dbml: `Table t {
  tags text
  []
  grid int

  [3]
  [] [not null]
}
`,
  },
  {
    name: "aliases in inline refs, long refs and group members",
    dbml: `Table users as U {
  id int
}

Table posts as P {
  id int
  uid int [ref: > U.id]
}

Ref {
  P.id - U.id
}

TableGroup g {
  U
  posts
}
`,
  },
  {
    name: "inline refs with every relation and optional side",
    dbml: `Table a {
  id int
  b1 int [ref: < b.id]
  b2 int [ref: - b.id]
  b3 int [ref: <> b.id]
  b4 int [ref: ?<>? b.id]
  b5 int [ref: ?> b.id]
}

Table b {
  id int
}
`,
  },
  {
    name: "custom setting keys in any case",
    dbml: `Table t [Owner: 'x', Data Team: 1] {
  c int [MyKey: 'v']
  d int
}

TableGroup g [Hello: 'x'] {
  t
}

Ref: t.c > t.d [Who: 'me']
`,
  },
];

// --- Known differences ---

interface KnownDifference {
  /** Why the parsers disagree, for the README's differences list. */
  reason: string;
  /**
   * What this package does with each document. `@dbml/core` does the
   * opposite: when this package rejects, `@dbml/core`'s parser takes the
   * document (its validator may still object); when this package accepts,
   * `@dbml/core` rejects it (see `coreVerdict`).
   */
  ours: "rejects" | "accepts";
  documents: string[];
  /** `MALFORMED` entries that show it: `@dbml/core`'s parser takes them. */
  malformed?: string[];
  /** Mutants (see `mutants` below) that show it, by id. */
  mutants?: string[];
}

const KNOWN_DIFFERENCES: KnownDifference[] = [
  {
    reason:
      "More than two parts in a table, sticky note, records or table group member name (`a.b.c`), or more " +
      "than three in a ref endpoint: `@dbml/core`'s parser reads the extra parts as a nested schema, which " +
      "its model then accepts where nothing has to resolve against it and otherwise reports as unknown.",
    ours: "rejects",
    documents: [
      "Table a.b.c {\n  id int\n}\n",
      "Note a.b.c {\n  'x'\n}\n",
      "Table a.b.t {\n  a int\n}\nrecords a.b.t(a) {\n  1\n}\n",
      "Table a.b.c {\n  d int\n}\nTable e {\n  f int\n}\nRef: a.b.c.d > e.f\n",
      "Table t {\n  id int\n}\nTableGroup g {\n  x.y.t\n}\n",
    ],
    malformed: ["table name with three parts", "ref endpoint with four parts"],
    mutants: ["hr and payroll schema #4"],
  },
  {
    reason:
      "A single-part inline ref target (`[ref: > id]`): `@dbml/core` resolves it to a column of the same " +
      "table; here an inline ref target needs a table and a column.",
    ours: "rejects",
    documents: ["Table t {\n  id int\n  c int [ref: > id]\n}\n"],
    malformed: ["ref setting single-part target"],
  },
  {
    reason: "Repeated signs on a number (`--1`, `- -1`) in a default or a records field.",
    ours: "rejects",
    documents: ["Table t {\n  c int [default: --1]\n}\n", "Table t {\n  a int\n}\nrecords t(a) {\n  - -1\n}\n"],
    mutants: ["default negative float #2"],
  },
  {
    reason: "Chained column type suffixes (`int(1)(2)`, `int[](1)`) and comma-separated array sizes (`int[1,2]`).",
    ours: "rejects",
    documents: [
      "Table t {\n  c int(1)(2)\n}\n",
      "Table t {\n  c int[](1)\n}\n",
      "Table t {\n  c int[1,2]\n}\n",
      "Table t {\n  c int\n  [1,2]\n}\n",
    ],
  },
  {
    reason: "YAML front matter (`---` … `---`), which `@dbml/core` uses for architecture files.",
    ours: "rejects",
    documents: ["---\nfoo: bar\n---\nTable t {\n  id int\n}\n"],
  },
  {
    reason:
      "The parse stream drops comments and `\\r` before the grammar sees them, so a comment counts as a " +
      "space between glued tokens (`id/**/int`), a `\\r` as a space before a header's settings, and a comment " +
      "or `\\r\\n` ends the line before an index's later-line `[`.",
    ours: "accepts",
    documents: [
      "Table t {\n  id/**/int\n}\n",
      "Table a\r\n[note: 'x'] {\r\n  id int\r\n}\r\n",
      "Table t {\n  id int\n  name int\n  indexes {\n    id/**/name\n  }\n}\n",
      "Table t {\n  id int\n  indexes {\n    (id)// c\n    [unique]\n  }\n}\n",
    ],
  },
  {
    reason:
      "The same, the other way: a comment or `\\r\\n` before an index column's later-line sort order, or a " +
      "column type's later-line array suffix, hides the line break `@dbml/core` attaches the `[` across.",
    ours: "rejects",
    documents: [
      "Table t {\n  id int\n  indexes {\n    id// c\n    [desc]\n  }\n}\n",
      "Table t {\r\n  id int\r\n  indexes {\r\n    id\r\n    [desc]\r\n  }\r\n}\r\n",
      "Table t {\r\n  tags text\r\n  []\r\n}\r\n",
      "Table t {\n  tags text// c\n  []\n}\n",
    ],
  },
  {
    reason: "An element keyword as a Project property key (`table: 'x'`), which `@dbml/core` reads as an element.",
    ours: "accepts",
    documents: ["Project p {\n  table: 'x'\n}\n"],
  },
  {
    reason:
      "Colour literals aren't validated: `#` followed by letters and digits is a colour (`#3a5x`, `#11223344`), " +
      "as `@dbml/core`'s lexer reads it, but its validator takes only 3- or 6-digit hex.",
    ours: "accepts",
    documents: ["Table t [headercolor: #3a5x] {\n  id int\n}\n", "Table t [headercolor: #11223344] {\n  id int\n}\n"],
  },
];

// --- Mutants ---

/** Mutants per corpus document; a mutant's id is its document's name and its index (`"table basic #2"`). */
const MUTANTS_PER_DOCUMENT = 8;

/**
 * A deterministic set of near-miss documents: for each corpus document of up
 * to 2,000 characters, `MUTANTS_PER_DOCUMENT` mutants, each changing the
 * document at one token drawn by a generator seeded with the document's name,
 * so adding corpus documents leaves existing ids alone. A mutation that leaves
 * the document unchanged is dropped. `withPartials: false` leaves out the
 * documents that inject a partial (see `coreMergesPartials`).
 */
const mutants = ({ withPartials }: { withPartials: boolean }): { id: string; source: string }[] => {
  const result: { id: string; source: string }[] = [];
  for (const sample of CORPUS) {
    if (sample.dbml.length > 2000) continue;
    if (!withPartials && injectsPartial(sample.dbml)) continue;
    const tokens = tokenize(sample.dbml);
    if (tokens.length < 2) continue;
    // A 32-bit linear congruential generator; `Math.imul` keeps the product exact.
    let seed = [...sample.name].reduce((hash, char) => (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0, 7);
    const random = (below: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return (seed >>> 16) % below;
    };
    for (let index = 0; index < MUTANTS_PER_DOCUMENT; index++) {
      const token = tokens[random(tokens.length)]!;
      const other = tokens[random(tokens.length)]!;
      const before = sample.dbml.slice(0, token.start);
      const after = sample.dbml.slice(token.end);
      const text = sample.dbml.slice(token.start, token.end);
      const otherText = sample.dbml.slice(other.start, other.end);
      const source = [
        before + after, // drop the token
        `${before}${text} ${text}${after}`, // repeat it
        `${before}\n${text}${after}`, // break the line before it
        before + otherText + after, // replace it with another token of the document
        `${before}${otherText} ${text}${after}`, // insert another token before it
      ][random(5)]!;
      if (source !== sample.dbml) result.push({ id: `${sample.name} #${index}`, source });
    }
  }
  return result;
};

/** The document's tokens other than comments, as offsets into it. */
const tokenize = (source: string): { start: number; end: number }[] => {
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") lineStarts.push(i + 1);
  const offset = ({ row, col }: { row: number; col: number }) => lineStarts[row - 1]! + col;
  const stream = dbmlLexer.tokenize(createInputStream(source));
  const tokens: { start: number; end: number }[] = [];
  let token: Token<DbmlTokenType> | null;
  while ((token = stream.next()) !== null)
    if (token.type !== "comment") tokens.push({ start: offset(token.position.start), end: offset(token.position.end) });
  return tokens;
};

// --- Tests ---

const named = <T extends { name: string }>(items: readonly T[]) => items.map((item) => [item.name, item] as const);

const compareProjections = (sample: Pick<Sample, "dbml">, skip: (note?: string) => void) => {
  const ours = canonical(projectDocument(dbml.parse(sample.dbml)));
  if (!coreMergesPartials && injectsPartial(sample.dbml)) skip("@dbml/core 12.1.0 needs Node 20+ to merge partials");
  expect(ours).toEqual(canonical(coreProjection(sample.dbml)));
};

const allowlist = (pick: (difference: KnownDifference) => string[] | undefined) =>
  new Set(KNOWN_DIFFERENCES.flatMap((difference) => pick(difference) ?? []));

describe("differential: CORPUS projects the same with both parsers", () => {
  it.for(named(CORPUS))("%s", ([, sample], { skip }) => compareProjections(sample, skip));
});

describe("differential: more documents project the same with both parsers", () => {
  it("names every case uniquely", () => {
    const names = PROJECTION_CASES.map((sample) => sample.name);
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
  });

  it.for(named(PROJECTION_CASES))("%s", ([, sample], { skip }) => compareProjections(sample, skip));
});

describe("differential: MALFORMED is rejected by both parsers", () => {
  const allowed = allowlist((difference) => difference.malformed);

  it.each(named(MALFORMED))("%s", (name, sample: Sample) => {
    expect(accepts(sample.dbml)).toBe(false);
    // Unless it is a known difference, `@dbml/core` rejects it too.
    expect(coreParses(sample.dbml)).toBe(allowed.has(name));
  });

  it("lists only MALFORMED entries in the known differences, under ones this package rejects", () => {
    const names = new Set(MALFORMED.map((sample) => sample.name));
    expect([...allowed].filter((name) => !names.has(name))).toEqual([]);
    expect(KNOWN_DIFFERENCES.filter((difference) => difference.malformed && difference.ours !== "rejects")).toEqual([]);
  });
});

describe("differential: known differences still hold", () => {
  const cases = KNOWN_DIFFERENCES.flatMap((difference) =>
    difference.documents.map((source) => [JSON.stringify(source), difference, source] as const),
  );

  it.each(cases)("%s", (_, difference: KnownDifference, source: string) => {
    expect(accepts(source)).toBe(difference.ours === "accepts");
    expect(coreParses(source)).toBe(difference.ours === "rejects");
  });
});

describe("differential: corpus mutants get the same verdict from both parsers", () => {
  const all = mutants({ withPartials: coreMergesPartials });
  const allowed = new Map(
    KNOWN_DIFFERENCES.flatMap((difference) => (difference.mutants ?? []).map((id) => [id, difference.ours] as const)),
  );

  it("generates several hundred mutants", () => {
    expect(all.length).toBeGreaterThan(500);
  });

  it("lists only existing mutants in the known differences", () => {
    const ids = new Set(mutants({ withPartials: true }).map(({ id }) => id));
    expect([...allowed.keys()].filter((id) => !ids.has(id))).toEqual([]);
  });

  it("agrees on every mutant outside the known differences", () => {
    const disagreements = all.flatMap(({ id, source }) => {
      const ours = accepts(source);
      const core = coreVerdict(source);
      const agree = ours === (core !== "rejects");
      // An allowlisted mutant must still disagree, the way its entry says.
      const expected = allowed.get(id);
      const ok = expected === undefined ? agree : !agree && ours === (expected === "accepts");
      return ok ? [] : [{ id, ours, core, source }];
    });
    expect(disagreements).toEqual([]);
  });
});
