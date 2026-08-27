import { describe, expect, it } from "vitest";
import { ParseError } from "./error";
import { createInputStream } from "./input-stream";
import { defineLexer, readers } from "./lexer";
import { type ContextConfig, createParseContext, makeRule } from "./rule";
import type { Token } from "./token";

const lexer = defineLexer({
  punctuation: { type: "punc", tokens: ["(", ")", ","], display: "a symbol" },
  identifier: { type: "var", start: /[a-z_]/i, part: /[a-z0-9_]/i, display: "an identifier" },
  readers: [readers.number("num", { display: "a number" })],
});

type TT = "punc" | "var" | "num";

const contextFor = (text: string, config: ContextConfig<TT> = {}) =>
  createParseContext<TT>(lexer.tokenize(createInputStream(text)), config);

// Consumes two tokens, then fails — exercises rollback and farthest tracking.
const deepFailure = makeRule<null, TT>({
  parse: (ctx) => {
    ctx.next();
    ctx.next();
    return ctx.croak("deep failure");
  },
  first: () => [],
  expected: () => "doom",
});

describe("peekAhead()", () => {
  it("looks ahead without consuming; peekAhead(0) === peek()", () => {
    const ctx = contextFor("a b c");
    expect(ctx.peekAhead(0)).toBe(ctx.peek());
    expect(ctx.peekAhead(1)?.value).toBe("b");
    expect(ctx.peekAhead(2)?.value).toBe("c");
    expect(ctx.peekAhead(3)).toBeNull();
    expect(ctx.next()?.value).toBe("a");
    expect(ctx.next()?.value).toBe("b");
    expect(ctx.next()?.value).toBe("c");
    expect(ctx.eof()).toBe(true);
  });

  it("keeps working after the buffered tokens are drained", () => {
    const ctx = contextFor("a b c d");
    ctx.peekAhead(1);
    ctx.next();
    ctx.next();
    expect(ctx.peekAhead(1)?.value).toBe("d");
    expect(ctx.next()?.value).toBe("c");
    expect(ctx.next()?.value).toBe("d");
  });

  it("buffered lookahead replays identically through tryParse rollback", () => {
    const ctx = contextFor("a b c");
    ctx.peekAhead(2);
    expect(ctx.tryParse(deepFailure)).toBeNull();
    expect(ctx.consumed()).toBe(0);
    expect(ctx.next()?.value).toBe("a");
    expect(ctx.next()?.value).toBe("b");
    expect(ctx.next()?.value).toBe("c");
  });
});

describe("croak() / farthestError()", () => {
  it("stamps consumed on the error and tracks the high-water mark", () => {
    const ctx = contextFor("a b");
    ctx.next();
    let caught: ParseError | null = null;
    try {
      ctx.croak("boom");
    } catch (error) {
      caught = error as ParseError;
    }
    expect(caught?.consumed).toBe(1);
    expect(ctx.farthestError()).toBe(caught);
  });

  it("survives tryParse rollback", () => {
    const ctx = contextFor("a b c");
    expect(ctx.tryParse(deepFailure)).toBeNull();
    expect(ctx.consumed()).toBe(0);
    expect(ctx.farthestError()?.msg).toBe("deep failure");
    expect(ctx.farthestError()?.consumed).toBe(2);
  });

  it("keeps the first error at the farthest depth on ties", () => {
    const ctx = contextFor("a b");
    const croaks: ParseError[] = [];
    for (let i = 0; i < 2; i++) {
      try {
        ctx.croak(`error ${i}`);
      } catch (error) {
        croaks.push(error as ParseError);
      }
    }
    expect(ctx.farthestError()).toBe(croaks[0]);
  });
});

describe("report()", () => {
  const shallowError = (ctx: ReturnType<typeof contextFor>) => {
    try {
      ctx.croak("shallow");
    } catch (error) {
      return error as ParseError;
    }
  };

  it("returns false in strict mode (no collector)", () => {
    const ctx = contextFor("a");
    expect(ctx.report(new ParseError("x", ctx.position(), ctx.position()))).toBe(false);
  });

  it("records the error as-is without preferFarthest", () => {
    const errors: ParseError[] = [];
    const ctx = contextFor("a b c", { errors });
    ctx.tryParse(deepFailure);
    expect(ctx.report(shallowError(ctx))).toBe(true);
    expect(errors[0]!.msg).toBe("shallow");
  });

  it("substitutes the deeper croak with preferFarthest, then clears it", () => {
    const errors: ParseError[] = [];
    const ctx = contextFor("a b c", { errors, preferFarthest: true });
    ctx.tryParse(deepFailure);
    ctx.report(shallowError(ctx));
    expect(errors[0]!.msg).toBe("deep failure");
    expect(ctx.farthestError()).toBeNull();
    // A stale mark must not shadow the next failure: the same shallow error
    // recorded again now stands on its own.
    ctx.report(shallowError(ctx));
    expect(errors[1]!.msg).toBe("shallow");
  });

  it("leaves hand-built errors (no consumed stamp) alone", () => {
    const errors: ParseError[] = [];
    const ctx = contextFor("a b c", { errors, preferFarthest: true });
    ctx.tryParse(deepFailure);
    ctx.report(new ParseError("hand-built", ctx.position(), ctx.position()));
    expect(errors[0]!.msg).toBe("hand-built");
  });
});

