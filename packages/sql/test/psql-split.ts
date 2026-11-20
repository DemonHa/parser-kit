// A test helper that splits a plain-format pg_dump / pg_dumpall file into
// statements the way psql does when it runs one (psqlscan.l), so each
// statement can be handed to `sqlLite.parse` on its own.
//
// It follows psql's lexer only as far as framing goes:
//
// - `;` ends a statement unless it is inside a string ('…', E'…' with
//   backslash escapes, "…"), a dollar-quoted body ($$…$$, $tag$…$tag$), a
//   comment (-- and nested /* */) or parentheses. Plain strings are read with
//   standard_conforming_strings on, which pg_dump writes for any 9.1+ server
//   left at its default.
// - In CREATE [OR REPLACE] FUNCTION / PROCEDURE, `BEGIN` … `END` (and a CASE
//   inside it) nests too, so a `BEGIN ATOMIC` body stays one statement. This is
//   psql's own heuristic, word for word.
// - A line starting with `\` at a statement boundary is a psql meta-command
//   (`\connect`, `\restrict`, …). It is returned separately, not as a statement.
// - After `COPY … FROM stdin;` the following lines up to `\.` are the inline
//   data block. They are returned separately too. Anything after the `;` on
//   the COPY's own line is dropped (pg_dump never writes any).
//
// Comments and blank lines between statements are dropped; a statement keeps
// the text from its first token to its `;` inclusive (a final statement
// without `;` runs to the end of the input).

export type SplitStatement = {
  sql: string;
  /** 1-based line the statement starts on. */
  line: number;
};

export type CopyBlock = {
  /** 1-based line of the first data row (or of `\.` when there are none). */
  line: number;
  rows: number;
};

export type MetaCommand = {
  line: number;
  text: string;
};

export type SplitResult = {
  statements: SplitStatement[];
  copyBlocks: CopyBlock[];
  metaCommands: MetaCommand[];
};

const isIdentStart = (ch: string) => /[A-Za-z_\u0080-\uffff]/.test(ch);
const isIdentChar = (ch: string) => /[A-Za-z0-9_$\u0080-\uffff]/.test(ch);

const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/y;

// The words psql's routine-body heuristic looks at, keyed by first letter.
const ROUTINE_LEAD_WORDS = new Set(["create", "function", "procedure", "or", "replace"]);

export function splitPsqlScript(text: string): SplitResult {
  const statements: SplitStatement[] = [];
  const copyBlocks: CopyBlock[] = [];
  const metaCommands: MetaCommand[] = [];

  let i = 0;
  let line = 1;
  // Start of the statement being read, or -1 between statements.
  let start = -1;
  let startLine = 0;
  let parenDepth = 0;
  let beginDepth = 0;
  // First letters of the statement's leading words, as psql records them.
  let words: string[] = [];
  // COPY-in is read off the words outside strings, comments and parentheses:
  // a statement led by COPY with `FROM stdin` at the top level.
  let firstWord = "";
  let prevTopWord = "";
  let copyIn = false;

  const advanceTo = (end: number) => {
    for (; i < end; i++) if (text[i] === "\n") line++;
  };
  const lineEnd = (from: number) => {
    const nl = text.indexOf("\n", from);
    return nl === -1 ? text.length : nl;
  };
  const inRoutine = () =>
    words[0] === "c" &&
    (words[1] === "f" ||
      words[1] === "p" ||
      (words[1] === "o" && words[2] === "r" && (words[3] === "f" || words[3] === "p")));

  const finish = (end: number) => {
    const sql = text.slice(start, end);
    statements.push({ sql, line: startLine });
    start = -1;
    parenDepth = 0;
    beginDepth = 0;
    words = [];
    firstWord = prevTopWord = "";
    if (copyIn) readCopyData();
    copyIn = false;
  };

  // psql switches to COPY-in after the statement's line; the data runs to a
  // line that is exactly `\.`.
  const readCopyData = () => {
    advanceTo(lineEnd(i) + 1);
    const block: CopyBlock = { line, rows: 0 };
    while (i < text.length) {
      const end = lineEnd(i);
      const row = text.slice(i, end).replace(/\r$/, "");
      advanceTo(end + 1);
      if (row === "\\.") break;
      block.rows++;
    }
    copyBlocks.push(block);
  };

  while (i < text.length) {
    const ch = text[i]!;
    const next = text[i + 1];

    if (start === -1) {
      if (/\s/.test(ch)) {
        advanceTo(i + 1);
        continue;
      }
      if (ch === "\\") {
        const end = lineEnd(i);
        metaCommands.push({ line, text: text.slice(i, end).replace(/\r$/, "") });
        advanceTo(end);
        continue;
      }
    }

    if (ch === "-" && next === "-") {
      advanceTo(lineEnd(i));
      continue;
    }
    if (ch === "/" && next === "*") {
      let depth = 0;
      let j = i;
      while (j < text.length) {
        if (text.startsWith("/*", j)) {
          depth++;
          j += 2;
        } else if (text.startsWith("*/", j)) {
          depth--;
          j += 2;
          if (depth === 0) break;
        } else j++;
      }
      advanceTo(j);
      continue;
    }

    if (start === -1) {
      start = i;
      startLine = line;
    }

    if (ch === "'") {
      const prev = text[i - 1] ?? "";
      const escapes = /[Ee]/.test(prev) && !isIdentChar(text[i - 2] ?? "");
      let j = i + 1;
      while (j < text.length) {
        if (escapes && text[j] === "\\") j += 2;
        else if (text[j] === "'" && text[j + 1] === "'") j += 2;
        else if (text[j] === "'") break;
        else j++;
      }
      advanceTo(j + 1);
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '"' && text[j + 1] === '"') j += 2;
        else if (text[j] === '"') break;
        else j++;
      }
      advanceTo(j + 1);
      continue;
    }
    // A dollar quote can follow a number or `$1` (`1$$…$$`); one inside an
    // identifier (`a$b$`) never gets here, as the word branch takes it.
    if (ch === "$") {
      DOLLAR_TAG.lastIndex = i;
      const tag = DOLLAR_TAG.exec(text);
      if (tag) {
        const close = text.indexOf(tag[0], i + tag[0].length);
        advanceTo(close === -1 ? text.length : close + tag[0].length);
        continue;
      }
    }
    if (isIdentStart(ch) && !isIdentChar(text[i - 1] ?? "")) {
      let j = i + 1;
      while (j < text.length && isIdentChar(text[j]!)) j++;
      const word = text.slice(i, j).toLowerCase();
      words.push(ROUTINE_LEAD_WORDS.has(word) ? word[0]! : "");
      if (words.length === 1) firstWord = word;
      if (parenDepth === 0) {
        if (firstWord === "copy" && prevTopWord === "from" && word === "stdin") copyIn = true;
        prevTopWord = word;
      }
      if (inRoutine() && parenDepth === 0) {
        if (word === "begin") beginDepth++;
        else if (word === "case" && beginDepth >= 1) beginDepth++;
        else if (word === "end" && beginDepth > 0) beginDepth--;
      }
      advanceTo(j);
      continue;
    }
    if (ch === "(") parenDepth++;
    else if (ch === ")" && parenDepth > 0) parenDepth--;
    else if (ch === ";" && parenDepth === 0 && beginDepth === 0) {
      advanceTo(i + 1);
      finish(i);
      continue;
    }
    advanceTo(i + 1);
  }

  if (start !== -1) {
    const sql = text.slice(start).trimEnd();
    if (sql) statements.push({ sql, line: startLine });
  }
  return { statements, copyBlocks, metaCommands };
}
