import type {
  Column,
  DataType,
  DbmlDocument,
  Endpoint,
  Enum,
  IndexEntry,
  Note,
  NumberValue,
  Project,
  QualifiedName,
  RecordField,
  Records,
  Ref,
  Relation,
  Setting,
  StickyNote,
  Table,
  TableGroup,
  TableItem,
  TablePartial,
  Value,
} from "../src/index";

// --- A common shape for a parsed DBML schema ---
//
// The differential test parses each document with this package and with
// `@dbml/core`, maps both results onto the shape below and compares them. The
// shape follows `@dbml/core`'s model, because that model is what consumers of
// DBML (diagram renderers, SQL exporters) are written against:
//
//   - unqualified tables, enums and groups default to the `public` schema;
//   - inline refs (`[ref: > t.c]`) are refs like any other, listed with the
//     document's refs;
//   - table partials are merged into the tables that inject them;
//   - aliases in ref endpoints are resolved to the table they name;
//   - column types are flattened to `@dbml/core`'s `type_name` / `args`
//     strings, defaults to `{ type, value }` with its type names.
//
// What it leaves out, on purpose: anything syntactic that the model doesn't
// keep (spans, quoting, setting order, note forms), and anything the model
// derives by validation rather than parsing (records values coerced to the
// column types, enum members resolved from defaults).
//
// `projectDocument` maps this package's AST onto the shape. It is the part an
// adapter onto a `@dbml/core`-style model would reuse; the `@dbml/core` side
// lives in `core-projection.ts`.

export interface ProjectedDocument {
  /** The `Project` element's fields; all `null` when there is none, as in `@dbml/core`. */
  project: ProjectedProject;
  tables: ProjectedTable[];
  refs: ProjectedRef[];
  enums: ProjectedEnum[];
  tableGroups: ProjectedTableGroup[];
  notes: ProjectedStickyNote[];
  records: ProjectedRecords[];
}

export interface ProjectedProject {
  name: string | null;
  databaseType: string | null;
  note: string | null;
}

/** A custom property (`[owner: 'x']`), keyed by its name in `settings`. */
export interface ProjectedProperty {
  type: "string" | "number" | "bool" | "color";
  value: string | number | boolean;
}

export interface ProjectedTable {
  schema: string;
  name: string;
  alias: string | null;
  note: string | null;
  headerColor: string | null;
  settings: Record<string, ProjectedProperty>;
  columns: ProjectedColumn[];
  indexes: ProjectedIndex[];
  checks: ProjectedCheck[];
}

export interface ProjectedColumn {
  name: string;
  type: { schema: string | null; name: string; args: string | null };
  pk: boolean;
  unique: boolean;
  /** `true` for `not null`, `false` for `null`, `null` when neither is written. */
  notNull: boolean | null;
  increment: boolean;
  default: ProjectedDefault | null;
  note: string | null;
  checks: string[];
  settings: Record<string, ProjectedProperty>;
}

/** `@dbml/core`'s `dbdefault`: `true`, `false` and `null` are `boolean`-typed strings. */
export interface ProjectedDefault {
  type: "string" | "number" | "boolean" | "expression";
  value: string | number;
}

export interface ProjectedIndex {
  columns: { type: "column" | "expression"; value: string; sortOrder: "asc" | "desc" | null }[];
  name: string | null;
  type: string | null;
  unique: boolean;
  pk: boolean;
  note: string | null;
}

export interface ProjectedCheck {
  name: string | null;
  expression: string;
}

/** `1` / `*`, prefixed with `0..` when that side is optional. */
export type Cardinality = "1" | "*" | "0..1" | "0..*";

export interface ProjectedEndpoint {
  schema: string | null;
  table: string;
  columns: string[];
  relation: Cardinality;
}

export interface ProjectedRef {
  name: string | null;
  endpoints: [ProjectedEndpoint, ProjectedEndpoint];
  onDelete: string | null;
  onUpdate: string | null;
  color: string | null;
  inactive: boolean;
  note: string | null;
  settings: Record<string, ProjectedProperty>;
}

