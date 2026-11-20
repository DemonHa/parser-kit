import { custom, type Infer, ParseError, type Position, type Span, type Token } from "@parser-kit/core";
import { type Ctx, fail, isName, isNewline, isPunc, isWord, quoteOptions, skipNewlines, type TT } from "./common";
import { enumElement } from "./enum";
import { tableGroupElement } from "./group";
import { stickyNoteElement } from "./note";
import { tablePartialElement } from "./partial";
import { projectElement } from "./project";
import { recordsElement } from "./records";
import { registerElementStart, report, skipElement, wasReported } from "./recovery";
import { refElement } from "./ref";
import { tableElement } from "./table";

// The top level: a document is a run of elements, each led by its keyword (any
// case). A new element kind is one line in `ELEMENTS`.

const ELEMENTS = [
  projectElement,
  tableElement,
  refElement,
  enumElement,
  tableGroupElement,
  stickyNoteElement,
  tablePartialElement,
  recordsElement,
] as const;

export type Element = Infer<(typeof ELEMENTS)[number]["rule"]>;

export interface DbmlDocument {
  type: "document";
  elements: Element[];
  span: Span;
}

const EXPECTED_ELEMENT = quoteOptions(ELEMENTS.map((element) => `"${element.display}"`));

// Where `diagnose` may resume after a bad element: an element keyword whose
// line, read ahead, holds a `{` (or, for a short-form `Ref`, a `:`) the way an
// element header does, and, unless it is `Project` or `Ref`, a name right
// after it. That keeps body lines such as `note text`, `Note: '…'`,
// `Note { '…' }` or `records (a) { … }`, met while skipping a table whose `{`
// is missing, from passing for elements.
//
// A later keyword's scan would stop where an earlier one's on the same line
// did, at the same token, so `cache` remembers where and on what: a keyword
// before that place gets the answer without rescanning, and a line of stray
// `} Table t` runs stays linear whatever ends it.
interface ScanCache {
  /** Where the last scan stopped: at a `{`, a `:`, a line break or the end of input, or at a lexer error. */
  until: Position | null;
  stop: "{" | ":" | "end" | "error";
}

const before = (a: Position, b: Position): boolean => a.row < b.row || (a.row === b.row && a.col < b.col);

const startsElement = (ctx: Ctx, token: Token<TT>, cache?: ScanCache): boolean => {
  const element = ELEMENTS.find((candidate) => isWord(token, candidate.keyword));
  if (element === undefined) return false;
  const ref = element.keyword === "ref";
  // A lookahead that runs into a lexer error records it and gives up there,
  // answering yes (the element then reports what follows). The cache keeps
  // that answer too, for later keywords before the error: inside an open `[`
  // a scan crosses lines, and would otherwise rerun to the same place.
  const peekAt = (n: number): Token<TT> | null | ParseError => {
    try {
      return ctx.peekAhead(n);
    } catch (error) {
      if (!(error instanceof ParseError) || !report(ctx, error)) throw error;
      return error;
    }
  };
  if (!ref && element.keyword !== "project") {
    const name = peekAt(1);
    if (name instanceof ParseError) return true;
    if (!isName(name)) return false;
  }
  if (cache?.until != null && before(token.position.start, cache.until)) {
    return cache.stop === "{" || cache.stop === "error" || (cache.stop === ":" && ref);
  }
  // A `:` inside a settings list (`Table t [note: 'x'] {`) doesn't count.
  let depth = 0;
  for (let n = 1; ; n++) {
    const next = peekAt(n);
    const stop = (at: ScanCache["stop"]): boolean => {
      if (cache !== undefined) {
        cache.until =
          next === null
            ? { row: Number.POSITIVE_INFINITY, col: 0 }
            : next instanceof ParseError
              ? next.start
              : next.position.start;
        cache.stop = at;
      }
      return at === "{" || at === "error" || (at === ":" && ref);
    };
    if (next instanceof ParseError) return stop("error");
    if (next === null || isNewline(next)) return stop("end");
    if (isPunc(next, "{")) return stop("{");
    if (isPunc(next, "[") || isPunc(next, "(")) depth++;
    else if (isPunc(next, "]") || isPunc(next, ")")) depth--;
    else if (depth <= 0 && isPunc(next, ":")) return stop(":");
  }
};

registerElementStart(startsElement);

// Elements may share a line (`} Table b {`) and blank lines may separate them.
// The span runs from the first element to the last. Under `diagnose`, a bad
// element is dropped and parsing resumes at the next element keyword that
// starts a line outside any braces (see `recovery.ts`).
export const document = custom<DbmlDocument, TT>(
  (ctx) => {
    const elements: Element[] = [];
    let start: Position | null = null;
    // One for the whole document: the cursor only moves forward.
    const cache: ScanCache = { until: null, stop: "end" };
    for (;;) {
      try {
        skipNewlines(ctx);
        if (ctx.eof()) break;
        start ??= ctx.position();
        const element = ELEMENTS.find((candidate) => isWord(ctx.peek(), candidate.keyword));
        if (element === undefined) fail(ctx, EXPECTED_ELEMENT);
        elements.push(element.rule.parse(ctx));
      } catch (error) {
        // An element that resynchronised past its own `}` has nothing left to skip.
        const resynchronised = wasReported(ctx, error);
        if (!report(ctx, error)) throw error;
        if (!resynchronised) skipElement(ctx, (token) => startsElement(ctx, token, cache));
      }
    }
    const last = elements[elements.length - 1];
    const begin = start ?? ctx.position();
    return { type: "document", elements, span: { start: begin, end: last?.span.end ?? begin } };
  },
  {
    expected: EXPECTED_ELEMENT,
    first: ELEMENTS.map((element) => ({ type: "ident" as const, value: element.keyword })),
  },
);
