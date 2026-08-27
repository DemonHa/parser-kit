# AGENTS.md — @database.io/parser-kit

A generic, zod-like parser toolkit: describe a grammar as schema **values** and
get the parser, the AST, and its TypeScript types out of one declaration
(`Infer<typeof rule>` reads the output type the way `z.infer` does). The kit
knows nothing about any particular language. See the root `AGENTS.md` for
monorepo tooling, and `README.md` here for the full user-facing guide.

## Orientation

Start with `README.md` (concepts + API) and then read `examples/js-lite/grammar.ts`
and `examples/sql-lite/grammar.ts` top to bottom — the examples are the fastest
way to learn the kit and are its genericity/integration tests.

## Public API

`src/index.ts` re-exports everything supported (no default export). The pieces:

- **Lexing** — `defineLexer`, the `readers.*` library (`number`, `string`,
  `dollarString`, `lineComment`, `blockComment`, `operator`, `regex`,
  `templateChunk`, `custom`), `LexContext`, mode/transition types.
- **Combinators** — `token`, `seq`, `field`, `skip`, `oneOf`, `attempt`,
  `optional`, `delimited`, `sepBy`, `repeat`, `lazy`, `custom`, `word`, `phrase`,
  `identifierLike`, and `bindTokens`.
- **Expressions** — `pratt`.
- **Grammars** — `defineExpression`, `defineGrammar` (each grammar exposes
  `parse` / `diagnose` / `parseValue`).
- **Support** — `ParseError`, `Infer`, `stripSpans`, `Position`/`Span`, the
  `describe*` label helpers, and the lower-level `Rule`/`ParseContext`/`Token`
  types for hand-written `custom()` rules.

**Changing the public API is a breaking change for its consumers.**
`@database.io/dbml-parser` already imports `ParseError`, `Position`,
`createInputStream`, and the trie helpers from here (its `CroakException extends
ParseError`), and is mid-migration onto the rest. Update consumers in lockstep.

## Internals — layered, bottom-up

`src/` layers cleanly; each file depends only on the ones above it:

- `input-stream.ts` (char cursor, single snapshot slot), `position.ts`, `trie.ts`
  (prefix-tree matcher) — the primitives.
- `token.ts` (`Token`, `TokenMatch`, `matchesToken`), `describe.ts` (error
  labels), `error.ts` (`ParseError`).
- `lexer.ts` — `defineLexer` + the whole `readers` library and mode engine.
- `combinators.ts` — the `Rule` combinators and `bindTokens`.
- `pratt.ts` — precedence climbing, built on `ParseContext`.
- `rule.ts` — `makeRule`, `createParseContext`, `Infer`, first-set machinery.
- `grammar.ts` — `defineExpression` / `defineGrammar` tie a lexer + root rule
  together and add recovery/trivia/error-reporting policy.
- `strip-spans.ts` — `stripSpans` for structural test comparisons.

## Authoring a grammar — gotchas that will bite you

- **TT is not inferable from a constraint-only position.** `seq`/`oneOf`/
  `defineExpression` derive the token union from their arguments, but standalone
  `token`/`word`/`phrase`/`identifierLike` can't. Call `bindTokens<TT>()` once
  per grammar module and use the bound factories so you don't repeat the generic.
- **`token()` returns a `Rule`; `match()` returns a `TokenMatch`.** Use the Rule
  form in `seq`/`skip`/`oneOf`/`optional`. Use `match()` only where a
  `TokenMatch` is expected — `delimited` open/close and `pratt` `match`-form
  operator args. Passing a `TokenMatch` where a `Rule` is required (e.g. `skip`)
  is a type error; wrap the token in a Rule instead.
- **Recursive rules need exactly one explicit annotation.** `const expr:
  Rule<Expr, TT> = pratt<Expr, TT>({...})` — same limitation as `z.lazy`. Use
  `lazy(() => rule)` for forward references.
- **`oneOf` commits on the first-set match; value-specific beats type-only.** A
  `word("ident","select")` branch wins over an `identifierLike` branch. Overlapping
  *committed* branches are a definition-time error; branches behind `lazy()` are
  validated on first parse instead. Wrap a shared-prefix branch in `attempt()`
  to opt it into full backtracking.
- **`optional`/`oneOf` don't backtrack unless `attempt`-wrapped.** An
  `optional(nameWord)` before a reserved keyword commits on the type-only first
  set then rejects — use `optional(attempt(nameWord))`.
- **Reader ordering matters.** In the `readers` array, comment readers must come
  before `operator` and `regex` (so `--`/`/*`/`//` win). `operator`'s `chars`
  must not overlap the punctuation trie's tokens — partition the character space.
- **Newline is not whitespace by default.** Either lex it as punctuation (DBML
  style) or add it to `whitespace` (JS style).

## Tests

Vitest, co-located as `*.test.ts` per module, plus the two `examples/*/`
suites (234 tests total). Run `pnpm --filter @database.io/parser-kit test`
(`types:check` / `build` likewise). When you add a feature:

- Add unit tests at the level it lives (lexer / combinator / pratt / rule /
  grammar) **and** exercise it end-to-end in an example grammar if it's
  user-facing — the examples are the genericity guard.
- **Keep every feature opt-in.** The kit's tests and, critically, the
  **93 byte-exact dbml goldens** in `@database.io/dbml-parser` must stay green
  after every change. Never regenerate a golden to make a change pass — a golden
  diff means you changed observable parse/error output.
- The `build` (`tsconfig.build.json`) compiles `src/` only — tests and
  `examples/` are excluded from the published output but are type-checked by
  `types:check`. Don't commit `build/`.
