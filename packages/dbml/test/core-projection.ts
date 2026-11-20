import type {
  Cardinality,
  ProjectedColumn,
  ProjectedDefault,
  ProjectedDocument,
  ProjectedField,
  ProjectedIndex,
  ProjectedProperty,
  ProjectedRef,
} from "./projection";

// `@dbml/core`'s normalized model → the common shape in `projection.ts`.
//
// `normalize()` returns flat id maps; this walks them back into a tree. The
// model leaves an unset flag out rather than writing `false`, and its
// published types don't match what 12.1.0 returns in places (a column type's
// `args`, an index's `pk`, a record value's `type`), so the parts read here
// are typed locally from what it actually returns.

type Ids<T> = Record<number, T>;
type Metadata = Record<string, { value: string | number | boolean; type: string }>;

/** The parts of `Database#normalize()` that the projection reads. */
export interface CoreModel {
  database: Ids<{ name?: string | null; databaseType?: string | null; note?: string | null }>;
  schemas: Ids<{ name: string }>;
  tables: Ids<{
    name: string;
    alias?: string | null;
    note?: string | null;
    headerColor?: string | null;
    metadata?: Metadata;
    schemaId: number;
    fieldIds: number[];
    indexIds: number[];
    checkIds: number[];
  }>;
  fields: Ids<{
    name: string;
    type: { schemaName: string | null; type_name: string; args?: string | null };
    pk?: boolean;
    unique?: boolean;
    not_null?: boolean;
    increment?: boolean;
    note?: string | null;
    dbdefault?: { type: ProjectedDefault["type"]; value: string | number };
    checkIds: number[];
    metadata?: Metadata;
  }>;
  indexes: Ids<{
    name?: string;
    type?: string;
    unique?: boolean;
    pk?: boolean;
    note?: string | null;
    columnIds: number[];
  }>;
  indexColumns: Ids<{ type: "column" | "expression"; value: string; sortOrder?: "desc" }>;
  checks: Ids<{ name?: string | null; expression: string; columnId: number | null }>;
  refs: Ids<{
    name?: string | null;
    color?: string;
    onDelete?: string;
    onUpdate?: string;
    inactive?: boolean;
    note?: string | null;
    metadata?: Metadata;
    endpointIds: number[];
  }>;
  endpoints: Ids<{ schemaName?: string | null; tableName: string; fieldNames: string[]; relation: Cardinality }>;
  enums: Ids<{ name: string; schemaId: number; valueIds: number[] }>;
  enumValues: Ids<{ name: string; note?: string | null }>;
  tableGroups: Ids<{
    name: string;
    note?: string | null;
    color?: string | null;
    metadata?: Metadata;
    schemaId: number;
    tableIds: number[];
  }>;
  notes: Ids<{ name: string; content: string; color?: string }>;
  records: Ids<{
    schemaName?: string | null;
    tableName: string;
    columns: string[];
    values: { value: unknown; type: string }[][];
  }>;
}

/** Maps `new Parser().parse(source, "dbmlv2").normalize()` onto the common shape. */
export const projectCoreModel = (model: CoreModel): ProjectedDocument => {
  const schemaName = (id: number) => model.schemas[id]!.name;
  const database = Object.values(model.database)[0]!;

  return {
    project: { name: database.name ?? null, databaseType: database.databaseType ?? null, note: database.note ?? null },
    tables: Object.values(model.tables).map((table) => ({
      schema: schemaName(table.schemaId),
      name: table.name,
      alias: table.alias ?? null,
      note: table.note ?? null,
      headerColor: table.headerColor ?? null,
      settings: properties(table.metadata),
      columns: table.fieldIds.map((id): ProjectedColumn => {
        const field = model.fields[id]!;
        return {
          name: field.name,
          type: { schema: field.type.schemaName, name: field.type.type_name, args: field.type.args ?? null },
          pk: field.pk ?? false,
          unique: field.unique ?? false,
          notNull: field.not_null ?? null,
          increment: field.increment ?? false,
          default: field.dbdefault ? { type: field.dbdefault.type, value: field.dbdefault.value } : null,
          note: field.note ?? null,
          checks: field.checkIds.map((checkId) => model.checks[checkId]!.expression),
          settings: properties(field.metadata),
        };
      }),
      indexes: table.indexIds.map((id): ProjectedIndex => {
        const index = model.indexes[id]!;
        return {
          columns: index.columnIds.map((columnId) => {
            const column = model.indexColumns[columnId]!;
            return { type: column.type, value: column.value, sortOrder: column.sortOrder ?? null };
          }),
          name: index.name ?? null,
          type: index.type ?? null,
          unique: index.unique ?? false,
          pk: index.pk ?? false,
          note: index.note ?? null,
        };
      }),
      checks: table.checkIds
        .map((id) => model.checks[id]!)
        .filter((check) => check.columnId === null)
        .map((check) => ({ name: check.name ?? null, expression: check.expression })),
    })),
    refs: Object.values(model.refs).map(
      (ref): ProjectedRef => ({
        name: ref.name ?? null,
        endpoints: ref.endpointIds.map((id) => {
          const end = model.endpoints[id]!;
          return {
            schema: end.schemaName ?? null,
            table: end.tableName,
            columns: [...end.fieldNames],
            relation: end.relation,
          };
        }) as ProjectedRef["endpoints"],
        // The model keeps an action as written (`CASCADE`); the AST lowercases it.
        onDelete: ref.onDelete?.toLowerCase() ?? null,
        onUpdate: ref.onUpdate?.toLowerCase() ?? null,
        color: ref.color ?? null,
        inactive: ref.inactive ?? false,
        note: ref.note ?? null,
        settings: properties(ref.metadata),
      }),
    ),
    enums: Object.values(model.enums).map((element) => ({
      schema: schemaName(element.schemaId),
      name: element.name,
      values: element.valueIds.map((id) => {
        const value = model.enumValues[id]!;
        return { name: value.name, note: value.note ?? null };
      }),
    })),
    tableGroups: Object.values(model.tableGroups).map((group) => ({
      schema: schemaName(group.schemaId),
      name: group.name,
      note: group.note ?? null,
      color: group.color ?? null,
      settings: properties(group.metadata),
      tables: group.tableIds.map((id) => {
        const table = model.tables[id]!;
        return { schema: schemaName(table.schemaId), name: table.name };
      }),
    })),
    notes: Object.values(model.notes).map((note) => ({
      name: note.name,
      content: note.content,
      color: note.color ?? null,
    })),
    records: Object.values(model.records).map((records) => ({
      schema: records.schemaName ?? null,
      table: records.tableName,
      columns: [...records.columns],
      rows: records.values.map((row) => row.map(field)),
    })),
  };
};

const properties = (metadata: Metadata | undefined): Record<string, ProjectedProperty> => {
  const result: Record<string, ProjectedProperty> = {};
  for (const [key, { value, type }] of Object.entries(metadata ?? {}))
    result[key] = { type: type as ProjectedProperty["type"], value };
  return result;
};

/** A record value reduced as `ProjectedField` describes. */
const field = ({ value, type }: { value: unknown; type: string }): ProjectedField => {
  if (value === null) return null;
  if (type === "integer" || type === "real") return typeof value === "number" ? { number: true } : { other: true };
  if (typeof value === "string" && type !== "expression") return value;
  if (typeof value === "boolean") return value;
  return { other: true };
};
