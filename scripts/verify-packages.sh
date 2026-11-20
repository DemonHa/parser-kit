#!/usr/bin/env bash
# Packs every published package the way the release does and checks what a
# consumer would get. Run after `pnpm build`; CI's "Package" job runs it.
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

# verify <package dir> <tarball name prefix>
verify() {
  local dir=$1 prefix=$2 tgz
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
}

verify packages/core parser-kit-core
verify packages/sql parser-kit-sql

# core's opt-in ./print entry ships in both formats, with declarations.
tar -tzf "$PACK"/parser-kit-core-*.tgz | sort > "$WORK/core-entries.txt"
for required in build/esm/print/index.js build/cjs/print/index.js build/esm/print/index.d.ts build/cjs/print/index.d.ts; do
  grep -qx "package/$required" "$WORK/core-entries.txt" || { echo "::error::packages/core: missing $required"; exit 1; }
done

# Install both tarballs together, so @parser-kit/sql's core dependency is the
# core packed here rather than the registry copy.
SMOKE="$WORK/smoke"
mkdir -p "$SMOKE"
cd "$SMOKE"
npm init -y >/dev/null
npm install --no-audit --no-fund "$PACK"/*.tgz >/dev/null

cat > esm.mjs <<'JS'
import * as core from "@parser-kit/core";
import { doc, render } from "@parser-kit/core/print";
import { sqlLite, sqlLiteScript } from "@parser-kit/sql";
if (!core.defineGrammar) throw new Error("core: ESM export missing");
if (render(doc.group(["a", doc.line, "b"]), { width: 1 }) !== "a\nb") throw new Error("core/print: ESM render failed");
const [stmt] = sqlLite.parse("SELECT 1 AS one");
if (stmt?.kind !== "select") throw new Error("sql: ESM parse failed");
if (sqlLiteScript.parse("\\connect db\nSELECT 1;\n").length !== 2) throw new Error("sql: ESM script parse failed");
console.log(`ESM ok: core ${Object.keys(core).length} exports, sql parses`);
JS

cat > cjs.cjs <<'JS'
const core = require("@parser-kit/core");
const { doc, render } = require("@parser-kit/core/print");
const { sqlLite } = require("@parser-kit/sql");
if (!core.defineGrammar) throw new Error("core: CJS export missing");
if (render(doc.group(["a", doc.line, "b"]), { width: 1 }) !== "a\nb") throw new Error("core/print: CJS render failed");
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

node esm.mjs
node cjs.cjs

# The declarations, AST types included, must resolve for a TypeScript consumer
# from both an ES module and a CommonJS one.
cat > consumer.mts <<'TS'
import { type Doc, group, line, render } from "@parser-kit/core/print";
import { type ScriptItem, type Stmt, sqlLite } from "@parser-kit/sql";
const stmts: Stmt[] = sqlLite.parse("SELECT 1");
export const items: ScriptItem[] = stmts;
const d: Doc = group(["a", line, "b"]);
export const text: string = render(d, { width: 80, indent: "\t" });
TS
cat > consumer.cts <<'TS'
import sql = require("@parser-kit/sql");
import print = require("@parser-kit/core/print");
const stmts: sql.Stmt[] = sql.sqlLite.parse("SELECT 1");
export const items: sql.ScriptItem[] = stmts;
const d: print.Doc = print.doc.group(["a", print.doc.line, "b"]);
export const text: string = print.render(d, { width: Number.POSITIVE_INFINITY });
TS
"$ROOT/node_modules/.bin/tsc" --noEmit --strict --module nodenext --moduleResolution nodenext \
  consumer.mts consumer.cts
echo "TypeScript ok: @parser-kit/sql and @parser-kit/core/print types resolve from ESM and CJS (nodenext)"

# Size budget for the print entry, measured the way a consumer's bundler sees
# it: bundled from the installed tarball, minified, gzipped.
PRINT_BUDGET=3072
npm install --no-audit --no-fund --no-save esbuild@0.28.2 >/dev/null
echo 'export * from "@parser-kit/core/print";' > print-entry.mjs
PRINT_SIZE=$(npx --no-install esbuild print-entry.mjs --bundle --minify --format=esm --log-level=error | gzip -9 | wc -c)
if [ "$PRINT_SIZE" -gt "$PRINT_BUDGET" ]; then
  echo "::error::@parser-kit/core/print is $PRINT_SIZE bytes min+gz, over the $PRINT_BUDGET byte budget"
  exit 1
fi
echo "Size ok: @parser-kit/core/print is $PRINT_SIZE bytes min+gz (budget $PRINT_BUDGET)"
