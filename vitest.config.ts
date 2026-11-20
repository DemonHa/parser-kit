import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// One vitest run covers the whole workspace: core's unit tests, the published
// PostgreSQL grammar (`@parser-kit/sql`) and the js-lite example. The two
// grammars double as the kit's genericity/integration guard.
// `@parser-kit/core` resolves to source so tests and benches need no build.
export default defineConfig({
  resolve: {
    // The subpath comes first: aliases match by prefix, first entry wins.
    alias: [
      { find: "@parser-kit/core/print", replacement: resolve(import.meta.dirname, "packages/core/src/print/index.ts") },
      { find: "@parser-kit/core", replacement: resolve(import.meta.dirname, "packages/core/src/index.ts") },
    ],
  },
  test: {
    include: ["packages/core/src/**/*.test.ts", "packages/sql/test/**/*.test.ts", "examples/**/*.test.ts"],
  },
});
