# parser-kit

[![npm](https://img.shields.io/npm/v/@parser-kit/core.svg)](https://www.npmjs.com/package/@parser-kit/core)
[![CI](https://github.com/DemonHa/parser-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/DemonHa/parser-kit/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/npm/l/@parser-kit/core.svg)](LICENSE)

A zod-like parser toolkit for TypeScript. Describe a grammar as schema **values** and get the parser, the AST, and its types out of one declaration — no code generation, no `.grammar` files, no build step.

```sh
npm install @parser-kit/core
```

```ts
import { bindTokens, defineGrammar, defineLexer, field, type Infer, readers, seq, skip } from "@parser-kit/core";

const lexer = defineLexer({
  identifier: { type: "ident", start: /[a-z_]/i, part: /[a-z0-9_]/i, display: "an identifier" },
  punctuation: { type: "punc", tokens: [":", ","], display: "a symbol" },
  readers: [readers.number("num", { display: "a number" })],
});

const { token } = bindTokens<"ident" | "punc" | "num">();

const pair = seq(
  field("key", token("ident")),
  skip(token("punc", { values: [":"] })),
  field("value", token("num")),
);

type Pair = Infer<typeof pair>;
// { key: { type: "ident"; value: string; span: Span }; value: { type: "num"; ... }; span: Span }

const grammar = defineGrammar({ lexer, root: pair });
grammar.parse("answer: 42");   // → typed Pair, spans included
grammar.parse("answer 42");    // → ParseError: Expected ":" but found "42"
```

**[Read the full guide →](packages/core/README.md)** — lexing, combinators, Pratt expressions, error recovery, and the design notes.

## Why

- **Types come from the grammar.** `Infer<typeof rule>` reads the AST type the way `z.infer` reads a schema. One declaration, no drift between parser and types.
- **Everything is a value.** Rules compose, `.map()`, and `.describe()`. No generator, no separate grammar language, no codegen step in your build.
- **Errors people can read.** `Expected "pk", "unique" or "note" but found a new line` — labels come from your lexer's `display` config, never from internal type names.
- **Recovery built in.** `diagnose()` collects every diagnostic instead of throwing at the first one, which is what editor tooling needs.
- **Context-sensitive lexing when you want it.** Modes and transitions handle JS regex-vs-division and template literals without a second pass.

## Packages

| Package | Description |
|---|---|
| [`@parser-kit/core`](packages/core) | The toolkit: lexer, combinators, Pratt engine, grammars |
| [`@parser-kit/sql`](packages/sql) | A typed SQL parser built on the kit. Its first dialect is PostgreSQL 17: DDL, DML, queries and whole psql / pg_dump scripts. Benchmarked against [`node-sql-parser`](https://www.npmjs.com/package/node-sql-parser); its [README](packages/sql/README.md) has the PostgreSQL coverage survey and the benchmark results |

## Example grammars

Two real grammars double as the kit's genericity and integration tests — and the fastest way to learn it. Read their `grammar.ts` top to bottom.

- **[`examples/js-lite/`](examples/js-lite/)** — a JavaScript subset: `const`/`let`, functions, control flow, full expression precedence, arrow functions, template literals. Exercises root-rule dispatch, backtracking, and lexer modes. Not published.
- **[`packages/sql/`](packages/sql/)** — the PostgreSQL grammar behind `@parser-kit/sql`: DDL, DML (`MERGE`, `COPY`, upserts), `SELECT` with CTEs and window functions, access control and utility statements, folded identifiers, dollar-quoted strings, keyword operators. The largest grammar in the repo, and the one to read for keyword tiers, Pratt operator tables, hand-written `custom` rules, backtracking and error recovery on a real language.

## Development

```sh
pnpm install
pnpm test          # core unit tests, @parser-kit/sql and js-lite
pnpm types:check
pnpm lint
pnpm build
pnpm bench         # @parser-kit/sql vs node-sql-parser
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

Parsing untrusted input, or found a way to make the parser hang on some? See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © DemonHa
