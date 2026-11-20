import type {
  Column,
  DataType,
  DbmlDocument,
  Element,
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
//   - unqualified tables and enums are in the `public` schema, and so is
//     every table group;
//   - inline refs (`[ref: > t.c]`) are refs like any other, listed with the
//     document's refs;
//   - table partials are merged into the tables that inject them;
//   - a table alias in a ref endpoint, a group member or a records target is
//     resolved to the table it names;
//   - column types are flattened to `@dbml/core`'s `type_name` / `args`
//     strings, defaults to `{ type, value }` with its type names;
//   - when a setting is repeated, the last one wins (`@dbml/core` rejects the
//     repeat as a validation error, so the test never sees it).
//
// What it leaves out, on purpose: anything syntactic that the model doesn't
// keep (spans, quoting, setting order, note forms, enum aliases, Project
// properties other than `database_type`), and anything the model derives by
// validation rather than parsing (records values coerced to their column's
// type, the enum member a default names).
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

/** A custom property (`[owner: 'x']`), keyed by its lowercased name in `settings`. */
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
  /** `sortOrder` is `desc` or `null`: the model keeps no `asc`, the default. */
  columns: { type: "column" | "expression"; value: string; sortOrder: "desc" | null }[];
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
  /**
   * As written, `null` when unqualified: the model doesn't default an
   * endpoint's schema, except a partial column's own in its inline refs.
   */
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

/** A records block. A block that lists no columns is dropped, as `@dbml/core` drops it. */
export interface ProjectedRecords {
  /** As written, `null` when unqualified. */
  schema: string | null;
  table: string;
  columns: string[];
  rows: ProjectedField[][];
}

/**
 * A record field. Strings, booleans, numbers and expressions keep their value;
 * `null` and an empty field are both `null`; an enum value keeps only that it
 * is one, since the model drops which member it names.
 *
 * `@dbml/core` coerces a value that doesn't fit its column's type (it
 * truncates a fraction in an integer column, turns a number into text in a
 * string column, …), and this shape doesn't model that: the documents the test
 * compares hold only values that fit their columns.
 */
export type ProjectedField =
  | string
  | boolean
  | null
  | { number: number }
  | { expression: string }
  | { enumValue: true };

export const DEFAULT_SCHEMA = "public";

// --- This package's AST → the common shape ---

/** Maps a parsed document onto the common shape. */
export const projectDocument = (doc: DbmlDocument): ProjectedDocument => {
  const of = <T extends Element["type"]>(type: T) =>
    doc.elements.filter((element): element is Extract<Element, { type: T }> => element.type === type);

  const tables = of("table");
  const enums = of("enum");
  const scope: Scope = { resolveTable: tableResolver(tables), ...enumResolver(enums) };
  const partials = new Map(of("tablePartial").map((partial) => [partial.name.value, partial]));
  const projected = tables.map((table) => projectTable(table, partials, scope));
  const project = of("project")[0];

  return {
    project: project ? projectProject(project) : { name: null, databaseType: null, note: null },
    tables: projected.map(({ table }) => table),
    refs: [...projected.flatMap(({ refs }) => refs), ...of("ref").map((ref) => projectRef(ref, scope))],
    enums: enums.map(projectEnum),
    tableGroups: of("tableGroup").map((group) => projectTableGroup(group, scope)),
    notes: of("stickyNote").map(projectSticky),
    records: [
      ...projected.flatMap(({ records }) => records),
      ...of("records").map((records) => projectTopLevelRecords(records, scope)),
    ].filter((records) => records.columns.length > 0),
  };
};

/** Name lookups that cross elements. */
interface Scope {
  /** The table a name refers to, with a table alias resolved. */
  resolveTable: (name: QualifiedName) => { schema: string | null; table: string };
  /** The enum an unqualified name is the alias of, if any, as the enum writes its name. */
  enumAlias: (name: string) => QualifiedName | undefined;
  /** Whether an enum of this name is declared in this schema (`public` when `null`). */
  isEnum: (schema: string | null, name: string) => boolean;
}

// --- Tables and partials ---

/** A table's or a partial's own contents, projected, before any merging. */
interface Body {
  columns: ProjectedColumn[];
  /** Each column's inline refs, keyed by column name. */
  inlineRefs: Map<string, InlineRef[]>;
  indexes: ProjectedIndex[];
  checks: ProjectedCheck[];
  note: string | null;
  headerColor: string | null;
}

type InlineRef = Extract<Setting, { kind: "ref" }>;

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

  return {
    columns: projected,
    inlineRefs: new Map(columns.map((column) => [column.name.value, settingsOf(column.settings, "ref")])),
    indexes,
    checks: items.flatMap((item) =>
      item.type === "checks"
        ? item.entries.map((entry) => ({
            name: propertyValue(entry.settings, "name"),
            expression: entry.expression.value,
          }))
        : [],
    ),
    // A `Note` item wins over a `note:` setting.
    note: last(items.filter((item): item is Note => item.type === "note"))?.value.value ?? noteOf(settings),
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
 *   - a table column's inline ref lists the target first and the column
 *     second, with the column's schema as written; a partial column's lists
 *     the column first, with its schema defaulted to `public`.
 */
const projectTable = (
  table: Table,
  partials: ReadonlyMap<string, TablePartial>,
  scope: Scope,
): { table: ProjectedTable; refs: ProjectedRef[]; records: ProjectedRecords[] } => {
  const own = projectBody(table.items, table.settings, scope);
  const schema = table.name.schema?.value ?? null;
  const name = table.name.name.value;

  // Each injection's partial, projected; an injection of an unknown partial adds nothing.
  const injected = new Map<TableItem, Body>();
  for (const item of table.items) {
    const partial = item.type === "partialInjection" ? partials.get(item.name.value) : undefined;
    if (partial) injected.set(item, projectBody(partial.items, partial.settings, scope));
  }
  const lastFirst = [...injected].reverse();

  // Which injection supplies each column name the table doesn't define.
  const taken = new Set(own.columns.map((column) => column.name));
  const supplier = new Map<string, TableItem>();
  for (const [item, body] of lastFirst)
    for (const column of body.columns)
      if (!taken.has(column.name)) {
        taken.add(column.name);
        supplier.set(column.name, item);
      }

  /** The refs of a column's inline refs; `fromPartial` picks the endpoint order and schema described above. */
  const inlineRefs = (column: string, refs: readonly InlineRef[], fromPartial: boolean): ProjectedRef[] =>
    refs.map(({ relation, target }) => {
      const [left, right] = cardinalities(relation);
      const ownEnd = {
        schema: fromPartial ? (schema ?? DEFAULT_SCHEMA) : schema,
        table: name,
        columns: [column],
        relation: left,
      };
      const other = endpoint(target, right, scope);
      return inlineRef(fromPartial ? [ownEnd, other] : [other, ownEnd]);
    });

  const ownColumns = new Map(own.columns.map((column) => [column.name, column]));
  const columns: ProjectedColumn[] = [];
  const refs: ProjectedRef[] = [];
  for (const item of table.items) {
    if (item.type === "column") {
      const column = ownColumns.get(item.name.value)!;
      columns.push(column);
      refs.push(...inlineRefs(column.name, own.inlineRefs.get(column.name) ?? [], false));
    }
    const body = injected.get(item);
    if (!body) continue;
    for (const column of body.columns) {
      if (supplier.get(column.name) !== item) continue;
      columns.push(column);
      refs.push(...inlineRefs(column.name, body.inlineRefs.get(column.name) ?? [], true));
    }
  }

  const fromPartials = <T>(pick: (body: Body) => T | null): T | null =>
    lastFirst.map(([, body]) => pick(body)).find((value) => value !== null) ?? null;

  const projected: ProjectedTable = {
    schema: schema ?? DEFAULT_SCHEMA,
    name,
    alias: table.alias?.value ?? null,
    note: own.note ?? fromPartials((body) => body.note),
    headerColor: own.headerColor ?? fromPartials((body) => body.headerColor),
    settings: customProperties(table.settings, ["headercolor"]),
    columns,
    indexes: [...lastFirst.flatMap(([, body]) => body.indexes), ...own.indexes],
    checks: [
      ...lastFirst.flatMap(([, body]) =>
        body.checks.map((check) => ({ ...check, name: check.name === null ? null : `${name}.${check.name}` })),
      ),
      ...own.checks,
    ],
  };

  // A records block inside the table lists all its columns when it names none.
  const records = table.items
    .filter((item): item is Records => item.type === "records")
    .map((records) => ({
      schema,
      table: name,
      columns: records.columns?.map((column) => column.value) ?? columns.map((column) => column.name),
      rows: projectRows(records),
    }));
  return { table: projected, refs, records };
};

const projectColumn = (column: Column, scope: Scope): ProjectedColumn => {
  const { settings } = column;
  const nullSetting = last(settingsOf(settings, "null"));
  const defaultSetting = last(settingsOf(settings, "default"));
  return {
    name: column.name.value,
    type: projectType(column.dataType, scope),
    pk: settings.some((setting) => setting.kind === "pk"),
    unique: settings.some((setting) => setting.kind === "unique"),
    notNull: nullSetting ? nullSetting.not : null,
    increment: settings.some((setting) => setting.kind === "increment"),
    default: defaultSetting ? projectDefault(defaultSetting.value) : null,
    note: noteOf(settings),
    checks: settingsOf(settings, "check").map((check) => check.expression.value),
    settings: customProperties(settings, []),
  };
};

/**
 * `@dbml/core`'s column type. `type_name` is the name as written, unquoted,
 * followed by its arguments joined by `,` and its array suffixes; `args` is
 * the arguments alone, and only when no array suffix follows them. An enum
 * alias is first replaced by the enum's name and schema (none for `public`).
 * Then a bare type
 * (no arguments, no array suffix) naming a declared enum keeps its schema
 * apart; any other schema-qualified type has its schema in `type_name` too.
 */
const projectType = (dataType: DataType, scope: Scope): ProjectedColumn["type"] => {
  const args = dataType.args === null ? null : dataType.args.map(typeArg).join(",");
  const arrays = dataType.arraySizes.map((size) => `[${size === null ? "" : numberText(size)}]`).join("");
  const alias = dataType.name.schema === null ? scope.enumAlias(dataType.name.name.value) : undefined;
  const { schema, name } = alias ?? dataType.name;
  // An alias takes the enum's schema, except `public`, which it leaves unwritten.
  const schemaName = alias && schema?.value === DEFAULT_SCHEMA ? null : (schema?.value ?? null);
  const bare = args === null && arrays === "";
  const prefix = schemaName === null || (bare && scope.isEnum(schemaName, name.value)) ? "" : `${schemaName}.`;
  return {
    schema: schemaName,
    name: `${prefix}${name.value}${args === null ? "" : `(${args})`}${arrays}`,
    args: arrays === "" ? args : null,
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
      return { type: "string", value: last(value.path)!.value };
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
 * Resolves a name that refers to a table: an unqualified name that is some
 * table's alias names that table. The schema stays as written (`null` when
 * unqualified), as in `@dbml/core`'s endpoints.
 */
const tableResolver = (tables: readonly Table[]): Scope["resolveTable"] => {
  const aliases = new Map<string, QualifiedName>();
  for (const table of tables) if (table.alias) aliases.set(table.alias.value, table.name);
  return (name) => {
    const resolved = (name.schema === null ? aliases.get(name.name.value) : undefined) ?? name;
    return { schema: resolved.schema?.value ?? null, table: resolved.name.value };
  };
};

/** Looks up declared enums: by schema and name, and by alias. */
const enumResolver = (enums: readonly Enum[]): Pick<Scope, "enumAlias" | "isEnum"> => {
  const key = (schema: string | null, name: string) => JSON.stringify([schema ?? DEFAULT_SCHEMA, name]);
  const names = new Set(enums.map((element) => key(element.name.schema?.value ?? null, element.name.name.value)));
  const aliases = new Map<string, QualifiedName>();
  for (const element of enums) if (element.alias) aliases.set(element.alias.value, element.name);
  return { enumAlias: (name) => aliases.get(name), isEnum: (schema, name) => names.has(key(schema, name)) };
};

// --- Refs ---

const cardinalities = (relation: Relation): [Cardinality, Cardinality] => {
  const [left, right]: ["1" | "*", "1" | "*"] =
    relation.op === ">" ? ["*", "1"] : relation.op === "<" ? ["1", "*"] : relation.op === "-" ? ["1", "1"] : ["*", "*"];
  return [relation.leftOptional ? `0..${left}` : left, relation.rightOptional ? `0..${right}` : right];
};

const endpoint = (end: Endpoint, relation: Cardinality, scope: Scope): ProjectedEndpoint => ({
  ...scope.resolveTable(end.table),
  columns: end.columns.map((column) => column.value),
  relation,
});

/** An inline ref: it has no name and no settings of its own. */
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
    last(settingsOf(settings, "action").filter((setting) => setting.on === on))?.action ?? null;
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
    const { schema, table } = scope.resolveTable(item);
    return [{ schema: schema ?? DEFAULT_SCHEMA, name: table }];
  }),
});

