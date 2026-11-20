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

# verify <package dir> <tarball name prefix> [allowlist regex]
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
    build/esm/index.d.ts build/cjs/index.d.ts build/esm/package.json build/cjs/package.json; do
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
    if [ "$status" -ne 1 ]; then
      echo "::error::$dir: files outside the allowlist in the tarball"
      cat "$WORK/unexpected.txt"
      exit 1
    fi
  fi
}

verify packages/core parser-kit-core
verify packages/sql parser-kit-sql
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
import { sqlLite, sqlLiteScript } from "@parser-kit/sql";
if (!core.defineGrammar) throw new Error("core: ESM export missing");
const [stmt] = sqlLite.parse("SELECT 1 AS one");
if (stmt?.kind !== "select") throw new Error("sql: ESM parse failed");
if (sqlLiteScript.parse("\\connect db\nSELECT 1;\n").length !== 2) throw new Error("sql: ESM script parse failed");
console.log(`ESM ok: core ${Object.keys(core).length} exports, sql parses`);
JS

cat > cjs.cjs <<'JS'
const core = require("@parser-kit/core");
const { sqlLite } = require("@parser-kit/sql");
if (!core.defineGrammar) throw new Error("core: CJS export missing");
const [stmt] = sqlLite.parse("SELECT 1 AS one");
if (stmt?.kind !== "select") throw new Error("sql: CJS parse failed");
try {
  sqlLite.parse("SELECT FROM WHERE");
  throw new Error("sql: CJS parse accepted malformed input");
} catch (e) {
  // sql must share core's ParseError class, not bundle a copy of it.
  if (!(e instanceof core.ParseError)) throw e;
}
console.log(`CJS ok: core ${Object.keys(core).length} exports, sql parses`);
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
# from both an ES module and a CommonJS one.
cat > consumer.mts <<'TS'
import { type ScriptItem, type Stmt, sqlLite } from "@parser-kit/sql";
const stmts: Stmt[] = sqlLite.parse("SELECT 1");
export const items: ScriptItem[] = stmts;
TS
cat > consumer.cts <<'TS'
import sql = require("@parser-kit/sql");
const stmts: sql.Stmt[] = sql.sqlLite.parse("SELECT 1");
export const items: sql.ScriptItem[] = stmts;
TS
"$ROOT/node_modules/.bin/tsc" --noEmit --strict --module nodenext --moduleResolution nodenext \
  consumer.mts consumer.cts
echo "TypeScript ok: @parser-kit/sql types resolve from ESM and CJS (nodenext)"

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
