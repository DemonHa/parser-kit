#!/usr/bin/env bash
# Packs every package the way the release does, and checks what a consumer
# would get. Run after `pnpm build`; CI's "Package" job runs it.
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

# core's opt-in ./print entry and its ./print/testing helpers ship in both
# formats, with declarations.
verify packages/core parser-kit-core "" build/esm/print/index.js build/cjs/print/index.js \
  build/esm/print/index.d.ts build/cjs/print/index.d.ts build/esm/print/testing.js build/cjs/print/testing.js \
  build/esm/print/testing.d.ts build/cjs/print/testing.d.ts
# Each SQL dialect is also a subpath export (`@parser-kit/sql/postgres`), with
# a parse-only entry that leaves the printer out (`@parser-kit/sql/postgres/parser`).
verify packages/sql parser-kit-sql "" build/esm/postgres/index.js build/cjs/postgres/index.js \
  build/esm/postgres/index.d.ts build/cjs/postgres/index.d.ts build/esm/postgres/parser.js \
  build/cjs/postgres/parser.js build/esm/postgres/parser.d.ts build/cjs/postgres/parser.d.ts
# @parser-kit/dbml's tarball is held to an allowlist of what consumers need.
verify packages/dbml parser-kit-dbml '^package/(build/|src/|LICENSE$|README\.md$|CHANGELOG\.md$|package\.json$)'
# @dbml/core and @dbml/parse are test and bench baselines, so they may only be
# devDependencies, which npm never installs for a consumer: the runtime
# dependencies are @parser-kit/core alone, and no published file imports them.
# `$WORK/manifest.json` is still dbml's, the last one `verify` extracted.
node -e '
  const m = require(process.argv[1]);
  const fail = (msg) => { console.error(`::error::@parser-kit/dbml: ${msg}`); process.exit(1); };
  if (m.private) fail("the packed manifest is private");
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies", "bundleDependencies", "bundledDependencies"]) {
    const names = Object.keys(m[field] ?? {});
    const allowed = field === "dependencies" ? ["@parser-kit/core"] : [];
    const extra = names.filter((name) => !allowed.includes(name));
    if (extra.length) fail(`unexpected ${field} ${extra}`);
  }
  console.log("Manifest ok: @parser-kit/dbml depends on @parser-kit/core only");
' "$WORK/manifest.json"
mkdir -p "$WORK/dbml"
tar -xzf "$PACK"/parser-kit-dbml-*.tgz -C "$WORK/dbml"
# grep exits 0 on a match, 1 on none and 2 on an error (a missing directory).
status=0
grep -rlE "['\"]@dbml/" "$WORK/dbml/package/build" "$WORK/dbml/package/src" || status=$?
if [ "$status" -ne 1 ]; then
  echo "::error::@parser-kit/dbml: a published file imports @dbml/core or @dbml/parse (or grep failed)"
  exit 1
fi


