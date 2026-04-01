import type { SupabaseClient } from '@supabase/supabase-js';

let auditTableVerified = false;

/**
 * Check that the audit_log table exists. Call once at startup or first use.
 * Throws if the table doesn't exist — forces the user to run migrations.
 */
export async function verifyAuditTable(supabase: SupabaseClient): Promise<void> {
  if (auditTableVerified) return;

  const { error } = await supabase
    .from('audit_log')
    .select('id')
    .limit(0);

  if (error) {
    throw new Error(
      `audit_log table not found. Run migration 005:\n` +
      `  ledger init\n` +
      `  — or run 005-audit-log.sql manually in Supabase Dashboard\n\n` +
      `Error: ${error.message}`
    );
  }

  auditTableVerified = true;
}