describe("newlineBefore()", () => {
  const nlLexer = defineLexer({
    punctuation: { type: "punc", tokens: [";"] },
    identifier: { type: "var", start: /[a-z]/i, part: /[a-z0-9]/i },
    readers: [readers.blockComment("comment", "/*", "*/")],
    whitespace: " \t\n",
  });
  type NlTT = "punc" | "var" | "comment";
  const nlContext = (text: string) =>
    createParseContext<NlTT>(nlLexer.tokenize(createInputStream(text)), { trivia: [{ type: "comment" }] });

  it("is false at the start of input and at EOF", () => {
    const ctx = nlContext("a");
    expect(ctx.newlineBefore()).toBe(false);
    ctx.next();
    expect(ctx.newlineBefore()).toBe(false);
  });

  it("compares rows across the gap", () => {
    const sameLine = nlContext("a b");
    sameLine.next();
    expect(sameLine.newlineBefore()).toBe(false);

    const broken = nlContext("a\nb");
    broken.next();
    expect(broken.newlineBefore()).toBe(true);
  });

  it("counts a line break inside a multi-line comment (ECMAScript ASI)", () => {
    const ctx = nlContext("a /*\n*/ b");
    ctx.next();
    expect(ctx.newlineBefore()).toBe(true);
    // The trivia was skipped as part of the check.
    expect(ctx.peek()?.value).toBe("b");
  });

  it("ignores a same-line comment", () => {
    const ctx = nlContext("a /* c */ b");
    ctx.next();
    expect(ctx.newlineBefore()).toBe(false);
  });

  it("is restored by tryParse rollback", () => {
    const consumeTwoAndFail = makeRule<null, NlTT>({
      parse: (ctx) => {
        ctx.next();
        ctx.next();
        return ctx.croak("doom");
      },
      first: () => [],
      expected: () => "doom",
    });
    const ctx = nlContext("a\nb c");
    ctx.next();
    expect(ctx.tryParse(consumeTwoAndFail)).toBeNull();
    expect(ctx.newlineBefore()).toBe(true);
  });
});

describe("backtracking across a mode change", () => {
  // A template-mode lexer: rollback must replay the exact same token sequence
  // even though the lexer switched modes partway through the buffered run.
  const tmplLexer = defineLexer({
    punctuation: { type: "punc", tokens: ["=", "`"] },
    identifier: { type: "var", start: /[a-z]/i, part: /[a-z0-9]/i },
    modes: {
      template: {
        punctuation: { type: "punc", tokens: ["`", "${"] },
        readers: [readers.templateChunk("chunk")],
        whitespace: "",
      },
    },
    transitions: [
      { on: { type: "punc", value: "`" }, inMode: "default", action: "push", mode: "template" },
      { on: { type: "punc", value: "`" }, inMode: "template", action: "pop" },
    ],
  });
  type TmplTT = "punc" | "var" | "chunk";

  it("replays identical tokens after rollback", () => {
    const text = "x = `ab` y";
    const drain = (ctx: ReturnType<typeof createParseContext<TmplTT>>) => {
      const out = [];
      let token: Token<TmplTT> | null;
      while ((token = ctx.next()) !== null) {
        out.push(token);
      }
      return out;
    };
    const straight = drain(createParseContext<TmplTT>(tmplLexer.tokenize(createInputStream(text))));

    const consumeTwoAndFail = makeRule<null, TmplTT>({
      parse: (ctx) => {
        ctx.next();
        ctx.next();
        return ctx.croak("doom");
      },
      first: () => [],
      expected: () => "doom",
    });
    const ctx = createParseContext<TmplTT>(tmplLexer.tokenize(createInputStream(text)));
    ctx.peekAhead(4); // lex through the mode change before any consumption
    expect(ctx.tryParse(consumeTwoAndFail)).toBeNull();
    expect(drain(ctx)).toEqual(straight);
  });
});
