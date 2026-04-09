-- ============================================================
-- Migration 008b — Phase 4.6.2 cleanup: drop legacy column
--
-- Runs AFTER the graded dataset is fully populated and run 14
-- has landed. The expected_doc_ids data was converted to grade-3
-- rows in eval_golden_judgments by convert-judgments-to-graded.ts.
-- ============================================================

ALTER TABLE eval_golden_dataset DROP COLUMN IF EXISTS expected_doc_ids;
