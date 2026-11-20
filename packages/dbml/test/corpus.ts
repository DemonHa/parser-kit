// The shared DBML corpus. Several consumers need the exact same documents, so
// they live here rather than in any one of them:
//
//   - `parity.test.ts` pins a byte-exact AST golden (spans included) for every
//     `CORPUS` entry, and a byte-exact `diagnose()` golden for every `CORPUS`
//     and `MALFORMED` entry, so a change that moves what these documents parse
//     to is a test failure.
//   - The differential test against `@dbml/core` and the benchmarks can feed
//     the same documents to both parsers.
//
// Every entry has a unique `name`; the goldens key on it, so renaming an entry
// moves the goldens. Add new entries next to their category and regenerate with
// `pnpm test -- -u` (see `parity.test.ts`).
//
// The documents are written from scratch. Some cover the same cases as an
// older DBML parser's golden suite (program, table names, column settings,
// defaults, notes, type lengths, header colours, indexes, enums, refs, the
// project, records and full examples); only the inputs are shared, not the
// expected output.

export type Sample = {
  /** Unique within `CORPUS` and `MALFORMED` together. */
  name: string;
  category: string;
  dbml: string;
};

/** Joins lines with CRLF, for the documents that pin `\r\n` handling. */
const crlf = (...lines: string[]) => lines.join("\r\n");

/**
 * Prepends the tables a ref-only document points at, so `@dbml/core` can
 * resolve every endpoint: each `"schema.table"` or `"table"` gets the columns
 * listed after it.
 */
const withTables = (tables: Record<string, string[]>, body: string) =>
  `${Object.entries(tables)
    .map(([name, columns]) => `Table ${name} {\n${columns.map((column) => `  ${column} int\n`).join("")}}\n`)
    .join("\n")}\n${body}`;

