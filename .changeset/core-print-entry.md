---
"@parser-kit/core": minor
---

Add `@parser-kit/core/print`, an opt-in entry point for turning ASTs back into text. It provides a Wadler/Leijen-style document IR (strings, arrays for concatenation, `group`, `indent`, `line`, `softline`, `hardline`, `nbsp`, `ifBreak`, `join`, plus `block` for indented brace bodies and `list` for bracketed lists that can disappear when empty) and `render(doc, { width, indent })`, which lays a doc out for a line width. `width: Infinity` keeps every group on one line and skips width measurement, and `indent` takes a number of spaces or a string such as `"\t"`. The renderer is iterative, so deeply nested docs can't overflow the stack. The entry ships as dual ESM/CommonJS with type declarations, weighs about 1.2 KB minified and gzipped, and nothing in the parsing API imports it, so parse-only bundles don't grow.