export interface ProjectedEnum {
  schema: string;
  name: string;
  values: { name: string; note: string | null }[];
}

export interface ProjectedTableGroup {
  schema: string;
  name: string;
  note: string | null;
  color: string | null;
  settings: Record<string, ProjectedProperty>;
  tables: { schema: string; name: string }[];
}

export interface ProjectedStickyNote {
  /** The last part of the name: `@dbml/core` drops a sticky note's schema. */
  name: string;
  content: string;
  color: string | null;
}

/**
 * A records block, with each field as written. `@dbml/core` coerces values to
 * their column's type, so only the field kinds that survive that unchanged
 * are compared: see `ProjectedField`.
 */
export interface ProjectedRecords {
  schema: string | null;
  table: string;
  columns: string[];
  rows: ProjectedField[][];
}

/**
 * A record field reduced to what `@dbml/core` keeps whatever the column type:
 * strings, booleans and `null` keep their value; a number keeps only that it
 * is a number (core truncates it under an integer column); anything else (an
 * expression, an enum value, an empty field) keeps only that it is there.
 */
export type ProjectedField = string | boolean | null | { number: true } | { other: true };

export const DEFAULT_SCHEMA = "public";

// --- This package's AST → the common shape ---

/** Maps a parsed document onto the common shape. */
export const projectDocument = (doc: DbmlDocument): ProjectedDocument => {
  const of = <T extends DbmlDocument["elements"][number]["type"]>(type: T) =>
    doc.elements.filter(
      (element): element is Extract<DbmlDocument["elements"][number], { type: T }> => element.type === type,
    );

  const enums = of("enum");
  const scope: Scope = { tables: tableResolver(of("table")), enumType: enumTypeBinder(enums) };
  const partials = new Map(of("tablePartial").map((partial) => [partial.name.value, partial]));
  const tables = of("table").map((table) => projectTable(table, partials, scope));
  const project = of("project")[0];

  return {
    project: project ? projectProject(project) : { name: null, databaseType: null, note: null },
    tables: tables.map(({ table }) => table),
    refs: [...tables.flatMap(({ refs }) => refs), ...of("ref").map((ref) => projectRef(ref, scope))],
    enums: enums.map(projectEnum),
    tableGroups: of("tableGroup").map((group) => projectTableGroup(group, scope)),
    notes: of("stickyNote").map(projectSticky),
    records: [...tables.flatMap(({ records }) => records), ...of("records").map((records) => projectRecords(records))]
      // `@dbml/core` drops a records block that lists no columns.
      .filter((records) => records.columns.length > 0),
  };
};

/** Name lookups the projection needs across elements. */
interface Scope {
  /** A ref endpoint's or group member's table, with aliases resolved. */
  tables: (name: QualifiedName) => { schema: string | null; table: string };
  /** Whether a column type names a declared enum, and which. */
  enumType: (type: DataType) => { schema: string | null; name: string } | undefined;
}

// --- Tables and partials ---

/** A table's or a partial's own contents, projected, before any merging. */
interface Body {
  columns: ProjectedColumn[];
  /** Each column's inline refs, keyed by column name. */
  inlineRefs: Map<string, { relation: Relation; target: Endpoint }[]>;
  indexes: ProjectedIndex[];
  checks: ProjectedCheck[];
  note: string | null;
  headerColor: string | null;
}

