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

- **Publishing goes through `pnpm publish`, never `npm publish` or `changeset publish`.** Dependency versions live in the `catalog:` block of `pnpm-workspace.yaml`, and only pnpm rewrites those specifiers into real versions when packing — npm ships the literal string `catalog:`. CI fails the build if a `catalog:` string reaches the packed manifest.
- **There is no `NPM_TOKEN`.** Releases use npm's [trusted publishing](https://docs.npmjs.com/trusted-publishers) over OIDC: the workflow requests `id-token: write`, and npm exchanges that short-lived token for a package-scoped publish credential. `pnpm publish` has no OIDC support of its own — it packs a tarball and shells out to `npm publish`, and npm performs the exchange. That needs npm >= 11.5.1, newer than what Node 20 bundles, so the workflow enforces a floor. Provenance attestations are generated automatically.

Setting this up on npmjs.com (one-time, per package): **Settings → Trusted Publisher → GitHub Actions**, with repository `DemonHa/parser-kit` and workflow `release.yml`. Adding an `NPM_TOKEN` secret would put a static credential back in front of the OIDC exchange — don't.

Two gotchas inherited from this setup:

- The publish must run on a **GitHub-hosted runner**. npm rejects OIDC from self-hosted runners with HTTP 422.
- `changesets/action`'s own `published` output is **always `false`** here. It detects a release by parsing changesets' `New tag:` lines, which only `changeset publish` prints — `pnpm publish` doesn't. Don't gate anything on it; diff `package.json` versions against `HEAD~1` instead.

The tarball is also verified in CI rather than merely built: it must carry `LICENSE`, `README.md`, both module builds, and no test files, and it's installed into a scratch project and imported through both ESM and CJS entry points.
