---
"@parser-kit/core": minor
---

`pratt()` infix and postfix groups accept an optional `when: (ctx, left) => boolean` guard. It runs after the group's operator matched and can decline after peeking: the next matching group of the same kind is tried, a token no postfix group accepts goes on to infix lookup, and if no infix group accepts either, the expression ends as if no operator matched. Use it to keep a catch-all operator group from taking a token another rule owns, or to let a keyword operator bow out when the following word shows it isn't one. The new `PrattGuard` type is exported. Groups without `when` behave exactly as before.
