// Tables and indexes: CREATE / ALTER TABLE, CREATE TABLE AS, indexes and partitions.
//
// Not printed yet: each kind in the list throws NotPrintableError. Printing
// one means adding its handler to the `{}` table and taking it out of the list.
import { defineFamily } from "./registry";

export const tablesFamily = defineFamily("tables", {}, [
  "createTable",
  "createTableAs",
  "alterTable",
  "alterAllInTablespace",
  "createIndex",
  "alterIndex",
]);
