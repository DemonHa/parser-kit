// Quoting policy for names and strings. The grammar supplies its lexical rules
// (which words may stand bare, the quote characters, how to escape); the policy
// decides from the value whether to quote, so a hand-built tree prints valid
// text even when its tags are missing or wrong.

/** `minimal`: quote only when needed. `always`: quote everything. `preserve-if-valid`: keep a "was quoted" hint, and leave a word bare only when that is valid. */
export type QuoteMode = "minimal" | "always" | "preserve-if-valid";

export interface QuotingRules {
  /** The opening quote, e.g. `'"'`, `"'"` or `` "`" ``. */
  quote: string;
  /** The closing quote. Default: the same as `quote` (`"]"` for `[name]`). */
  close?: string;
  /**
   * How text inside the quotes is escaped: `"double"` (default) doubles the
   * closing quote, SQL-style; `"backslash"` puts a backslash before it and
   * before every backslash (nothing else: pass a function to escape newlines
   * or control characters); or a function of the raw text. The two built-in
   * styles need a one-character closing quote.
   */
  escape?: "double" | "backslash" | ((text: string) => string);
  /**
   * Matches one character that may start a bare word. Without it nothing is
   * bare and every value is quoted, which suits string literals.
   */
  start?: RegExp;
  /** Matches one character that may continue a bare word. Default: `start`. */
  part?: RegExp;
  /** Words that must be quoted even though they are lexically bare, as the lexer reads them (after folding). */
  reserved?: ReadonlySet<string> | readonly string[] | ((word: string) => boolean);
  /**
   * How the lexer folds bare words. A word that folding would change can only
   * be written quoted: under `"lower"`, `MyCol` must print as `"MyCol"`.
   */
  fold?: "lower" | "upper";
}

/** Prints `value` as a bare word or quoted. `hint` is whether the source quoted it, used by `preserve-if-valid`. */
export type Quote = (value: string, mode?: QuoteMode, hint?: boolean) => string;

const charTest = (re: RegExp) => new RegExp(`^(?:${re.source})$`, re.flags.replace(/[gy]/g, ""));

/**
 * Builds a quoting function from a grammar's lexical rules.
 *
 * ```ts
 * const ident = quoting({ quote: '"', start: /[a-z_]/, part: /[a-z0-9_$]/, reserved: RESERVED, fold: "lower" });
 * ident("users");          // users
 * ident("MyCol");          // "MyCol"
 * ident("select");         // "select"
 * ident("users", "always"); // "users"
 * ```
 */
export const quoting = (rules: QuotingRules): Quote => {
  const open = rules.quote;
  const close = rules.close ?? open;
  const esc = rules.escape ?? "double";
  if (typeof esc !== "function" && close.length !== 1) {
    throw new TypeError("quoting: built-in escapes need a one-character closing quote");
  }
  const encode =
    typeof esc === "function"
      ? esc
      : esc === "double"
        ? (s: string) => s.split(close).join(close + close)
        : (s: string) => s.replace(/\\/g, "\\\\").split(close).join(`\\${close}`);
  const start = rules.start && charTest(rules.start);
  const part = rules.part ? charTest(rules.part) : start;
  const r = rules.reserved;
  const reserved =
    typeof r === "function"
      ? r
      : (
          (set) => (w: string) =>
            set.has(w)
        )(new Set(r));
  const fold =
    rules.fold === "lower"
      ? (s: string) => s.toLowerCase()
      : rules.fold === "upper"
        ? (s: string) => s.toUpperCase()
        : undefined;

  const bare = (s: string): boolean => {
    if (!start || !part || s === "" || (fold && fold(s) !== s) || reserved(s)) return false;
    const chars = Array.from(s);
    return start.test(chars[0]!) && chars.every((ch, i) => i === 0 || part.test(ch));
  };

  return (value, mode = "minimal", hint) =>
    mode === "always" || (mode === "preserve-if-valid" && hint === true) || !bare(value)
      ? open + encode(value) + close
      : value;
};
