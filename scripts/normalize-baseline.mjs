// Rewrites the absolute `filepath` vitest bakes into bench-baseline.json to a
// package-relative one, so the committed baseline is portable across machines
// (otherwise --compare can't match another dev's home directory).
import { readFileSync, writeFileSync } from "node:fs";

const FILE = "bench-baseline.json";
const report = JSON.parse(readFileSync(FILE, "utf8"));
for (const file of report.files ?? []) {
  file.filepath = file.filepath.replace(/^.*\/parser-kit\//, "");
}
writeFileSync(FILE, `${JSON.stringify(report, null, 2)}\n`);
