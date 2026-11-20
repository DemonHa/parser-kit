---
"@parser-kit/core": patch
---

Deprecate the unused printing hooks: `Rule.print`, `Rule.inverse`, the `print` option of `custom()`, the second (`inverse`) argument to `map()`, and the `Printer` type. Nothing in parser-kit ever called them. Printing will be provided by a forthcoming opt-in `@parser-kit/core/print` entry instead, and these hooks will be removed before 1.0. They still type-check and are still stored on the rule they are passed to, so this release changes no behaviour.
