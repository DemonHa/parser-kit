// The root entry, `@parser-kit/sql`: every dialect, each as one object with the
// same shape (`postgres.parse`, `postgres.diagnose`, …), plus its AST types.
// Each dialect also has its own subpath (`@parser-kit/sql/postgres`).
export * from "./postgres/index";
