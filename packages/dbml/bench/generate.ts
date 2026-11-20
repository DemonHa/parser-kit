// Deterministic generator for the large-schema benches: no randomness, so a
// given size always yields the same text and runs stay comparable.
//
// Each "module" is a block of realistic DBML using the constructs a real
// schema file is made of: an enum, tables with typed columns, every common
// column setting, notes in both forms, an `indexes` block, inline and
// top-level refs, a table group and a few records. Every name is unique and
// every ref resolves, so `@dbml/core` accepts the whole file, validator and
// binder included, and the two parsers can be compared on the same input.

const TYPES = ["integer", "bigint", "varchar(255)", "text", "timestamp", "boolean", "decimal(10,2)", "uuid", "jsonb"];

/** One module: an enum, four tables, a group, a long-form ref and a records block (about 100 lines). */
function module(i: number): string {
  const s = `m${i}`;
  const lines: string[] = [];
  lines.push(`// module ${i}`);
  lines.push(`enum ${s}_status {`);
  lines.push(`  active [note: 'In use']`);
  lines.push(`  archived`);
  lines.push(`  "on hold"`);
  lines.push(`}`);
  lines.push("");
  for (let t = 0; t < 4; t++) {
    const table = `${s}_t${t}`;
    const header = t === 0 ? `Table ${table} as ${s.toUpperCase()}_T${t} [headercolor: #3498DB]` : `Table ${table}`;
    lines.push(`${header} {`);
    lines.push(`  id integer [pk, increment]`);
    if (t > 0) lines.push(`  parent_id integer [not null, ref: > ${s}_t${t - 1}.id]`);
    lines.push(`  status ${s}_status [default: 'active']`);
    for (let c = 0; c < 6; c++) {
      const type = TYPES[(i + t + c) % TYPES.length]!;
      const settings =
        c % 3 === 0
          ? ` [not null, note: 'Column ${c} of ${table}']`
          : c % 3 === 1
            ? ` [default: ${c % 2 === 0 ? "`now()`" : String(c * 10)}]`
            : "";
      lines.push(`  col_${c} ${type}${settings}`);
    }
    lines.push(`  created_at timestamp [default: \`now()\`]`);
    lines.push("");
    lines.push(`  indexes {`);
    lines.push(`    (id, created_at) [unique, name: '${table}_id_created']`);
    lines.push(`    col_0 [type: btree]`);
    lines.push(`  }`);
    lines.push("");
    lines.push(`  Note: 'Table ${t} of module ${i}'`);
    lines.push(`}`);
    lines.push("");
  }
  lines.push(`Ref ${s}_link {`);
  lines.push(`  ${s}_t3.col_0 > ${s}_t0.id [delete: cascade]`);
  lines.push(`}`);
  lines.push(`Ref: ${s}_t2.col_1 - ${s}_t1.id`);
  lines.push("");
  lines.push(`TableGroup ${s}_group [note: 'Module ${i}'] {`);
  for (let t = 0; t < 4; t++) lines.push(`  ${s}_t${t}`);
  lines.push(`}`);
  lines.push("");
  lines.push(`records ${s}_t0(id, status, created_at) {`);
  lines.push(`  1, 'active', '2024-01-01'`);
  lines.push(`  2, 'archived', '2024-02-01'`);
  lines.push(`}`);
  lines.push("");
  return lines.join("\n");
}

/** A schema of at least `targetLines` lines, built from whole modules. */
export function generateSchema(targetLines: number): string {
  const parts: string[] = [`Project bench {\n  database_type: 'PostgreSQL'\n  Note: 'Generated benchmark schema'\n}\n`];
  let lines = 4;
  for (let i = 0; lines < targetLines; i++) {
    const m = module(i);
    parts.push(m);
    lines += m.split("\n").length;
  }
  return parts.join("\n");
}

/**
 * The same schema with a syntax error on one line in every `every` tables
 * (an empty setting, a setting with no value, or a stray token), for timing
 * `diagnose` recovery at scale. Every error is local, so recovery resumes on
 * the next line and the rest of the schema is still read. Each kind is also a
 * syntax error for `@dbml/parse`'s parse stage (not just its validator), so
 * both parsers take their error paths.
 */
export function withErrors(schema: string, every: number): string {
  let table = 0;
  return schema
    .split("\n")
    .map((line) => {
      if (!line.startsWith("Table ")) return line;
      table++;
      if (table % every !== 0) return line;
      const kind = (table / every) % 3;
      const bad = kind === 0 ? "  col_x int [pk,, unique]" : kind === 1 ? "  bad_setting int [default: ]" : "  ) stray";
      return `${line}\n${bad}`;
    })
    .join("\n");
}
