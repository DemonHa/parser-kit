import { readdirSync, readFileSync } from "node:fs";
import { createInputStream, type Token } from "@parser-kit/core";
import { postgres } from "../src/postgres/index";
import { collectComments, type SqlTokenType } from "../src/postgres/lexer";

// Shared by `format.test.ts` and the libpg_query differential: comment-heavy
// sources, a way to put comments between every pair of tokens of a corpus
// source, and the comments a script holds, as `format` must keep them.

/** Sources whose comments sit everywhere `format` has to handle. */
export const COMMENT_CASES: string[] = [
  // Leading, trailing, between statements, end of file.
  "-- leading\nSELECT 1; -- trailing\n/* between */\nSELECT 2;\n-- end",
  "/* a */ /* b */ SELECT 1; /* c */ /* d */ -- e\n\n\n-- after a blank run\nSELECT 2",
  // Inside statements: between clauses and list items, and every other gap.
  "SELECT a, -- first\n  b /* second */, c\nFROM t -- the table\nWHERE x = 1 /* cond */\nORDER BY a; -- done",
  "INSERT INTO t (a, /* col */ b) VALUES (1, -- one\n 2) RETURNING *;",
  "UPDATE t SET a = 1, /* x */ b = 2 WHERE c; DELETE FROM t /* all */;",
  "WITH /* cte */ q AS (SELECT 1 -- inner\n) SELECT * FROM q;",
  "CREATE TABLE t (\n  id int PRIMARY KEY, -- the key\n  /* name */ name text NOT NULL\n);",
  // A comment between a prefix operator and its operand, and next to operators.
  "SELECT - /* neg */ 1, - -- line\n -1, @ /* abs */ -2, 1 - /* x */ -1, NOT /* n */ true;",
  "SELECT a--b\n, c/*d*/-e FROM t;",
  // Things that look like comments and aren't.
  "SELECT '--' AS a, '/*' AS b, E'/* \\' --' AS c, $$ -- $$ AS d, $t$ /* x */ $t$ AS e, \"--x\" AS f; -- real",
  "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1 -- inside\n /* body */ $$; -- after",
  "DO $$ BEGIN -- not a comment here\n PERFORM 1; END $$;",
  "SELECT U&'d!0061t!+000061' /* u */ UESCAPE /* v */ '!';",
  // A `--` comment inside a string continuation: one literal.
  "SELECT 'a' -- joins\n  'b' -- and again\n  'c';",
  // Nested block comments, and block comments over several lines.
  "/* outer /* inner */ still outer */ SELECT 1; /* one\n   two\n   three */\nSELECT /* x /* y */ z */ 2;",
  // Line endings: CRLF, and a comment at the very end with no newline.
  "-- crlf\r\nSELECT 1; -- t\r\n/* a\r\n b */\r\nSELECT 2;\r\n-- end",
  "SELECT 1; /* no newline at the end */",
  "SELECT 1 -- no newline at the end",
  // A bare CR ends a `--` comment but isn't a new row: what follows must not join it.
  "SELECT 1; -- a\r/* b */\r-- c\rSELECT 2 -- d\r-- e\r;",
  "COPY t FROM stdin -- a\r-- b\r;\n1\n\\.\n",
  // psql meta-commands and COPY rows.
  "-- dump\n\\connect db\n/* before copy */\nCOPY t (a, b) FROM stdin; -- rows follow\n1\t-- not a comment\n2\t/* nor this */\n\\.\n\n-- after\n\\x\nSELECT 1;",
  "COPY t FROM stdin /* moved */; -- kept\n1\n\\.\n",
  "COPY t FROM stdin\n-- before the semicolon\n;\n1\n\\.\n",
  "SELECT 1; /* a */ \\connect db",
  // A BEGIN ATOMIC routine body with comments inside.
  "CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC -- body\n SELECT 1; /* two */ SELECT 2; END; -- after",
  // Comments only, and nothing.
  "-- only a comment",
  "/* only */ /* comments */\n-- here",
  "",
  "  \n\t\n",
];

/** The pg_dump fixtures, whole. */
export const DUMPS = readdirSync(new URL("./fixtures/pg-dump/", import.meta.url))
  .filter((file) => file.endsWith(".sql"))
  .map((file) => readFileSync(new URL(`./fixtures/pg-dump/${file}`, import.meta.url), "utf8"));

/**
 * The text of every comment in a script, sorted, as `format` keeps it: a block
 * comment's CRLFs as LFs, a line comment without a trailing `\r`.
 */
export const commentTexts = (text: string): string[] => {
  const lines = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) lines.push(i + 1);
  const { comments } = collectComments(() => postgres.parseScript(text));
  const seen = new Map<number, string>();
  for (const { start, end } of comments) {
    const from = lines[start.row - 1]! + start.col;
    const raw = text.slice(from, lines[end.row - 1]! + end.col);
    seen.set(from, raw.startsWith("--") ? raw.replace(/\r+$/, "") : raw.replace(/\r+\n/g, "\n"));
  }
  return [...seen.values()].sort();
};

// Token types whose span starts where the token does. A quoted token's span
// covers its body only, so no comment is put right before one.
const PLAIN: ReadonlySet<SqlTokenType> = new Set(["ident", "number", "op", "punc", "param"]);

/**
 * `sql` with a comment before every token that starts plainly (a name, number,
 * operator, punctuation or parameter), alternating block and line comments.
 * Null when `sql` doesn't lex.
 */
export const withComments = (sql: string): string | null => {
  const tokens: Token<SqlTokenType>[] = [];
  try {
    const stream = postgres.lexer.tokenize(createInputStream(sql));
    for (let token = stream.next(); token !== null; token = stream.next()) tokens.push(token);
  } catch {
    return null;
  }
  const lines = [0];
  for (let i = sql.indexOf("\n"); i !== -1; i = sql.indexOf("\n", i + 1)) lines.push(i + 1);
  let out = "";
  let last = 0;
  tokens.forEach((token, i) => {
    if (i === 0 || !PLAIN.has(token.type)) return;
    const start = lines[token.position.start.row - 1]! + token.position.start.col;
    out += sql.slice(last, start) + (i % 2 === 0 ? ` /* c${i} */ ` : ` -- c${i}\n`);
    last = start;
  });
  return out + sql.slice(last);
};
