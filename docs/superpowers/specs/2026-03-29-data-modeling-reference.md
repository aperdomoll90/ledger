# Data Modeling Reference: Postgres + Supabase for AI-Powered Applications

A step-by-step guide for schema design decisions. Work through each section before writing any DDL. The pre-DDL checklist at the end is the final gate.

---

## 1. Conceptual Modeling — Define Before You Design

### The Three Levels

Work top-down. Never start at the physical level.

| Level | What you define | Output |
|---|---|---|
| **Conceptual** | Entities, relationships, boundaries — no columns, no types | ER diagram or written list |
| **Logical** | Attributes, cardinality, normalization decisions | Table/column sketches |
| **Physical** | Types, indexes, constraints, DDL | Actual SQL |

### Rules

**Define entities as nouns, not verbs.** `users`, `documents`, `jobs` — not `user_document_access`. Join tables represent relationships, not entities.

**Name the relationship, not just the cardinality.** "A user *owns* many documents" is more useful than "users 1:N documents." The verb often reveals whether you need a join table or a foreign key.

**Identify aggregate boundaries before writing columns.** If you find yourself asking "should this be its own table?" — it probably should. A good heuristic: if the data has its own lifecycle (can be created, updated, deleted independently), it's an entity.

**Avoid the God Table anti-pattern.** A table with 40+ columns where only some columns apply to each row is a sign that you have multiple entities merged into one. Break them apart.

**Write your most important queries first.** Before you finalize any table structure, write out the 5-10 queries your application will run most often. Schema should serve those queries — not be designed in isolation and then queried as an afterthought.

### Anti-Patterns to Avoid

- Designing the schema before you know your access patterns
- Letting your ORM generate your schema — use the ORM to talk to a schema you designed
- Starting with a "flexible" JSONB blob because you haven't thought through the structure yet
- Creating tables that mirror your API request/response shapes rather than your domain model

---

## 2. Normalization — When to Normalize and When to Stop

### The Rules (3NF is your target)

**1NF:** Every column holds one value, every row is unique. No comma-separated lists in a single column — use an array column or a child table.

**2NF:** Every non-key attribute depends on the whole primary key — relevant if you use composite keys. If `order_items` has `(order_id, product_id)` as PK, a column like `product_name` that only depends on `product_id` violates 2NF.

**3NF:** No transitive dependencies. If `users` has both `zip_code` and `city`, and `city` depends on `zip_code` rather than on the user, that's a 3NF violation. Extract it.

**Target:** 3NF for transactional data. Consider stopping at BCNF only when you have specific integrity requirements around candidate keys.

### When to Denormalize (and Why)

Denormalize only after you have a demonstrated performance problem, not in anticipation of one. Postgres joins are fast. The query planner is sophisticated. Premature denormalization trades correctness guarantees for performance gains you may never need.

**Legitimate reasons to denormalize:**
- Read-heavy workloads where joins across 3+ tables are on the hot path and profiling shows the join cost is real
- Reporting/analytics queries that aggregate large datasets — use materialized views, not schema denormalization
- Data that is written once and read many times (lookup tables, reference data)

**Denormalization tools to prefer over structural schema changes:**
- **Materialized views** — keep the normalized schema, let Postgres manage the denormalized copy
- **Generated columns** — compute and store derived values without application logic
- **Partial indexes** — speed up filtered queries without duplicating data

### JSONB and Normalization

JSONB is not a license to skip normalization. The same rules apply to what goes in a JSONB column. If you're storing 20 attributes in a JSONB blob because they're "optional," ask whether those attributes actually belong to a separate entity with its own table.

The correct pattern: model your core attributes as columns, use JSONB as an extension point for genuinely variable/sparse attributes.

---

## 3. Columns vs JSONB — The Decision Framework

This is the single most abused decision in Postgres schema design. JSONB is powerful, but using it as a shortcut around modeling is the new EAV anti-pattern.

### Use Regular Columns When

- You query that field directly in WHERE, ORDER BY, or JOIN clauses
- You need a constraint on the field (NOT NULL, UNIQUE, CHECK, FK)
- You need Postgres to keep statistics on the field's distribution (for the query planner)
- The field appears in more than ~10% of rows
- The type is known and stable

**The statistics problem is critical.** Postgres cannot track value distributions inside JSONB columns. It falls back to a hardcoded 0.1% selectivity estimate for JSONB field conditions, which causes systematically bad query plans. If you filter on `record->>'status' = 'active'` on a table where 90% of rows match, Postgres has no way to know that and will make poor join order decisions.

### Use JSONB When

