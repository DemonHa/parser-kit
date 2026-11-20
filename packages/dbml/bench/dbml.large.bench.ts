import { bench, describe } from "vitest";
import { dbml } from "../src/index";
import { generateSchema, withErrors } from "./generate";
import { checkFileKindStub, incumbentAccepts, incumbentFull, incumbentParse, incumbentParseErrors } from "./incumbent";

// Large-file throughput: a single big schema file, handed to each parser in
// one call, the way a real project file is. The schemas come from the
// deterministic generator in `generate.ts` (enums, tables with notes, indexes,
// inline and top-level refs, groups, records), at about 1k, 5k and 20k lines,
// so the cost per KB is visible and a performance cliff would show up as a
// ratio that grows with size. See `incumbent.ts` for what each incumbent
// entry measures.

const SIZES = [1_000, 5_000, 20_000];
const SCHEMAS = SIZES.map((lines) => generateSchema(lines));
const kb = (text: string) => Buffer.byteLength(text, "utf8") / 1024;

// Pathological-but-legal input: one very long string and one very long
// backtick expression. Lexing them must stay linear.
const LONG_NOTE = `Table t {\n  id int [note: '${"a long note, ".repeat(40_000)}']\n}\n`;
const LONG_EXPRESSION = `Table t {\n  id int [default: \`${"coalesce(a, b) + ".repeat(30_000)}1\`]\n}\n`;

// Sanity checks at collection time, so no bench silently times an error path.
for (const schema of [...SCHEMAS, LONG_NOTE, LONG_EXPRESSION]) {
  if (dbml.diagnose(schema).errors.length > 0) throw new Error("generated schema fails to parse");
  if (!incumbentAccepts(schema)) throw new Error("@dbml/core rejects a generated schema");
  checkFileKindStub(schema);
}
{
  const lines = SCHEMAS.map((s) => {
    const { elements } = dbml.parse(s);
    return `  ${s.split("\n").length} lines, ${kb(s).toFixed(1)} KB, ${elements.length} elements`;
  });
  // eslint-disable-next-line no-console
  console.log(`\n[generated schemas]\n${lines.join("\n")}\n`);
}

for (const schema of SCHEMAS) {
  const label = `${schema.split("\n").length} lines (${kb(schema).toFixed(0)} KB)`;
  describe(`generated schema: ${label}`, () => {
    bench("@parser-kit/dbml", () => {
      dbml.parse(schema);
    });
    bench("@dbml/parse (lex + parse)", () => {
      incumbentParse(schema);
    });
    bench("@dbml/core Parser.parse (full)", () => {
      incumbentFull(schema);
    });
  });
}

// --- diagnose at scale: valid, and with an error in every 10th table ---
// Recovery resumes on the next line, so diagnose should cost about what parse
// costs. `@dbml/parse`'s parse stage recovers too, and reports the same number
// of syntax errors (checked below): the like-for-like comparison.
{
  const schema = SCHEMAS[SCHEMAS.length - 1]!;
  const broken = withErrors(schema, 10);
  const errors = dbml.diagnose(broken).errors.length;
  if (errors === 0) throw new Error("withErrors produced a valid schema");
  if (incumbentParseErrors(broken) !== errors) throw new Error("@dbml/parse finds a different number of syntax errors");
  checkFileKindStub(broken);
  describe(`diagnose: ${schema.split("\n").length}-line schema, valid`, () => {
    bench("@parser-kit/dbml diagnose", () => {
      dbml.diagnose(schema);
    });
    bench("@parser-kit/dbml parse", () => {
      dbml.parse(schema);
    });
  });
  describe(`diagnose: ${broken.split("\n").length}-line schema, ${errors} syntax errors`, () => {
    bench("@parser-kit/dbml diagnose", () => {
      dbml.diagnose(broken);
    });
    bench("@dbml/parse (lex + parse)", () => {
      incumbentParse(broken);
    });
  });
}

// --- long tokens ---
describe(`one ${kb(LONG_NOTE).toFixed(0)} KB note string`, () => {
  bench("@parser-kit/dbml", () => {
    dbml.parse(LONG_NOTE);
  });
  bench("@dbml/parse (lex + parse)", () => {
    incumbentParse(LONG_NOTE);
  });
});
describe(`one ${kb(LONG_EXPRESSION).toFixed(0)} KB backtick expression`, () => {
  bench("@parser-kit/dbml", () => {
    dbml.parse(LONG_EXPRESSION);
  });
  bench("@dbml/parse (lex + parse)", () => {
    incumbentParse(LONG_EXPRESSION);
  });
});
