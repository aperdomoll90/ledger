# SQL & Postgres — Study Reference

Everything learned while building Ledger's database layer. Refer back to this when working with Supabase or Postgres directly.

---

## SQL Command Types

SQL is not just `SELECT`. There are different categories of commands:

| Type | Full Name | Purpose | Examples |
|---|---|---|---|
| **DQL** | Data Query Language | Read data | `SELECT` |
| **DDL** | Data Definition Language | Change structure | `CREATE`, `DROP`, `ALTER`, `CREATE INDEX` |
| **DML** | Data Manipulation Language | Change data | `INSERT`, `UPDATE`, `DELETE` |
| **DCL** | Data Control Language | Permissions | `GRANT`, `REVOKE` |
| **Utility** | — | System operations | `NOTIFY`, `LISTEN`, `SET`, `EXPLAIN`, `VACUUM` |

All of these can be run in the Supabase SQL Editor — it's not limited to SELECT queries.

---

## Key Syntax Patterns

### The `::` Cast Operator
Converts one type to another. Postgres is strict about types — you often need to explicitly say "treat this as type X."

```sql
'public'::regnamespace   -- text → namespace type
'100'::int               -- text → integer
embedding_text::vector   -- text → pgvector vector type
```

This is the same concept behind our `match_notes` fix — PostgREST sends the embedding as text, so we cast it to `vector` inside the function with `q_emb::vector`.

### `AS` — Column Aliases
Renames a column in the output. Purely cosmetic — doesn't change any data.

```sql
SELECT proname AS function_name FROM pg_proc;
-- Output column header says "function_name" instead of "proname"
```

### `WHERE` — Filtering
Restricts which rows are returned.

```sql
WHERE schemaname = 'public'    -- only your objects, hides Postgres/Supabase internals
WHERE tablename = 'notes'      -- only indexes for the notes table
```

### `DROP FUNCTION name(types)`
Must include parameter types because Postgres supports **function overloading** — two functions can share a name with different parameters. The types tell Postgres which one to drop.

```sql
DROP FUNCTION match_notes(text, double precision, integer);
```

### `CREATE OR REPLACE FUNCTION`
Replaces the function body IF the signature (name + parameter types) matches. If you changed the parameters, it creates a second overload instead. In that case, DROP first, then CREATE.

### `DEFAULT` in Function Parameters
Sets a default value so callers can omit the parameter.

```sql
threshold double precision DEFAULT 0.5
-- Can call: match_notes(embedding_text)          -- uses 0.5
-- Or call:  match_notes(embedding_text, 0.8)     -- uses 0.8
```

---

## System Catalog Tables

Built-in tables that Postgres maintains automatically. They store metadata about every object in the database — you query them to understand your database's own structure.

| Catalog | Tracks | Plain English |
|---|---|---|
| `pg_proc` | Functions | "What functions exist?" |
| `pg_indexes` | Indexes | "What indexes exist on my tables?" |
| `pg_tables` | Tables | "What tables exist?" |
| `pg_class` | Everything (tables, indexes, views, sequences) | Master list of all objects |
| `information_schema.columns` | Columns | "What columns does this table have?" |
| `pg_type` | Data types | "What types are available?" |
| `pg_extension` | Extensions | "What extensions are installed?" (pgvector, etc.) |
| `pg_roles` | Users/roles | "Who has access?" |
| `pg_policies` | RLS policies | "What security rules exist?" |
| `pg_stat_user_tables` | Table stats | "How many rows, last vacuum?" |

`information_schema` is the SQL-standard way to query metadata (works across databases). `pg_*` tables are Postgres-specific but more detailed.

---

## Common Queries

```sql
-- List your tables
SELECT tablename FROM pg_tables WHERE schemaname = 'public';

-- List columns of a specific table
SELECT column_name, data_type, is_nullable
FROM information_schema.columns WHERE table_name = 'notes';

-- List installed extensions
SELECT extname, extversion FROM pg_extension;

-- List RLS policies
SELECT tablename, policyname, cmd
FROM pg_policies WHERE schemaname = 'public';

-- List all custom functions and their parameters
SELECT proname, pg_get_function_arguments(oid)
FROM pg_proc WHERE pronamespace = 'public'::regnamespace;

-- List indexes on a table (includes full CREATE statement)
SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'notes';

-- Row count estimates
SELECT relname, n_live_tup FROM pg_stat_user_tables;
```

---

## NOTIFY / LISTEN — Postgres Built-in Pub/Sub

Postgres has a built-in messaging system. One process can send a message to another on a named channel.