- The shape of the data varies row-to-row (genuinely polymorphic attributes)
- You don't know the attribute keys at schema design time
- The data is ingested from external systems (API payloads, webhook bodies) and you need to preserve the original structure
- The attribute set is large but sparse — most rows don't have most attributes
- You need to store nested hierarchical data that doesn't flatten cleanly

### The Hybrid Pattern (Preferred for Most Cases)

Model all known, frequently-used attributes as columns. Add a single `metadata JSONB` column for the extension case:

```sql
CREATE TABLE documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  title       text NOT NULL,
  status      text NOT NULL DEFAULT 'draft',
  created_at  timestamptz NOT NULL DEFAULT now(),
  metadata    jsonb        -- extension point: rare/variable attributes
);
CREATE INDEX idx_documents_metadata ON documents USING GIN (metadata jsonb_path_ops);
```

### When to Extract JSONB Fields to Columns

- When a JSONB field starts appearing in WHERE clauses on hot queries
- When you need to enforce uniqueness or referential integrity on the value
- When query plans show poor selectivity estimates for that field

The extraction pattern uses a generated column (Postgres 12+) as an intermediate step before a full column migration:

```sql
ALTER TABLE documents
  ADD COLUMN status_extracted text GENERATED ALWAYS AS (metadata->>'status') STORED;
CREATE INDEX idx_documents_status_extracted ON documents (status_extracted);
```

Once queries use the generated column and performance validates, promote it to a real column in a follow-up migration.

### Anti-Patterns

- Using JSONB to avoid deciding on a schema ("we'll figure it out later")
- Storing foreign key values inside JSONB (you lose referential integrity entirely)
- Filtering on deeply nested JSONB paths in production queries without indexes
- Using `json` type — always use `jsonb`. The `json` type re-parses on every operation; `jsonb` stores a decomposed binary format and processes faster.
- EAV tables — three-column tables of `(entity_id, attribute_name, value)` — are an anti-pattern. JSONB is better than EAV, but a proper column schema is better than both.

---

## 4. Naming Conventions

Consistency here pays compounding returns. These follow Postgres community conventions and avoid the quoting hell that comes from using reserved words or mixed case.

### General Rules

