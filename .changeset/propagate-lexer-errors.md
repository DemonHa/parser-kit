---
"@parser-kit/core": minor
---

Add the opt-in `errorReporting.propagateLexerErrors` grammar option. Without it, a lexer error raised inside an `attempt()` branch (or any `ctx.tryParse`) rolls back like a failed alternative. The lexer has already consumed the offending characters by then, so the error resurfaces as a misleading parser error on whatever follows, or is silently dropped when the next branch succeeds. With the option on, errors thrown by the token stream are tagged `ParseError.fromLexer` and rethrown by `tryParse` and left alone by `describe()` relabelling, so `parse` and `diagnose` report the real lexer error. Default behaviour is unchanged.
