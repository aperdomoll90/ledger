-- Migration 006: Transactional Note Operations with Audit
-- Every note write (create, update, delete) is wrapped in a transaction with its audit entry.
-- If either the note write or the audit entry fails, both roll back.
-- This prevents: orphaned notes without audit trails, audit entries for failed writes,
-- and partial chunk writes.

-- =============================================================================
-- 1. CREATE: Insert one or more note rows + audit entry in one transaction
-- =============================================================================
-- Accepts arrays for multi-chunk support. Single-chunk = arrays of length 1.
-- Returns the IDs of all inserted rows.

CREATE OR REPLACE FUNCTION note_create(
  p_contents     text[],
  p_metadatas    jsonb[],
  p_embeddings   vector(1536)[],
  p_ids          bigint[]       DEFAULT NULL,   -- optional: preserve specific IDs (for upsert)
  p_created_at   timestamptz    DEFAULT NULL     -- optional: preserve original timestamp
) RETURNS bigint[] AS $$
DECLARE
  v_ids       bigint[] := '{}';
  v_id        bigint;
  v_ts        timestamptz := COALESCE(p_created_at, now());
  i           int;
BEGIN
  FOR i IN 1..array_length(p_contents, 1) LOOP
    IF p_ids IS NOT NULL AND p_ids[i] IS NOT NULL THEN
      INSERT INTO notes (id, content, metadata, embedding, created_at)
      VALUES (p_ids[i], p_contents[i], p_metadatas[i], p_embeddings[i], v_ts)
      RETURNING id INTO v_id;
    ELSE
      INSERT INTO notes (content, metadata, embedding, created_at)
      VALUES (p_contents[i], p_metadatas[i], p_embeddings[i], v_ts)
      RETURNING id INTO v_id;
    END IF;
    v_ids := v_ids || v_id;
  END LOOP;

  -- Audit: log creation using first chunk's metadata for domain/agent
  INSERT INTO audit_log (note_id, domain, operation, agent, diff)
  VALUES (
    v_ids[1],
    p_metadatas[1]->>'domain',
    'create',
    COALESCE(p_metadatas[1]->>'agent', 'unknown'),
    NULL
  );

  RETURN v_ids;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- 2. UPDATE: Update a single note in-place + audit entry
-- =============================================================================
-- Reads old content/metadata before overwriting for the audit diff.

CREATE OR REPLACE FUNCTION note_update(
  p_id         bigint,
  p_content    text,
  p_metadata   jsonb,
  p_embedding  vector(1536)
) RETURNS void AS $$
DECLARE
  v_old_content  text;
  v_old_metadata jsonb;
BEGIN
  -- Read old values for audit diff
  SELECT content, metadata INTO v_old_content, v_old_metadata
  FROM notes WHERE id = p_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Note % not found', p_id;
  END IF;

  -- Update the note
  UPDATE notes
  SET content = p_content, metadata = p_metadata, embedding = p_embedding, updated_at = now()
  WHERE id = p_id;

  -- Audit: log update with old values for rollback
  INSERT INTO audit_log (note_id, domain, operation, agent, diff)
  VALUES (
    p_id,
    p_metadata->>'domain',
    'update',
    COALESCE(p_metadata->>'agent', 'unknown'),
    jsonb_build_object('content', v_old_content, 'metadata', v_old_metadata)
  );
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- 3. REPLACE: Delete old note/chunks + insert new note/chunks + audit
-- =============================================================================
-- For chunk-count changes: atomically removes old content and inserts new.
-- Preserves the original note ID for the first new chunk.

CREATE OR REPLACE FUNCTION note_replace(
  p_old_id          bigint,           -- original note ID to preserve
  p_old_chunk_group text,             -- NULL if old was single-chunk
  p_contents        text[],
  p_metadatas       jsonb[],
  p_embeddings      vector(1536)[],
  p_created_at      timestamptz
) RETURNS bigint[] AS $$
DECLARE
  v_old_content  text;
  v_old_metadata jsonb;
  v_ids          bigint[] := '{}';
  v_id           bigint;
  i              int;
