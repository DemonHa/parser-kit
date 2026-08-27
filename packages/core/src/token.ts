import type { Position, Span } from "./position";

// Same shape dbml-parser's lexer produces today, parameterized over the
// consumer's token vocabulary.
export interface Token<TT extends string = string, V extends string = string> {
  type: TT;
  value: V;
  position: Span;
}

export interface TokenStream<TT extends string = string> {
  next: () => Token<TT> | null;
  peek: () => Token<TT> | null;
  eof: () => boolean;
  croak: (msg: string, start: Position, end: Position) => never;
  position: () => Position;
}

// A token pattern: type plus (optionally) an exact value.
export interface TokenMatch<TT extends string = string> {
  type: TT;
  value?: string;
}

export const matchesToken = <TT extends string>(token: Token<TT> | null, match: TokenMatch<TT>): boolean => {
  return token !== null && token.type === match.type && (match.value === undefined || token.value === match.value);
};
