import { describe, expect, it } from "vitest";
import { quoting } from "./index";

// PostgreSQL-style names: bare words fold to lower case, `"` quotes with `""`.
const pgIdent = quoting({
  quote: '"',
  start: /[a-z_]/,
  part: /[a-z0-9_$]/,
  reserved: ["select", "from", "user"],
  fold: "lower",
});

describe("quoting", () => {
  it("quotes only when the value can't be written bare in minimal mode", () => {
    expect(pgIdent("users")).toBe("users");
    expect(pgIdent("_t1$")).toBe("_t1$");
    expect(pgIdent("MyCol")).toBe('"MyCol"');
    expect(pgIdent("1abc")).toBe('"1abc"');
    expect(pgIdent("first name")).toBe('"first name"');
    expect(pgIdent("select")).toBe('"select"');
    expect(pgIdent("")).toBe('""');
  });

  it("escapes the quote by doubling it by default", () => {
    expect(pgIdent('say "hi"')).toBe('"say ""hi"""');
  });

  it("quotes everything in always mode", () => {
    expect(pgIdent("users", "always")).toBe('"users"');
  });

  it("keeps a quoted hint in preserve-if-valid mode, and drops a bare hint that isn't valid", () => {
    expect(pgIdent("users", "preserve-if-valid", true)).toBe('"users"');
    expect(pgIdent("users", "preserve-if-valid", false)).toBe("users");
    expect(pgIdent("users", "preserve-if-valid")).toBe("users");
    expect(pgIdent("a b", "preserve-if-valid", false)).toBe('"a b"');
    expect(pgIdent("user", "preserve-if-valid", false)).toBe('"user"');
  });

  it("checks folding in either direction", () => {
    const upper = quoting({ quote: '"', start: /[A-Z]/, part: /[A-Z0-9]/, fold: "upper" });
    expect(upper("EMP")).toBe("EMP");
    expect(upper("emp")).toBe('"emp"');
  });

  it("takes a reserved-word predicate, distinct close quotes and backslash escapes", () => {
    const tsql = quoting({ quote: "[", close: "]", start: /[a-z]/, reserved: (w) => w.toLowerCase() === "go" });
    expect(tsql("GO")).toBe("[GO]");
    expect(tsql("go")).toBe("[go]");
    expect(tsql("a]b")).toBe("[a]]b]");
    expect(tsql("ok")).toBe("ok");
    const js = quoting({ quote: "'", escape: "backslash" });
    expect(js("it's \\o/")).toBe("'it\\'s \\\\o/'");
  });

  it("anchors start and part rules as a whole, alternations included", () => {
    const q = quoting({ quote: '"', start: /_|[a-z]*/ });
    expect(q("1")).toBe('"1"');
    expect(q("_")).toBe("_");
  });

  it("needs an escape function for a multi-character closing quote", () => {
    expect(() => quoting({ quote: "[[", close: "]]" })).toThrow(/one-character closing quote/);
    expect(() => quoting({ quote: "'''", escape: "backslash" })).toThrow(/one-character closing quote/);
    const triple = quoting({ quote: "'''", escape: (s) => s.replace(/'/g, "\\'") });
    expect(triple("a'")).toBe("'''a\\''''");
  });

  it("quotes every value when no start rule is given, as for string literals", () => {
    const str = quoting({ quote: "'" });
    expect(str("abc")).toBe("'abc'");
    expect(str("it's")).toBe("'it''s'");
  });

  it("takes a custom escape function", () => {
    const tpl = quoting({ quote: "`", escape: (s) => s.replace(/[`$\\]/g, "\\$&") });
    expect(tpl("a`${b}")).toBe("`a\\`\\${b}`");
  });

  it("tests characters by code point, so astral characters count once", () => {
    const uni = quoting({ quote: '"', start: /\p{L}/u, part: /[\p{L}\p{N}]/u });
    expect(uni("𝒳1")).toBe("𝒳1");
    expect(uni("1𝒳")).toBe('"1𝒳"');
  });
});