BEGIN
  -- Read old values for audit diff (from the original note)
  SELECT content, metadata INTO v_old_content, v_old_metadata
  FROM notes WHERE id = p_old_id;

  -- Delete old note/chunks
  IF p_old_chunk_group IS NOT NULL THEN
    DELETE FROM notes WHERE metadata->>'chunk_group' = p_old_chunk_group;
  ELSE
    DELETE FROM notes WHERE id = p_old_id;
  END IF;

  -- Insert new note/chunks
  FOR i IN 1..array_length(p_contents, 1) LOOP
    IF i = 1 THEN
      -- First chunk preserves the original ID
      INSERT INTO notes (id, content, metadata, embedding, created_at)
      VALUES (p_old_id, p_contents[i], p_metadatas[i], p_embeddings[i], p_created_at)
      RETURNING id INTO v_id;
    ELSE
      INSERT INTO notes (content, metadata, embedding, created_at)
      VALUES (p_contents[i], p_metadatas[i], p_embeddings[i], p_created_at)
      RETURNING id INTO v_id;
    END IF;
    v_ids := v_ids || v_id;
  END LOOP;

  -- Audit: log as update with old values for rollback
  INSERT INTO audit_log (note_id, domain, operation, agent, diff)
  VALUES (
    p_old_id,
    p_metadatas[1]->>'domain',
    'update',
    COALESCE(p_metadatas[1]->>'agent', 'unknown'),
    jsonb_build_object('content', v_old_content, 'metadata', v_old_metadata)
  );

  RETURN v_ids;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- 4. DELETE: Delete note/chunks + audit entry with full content for rollback
-- =============================================================================

CREATE OR REPLACE FUNCTION note_delete(
  p_id           bigint,
  p_chunk_group  text,       -- NULL if single-chunk note
  p_agent        text
) RETURNS void AS $$
DECLARE
  v_content  text;
  v_metadata jsonb;
BEGIN
  -- Read full content for rollback
  SELECT content, metadata INTO v_content, v_metadata
  FROM notes WHERE id = p_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Note % not found', p_id;
  END IF;

  -- Audit FIRST: store full content before deletion
  INSERT INTO audit_log (note_id, domain, operation, agent, diff)
  VALUES (
    p_id,
    v_metadata->>'domain',
    'delete',
    p_agent,
    jsonb_build_object('content', v_content, 'metadata', v_metadata)
  );

  -- Then delete
  IF p_chunk_group IS NOT NULL THEN
    DELETE FROM notes WHERE metadata->>'chunk_group' = p_chunk_group;
  ELSE
    DELETE FROM notes WHERE id = p_id;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- 5. UPDATE METADATA: Update metadata fields + audit with changed fields
-- =============================================================================

CREATE OR REPLACE FUNCTION note_update_metadata(
  p_id          bigint,
  p_metadata    jsonb       -- fields to merge (not full replacement)
) RETURNS void AS $$
DECLARE
  v_old_metadata jsonb;
  v_merged       jsonb;
  v_changed      jsonb;
BEGIN
  SELECT metadata INTO v_old_metadata FROM notes WHERE id = p_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Note % not found', p_id;
  END IF;

  -- Merge: new fields override old, old fields preserved
  v_merged := v_old_metadata || p_metadata;

  -- Calculate which fields actually changed (old values of changed keys)
  SELECT COALESCE(jsonb_object_agg(key, v_old_metadata->key), '{}'::jsonb)
  INTO v_changed
  FROM jsonb_each(p_metadata)
  WHERE v_old_metadata->key IS DISTINCT FROM p_metadata->key;

  -- Update
  UPDATE notes SET metadata = v_merged, updated_at = now() WHERE id = p_id;

  -- Audit
  INSERT INTO audit_log (note_id, domain, operation, agent, diff)
  VALUES (
    p_id,
    v_merged->>'domain',
    'update_metadata',
    COALESCE(v_merged->>'agent', 'unknown'),
    jsonb_build_object('metadata', v_changed)
  );
END;
$$ LANGUAGE plpgsql;
