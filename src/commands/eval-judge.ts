// eval-judge.ts
// CLI command for the graded-relevance rejudging walkthrough.

import type { LedgerConfig } from '../lib/config.js';
import type { IClientsProps } from '../lib/documents/classification.js';
import { runJudgeSession } from '../lib/eval/eval-judge-session.js';

export interface IJudgeOptionsProps {
  query?: number;
}

export async function evalJudge(
  config:  LedgerConfig,
  options: IJudgeOptionsProps,
): Promise<void> {
  const clients: IClientsProps = {
    supabase:     config.supabase,
    openai:       config.openai,
    cohereApiKey: config.cohereApiKey,
  };

  await runJudgeSession(clients, options.query);
}
