// The root entry, `@parser-kit/sql`: every dialect as one object with the same
// shape (`postgres.parse`, `postgres.diagnose`, …). A dialect's AST types are
// namespaced here (`Postgres.Stmt`), because each dialect has its own `Stmt`,
// `Expr`, …; its subpath (`@parser-kit/sql/postgres`) exports them unqualified.
export type { Diagnosis } from "./dialect";
export type * as Postgres from "./postgres/ast";
export { type PostgresDialect, type PostgresTokenType, postgres } from "./postgres/index";
