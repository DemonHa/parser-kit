# @parser-kit/core

## 0.2.0

### Minor Changes

- [#44](https://github.com/DemonHa/parser-kit/pull/44) [`b21b40f`](https://github.com/DemonHa/parser-kit/commit/b21b40f8afead5b71bbf42cb6fb40e818ca2a821) Thanks [@DemonHa](https://github.com/DemonHa)! - `pratt()` infix and postfix groups accept an optional `when: (ctx, left) => boolean` guard. It runs after the group's operator matched and can decline after peeking: the next matching group of the same kind is tried, a token no postfix group accepts goes on to infix lookup, and if no infix group accepts either, the expression ends as if no operator matched. Use it to keep a catch-all operator group from taking a token another rule owns, or to let a keyword operator bow out when the following word shows it isn't one. The new `PrattGuard` type is exported. Groups without `when` behave exactly as before.

- [#43](https://github.com/DemonHa/parser-kit/pull/43) [`9222189`](https://github.com/DemonHa/parser-kit/commit/92221890d166a882b6f911697f8d1b25b75bb0f8) Thanks [@DemonHa](https://github.com/DemonHa)! - Add the opt-in `errorReporting.propagateLexerErrors` grammar option. Without it, a lexer error raised inside an `attempt()` branch (or any `ctx.tryParse`) rolls back like a failed alternative. The lexer has already consumed the offending characters by then, so the error resurfaces as a misleading parser error on whatever follows, or is silently dropped when the next branch succeeds. With the option on, errors thrown by the token stream are tagged `ParseError.fromLexer` and rethrown by `tryParse` and left alone by `describe()` relabelling, so `parse` and `diagnose` report the real lexer error. Default behaviour is unchanged.

- [#59](https://github.com/DemonHa/parser-kit/pull/59) [`990541c`](https://github.com/DemonHa/parser-kit/commit/990541cdd5035f01dd54b7d582621b01c1e24f08) Thanks [@DemonHa](https://github.com/DemonHa)! - Add the opt-in `strictDelimited` grammar option. By default a `delimited()` list that reaches end of input before its close token ends there as if closed, so `(a, b` at the end of the input parses as a complete list. Grammars that require a terminator after every construct never notice, because the terminator check fails first, but a grammar whose last statement needs no terminator accepts the truncated input. With the option on, the list fails with `Expected <close> but found end of input`. `ParseContext` exposes the setting as the read-only `strictDelimited`. Default behaviour is unchanged.

## 0.1.0

### Minor Changes

- [`93cd05e`](https://github.com/DemonHa/parser-kit/commit/93cd05eca83db904effbcebf1b2eb9190e6a2139) Thanks [@DemonHa](https://github.com/DemonHa)! - Initial public release.
  
  A zod-like parser toolkit: describe a grammar as schema values and get the parser, the AST, and its TypeScript types out of one declaration. `Infer<typeof rule>` reads the output type the way `z.infer` does.
  
  - **Lexing** — `defineLexer` with a data-driven reader library (numbers, strings, dollar-quoted strings, comments, operators, regex literals, template chunks), plus modes and transitions for context-sensitive tokenization.
  - **Combinators** — `seq`, `oneOf`, `optional`, `delimited`, `sepBy`, `repeat`, `lazy`, `attempt`, `word`, `phrase`, `identifierLike`, and `custom`, dispatched LL(1) on first sets.
  - **Expressions** — `pratt()` precedence climbing with prefix, infix, and postfix groups, custom tails, and non-associative operators.
  - **Grammars** — `defineGrammar` / `defineExpression`, each exposing `parse`, `diagnose` (error recovery that collects every diagnostic), and `parseValue`.
  - Always-on source spans, human-readable `ParseError` messages driven by your lexer's `display` labels, and dual ESM/CJS builds with zero runtime dependencies.
