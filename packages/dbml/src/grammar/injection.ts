import { custom, type Span } from "@parser-kit/core";
import { type Ctx, type Ident, isPunc, readIdent, skipNewlines, type TT } from "./common";

// A table partial injected into a table body, `~name`, kept in source order
// among the table's items. Which partial it names, and how its items merge
// into the table, is not checked here. (It lives apart from `partial.ts`,
// which reads its body through the table-items registry that lists this item.)

export interface PartialInjection {
  type: "partialInjection";
  name: Ident;
  span: Span;
}

export const isPartialInjection = (ctx: Ctx): boolean => isPunc(ctx.peek(), "~");

// As in `@dbml/core`, spaces and even line breaks may follow the `~`.
export const partialInjection = custom<PartialInjection, TT>(
  (ctx) => {
    const start = ctx.position();
    ctx.next();
    skipNewlines(ctx);
    const name = readIdent(ctx, "a table partial name");
    return { type: "partialInjection", name, span: ctx.spanFrom(start) };
  },
  { expected: '"~"', first: [{ type: "punc", value: "~" }] },
);