/** Valid DBML: `dbml.parse` must accept every entry. */
export const CORPUS: Sample[] = [
  // --- program ---
  { category: "program", name: "empty script", dbml: "" },
  { category: "program", name: "newlines only", dbml: "\n\n\n" },
  {
    category: "program",
    name: "whitespace and comments only",
    dbml: "  // nothing here\n\t/* still\n nothing */\n  \n",
  },

  // --- project ---
  {
    category: "project",
    name: "project with database_type and note",
    dbml: `Project ecommerce {
  database_type: 'PostgreSQL'
  Note: 'Schema for the online store'
}
`,
  },
  {
    category: "project",
    name: "project with block note and custom properties",
    dbml: `Project "Billing Service" {
  database_type: 'MySQL'
  owner: 'payments-team'
  version: "2.3"
  Note {
    '''
    # Billing

    Holds **invoices**, payments and refunds.
    '''
  }
}
`,
  },
  { category: "project", name: "project without a name", dbml: "Project {\n  database_type: 'SQLite'\n}\n" },

  // --- table names ---
  { category: "table-names", name: "table basic", dbml: "Table users {\n  id integer\n  name varchar\n}\n" },
  { category: "table-names", name: "table with schema name", dbml: "Table auth.users {\n  id integer\n}\n" },
  { category: "table-names", name: "table with alias", dbml: "Table users as U {\n  id integer\n}\n" },
  {
    category: "table-names",
    name: "table with quoted name",
    dbml: 'Table "order items" {\n  "order id" integer\n}\n',
  },
  {
    category: "table-names",
    name: "table with quoted schema and alias",
    dbml: 'Table "sales data"."order items" as "OI" {\n  id integer\n}\n',
  },
  {
    category: "table-names",
    name: "table with quoted schema name",
    dbml: 'Table "my schema".accounts {\n  id integer\n}\n',
  },
  {
    category: "table-names",
    name: "table with quoted column name and type",
    dbml: 'Table measurements {\n  "taken at" "timestamp with time zone"\n  "value (raw)" "double precision"\n}\n',
  },
  {
    category: "table-names",
    name: "table keyword in any case",
    dbml: "TABLE a {\n  id int\n}\ntable b {\n  id int\n}\n",
  },
  { category: "table-names", name: "single-line table body", dbml: "Table tags { id int }\n" },
  {
    category: "table-names",
    name: "single-line blocks",
    dbml: "Table t { id int }\nenum e { a }\nTable u {\n  id int\n  indexes { id }\n  checks { `id > 0` }\n  Note { 'x' }\n}\n",
  },

  // --- column types ---
  {
    category: "types",
    name: "all column type forms",
    dbml: `Table type_zoo {
  a int
  b varchar(255)
  c decimal(10, 2)
  d "double precision"
  e int[]
  f text[][]
  g int[3]
  h public.mood
  i "timestamp with time zone"
  j bit(1)
  k numeric(5,-2)
  l char(1)[]
}
`,
  },
  { category: "types", name: "type length single", dbml: "Table t {\n  code varchar(32)\n}\n" },
  { category: "types", name: "type length multiple", dbml: "Table t {\n  price decimal(12, 4)\n}\n" },
  { category: "types", name: "empty type args", dbml: "Table t {\n  c varchar()\n}\n" },
  {
    category: "types",
    name: "type args with strings and names",
    dbml: "Table t {\n  pos geometry(point, 4326)\n  label enum_like('a', 'b')\n}\n",
  },

  // --- column settings ---
  {
    category: "column-settings",
    name: "pk and not null",
    dbml: "Table users {\n  id integer [pk, not null]\n  email varchar [not null, unique]\n}\n",
  },
  {
    category: "column-settings",
    name: "all column settings",
    dbml: `Table accounts {
  id integer [primary key, increment]
  email varchar(320) [unique, not null, note: 'login address']
  nickname varchar [null]
  status account_status [default: 'active']
  referrer_id integer [ref: > accounts.id]
  owner_id integer [ref: - users.id, not null]
  balance decimal(12, 2) [default: 0, check: \`balance >= 0\`, check: \`balance < 1000000\`]
  region varchar [pii: false, owner: 'data-team', source system: 'crm']
}

Table users {
  id integer [pk]
}
`,
  },
  { category: "column-settings", name: "empty settings list", dbml: "Table t {\n  id int []\n}\n" },
  {
    category: "column-settings",
    name: "bare pk and unique after the type",
    dbml: "Table t {\n  id int pk\n  code text unique\n}\n",
  },
  {
    category: "column-settings",
    name: "settings list spanning lines",
    dbml: `Table invoices {
  id int [
    pk,
    increment,
    note: 'surrogate key'
  ]
  total decimal [not null,
                 default: 0]
}
`,
  },
  {
    category: "column-settings",
    name: "column settings in any case",
    dbml: "Table t {\n  id int [PK, Not Null, UNIQUE, Increment]\n  x int [NOTE: 'n', Default: 1]\n}\n",
  },

  // --- defaults ---
  {
    category: "defaults",
    name: "default values of every kind",
    dbml: `Table defaults {
  s varchar [default: 'unknown']
  dq varchar [default: "double quoted"]
  n int [default: 42]
  f float [default: 3.14]
  neg int [default: -1]
  negf float [default: -0.5]
  exp float [default: 1.5e-3]
  t boolean [default: true]
  fa boolean [default: false]
  nu int [default: null]
  ex timestamp [default: \`now()\`]
  en status [default: status.active]
  sen billing.status [default: billing.status.active]
}

enum status {
  active
}

enum billing.status {
  active
}
`,
  },
  { category: "defaults", name: "default string", dbml: "Table t {\n  c text [default: 'n/a']\n}\n" },
  { category: "defaults", name: "default number", dbml: "Table t {\n  c int [default: 10]\n}\n" },
  { category: "defaults", name: "default float", dbml: "Table t {\n  c float [default: 10.25]\n}\n" },
  { category: "defaults", name: "default negative number", dbml: "Table t {\n  c int [default: -10]\n}\n" },
  { category: "defaults", name: "default negative float", dbml: "Table t {\n  c float [default: -10.25]\n}\n" },
  { category: "defaults", name: "default true", dbml: "Table t {\n  c bool [default: true]\n}\n" },
  { category: "defaults", name: "default false", dbml: "Table t {\n  c bool [default: false]\n}\n" },
  { category: "defaults", name: "default null", dbml: "Table t {\n  c int [default: null]\n}\n" },
  {
    category: "defaults",
    name: "default null with not null",
    dbml: "Table t {\n  c int [default: null, not null]\n}\n",
  },
  {
    category: "defaults",
    name: "default expression",
    dbml: "Table t {\n  c timestamp [default: `now() at time zone 'utc'`]\n}\n",
  },

  // --- ref, note and check settings ---
  {
    category: "column-settings",
    name: "ref setting valid",
    dbml: "Table users {\n  id int [pk]\n}\n\nTable posts {\n  author_id int [ref: > users.id]\n}\n",
  },
  {
    category: "column-settings",
    name: "ref setting every relation",
    dbml: `Table t {
  a int [ref: > x.id]
  b int [ref: < x.id]
  c int [ref: - x.id]
  d int [ref: <> x.id]
  e int [ref: > s.x.id]
  f int [ref: >? x.id]
  g int [ref: > y.id, ref: - z.id]
}

Table x {
  id int
}

Table y {
  id int
}

Table z {
  id int
}

Table s.x {
  id int
}
`,
  },
  { category: "column-settings", name: "note setting valid", dbml: "Table t {\n  c int [note: 'counts things']\n}\n" },
  {
    category: "column-settings",
    name: "check setting expression",
    dbml: "Table t {\n  age int [check: `age >= 18`]\n}\n",
  },

  // --- table notes ---
  { category: "notes", name: "table note quoted string", dbml: 'Table t {\n  id int\n  Note: "stores things"\n}\n' },
  { category: "notes", name: "table note string", dbml: "Table t {\n  id int\n  Note: 'stores things'\n}\n" },
  {
    category: "notes",
    name: "table note multiline string",
    dbml: `Table t {
  id int
  Note: '''
    Stores things.
      Indented line.

    Last line.
  '''
}
`,
  },
  {
    category: "notes",
    name: "table note block form",
    dbml: "Table t {\n  id int\n  note {\n    'block note'\n  }\n}\n",
  },
  {
    category: "notes",
    name: "string escapes",
    dbml: "Table t {\n  id int [note: 'it\\'s \\\"quoted\\\"\\ttab\\nnewline \\u00e9 back\\\\slash']\n}\n",
  },

  // --- table settings ---
  { category: "table-settings", name: "headercolor short hex", dbml: "Table t [headercolor: #3a5] {\n  id int\n}\n" },
  { category: "table-settings", name: "headercolor long hex", dbml: "Table t [headercolor: #3498DB] {\n  id int\n}\n" },
  {
    category: "table-settings",
    name: "every table setting",
    dbml: "Table audit.events as E [headercolor: #ff8800, note: 'append-only', retention: '90 days'] {\n  id bigint [pk]\n}\n",
  },

  // --- refs ---
  {
    category: "refs",
    name: "ref short form",
    dbml: withTables({ users: ["id"], posts: ["user_id"] }, "Ref: posts.user_id > users.id\n"),
  },
  {
    category: "refs",
    name: "ref short form named",
    dbml: withTables({ users: ["id"], posts: ["user_id"] }, "Ref fk_posts_user: posts.user_id > users.id\n"),
  },
  {
    category: "refs",
    name: "ref long form",
    dbml: withTables(
      { customers: ["id"], orders: ["customer_id"] },
      "Ref fk_orders_customer {\n  orders.customer_id > customers.id [delete: cascade, update: no action]\n}\n",
    ),
  },
  {
    category: "refs",
    name: "ref long form unnamed",
    dbml: withTables({ a: ["b"], c: ["d"] }, "Ref {\n  a.b - c.d\n}\n"),
  },
  {
    category: "refs",
    name: "ref every relation",
    dbml: withTables(
      { a: ["w", "x", "y", "z"], b: ["w", "x", "y", "z"] },
      "Ref: a.w < b.w\nRef: a.x > b.x\nRef: a.y - b.y\nRef: a.z <> b.z\n",
    ),
  },
  {
    category: "refs",
    name: "ref optional sides",
    dbml: withTables(
      { a: ["v", "w", "x", "y", "z"], b: ["v", "w", "x", "y", "z"] },
      "Ref: a.v >? b.v\nRef: a.w ?> b.w\nRef: a.x ?<>? b.x\nRef: a.y -? b.y\nRef: a.z ?< b.z\n",
    ),
  },
  {
    category: "refs",
    name: "ref composite",
    dbml: withTables(
      { order_items: ["order_id", "product_id"], stock: ["order_id", "product_id"] },
      "Ref: order_items.(order_id, product_id) > stock.(order_id, product_id)\n",
    ),
  },
  {
    category: "refs",
    name: "ref with schema names",
    dbml: withTables(
      { "sales.orders": ["customer_id"], "crm.customers": ["id"] },
      "Ref: sales.orders.customer_id > crm.customers.id\n",
    ),
  },
  {
    category: "refs",
    name: "ref with quoted schema names",
    dbml: withTables(
      { '"sales data"."order items"': ['"order id"'], '"sales data".orders': ["id"] },
      'Ref: "sales data"."order items"."order id" > "sales data".orders.id\n',
    ),
  },
  {
    category: "refs",
    name: "ref every setting",
    dbml: withTables(
      { a: ["w", "x", "y", "z"], b: ["w", "x", "y", "z"] },
      `Ref: a.w > b.w [delete: set null, update: set default]
Ref: a.x > b.x [delete: restrict, update: cascade, color: #79AD51]
Ref: a.y > b.y [inactive, note: 'legacy link']
Ref: a.z > b.z [delete: no action, owner: 'ops']
`,
    ),
  },
  {
    category: "refs",
    name: "ref without spaces around the relation",
    dbml: withTables({ a: ["b", "c"], c: ["d", "e"] }, "Ref: a.b>c.d\nRef: a.c<>c.e\n"),
  },

  // --- enums ---
  {
    category: "enums",
    name: "enum basic",
    dbml: "enum job_status {\n  created\n  running\n  done\n  failure\n}\n",
  },
  {
    category: "enums",
    name: "enum with schema and alias",
    dbml: "Enum v2.job_status as JobStatus {\n  queued\n  started\n}\n",
  },
  {
    category: "enums",
    name: "enum with quoted names",
    dbml: 'enum "grade level" {\n  "A+"\n  "A"\n  "not graded"\n}\n',
  },
  {
    category: "enums",
    name: "enum with value settings",
    dbml: `enum order_status {
  pending [note: 'waiting for payment']
  paid [note: '''
    Payment captured.
  ''']
  shipped
}
`,
  },
  {
    category: "enums",
    name: "enum used as a column type",
    dbml: "enum s.mood {\n  happy\n  sad\n}\n\nTable people {\n  id int\n  mood s.mood [default: s.mood.happy]\n}\n",
  },

  // --- indexes ---
  {
    category: "indexes",
    name: "indexes plain and composite",
    dbml: `Table bookings {
  id int
  country varchar
  booking_date date
  created_at timestamp

  indexes {
    created_at
    (id, country)
    (country, booking_date)
  }
}
`,
  },
  {
    category: "indexes",
    name: "indexes with settings",
    dbml: `Table bookings {
  id int
  country varchar

  indexes {
    id [pk]
    country [unique]
    (id, country) [unique, note: 'one per country']
  }
}
`,
  },
  {
    category: "indexes",
    name: "indexes with name and type settings",
    dbml: `Table bookings {
  id int
  country varchar
  booking_date date

  indexes {
    booking_date [name: 'idx_booking_date', type: btree]
    country [type: hash]
    (country, booking_date) [name: 'country_date', unique, type: btree]
  }
}
`,
  },
  {
    category: "indexes",
    name: "indexes with expressions",
    dbml: `Table users {
  id int
  email varchar

  indexes {
    \`lower(email)\` [unique]
    (\`id*3\`, id)
    (\`date_trunc('day', created_at)\`, email)
  }
}
`,
  },
  {
    category: "indexes",
    name: "indexes with sort order",
    dbml: "Table t {\n  a int\n  b int\n  indexes {\n    (a [asc], b [desc])\n    a[desc]\n  }\n}\n",
  },

  // --- checks ---
  {
    category: "checks",
    name: "checks block",
    dbml: `Table products {
  id int
  price decimal
  discount decimal

  checks {
    \`price > 0\`
    \`discount between 0 and price\` [name: 'chk_discount']
  }
}
`,
  },

  // --- table groups ---
  {
    category: "groups",
    name: "table group with settings and note",
    dbml: withTables(
      { invoices: ["id"], payments: ["id"], "finance.refunds": ["id"] },
      `TableGroup billing [color: #345, note: 'money things'] {
  invoices
  payments
  finance.refunds
  Note: 'Everything that touches money'
}
`,
    ),
  },
  {
    category: "groups",
    name: "table group basic",
    dbml: withTables({ users: ["id"], accounts: ["id"] }, "TableGroup core {\n  users\n  accounts\n}\n"),
  },

  // --- sticky notes ---
  {
    category: "sticky-notes",
    name: "sticky note",
    dbml: "Note onboarding {\n  'Start reading from the users table'\n}\n",
  },
  {
    category: "sticky-notes",
    name: "sticky note with settings and multiline text",
    dbml: `Note design_notes [color: #ffcc00] {
  '''
  - users own accounts
  - accounts own orders
  '''
}
`,
  },

  {
    category: "sticky-notes",
    name: "sticky note with a schema-qualified name",
    dbml: "Note docs.readme {\n  'Lives in the docs schema'\n}\n",
  },

  // --- partials ---
  {
    category: "partials",
    name: "table partial with injection",
    dbml: `TablePartial base_template [headercolor: #aabbcc, note: 'shared columns'] {
  id int [pk, not null]
  created_at timestamp [default: \`now()\`]
  updated_at timestamp
  indexes {
    created_at
  }
}

TablePartial soft_delete {
  deleted_at timestamp [null]
}

Table users {
  ~base_template
  name varchar
  ~soft_delete
  Note: 'users inherit the shared columns'
}
`,
  },

  // --- records ---
  {
    category: "records",
    name: "records with mixed value types",
    dbml: `enum user_status {
  active
  banned
}

Table users {
  id int [pk]
  name varchar
  score float
  active bool
  status user_status
  joined timestamp
}

records users(id, name, score, active, status, joined) {
  1, 'Alice', 9.5, true, user_status.active, \`now()\`
  2, 'Bob', -1, false, null, '2024-01-01'
  3, "Carol", 1e3, true, user_status.banned,
  4, , 0, false, user_status.active, null
}
`,
  },
  {
    category: "records",
    name: "records inside a table",
    dbml: `Table countries {
  code char(2) [pk]
  name varchar

  records (code, name) {
    'NO', 'Norway'
    'JP', 'Japan'
  }
}
`,
  },
  {
    category: "records",
    name: "records with example setting and no column list",
    dbml: "Table t {\n  a int\n  b text\n  records {\n    1, 'one'\n  }\n}\nTable s.t {\n  a int\n}\nrecords s.t(a) [example] {\n  1\n  2\n}\n",
  },

  {
    category: "records",
    name: "records row continued on the next line",
    dbml: "Table t {\n  a int\n  b int\n}\nrecords t(a, b) {\n  1\n  , 2\n  3, 4\n}\n",
  },

  // --- comments, layout, lexical ---
  {
    category: "lexical",
    name: "comments everywhere",
    dbml: `// leading comment
/* block
   comment */
Table /* inline */ users // trailing
{
  // comment line in a body
  id int /* after type */ [pk] // after settings
  /* between columns */
  name varchar [
    // inside a settings list
    not null
  ]
}
Table posts {
  user_id int
}
Ref: users.id /* mid ref */ < posts.user_id // trailing
`,
  },
  {
    category: "lexical",
    name: "blank lines between table rows",
    dbml: "Table t {\n\n  id int\n\n\n  name text\n\n}\n",
  },
  {
    category: "lexical",
    name: "blank line before indexes block",
    dbml: "Table t {\n  id int\n  name text\n\n  indexes {\n    name\n  }\n}\n",
  },
  {
    category: "lexical",
    name: "crlf line endings",
    dbml: crlf(
      "Project p {",
      "  database_type: 'PostgreSQL'",
      "}",
      "",
      "Table users {",
      "  id int [pk]",
      "  bio text [note: '''",
      "    multi",
      "    line''']",
      "  indexes {",
      "    (id, bio)",
      "  }",
      "}",
      "",
      "Table posts {",
      "  user_id int",
      "}",
      "",
      "Ref: posts.user_id > users.id",
      "",
    ),
  },
  {
    category: "lexical",
    name: "unicode names and strings",
    dbml: `Table bảng_người_dùng as 用户 {
  mã int [pk, note: 'khóa chính — primary key']
  名前 varchar [note: '名前は必須です 😀']
  "prénom" text
}

enum 状態 {
  有効
  "無効 ✗"
}
`,
  },
  {
    category: "lexical",
    name: "digit-led names and number forms",
    dbml: "Table t {\n  2fa_code varchar\n  a float [default: 1e5]\n  b float [default: 0.000]\n  c int [default: 007]\n}\n",
  },
  {
    category: "lexical",
    name: "multi-line strings",
    dbml: `Project docs {
  Note: '''
    Line one
      indented
    Line three with 'quotes' and \\''' escaped
  '''
}

Table t {
  id int [note: '''single line in triple quotes''']
  body text [default: '''
  keeps its text
  ''']
}
`,
  },
  { category: "lexical", name: "no trailing newline", dbml: "Table t {\n  id int\n}" },
  { category: "lexical", name: "tabs for indentation", dbml: "Table t {\n\tid\tint\t[pk]\n\tname\ttext\n}\n" },

  // --- keywords as names ---
  {
    category: "keywords",
    name: "keywords as column names",
    dbml: `Table keyword_columns {
  note varchar
  ref int
  indexes int
  checks int
  records int
  table varchar
  enum varchar
  project varchar
  pk int
  null int
  default int
  as int
  Note: 'the real note'
}
`,
  },
  {
    category: "keywords",
    name: "keywords as table, enum and value names",
    dbml: `Table note {
  note note
}
Table indexes as checks {
  indexes int
}
enum ref {
  table
  enum
  note
}
Ref: note.note > indexes.indexes
`,
  },
  {
    category: "keywords",
    name: "keywords as index columns",
    dbml: "Table t {\n  asc int\n  desc int\n  name int\n  type int\n  indexes {\n    (asc, desc)\n    name\n    type\n  }\n}\n",
  },

  // --- realistic schemas ---
  {
    category: "realistic",
    name: "full example with top-level comments",
    dbml: `// Use DBML to define your database structure
// Docs: https://dbml.dbdiagram.io/docs

Table follows {
  following_user_id integer
  followed_user_id integer
  created_at timestamp
}

Table users {
  id integer [primary key]
  username varchar
  role varchar
  created_at timestamp
}

Table posts {
  id integer [primary key]
  title varchar
  body text [note: 'Content of the post']
  user_id integer [not null]
  status varchar
  created_at timestamp
}

Ref user_posts: posts.user_id > users.id // many-to-one

Ref: users.id < follows.following_user_id

Ref: users.id < follows.followed_user_id
`,
  },
  {
    category: "realistic",
    name: "e-commerce schema",
    dbml: `Project ecommerce {
  database_type: 'PostgreSQL'
  Note: '''
    # E-commerce

    Customers, catalogue, carts, orders and shipping.
  '''
}

enum ecommerce.order_status {
  created [note: 'Waiting to be processed']
  paid
  shipped
  delivered
  cancelled
  refunded
}

enum ecommerce.product_status {
  out_of_stock
  in_stock
  running_low
}

Table ecommerce.merchants {
  id int [pk]
  country_code int
  merchant_name varchar
  "created at" varchar
  admin_id int [ref: > users.id]
  Note: 'Sellers on the marketplace'

  indexes {
    (id, country_code) [pk]
  }
}

Table users as U {
  id int [pk, increment]
  full_name varchar [not null]
  email varchar(320) [unique, not null]
  gender varchar(1)
  date_of_birth date
  created_at timestamp [default: \`now()\`]
  country_code int [ref: > countries.code]

  indexes {
    \`lower(email)\` [unique, name: 'users_email_ci']
    created_at
  }
}

Table countries {
  code int [pk]
  name varchar
  continent_name varchar
}

Table ecommerce.product_tags {
  id int [pk]
  name varchar
}

Table ecommerce.products [headercolor: #24BAB1] {
  id int [pk]
  name varchar [not null]
  merchant_id int [not null]
  price decimal(10, 2) [default: 0, check: \`price >= 0\`]
  status ecommerce.product_status
  tags int[]
  created_at datetime [default: \`now()\`]

  indexes {
    (merchant_id, status) [name: 'product_status']
    id [unique]
  }
}

Table ecommerce.product_tag_links {
  product_id int [ref: > ecommerce.products.id]
  tag_id int [ref: > ecommerce.product_tags.id]

  indexes {
    (product_id, tag_id) [pk]
  }
}

Table ecommerce.carts {
  id int [pk]
  user_id int [ref: - U.id]
  updated_at timestamp
}

Table ecommerce.cart_items {
  cart_id int
  product_id int
  quantity int [default: 1, check: \`quantity > 0\`]

  indexes {
    (cart_id, product_id) [pk]
  }
}

Table ecommerce.orders {
  id int [pk]
  user_id int [not null, unique]
  status ecommerce.order_status [default: ecommerce.order_status.created]
  total decimal(12, 2)
  created_at varchar [note: 'When order created']

  checks {
    \`total >= 0\` [name: 'orders_total_positive']
  }
}

Table ecommerce.order_items {
  order_id int
  product_id int
  quantity int [default: 1]
  unit_price decimal(10, 2)

  indexes {
    (order_id, product_id) [unique]
  }
}

Table ecommerce.shipments {
  id int [pk]
  order_id int [ref: - ecommerce.orders.id]
  carrier varchar
  tracking_code varchar [unique, null]
  shipped_at timestamp
}

Ref: ecommerce.orders.user_id > U.id [delete: restrict]
Ref: ecommerce.order_items.order_id > ecommerce.orders.id [delete: cascade]
Ref: ecommerce.order_items.product_id > ecommerce.products.id
Ref: ecommerce.products.merchant_id > ecommerce.merchants.id
Ref: ecommerce.cart_items.(cart_id) > ecommerce.carts.(id) [delete: cascade]
Ref: ecommerce.cart_items.product_id > ecommerce.products.id

TableGroup storefront [color: #24BAB1] {
  ecommerce.products
  ecommerce.product_tags
  ecommerce.product_tag_links
  ecommerce.merchants
}

TableGroup checkout {
  ecommerce.carts
  ecommerce.cart_items
  ecommerce.orders
  ecommerce.order_items
  ecommerce.shipments
  Note: 'From cart to doorstep'
}

records countries(code, name, continent_name) {
  47, 'Norway', 'Europe'
  81, 'Japan', 'Asia'
  1, 'United States', 'North America'
}
`,
  },
  {
    category: "realistic",
    name: "blog schema",
    dbml: `Project blog {
  database_type: 'MySQL'
  Note: 'A small multi-author blog'
}

enum post_state {
  draft
  scheduled
  published [note: 'visible to readers']
  archived
}

TablePartial timestamps {
  created_at datetime [not null, default: \`CURRENT_TIMESTAMP\`]
  updated_at datetime [null]
}

Table authors {
  id int [pk, increment]
  handle varchar(40) [unique, not null]
  display_name varchar(120)
  bio text
  avatar_url varchar
  ~timestamps
}

Table posts {
  id int [pk, increment]
  author_id int [not null, ref: > authors.id]
  slug varchar(200) [not null]
  title varchar(200) [not null]
  body longtext
  state post_state [default: 'draft']
  published_at datetime
  ~timestamps

  indexes {
    slug [unique]
    (author_id, published_at) [name: 'author_timeline']
  }
  Note {
    'One row per article. The slug is unique site-wide.'
  }
}

Table tags {
  id int [pk, increment]
  name varchar(50) [unique]
}

Table post_tags {
  post_id int [ref: > posts.id]
  tag_id int [ref: > tags.id]

  indexes {
    (post_id, tag_id) [pk]
  }
}

Table comments {
  id int [pk, increment]
  post_id int [not null]
  parent_id int [null, note: 'threaded replies']
  author_name varchar(80)
  body text [not null]
  approved boolean [default: false]
  ~timestamps

  checks {
    \`char_length(body) > 0\`
  }
}

Ref: comments.post_id > posts.id [delete: cascade]
Ref: comments.parent_id > comments.id [delete: set null]

Note editorial_flow [color: #8E44AD] {
  '''
  Drafts are private. Scheduled posts publish
  automatically at published_at.
  '''
}

records tags(id, name) {
  1, 'engineering'
  2, 'culture'
  3, 'release notes'
}
`,
  },
  {
    category: "realistic",
    name: "saas multi-tenant schema",
    dbml: `Project saas {
  database_type: 'PostgreSQL'
  Note: 'Row-level multi-tenancy: every tenant-owned row carries tenant_id'
}

enum core.plan_tier {
  free
  team
  business
  enterprise
}

enum core.member_role {
  owner
  admin
  member
  "read-only"
}

TablePartial tenant_owned {
  tenant_id uuid [not null, ref: > core.tenants.id]
  indexes {
    tenant_id
  }
}

TablePartial audited {
  created_at timestamptz [not null, default: \`now()\`]
  created_by uuid [ref: > core.users.id]
  updated_at timestamptz
}

Table core.tenants [headercolor: #1E8449] {
  id uuid [pk, default: \`gen_random_uuid()\`]
  slug citext [unique, not null]
  name text [not null]
  plan core.plan_tier [not null, default: core.plan_tier.free]
  seats int [default: 5, check: \`seats > 0\`]
  settings jsonb [default: '{}']
  ~audited
}

Table core.users {
  id uuid [pk, default: \`gen_random_uuid()\`]
  email citext [unique, not null]
  name text
  last_seen_at timestamptz
}

Table core.memberships {
  ~tenant_owned
  user_id uuid [not null]
  role core.member_role [not null, default: 'member']
  ~audited

  indexes {
    (tenant_id, user_id) [unique, name: 'memberships_tenant_user']
  }
}

Table app.projects {
  id uuid [pk]
  ~tenant_owned
  name text [not null]
  archived boolean [default: false]
  ~audited

  indexes {
    (tenant_id, name) [unique]
    (tenant_id, \`lower(name)\`) [type: btree]
  }
}

Table app.tasks {
  id bigint [pk, increment]
  ~tenant_owned
  project_id uuid [not null]
  assignee_id uuid [null]
  title text [not null]
  priority smallint [default: 3]
  due_on date
  ~audited

  checks {
    \`priority between 1 and 5\` [name: 'tasks_priority_range']
  }
}

Table billing.subscriptions {
  id uuid [pk]
  tenant_id uuid [unique, not null]
  stripe_customer_id text [unique]
  current_period_end timestamptz
  cancel_at_period_end boolean [default: false]
}

Table billing.invoices {
  id uuid [pk]
  subscription_id uuid [not null]
  amount_cents bigint [not null]
  currency char(3) [default: 'USD']
  issued_at timestamptz
  paid_at timestamptz [null]
}

Ref: core.memberships.user_id > core.users.id [delete: cascade]
Ref: app.tasks.project_id > app.projects.id [delete: cascade]
Ref: app.tasks.assignee_id > core.users.id [delete: set null]
Ref: billing.subscriptions.tenant_id - core.tenants.id
Ref: billing.invoices.subscription_id > billing.subscriptions.id
Ref tenant_scoped_tasks: app.tasks.(tenant_id, project_id) > app.projects.(tenant_id, id)

TableGroup identity [color: #1E8449] {
  core.tenants
  core.users
  core.memberships
}

TableGroup work {
  app.projects
  app.tasks
}

TableGroup billing [note: 'Owned by the payments team'] {
  billing.subscriptions
  billing.invoices
}

records core.tenants(id, slug, name, plan, seats) [example] {
  '00000000-0000-0000-0000-000000000001', 'acme', 'Acme Inc.', core.plan_tier.business, 50
  '00000000-0000-0000-0000-000000000002', 'globex', 'Globex', core.plan_tier.free,
}
`,
  },
  {
    category: "realistic",
    name: "hr and payroll schema",
    dbml: `Project hr {
  database_type: 'SQL Server'
}

Enum hr.employment_type {
  full_time
  part_time
  contractor
  intern
}

Table hr.departments {
  id int [pk, increment]
  name nvarchar(100) [not null, unique]
  parent_id int [ref: > hr.departments.id]
  cost_center varchar(12)
}

Table hr.employees as E {
  id int [pk, increment]
  employee_no varchar(10) [unique, not null]
  first_name nvarchar(60) [not null]
  last_name nvarchar(60) [not null]
  department_id int [not null]
  manager_id int [ref: > E.id]
  type hr.employment_type [default: hr.employment_type.full_time]
  hired_on date [not null]
  terminated_on date [null]

  checks {
    \`terminated_on is null or terminated_on >= hired_on\`
  }
}

Table payroll.salaries {
  employee_id int
  effective_from date
  amount decimal(12, 2) [not null, check: \`amount > 0\`]
  currency char(3) [default: 'EUR']

  indexes {
    (employee_id, effective_from) [pk]
  }
}

Table payroll.payslips {
  id bigint [pk, increment]
  employee_id int [not null]
  period char(7) [note: 'YYYY-MM']
  gross decimal(12, 2)
  net decimal(12, 2)

  indexes {
    (employee_id, period) [unique, name: 'payslip_per_period']
  }
}

Ref: payroll.salaries.employee_id > E.id [delete: cascade]
Ref: payroll.payslips.employee_id > E.id

Ref {
  hr.departments.id < hr.employees.department_id [update: cascade]
}

TableGroup people [color: #c0392b] {
  hr.departments
  hr.employees
}

TableGroup money {
  payroll.salaries
  payroll.payslips
}
`,
  },
  {
    category: "realistic",
    name: "iot telemetry schema",
    dbml: `/*
 * Device telemetry: fleets of devices push readings
 * that roll up into hourly aggregates.
 */
Table fleets {
  id serial [pk]
  name text [not null]
}

Table devices {
  id uuid [pk]
  fleet_id int [ref: > fleets.id, not null]
  serial_no text [unique]
  firmware text
  location point
  tags text[]
  last_heartbeat timestamptz
}

Table readings {
  device_id uuid
  taken_at timestamptz
  metric text
  value "double precision"
  quality smallint [default: 100]

  indexes {
    (device_id, taken_at, metric) [pk]
    (metric, taken_at [desc]) [name: 'readings_by_metric']
  }
}

Table hourly_rollups {
  device_id uuid
  hour timestamptz
  metric text
  min "double precision"
  max "double precision"
  avg "double precision"
  samples int

  indexes {
    (device_id, hour, metric) [unique]
  }
}

Ref: readings.device_id > devices.id [delete: cascade]
Ref: hourly_rollups.(device_id) > devices.(id)

Note retention [color: #e67e22] {
  'Raw readings are kept 30 days; rollups for 2 years.'
}
`,
  },
];

