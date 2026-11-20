# @parser-kit/core

## 0.3.0

### Minor Changes

- [#86](https://github.com/DemonHa/parser-kit/pull/86) [`7ed2825`](https://github.com/DemonHa/parser-kit/commit/7ed2825629a1f8e19fcc3670a3945966d04c4dc8) Thanks [@DemonHa](https://github.com/DemonHa)! - Add `@parser-kit/core/print`, an opt-in entry point for turning ASTs back into text. It provides a Wadler/Leijen-style document IR (strings, arrays for concatenation, `group`, `indent`, `line`, `softline`, `hardline`, `nbsp`, `ifBreak`, `join`, plus `block` for indented brace bodies and `list` for bracketed lists that can disappear when empty) and `render(doc, { width, indent })`, which lays a doc out for a line width. `width: Infinity` lays every group out flat (only hard lines and groups that must break still break) and skips width measurement, and `indent` takes a number of spaces or a string such as `"\t"`. Spaces and tabs before every line break the doc makes, and at the end of the output, are dropped. The renderer is iterative, so deeply nested docs can't overflow the stack. The entry ships as dual ESM/CommonJS with type declarations (its types also resolve under `moduleResolution: node10`), and nothing in the parsing API imports it, so parse-only bundles don't grow.

- [#88](https://github.com/DemonHa/parser-kit/pull/88) [`2c0567b`](https://github.com/DemonHa/parser-kit/commit/2c0567b63b3b71d8ec31b8ca7e623c93a9ca46f1) Thanks [@DemonHa](https://github.com/DemonHa)! - Add typed printers, Pratt-table precedence and quoting to `@parser-kit/core/print`.
  
  - `definePrinter<T>()(key, handlers)` builds a printer for one discriminated union, dispatching on the discriminant you name (`"kind"`, `"type"`, …). Leaving a variant out is a compile error, and each handler gets its node narrowed. Printers compose: each union gets its own, and they call each other, so a discriminant value shared by two unions is handled per union. Handlers recurse through the printer they are given, so `extendPrinter(base, overrides)` builds a variant (a dialect, say) whose overrides apply all the way down. `Printable<T>` makes every `span` optional, so printers accept hand-built trees.
  - `precedence(table, { key, print })` derives parenthesisation from the same Pratt table the parser uses: `prec.child(parent, child, side)` wraps a child only when the parser needs it. It reads each group's binding power and associativity, plus two new optional printer-only fields on Pratt groups, `nodes` (the node keys a `match` / `parse` group builds, optionally each with its own tail) and `rhs` (the bp a custom `parse` reads its trailing operand at, or `"none"`). The parser ignores both, so existing grammars parse exactly as before. Where it can't tell, it adds parentheses, and a node key the table doesn't name throws rather than printing unchecked. `prec.operand(node, minBp, context)` covers operands parsed outside the table, and `contexts` names cut-down tables for restricted positions; a context applies to the whole operand printed in it.
  - `quoting(rules)` prints names and strings bare or quoted from the grammar's lexical rules (quote characters, escape style, start and part characters, reserved words, case folding), in `"minimal"`, `"always"` or `"preserve-if-valid"` mode. Quoting is decided from the value, so hand-built trees print valid text.
  - A new `@parser-kit/core/print/testing` entry exports `fieldCoverage`, a test helper that records which fields a printer reads across a corpus and reports the variants it never printed and the fields it never read.
  
  With these, the `./print` entry is about 3 KB minified and gzipped; the testing entry is separate and doesn't count towards it. `PrattPrintMeta` is exported from the root entry.

### Patch Changes

- [#82](https://github.com/DemonHa/parser-kit/pull/82) [`87a9cbd`](https://github.com/DemonHa/parser-kit/commit/87a9cbd8e023c43d05ce29e33e7acc939eb3ce3c) Thanks [@DemonHa](https://github.com/DemonHa)! - Deprecate the unused printing hooks: `Rule.print`, `Rule.inverse`, the `print` option of `custom()`, the second (`inverse`) argument to `map()`, and the `Printer` type. Nothing in parser-kit ever called them. Printing will be provided by a forthcoming opt-in `@parser-kit/core/print` entry instead, and these hooks will be removed before 1.0. They still type-check and are still stored on the rule they are passed to, so this release changes no behaviour.

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
