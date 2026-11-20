import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// One vitest run covers the whole workspace: core's unit tests, the published
// PostgreSQL grammar (`@parser-kit/sql`), the js-lite example and the DBML
// package in development (`@parser-kit/dbml`). The PostgreSQL and js-lite
// grammars double as the kit's genericity/integration guard.
// `@parser-kit/core` resolves to source so tests and benches need no build.
export default defineConfig({
  resolve: {
    alias: {
      "@parser-kit/core": resolve(import.meta.dirname, "packages/core/src/index.ts"),
    },
  },
  test: {
    include: [
      "packages/core/src/**/*.test.ts",
      "packages/sql/test/**/*.test.ts",
      "packages/dbml/test/**/*.test.ts",
      "examples/**/*.test.ts",
    ],
  },
});
