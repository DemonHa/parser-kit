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
| `packages/sql` | `@parser-kit/sql` — the published SQL parser, one directory per dialect under `src/` (PostgreSQL in `src/postgres/`, exported as the `postgres` object and the `@parser-kit/sql/postgres` subpath), plus its benchmarks, the PostgreSQL coverage battery and the pg_dump corpus |
| `packages/dbml` | `@parser-kit/dbml` — the published DBML parser, one grammar module per construct under `src/grammar/`, plus its corpus, parity goldens, differential test against `@dbml/core` and benchmarks |
| `examples/js-lite` | A JavaScript subset. Not published |

`packages/*` means "things this repo publishes". `@parser-kit/sql`, `@parser-kit/dbml` and the js-lite example import `@parser-kit/core` by name the way you would. Tests and typechecks resolve that specifier to core's **source**, so you never need to build before running them; the grammar packages' own builds resolve it to core's build output, which the root `pnpm build` produces first.

`packages/sql/README.md` has the SQL grammar's own workflow: the coverage battery, the pg_dump corpus and the lists to keep up to date. `packages/dbml/AGENTS.md` has the DBML grammar's: its layout, the `@dbml/core` differential test and the rules for new constructs. `packages/dbml/README.md` lists the differences from `@dbml/core`, and `packages/dbml/test/readme.test.ts` runs its examples, so a change that moves one of them updates the README too.

`packages/core/AGENTS.md` is the internals guide — the module layering and the gotchas that bite when authoring a grammar. Read it before changing `src/`.

## Everyday commands

Run these from the repo root:

```sh
pnpm test          # core unit tests, @parser-kit/sql, @parser-kit/dbml and js-lite
pnpm types:check   # tsc --noEmit across every package
pnpm lint          # biome
pnpm lint:fix
pnpm build         # tsc → packages/{core,sql,dbml}/build/{esm,cjs}
pnpm bench         # @parser-kit/sql vs node-sql-parser, @parser-kit/dbml vs @dbml/core
```

`pre-commit` runs `pnpm lint && pnpm test`, and `commit-msg` runs commitlint.

## Making a change

1. **Branch off `main`.**
2. **Add tests at the level the change lives** — lexer, combinator, pratt, rule, or grammar. If it's user-facing, also exercise it end-to-end in one of the grammars (`packages/sql`, `packages/dbml` or `examples/js-lite`). They are the genericity guard: they're what catches a "generic" feature that quietly assumes DBML or SQL.
3. **Never regenerate a golden or a snapshot to make a change pass.** A diff there means observable parse or error output moved, which is the thing under test. That goes double for the `packages/sql/test/parity.*.golden.json`, `packages/dbml/test/parity.*.golden.json` and `examples/js-lite/parity.*.golden.json` files: they pin every corpus AST (spans and all) and every `diagnose()` message byte-for-byte, so they're what proves a "behaviour-preserving" refactor actually preserved behaviour. When output *is* meant to move, regenerate with `pnpm test -- -u` — the `--` matters, since pnpm eats a bare `-u` and exits 0 without running vitest — and call the diff out in review.
4. **Write a conventional commit.** `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `build:`, `chore:` — commitlint enforces it. Scope by area where it helps: `feat(lexer):`, `fix(pratt):`.
5. **Add a changeset** for anything user-visible:

   ```sh
   pnpm changeset
   ```

   Pick the package (`@parser-kit/core`, `@parser-kit/sql` or `@parser-kit/dbml`), pick a bump, and describe the change the way a release note should read — this text becomes the CHANGELOG entry. Skip it only for changes with no consumer impact (CI, internal docs, tests).

## Versioning

The kit is pre-1.0. The API is still settling while `@database.io/dbml-parser` finishes migrating onto it, so:

- **minor** (`0.x.0`) — new features *and* breaking changes
- **patch** (`0.0.x`) — fixes and docs

Every published package follows these rules. Anything that changes a package's public surface (its `src/index.ts`) is a break, even if it type-checks downstream. Say so in the changeset.

## Benchmarks

`bench-baseline.json` is committed so `pnpm bench:compare` shows per-benchmark deltas as the grammar grows.

```sh
pnpm bench:compare   # diff against the committed baseline
pnpm bench:save      # refresh it after an intentional change
```

Absolute numbers drift with machine load — trust the ratios against the incumbents (node-sql-parser, @dbml/core) and the compare deltas over raw `hz`. Benchmarks don't run in CI.

## Releases

Maintainers only. Merging to `main` with pending changesets makes the Release workflow open a **"chore(release): version packages"** PR that accumulates the version bump and CHANGELOG. Merging *that* PR publishes to npm.

Two constraints worth knowing before touching the release setup:

- **Publishing goes through `pnpm publish`, never `npm publish` or `changeset publish`.** Dependency versions live in the `catalog:` block of `pnpm-workspace.yaml`, and only pnpm rewrites those specifiers into real versions when packing — npm ships the literal string `catalog:`. CI's Package job (`scripts/verify-packages.sh`, which you can run locally after `pnpm build`) fails if a `catalog:` or `workspace:` string reaches a packed manifest, if tests, benches, goldens or fixtures leak into a tarball, if `@dbml/core` or `@dbml/parse` (test and bench dependencies only) reach `@parser-kit/dbml`'s manifest, if a package (or `@parser-kit/sql`'s dialect subpaths) fails to import from ESM, CJS or TypeScript, or if a bundle grows past its size budget.
- **There is no `NPM_TOKEN`.** Releases use npm's [trusted publishing](https://docs.npmjs.com/trusted-publishers) over OIDC: the workflow requests `id-token: write`, and npm exchanges that short-lived token for a package-scoped publish credential. `pnpm publish` has no OIDC support of its own — it packs a tarball and shells out to `npm publish`, and npm performs the exchange. That needs npm >= 11.5.1, newer than what Node 20 bundles, so the workflow enforces a floor. Provenance attestations are generated automatically.

Setting this up on npmjs.com (one-time, per package): **Settings → Trusted Publisher → GitHub Actions**, with repository `DemonHa/parser-kit` and workflow `release.yml`. A package that doesn't exist on npm yet has no settings page, so the workflow can't publish a brand-new package on its own. `@parser-kit/sql` went through this for its first release, and `@parser-kit/dbml` needs it before its first (0.1.0). Before merging the version PR that first releases one, publish that version once by hand from a maintainer machine, on the version PR's branch so the bumped version is what goes out (`pnpm build`, then `pnpm publish --access public` in the package directory: pnpm, so `catalog:` and `workspace:` are rewritten; that one release has no provenance attestation), then add the trusted publisher on npmjs.com as above. If the same version PR also bumps `@parser-kit/core`, the hand-published package depends on a core version that only reaches npm when the workflow publishes it, so it can't be installed until then: merge the version PR right after. Later releases go through the workflow, and `pnpm -r publish` skips the version that is already on the registry. Adding an `NPM_TOKEN` secret would put a static credential back in front of the OIDC exchange — don't.

Two gotchas inherited from this setup:

- The publish must run on a **GitHub-hosted runner**. npm rejects OIDC from self-hosted runners with HTTP 422.
- `changesets/action`'s own `published` output is **always `false`** here. It detects a release by parsing changesets' `New tag:` lines, which only `changeset publish` prints — `pnpm publish` doesn't. Don't gate anything on it; diff `package.json` versions against `HEAD~1` instead.

The tarball is also verified in CI rather than merely built: it must carry `LICENSE`, `README.md`, both module builds, and no test files, and it's installed into a scratch project and imported through both ESM and CJS entry points.
