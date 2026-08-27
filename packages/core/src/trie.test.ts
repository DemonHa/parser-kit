import { describe, expect, it } from "vitest";
import { createInputStream } from "./input-stream";
import { createTree, extractTokenByTree } from "./trie";

const isId = (char: string) => /[a-z_]/i.test(char) || "?!-<>=0123456789".indexOf(char) >= 0;

describe("utils", () => {
  describe("Create tree", () => {
    it("Should create a tree", () => {
      const tree = createTree(["<", ">", "<|>"]);

      expect(tree).toEqual([
        {
          "<": [
            {
              "|": [
                {
                  ">": [{}, true],
                },
                false,
              ],
            },
            true,
          ],
          ">": [{}, true],
        },
        false,
      ]);
    });

    it("Should create a correct tree with the provided strings", () => {
      const tree = createTree(["hello", "he"]);

      expect(tree).toEqual([
        {
          h: [
            {
              e: [
                {
                  l: [
                    {
                      l: [
                        {
                          o: [{}, true],
                        },
                        false,
                      ],
                    },
                    false,
                  ],
                },
                true,
              ],
            },
            false,
          ],
        },
        false,
      ]);
    });

    it("Should create a tree from an array of arrays", () => {
      const tree = createTree([["some"], ["some", "one", "is"]]);

      expect(tree).toEqual([
        {
          some: [
            {
              one: [
                {
                  is: [{}, true],
                },
                false,
              ],
            },
            true,
          ],
        },
        false,
      ]);
    });
  });

  describe("Extract token by tree", () => {
    it("Should correctly parse the longest token", () => {
      const tree = createTree([["hello"], ["hello", "world"]]);
      const input = createInputStream("hello world");

      const token = extractTokenByTree(
        tree,
        input.snapshot,
        input.reload,
        () => {
          let string = "";
          while (!input.eof() && isId(input.peek())) {
            string += input.next();
          }
          return string;
        },
        () => {
          input.next(); // Skip the space character
        },
        " ",
      );

      expect(token).toEqual("hello world");
    });
  });
});
