# @parser-kit/dbml

> **In development.** This package is not published yet and its API is not
> implemented: `dbml.parse` and `dbml.diagnose` throw until the grammar lands.

A typed [DBML](https://dbml.dbdiagram.io/docs/) parser for JavaScript and TypeScript, built with [`@parser-kit/core`](../core). It will turn DBML (`Project`, `Table`, `Ref`, `Enum`, `TableGroup`, notes, `TablePartial`, `records`) into a span-annotated AST with exported TypeScript types, and recover from errors for editor tooling.

```ts
import { dbml } from "@parser-kit/dbml";

dbml.parse(source);    // the document AST; throws a ParseError at the first problem
dbml.diagnose(source); // a best-effort AST plus every error, for editors
```

Dual ESM / CommonJS, with type declarations. Node 18 or later.

Contributors: see [`AGENTS.md`](AGENTS.md) for the package's layout and rules.

## License

MIT
