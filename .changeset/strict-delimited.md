---
"@parser-kit/core": minor
---

Add the opt-in `strictDelimited` grammar option. By default a `delimited()` list that reaches end of input before its close token ends there as if closed, so `(a, b` at the end of the input parses as a complete list. Grammars that require a terminator after every construct never notice, because the terminator check fails first, but a grammar whose last statement needs no terminator accepts the truncated input. With the option on, the list fails with `Expected <close> but found end of input`. `ParseContext` exposes the setting as the read-only `strictDelimited`. Default behaviour is unchanged.