```sql
LISTEN channel_name;                    -- subscribe to a channel
NOTIFY channel_name, 'some message';    -- publish a message
```

### PostgREST Schema Reload
PostgREST caches your database structure (tables, functions, types). After any DDL change (CREATE, DROP, ALTER), you must tell it to refresh:

```sql
NOTIFY pgrst, 'reload schema';
```

Without this, PostgREST uses its stale cached view and may call old function signatures or miss new ones.

Supabase Realtime also uses NOTIFY/LISTEN under the hood — it listens for changes to your tables and pushes them to connected clients.

---

## Schemas — Namespaces for Database Objects

A schema is like a folder for organizing tables, functions, and indexes.

```
database/
├── public/          ← your stuff (notes, match_notes, etc.)
├── auth/            ← Supabase's auth tables (users, sessions)
├── storage/         ← Supabase's file storage
├── extensions/      ← where pgvector lives
└── pg_catalog/      ← Postgres internals (pg_proc, pg_indexes, etc.)
```

- `public` is the default schema. Creating a table without specifying a schema puts it in `public`.
- PostgREST only exposes the `public` schema by default. Your tables must be in `public` for `supabase-js` to reach them.
- Filter catalog queries with `WHERE schemaname = 'public'` to see only your objects.

---

## Indexes

Indexes make lookups faster. Without an index, Postgres scans every row (**sequential scan**). With an index, it uses a shortcut.

### B-tree (default)
Standard index for exact matches and sorting. Created automatically for primary keys.

```sql
-- This happens automatically when you define a primary key:
CREATE UNIQUE INDEX notes_pkey ON notes USING btree (id);
```

### IVFFlat (pgvector — avoid for small datasets)
Divides vectors into buckets (`lists`). Searches a subset of buckets (`probes`).

**Problem:** Too many lists + few rows = empty buckets = no results. Must tune `lists` to data size.

```sql
-- BAD: 100 lists for 4 rows
CREATE INDEX ON notes USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

### HNSW (pgvector — recommended)
Graph-based index. Connects similar vectors in a multi-layer network. Works with any number of rows, no tuning required.

```sql
-- GOOD: works at any scale
CREATE INDEX notes_embedding_idx ON public.notes USING hnsw (embedding vector_cosine_ops);
```

### Operator Classes
The `vector_cosine_ops` part tells the index which math to use:
- `vector_cosine_ops` — cosine distance (standard for text embeddings, measures similarity of meaning)
- `vector_l2_ops` — Euclidean distance (measures spatial distance)
- `vector_ip_ops` — inner product

---

## Functions — Anatomy

```sql
CREATE OR REPLACE FUNCTION public.match_notes(
  q_emb text,                              -- parameter: name + type
  threshold double precision DEFAULT 0.5,   -- with default value
  max_results integer DEFAULT 10
)
RETURNS TABLE(                              -- output shape
  id bigint,
  content text,
  metadata jsonb,
  similarity double precision
)
LANGUAGE sql STABLE                         -- language + volatility
AS $$
  -- function body (the actual SQL)
  SELECT ...
$$;
```

### LANGUAGE
- `sql` — plain SQL. The query planner can see inside and optimize. Use for simple queries.
- `plpgsql` — procedural. Supports variables, loops, IF/ELSE. The planner treats it as a black box.

### Volatility
A promise to Postgres about what the function does:
- `VOLATILE` (default) — may modify data, returns different results each call
- `STABLE` — read-only, same results within a transaction. Lets Postgres optimize.
- `IMMUTABLE` — always returns the same result for the same inputs. Most optimizable.

### The `<=>` Operator
pgvector's cosine distance operator. Returns a value between 0 and 2:
- 0 = identical vectors
- 1 = orthogonal (unrelated)
- 2 = opposite

To convert distance to similarity (0–1 scale): `1 - (embedding <=> query_vector)`

### `least()` Function
Returns the smallest of its arguments. Used as a safety cap:
```sql
LIMIT least(max_results, 200)  -- never return more than 200, even if someone passes 10000
```

---

## RLS (Row Level Security)

By default, anyone with your Supabase API key can read/write every row. RLS adds rules to restrict access.

- `rls_auto_enable` — Supabase creates this function automatically. It enables RLS on new tables so you don't accidentally leave one open.
- RLS policies define who can do what (SELECT, INSERT, UPDATE, DELETE) on which rows.

```sql
-- See existing policies
SELECT tablename, policyname, cmd FROM pg_policies WHERE schemaname = 'public';
```
