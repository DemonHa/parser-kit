// The package entry: `@parser-kit/dbml` resolves here. The DBML grammar is not
// written yet, so `dbml` only fixes the shape of the public API — every method
// throws until the parser lands.

function notImplemented(method: string): never {
  throw new Error(`@parser-kit/dbml: dbml.${method}() is not implemented yet`);
}

/** The DBML parser. `parse` throws at the first error; `diagnose` collects every error. */
export const dbml = {
  parse(_text: string): never {
    return notImplemented("parse");
  },
  diagnose(_text: string): never {
    return notImplemented("diagnose");
  },
};
