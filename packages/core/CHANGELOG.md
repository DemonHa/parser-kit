# @parser-kit/core

## 0.1.0

### Minor Changes

- [`93cd05e`](https://github.com/DemonHa/parser-kit/commit/93cd05eca83db904effbcebf1b2eb9190e6a2139) Thanks [@DemonHa](https://github.com/DemonHa)! - Initial public release.
  
  A zod-like parser toolkit: describe a grammar as schema values and get the parser, the AST, and its TypeScript types out of one declaration. `Infer<typeof rule>` reads the output type the way `z.infer` does.
  
  - **Lexing** — `defineLexer` with a data-driven reader library (numbers, strings, dollar-quoted strings, comments, operators, regex literals, template chunks), plus modes and transitions for context-sensitive tokenization.
  - **Combinators** — `seq`, `oneOf`, `optional`, `delimited`, `sepBy`, `repeat`, `lazy`, `attempt`, `word`, `phrase`, `identifierLike`, and `custom`, dispatched LL(1) on first sets.
  - **Expressions** — `pratt()` precedence climbing with prefix, infix, and postfix groups, custom tails, and non-associative operators.
  - **Grammars** — `defineGrammar` / `defineExpression`, each exposing `parse`, `diagnose` (error recovery that collects every diagnostic), and `parseValue`.
  - Always-on source spans, human-readable `ParseError` messages driven by your lexer's `display` labels, and dual ESM/CJS builds with zero runtime dependencies.
