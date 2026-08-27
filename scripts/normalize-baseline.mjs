// Rewrites the absolute `filepath` vitest bakes into bench-baseline.json to a
// repo-relative one, so the committed baseline is portable across machines
// (otherwise --compare can't match another dev's home directory).
import { readFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";

const FILE = "bench-baseline.json";
const root = process.cwd();

const report = JSON.parse(readFileSync(FILE, "utf8"));
for (const file of report.files ?? []) {
  file.filepath = relative(root, file.filepath);
}
writeFileSync(FILE, `${JSON.stringify(report, null, 2)}\n`);
