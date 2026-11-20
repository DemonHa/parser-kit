import type { ParseError } from "@parser-kit/core";
import { expect, it } from "vitest";
import { dbml } from "../src/index";
import { CORPUS, MALFORMED } from "./corpus";

// --- byte-exact parity harness ---
//
// The example suites assert on *shapes*: `stripSpans` output compared with
// `toEqual`, error messages matched against a string. That leaves plenty of
// room for an internal change to shift something observable — a span by one
// column, a recovered element, the wording of a diagnostic — without turning a
// test red. Spans in particular are asserted on as few as one document per
// construct.
//
// This harness closes that gap. It serialises the full AST — spans included,
// nothing stripped — for every corpus document, plus what `diagnose()` reports
// for every corpus document and every malformed input, and compares the result
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
// into a readable list of offending entries.
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

it("names every corpus and malformed entry uniquely", () => {
  // The goldens key on the name, and so will anything else that reuses the corpus.
  const names = [...CORPUS, ...MALFORMED].map((sample) => sample.name);
  expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
});

it("parses the corpus to byte-identical ASTs", async () => {
  const entries = CORPUS.map(({ name, dbml: source }) => ({ name, source, ast: capture(() => dbml.parse(source)) }));

  // Every corpus document is valid DBML, so `capture` must not have caught
  // anything. Without this a document with a typo in it degrades to a pinned
  // error string, and the constructs it was added to cover go unpinned while
  // the golden still looks healthy.
  expect(entries.filter((entry) => threw(entry.ast)).map((entry) => entry.name)).toEqual([]);

  await expect(serialise(entries)).toMatchFileSnapshot("./parity.ast.golden.json");
});

it("reports byte-identical diagnostics for the corpus and for malformed input", async () => {
  // A valid document's recovered AST is its parsed AST, which the AST golden
  // already pins in full. Asserting the two are identical here, rather than
  // writing every corpus tree out a second time, keeps this golden to what
  // `diagnose` adds: the errors, and the AST it salvages from malformed input.
  const astMismatches: string[] = [];
  const valid = CORPUS.map(({ name, dbml: source }) => {
    const result = capture(() => dbml.diagnose(source));
    if (threw(result)) return { name, ...result };
    if (JSON.stringify(result.ast) !== JSON.stringify(capture(() => dbml.parse(source)))) astMismatches.push(name);
    return { name, errors: result.errors.map(describeError) };
  });
  expect(astMismatches).toEqual([]);

  const malformed = MALFORMED.map(({ name, dbml: source }) => ({
    name,
    source,
    ...capture(() => {
      const { ast, errors } = dbml.diagnose(source);
      return { errors: errors.map(describeError), ast };
    }),
  }));

  // Recovery is the point of these inputs: if a change makes `diagnose` throw
  // instead of collecting, the golden diff alone would not say so loudly.
  expect([...valid, ...malformed].filter(threw).map((entry) => entry.name)).toEqual([]);
  // The corpus must stay error-free and every malformed input must stay
  // malformed, or an entry silently stops covering what it was added for.
  expect(valid.filter((entry) => !threw(entry) && entry.errors.length > 0).map((entry) => entry.name)).toEqual([]);
  expect(malformed.filter((entry) => !threw(entry) && entry.errors.length === 0).map((entry) => entry.name)).toEqual(
    [],
  );
  expect(MALFORMED.filter(({ dbml: source }) => !threw(capture(() => dbml.parse(source)))).map((s) => s.name)).toEqual(
    [],
  );

  await expect(serialise([...valid, ...malformed])).toMatchFileSnapshot("./parity.diagnostics.golden.json");
});
