CREATE OR REPLACE FUNCTION match_notes(
  q_emb text,
  threshold double precision DEFAULT 0.5,
  max_results integer DEFAULT 10
)
RETURNS TABLE(id bigint, content text, metadata jsonb, similarity double precision)
LANGUAGE sql STABLE AS $$
  SELECT notes.id, notes.content, notes.metadata,
    1 - (notes.embedding <=> q_emb::vector) AS similarity
  FROM notes
  WHERE 1 - (notes.embedding <=> q_emb::vector) > threshold
  ORDER BY notes.embedding <=> q_emb::vector
  LIMIT least(max_results, 200)
$$;
