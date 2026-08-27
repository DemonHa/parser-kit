import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// One vitest run covers the whole workspace: core's unit tests plus the two
// example grammars, which double as the kit's genericity/integration guard.
// `@parser-kit/core` resolves to source so tests and benches need no build.
export default defineConfig({
  resolve: {
    alias: {
      "@parser-kit/core": resolve(import.meta.dirname, "packages/core/src/index.ts"),
    },
  },
  test: {
    include: ["packages/core/src/**/*.test.ts", "examples/**/*.test.ts"],
  },
});
