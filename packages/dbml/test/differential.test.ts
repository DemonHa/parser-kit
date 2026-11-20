import { Parser } from "@dbml/core";
import { createInputStream, type Token } from "@parser-kit/core";
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
//   - Every `CORPUS` document parses with both, and both results, mapped onto
//     the common shape in `projection.ts`, are equal: tables, columns, types,
//     settings, defaults, notes, indexes, checks, refs (inline ones included),
//     enums, table groups, sticky notes, records and the project, with table
//     partials merged the way `@dbml/core` merges them.
//   - Every `MALFORMED` input is rejected by both. Error messages are not
//     compared; they differ by design.
//   - A deterministic batch of mutants of the corpus (a token dropped,
//     repeated, replaced, or a line break inserted) gets the same verdict
//     from both, counting as a `@dbml/core` rejection only an error in its
//     syntax range (codes 1000–1999). Validation errors (unknown tables,
//     duplicates, …) are not parse errors here.
//
// Where the two parsers deliberately disagree, the case is listed in
// `KNOWN_DIFFERENCES` with its reason, and the test checks that the
// difference still holds, so an entry can't go stale. Nothing is skipped
// silently: a new disagreement is either a bug to fix or a new entry.

const coreParser = new Parser();

/** `@dbml/core`'s model of `source`, mapped onto the common shape; throws what `@dbml/core` throws. */
const coreProjection = (source: string): ProjectedDocument =>
  projectCoreModel(coreParser.parse(source, "dbmlv2").normalize() as unknown as CoreModel);

/** `@dbml/core`'s error codes for `source`, or `null` when it accepts it. */
const coreErrors = (source: string): number[] | null => {
  try {
    coreParser.parse(source, "dbmlv2");
    return null;
  } catch (error) {
    const diags = (error as { diags?: { code: number }[] }).diags;
    if (!diags) throw error;
    return diags.map((diag) => diag.code);
  }
};

const isSyntaxError = (code: number) => code >= 1000 && code < 2000;

