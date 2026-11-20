import type { ParseError } from "@parser-kit/core";
import { expect, it } from "vitest";
import { postgres } from "../src/postgres/index";
import { CORPUS } from "./corpus";
import { LEXER_EDGE_CASES, MULTI_LINE, SUPPLEMENTAL } from "./parity-corpus";

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
// `parity-corpus.ts`, plus the errors `diagnose()` collects for a fixed list of malformed inputs, and compares the result
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

// Malformed inputs, each trailed by a statement that recovery at the `;` sync
// point can reach. Annotated per row rather than as a prose list, so adding one
// can't leave the descriptions off by one.
const MALFORMED = [
  // A failure inside a construct: the siblings around it survive.
  "CREATE TABLE t (id int, 42 bad, ok text);\nDROP TABLE t;",
  // An unknown keyword where a clause was expected.
  "SELECT * FRUM t;\nSELECT 1;",
  // A backtracked branch whose deeper error `preferFarthest` substitutes in.
  // The PostgreSQL grammar enables it; js-lite does not, so this is the only harness that
  // covers that substitution.
  "CREATE TABLE IF NOT EXIST foo (id int);\nSELECT 1;",
  // A clause truncated at the statement terminator.
  "SELECT * FROM;\nSELECT 2;",
  // A lexer error, which surfaces lazily at the parser's first peek.
  "SELECT $ FROM t;\nSELECT 3;",
  // Two independent failures in one input: pins the order diagnostics come out
  // in, and that recovery keeps going after the first one.
  "SELECT * FROM;\nSELECT * FRUM u;\nSELECT 4;",
  "CREATE TABLE a (id int, 42 bad);\nSELECT * FROM;\nSELECT 5;",
  // A non-ASCII character at a *token start* — the only input here that drives
  // the out-of-range path of an ASCII-indexed dispatch or char-class table —
  // followed by a character no reader claims. The `é` is an identifier, as
  // every character from U+0080 up is to PG; the backslash is the lex error.
  "SELECT é \\ FROM t;\nSELECT 6;",
  // The three croak sites in the letter-prefixed literal readers. A lexer
  // croak has to leave the cursor somewhere recovery can resync from, and the
  // only way to see that is to pin what `diagnose` salvages: the first two
  // read past the whole literal, so the trailing statement survives.
  "SELECT B'12' FROM t;\nSELECT 1;",
  "SELECT U&'\\00' FROM t;\nSELECT 2;",
  // The UESCAPE character is read as a whole `'…'` for exactly this reason —
  // croaking with its closing quote unconsumed left that quote to open a
  // runaway string that ate the rest of the input.
  "SELECT U&'x' UESCAPE '5' FROM t;\nSELECT 3;",
  // A truncated tail is rejected on the same test: one legal character is not
  // enough if the quote that would have closed it never arrived. The one row
  // here whose trailing statement is *not* recoverable, and necessarily so —
  // the unclosed literal swallowed it, exactly as an unclosed `'…'` would.
  "SELECT U&'\\0041' UESCAPE '!\nSELECT 4;",
  // A lex error *inside* a multi-word type name's lookahead. Filling the
  // lookahead buffer consumes the offending character, so typeRef has to report
  // it rather than discard it along with the failed tail. Both errors survive,
  // but this is the one row here whose list is not in source order: the
  // lookahead runs, and reports, before the syntax error it declines to cause.
  "CREATE TABLE t (c timestamp with \\);\nSELECT 7;",
  // The same mechanism with the tail completing rather than failing, which is
  // the more surprising outcome and so pinned separately: `interval day` is a
  // type, the bad character is the statement's only error, and the column
  // definition around it recovers into the AST whole.
  "CREATE TABLE t (c interval day \\);\nSELECT 8;",
  // The constraint-attribute tail after UNIQUE / PRIMARY KEY / REFERENCES peeks
  // a second token only past a `not`. Peeking unconditionally, the bad
  // character after the comma would fail inside the UNIQUE handler and take
  // column `a` down with it. The second row is the peek it does take: the
  // column is lost, exactly as NOT NULL's own `null` lookup would lose it.
  "CREATE TABLE t (a int UNIQUE, \\ int);\nSELECT 9;",
  "CREATE TABLE t (a int UNIQUE NOT \\);\nSELECT 10;",
  // At table level the tail's peek meets the bad character inside the UNIQUE
  // item, so recovery resyncs at the next comma and the table survives with
  // both columns.
  "CREATE TABLE t (a int, UNIQUE (a) \\, b int);\nSELECT 11;",
  // A failure inside a LIKE item recovers like one inside a column: the
  // element-list siblings around it survive.
  "CREATE TABLE t (id int, LIKE src INCLUDING everything, ok text);\nSELECT 12;",
  // So does one inside a PARTITION OF element list, the second list a CREATE
  // TABLE can carry.
  "CREATE TABLE p PARTITION OF m (a NOT NULL, b DEFAULT, c DEFAULT 0) DEFAULT;\nSELECT 13;",
  // The empty-list check peeks past the `(`, which must report a lex error on
  // the first item rather than throw it past recovery: the table survives.
  "CREATE TABLE p PARTITION OF m (\\ a NOT NULL, b DEFAULT 1) DEFAULT;\nSELECT 14;",
  // A `(` in FROM ahead of no query word is read as a parenthesised join, so a
  // lone table in parentheses fails at its `)`.
  "SELECT * FROM (a);\nSELECT 15;",
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