const projectBody = (items: readonly TableItem[], settings: readonly Setting[], scope: Scope): Body => {
  const columns = items.filter((item): item is Column => item.type === "column");
  const projected = columns.map((column) => projectColumn(column, scope));
  const indexes = items.flatMap((item) => (item.type === "indexes" ? item.entries.map(projectIndex) : []));

  // Several `pk` columns make one composite primary key: `@dbml/core` turns
  // them into a `pk` index after the body's own indexes and clears their flag.
  const pkColumns = projected.filter((column) => column.pk);
  if (pkColumns.length >= 2) {
    indexes.push({
      columns: pkColumns.map((column) => ({ type: "column", value: column.name, sortOrder: null })),
      name: null,
      type: null,
      unique: false,
      pk: true,
      note: null,
    });
    for (const column of pkColumns) column.pk = false;
  }

  // A `Note` item wins over a `note:` setting, and the last `Note` item wins.
  const noteItem = last(items.filter((item): item is Note => item.type === "note"));
  return {
    columns: projected,
    inlineRefs: new Map(
      columns.map((column) => [
        column.name.value,
        column.settings.flatMap((setting) => (setting.kind === "ref" ? [setting] : [])),
      ]),
    ),
    indexes,
    checks: items.flatMap((item) =>
      item.type === "checks"
        ? item.entries.map((entry) => ({
            name: propertyValue(entry.settings, "name"),
            expression: entry.expression.value,
          }))
        : [],
    ),
    note: noteItem?.value.value ?? noteOf(settings),
    headerColor: propertyValue(settings, "headercolor"),
  };
};

/**
 * A table with its partials merged in, as `@dbml/core` merges them:
 *
 *   - a partial's columns take the place of its injection (`~name`);
 *   - a column the table defines itself wins over a partial's column of the
 *     same name, and among partials the last injected wins, replacing the
 *     whole column;
 *   - `note` and `headercolor` follow the same precedence;
 *   - the partials' indexes and checks come first, the last injected first,
 *     followed by the table's own; a partial check's name is prefixed with
 *     the table's name (`t.chk`);
 *   - a partial column's inline refs list the column first and the target
 *     second, with the column's schema defaulted to `public`; a table
 *     column's list the target first, with the schema as written.
 */
const projectTable = (
  table: Table,
  partials: ReadonlyMap<string, TablePartial>,
  scope: Scope,
): { table: ProjectedTable; refs: ProjectedRef[]; records: ProjectedRecords[] } => {
  const own = projectBody(table.items, table.settings, scope);
  const schema = table.name.schema?.value ?? null;
  const name = table.name.name.value;
  const self = (column: string, relation: Cardinality, schemaName = schema): ProjectedEndpoint => ({
    schema: schemaName,
    table: name,
    columns: [column],
    relation,
  });

  // The injections in source order, each with its partial projected.
  const injections = table.items.flatMap((item) => {
    const partial = item.type === "partialInjection" ? partials.get(item.name.value) : undefined;
    return partial ? [{ item, body: projectBody(partial.items, partial.settings, scope) }] : [];
  });
  const lastFirst = [...injections].reverse();

  // Which injection supplies each column name the table doesn't define.
  const taken = new Set(own.columns.map((column) => column.name));
  const supplier = new Map<string, TableItem>();
  for (const { item, body } of lastFirst)
    for (const column of body.columns)
      if (!taken.has(column.name)) {
        taken.add(column.name);
        supplier.set(column.name, item);
      }

  const columns: ProjectedColumn[] = [];
  const refs: ProjectedRef[] = [];
  const ownColumns = new Map(own.columns.map((column) => [column.name, column]));
  for (const item of table.items) {
    if (item.type === "column") {
      const column = ownColumns.get(item.name.value)!;
      columns.push(column);
      for (const ref of own.inlineRefs.get(column.name) ?? []) {
        const [left, right] = cardinalities(ref.relation);
        refs.push(inlineRef([endpoint(ref.target, right, scope), self(column.name, left)]));
      }
    }
    const injected = injections.find((injection) => injection.item === item);
    if (!injected) continue;
    for (const column of injected.body.columns) {
      if (supplier.get(column.name) !== item) continue;
      columns.push(column);
      for (const ref of injected.body.inlineRefs.get(column.name) ?? []) {
        const [left, right] = cardinalities(ref.relation);
        refs.push(inlineRef([self(column.name, left, schema ?? DEFAULT_SCHEMA), endpoint(ref.target, right, scope)]));
      }
    }
  }

  const note = own.note ?? lastFirst.map(({ body }) => body.note).find((value) => value !== null) ?? null;
  const headerColor =
    own.headerColor ?? lastFirst.map(({ body }) => body.headerColor).find((value) => value !== null) ?? null;

  const projected: ProjectedTable = {
    schema: schema ?? DEFAULT_SCHEMA,
    name,
    alias: table.alias?.value ?? null,
    note,
    headerColor,
    settings: customProperties(table.settings, ["headercolor"]),
    columns,
    indexes: [...lastFirst.flatMap(({ body }) => body.indexes), ...own.indexes],
    checks: [
      ...lastFirst.flatMap(({ body }) =>
        body.checks.map((check) => ({ ...check, name: check.name === null ? null : `${name}.${check.name}` })),
      ),
      ...own.checks,
    ],
  };
  const records = table.items
    .filter((item): item is Records => item.type === "records")
    .map((records) => projectRecords(records, { schema, name, columns: columns.map((column) => column.name) }));
  return { table: projected, refs, records };
};

