---
"@parser-kit/core": minor
---

Add typed printers, Pratt-table precedence and quoting to `@parser-kit/core/print`.

- `definePrinter<T>()(key, handlers)` builds a printer for one discriminated union, dispatching on the discriminant you name (`"kind"`, `"type"`, …). Leaving a variant out is a compile error, and each handler gets its node narrowed. Printers compose: each union gets its own, and they call each other, so a discriminant value shared by two unions is handled per union. Handlers recurse through the printer they are given, so `extendPrinter(base, overrides)` builds a variant (a dialect, say) whose overrides apply all the way down. `Printable<T>` makes every `span` optional, so printers accept hand-built trees.
- `precedence(table, { key, print })` derives parenthesisation from the same Pratt table the parser uses: `prec.child(parent, child, side)` wraps a child only when the parser needs it. It reads each group's binding power and associativity, plus two new optional printer-only fields on Pratt groups, `nodes` (the node keys a `match` / `parse` group builds) and `rhs` (the bp a custom `parse` reads its trailing operand at, or `"none"`). The parser ignores both, so existing grammars parse exactly as before. Where it can't tell, it adds parentheses. `prec.operand(node, minBp, context)` covers operands parsed outside the table, and `contexts` names cut-down tables for restricted positions.
- `quoting(rules)` prints names and strings bare or quoted from the grammar's lexical rules (quote characters, escape style, start and part characters, reserved words, case folding), in `"minimal"`, `"always"` or `"preserve-if-valid"` mode. Quoting is decided from the value, so hand-built trees print valid text.
- A new `@parser-kit/core/print/testing` entry exports `fieldCoverage`, a test helper that records which fields a printer reads across a corpus and reports the variants it never printed and the fields it never read.

With these, the `./print` entry is about 2.5 KB minified and gzipped; the testing entry is separate and doesn't count towards it. `PrattPrintMeta` is exported from the root entry.
