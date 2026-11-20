---
"@parser-kit/sql": minor
---

First release of `@parser-kit/sql`: the PostgreSQL 17 grammar that lived in the repo as the `examples/sql-lite` example, now published as a package. `sqlLite` parses SQL into a span-annotated AST, `sqlLiteScript` reads whole psql / pg_dump scripts (meta-commands and `COPY … FROM stdin` data included), and both offer `parse` (throws a `ParseError`) and `diagnose` (recovers at each `;`). The lexers and every AST node type (`Stmt`, `Query`, `Expr`, `ScriptItem`, …) are exported too. Ships as dual ESM/CommonJS with type declarations, and depends on `@parser-kit/core`.
