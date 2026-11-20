import { describe, expect, it } from "vitest";
import { postgres } from "../src/postgres/index";
import { stringify } from "../src/postgres/print/index";

// PostgreSQL-only spellings of the dml family's statements: forms this parser
// reads to the same tree either way, so a round trip can't tell them apart,
// pinned as exact output.
const print = (sql: string): string => stringify(postgres.parse(sql)[0]!);

describe("stringify: DML, transaction and session statements", () => {
  it("keeps MERGE_ACTION() bare, where quoted it would name a user function", () => {
    expect(
      print('MERGE INTO t USING s ON true WHEN MATCHED THEN DELETE RETURNING merge_action(), "merge_action"(1)'),
    ).toBe('MERGE INTO t USING s ON TRUE WHEN MATCHED THEN DELETE RETURNING merge_action(), "merge_action"(1);');
  });

  it("quotes a one-part procedure name PostgreSQL's CALL can't take bare", () => {
    const sql = 'CALL "coalesce"(1); CALL "trim"(); CALL s.coalesce(); CALL "left"(); CALL p(VARIADIC a)';
    expect(stringify(postgres.parse(sql))).toBe(
      'CALL "coalesce"(1);\nCALL "trim"();\nCALL s.coalesce();\nCALL "left"();\nCALL p(VARIADIC a);',
    );
  });
});
