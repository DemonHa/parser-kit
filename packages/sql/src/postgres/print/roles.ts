// Roles, privileges, comments and the DROP family.
//
// Not printed yet: each kind below throws NotPrintableError. Printing one
// means adding its handler to the first table and taking it out of the list.
import { defineFamily } from "./registry";

export const rolesFamily = defineFamily("roles", {}, [
  "createRole",
  "alterRole",
  "grant",
  "revoke",
  "alterDefaultPrivileges",
  "dropOwned",
  "reassignOwned",
  "comment",
  "securityLabel",
  "drop",
]);
