// `postgres.format`: text to text. The script is parsed as `parseScript` parses
// it and printed as `stringifyScript` prints it, and its comments are put back
// around the statements. The AST holds no comments; the parse lexers report
// each one they pass over by span (`collectComments`), and this module places
// them by comparing those spans with the items' spans:
//
// - a comment between two items that starts on the row the previous item ends
//   on trails that item, after its `;`, on the same line;
// - any other comment between two items, or before the first, leads the next
//   item (or ends the output), on a line of its own;
// - a comment inside an item's span, which the canonical layout has no safe
//   place for, is moved to just before the item, on a line of its own, in
//   source order. So is a block comment trailing a `COPY … FROM STDIN`, since
//   psql allows only a `--` comment after that `;`.
//
// Comments are copied verbatim (a block comment's CRLFs become LFs), so no
// comment is lost or changed. Every comment ends up outside any statement and
// is followed by a line break, so it can't run into the SQL around it. One blank
// line is kept where the source had at least one between two of these units.
import type { Position, Span } from "@parser-kit/core";
import type { ScriptItem, Stmt } from "../ast";
import { postgresScriptGrammar } from "../grammar";
import { collectComments } from "../lexer";
import { type StringifyScriptOptions, stringify, stringifyScript } from "./index";

/**
 * `format`'s options: `stringifyScript`'s. Every statement ends in `;`, as in
 * a script.
 */
export type FormatOptions = StringifyScriptOptions;

interface Comment {
  start: number;
  end: number;
  row: number;
  endRow: number;
  text: string;
}

/** A run of output lines and the source rows it came from. */
interface Unit {
  text: string;
  row: number;
  endRow: number;
}

/**
 * Formats a PostgreSQL script: parses it as `parseScript` does and prints it
 * as `stringifyScript` does, keeping its comments (see above for where they
 * go). Throws the first `ParseError`. The output ends in a line break unless
 * it is empty.
 */
export const format = (text: string, options?: FormatOptions): string => {
  const { result: items, comments: spans, semicolons } = collectComments(() => postgresScriptGrammar.parse(text));
  const lineStarts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) lineStarts.push(i + 1);
  const offset = (position: Position) => lineStarts[position.row - 1]! + position.col;

  // A comment can be reported twice if a lexer re-reads it; keep each once.
  const byStart = new Map<number, Comment>();
  for (const { start, end } of spans) {
    const from = offset(start);
    const raw = text.slice(from, offset(end));
    byStart.set(from, {
      start: from,
      end: offset(end),
      row: start.row,
      endRow: end.row,
      text: raw.startsWith("--") ? raw.replace(/\r$/, "") : raw.replace(/\r\n/g, "\n"),
    });
  }
  const comments = [...byStart.values()].sort((a, b) => a.start - b.start);

  // The 1-based row of an offset: the number of line starts at or before it.
  const rowOf = (at: number) => {
    let [low, high] = [1, lineStarts.length];
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineStarts[mid - 1]! <= at) low = mid;
      else high = mid - 1;
    }
    return low;
  };
  const commentAt = new Map(comments.map((c) => [c.start, c]));
  // Where an item really starts: a statement's span can begin after its first
  // words (`CREATE`, `WITH …`, `(`), so scan from the end of the item before,
  // past whitespace, `;` and comments.
  const startFrom = (from: number) => {
    let at = from;
    for (;;) {
      const c = commentAt.get(at);
      if (c !== undefined) at = c.end;
      else if (/[\s;]/.test(text[at] ?? "")) at++;
      else return at;
    }
  };

  const units: Unit[] = [];
  let next = 0;
  // The item before, whose trailing comments are being collected.
  let previous: { item: ScriptItem; endRow: number; trailing: Comment[] } | undefined;

  const take = (before: number) => {
    const taken: Comment[] = [];
    while (next < comments.length && comments[next]!.start < before) taken.push(comments[next++]!);
    return taken;
  };
  const between = (before: number) => {
    for (const c of take(before)) {
      if (previous !== undefined && previous.item.kind !== "psqlMeta" && c.row === previous.endRow) {
        previous.trailing.push(c);
      } else {
        units.push({ text: c.text, row: c.row, endRow: c.endRow });
      }
    }
  };

  const pending: { item: ScriptItem; inner: Comment[]; trailing: Comment[]; unit: Unit; endRow: number }[] = [];
  // Where a COPY's rows end in the source: just past the first line after its
  // `;` that is exactly `\.`.
  const rowsEnd = (from: number) => {
    for (let row = rowOf(from) + 1; row <= lineStarts.length; row++) {
      const lineEnd = row < lineStarts.length ? lineStarts[row]! - 1 : text.length;
      const line = text.slice(lineStarts[row - 1], lineEnd);
      if (line === "\\." || line === "\\.\r") return lineEnd;
    }
    return text.length;
  };
  const ends = semicolons.map((semicolon) => offset(semicolon.end)).sort((a, b) => a - b);
  let boundary = 0;
  let nextEnd = 0;
  items.forEach((item, i) => {
    const span = item.span as Span;
    const start = Math.min(startFrom(boundary), offset(span.start));
    between(start);
    const end = offset(span.end);
    const entry = {
      item,
      inner: take(end),
      trailing: [] as Comment[],
      unit: { text: "", row: rowOf(start), endRow: 0 },
      endRow: span.end.row,
    };
    // Trailing comments go by the row the statement ends on.
    previous = { item, endRow: span.end.row, trailing: entry.trailing };
    pending.push(entry);
    units.push(entry.unit);
    // The item ends at its `;`, if one comes before the next item.
    const following = items[i + 1]?.span;
    const limit = following === undefined ? text.length : offset(following.start);
    while (nextEnd < ends.length && ends[nextEnd]! <= end) nextEnd++;
    const semicolon = ends[nextEnd] !== undefined && ends[nextEnd]! <= limit ? ends[nextEnd] : undefined;
    boundary = semicolon ?? end;
    if (item.kind === "copy" && item.data !== undefined) {
      boundary = rowsEnd(boundary);
      entry.endRow = rowOf(boundary);
    }
  });
  between(text.length + 1);

  for (const { item, inner, trailing, unit, endRow } of pending) {
    unit.endRow = endRow;
    if (item.kind === "psqlMeta") {
      unit.text = stringifyScript([item], options);
      continue;
    }
    const statement = stringify(item as Stmt, { ...options, semicolons: "always" });
    const whole = stringifyScript([item], options);
    if (!whole.startsWith(statement)) throw new Error("format: a statement printed differently in a script");
    const copyIn = item.kind === "copy" && whole.length > statement.length;
    // psql allows only a `--` comment after a `COPY … FROM STDIN;`.
    const after = copyIn ? trailing.filter((c) => c.text.startsWith("--")) : trailing;
    inner.push(...trailing.filter((c) => !after.includes(c)));
    for (const c of trailing) unit.endRow = Math.max(unit.endRow, c.endRow);
    const body = statement + after.map((c) => ` ${c.text}`).join("") + whole.slice(statement.length);
    unit.text = [...inner.map((c) => c.text), body].join("\n");
  }

  let out = "";
  units.forEach((unit, i) => {
    if (i > 0) out += unit.row - units[i - 1]!.endRow >= 2 ? "\n\n" : "\n";
    out += unit.text;
  });
  return out === "" ? out : `${out}\n`;
};
