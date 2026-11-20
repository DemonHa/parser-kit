# @parser-kit/core

[![npm](https://img.shields.io/npm/v/@parser-kit/core.svg)](https://www.npmjs.com/package/@parser-kit/core)
[![CI](https://github.com/DemonHa/parser-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/DemonHa/parser-kit/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/npm/l/@parser-kit/core.svg)](../../LICENSE)

A generic, zod-like parser toolkit: describe a grammar as schema values and get the parser, the AST **and its TypeScript types** out of the same declaration. No code generation, no grammar files — rules are plain values you compose, and `Infer<typeof rule>` reads the output type the way `z.infer` does.

```sh
npm install @parser-kit/core   # or: pnpm add / yarn add / bun add
```

Ships ESM and CommonJS builds with bundled type declarations. Node >= 18, zero runtime dependencies.

The kit knows nothing about any particular language. Two grammars in the repo parse real languages with the same engine: [`examples/js-lite/`](https://github.com/DemonHa/parser-kit/tree/main/examples/js-lite) (a JavaScript subset) and [`@parser-kit/sql`](https://github.com/DemonHa/parser-kit/tree/main/packages/sql) (PostgreSQL 17, published as its own package, with the grammar in `src/postgres/`).

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
- [Printing: `@parser-kit/core/print`](#printing-parser-kitcoreprint) — a document IR and renderer, typed printers, parentheses from the Pratt table, quoting
- [The example grammars](#the-example-grammars) — how to learn the kit by reading
- [Design notes & current limits](#design-notes--current-limits)

## Core concepts

**`Rule<T, TT>`** — the schema value. `T` is what the rule produces, `TT` is the grammar's token vocabulary (a string union you define; nothing is hardcoded). Every rule knows how to `parse`, exposes its LL(1) dispatch set (`first()`), renders itself for error messages (`expected()`), and supports `.map(fn)` / `.describe(label)`.

**Always-on spans** — every engine-produced node carries `span: { start, end }` with `{ row, col }` positions. `.map` callbacks receive the span as a second argument. Use `stripSpans(value)` for structural comparisons in tests.

**Errors** — the kit throws `ParseError { msg, start, end }` with human messages ("Expected a number but found \"foo\"", "Expected \"pk\", \"unique\" or \"note\" but found a new line"). Labels like "a number" come from the lexer's `display` config, never from internal type names. Consumers can subclass `ParseError` to keep their own error identity (`class CroakException extends ParseError`) without losing the kit's messages.

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
| `delimited(open, close, sep, item, { interleaved?, recover? })` | Bracketed list. `interleaved: true` = comma-style; `false` = separator-terminated lines where runs of separators and trivia collapse (blank lines, comment lines). `recover: true`: in `diagnose()` a failed item is recorded and skipped to the list's own next separator or close (nested open/close pairs counted), keeping the sibling items — strict `parse()` still throws. End of input closes an open list unless the grammar sets `strictDelimited` (below) |
| `sepBy(item, sep)` | Bare separated list, no brackets |
| `repeat(rule, { until? })` | Zero-or-more until EOF or an `until` match; participates in error recovery |
| `lazy(() => rule)` | Forward references / recursion |
| `custom(parseFn, { expected, first })` | Escape hatch: a hand-written parser over `ParseContext` that still composes, dispatches, and reports errors like any rule |
| `word(type, text)` | One keyword by exact value on an identifier-typed token (`word("ident", "select")`) — the keyword strategy for folding lexers: keywords never get their own token type |
| `phrase(type, ...words)` | A keyword run (`phrase("ident", "primary", "key")`) as one node: value joined with spaces, span covering the run, dispatched on the first word |
| `identifierLike(type, { exclude })` | Any `type` token whose value is not in `exclude` — the "identifier that isn't a reserved word" position. Type-only first set, so it loses to every `word()`/`phrase()` branch in `oneOf` |
| `bindTokens<TT>()` | Returns `token`/`match`/`word`/`phrase` pre-bound to your token union so call sites don't repeat the generic |

`ParseContext` (what `custom()` sees) offers `peek/next/eof/is/eat`, `peekAhead(n)` (arbitrary lookahead; `peekAhead(0) === peek()`; raw tokens, no trivia skipping), `parse(rule)`, `tryParse(rule)` (snapshot + rollback; see `propagateLexerErrors` below), `position()`, `croak(msg)`, plus engine surface: `spanFrom(start)`, `skipTrivia()`, `newlineBefore()` (was the current token separated from the previous significant one by a newline — for ASI-style rules), `label(type)`, `recover(error)` (record + resync), `report(error)` (record only), `farthestError()`, `consumed()`, and the read-only `strictDelimited` flag.

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

Any infix or postfix group can take an opt-in `when: (ctx, left) => boolean` guard, checked after the group's operator matched. Returning `false` declines: the next matching group of the same kind is tried, and a token no postfix group accepts goes on to infix lookup as usual. If no infix group accepts either, the expression ends there as if no operator matched, leaving the token to the enclosing rule. Infix guards run before the bp check, so a later group with a different bp can take a declined token; postfix guards run only once the group's bp qualifies. The cursor is still on the operator, so peek with `ctx.peek()`/`ctx.peekAhead(n)` and don't consume. The guard may be called again for the same token (at each enclosing precedence level, with that level's `left`, and for the non-associativity chain check), so keep it pure. That lets a catch-all operator group skip one token (`when: (ctx) => ctx.peek()?.value !== "=>"`), or a keyword postfix like `AT` bow out unless `TIME ZONE` or `LOCAL` follows, so the word stays usable as an alias. Guards don't change the rule's first set, and groups without one behave and cost exactly as before.

Groups also accept two printer-only fields, `nodes` and `rhs`, which the parser ignores. They let `precedence()` in [`@parser-kit/core/print`](#parentheses-from-the-pratt-table-precedence) derive a printer's parentheses from the same table.

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

**Lexer error propagation** — `defineGrammar({ ..., errorReporting: { propagateLexerErrors: true } })` stops backtracking from swallowing lexer errors. Lexing is lazy, so a bad character can be hit while an `attempt()` branch (or any `ctx.tryParse`) is running. By default that error rolls the branch back like any other failure. But the lexer has already consumed the offending characters, so the next branch trips over whatever follows them and reports a misleading parser error, or even parses cleanly with the characters silently dropped. With the flag on, errors thrown by the token stream are stamped `fromLexer: true` and pass through `tryParse` (nested ones included) and `describe()` relabelling unchanged. `parse` throws them, and in `diagnose` they reach recovery like any other error. The cursor stays where the lexer stopped instead of rolling back. Lexer errors carry no `consumed` stamp, so `preferFarthest` never replaces one with a croak from an abandoned branch. The flag is off by default, and with it off errors are neither tagged nor rethrown.

**Strict list closes** — `defineGrammar({ ..., strictDelimited: true })` makes a `delimited()` list that reaches end of input before its close token fail with `Expected <close> but found end of input`. By default the list ends there as if closed, so `(a, b` at the end of the input parses as a complete list. A grammar that requires a terminator after every construct never notices, because the terminator check fails first. A grammar whose last statement needs no terminator wants the flag. It is off by default, and with it off nothing changes.

## Printing: `@parser-kit/core/print`

An opt-in entry point for the other direction, AST → text. It holds a Wadler/Leijen-style document IR (the model prettier uses), a renderer that lays a document out for a line width, typed exhaustive printers (`definePrinter`), parentheses derived from your Pratt table (`precedence`) and a quoting policy for names and strings (`quoting`). You write the printer by hand, one handler per node, and build docs instead of strings. The entry is about 2.5 KB minified and gzipped, and nothing in the parsing API imports it, so parse-only bundles don't grow.

```ts
import { doc, render } from "@parser-kit/core/print";
const { group, indent, line, softline, join, block, list } = doc;

const call = (name: string, args: doc.Doc[]) =>
  group([name, "(", indent([softline, join([",", line], args)]), softline, ")"]);

render(call("f", ["alpha", "beta"]), { width: 80 });   // "f(alpha, beta)"
render(call("f", ["alpha", "beta"]), { width: 10 });   // "f(\n  alpha,\n  beta\n)"

// Fixed shapes: an indented body, and a settings list that vanishes when empty.
const column = ["id int", list(" [", ["pk", "increment"], "]", { empty: "omit" })];
render(block("Table users", [column]), { width: Infinity, indent: "\t" });
// "Table users {\n\tid int [pk, increment]\n}"
```

A `Doc` is a string, an array of docs (concatenation), or a command:

| Builder | Meaning |
|---|---|
| `group(doc, { shouldBreak? })` | Lay `doc` out flat if it fits in the rest of the line, else break every line directly inside it. Nested groups decide for themselves, outermost first. |
| `indent(doc)` | One more indentation level for the line breaks inside `doc`. |
| `line` / `softline` | A space / nothing when the enclosing group is flat, a newline when it is broken. |
| `hardline` | Always a newline. Every group around it breaks (except from inside the broken branch of an `ifBreak`, which a flat group never prints). |
| `nbsp` | A space that never breaks, for places where a newline would change meaning. |
| `ifBreak(broken, flat?)` | Pick a doc by the enclosing group's mode (trailing commas, optional parentheses). |
| `join(sep, docs)` | `docs` with `sep` between them. |
| `block(header, items, { open?, close? })` | `header {`, one indented item per line, `}`. Prints `header {}` when empty, and no leading space when `header` is empty. |
| `list(open, items, close, { separator?, empty? })` | `[a, b]` flat, one item per line broken. `empty: "omit"` prints nothing for an empty list. |

`render(doc, { width = 80, indent = 2 })` returns the text. `indent` is a number of spaces or a string such as `"\t"`. **`width: Infinity`** lays every group out flat and skips width measurement altogether, which is the fast path for one-line output. Only hard lines, groups that must break (built with `shouldBreak`, or containing a hard line), and lines outside every group still break. As in prettier, a `line` that is not inside any group always breaks, so wrap a doc in `group()` to get it on one line. Text width is its `.length` (an indent string's too, so a tab counts as one column), and a `"\n"` inside a string is written as is, with no indentation after it. Spaces and tabs before each line break the doc makes, and at the end of the output, are dropped. Rendering is iterative, so a deeply nested doc can't overflow the stack.

`list` is a group, so it breaks when it doesn't fit. For a language where newlines carry meaning (DBML settings lists, for instance), render at `width: Infinity`, or concatenate the parts yourself, so only the hard lines you placed break.

### Typed printers: `definePrinter`

`definePrinter<T>()(key, handlers)` builds a printer for one discriminated union `T`, dispatching on the discriminant `key` (`"kind"`, `"type"`, …). The handlers object needs one entry per variant, so leaving one out is a compile error, and each handler gets its node narrowed to that variant. Take `T` from the grammar (`Infer<typeof rule>`, or the AST type you declared for a recursive rule).

```ts
import { definePrinter, extendPrinter, type NodePrinter, type Printable } from "@parser-kit/core/print";

const printExpr: NodePrinter<Printable<Expr>, "kind"> = definePrinter<Printable<Expr>>()("kind", {
  number: (n) => String(n.value),
  binary: (n, print) => [print(n.left), " ", n.op, " ", print(n.right)],
  subquery: (n) => ["(", printQuery(n.query), ")"],
  // omit a kind and tsc fails: Property 'call' is missing
});
const printFrom = definePrinter<Printable<FromItem>>()("kind", {
  table: (n) => n.name,
  subquery: (n) => ["(", printQuery(n.query), ") AS ", n.alias], // same tag, another union
});
```

- **One printer per union.** Discriminant values repeat across unions (an expression and a FROM item can both be `kind: "subquery"`), so each union gets its own printer and the printers call each other. Records with no discriminant are plain functions. Like recursive rules, printers that call each other need one type annotation (`NodePrinter<T, K>`) to break the inference cycle.
- **Recursion goes through `print`.** Each handler gets the printer it runs in as its second argument. Recurse through it rather than the printer's name, so a printer built by `extendPrinter` applies its overrides all the way down.
- **`extendPrinter(base, overrides)`** reuses every handler of `base` and replaces some, e.g. a dialect that prints a few nodes differently. To print a wider union, spread `base.handlers` into a new `definePrinter` call for it and add the new variants; the reused handlers recurse through the wider printer.
- **`Printable<T>`** is `T` with every `span` optional, all the way down, so the printer accepts hand-built trees as well as parsed ones. Printers should never read spans.
- A node whose discriminant has no handler at run time (a hand-built tree with a typo) throws a `TypeError`.

### Parentheses from the Pratt table: `precedence`

`precedence(table, { key, print })` reads binding powers and associativity from the same table `pratt()` parses with, so the printer adds parentheses only where the parser needs them and the two can't drift apart. `key` names a node's entry in the table, `print` prints a child, and `prec.child(parent, child, side)` returns the child's doc, wrapped if needed. Pull the operator groups out of the `pratt()` call so both sides share them:

```ts
export const expressionTable: Omit<PrattDef<Expr, TT>, "atom"> = {
  prefix: [{ ops: ["-", "!"], bp: 14, nodes: ["unary"] }],
  infix: [
    { ops: ["="], bp: 2, assoc: "right", nodes: ["assign"], map: … },
    { ops: ["?"], bp: 3, nodes: ["cond"], rhs: 0, parse: … }, // alternate parsed with parseRhs(0)
    { ops: ["+", "-"], bp: 11, map: … },                       // binary nodes, keyed by op
  ],
  postfix: [{ match: punc("("), bp: 17, nodes: ["call"], rhs: "none", parse: … }],
};
const expression = pratt({ atom, ...expressionTable });

const prec = precedence<Expr>(expressionTable, {
  key: (n) => (n.kind === "binary" ? n.op : n.kind),
  print: (n): Doc => printExpr(n),
  atoms: { arrow: 0 }, // an atom whose body runs on: `x => x + 1`
});
// in printExpr:
binary: (n) => group([prec.child(n, n.left, "left"), " ", n.op, indent([line, prec.child(n, n.right, "right")])]),
call: (n, print) => [prec.child(n, n.callee, "left"), list("(", n.args.map(print), ")")],
```

- **Keys.** An `ops` group without a custom `parse` is keyed by its ops: return the operator from `key` for the nodes it builds, or `{ prefix: op }` for a prefix op (the same op can be both, like `-`). Any group can name its nodes in `nodes` instead. A key the table doesn't name is an atom, never wrapped.
- **Two optional fields on Pratt groups**, `nodes` and `rhs`, are printer metadata; the parser ignores them. `rhs` says where a custom `parse` reads its trailing operand (the bp it passes to `parseRhs`), or `"none"` when the node ends in a token of its own (`)`, `]`, a name). It is derived for `ops` groups without `parse`; a `parse` group without it is treated as open to every operator, which is safe but adds parentheses.
- **Sides.** `"left"` and `"right"` are the operands before and after the operator; `"inner"` is an operand between tokens of the node (a ternary's middle, call arguments) and is never wrapped. A prefix operator's operand is its `"right"`.
- **Conservative where unsure.** A custom-`parse` group without an explicit `assoc` is treated as non-associative, so a chain of it is parenthesised (`(a BETWEEN b AND c) BETWEEN …`). A parent the table doesn't know wraps every operator child. A key two groups build with different binding powers throws when the table is read.
- **Context.** `prec.operand(node, minBp?, context?)` handles operands the grammar parses outside the table, at a given bp (0, the default, is a whole expression). `contexts: { b: restrictedTable }` names cut-down tables for positions the grammar parses with fewer operators; pass the name as the last argument of `child` or `operand`, and nodes that table can't build are wrapped there. `prec.parens(…)` answers the question without printing, and `wrap` replaces the default `["(", doc, ")"]`.

### Quoting: `quoting`

`quoting(rules)` builds a function that prints a name or string bare or quoted. The grammar supplies its lexical rules; the policy decides from the value, so a hand-built tree prints valid text even when its tags are missing or wrong.

```ts
import { quoting } from "@parser-kit/core/print";

const ident = quoting({ quote: '"', start: /[a-z_]/, part: /[a-z0-9_$]/, reserved: RESERVED, fold: "lower" });
ident("users");                             // users
ident("MyCol");                             // "MyCol"   (folding would change it)
ident("select");                            // "select"  (reserved)
ident('say "hi"');                          // "say ""hi"""
ident("users", "always");                   // "users"
ident("users", "preserve-if-valid", true);  // "users"   (the source quoted it)

const str = quoting({ quote: "'", escape: "backslash" }); // no `start`: always quoted
str("it's");                                // 'it\'s'
```

Rules: `quote` and `close` (default: the same), `escape` (`"double"`, the default, doubles the closing quote; `"backslash"` escapes it and backslashes, and nothing else, so pass a function to escape newlines or control characters; both need a one-character `close`), `start` / `part` (regexes for one character; without `start` nothing is bare), `reserved` (a `Set` or array of words, or a predicate, as the lexer reads them after folding) and `fold` (`"lower"` / `"upper"`: a word folding would change must be quoted). Modes: `"minimal"` (default) quotes only when needed, `"always"` quotes everything, `"preserve-if-valid"` keeps a "was quoted" hint and leaves a word bare only when that is valid.

### Finding dropped fields: `@parser-kit/core/print/testing`

Exhaustive handlers prove every variant is printed, not that every field is. `fieldCoverage({ key })` wraps trees so a test can see what the printer read, and reports the variants it never printed and the fields it never read. It is a separate entry point, so it never reaches a printer's bundle.

```ts
import { fieldCoverage } from "@parser-kit/core/print/testing";

const coverage = fieldCoverage({ key: "kind", kinds: ALL_KINDS }); // `kinds` is optional
for (const source of corpus) render(printStmt(coverage.track(parse(source))));
expect(coverage.report()).toEqual({ kinds: [], fields: [] });
// e.g. { kinds: ["window"], fields: ["table.note"] }
```

Fields are reported as `variant.field`; a record without a discriminant is named by where it sits (`select.items.alias`). Only fields of nodes the printer reached count: a subtree it never enters shows up as its parent's unread field. `span` is ignored by default (`ignore` replaces that list). A variant is printed once its discriminant is read; list every variant in `kinds` to also catch ones the corpus never reached.

Limits: only plain objects, arrays and prototype-less objects are tracked (class instances, `Map`s and `Date`s pass through unrecorded). Spreading a node, `Object.values` / `Object.entries` and `JSON.stringify` read every field, so a printer that copies nodes wholesale gets a clean report. The tracked view is not `===` the original tree, so look-ups keyed by the parsed nodes (a `WeakMap` of comments, say) miss on it.

## The example grammars

Two real grammars double as the kit's genericity/integration tests and as the fastest way to learn it — read their `grammar.ts` top to bottom.

- **[`examples/js-lite/`](https://github.com/DemonHa/parser-kit/tree/main/examples/js-lite)** — a JavaScript subset (`const`/`let`, `function`, `if`/`else`, `while`, `return`, blocks, expression statements, full expression precedence, arrays, arrow functions). Exercises what DBML doesn't: root-rule dispatch, newlines as whitespace, the whole `pratt()` table, load-bearing `attempt()` backtracking, and the template-literal *mode*.
- **[`packages/sql/`](https://github.com/DemonHa/parser-kit/tree/main/packages/sql)** — the PostgreSQL 17 grammar published as `@parser-kit/sql` (`postgres.parse`, grammar in [`src/postgres/grammar.ts`](https://github.com/DemonHa/parser-kit/blob/main/packages/sql/src/postgres/grammar.ts)): DDL, DML, queries and psql scripts, with folded identifiers, dollar-quoted and `E'…'` strings, `readers.operator`, a full Pratt operator table with keyword operators, hand-written `custom()` rules and `diagnose()` recovery. The best reference for a folding lexer, keyword tiers and `word()`/`phrase()` keyword matching.

## Design notes & current limits

- **Stringify/printing**: printers are written by hand, not derived from the grammar. The separate, opt-in [`@parser-kit/core/print`](#printing-parser-kitcoreprint) entry provides the building blocks: typed exhaustive dispatch, parentheses from the same Pratt table the parser uses, and quoting from the grammar's lexical rules. The `Rule.print` / `Rule.inverse` hooks, `custom(…, { print })`, the second argument to `map(fn, inverse)` and the `Printer` type are deprecated: nothing ever called them, and they will be removed before 1.0.
- **Tokenization is context-sensitive when you opt in**: readers dispatch on the current character, but [modes, transitions, and `LexContext`](#context-sensitive-lexing-modes--transitions) give the lexer/parser interplay that JS regex-vs-division and template literals need. A mode-free lexer stays a plain context-free tokenizer.
- **`InputStream` ships a string implementation only** — the interface is the contract, but there's no streaming/incremental reader yet.
- **`oneOf` validation** runs at definition time when possible; branches behind `lazy()` forward references are validated on first parse instead.
- Type inference happens at construction (zod's trick) — no deep recursive conditional types. Recursive rules need exactly one explicit `Rule<T, TT>` annotation, same limitation as `z.lazy`.

## Development

This package lives in the [DemonHa/parser-kit](https://github.com/DemonHa/parser-kit) workspace. From the repo root:

```sh
pnpm install
pnpm test          # core unit tests, @parser-kit/sql and js-lite
pnpm types:check
pnpm lint
pnpm build         # tsc → packages/core/build/{esm,cjs}
```

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the change workflow.

### Benchmarks

The parser benchmarks live with the SQL grammar, in [`packages/sql/bench/`](https://github.com/DemonHa/parser-kit/tree/main/packages/sql/bench). [`postgres.bench.ts`](https://github.com/DemonHa/parser-kit/blob/main/packages/sql/bench/postgres.bench.ts) pits `@parser-kit/sql` against [`node-sql-parser`](https://www.npmjs.com/package/node-sql-parser) on a corpus lifted from its tests. Throughput is only compared on statements both parsers accept; a coverage line reports how many of the corpus each handles. [`packages/core/bench/render.bench.ts`](https://github.com/DemonHa/parser-kit/blob/main/packages/core/bench/render.bench.ts) measures `render` on a 1,000-statement doc, at `width: Infinity` and at two finite widths.

```sh
pnpm bench          # run once, print the table
pnpm bench:save     # write bench-baseline.json (the committed baseline)
pnpm bench:compare  # diff the current run against bench-baseline.json
```

`bench-baseline.json` is committed so `bench:compare` shows per-benchmark deltas (`⇑`/`⇓`) as the grammar grows. Re-run `bench:save` to refresh the baseline after an intentional change. Absolute numbers drift with machine load — trust the @parser-kit/sql-vs-node-sql-parser ratio and the compare deltas over raw `hz`.