# Install the tarballs together, so the grammars' core dependency is the core
# packed here rather than the registry copy.
SMOKE="$WORK/smoke"
mkdir -p "$SMOKE"
cd "$SMOKE"
npm init -y >/dev/null
npm install --no-audit --no-fund "$PACK"/*.tgz >/dev/null

cat > esm.mjs <<'JS'
import * as core from "@parser-kit/core";
import { definePrinter, doc, precedence, quoting, render } from "@parser-kit/core/print";
import { fieldCoverage } from "@parser-kit/core/print/testing";
import * as sql from "@parser-kit/sql";
import { postgres } from "@parser-kit/sql/postgres";
import { postgres as parser } from "@parser-kit/sql/postgres/parser";
if (!core.defineGrammar) throw new Error("core: ESM export missing");
if (render(doc.group(["a", doc.line, "b"]), { width: 1 }) !== "a\nb") throw new Error("core/print: ESM render failed");
if (typeof definePrinter !== "function" || typeof precedence !== "function") throw new Error("core/print: ESM export missing");
if (quoting({ quote: '"' })("a") !== '"a"') throw new Error("core/print: ESM quoting failed");
if (fieldCoverage({ key: "kind" }).report().fields.length !== 0) throw new Error("core/print/testing: ESM failed");
if (Object.keys(sql).sort().join() !== "NotPrintableError,postgres") throw new Error(`sql: unexpected ESM exports ${Object.keys(sql)}`);
if (sql.postgres !== postgres) throw new Error("sql: the root and /postgres entries load separate copies");
const [stmt] = postgres.parse("SELECT 1 AS one");
if (stmt?.kind !== "select") throw new Error("sql: ESM parse failed");
if (postgres.parseScript("\\connect db\nSELECT 1;\n").length !== 2) throw new Error("sql: ESM script parse failed");
if (postgres.diagnose("SELECT FROM WHERE").errors.length !== 1) throw new Error("sql: ESM diagnose failed");
if (postgres.stringify(postgres.parse("select a,b from t where x=1")) !== "SELECT a, b FROM t WHERE x = 1;") throw new Error("sql: ESM stringify failed");
if (postgres.stringify(stmt, { width: 1 }) !== "SELECT\n  1 AS one;") throw new Error("sql: ESM pretty stringify failed");
const script = "\\connect db\nCOPY t FROM STDIN;\n1\n\\.\nSELECT 1;";
if (postgres.stringifyScript(postgres.parseScript(script)) !== script) throw new Error("sql: ESM stringifyScript failed");
if (typeof sql.NotPrintableError !== "function") throw new Error("sql: ESM NotPrintableError missing");
if ("stringify" in parser || parser.parse !== postgres.parse) throw new Error("sql: ESM /postgres/parser is not the parse-only object");
console.log(`ESM ok: core ${Object.keys(core).length} exports, sql parses and prints from the root and /postgres, parses from /postgres/parser`);
JS

cat > cjs.cjs <<'JS'
const core = require("@parser-kit/core");
const { definePrinter, doc, precedence, quoting, render } = require("@parser-kit/core/print");
const { fieldCoverage } = require("@parser-kit/core/print/testing");
const sql = require("@parser-kit/sql");
const { postgres } = require("@parser-kit/sql/postgres");
const { postgres: parser } = require("@parser-kit/sql/postgres/parser");
if (!core.defineGrammar) throw new Error("core: CJS export missing");
if (render(doc.group(["a", doc.line, "b"]), { width: 1 }) !== "a\nb") throw new Error("core/print: CJS render failed");
if (typeof definePrinter !== "function" || typeof precedence !== "function") throw new Error("core/print: CJS export missing");
if (quoting({ quote: '"' })("a") !== '"a"') throw new Error("core/print: CJS quoting failed");
if (fieldCoverage({ key: "kind" }).report().fields.length !== 0) throw new Error("core/print/testing: CJS failed");
if (Object.keys(sql).sort().join() !== "NotPrintableError,postgres") throw new Error(`sql: unexpected CJS exports ${Object.keys(sql)}`);
if (sql.postgres !== postgres) throw new Error("sql: the root and /postgres entries load separate copies");
const [stmt] = postgres.parse("SELECT 1 AS one");
if (stmt?.kind !== "select") throw new Error("sql: CJS parse failed");
if (postgres.diagnoseScript("\\connect db\nSELECT 1;\n").ast.length !== 2) throw new Error("sql: CJS script parse failed");
if (postgres.stringify(postgres.parse("select a,b from t where x=1")) !== "SELECT a, b FROM t WHERE x = 1;") throw new Error("sql: CJS stringify failed");
if (postgres.stringify(stmt, { width: 1 }) !== "SELECT\n  1 AS one;") throw new Error("sql: CJS pretty stringify failed");
const script = "\\connect db\nCOPY t FROM STDIN;\n1\n\\.\nSELECT 1;";
if (postgres.stringifyScript(postgres.parseScript(script)) !== script) throw new Error("sql: CJS stringifyScript failed");
if (typeof sql.NotPrintableError !== "function") throw new Error("sql: CJS NotPrintableError missing");
if ("stringify" in parser || parser.parse !== postgres.parse) throw new Error("sql: CJS /postgres/parser is not the parse-only object");
try {
  postgres.parse("SELECT FROM WHERE");
  throw new Error("sql: CJS parse accepted malformed input");
} catch (e) {
  // sql must share core's ParseError class, not bundle a copy of it.
  if (!(e instanceof core.ParseError)) throw e;
}
console.log(`CJS ok: core ${Object.keys(core).length} exports, sql parses and prints from the root and /postgres, parses from /postgres/parser`);
JS

cat > dbml-esm.mjs <<'JS'
import * as core from "@parser-kit/core";
import * as entry from "@parser-kit/dbml";
const { dbml, dbmlLexer } = entry;
if (Object.keys(entry).sort().join() !== "dbml,dbmlLexer") throw new Error(`dbml: unexpected ESM exports ${Object.keys(entry)}`);
const doc = dbml.parse("Table users {\n  id int [pk]\n}\nRef: posts.user_id > users.id\n");
if (doc.elements.map((e) => e.type).join() !== "table,ref") throw new Error("dbml: ESM parse failed");
const { ast, errors } = dbml.diagnose("Table a {\n  id int [pk,]\n}\nTable b {\n  id int\n}\n");
if (errors.length !== 1 || ast.elements.length !== 2) throw new Error("dbml: ESM diagnose failed");
if (dbmlLexer.tokenize(core.createInputStream("// c")).next()?.type !== "comment") throw new Error("dbml: ESM lexer failed");
try {
  dbml.parse("Table");
  throw new Error("dbml: ESM parse accepted malformed input");
} catch (e) {
  if (!(e instanceof core.ParseError)) throw e;
}
console.log("ESM ok: dbml parses, diagnoses and tokenizes");
JS

cat > dbml-cjs.cjs <<'JS'
const core = require("@parser-kit/core");
const { dbml, dbmlLexer } = require("@parser-kit/dbml");
const doc = dbml.parse("Table users {\n  id int [pk]\n}\n");
if (doc.elements[0]?.type !== "table") throw new Error("dbml: CJS parse failed");
if (dbml.diagnose("Table a {\n  id int [pk,]\n}\n").errors.length !== 1) throw new Error("dbml: CJS diagnose failed");
if (typeof dbmlLexer?.tokenize !== "function") throw new Error("dbml: CJS lexer missing");
try {
  dbml.parse("Table");
  throw new Error("dbml: CJS parse accepted malformed input");
} catch (e) {
  // dbml must share core's ParseError class, not bundle a copy of it.
  if (!(e instanceof core.ParseError)) throw e;
}
console.log("CJS ok: dbml parses and diagnoses");
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
const options: pg.StringifyOptions = { width: 80, keywordCase: "lower" };
export const text: string = postgres.stringify(stmts, options) + pg.postgres.stringifyScript(items, { indent: "\t" });
export const isError: boolean = new pg.NotPrintableError("x") instanceof Error;
export const parser: pg.PostgresParser = (await import("@parser-kit/sql/postgres/parser")).postgres;
export { tokens };
TS
cat > consumer.cts <<'TS'
import sql = require("@parser-kit/sql");
import pg = require("@parser-kit/sql/postgres");
const stmts: sql.Postgres.Stmt[] = sql.postgres.parse("SELECT 1");
export const items: pg.ScriptItem[] = [...stmts, ...pg.postgres.diagnoseScript("x").ast];
export const text: string = sql.postgres.stringify(stmts, { semicolons: "never" });
import parser = require("@parser-kit/sql/postgres/parser");
export const parsed: parser.Stmt[] = parser.postgres.parse("SELECT 1");
TS
"$ROOT/node_modules/.bin/tsc" --noEmit --strict --module nodenext --moduleResolution nodenext \
  consumer.mts consumer.cts
echo "TypeScript ok: @parser-kit/sql, /postgres and /postgres/parser types resolve from ESM and CJS (nodenext)"

# TypeScript's legacy `node` resolution ignores `exports`; `typesVersions`
# maps the subpath for it.
cat > legacy.ts <<'TS'
import { type Stmt, type StringifyOptions, postgres } from "@parser-kit/sql/postgres";
import { postgres as parser } from "@parser-kit/sql/postgres/parser";
export const stmts: Stmt[] = parser.parse("SELECT 1");
const options: StringifyOptions = { width: 80 };
export const text: string = postgres.stringify(stmts, options);
TS
"$ROOT/node_modules/.bin/tsc" --noEmit --strict --target es2022 --module commonjs --moduleResolution node --ignoreDeprecations 5.0 \
  legacy.ts
echo "TypeScript ok: @parser-kit/sql/postgres and /postgres/parser types resolve under moduleResolution node"

cat > dbml-consumer.mts <<'TS'
import type { ParseError } from "@parser-kit/core";
import { type DbmlDocument, type DbmlTokenType, dbml, type Element, type Setting } from "@parser-kit/dbml";
const doc: DbmlDocument = dbml.parse("Table t { id int }");
const elements: Element[] = doc.elements;
export const settings: Setting[] = elements.flatMap((e) => (e.type === "table" ? e.settings : []));
export const errors: ParseError[] = dbml.diagnose("x").errors;
export const token: DbmlTokenType = "ident";
TS
cat > dbml-consumer.cts <<'TS'
import pkg = require("@parser-kit/dbml");
const result: { ast: pkg.DbmlDocument; errors: unknown[] } = pkg.dbml.diagnose("Table t { id int }");
export const tables: pkg.Table[] = result.ast.elements.filter((e): e is pkg.Table => e.type === "table");
TS
"$ROOT/node_modules/.bin/tsc" --noEmit --strict --module nodenext --moduleResolution nodenext \
  dbml-consumer.mts dbml-consumer.cts
echo "TypeScript ok: @parser-kit/dbml types resolve from ESM and CJS (nodenext)"

# core's ./print subpath: types from ESM and CJS (nodenext), and under the
# legacy node10 resolution through core's typesVersions map.
cat > print-consumer.mts <<'TS'
import { type Doc, definePrinter, group, line, render } from "@parser-kit/core/print";
import { type FieldCoverage, fieldCoverage } from "@parser-kit/core/print/testing";
const d: Doc = group(["a", line, "b"]);
export const text: string = render(d, { width: 80, indent: "\t" });
type N = { kind: "a" } | { kind: "b"; x: string };
export const p: (n: N) => Doc = definePrinter<N>()("kind", { a: () => "a", b: (n) => n.x });
export const cov: FieldCoverage = fieldCoverage({ key: "kind" });
TS
cat > print-consumer.cts <<'TS'
import print = require("@parser-kit/core/print");
import testing = require("@parser-kit/core/print/testing");
export const cov: testing.FieldCoverage = testing.fieldCoverage({ key: "type" });
const d: print.Doc = print.doc.group(["a", print.doc.line, "b"]);
export const text: string = print.render(d, { width: Number.POSITIVE_INFINITY });
TS
"$ROOT/node_modules/.bin/tsc" --noEmit --strict --module nodenext --moduleResolution nodenext \
  print-consumer.mts print-consumer.cts
cat > print-legacy.ts <<'TS'
import { defineGrammar } from "@parser-kit/core";
import { type Doc, render } from "@parser-kit/core/print";
import { fieldCoverage } from "@parser-kit/core/print/testing";
export const cov: unknown = fieldCoverage;
const d: Doc = ["a", "b"];
export const text: string = render(d);
export const g: unknown = defineGrammar;
TS
"$ROOT/node_modules/.bin/tsc" --noEmit --strict --target es2022 --module commonjs --moduleResolution node --ignoreDeprecations 5.0 \
  print-legacy.ts
echo "TypeScript ok: @parser-kit/core/print and /print/testing types resolve from ESM and CJS (nodenext) and under moduleResolution node"

# Size budget for the print entry, measured the way a consumer's bundler sees
# it: bundled from the installed tarball, minified, gzipped. esbuild comes from
# the workspace (pinned by the lockfile); it resolves the import from this
# directory, so the installed tarball is what gets measured.
PRINT_BUDGET=3072
echo 'export * from "@parser-kit/core/print";' > print-entry.mjs
PRINT_SIZE=$("$ROOT/node_modules/.bin/esbuild" print-entry.mjs --bundle --minify --format=esm --log-level=error | gzip -9 | wc -c)
if [ "$PRINT_SIZE" -gt "$PRINT_BUDGET" ]; then
  echo "::error::@parser-kit/core/print is $PRINT_SIZE bytes min+gz, over the $PRINT_BUDGET byte budget"
  exit 1
fi
echo "Size ok: @parser-kit/core/print is $PRINT_SIZE bytes min+gz (budget $PRINT_BUDGET)"

# Size budgets for the SQL entries, measured the same way. The parse-only
# entry (/postgres/parser) holds the grammar alone; the printer comes with the
# `postgres` object of the root and /postgres entries, since an object's
# methods can't be tree-shaken apart. Its own budget is the difference, and
# it includes @parser-kit/core/print.
size_of() {
  echo "export * from \"$1\";" > size-entry.mjs
  "$ROOT/node_modules/.bin/esbuild" size-entry.mjs --bundle --minify --format=esm --log-level=error | gzip -9 | wc -c
}
check_size() {
  local name=$1 size=$2 budget=$3
  if [ "$size" -gt "$budget" ]; then
    echo "::error::$name is $size bytes min+gz, over the $budget byte budget"
    exit 1
  fi
  echo "Size ok: $name is $size bytes min+gz (budget $budget)"
}
PARSER_SIZE=$(size_of "@parser-kit/sql/postgres/parser")
POSTGRES_SIZE=$(size_of "@parser-kit/sql/postgres")
ROOT_SIZE=$(size_of "@parser-kit/sql")
check_size "@parser-kit/sql/postgres/parser" "$PARSER_SIZE" 58368
check_size "@parser-kit/sql/postgres" "$POSTGRES_SIZE" 86016
check_size "@parser-kit/sql" "$ROOT_SIZE" 86016
check_size "the PostgreSQL printer (/postgres less /postgres/parser)" $((POSTGRES_SIZE - PARSER_SIZE)) 27648
# @parser-kit/dbml's whole entry, @parser-kit/core included (about 13.3 KB at
# its first release).
check_size "@parser-kit/dbml" "$(size_of "@parser-kit/dbml")" 16384
