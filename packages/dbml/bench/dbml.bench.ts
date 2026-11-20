import { bench, describe } from "vitest";
import { dbml } from "../src/index";
import { CORPUS, MALFORMED } from "../test/corpus";
import { checkFileKindStub, incumbentAccepts, incumbentFull, incumbentParse, incumbentParseErrors } from "./incumbent";

// Benchmark `@parser-kit/dbml` against the incumbent, `@dbml/core` 12.1.0. The
// corpus lives in `test/corpus.ts`, so this bench and the parity goldens in
// `parity.test.ts` measure and pin the same documents.
//
// Each group times three things (see `incumbent.ts` for what each one does):
//   - `@parser-kit/dbml`: `dbml.parse`, lex + parse to a span-annotated AST.
//   - `@dbml/parse (lex + parse)`: the incumbent's parse stage alone, the
//     like-for-like comparison (with its front-matter re-lex skipped).
//   - `@dbml/core Parser.parse (full)`: the incumbent's public entry, which
//     also validates, binds and builds its model. Not like for like: shown
//     because it is what a `@dbml/core` user calls.
//
// In the valid-input groups, only documents `@dbml/core` fully accepts are
// timed, so no incumbent run takes an error path. On Node 18 that leaves out
// the documents that inject a partial (core 12.1.0 merges them with
// `Array#toReversed`). The malformed groups at the end time error paths on
// purpose.

const SHARED = CORPUS.filter((s) => incumbentAccepts(s.dbml));
// Malformed documents split by where the incumbent catches them. Only those
// with syntax errors in `@dbml/parse`'s parse stage make both parsers take
// their error paths; the rest the incumbent's parse stage accepts and only its
// validator rejects (`dbml.diagnose` reports them all).
const MALFORMED_SYNTAX = MALFORMED.filter((s) => incumbentParseErrors(s.dbml) > 0);
const MALFORMED_REJECTED = MALFORMED.filter((s) => !incumbentAccepts(s.dbml));
const REALISTIC = SHARED.filter((s) => s.category === "realistic");
const CATEGORIES = [...new Set(SHARED.map((s) => s.category))];
const kb = (docs: { dbml: string }[]) =>
  (docs.reduce((n, s) => n + Buffer.byteLength(s.dbml, "utf8"), 0) / 1024).toFixed(1);

// Sanity checks at collection time: every timed document parses here without
// errors, every malformed one reports at least one, so no bench silently
// measures an error path.
// The incumbent's parse stage reports no syntax error on a timed valid
// document, and skipping its file-kind sniff changes nothing on any input.
for (const { name, dbml: source } of SHARED) {
  if (dbml.diagnose(source).errors.length > 0) throw new Error(`corpus document fails to parse: ${name}`);
  if (incumbentParseErrors(source) > 0) throw new Error(`@dbml/parse reports a syntax error: ${name}`);
}
for (const { name, dbml: source } of MALFORMED) {
  if (dbml.diagnose(source).errors.length === 0) throw new Error(`malformed document parses: ${name}`);
}
for (const { dbml: source } of [...CORPUS, ...MALFORMED]) checkFileKindStub(source);
// eslint-disable-next-line no-console
console.log(
  `\n[corpus] timed: ${SHARED.length}/${CORPUS.length} documents (${kb(SHARED)} KB) accepted by @dbml/core | ` +
    `realistic: ${REALISTIC.length} (${kb(REALISTIC)} KB) | malformed: ${MALFORMED.length}, ` +
    `${MALFORMED_SYNTAX.length} with syntax errors from @dbml/parse, ${MALFORMED_REJECTED.length} rejected by @dbml/core\n`,
);

/** The three standard contenders over `docs`. */
function contenders(docs: { dbml: string }[]) {
  bench("@parser-kit/dbml", () => {
    for (const { dbml: source } of docs) dbml.parse(source);
  });
  bench("@dbml/parse (lex + parse)", () => {
    for (const { dbml: source } of docs) incumbentParse(source);
  });
  bench("@dbml/core Parser.parse (full)", () => {
    for (const { dbml: source } of docs) incumbentFull(source);
  });
}

// --- the whole corpus ---
describe(`whole corpus (${SHARED.length} documents)`, () => {
  contenders(SHARED);
});

// --- the large realistic schemas, together and one by one ---
describe(`realistic schemas (${REALISTIC.length} documents)`, () => {
  contenders(REALISTIC);
});
for (const doc of REALISTIC) {
  describe(`realistic: ${doc.name}`, () => {
    contenders([doc]);
  });
}

// --- per category ---
for (const category of CATEGORIES) {
  if (category === "realistic") continue;
  const docs = SHARED.filter((s) => s.category === category);
  describe(`${category} (${docs.length} documents)`, () => {
    contenders(docs);
  });
}

// --- diagnose: on valid input it should cost what parse costs ---
describe(`diagnose, valid input: whole corpus (${SHARED.length} documents)`, () => {
  bench("@parser-kit/dbml diagnose", () => {
    for (const { dbml: source } of SHARED) dbml.diagnose(source);
  });
  bench("@parser-kit/dbml parse", () => {
    for (const { dbml: source } of SHARED) dbml.parse(source);
  });
  bench("@dbml/parse (lex + parse)", () => {
    for (const { dbml: source } of SHARED) incumbentParse(source);
  });
});

// --- diagnose on malformed input: error recovery against the incumbent's ---
// Like for like: the documents `@dbml/parse`'s parse stage also finds syntax
// errors in. It recovers and collects them, as `dbml.diagnose` does.
describe(`diagnose, malformed input with syntax errors for both (${MALFORMED_SYNTAX.length} documents)`, () => {
  bench("@parser-kit/dbml diagnose", () => {
    for (const { dbml: source } of MALFORMED_SYNTAX) dbml.diagnose(source);
  });
  bench("@dbml/parse (lex + parse)", () => {
    for (const { dbml: source } of MALFORMED_SYNTAX) incumbentParse(source);
  });
});
// Every malformed document `@dbml/core` rejects. `Parser.parse` collects
// errors by running its whole pipeline (lex, parse, validate, bind, interpret)
// and then throws, so its cost includes those stages and building the error.
describe(`diagnose, malformed input rejected by @dbml/core (${MALFORMED_REJECTED.length} documents)`, () => {
  bench("@parser-kit/dbml diagnose", () => {
    for (const { dbml: source } of MALFORMED_REJECTED) dbml.diagnose(source);
  });
  bench("@dbml/core Parser.parse (full, throws)", () => {
    for (const { dbml: source } of MALFORMED_REJECTED) incumbentAccepts(source);
  });
});
