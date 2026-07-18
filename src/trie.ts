interface TrieOptions {
  [key: string]: [TrieOptions, boolean];
}

export type Trie = [TrieOptions, boolean];

export const createTree = (arr: Iterable<Iterable<string>>): Trie => {
  const res: Trie = [{}, false];

  for (const e of arr) {
    let cur = res;
    for (const char of e) {
      if (!(char in cur[0])) {
        cur[0][char] = [{}, false];
      }
      // guaranteed present: created just above if it was missing
      cur = cur[0][char]!;
    }
    cur[1] = true;
  }
  return res;
};

export const extractTokenByTree = (
  tree: Trie,
  snapshot: () => void,
  reload: () => void,
  extract: () => string,
  skip: () => void,
  join = "",
) => {
  let token = "";
  const tokens: string[] = [];
  let isSnapshotDone = false;

  let current = tree;
  let val = "";

  snapshot();
  while ((val = extract()) in current[0]) {
    // guaranteed present by the `val in current[0]` loop condition
    current = current[0][val]!;

    tokens.push(val);

    if (current[1]) {
      token = tokens.join(join);
      snapshot();
      isSnapshotDone = true;
    }
    skip();
  }
  reload();
  return isSnapshotDone ? token : null;
};