const projectColumn = (column: Column, scope: Scope): ProjectedColumn => {
  const { settings } = column;
  const nullSetting = lastOf(settings, "null");
  const defaultSetting = lastOf(settings, "default");
  return {
    name: column.name.value,
    type: projectType(column.dataType, scope),
    pk: settings.some((setting) => setting.kind === "pk"),
    unique: settings.some((setting) => setting.kind === "unique"),
    notNull: nullSetting ? nullSetting.not : null,
    increment: settings.some((setting) => setting.kind === "increment"),
    default: defaultSetting ? projectDefault(defaultSetting.value) : null,
    note: noteOf(settings),
    checks: settings.flatMap((setting) => (setting.kind === "check" ? [setting.expression.value] : [])),
    settings: customProperties(settings, []),
  };
};

/**
 * `@dbml/core`'s column type. `type_name` is the name as written, unquoted,
 * followed by its arguments joined by `,` and its array suffixes; `args` is
 * the arguments alone, and only when no array suffix follows them. A type
 * naming a declared enum (or its alias) is that enum's bare name with its
 * schema apart; any other schema-qualified type keeps its schema in
 * `type_name` too.
 */
const projectType = (dataType: DataType, scope: Scope): ProjectedColumn["type"] => {
  const args = dataType.args === null ? null : dataType.args.map(typeArg).join(",");
  const suffix = `${args === null ? "" : `(${args})`}${dataType.arraySizes.map((size) => `[${size === null ? "" : numberText(size)}]`).join("")}`;
  const enumType = dataType.arraySizes.length === 0 ? scope.enumType(dataType) : undefined;
  const schema = enumType ? enumType.schema : (dataType.name.schema?.value ?? null);
  const name = enumType ? enumType.name : dataType.name.name.value;
  return {
    schema,
    name: `${schema === null || enumType ? "" : `${schema}.`}${name}${suffix}`,
    args: dataType.arraySizes.length === 0 ? args : null,
  };
};

const typeArg = (value: Value): string => {
  switch (value.kind) {
    case "number":
      return numberText(value);
    case "identifier":
      return value.value.value;
    case "enumConstant":
      return value.path.map((part) => part.value).join(".");
    case "null":
      return "null";
    default:
      return String(value.value);
  }
};

const numberText = (value: NumberValue): string => value.raw ?? String(value.value);

const projectDefault = (value: Value): ProjectedDefault => {
  switch (value.kind) {
    case "string":
    case "color":
      return { type: "string", value: value.value };
    case "number":
      return { type: "number", value: value.value };
    case "boolean":
      return { type: "boolean", value: String(value.value) };
    case "null":
      return { type: "boolean", value: "null" };
    case "expression":
      return { type: "expression", value: value.value };
    case "enumConstant":
      // The model keeps only the member's name.
      return { type: "string", value: value.path[value.path.length - 1]!.value };
    case "identifier":
      return { type: "string", value: value.value.value };
  }
};

const projectIndex = (entry: IndexEntry): ProjectedIndex => ({
  columns: entry.fields
    .flatMap((field) => (field.kind === "composite" ? field.columns : [field]))
    .map((column) => ({
      ...(column.kind === "column"
        ? { type: "column" as const, value: column.name.value }
        : { type: "expression" as const, value: column.expression.value }),
      // The model keeps `desc` only; `asc` is the default.
      sortOrder: column.order === "desc" ? "desc" : null,
    })),
  name: propertyValue(entry.settings, "name"),
  type: propertyValue(entry.settings, "type"),
  unique: entry.settings.some((setting) => setting.kind === "unique"),
  pk: entry.settings.some((setting) => setting.kind === "pk"),
  note: noteOf(entry.settings),
});

