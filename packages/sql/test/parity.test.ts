import type { ParseError } from "@parser-kit/core";
import { expect, it } from "vitest";
import { postgres } from "../src/postgres/index";
import { CORPUS } from "./corpus";
import { LEXER_EDGE_CASES, MALFORMED, MULTI_LINE, SUPPLEMENTAL } from "./parity-corpus";

// --- byte-exact parity harness ---
//
// The example suites assert on *shapes*: `stripSpans` output compared with
// `toEqual`, error messages matched with a regex. That leaves plenty of room
// for an internal change to shift something observable — a span by one column,
// a recovered statement, the wording of a diagnostic — without turning a test
// red. Spans in particular are asserted almost nowhere: `parse` here strips
// them before comparing, and so does the `lex` helper.
//
// This harness closes that gap. It serialises the full AST — spans included,
// nothing stripped — for every corpus row and every statement in
// `parity-corpus.ts`'s valid lists (`SUPPLEMENTAL` / `MULTI_LINE` /
// `LEXER_EDGE_CASES`), plus the errors `diagnose()` collects for its
// `MALFORMED` list, and compares the result
// byte-for-byte against a committed golden. A refactor that is supposed to
// preserve behaviour must leave those files untouched.
//
// The goldens are generated from the parser's current behaviour, not derived
// from a spec, so they are only meaningful if they are recorded *before* the
// change under test. Regenerate them with `pnpm test -- -u` (the `--` is
// required — pnpm swallows a bare `-u` and exits 0 without running anything)
// when a behaviour change is intended and reviewed, never to make a refactor
// pass.
//
// What it does *not* pin: `ParseError.stack`, which is not portable enough to
// commit. A change to stack capture has to bring its own assertions.

// Record a throw rather than propagating it, so one bad case doesn't abort the
// run and hide every case after it. The assertions below turn what it caught
// into a readable list of offending sources.
const capture = <T>(run: () => T): T | { thrown: string } => {
  try {
    return run();
  } catch (error) {
    return { thrown: String(error) };
  }
};

const threw = (value: unknown): value is { thrown: string } =>
  typeof value === "object" && value !== null && "thrown" in value;

const serialise = (entries: unknown[]) => `${JSON.stringify(entries, null, 2)}\n`;

// `message` already carries the start position; `end` is not in it and would
// otherwise be unpinned.
const describeError = (error: ParseError) => ({ message: error.message, end: error.end });

it("parses the corpus to byte-identical ASTs", async () => {
  const sources = [...CORPUS.map((sample) => sample.sql), ...SUPPLEMENTAL, ...MULTI_LINE, ...LEXER_EDGE_CASES];
  const entries = sources.map((source) => ({ source, ast: capture(() => postgres.parse(source)) }));

  // Every source above is valid SQL, so `capture` must not have caught
  // anything. Without this a corpus row with a typo in it degrades to a pinned
  // error string, and the constructs it was added to cover go unpinned while
  // the golden still looks healthy.
  expect(entries.filter((entry) => threw(entry.ast)).map((entry) => entry.source)).toEqual([]);

  await expect(serialise(entries)).toMatchFileSnapshot("./parity.ast.golden.json");
});

it("reports byte-identical diagnostics for malformed input", async () => {
  const entries = MALFORMED.map((source) => ({
    source,
    ...capture(() => {
      const { ast, errors } = postgres.diagnose(source);
      return { errors: errors.map(describeError), ast };
    }),
  }));

  // Recovery is the point of these inputs: if a change makes `diagnose` throw
  // instead of collecting, the golden diff alone would not say so loudly.
  expect(entries.filter(threw).map((entry) => entry.source)).toEqual([]);

  await expect(serialise(entries)).toMatchFileSnapshot("./parity.diagnostics.golden.json");
});
