// The objects family's printer cases (other schema object statements), for
// `stringify.test.ts`: each is round-tripped, and its width-80 output pinned in
// `stringify.objects.golden.sql`. Empty until the family has a printer.
export const cases: string[] = [];

// Variants of the nested unions the family's printer reads, so P4 reports one
// the cases never reach.
export const kinds: string[] = [];