const projectSticky = (note: StickyNote): ProjectedStickyNote => ({
  name: note.name.name.value,
  content: note.value.value,
  color: propertyValue(note.settings, "color"),
});

/** A top-level records block (`records t(a, b) { … }`), which always names its table. */
const projectTopLevelRecords = (records: Records, scope: Scope): ProjectedRecords => {
  if (records.table === null) throw new Error("a top-level records block names its table");
  return {
    ...scope.resolveTable(records.table),
    columns: records.columns?.map((column) => column.value) ?? [],
    rows: projectRows(records),
  };
};

const projectRows = (records: Records): ProjectedField[][] => records.rows.map((row) => row.fields.map(projectField));

const projectField = (field: RecordField): ProjectedField => {
  switch (field.kind) {
    case "string":
    case "boolean":
      return field.value;
    case "null":
    case "empty":
      return null;
    case "number":
      return { number: field.value };
    case "expression":
      return { expression: field.value };
    case "enumConstant":
      return { enumValue: true };
  }
};

// --- Settings ---

const last = <T>(items: readonly T[]): T | undefined => items[items.length - 1];

type SettingOf<K extends Setting["kind"]> = Extract<Setting, { kind: K }>;

const settingsOf = <K extends Setting["kind"]>(settings: readonly Setting[], kind: K): SettingOf<K>[] =>
  settings.filter((setting): setting is SettingOf<K> => setting.kind === kind);

const noteOf = (settings: readonly Setting[]): string | null => last(settingsOf(settings, "note"))?.value.value ?? null;

/** The value of a known `key: value` property (`headercolor`, `color`, `name`, `type`) as text. */
const propertyValue = (settings: readonly Setting[], key: string): string | null => {
  const setting = last(settingsOf(settings, "property").filter((property) => property.key.value === key));
  if (!setting) return null;
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
  for (const setting of settingsOf(settings, "property"))
    if (!known.includes(setting.key.value)) result[setting.key.value.toLowerCase()] = propertyOf(setting.value);
  return result;
};

/** A custom property's value: the grammar takes a string, a number, a boolean, a color or `none`. */
const propertyOf = (value: Value): ProjectedProperty => {
  switch (value.kind) {
    case "string":
      return { type: "string", value: value.value };
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
      throw new Error(`unexpected custom property value: ${value.kind}`);
  }
};
