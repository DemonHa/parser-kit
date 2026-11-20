// Writes a minimal package.json into each build output dir so Node resolves the
// right module format per file, regardless of the root package's "type".
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const buildDir = join(dirname(fileURLToPath(import.meta.url)), "..", "build");

const stubs = {
  esm: { type: "module" },
  cjs: { type: "commonjs" },
};

for (const [dir, pkg] of Object.entries(stubs)) {
  const target = join(buildDir, dir, "package.json");
  writeFileSync(target, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`wrote ${target}`);
}
