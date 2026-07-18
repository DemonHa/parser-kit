import type { Position } from "./position";

// The single error type parser-kit throws. Consumers that need their own
// exception identity (e.g. dbml-parser's CroakException) subclass it, so
// `instanceof` checks keep working on both sides.
export class ParseError extends Error {
  constructor(
    public msg: string,
    public start: Position,
    public end: Position,
  ) {
    super(`${msg} (${start.row}:${start.col})`);
    this.name = "Parse Error";
  }
}