- **Lowercase with underscores (snake_case) everywhere.** Postgres folds unquoted identifiers to lowercase. Mixed case requires double-quoting everywhere forever — don't do it.
- **63 character maximum** (Postgres silently truncates longer names — the truncation won't match what you named the object).
- **No reserved words** as identifiers: `user`, `order`, `table`, `type`, `value`, `key`, `name` — all reserved or problematic. Use `app_user`, `orders`, etc.

### Tables

- Plural nouns: `users`, `documents`, `embeddings`, `audit_events`
- No `tbl_` prefix — it adds noise with no value
- Relationship/join tables: combine the two table names — `user_roles`, `document_tags`

### Columns

- Primary key: `id` (when the table has a single obvious PK) or `{table_singular}_id` for clarity in joins
- Foreign keys: `{referenced_table_singular}_id` — `user_id`, `document_id`, `organization_id`
- Booleans: `is_*` or `has_*` prefix — `is_active`, `has_verified_email`
- Timestamps: `created_at`, `updated_at`, `deleted_at`, `published_at` — always `timestamptz`, never bare `timestamp`
- Status/state columns: use `text` with a CHECK constraint or a small lookup table, not an `ENUM` type (see Constraints section)

### Indexes

Follow a consistent pattern so you can grep for them and understand them at a glance:

| Index type | Pattern | Example |
|---|---|---|
| Standard B-tree | `idx_{table}_{column}` | `idx_documents_user_id` |
| Composite | `idx_{table}_{col1}_{col2}` | `idx_documents_user_id_status` |
| Unique | `uq_{table}_{column}` | `uq_users_email` |
| Partial | `idx_{table}_{column}_{condition}` | `idx_documents_status_active` |
| GIN (JSONB/full-text) | `gin_{table}_{column}` | `gin_documents_metadata` |
| HNSW (vector) | `hnsw_{table}_{column}` | `hnsw_documents_embedding` |
| Primary key | `{table}_pkey` | `users_pkey` (auto-named by Postgres) |

### Functions and Procedures

- Prefix with action verb: `get_`, `create_`, `update_`, `delete_`, `check_`, `calculate_`
- Trigger functions: `trg_{table}_{action}` — `trg_documents_update_timestamp`

### Constraints

- Foreign keys: `fk_{table}_{referenced_table}` — `fk_documents_users`
- Check constraints: `chk_{table}_{column}` — `chk_documents_status`
- Unique constraints: `uq_{table}_{column}` — `uq_users_email`

### Supabase-Specific

- Keep tables in `public` schema unless you have a specific reason for custom schemas
- Don't name tables `auth`, `storage`, `realtime`, `extensions` — these are Supabase system schemas
- Profiles table: use `profiles` (not `users`) for the app-level user data that mirrors `auth.users`

---

## 5. Index Strategy

### The Default: B-tree

B-tree is the default index type and handles the vast majority of use cases. Use it for:
- Equality (`=`)
- Range queries (`<`, `>`, `BETWEEN`)
- `ORDER BY` and `LIMIT` patterns
- `LIKE 'prefix%'` (not `%suffix%`)
- Foreign key columns (Postgres does **not** auto-index FK columns — you must add these manually)

**Index foreign key columns.** Without an index on the FK column, every DELETE or UPDATE on the parent table triggers a sequential scan of the child table to check for orphaned rows. This gets expensive fast.

### GIN Indexes

Use GIN for:
- JSONB containment queries (`@>`, `?`, `?|`, `?&`)
- Array columns
- Full-text search (`tsvector`)

**GIN operator class choice matters:**
- `jsonb_ops` (default): supports all JSONB operators. Larger index.
- `jsonb_path_ops`: only supports `@>` (containment), but produces a smaller, faster index. Prefer this if you only use containment queries.

```sql
-- For containment-only queries (preferred when applicable):
CREATE INDEX gin_documents_metadata ON documents USING GIN (metadata jsonb_path_ops);

-- For all JSONB operators:
CREATE INDEX gin_documents_metadata ON documents USING GIN (metadata);
```

**GIN write overhead warning.** GIN indexes are slower to update than B-tree. On write-heavy columns, this cost adds up. Postgres mitigates this with a pending list (inserted first to a small buffer, bulk-inserted to the index on VACUUM), but index bloat still accumulates. Monitor with `pg_stat_user_indexes` and run `REINDEX CONCURRENTLY` periodically on large GIN indexes.

### HNSW Indexes (Vector Search)

Use HNSW (Hierarchical Navigable Small World) for vector similarity search with pgvector. Prefer HNSW over IVFFlat in most cases:
- HNSW builds on empty tables and handles inserts without rebuilding
- IVFFlat requires a pre-training step (needs data before building) and doesn't adapt to new inserts

```sql
-- L2 distance (Euclidean):
CREATE INDEX hnsw_documents_embedding ON documents USING hnsw (embedding vector_l2_ops);

-- Cosine similarity:
CREATE INDEX hnsw_documents_embedding ON documents USING hnsw (embedding vector_cosine_ops);
```

**Tune HNSW parameters to your dataset.** The defaults work for getting started, but for production:
- `m` (connections per layer, default 16): higher = better recall, slower build, more memory
- `ef_construction` (search width during build, default 64): higher = better index quality, slower build
- `ef_search` (query-time search width, default 40): higher = better recall, slower queries

Always benchmark with your actual data and recall targets before settling on parameters.

**Dimension alignment is critical.** The `vector(N)` column dimension must exactly match your embedding model's output. Document which model produced which column in a comment or in your migration notes.

### Partial Indexes

Use partial indexes to index only the rows you actually query. They're smaller, faster to build, and faster to search:

```sql
-- Only index active documents:
CREATE INDEX idx_documents_user_id_active
  ON documents (user_id)
  WHERE status = 'active';

-- Only index soft-deleted rows for cleanup jobs:
CREATE INDEX idx_documents_deleted_at_pending
  ON documents (deleted_at)
  WHERE deleted_at IS NOT NULL;
```

### Composite Indexes

Column order matters. Put the highest-selectivity column first, or the column that will appear in the most equality conditions:

```sql
-- Query: WHERE user_id = $1 AND status = $2
CREATE INDEX idx_documents_user_status ON documents (user_id, status);
-- user_id first: equality on user_id narrows the scan before filtering on status
```

Postgres 17+ supports skip scans on multicolumn B-tree indexes, reducing the need for redundant single-column indexes when leading columns are filtered. Still, be explicit for clarity.

### When Not to Index

- Small tables (< ~1000 rows): sequential scan is often faster than an index lookup
- Low-cardinality boolean/enum columns used alone: an index on `is_active` where 80% of rows are `true` is often not used by the planner
- Columns that are never queried in WHERE, JOIN, or ORDER BY clauses
- Indexes you added speculatively — remove them if `pg_stat_user_indexes.idx_scan` stays at zero after weeks in production

### RLS Performance (Supabase-Specific)

Index columns used in RLS policies. An RLS policy like `auth.uid() = user_id` causes a full table scan on every query unless `user_id` is indexed. This is a silent performance trap that hits hard at scale:

```sql
CREATE INDEX idx_documents_user_id ON documents (user_id);
```

---

## 6. Constraints and Defaults

Constraints are the schema's immune system. Use them aggressively — the database enforces them at all times, regardless of what the application does.

### NOT NULL

Default to NOT NULL for every column. Nullable columns mean "this value may or may not exist," which adds handling overhead in every query and application layer that touches the column. Add NULL only when absence is a meaningful state in your domain — not as a lazy default.

Be aware: adding `NOT NULL` to an existing column on a large table requires a full table scan and an ACCESS EXCLUSIVE lock. Do this with the NOT VALID pattern (see Migration section).

### DEFAULT

Use server-side defaults for:
- `id`: `DEFAULT gen_random_uuid()` — prefer `uuid` over serial integers; avoids enumeration attacks, works safely in distributed systems
- `created_at`: `DEFAULT now()`
- `updated_at`: `DEFAULT now()` — pair with a trigger to auto-update
- Status columns: `DEFAULT 'draft'` or whatever the initial state is

Avoid application-generated UUIDs when the database can generate them — you reduce round-trips and ensure values always exist even on direct SQL inserts.

### CHECK Constraints

Use CHECK for domain validation:

```sql
-- Status as text with CHECK is preferable to ENUM:
status text NOT NULL DEFAULT 'draft'
  CONSTRAINT chk_documents_status CHECK (status IN ('draft', 'published', 'archived'))
```

**Prefer `text + CHECK` over `ENUM`.** ENUM types are schema objects — adding a new value requires `ALTER TYPE`, which takes an ACCESS EXCLUSIVE lock and cannot be done in a transaction in some Postgres versions. A `text + CHECK` constraint is modified with a simple `ALTER TABLE ... DROP CONSTRAINT / ADD CONSTRAINT` which can be done with `NOT VALID` (no lock on existing rows) and then `VALIDATE CONSTRAINT` (uses a weaker lock).

### Foreign Keys

Always define foreign keys for relationships between entities. The overhead on write operations is real but acceptable in exchange for referential integrity guarantees.

Configure cascade behavior explicitly — never rely on the default (NO ACTION, which errors on orphaned rows):

```sql
user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE
-- or
user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT
-- or
user_id uuid REFERENCES users(id) ON DELETE SET NULL  -- only if the FK column is nullable
```

**Always index foreign key columns** (Postgres does not do this automatically).

For Supabase specifically: reference `auth.users(id)` directly from your `profiles` table, always with `ON DELETE CASCADE`.

### UNIQUE Constraints

Prefer a UNIQUE constraint over a unique index when the uniqueness is a business rule — it's more visible in `\d` output and schema inspection tools:

```sql
ALTER TABLE users ADD CONSTRAINT uq_users_email UNIQUE (email);
```

For conditional uniqueness (unique only when another column has a specific value), use a partial unique index:

```sql
CREATE UNIQUE INDEX uq_documents_slug_published
  ON documents (slug) WHERE status = 'published';
```

### Timestamps Convention

Always use `timestamptz` (timestamp with time zone), never bare `timestamp`. Bare timestamps are stored without timezone information and silently create DST bugs when your server or client timezone changes. `timestamptz` stores UTC internally and converts on output based on the session timezone.

---

## 7. Migration Strategy

The goal: every schema change can be deployed without downtime and rolled back safely.

### The Expand-Contract Pattern

Every breaking schema change (rename, type change, drop) follows three phases spread across separate deployments:

1. **Expand** — Add the new structure alongside the old. Both old and new code paths work simultaneously.
2. **Migrate** — Backfill existing data. Deploy code that writes to both old and new.
3. **Contract** — Remove the old structure once no code references it.

This means a column rename takes three deployments, not one. This is the correct tradeoff.

### Adding Columns Safely

Postgres 11+: Adding a column with a DEFAULT no longer rewrites the table. The default is stored in catalog metadata — new rows get the default written physically, old rows return it on read. This makes the following safe at any table size:

```sql
ALTER TABLE documents ADD COLUMN is_featured boolean NOT NULL DEFAULT false;
```

Before Postgres 11, this rewrote the entire table and held an exclusive lock for the duration. Avoid this pattern on old Postgres versions.

### Adding NOT NULL to Existing Columns

The naive approach (`ALTER TABLE t ALTER COLUMN c SET NOT NULL`) holds an ACCESS EXCLUSIVE lock while it scans the entire table. For large tables:

```sql
-- Step 1: Add the constraint as NOT VALID (validates new writes only, no table scan, minimal lock)
ALTER TABLE documents
  ADD CONSTRAINT chk_documents_title_not_null CHECK (title IS NOT NULL) NOT VALID;

-- Step 2: Validate the constraint (uses ShareUpdateExclusiveLock, non-blocking for reads/writes)
ALTER TABLE documents VALIDATE CONSTRAINT chk_documents_title_not_null;

-- Step 3 (optional, after backfilling nulls): Set the actual NOT NULL flag
-- This is now instant because the CHECK constraint proves no nulls exist
ALTER TABLE documents ALTER COLUMN title SET NOT NULL;
ALTER TABLE documents DROP CONSTRAINT chk_documents_title_not_null;
```

### Backfilling Data

Never backfill in a single transaction on a large table. Batch in chunks of 1,000–10,000 rows:

```sql
-- Backfill in batches; run this in a loop until 0 rows affected:
UPDATE documents
SET title = 'Untitled'
WHERE id IN (
  SELECT id FROM documents
  WHERE title IS NULL
  LIMIT 5000
);
```

Hold row-level locks only for the duration of each batch transaction, not the entire backfill.

### Renaming Columns

Follow the expand-contract pattern:

1. Add a new column with the desired name
2. Write a trigger to sync old → new on writes (keep both in sync)
3. Backfill new column from old column
4. Deploy application code to read/write the new column
5. Remove the sync trigger
6. Drop the old column

### Index Creation Without Locking

Always use `CONCURRENTLY` when creating indexes on live tables:

```sql
CREATE INDEX CONCURRENTLY idx_documents_user_id ON documents (user_id);
```

`CONCURRENTLY` takes significantly longer to build but does not hold an exclusive lock. It requires that no transactions are actively modifying the table at the start of the build. Note: cannot be used inside a transaction block.

### lock_timeout and statement_timeout

Set these on migration sessions to avoid migrations accidentally holding locks that cascade into outages:

```sql
SET lock_timeout = '2s';
SET statement_timeout = '30s';
```

If the lock cannot be acquired within the timeout, the migration fails fast rather than quietly blocking production traffic.

---

## 8. Access Patterns — Schema Follows Queries

### The Principle

Schema design in relational databases has two failure modes: designing for storage convenience (what the data looks like) and designing for write simplicity (what's easy to insert). The correct target is designing for read patterns (what queries need to be fast).

### How to Derive Access Patterns

Before finalizing any table structure:

1. List the entities your application manages
2. For each entity, list the operations: list, get, create, update, delete, search
3. For each list/search operation, identify: what filters? what sort orders? what joins?
4. For each get operation: what related data is fetched in the same request?
5. Mark the top 5 operations by expected frequency

These become your index strategy and your denormalization decision points.

### Common Access Pattern Problems

**N+1 queries hidden in schema structure.** If your application fetches a list of items and then fetches related data for each item in a loop, your schema is missing a join design. Either add the join explicitly, or denormalize the frequently-fetched related columns (e.g., `user_display_name` on the `documents` table, updated by trigger).

**Missing composite indexes for common filter combinations.** If your hottest query is `WHERE user_id = $1 AND status = 'active' ORDER BY created_at DESC`, a single-column index on `user_id` is insufficient. You need a composite index on `(user_id, status, created_at DESC)`.

**Full-text search without tsvector.** `LIKE '%search_term%'` is a sequential scan regardless of indexes. Use `tsvector` + `GIN` for any text search feature:

```sql
ALTER TABLE documents ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(body, ''))) STORED;

CREATE INDEX gin_documents_search_vector ON documents USING GIN (search_vector);
```

### Supabase and PostgREST Considerations

Supabase's auto-generated API (PostgREST) translates HTTP requests to SQL. Design tables with this in mind:

- PostgREST does not support pgvector similarity operators — wrap vector queries in a Postgres function called via `rpc()`
- PostgREST respects RLS policies — your access patterns must be expressible as SQL predicates on the authenticated user
- Deeply nested relationships via PostgREST can generate inefficient SQL — profile the generated queries, not just the schema

---

## 9. Embedding / Vector Columns

### Extension Setup

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

In Supabase: enable via Dashboard → Database → Extensions → Search "vector". Install in the `extensions` schema to keep the `public` schema clean.

### Column Design

```sql
CREATE TABLE documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content     text NOT NULL,
  embedding   vector(1536),        -- dimensions must match your model exactly
  model_name  text NOT NULL,       -- track which model produced this embedding
  embedded_at timestamptz,         -- null = not yet embedded
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

Document the embedding model in the column comment or a migrations note. When you change models, the embedding dimensions may change — this requires rebuilding the column and all indexes.

### Tracking Embedding State

Maintain a nullable `embedded_at` timestamp rather than a boolean flag. This tells you both whether a row has been embedded and when — useful for debugging stale embeddings after model changes.

### Index Selection

**HNSW is the default choice for production:**

```sql
-- Cosine similarity (most common for text/semantic search):
CREATE INDEX CONCURRENTLY hnsw_documents_embedding
  ON documents USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

**IVFFlat is an alternative for specific trade-offs:**
- Faster to build, smaller index for large datasets
- Requires existing data before building (needs `ANALYZE` first)
- Must be rebuilt when significant new data is added
- Use for batch/periodic workflows where build time matters more than live recall

```sql
-- IVFFlat: run AFTER bulk inserting data
ANALYZE documents;  -- needed for IVFFlat to set lists count
CREATE INDEX CONCURRENTLY ivfflat_documents_embedding
  ON documents USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);  -- sqrt(row_count) is a common starting point
```

### Hybrid Search Pattern

For production AI applications, pure vector search rarely gives the best results. Combine vector similarity with structured filters:

```sql
-- Hybrid: vector similarity + structured filter, via Postgres function:
CREATE OR REPLACE FUNCTION search_documents(
  query_embedding vector(1536),
  match_threshold float,
  match_count int,
  filter_user_id uuid
)
RETURNS TABLE (id uuid, content text, similarity float)
LANGUAGE sql
AS $$
  SELECT id, content, 1 - (embedding <=> query_embedding) AS similarity
  FROM documents
  WHERE user_id = filter_user_id
    AND 1 - (embedding <=> query_embedding) > match_threshold
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;
```

### Scaling Considerations

- pgvector with HNSW works well up to tens of millions of vectors on well-provisioned hardware
- For very large datasets (100M+ vectors), evaluate whether a dedicated vector database is warranted
- After bulk inserts, run `VACUUM ANALYZE` before querying — the HNSW index does not update statistics automatically
- Use `pg_prewarm` after restarts or failovers to warm the vector index into shared_buffers before serving traffic

---

## 10. Audit Trails

### Baseline: Every Table Gets Timestamps

The minimum for any production table:

```sql
created_at  timestamptz NOT NULL DEFAULT now(),
updated_at  timestamptz NOT NULL DEFAULT now()
```

Maintain `updated_at` with a trigger:

```sql
CREATE OR REPLACE FUNCTION trg_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
```

### Soft Deletes

Use `deleted_at timestamptz` (nullable) when you need to:
- Allow undeletion within a grace period
- Maintain referential relationships even after "deletion"
- Audit what was deleted and when

Add a partial index to keep active-record queries fast:

```sql
CREATE INDEX idx_documents_active
  ON documents (user_id, created_at DESC)
  WHERE deleted_at IS NULL;
```

**Soft delete is not a substitute for an audit log.** Soft delete tells you something was deleted; an audit log tells you the full history including what the data looked like before deletion.

### Row-Level Audit Log

For tables where you need full change history, use a trigger-based audit log:

```sql
CREATE TABLE audit_events (
  id              bigserial PRIMARY KEY,
  schema_name     text NOT NULL,
  table_name      text NOT NULL,
  operation       text NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
  row_id          text NOT NULL,
  old_data        jsonb,
  new_data        jsonb,
  changed_columns text[],
  app_user_id     uuid,           -- application-level user (from session variable)
  db_user         text NOT NULL DEFAULT current_user,
  transaction_id  bigint DEFAULT txid_current(),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Index for lookups by record:
CREATE INDEX idx_audit_events_table_row
  ON audit_events (table_name, row_id, created_at DESC);
```

The trigger:

```sql
CREATE OR REPLACE FUNCTION trg_audit_log()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_data jsonb;
  new_data jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    old_data := to_jsonb(OLD);
    INSERT INTO audit_events (schema_name, table_name, operation, row_id, old_data, app_user_id)
    VALUES (TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP, OLD.id::text, old_data,
            current_setting('app.current_user_id', true)::uuid);
    RETURN OLD;
  ELSIF TG_OP = 'UPDATE' THEN
    old_data := to_jsonb(OLD);
    new_data := to_jsonb(NEW);
    INSERT INTO audit_events (schema_name, table_name, operation, row_id, old_data, new_data, app_user_id)
    VALUES (TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP, NEW.id::text, old_data, new_data,
            current_setting('app.current_user_id', true)::uuid);
    RETURN NEW;
  ELSIF TG_OP = 'INSERT' THEN
    new_data := to_jsonb(NEW);
    INSERT INTO audit_events (schema_name, table_name, operation, row_id, new_data, app_user_id)
    VALUES (TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP, NEW.id::text, new_data,
            current_setting('app.current_user_id', true)::uuid);
    RETURN NEW;
  END IF;
END;
$$;
```

Set the application user via a session variable before DML:

```sql
SELECT set_config('app.current_user_id', $user_id, true);
```

### Audit Table Anti-Pattern Warning

A monolithic `audit_events` table will become your largest table. Partition it from day one:

```sql
CREATE TABLE audit_events (
  -- ... columns ...
  created_at timestamptz NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);

CREATE TABLE audit_events_2025 PARTITION OF audit_events
  FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
```

Alternatively: use a separate append-only Postgres instance, or stream audit events to an external log store (S3 + Athena, Loki, etc.) for long-term retention without bloating your primary database.

### What Not to Audit

Auditing everything at the row level is expensive. Be selective:
- Audit tables containing PII, financial data, or access-control records
- Don't audit high-volume tables (events, analytics, logs) — these are their own audit trail
- Don't audit `updated_at` column changes in isolation (the trigger fires even for no-op updates)

---

## Pre-DDL Checklist

Run through this before writing any `CREATE TABLE` or `ALTER TABLE`. If you can't answer an item, stop and resolve it first.

### Conceptual Clarity

- [ ] Every entity has a clear definition — I can state in one sentence what each table represents
- [ ] Relationships between entities are named (not just "has many") and cardinality is documented
- [ ] I have written the 5 most important queries my application will run against this schema
- [ ] No entities are conflated into one table (no God Tables)
- [ ] Join tables represent genuine many-to-many relationships, not entities masquerading as relationships

### Normalization Decisions

- [ ] The schema is at 3NF unless I have a documented, measured reason to denormalize
- [ ] Denormalization (if any) uses materialized views or generated columns, not duplicated data in application columns
- [ ] No comma-separated values or arrays-as-strings in any column (arrays go in `text[]` or a child table)

### Column vs JSONB Decision

- [ ] Every JSONB column has a documented reason (variable schema, sparse attributes, external payload preservation)
- [ ] No foreign key values are stored inside JSONB
- [ ] Every field I filter on in WHERE/ORDER BY is a real column (not a JSONB path expression on a hot query)
- [ ] I am using `jsonb` not `json`
- [ ] JSONB columns that need querying have a GIN index defined

### Naming

- [ ] All identifiers are snake_case, lowercase, under 63 characters
- [ ] No reserved words used as identifiers
- [ ] Tables are plural nouns
- [ ] FK columns follow the `{referenced_table_singular}_id` pattern
- [ ] Boolean columns have `is_` or `has_` prefix
- [ ] Timestamp columns use `timestamptz`, named with `_at` suffix
- [ ] All indexes follow the naming convention for their type

### Indexes

- [ ] Every FK column has a corresponding index
- [ ] Columns used in RLS policies are indexed
- [ ] JSONB columns that are queried have a GIN index
- [ ] Vector columns have an HNSW (or IVFFlat) index with operator class matching my distance metric
- [ ] Composite indexes are in the right column order (highest-selectivity or equality-condition column first)
- [ ] I used `CREATE INDEX CONCURRENTLY` for all indexes on existing tables

### Constraints and Defaults

- [ ] All columns are `NOT NULL` by default; nullable columns have an explicit domain reason
- [ ] `id` columns use `DEFAULT gen_random_uuid()`
- [ ] `created_at` and `updated_at` have server-side defaults
- [ ] `updated_at` has a trigger to auto-update
- [ ] Status/state columns use `text + CHECK` not `ENUM`
- [ ] All FK constraints have explicit `ON DELETE` behavior (not relying on default NO ACTION silently)
- [ ] All timestamps use `timestamptz` not `timestamp`

### Migration Safety

- [ ] New NOT NULL columns on large tables use the NOT VALID + VALIDATE pattern
- [ ] Data backfills are written in batches (not a single transaction over the full table)
- [ ] Column renames follow expand-contract (not a direct `ALTER TABLE RENAME COLUMN` on a live table)
- [ ] Index creation uses `CONCURRENTLY`
- [ ] Migration session has `lock_timeout` set to fail fast rather than silently block

### Access Patterns

- [ ] The 5 most critical queries have corresponding indexes
- [ ] Any full-text search feature uses `tsvector` + GIN, not `LIKE '%term%'`
- [ ] Vector queries are wrapped in Postgres functions (required for Supabase PostgREST)
- [ ] I have checked the query plan (`EXPLAIN ANALYZE`) for at least the top 3 queries

### Embeddings (if applicable)

- [ ] Vector column dimension matches the embedding model exactly
- [ ] Model name and dimension are documented in a migration comment
- [ ] `embedded_at timestamptz` column tracks embedding state
- [ ] HNSW index uses the correct operator class for my distance metric (`vector_cosine_ops`, `vector_l2_ops`, `vector_ip_ops`)
- [ ] HNSW index has documented `m` and `ef_construction` parameters with reasoning

### Audit Trail

- [ ] Every table has `created_at timestamptz NOT NULL DEFAULT now()`
- [ ] Every mutable table has `updated_at timestamptz NOT NULL DEFAULT now()` with a trigger
- [ ] Tables with PII, financial data, or access-control records have a row-level audit log trigger
- [ ] Audit table is partitioned by time range or routed to an external log store
- [ ] Soft-deleted tables have a partial index on the active (not deleted) rows

### Supabase-Specific

- [ ] RLS is enabled on all tables in the `public` schema
- [ ] RLS policies are defined — no tables left in "no policy = no access" limbo
- [ ] `profiles` table references `auth.users(id)` with `ON DELETE CASCADE`
- [ ] `service_role` key is never used in client-side code
- [ ] No tables named after Supabase reserved schemas (`auth`, `storage`, `realtime`)

---

Sources:
- [When To Avoid JSONB In A PostgreSQL Schema — Heap](https://www.heap.io/blog/when-to-avoid-jsonb-in-a-postgresql-schema)
- [PostgreSQL Anti-Patterns: Unnecessary JSON/Hstore Dynamic Columns — EDB/2ndQuadrant](https://www.2ndquadrant.com/en/blog/postgresql-anti-patterns-unnecessary-jsonhstore-dynamic-columns/)
- [Entity-attribute-value (EAV) design in PostgreSQL — don't do it! — CYBERTEC](https://www.cybertec-postgresql.com/en/entity-attribute-value-eav-design-in-postgresql-dont-do-it/)
- [PostgreSQL Documentation: JSON Types](https://www.postgresql.org/docs/current/datatype-json.html)
- [PostgreSQL Documentation: Index Types](https://www.postgresql.org/docs/current/indexes-types.html)
- [HNSW Indexes with Postgres and pgvector — Crunchy Data](https://www.crunchydata.com/blog/hnsw-indexes-with-postgres-and-pgvector)
- [Understanding vector search and HNSW index with pgvector — Neon](https://neon.com/blog/understanding-vector-search-and-hnsw-index-with-pgvector)
- [pgvector: Embeddings and vector similarity — Supabase Docs](https://supabase.com/docs/guides/database/extensions/pgvector)
- [How to perform Postgres schema changes in production with zero downtime — Xata](https://xata.io/blog/zero-downtime-schema-migrations-postgresql)
- [Zero-Downtime Schema Migrations on Large Production Tables — Medium](https://amrelsher07.medium.com/zero-downtime-schema-migrations-on-large-production-tables-0bdc27d3ad40)
- [Zero-downtime Postgres schema migrations need this: lock_timeout and retries — PostgresAI](https://postgres.ai/blog/20210923-zero-downtime-postgres-schema-migrations-lock-timeout-and-retries)
- [Row Level Security — Supabase Docs](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [RLS Performance and Best Practices — Supabase Docs](https://supabase.com/docs/guides/troubleshooting/rls-performance-and-best-practices-Z5Jjwv)
- [Understanding Postgres GIN Indexes: The Good and the Bad — pganalyze](https://pganalyze.com/blog/gin-index)
- [Indexing JSONB in Postgres — Crunchy Data](https://www.crunchydata.com/blog/indexing-jsonb-in-postgres)
- [PostgreSQL index naming convention — GitHub Gist](https://gist.github.com/popravich/d6816ef1653329fb1745)
- [Row change auditing options for PostgreSQL — CYBERTEC](https://www.cybertec-postgresql.com/en/row-change-auditing-options-for-postgresql/)
- [Let's Build Production-Ready Audit Logs in PostgreSQL — Medium](https://medium.com/@sehban.alam/lets-build-production-ready-audit-logs-in-postgresql-7125481713d8)
- [Optimize generative AI applications with pgvector indexing — AWS](https://aws.amazon.com/blogs/database/optimize-generative-ai-applications-with-pgvector-indexing-a-deep-dive-into-ivfflat-and-hnsw-techniques/)
- [Normalize or De-normalize? Relational SQL Columns or JSON Document Attributes — PGDay.ch 2025](https://www.pgday.ch/common/slides/2025_20250626_pgday.ch_-_Normalize_or_De-normalize_Relational_SQL_Columns_or_JSON_Document_Attributes.pdf)