const accepts = (source: string): boolean => {
  try {
    dbml.parse(source);
    return true;
  } catch {
    return false;
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
// Node 18 lacks, so on Node 18 it throws a TypeError for any table that
// injects a partial. Those documents are still parsed by this package there;
// only the comparison (and their mutants) are skipped, and they run on every
// newer Node.
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
    dbml: `TablePartial p {
  a int [pk]
  b int [pk]
}

Table t {
  ~p
  c int
}

Table u {
  a int [pk]
  b int [pk]
  indexes {
    a [unique]
  }
}
`,
  },
  {
    name: "column types naming an enum, its alias or another schema",
    dbml: `enum s.status as St {
  a
  b
}

enum public.e {
  x
}

Table t {
  w St [default: St.a]
  x s.status
  y s.status[]
  z e
  v public.e
  u e(1)
  p pg.uuid
  q "pg"."int 4"
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
  /** What this package does with each document; `@dbml/core` does the opposite. */
  ours: "rejects" | "accepts";
  /** Documents that show the difference: `@dbml/core` accepts them fully, or rejects them with a syntax error. */
  documents: string[];
  /** `MALFORMED` entries that `@dbml/core` accepts because of it. */
  malformed?: string[];
  /** Mutants (see `mutants` below) that show it, by id. */
  mutants?: string[];
}

const KNOWN_DIFFERENCES: KnownDifference[] = [
  {
    reason:
      "More than two parts in a table, sticky note or records name (`a.b.c`), or more than three in a ref " +
      "endpoint: `@dbml/core` reads the extra parts as a nested schema and accepts them where nothing has to " +
      "resolve against them, but doesn't support nested schemas.",
    ours: "rejects",
    documents: [
      "Table a.b.c {\n  id int\n}\n",
      "Note a.b.c {\n  'x'\n}\n",
      "Table a.b.t {\n  a int\n}\nrecords a.b.t(a) {\n  1\n}\n",
      "Table a.b.c {\n  d int\n}\nTable e {\n  f int\n}\nRef: a.b.c.d > e.f\n",
    ],
    malformed: ["table name with three parts"],
  },
  {
    reason:
      "A single-part inline ref target (`[ref: > id]`): `@dbml/core` resolves it to a column of the same " +
      "table; here an inline ref target needs a table and a column.",
    ours: "rejects",
    documents: ["Table t {\n  id int\n  c int [ref: > id]\n}\n"],
  },
  {
    reason: "Repeated signs on a number (`--1`, `- -1`) in a default or a records field.",
    ours: "rejects",
    documents: ["Table t {\n  c int [default: --1]\n}\n", "Table t {\n  a int\n}\nrecords t(a) {\n  - -1\n}\n"],
  },
  {
    reason: "Chained column type suffixes (`int(1)(2)`, `int[](1)`) and comma-separated array sizes (`int[1,2]`).",
    ours: "rejects",
    documents: ["Table t {\n  c int(1)(2)\n}\n", "Table t {\n  c int[](1)\n}\n", "Table t {\n  c int[1,2]\n}\n"],
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
      "The same, the other way: a comment or `\\r\\n` before an index's later-line sort order hides the line " +
      "break `@dbml/core` attaches `[desc]` across.",
    ours: "rejects",
    documents: [
      "Table t {\n  id int\n  indexes {\n    id// c\n    [desc]\n  }\n}\n",
      "Table t {\r\n  id int\r\n  indexes {\r\n    id\r\n    [desc]\r\n  }\r\n}\r\n",
    ],
  },
  {
    reason: "An element keyword as a Project property key (`table: 'x'`), which `@dbml/core` reads as an element.",
    ours: "accepts",
    documents: ["Project p {\n  table: 'x'\n}\n"],
  },
];

// --- Mutants ---

/**
 * A deterministic set of near-miss documents: for each corpus document of up
 * to 2,000 characters, `MUTANTS_PER_DOCUMENT` mutants, each changing one token at a position
 * drawn from a generator seeded by the document's name. A mutant's id is the
 * document's name and its index (`"table basic #2"`), so adding corpus
 * documents leaves existing ids alone.
 */
const MUTANTS_PER_DOCUMENT = 8;

const mutants = (): { id: string; source: string }[] => {
  const result: { id: string; source: string }[] = [];
  for (const sample of CORPUS) {
    if (sample.dbml.length > 2000) continue;
    if (!coreMergesPartials && injectsPartial(sample.dbml)) continue;
    const tokens = tokenize(sample.dbml);
    if (tokens.length < 2) continue;
    let seed = [...sample.name].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 7);
    const random = (below: number) => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return (seed >>> 8) % below;
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
      result.push({ id: `${sample.name} #${index}`, source });
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

describe("differential: CORPUS projects the same with both parsers", () => {
  it.for(named(CORPUS))("%s", ([, sample], { skip }) => compareProjections(sample, skip));
});

describe("differential: more documents project the same with both parsers", () => {
  it.for(named(PROJECTION_CASES))("%s", ([, sample], { skip }) => compareProjections(sample, skip));
});

describe("differential: MALFORMED is rejected by both parsers", () => {
  const allowed = new Map(
    KNOWN_DIFFERENCES.flatMap((difference) => (difference.malformed ?? []).map((name) => [name, difference])),
  );

  it.each(named(MALFORMED))("%s", (name, sample: Sample) => {
    expect(accepts(sample.dbml)).toBe(false);
    // A known difference: `@dbml/core` accepts it.
    expect(coreErrors(sample.dbml) === null).toBe(allowed.has(name));
  });

  it("lists only MALFORMED entries in the known differences", () => {
    const names = new Set(MALFORMED.map((sample) => sample.name));
    expect([...allowed.keys()].filter((name) => !names.has(name))).toEqual([]);
  });
});

describe("differential: known differences still hold", () => {
  const cases = KNOWN_DIFFERENCES.flatMap((difference) =>
    difference.documents.map((source) => [JSON.stringify(source), difference, source] as const),
  );

  it.each(cases)("%s", (_, difference: KnownDifference, source: string) => {
    const errors = coreErrors(source);
    if (difference.ours === "rejects") {
      expect(accepts(source)).toBe(false);
      expect(errors).toBeNull();
    } else {
      expect(accepts(source)).toBe(true);
      expect(errors).not.toBeNull();
    }
  });
});

describe("differential: corpus mutants get the same verdict from both parsers", () => {
  const all = mutants();
  const allowed = new Map(
    KNOWN_DIFFERENCES.flatMap((difference) => (difference.mutants ?? []).map((id) => [id, difference])),
  );

  it("generates a few hundred mutants", () => {
    expect(all.length).toBeGreaterThan(300);
  });

  it("agrees on every mutant outside the known differences", () => {
    const disagreements = all.flatMap(({ id, source }) => {
      const ours = accepts(source);
      const errors = coreErrors(source);
      const core = errors === null;
      // Ours stricter only where core's rejection is a validation error, not syntax.
      const agree = ours === core || (ours && errors!.every((code) => !isSyntaxError(code)));
      return agree !== allowed.has(id) ? [] : [{ id, ours, core: errors ?? "accepts", source }];
    });
    expect(disagreements).toEqual([]);
  });
});
