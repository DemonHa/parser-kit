# Security Policy

`@parser-kit/core` is a parsing library, so the interesting question is almost always **what happens when it is pointed at input the caller did not write** — a `.sql` file from a user upload, a DBML document pasted into an editor, a snippet in a web request. It parses text and returns a value: it evaluates nothing, reads no files, opens no sockets, and has zero runtime dependencies.

## Reporting a vulnerability

Report privately through GitHub — **[Security → Report a vulnerability](https://github.com/DemonHa/parser-kit/security/advisories/new)** — not through a public issue, a PR, or a discussion.

Useful reports include the grammar (or a trimmed version of it), the input that triggers the behaviour, what you expected, and what happened instead. A failing test against `packages/core` or one of the example grammars is the fastest possible report.

This is a small project with one maintainer. Expect a first response within a week, and a fix or an explicit "this is working as intended, here's why" once the report is confirmed. If a week passes with no reply, feel free to nudge by opening a public issue that says only that a security report is waiting — no details.

Please give a fix a reasonable window before publishing. Reporters are credited in the advisory unless they'd rather not be.

## Supported versions

The kit is pre-1.0 and only the latest published release gets fixes. There are no backport branches.

| Version | Supported |
|---|---|
| latest `0.x` | ✅ |
| anything older | ❌ — upgrade |

## What counts

**In scope** — anything where well-formed use of the public API mishandles untrusted *input*:

- Input that makes the lexer or parser loop forever, or take time or memory superlinear in its length, on a grammar that has no such blowup by construction.
- Catastrophic backtracking in a regex the kit ships itself (the built-in `readers`, the operator table, the internal matchers) — as opposed to one you wrote in your own lexer config.
- A parse that returns a value contradicting the grammar it was given: tokens the grammar rejects reaching the AST, spans pointing outside the source, `diagnose()` reporting success on input `parse()` rejects.
- Anything that escapes the "text in, plain data out" boundary — a code path that reaches `eval`, the filesystem, the network, or prototype pollution via a crafted input string.

**Out of scope:**

- **Your grammar's own semantics.** A grammar that accepts more than you intended, or a `.map()` callback of yours that does something unsafe with a parsed value, is application code. The kit runs your callbacks; it does not police them.
- **Regexes you supply.** `identifier.start`, `identifier.part`, and `CharClass` predicates are tested one character at a time, so they can't backtrack catastrophically — but a `custom()` rule or a hand-written reader that runs your own multi-character regex over the input is yours to bound.
- **Stack depth on deeply nested input.** The parser is recursive descent, so input nested deeply enough (`((((…))))` — order of a thousand levels for a typical expression grammar, depending on the rule chain and the runtime's stack size) throws a `RangeError` rather than returning a `ParseError`. That's a hardening gap, not a memory-safety bug: it's catchable, and it fails closed. Parsing untrusted input? Cap the input length, and catch `RangeError` alongside `ParseError`. A report that makes it happen at *shallow* nesting is in scope and worth filing.
- **Denial of service you asked for.** Grammars can be written to backtrack exponentially — a chain of `attempt()`s over an ambiguous prefix is the usual shape. That's a property of the grammar, not of the engine.
- Vulnerabilities in dev dependencies that don't reach the published package, and anything in `examples/`, which is not published.

## What ships

Releases are published from CI over npm [trusted publishing](https://docs.npmjs.com/trusted-publishers) — there is no long-lived npm token to steal — and carry provenance attestations, so a tarball on npm can be traced back to the workflow run and commit that built it. Verify one with:

```sh
npm audit signatures
```

The published tarball is limited to `build/`, `src/` minus tests, `README.md`, `LICENSE`, and `CHANGELOG.md`. There is no install script, no postinstall step, and no runtime dependency to audit.
