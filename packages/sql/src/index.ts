// The root entry, `@parser-kit/sql`: every dialect as one object with the same
// shape (`postgres.parse`, `postgres.stringify`, …). A dialect's types are
// namespaced (`Postgres.Stmt`) or prefixed (`PostgresDialect`) here, because
// each dialect has its own `Stmt`, `Expr`, printer options, …; its subpath
// (`@parser-kit/sql/postgres`) exports them unqualified.
export type { Diagnosis } from "./dialect";
export type * as Postgres from "./postgres/ast";
export {
  NotPrintableError,
  type PostgresDialect,
  type PostgresParser,
  type PostgresTokenType,
  postgres,
} from "./postgres/index";
