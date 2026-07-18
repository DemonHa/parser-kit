import { ParseError } from "./error";
import type { Position } from "./position";

// Character-level input contract. v1 ships the string implementation below;
// any other source (bytes, ropes, ...) can implement the same interface.
export interface InputStream {
  next: () => string;
  peek: () => string;
  eof: () => boolean;
  croak: (msg: string, start: Position, end: Position) => never;
  position: () => Position;
  snapshot: () => void;
  reload: () => void;
}

export function createInputStream(input: string): InputStream {
  let [pos, line, col] = [0, 1, 0];

  let snapshots: [number, number, number] = [pos, line, col];

  const next = () => {
    const ch = input.charAt(pos++);

    if (ch === "\n") {
      line++;
      col = 0;
    } else {
      col++;
    }

    return ch;
  };

  const peek = () => {
    return input.charAt(pos);
  };

  const eof = () => {
    return peek() === "";
  };

  const croak = (msg: string, start: Position, end: Position) => {
    throw new ParseError(msg, start, end);
  };

  const position = () => {
    return {
      row: line,
      col,
    };
  };

  const reload = () => {
    [pos, line, col] = snapshots;
  };

  const snapshot = () => {
    snapshots = [pos, line, col];
  };

  return {
    next,
    peek,
    eof,
    croak,
    position,
    snapshot,
    reload,
  };
}
