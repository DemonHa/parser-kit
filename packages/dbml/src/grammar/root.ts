import { custom, type Infer, ParseError, type Position, type Span } from "@parser-kit/core";
import { fail, isWord, quoteOptions, skipNewlines, type TT } from "./common";
import { enumElement } from "./enum";
import { projectElement } from "./project";
import { refElement } from "./ref";
import { tableElement } from "./table";

// The top level: a document is a run of elements, each led by its keyword (any
// case). A new element kind is one line in `ELEMENTS`.

const ELEMENTS = [projectElement, tableElement, refElement, enumElement] as const;

export type Element = Infer<(typeof ELEMENTS)[number]["rule"]>;

export interface DbmlDocument {
  type: "document";
  elements: Element[];
  span: Span;
}

const EXPECTED_ELEMENT = quoteOptions(ELEMENTS.map((element) => `"${element.display}"`));

// Elements may share a line (`} Table b {`) and blank lines may separate them.
// The span runs from the first element to the last. On an error, `diagnose`
// keeps the elements before it, records it and skips the rest of the input
// (recording any lexer error met while skipping).
export const document = custom<DbmlDocument, TT>(
  (ctx) => {
    const elements: Element[] = [];
    let start: Position | null = null;
    for (;;) {
      try {
        skipNewlines(ctx);
        if (ctx.eof()) break;
        start ??= ctx.position();
        const element = ELEMENTS.find((candidate) => isWord(ctx.peek(), candidate.keyword));
        if (element === undefined) fail(ctx, EXPECTED_ELEMENT);
        elements.push(element.rule.parse(ctx));
      } catch (error) {
        if (!(error instanceof ParseError) || !ctx.recover(error)) throw error;
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