// --- Name resolution ---

/**
 * Resolves a ref endpoint's or group member's table: an unqualified name that
 * is some table's alias names that table. The schema stays as written (`null`
 * when unqualified), as in `@dbml/core`'s endpoints.
 */
const tableResolver = (tables: readonly Table[]): Scope["tables"] => {
  const aliases = new Map<string, QualifiedName>();
  for (const table of tables) if (table.alias) aliases.set(table.alias.value, table.name);
  return (name) => {
    const resolved = (name.schema === null ? aliases.get(name.name.value) : undefined) ?? name;
    return { schema: resolved.schema?.value ?? null, table: resolved.name.value };
  };
};

/**
 * Finds the enum a column type names: `status` or `s.status` matching an
 * enum's name in that schema (`public` when unqualified), or an unqualified
 * enum alias. The result has `@dbml/core`'s spelling: the enum's own name,
 * with the schema as the type writes it, or for an alias as the enum writes
 * it (`null` when unqualified).
 */
const enumTypeBinder = (enums: readonly Enum[]): Scope["enumType"] => {
  const key = (schema: string, name: string) => JSON.stringify([schema, name]);
  const names = new Set<string>();
  const aliases = new Map<string, QualifiedName>();
  for (const element of enums) {
    names.add(key(element.name.schema?.value ?? DEFAULT_SCHEMA, element.name.name.value));
    if (element.alias) aliases.set(element.alias.value, element.name);
  }
  return ({ name, args }) => {
    if (args !== null) return undefined;
    if (names.has(key(name.schema?.value ?? DEFAULT_SCHEMA, name.name.value)))
      return { schema: name.schema?.value ?? null, name: name.name.value };
    const target = name.schema === null ? aliases.get(name.name.value) : undefined;
    return target && { schema: target.schema?.value ?? null, name: target.name.value };
  };
};

// --- Refs ---

const cardinalities = (relation: Relation): [Cardinality, Cardinality] => {
  const [left, right]: ["1" | "*", "1" | "*"] =
    relation.op === ">" ? ["*", "1"] : relation.op === "<" ? ["1", "*"] : relation.op === "-" ? ["1", "1"] : ["*", "*"];
  return [relation.leftOptional ? `0..${left}` : left, relation.rightOptional ? `0..${right}` : right];
};

const endpoint = (end: Endpoint, relation: Cardinality, scope: Scope): ProjectedEndpoint => ({
  ...scope.tables(end.table),
  columns: end.columns.map((column) => column.value),
  relation,
});

const inlineRef = (endpoints: [ProjectedEndpoint, ProjectedEndpoint]): ProjectedRef => ({
  name: null,
  endpoints,
  onDelete: null,
  onUpdate: null,
  color: null,
  inactive: false,
  note: null,
  settings: {},
});

const projectRef = (ref: Ref, scope: Scope): ProjectedRef => {
  const [left, right] = cardinalities(ref.relation);
  const { settings } = ref;
  const action = (on: "delete" | "update") =>
    last(settings.filter((setting): setting is SettingOf<"action"> => setting.kind === "action" && setting.on === on))
      ?.action ?? null;
  return {
    name: ref.name?.value ?? null,
    endpoints: [endpoint(ref.left, left, scope), endpoint(ref.right, right, scope)],
    onDelete: action("delete"),
    onUpdate: action("update"),
    color: propertyValue(settings, "color"),
    inactive: settings.some((setting) => setting.kind === "inactive"),
    note: noteOf(settings),
    settings: customProperties(settings, ["color"]),
  };
};

// --- Other elements ---

