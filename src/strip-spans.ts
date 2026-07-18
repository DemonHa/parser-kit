// Deep-clones a value while dropping every `span` property. Parse output
// always carries spans; tests and AST diffing use this to compare structure.
export function stripSpans<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripSpans(item)) as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key !== "span") {
        out[key] = stripSpans(entry);
      }
    }
    return out as T;
  }
  return value;
}
