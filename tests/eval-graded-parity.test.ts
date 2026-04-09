// eval-graded-parity.test.ts
// Integration test: verifies that after auto-conversion, eval_golden_judgments
// reproduces the exact binary judgments from eval_golden_dataset.expected_doc_ids.
//
// Gated: only runs when PARITY_TEST=1.
// Requires: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY env vars.

import 'dotenv/config';
import { describe, it, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';

const runParity = process.env.PARITY_TEST === '1';
const describeIfEnabled = runParity ? describe : describe.skip;

interface IGoldenWithJudgmentsProps {
  id:               number;
  expected_doc_ids: number[] | null;
  judgments:        Array<{ document_id: number; grade: number }> | null;
}

describeIfEnabled('graded parity: judgments table matches legacy expected_doc_ids', () => {
  it('every expected_doc_id has a matching grade-3 judgment', async () => {
    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );

    const { data, error } = await supabase
      .from('eval_golden_dataset')
      .select('id, expected_doc_ids, judgments:eval_golden_judgments(document_id, grade)');

    expect(error).toBeNull();
    expect(data).toBeTruthy();

    const rows = data as IGoldenWithJudgmentsProps[];

    for (const row of rows) {
      const expectedIds = row.expected_doc_ids ?? [];
      const grade3Ids = new Set(
        (row.judgments ?? [])
          .filter(judgment => judgment.grade === 3)
          .map(judgment => judgment.document_id),
      );

      for (const expectedId of expectedIds) {
        expect(
          grade3Ids.has(expectedId),
          `golden_id=${row.id} missing grade-3 judgment for doc ${expectedId}`,
        ).toBe(true);
      }
    }
  });

  it('total grade-3 judgment count equals total expected_doc_ids count', async () => {
    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );

    const { data: goldens } = await supabase
      .from('eval_golden_dataset')
      .select('expected_doc_ids');

    const totalExpected = (goldens ?? []).reduce((sum, row) => {
      const expected = (row as { expected_doc_ids: number[] | null }).expected_doc_ids ?? [];
      return sum + expected.length;
    }, 0);

    const { count } = await supabase
      .from('eval_golden_judgments')
      .select('*', { count: 'exact', head: true })
      .eq('grade', 3);

    expect(count).toBe(totalExpected);
  });
});
