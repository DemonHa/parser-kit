import type { ParseError } from "@parser-kit/core";

// Types every dialect object shares (`postgres` now; `mysql` and others later).

/** A recovering parse: the partial AST and every error collected on the way. */
export type Diagnosis<T> = { ast: T; errors: ParseError[] };