/**
 * Invalid DBML, one entry per meaningful error path: `dbml.parse` must reject
 * every entry, and `parity.test.ts` pins what `dbml.diagnose` reports for it.
 * Most are trailed by a valid element, so a future recovery change shows up
 * as that element appearing in the recovered AST.
 */
export const MALFORMED: Sample[] = [
  // --- program ---
  { category: "program", name: "invalid top-level word", dbml: "Tabel users {\n  id int\n}\n" },
  { category: "program", name: "stray closing brace", dbml: "}\nTable t {\n  id int\n}\n" },
  {
    category: "program",
    name: "garbage between elements",
    dbml: "Table a {\n  id int\n}\n42\nTable b {\n  id int\n}\n",
  },

  // --- table headers ---
  { category: "table-names", name: "table without a name", dbml: "Table {\n  id int\n}\n" },
  { category: "table-names", name: "table missing open brace", dbml: "Table users\n  id int\n}\n" },
  // Accepted by @dbml/core's parser; rejected here on purpose (a known difference).
  { category: "table-names", name: "table name with three parts", dbml: "Table a.b.c {\n  id int\n}\n" },
  { category: "table-names", name: "alias without a name", dbml: "Table users as {\n  id int\n}\n" },
  { category: "table-names", name: "unclosed table body", dbml: "Table users {\n  id int\n" },

  // --- columns ---
  { category: "columns", name: "column without a type", dbml: "Table t {\n  id\n}\nTable ok {\n  id int\n}\n" },
  {
    category: "columns",
    name: "comma between columns",
    dbml: "Table t {\n  id int,\n  name text\n}\n",
  },
  {
    category: "columns",
    name: "bad column mid-table",
    dbml: "Table t {\n  id int\n  42 bad\n  name text\n}\nTable ok {\n  id int\n}\n",
  },
  { category: "column-settings", name: "invalid column setting", dbml: "Table t {\n  id int [primary]\n}\n" },
  {
    category: "column-settings",
    name: "column settings end of file",
    dbml: "Table t {\n  id int [pk, not null",
  },
  {
    category: "column-settings",
    name: "missing comma between settings",
    dbml: "Table t {\n  id int [pk not null]\n}\n",
  },
  { category: "column-settings", name: "trailing comma in settings", dbml: "Table t {\n  id int [pk,]\n}\n" },
  { category: "column-settings", name: "not without null", dbml: "Table t {\n  id int [not]\n}\n" },

  // --- defaults ---
  {
    category: "defaults",
    name: "default invalid type",
    dbml: "Table t {\n  c int [default: [1]]\n}\n",
  },
  { category: "defaults", name: "default not null", dbml: "Table t {\n  c int [default: not null]\n}\n" },
  { category: "defaults", name: "default end of file", dbml: "Table t {\n  c int [default:" },
  { category: "defaults", name: "default without a value", dbml: "Table t {\n  c int [default]\n}\n" },

  // --- ref, note and check settings ---
  {
    category: "column-settings",
    name: "ref setting invalid connector",
    dbml: "Table t {\n  c int [ref: => u.id]\n}\n",
  },
  {
    category: "column-settings",
    name: "ref setting invalid type",
    dbml: "Table t {\n  c int [ref: > 'users.id']\n}\n",
  },
  // @dbml/core rejects this only when it resolves the target; rejected here on purpose.
  { category: "column-settings", name: "ref setting single-part target", dbml: "Table t {\n  c int [ref: > id]\n}\n" },
  { category: "column-settings", name: "note setting invalid type", dbml: "Table t {\n  c int [note: 42]\n}\n" },
  { category: "column-settings", name: "note setting invalid syntax", dbml: "Table t {\n  c int [note 'x']\n}\n" },
  {
    category: "column-settings",
    name: "check setting not an expression",
    dbml: "Table t {\n  c int [check: 'c > 0']\n}\n",
  },

  // --- types ---
  { category: "types", name: "unclosed type args", dbml: "Table t {\n  c varchar(255\n}\n" },

  // --- table settings and notes ---
  {
    category: "table-settings",
    name: "headercolor invalid hex",
    dbml: "Table t [headercolor: 'red'] {\n  id int\n}\n",
  },
  { category: "table-settings", name: "invalid note setting", dbml: "Table t [note: 42] {\n  id int\n}\n" },
  // A header's settings list must start on the header's line, as in @dbml/core.
  {
    category: "table-settings",
    name: "table settings on a later line",
    dbml: "Table t\n  [headercolor: #000, note: 'x'] {\n  id int\n}\n",
  },
  { category: "table-settings", name: "invalid not null", dbml: "Table t [not null] {\n  id int\n}\n" },
  { category: "notes", name: "table note without a value", dbml: "Table t {\n  id int\n  Note:\n}\n" },
  {
    category: "notes",
    name: "unterminated string",
    dbml: "Table t {\n  id int [note: 'oops]\n}\nTable ok {\n  id int\n}\n",
  },
  {
    category: "notes",
    name: "unterminated multiline string",
    dbml: "Table t {\n  id int\n  Note: '''never closed\n}\n",
  },

  // --- refs ---
  { category: "refs", name: "ref missing endpoint", dbml: "Ref: users.id >\nTable t {\n  id int\n}\n" },
  { category: "refs", name: "ref missing relation", dbml: "Ref: users.id posts.user_id\n" },
  { category: "refs", name: "ref endpoint without a column", dbml: "Ref: users > posts.user_id\n" },
  {
    category: "refs",
    name: "ref invalid action",
    dbml: "Ref: a.x > b.y [delete: explode]\n",
  },
  { category: "refs", name: "ref long form with two relationships", dbml: "Ref {\n  a.x > b.y\n  c.x > d.y\n}\n" },
  // @dbml/core rejects this only when it resolves the schema; rejected here on purpose.
  { category: "refs", name: "ref endpoint with four parts", dbml: "Ref: a.b.c.d > e.f\n" },

  // --- enums ---
  { category: "enums", name: "enum invalid comma", dbml: "enum status {\n  active,\n  inactive\n}\n" },
  { category: "enums", name: "enum invalid pk prop", dbml: "enum status {\n  active [pk]\n}\n" },
  { category: "enums", name: "enum invalid increment prop", dbml: "enum status {\n  active [increment]\n}\n" },
  { category: "enums", name: "enum value with a type", dbml: "enum status {\n  active int\n}\n" },

  // --- indexes and checks ---
  {
    category: "indexes",
    name: "index unknown setting",
    dbml: "Table t {\n  a int\n  indexes {\n    a [clustered]\n  }\n}\n",
  },
  {
    category: "indexes",
    name: "index unclosed composite",
    dbml: "Table t {\n  a int\n  indexes {\n    (a, b\n  }\n}\n",
  },
  {
    category: "checks",
    name: "check entry not an expression",
    dbml: "Table t {\n  a int\n  checks {\n    a > 0\n  }\n}\n",
  },

  // --- groups, sticky notes, partials ---
  { category: "groups", name: "table group without a name", dbml: "TableGroup {\n  a\n}\n" },
  { category: "groups", name: "named note inside a table group", dbml: "TableGroup g {\n  a\n  Note n { 'x' }\n}\n" },
  { category: "sticky-notes", name: "sticky note without text", dbml: "Note n {\n}\n" },
  { category: "partials", name: "injection without a name", dbml: "Table t {\n  ~\n}\n" },
  { category: "partials", name: "records inside a table partial", dbml: "TablePartial p {\n  records { 1 }\n}\n" },

  // --- records ---
  { category: "records", name: "records unclosed column list", dbml: "records t(a, b {\n  1, 2\n}\n" },
  { category: "records", name: "records invalid value", dbml: "records t(a) {\n  [1]\n}\n" },

  // --- project ---
  { category: "project", name: "project property with a number", dbml: "Project p {\n  version: 2\n}\n" },
  { category: "project", name: "project with settings", dbml: "Project p [note: 'x'] {\n  a: 'b'\n}\n" },

  // --- lexical ---
  { category: "lexical", name: "unknown character", dbml: "Table t {\n  id int $\n}\n" },
  { category: "lexical", name: "unterminated block comment", dbml: "Table t {\n  id int\n}\n/* never closed\n" },
  { category: "lexical", name: "unterminated quoted name", dbml: 'Table "users {\n  id int\n}\n' },
  { category: "lexical", name: "unterminated expression", dbml: "Table t {\n  id int [default: `now()]\n}\n" },
  { category: "lexical", name: "trailing semicolon", dbml: "Table t {\n  id int\n};\n" },
];
