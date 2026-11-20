#!/usr/bin/env bash
# Packs every package the way the release does, private ones in development
# included, and checks what a consumer would get. Run after `pnpm build`; CI's
# "Package" job runs it.
#
# Each tarball must resolve catalog: and workspace: specifiers, ship only what
# consumers need, and import cleanly from ESM, CJS and TypeScript. Only
# `pnpm pack` rewrites those specifiers, so a leak here means the release script
# was switched to npm by mistake.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
PACK="$WORK/pack"
mkdir -p "$PACK"

# verify <package dir> <tarball name prefix> [allowlist regex] [extra required entries...]
# Pass "" as the allowlist to require extra entries without one.
verify() {
  local dir=$1 prefix=$2 allowed=${3:-} tgz
  (cd "$ROOT/$dir" && pnpm pack --pack-destination "$PACK" >/dev/null)
  tgz=$(ls "$PACK/$prefix"-*.tgz)
  echo "== $dir: $(basename "$tgz")"

  # List the entries once, then grep the file. `tar | grep -q` is a trap under
  # pipefail: grep exits on its first match, GNU tar dies writing to the closed
  # pipe, and the pipeline reports the *match* as a failure. The negative checks
  # invert the same way — a leaked test file would short-circuit grep and read
  # as "nothing leaked".
  tar -tzf "$tgz" | sort > "$WORK/entries.txt"
  sed 's/^/   /' "$WORK/entries.txt"
  tar -xzOf "$tgz" package/package.json > "$WORK/manifest.json"

  if grep -qE '"(catalog|workspace):' "$WORK/manifest.json"; then
    echo "::error::catalog:/workspace: specifier leaked into the $dir manifest"
    cat "$WORK/manifest.json"
    exit 1
  fi
  local required
  for required in LICENSE README.md package.json build/esm/index.js build/cjs/index.js \
    build/esm/index.d.ts build/cjs/index.d.ts build/esm/package.json build/cjs/package.json "${@:4}"; do
    grep -qx "package/$required" "$WORK/entries.txt" || { echo "::error::$dir: missing $required"; exit 1; }
  done
  # Tests, benches, goldens and corpus fixtures stay in the repo.
  local leaked='\.(test|bench)\.ts$|\.golden\.json$|/fixtures/|^package/(test|bench)/'
  if grep -qE "$leaked" "$WORK/entries.txt"; then
    echo "::error::$dir: test, bench or fixture files leaked into the tarball"
    grep -E "$leaked" "$WORK/entries.txt"
    exit 1
  fi
  # With an allowlist, every entry must match it. `grep -v` exits 1 when every
  # line matches, 0 when it printed a stray entry and 2 on error.
  if [ -n "$allowed" ]; then
    local status=0
    grep -vE "$allowed" "$WORK/entries.txt" > "$WORK/unexpected.txt" || status=$?
    [ "$status" -ne 2 ] || { echo "::error::$dir: grep failed on the allowlist regex"; exit 1; }
    if [ "$status" -ne 1 ]; then
      echo "::error::$dir: files outside the allowlist in the tarball"
      cat "$WORK/unexpected.txt"
      exit 1
    fi
  fi
}

verify packages/core parser-kit-core
# Each SQL dialect is also a subpath export (`@parser-kit/sql/postgres`).
verify packages/sql parser-kit-sql "" build/esm/postgres/index.js build/cjs/postgres/index.js \
  build/esm/postgres/index.d.ts build/cjs/postgres/index.d.ts
# @parser-kit/dbml is private until its first release, but `pnpm pack` still
# packs it. Its tarball is held to an allowlist of what consumers need.
verify packages/dbml parser-kit-dbml '^package/(build/|src/|LICENSE$|README\.md$|CHANGELOG\.md$|package\.json$)'