const projectProject = (project: Project): ProjectedProject => {
  let databaseType: string | null = null;
  let note: string | null = null;
  for (const item of project.items) {
    if (item.type === "note") note = item.value.value;
    else if (item.key.value.toLowerCase() === "database_type") databaseType = item.value.value;
  }
  return { name: project.name?.value ?? null, databaseType, note };
};

const projectEnum = (element: Enum): ProjectedEnum => ({
  schema: element.name.schema?.value ?? DEFAULT_SCHEMA,
  name: element.name.name.value,
  values: element.values.map((value) => ({ name: value.name.value, note: noteOf(value.settings) })),
});

const projectTableGroup = (group: TableGroup, scope: Scope): ProjectedTableGroup => ({
  schema: DEFAULT_SCHEMA,
  name: group.name.value,
  note: last(group.items.filter((item): item is Note => item.type === "note"))?.value.value ?? noteOf(group.settings),
  color: propertyValue(group.settings, "color"),
  settings: customProperties(group.settings, ["color"]),
  tables: group.items.flatMap((item) => {
    if (item.type !== "member") return [];
    const { schema, table } = scope.tables(item);
    return [{ schema: schema ?? DEFAULT_SCHEMA, name: table }];
  }),
});

const projectSticky = (note: StickyNote): ProjectedStickyNote => ({
  name: note.name.name.value,
  content: note.value.value,
  color: propertyValue(note.settings, "color"),
});

/** A records block; one inside a table gets the table's name, and all its columns when it lists none. */
const projectRecords = (
  records: Records,
  owner?: { schema: string | null; name: string; columns: string[] },
): ProjectedRecords => ({
  schema: owner ? owner.schema : (records.table!.schema?.value ?? null),
  table: owner ? owner.name : records.table!.name.value,
  columns: records.columns?.map((column) => column.value) ?? owner?.columns ?? [],
  rows: records.rows.map((row) => row.fields.map(projectField)),
});

const projectField = (field: RecordField): ProjectedField => {
  switch (field.kind) {
    case "string":
    case "boolean":
      return field.value;
    case "null":
    case "empty":
      return null;
    case "number":
      return { number: true };
    default:
      return { other: true };
  }
};

// --- Settings ---

const last = <T>(items: readonly T[]): T | undefined => items[items.length - 1];

type SettingOf<K extends Setting["kind"]> = Extract<Setting, { kind: K }>;

const lastOf = <K extends Setting["kind"]>(settings: readonly Setting[], kind: K): SettingOf<K> | undefined =>
  last(settings.filter((setting): setting is SettingOf<K> => setting.kind === kind));

const noteOf = (settings: readonly Setting[]): string | null =>
  settings.find((setting): setting is SettingOf<"note"> => setting.kind === "note")?.value.value ?? null;

/** The value of the first known `key: value` property with this (lowercase) key, as text. */
const propertyValue = (settings: readonly Setting[], key: string): string | null => {
  const setting = settings.find((s) => s.kind === "property" && s.key.value === key);
  if (setting?.kind !== "property") return null;
  const { value } = setting;
  return value.kind === "identifier" ? value.value.value : "value" in value ? String(value.value) : null;
};

/**
 * The custom properties among `settings`, keyed by name in lowercase (as
 * `@dbml/core` keys them; the AST keeps the case as written). `known` lists
 * the property keys that aren't custom.
 */
const customProperties = (
  settings: readonly Setting[],
  known: readonly string[],
): Record<string, ProjectedProperty> => {
  const result: Record<string, ProjectedProperty> = {};
  for (const setting of settings)
    if (setting.kind === "property" && !known.includes(setting.key.value))
      result[setting.key.value.toLowerCase()] = propertyOf(setting.value);
  return result;
};

const propertyOf = (value: Value): ProjectedProperty => {
  switch (value.kind) {
    case "number":
      return { type: "number", value: value.value };
    case "boolean":
      return { type: "bool", value: value.value };
    case "color":
      return { type: "color", value: value.value };
    case "identifier":
      // `none`, which `@dbml/core` files as a color.
      return { type: "color", value: value.value.value };
    default:
      return { type: "string", value: "value" in value ? String(value.value) : "" };
  }
};
