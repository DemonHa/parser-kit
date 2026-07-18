import { describe, expect, it } from "vitest";
import { ParseError } from "./error";
import { createInputStream } from "./input-stream";

const mockedPosition = { row: 1, col: 0 };

describe("InputStream", () => {
  it("Should throw when asking to throw an error", () => {
    const stream = createInputStream(`Hello World`);

    expect(() => stream.croak("Token not found", mockedPosition, mockedPosition)).toThrow(ParseError);
  });

  it("Should return the correct stream of data", () => {
    const stream = createInputStream(`Hello World`);

    expect([stream.next(), stream.next(), stream.next(), stream.next(), stream.next()].join("")).toBe("Hello");
  });

  it("Should return the correct stream of data when we peak and do not modifies the cursor", () => {
    const stream = createInputStream(`Hello World`);

    stream.next();

    expect(stream.peek()).toBe("e");
    expect(stream.next()).toBe("e");
    expect(stream.position()).toEqual({
      row: 1,
      col: 2,
    });
  });

  it("Should detect when you are at the end of file", () => {
    const stream = createInputStream(`Hello`);

    stream.next();
    expect(stream.eof()).toBe(false);
    stream.next();
    stream.next();
    stream.next();
    expect(stream.eof()).toBe(false);
    stream.next();
    expect(stream.eof()).toBe(true);
  });

  it("Should be able to return the right position", () => {
    const stream = createInputStream(`H\nel`);
    expect(stream.position()).toEqual({
      row: 1,
      col: 0,
    });
    stream.next();
    expect(stream.peek()).toEqual("\n");
    expect(stream.position()).toEqual({
      row: 1,
      col: 1,
    });
    stream.next();
    expect(stream.peek()).toEqual("e");
    expect(stream.position()).toEqual({
      row: 2,
      col: 0,
    });
  });

  it("Should be able take a snapshot and return back to the last snapshot", () => {
    const stream = createInputStream("Hello World");

    stream.next();
    stream.next();
    stream.snapshot();
    stream.next();
    stream.next();
    expect(stream.peek()).toEqual("o");
    stream.reload();
    expect(stream.peek()).toEqual("l");
  });
});