# Install the tarballs together, so the grammars' core dependency is the core
# packed here rather than the registry copy.
SMOKE="$WORK/smoke"
mkdir -p "$SMOKE"
cd "$SMOKE"
npm init -y >/dev/null
npm install --no-audit --no-fund "$PACK"/*.tgz >/dev/null

cat > esm.mjs <<'JS'
import * as core from "@parser-kit/core";
import * as sql from "@parser-kit/sql";
import { postgres } from "@parser-kit/sql/postgres";
if (!core.defineGrammar) throw new Error("core: ESM export missing");
if (Object.keys(sql).join() !== "postgres") throw new Error(`sql: unexpected ESM exports ${Object.keys(sql)}`);
if (sql.postgres !== postgres) throw new Error("sql: the root and /postgres entries load separate copies");
const [stmt] = postgres.parse("SELECT 1 AS one");
if (stmt?.kind !== "select") throw new Error("sql: ESM parse failed");
if (postgres.parseScript("\\connect db\nSELECT 1;\n").length !== 2) throw new Error("sql: ESM script parse failed");
if (postgres.diagnose("SELECT FROM WHERE").errors.length !== 1) throw new Error("sql: ESM diagnose failed");
console.log(`ESM ok: core ${Object.keys(core).length} exports, sql parses from the root and /postgres`);
JS

cat > cjs.cjs <<'JS'
const core = require("@parser-kit/core");
const sql = require("@parser-kit/sql");
const { postgres } = require("@parser-kit/sql/postgres");
if (!core.defineGrammar) throw new Error("core: CJS export missing");
if (Object.keys(sql).join() !== "postgres") throw new Error(`sql: unexpected CJS exports ${Object.keys(sql)}`);
if (sql.postgres !== postgres) throw new Error("sql: the root and /postgres entries load separate copies");
const [stmt] = postgres.parse("SELECT 1 AS one");
if (stmt?.kind !== "select") throw new Error("sql: CJS parse failed");
if (postgres.diagnoseScript("\\connect db\nSELECT 1;\n").ast.length !== 2) throw new Error("sql: CJS script parse failed");
try {
  postgres.parse("SELECT FROM WHERE");
  throw new Error("sql: CJS parse accepted malformed input");
} catch (e) {
  // sql must share core's ParseError class, not bundle a copy of it.
  if (!(e instanceof core.ParseError)) throw e;
}
console.log(`CJS ok: core ${Object.keys(core).length} exports, sql parses from the root and /postgres`);
JS

cat > dbml-esm.mjs <<'JS'
import { dbml } from "@parser-kit/dbml";
if (typeof dbml?.parse !== "function" || typeof dbml.diagnose !== "function") throw new Error("dbml: ESM export missing");
console.log("ESM ok: dbml exports parse and diagnose");
JS

cat > dbml-cjs.cjs <<'JS'
const { dbml } = require("@parser-kit/dbml");
if (typeof dbml?.parse !== "function" || typeof dbml.diagnose !== "function") throw new Error("dbml: CJS export missing");
console.log("CJS ok: dbml exports parse and diagnose");
JS

node esm.mjs
node cjs.cjs
node dbml-esm.mjs
node dbml-cjs.cjs

# The declarations, AST types included, must resolve for a TypeScript consumer
# from both an ES module and a CommonJS one, through the root and the subpath.
cat > consumer.mts <<'TS'
import { type Postgres, postgres } from "@parser-kit/sql";
import * as pg from "@parser-kit/sql/postgres";
type ScriptItem = pg.ScriptItem;
const stmts: Postgres.Stmt[] = postgres.parse("SELECT 1");
const items: ScriptItem[] = pg.postgres.parseScript("SELECT 1");
const tokens: pg.PostgresTokenType[] = ["ident"];
export const all: ScriptItem[] = [...stmts, ...items, ...pg.postgres.diagnose("x").ast];
export { tokens };
TS
cat > consumer.cts <<'TS'
import sql = require("@parser-kit/sql");
import pg = require("@parser-kit/sql/postgres");
const stmts: sql.Postgres.Stmt[] = sql.postgres.parse("SELECT 1");
export const items: pg.ScriptItem[] = [...stmts, ...pg.postgres.diagnoseScript("x").ast];
TS
"$ROOT/node_modules/.bin/tsc" --noEmit --strict --module nodenext --moduleResolution nodenext \
  consumer.mts consumer.cts
echo "TypeScript ok: @parser-kit/sql and /postgres types resolve from ESM and CJS (nodenext)"

# TypeScript's legacy `node` resolution ignores `exports`; `typesVersions`
# maps the subpath for it.
cat > legacy.ts <<'TS'
import { type Stmt, postgres } from "@parser-kit/sql/postgres";
export const stmts: Stmt[] = postgres.parse("SELECT 1");
TS
"$ROOT/node_modules/.bin/tsc" --noEmit --strict --target es2022 --module commonjs --moduleResolution node --ignoreDeprecations 5.0 \
  legacy.ts
echo "TypeScript ok: @parser-kit/sql/postgres types resolve under moduleResolution node"

cat > dbml-consumer.mts <<'TS'
import { dbml } from "@parser-kit/dbml";
export const parse: (text: string) => unknown = dbml.parse;
TS
cat > dbml-consumer.cts <<'TS'
import pkg = require("@parser-kit/dbml");
export const diagnose: (text: string) => unknown = pkg.dbml.diagnose;
TS
"$ROOT/node_modules/.bin/tsc" --noEmit --strict --module nodenext --moduleResolution nodenext \
  dbml-consumer.mts dbml-consumer.cts
echo "TypeScript ok: @parser-kit/dbml types resolve from ESM and CJS (nodenext)"
