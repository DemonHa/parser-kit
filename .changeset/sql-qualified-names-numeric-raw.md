---
"@parser-kit/sql": patch
---

Keep qualified-name parts and numeric literal text in the AST. A call's `name`, a type's `name`, a `RANGE` option's `value` and a configuration parameter's name (`SET` / `SHOW` / `RESET`, a routine's `SET`, `ALTER ROLE` / `ALTER DATABASE … SET | RESET`) are now `string[]` with one element per part, so `"a.b"(1)` (`["a.b"]`) and `a.b(1)` (`["a", "b"]`) no longer parse to the same tree. A quoted type name that spells a multi-word type (`"double precision"`) carries `quoted: true`. A number now keeps `raw` whenever its decimal text is anything but the plain integer `String(value)` gives back (`1.0`, `1.50`, `5.`, `1e2`), so its PostgreSQL type (`numeric` vs `integer`) and scale survive; a `0x` / `0o` / `0b` integer below 2^53 still has none. Breaking for code written against the `examples/sql-lite` shapes that reads these fields as strings.
