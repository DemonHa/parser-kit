import type { ParseError } from "@parser-kit/core";
import { expect, it } from "vitest";
import { jsLite } from "./grammar";

// --- byte-exact parity harness ---
//
// The counterpart to `examples/sql-lite/parity.test.ts`. It serialises the full
// AST — spans included, nothing stripped — for every source below, plus the
// errors `diagnose()` collects for a fixed list of malformed inputs, and
// compares the result byte-for-byte against a committed golden. The example
// suites assert on shapes (`stripSpans` + `toEqual`, regex `toThrow`) and on
// spans almost nowhere — `describe("JS-lite spans")` pins three of them, on one
// single-line source — so a refactor can shift a span or a diagnostic without
// turning any of them red. This is what catches that.
//
// The goldens are only meaningful if they were recorded *before* the change
// under test. Regenerate them with `pnpm test -- -u` — never to make a refactor
// pass.
//
// js-lite keeps its corpus inline because, unlike sql-lite's, nothing else
// consumes it.

// Every construct the suite covers, one source per line: declarations,
// functions, control flow, the full precedence ladder, postfix chains,
// literals, and the `attempt`-backtracked arrow forms.
const CORPUS = [
  // --- statements ---
  "const x = 1;",
  "let y = 2;",
  "function add(a, b) { return a + b; }",
  "function noop() { }",
  "if (x > 1) { y = 2; } else y = 3;",
  "if (x) return;",
  "while (ok) { return; }",
  "while (x < 3) { x = x + 1; }",
  "{ const inner = 1; inner; }",
  "// setup\nconst x = 1;\n/* then */\nx = x + 1;\n",
  // --- expressions ---
  "1 + 2 * 3;",
  "(1 + 2) * 3;",
  "a < 1 && b >= 2 || c === 3;",
  "a != b !== c;",
  "a == b;",
  "a - b / c % d;",
  "a = b = 1;",
  "ok ? 1 : 2;",
  "-a * b;",
  "!a && b;",
  "a.b.c(1)[x];",
  "f(1, 'two')(3);",
  "[1, 'two', true, null];",
  "[[1], [], [2, 3]];",
  // --- arrow functions (attempt backtracking) ---
  "(a, b) => a + b;",
  "(a + b);",
  "(a);",
  "x => x * 2;",
  "x;",
  "() => 1;",
  "(x) => { return x; };",
  "apply(x => x + 1, [1, 2]);",
  // --- lexing edges: both quote styles, comment forms, number forms ---
  "const s = 'single' ; const d = \"double\";",
  "const n = 1.5; const z = 0; const big = 1234567890;",
  "/* multi\n   line */ const after = 1; // eol\n",
  "const $dollar = _under$score;",
  // Non-ASCII inside string bodies: pins column counting across a multi-byte
  // run. Nothing here starts a token with a non-ASCII character — that is a lex
  // error in this grammar, so it lives in MALFORMED below.
  "const s = 'héllo'; const t = \"wörld — dash\";",
  // --- multi-line source, so spans past row 1 are pinned ---
  "function outer(a) {\n  const b = a + 1;\n  if (b > 2) {\n    return b;\n  }\n  return 0;\n}\n",
];

// Malformed inputs, each trailed by a statement that recovery at the `;` / `}`
// sync points can reach — though not all of them survive, and the golden
// records whatever recovery actually produces, `[]` included. Annotated per row
// rather than as a prose list, so adding one can't leave the descriptions off
// by one. js-lite sets no `errorReporting`, so `preferFarthest` is off here;
// sql-lite's harness is the one that covers it.
const MALFORMED = [
  // A missing initialiser.
  "const x = ;\nconst y = 2;",
  // A keyword where a name is required.
  "const = 1;\nconst z = 3;",
  // A binary expression truncated at its operator.
  "1 + ;\nlet a = 4;",
  // A lexer error, which surfaces lazily at the parser's first peek.
  "@\nlet b = 5;",
  // A token that cannot start a statement.
  "const x = 1; ]\nlet c = 6;",
  // Two independent failures in one input: pins the order diagnostics come out
  // in, and that recovery keeps going after the first one.
  "const x = ;\nlet y = ;\nconst z = 7;",
  // A non-ASCII character at a *token start* — the only input here that drives
  // the out-of-range path of an ASCII-indexed dispatch or char-class table. It
  // is a lex error in this grammar, which is why it belongs in this list.
  "const é = 1;\nlet d = 8;",
];

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
  const entries = CORPUS.map((source) => ({ source, ast: capture(() => jsLite.parse(source)) }));

  // Every source above is valid js-lite, so `capture` must not have caught
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
      const { ast, errors } = jsLite.diagnose(source);
      return { errors: errors.map(describeError), ast };
    }),
  }));

  // Recovery is the point of these inputs: if a change makes `diagnose` throw
  // instead of collecting, the golden diff alone would not say so loudly.
  expect(entries.filter(threw).map((entry) => entry.source)).toEqual([]);

  await expect(serialise(entries)).toMatchFileSnapshot("./parity.diagnostics.golden.json");
});
