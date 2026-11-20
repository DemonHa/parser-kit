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

  it("quotes a reserved word as a utility option's name or value", () => {
    expect(print('EXPLAIN ("select" 1, "all", analyze, analyse, FORMAT "select", x on, y "on") SELECT 1')).toBe(
      'EXPLAIN ("select" 1, "all", ANALYZE, ANALYSE, FORMAT "select", X on, Y on) SELECT 1;',
    );
    expect(print('VACUUM ("select", index_cleanup "null", full, verbose "user") t')).toBe(
      'VACUUM ("select", INDEX_CLEANUP "null", FULL, VERBOSE "user") t;',
    );
    // COPY's option names may be reserved words bare; its values may not.
    expect(print('COPY t FROM STDIN (null "null", default "all", force_not_null ("select", b), force_quote *)')).toBe(
      'COPY t FROM STDIN WITH (NULL "null", DEFAULT "all", FORCE_NOT_NULL ("select", b), FORCE_QUOTE *);',
    );
  });

  it("quotes a word time zone, which PostgreSQL takes as an identifier only", () => {
    const sql =
      'SET TIME ZONE "year"; SET TIME ZONE america; SET TIME ZONE "local"; SET TIME ZONE LOCAL; SET TIME ZONE 7';
    expect(stringify(postgres.parse(sql))).toBe(
      'SET TIME ZONE "year";\nSET TIME ZONE "america";\nSET TIME ZONE "local";\nSET TIME ZONE DEFAULT;\nSET TIME ZONE 7;',
    );
  });

  it("writes CLUSTER's lone VERBOSE as the flag, which predates the option list", () => {
    const sql = "CLUSTER VERBOSE; CLUSTER (VERBOSE); CLUSTER VERBOSE t; CLUSTER (VERBOSE, x 1)";
    expect(stringify(postgres.parse(sql))).toBe(
      "CLUSTER VERBOSE;\nCLUSTER VERBOSE;\nCLUSTER (VERBOSE) t;\nCLUSTER (VERBOSE, X 1);",
    );
  });
});
