# Contributing

Thanks for taking a look. The kit is small and deliberately unmagical — most changes are a new combinator, a new lexer reader, or a fix in how an error reads.

## Setup

Requires Node >= 18 and pnpm (the repo pins its version via `packageManager`, so `corepack enable` is enough).

```sh
pnpm install
pnpm test
```

## Layout

| Path | What it is |
|---|---|
| `packages/core` | `@parser-kit/core` — the published toolkit |
| `examples/js-lite` | A JavaScript subset. Not published |
| `examples/sql-lite` | A PostgreSQL DDL/DML subset, plus the benchmarks. Not published |

`packages/*` means "things this repo publishes"; the examples are workspace packages so they import `@parser-kit/core` by name the way you would. Tests and typechecks resolve that specifier to core's **source**, so you never need to build before running them.

`packages/core/AGENTS.md` is the internals guide — the module layering and the gotchas that bite when authoring a grammar. Read it before changing `src/`.

## Everyday commands

Run these from the repo root:

```sh
pnpm test          # core unit tests + both example grammars (350 tests)
pnpm types:check   # tsc --noEmit across every package
pnpm lint          # biome
pnpm lint:fix
pnpm build         # tsc → packages/core/build/{esm,cjs}
pnpm bench         # sql-lite vs node-sql-parser
```

`pre-commit` runs `pnpm lint && pnpm test`, and `commit-msg` runs commitlint.

## Making a change

1. **Branch off `main`.**
2. **Add tests at the level the change lives** — lexer, combinator, pratt, rule, or grammar. If it's user-facing, also exercise it end-to-end in one of the example grammars. The examples are the genericity guard: they're what catches a "generic" feature that quietly assumes DBML or SQL.
3. **Never regenerate a golden or a snapshot to make a change pass.** A diff there means observable parse or error output moved, which is the thing under test.
4. **Write a conventional commit.** `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `build:`, `chore:` — commitlint enforces it. Scope by area where it helps: `feat(lexer):`, `fix(pratt):`.
5. **Add a changeset** for anything user-visible:

   ```sh
   pnpm changeset
   ```

   Pick `@parser-kit/core`, pick a bump, and describe the change the way a release note should read — this text becomes the CHANGELOG entry. Skip it only for changes with no consumer impact (CI, internal docs, tests).

## Versioning

The kit is pre-1.0. The API is still settling while `@database.io/dbml-parser` finishes migrating onto it, so:

- **minor** (`0.x.0`) — new features *and* breaking changes
- **patch** (`0.0.x`) — fixes and docs

Anything that changes the public surface in `src/index.ts` is a break, even if it type-checks downstream. Say so in the changeset.

## Benchmarks

`bench-baseline.json` is committed so `pnpm bench:compare` shows per-benchmark deltas as the grammar grows.

```sh
pnpm bench:compare   # diff against the committed baseline
pnpm bench:save      # refresh it after an intentional change
```

Absolute numbers drift with machine load — trust the sql-lite-vs-node ratio and the compare deltas over raw `hz`. Benchmarks don't run in CI.

## Releases

Maintainers only. Merging to `main` with pending changesets makes the Release workflow open a **"chore(release): version packages"** PR that accumulates the version bump and CHANGELOG. Merging *that* PR publishes to npm.

Two constraints worth knowing before touching the release setup:

- **Publishing must go through `pnpm publish`, never `npm publish` or `changeset publish`.** Dependency versions live in the `catalog:` block of `pnpm-workspace.yaml`, and only pnpm rewrites those specifiers into real versions when packing. npm ships the literal string `catalog:`, which is why `changeset:publish` calls `pnpm publish -r` and CI fails the build if a `catalog:` string reaches the packed manifest.
- **The tarball is verified in CI**, not just built: it must carry `LICENSE`, `README.md`, both module builds, and no test files, and it's installed into a scratch project and imported through both ESM and CJS entry points.

Provenance attestation is requested via `NPM_CONFIG_PROVENANCE` and `publishConfig.provenance`. It's best-effort — if a publish ever fails on it, drop the setting rather than blocking the release.
