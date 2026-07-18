# @database.io/parser-kit

A generic, zod-like parser toolkit: describe a grammar as schema values and get the parser, the AST **and its TypeScript types** out of the same declaration. No code generation, no grammar files — rules are plain values you compose, and `Infer<typeof rule>` reads the output type the way `z.infer` does.

The kit knows nothing about any particular language. `@database.io/dbml-parser` is being rebuilt on top of it, and two bundled examples parse real-shaped grammars with the same engine: [`examples/js-lite/`](examples/js-lite/) (a JavaScript subset) and [`examples/sql-lite/`](examples/sql-lite/) (a PostgreSQL-flavoured DDL subset).

```ts
import { bindTokens, defineGrammar, defineLexer, field, type Infer, readers, seq, skip } from "@database.io/parser-kit";

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
grammar.parse("answer: 42");        // → typed Pair, spans included
grammar.parse("answer 42");         // → ParseError: Expected ":" but found "42"
```

## Contents

- [Core concepts](#core-concepts) — `Rule`, spans, errors
- [Lexing: `defineLexer`](#lexing-definelexer) — token rules and dispatch order
  - [Built-in readers](#built-in-readers) — numbers, strings, comments, operators, regex, templates
  - [Context-sensitive lexing](#context-sensitive-lexing-modes--transitions) — modes, transitions, `LexContext`
- [Combinators](#combinators) — `seq`, `oneOf`, `optional`, `delimited`, …
- [Expressions: `pratt`](#expressions-pratt) — precedence climbing
- [Grammars: `defineExpression` / `defineGrammar`](#grammars-defineexpression--definegrammar)
- [The examples](#the-examples) — how to learn the kit by reading
- [Design notes & current limits](#design-notes--current-limits)

## Core concepts

**`Rule<T, TT>`** — the schema value. `T` is what the rule produces, `TT` is the grammar's token vocabulary (a string union you define; nothing is hardcoded). Every rule knows how to `parse`, exposes its LL(1) dispatch set (`first()`), renders itself for error messages (`expected()`), and supports `.map(fn)` / `.describe(label)`.

**Always-on spans** — every engine-produced node carries `span: { start, end }` with `{ row, col }` positions. `.map` callbacks receive the span as a second argument. Use `stripSpans(value)` for structural comparisons in tests.

**Errors** — the kit throws `ParseError { msg, start, end }` with human messages ("Expected a number but found \"foo\"", "Expected \"pk\", \"unique\" or \"note\" but found a new line"). Labels like "a number" come from the lexer's `display` config, never from internal type names. Consumers can subclass `ParseError` to keep their own error identity (`CroakException extends ParseError` in dbml-parser).

## Lexing: `defineLexer`

Data-driven tokenizer over the character-level `InputStream` (v1 ships a string implementation; the interface is the contract).

```ts
const lexer = defineLexer({
  keywords: {
    type: "kw",
    words: ["table", "ref", ["not", "null"], ["primary", "key"]],  // multi-word entries match across whitespace
    caseInsensitive: true,                                          // token keeps the lowercase form
    display: "a keyword",
  },
  punctuation: { type: "punc", tokens: ["{", "}", ":", "\n", "<", "<>"], display: "a symbol" },
  identifier: { type: "var", start: /[a-z_]/i, part: /[a-z0-9_]/i, display: "an identifier" },
  // identifier also takes fold: "lower" | "upper" — token.value is case-folded (PG's
  // unquoted-identifier rule); with a folding lexer, match keywords by value via word()/phrase()
  readers: [
    readers.number("num", { signs: ["-"] }),               // -3, 1.5; sign only when a digit follows
    readers.string("str", { quote: "'", block: { fence: "'''", type: "mstr" } }),  // block strings dedent
    readers.lineComment("comment", "//"),
    readers.blockComment("comment", "/*", "*/"),
    readers.custom("hex", { startsWith: "#", read: (stream) => /* ... */ "" }),
  ],
  whitespace: " \t",   // CharClass: string set, RegExp, or predicate. Newline is NOT skipped by default —
                       // lex it as punctuation (DBML) or add it to whitespace (JS).
});
```

Dispatch order: readers (in listed order) → keywords/identifier → punctuation (longest match wins via a trie) → `Unexpected character "x"`. A reader may return `null` to fall through to the next candidate. Tokens are `{ type, value, position: { start, end } }`.

### Built-in readers

`readers.*` returns a `Reader` you drop into the `readers` array. Each takes a token `type` and an options object; every reader accepts `display` for its error label. All the tricky rules (backtrack-on-non-match, EOF handling, span vs. decoded value) are handled for you.

| Reader | Handles | Key options |
|---|---|---|
| `readers.number(type, opts)` | Integer/decimal literals | `signs` (leading `+`/`-`, only when a digit follows), `decimal` (default `true`), `exponent` (`1.5e-3`), `leadingDot` (`.5`), `radix` (`{ hex, octal, binary }` → `0x`/`0o`/`0b`), `separators` (`1_000`, stripped from `value`) |
| `readers.string(type, opts)` | Quoted strings | `quote`, `block` (`{ fence, type, dedent }` triple-fence form), `prefix` (`E'…'`), `prefixCaseInsensitive`, `escape` (`{ doubling: '' → ', backslash: true \| map }`) |
| `readers.dollarString(type, opts)` | PG `$tag$…$tag$` (raw body, `$1` falls through) | — |
| `readers.lineComment(type, prefix, opts)` | `//` / `--` to end of line | — |
| `readers.blockComment(type, open, close, opts)` | `/* … */` | `nested` (depth-counted `/* /* */ */`) |
| `readers.operator(type, opts)` | PG multi-char operators (`||`, `@>`, `<->`) | `chars`, `stopAt` (never cross a comment start; default `["--","/*"]`), `noTrailing` (trim trailing `+`/`-` unless a strong char is present). Partition its `chars` from the punctuation trie; list comment readers before it |
| `readers.regex(type, opts)` | JS regex literals (`/…/flags`) | `allowedAfter(ctx)` — the division-vs-regex predicate; the default classifies `ctx.lastToken` by value shape. List after the comment readers |
| `readers.templateChunk(type, opts)` | A run of template text up to `` ` `` or `${` | `exit`, `enter`, `escape`; returns `null` on a delimiter so no empty chunks. Used under a template *mode* (below) |
| `readers.custom(type, opts)` | Escape hatch | `startsWith` (`CharClass`), `read(stream, ctx) → ReaderResult \| string \| null` |

A reader's `read` returns `{ value, type?, start?, end? }` — override `type` to emit a different token type (block strings), or `start`/`end` to span the content rather than the delimiters (dbml strings span inside the quotes). Return `null` to decline after restoring the stream yourself.

### Context-sensitive lexing: modes & transitions

Readers dispatch on the current character, but two escape hatches let the lexer depend on what came before — enough for JS regex-vs-division and template literals without a separate lexer pass.

**`LexContext`** is passed to every reader as a third argument (`read(stream, ctx)`) and to transition guards. It is a *pure function of the tokens already emitted*, which is what keeps snapshot/rollback sound — parser branching can never change it:

```ts
interface LexContext {
  lastToken: Token | null;   // last non-trivia token; null at start of input
  lastMode: string;          // the mode lastToken was lexed in
  mode: string;              // current mode (top of the stack); root is "default"
}
```

**Modes** are alternate lexing tables (their own `readers`/`punctuation`/`whitespace`), and **transitions** switch between them, driven by the tokens themselves — evaluated once, at lexing time, so rollback never re-runs them:

```ts
const lexer = defineLexer({
  // ...root ("default") mode: identifiers, numbers, `` ` `` punctuation, the regex reader...
  punctuation: { type: "punc", tokens: ["`", "${", "}", "/"], display: "a symbol" },
  readers: [readers.regex("regex"), /* ... */],

  modes: {
    template: {
      whitespace: "",                                   // every character is significant
      punctuation: { type: "punc", tokens: ["`", "${"], display: "a symbol" },
      readers: [readers.templateChunk("tmpl")],
    },
  },
  transitions: [
    { on: { type: "punc", value: "`" }, inMode: "default", action: "push", mode: "template" },
    { on: { type: "punc", value: "`" }, inMode: "template", action: "pop" },
    { on: { type: "punc", value: "${" }, inMode: "template", action: "push", mode: "default" },
    { on: { type: "punc", value: "}" }, when: (ctx) => ctx.mode === "default", action: "pop" },
  ],
  trivia: ["comment"],                                  // excluded from lastToken tracking
});
```

Transitions carry `on` (the token pattern that fires it), optional `inMode` (only when that mode was current) and `when(ctx)` guards, `action: "push" | "pop"`, and a target `mode` for pushes. First match wins; a `pop` at the root is a no-op (a stray `}` becomes the parser's error, not the lexer's). On the parser side, `ctx.newlineBefore()` reads whether a newline separated the current token from the previous significant one — the hook for ASI-style rules.

## Combinators

| Combinator | Meaning |
|---|---|
| `token(type)` / `token(type, { values })` | Match one token; `values` narrows the output to a literal union (`kw(["delete","update"])` → `value: "delete" \| "update"`) |
| `seq(field("a", r1), skip(r2), ...)` | Sequence. `field` names an output property, `skip` consumes without output. Explicit tuple ordering — no reliance on object key order |
| `oneOf(r1, r2, ...)` | LL(1) alternation dispatched on `first()` sets. Value-specific branches beat type-only branches; overlapping committed branches are a definition-time error |
| `attempt(rule)` | Opts a `oneOf`/`optional` branch into full backtracking (token ring buffer rollback) for shared prefixes — `(a, b) => a` vs `(a + b)` |
| `optional(rule)` / `optional(rule, { default })` | First-set-gated optionality — no backtracking unless the rule is `attempt`-wrapped |
| `delimited(open, close, sep, item, { interleaved?, recover? })` | Bracketed list. `interleaved: true` = comma-style; `false` = separator-terminated lines where runs of separators and trivia collapse (blank lines, comment lines). `recover: true`: in `diagnose()` a failed item is recorded and skipped to the list's own next separator or close (nested open/close pairs counted), keeping the sibling items — strict `parse()` still throws |
| `sepBy(item, sep)` | Bare separated list, no brackets |
| `repeat(rule, { until? })` | Zero-or-more until EOF or an `until` match; participates in error recovery |
| `lazy(() => rule)` | Forward references / recursion |
| `custom(parseFn, { expected, first })` | Escape hatch: a hand-written parser over `ParseContext` that still composes, dispatches, and reports errors like any rule |
| `word(type, text)` | One keyword by exact value on an identifier-typed token (`word("ident", "select")`) — the keyword strategy for folding lexers: keywords never get their own token type |
| `phrase(type, ...words)` | A keyword run (`phrase("ident", "primary", "key")`) as one node: value joined with spaces, span covering the run, dispatched on the first word |
| `identifierLike(type, { exclude })` | Any `type` token whose value is not in `exclude` — the "identifier that isn't a reserved word" position. Type-only first set, so it loses to every `word()`/`phrase()` branch in `oneOf` |
| `bindTokens<TT>()` | Returns `token`/`match`/`word`/`phrase` pre-bound to your token union so call sites don't repeat the generic |

`ParseContext` (what `custom()` sees) offers `peek/next/eof/is/eat`, `peekAhead(n)` (arbitrary lookahead; `peekAhead(0) === peek()`; raw tokens, no trivia skipping), `parse(rule)`, `tryParse(rule)` (snapshot + rollback), `position()`, `croak(msg)`, plus engine surface: `spanFrom(start)`, `skipTrivia()`, `newlineBefore()` (was the current token separated from the previous significant one by a newline — for ASI-style rules), `label(type)`, `recover(error)` (record + resync), `report(error)` (record only), `farthestError()`, `consumed()`.

## Expressions: `pratt()`

Declarative precedence climbing for operator grammars `seq`/`oneOf` can't express without exploding:

```ts
const expression: Rule<Expr, TT> = pratt<Expr, TT>({   // recursive rules need one explicit annotation
  atom: oneOf(numberLit, parenExpr),
  prefix: [{ ops: ["!", "-"], bp: 14, type: "punc", map: (op, operand, span) => ... }],
  infix: [
    { ops: ["="], bp: 2, assoc: "right", type: "punc", map: ... },
    { ops: ["?"], bp: 3, type: "punc", parse: (ctx, left, h) => ... },   // custom tail (ternary)
    { ops: ["<", ">"], bp: 9, type: "punc", assoc: "nonassoc", map: ... },
    { ops: ["+", "-"], bp: 11, type: "punc", map: ... },
    { match: word("ident", "between"), bp: 7, parse: (ctx, left, h) => ... },  // multi-word operator
  ],
  postfix: [{ match: punc("("), bp: 17, parse: (ctx, left, h) => ... }], // call/member/index
});
```

Higher `bp` binds tighter; left-associative operators re-enter at `bp + 1`, right-associative at `bp`. `nonassoc` re-enters at `bp + 1` and croaks (`Operator "<" is non-associative`) when another operator of the same group follows — `a < b < c` errors, `(a < b) < c` parses; put all same-precedence comparisons in one group so mixed chains are caught too.

Custom `parse` callbacks get `h: PrattHelpers` with `h.parseRhs(minBp)` — re-enter precedence climbing for an operand instead of recursing through the whole rule at bp 0. That's how BETWEEN consumes its bounds above `AND`'s own bp: `parse: (ctx, left, h) => { ctx.next(); const lo = h.parseRhs(8); ctx.parse(word("ident", "and")); const hi = h.parseRhs(8); ... }`.

The `match` infix form dispatches on a rule's first set instead of literal op values — the hook for multi-word operators built from `word()`/`phrase()`. Groups are tried in declaration order, first match wins: operators sharing a leading token (`NOT LIKE` / `NOT BETWEEN` / `NOT IN`) must be one group dispatching internally. Case-insensitive keyword operators need no pratt feature — with a folding lexer, `{ ops: ["and"], type: "ident" }` is already exact.

## Grammars: `defineExpression` / `defineGrammar`

Two forms. **Root-rule** for languages whose statements need no leading keyword:

```ts
const jsLite = defineGrammar({
  lexer,
  root: repeat(statement),
  trivia: { between: [{ type: "comment" }] },              // skippable between items — policy, not baked in
  recovery: { sync: [{ type: "punc", value: ";", consume: true }, { type: "punc", value: "}" }] },
});
```

**Keyword-expressions sugar** for DBML-style languages — derives the root loop, the top-level error message, and the recovery sync set from the expression list:

```ts
const tableExpr = defineExpression({ keyword: "table", type: "table", display: "Table", rule: ... });
const grammar = defineGrammar({ lexer, expressions: [tableExpr, refExpr], trivia: ... });
// grammar.parse(src) → { type: "program", program: (Infer<...>)[] }
```

Every grammar exposes:

- `parse(text)` — throws the first `ParseError`.
- `diagnose(text)` — error recovery: skips to the next sync point, collects every diagnostic (lexer errors included), returns `{ ast, errors }`.
- `parseValue(rule, text)` — run any sub-rule standalone against fresh input (tests, tooling).

**Farthest-failure error reporting** — `defineGrammar({ ..., errorReporting: { preferFarthest: true } })` reports the failure that consumed the most tokens instead of the one that happened to propagate, so a deep failure inside a discarded `attempt()` branch beats the shallow "wrong branch" message. Standard PEG tradeoff: the reported error may point into an abandoned attempt — usually the better message, and the flag is off by default so existing grammars' messages are byte-identical.

## The examples

Two runnable grammars double as the kit's genericity/integration tests and as the fastest way to learn it — read their `grammar.ts` top to bottom.

- **[`examples/js-lite/`](examples/js-lite/)** — a JavaScript subset (`const`/`let`, `function`, `if`/`else`, `while`, `return`, blocks, expression statements, full expression precedence, arrays, arrow functions). Exercises what DBML doesn't: root-rule dispatch, newlines as whitespace, the whole `pratt()` table, load-bearing `attempt()` backtracking, and the template-literal *mode*.
- **[`examples/sql-lite/`](examples/sql-lite/)** — a PostgreSQL-flavoured DDL subset (`CREATE`/`ALTER`/`DROP TABLE`, `CREATE INDEX`/`TYPE`, `COMMENT ON`) with folded identifiers, dollar-quoted and `E'…'` strings, `readers.operator`, and pratt expressions (cast `::`, `||`, non-associative comparisons, keyword operators `AND`/`OR`/`IS NULL`/`[NOT] LIKE`/`BETWEEN`/`IN`). The best reference for a folding lexer and `word()`/`phrase()` keyword matching.

## Design notes & current limits

- **Stringify/printing**: rules carry optional `print`/`inverse` hooks so derivation is possible later; nothing consumes them yet (the kit keeps hand-written stringify on the consumer side).
- **Tokenization is context-sensitive when you opt in**: readers dispatch on the current character, but [modes, transitions, and `LexContext`](#context-sensitive-lexing-modes--transitions) give the lexer/parser interplay that JS regex-vs-division and template literals need. A mode-free lexer stays a plain context-free tokenizer.
- **`InputStream` ships a string implementation only** — the interface is the contract, but there's no streaming/incremental reader yet.
- **`oneOf` validation** runs at definition time when possible; branches behind `lazy()` forward references are validated on first parse instead.
- Type inference happens at construction (zod's trick) — no deep recursive conditional types. Recursive rules need exactly one explicit `Rule<T, TT>` annotation, same limitation as `z.lazy`.

## Development

```sh
pnpm --filter @database.io/parser-kit test         # unit tests per combinator + lexer + JS-lite
pnpm --filter @database.io/parser-kit types:check
pnpm --filter @database.io/parser-kit build        # tsc → build/
```
