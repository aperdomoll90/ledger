ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_all" ON notes;
DROP POLICY IF EXISTS "anon_read_only" ON notes;
-- Service role bypasses RLS (Supabase built-in). No policies needed.
-- Anon key is locked out: RLS enabled + no matching policy = deny all.
