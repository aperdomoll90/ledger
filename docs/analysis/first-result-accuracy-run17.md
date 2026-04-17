# First-Result Accuracy Diagnostic: Run 17

> Generated: 2026-04-17
> Run date: 2026-04-17T02:45:37.974954+00:00
> Queries: 144 (132 scored, 12 out-of-scope)
> First-result accuracy: 65.9%

## Executive Summary

45 of 132 queries (34.1%) do not have the best result at position 1. The dominant failure mode is **near miss (position 2-3)**. 11 queries have unjudged documents at position 1 and need manual review before the classification is trustworthy.

## Failure Taxonomy

| Category        | Count | %     | Description                             |
|-----------------|-------|-------|-----------------------------------------|
| Top-1 correct   |    87  | 65.9% | Position 1 has grade >= 2               |
| Near miss       |    22  | 16.7% | First correct at position 2-3           |
| Buried          |    10  |  7.6% | First correct at position 4-10          |
| Unjudged winner |    11  |  8.3% | Top doc never graded (judgment gap)     |
| Absent          |     2  |  1.5% | No grade >= 2 doc in top 10             |
| Out-of-scope    |    12  | n/a   | Excluded from metric                    |

## Tag Breakdown

Sorted by first-result accuracy (worst first).

| Tag                | Total | Correct | Near Miss | Buried | Absent | Unjudged | 1st-Result% | Avg Gap  |
|--------------------|-------|---------|-----------|--------|--------|----------|-------------|----------|
| security           |     2   |     0     |     1       |     0    |     0    |     1      | 0.0%        | 0.0074 |
| technical          |     9   |     3     |     1       |     1    |     0    |     4      | 33.3%       | 0.0023 |
| custom-skills      |     7   |     3     |     2       |     1    |     0    |     1      | 42.9%       | 0.0074 |
| ledger             |    29   |    14     |     7       |     3    |     0    |     5      | 48.3%       | 0.0027 |
| project            |     8   |     4     |     3       |     1    |     0    |     0      | 50.0%       | 0.0043 |
| conceptual         |    28   |    15     |     4       |     3    |     0    |     6      | 53.6%       | 0.0038 |
| multi-doc          |    12   |     7     |     2       |     2    |     0    |     1      | 58.3%       | 0.0035 |
| exact-term         |    17   |    10     |     1       |     2    |     0    |     4      | 58.8%       | 0.0056 |
| atelier            |    10   |     7     |     2       |     0    |     1    |     0      | 70.0%       | 0.0055 |
| simple             |    63   |    46     |    13       |     3    |     1    |     0      | 73.0%       | 0.0056 |
| system             |     4   |     3     |     0       |     1    |     0    |     0      | 75.0%       | 0.0092 |
| cross-domain       |    12   |     9     |     2       |     0    |     1    |     0      | 75.0%       | 0.0046 |
| persona            |    41   |    32     |     5       |     3    |     1    |     0      | 78.0%       | 0.0065 |
| workspace          |     5   |     4     |     1       |     0    |     0    |     0      | 80.0%       | 0.0036 |
| starbrite          |     5   |     5     |     0       |     0    |     0    |     0      | 100.0%      | 0.0033 |
| general            |    10   |    10     |     0       |     0    |     0    |     0      | 100.0%      | 0.0054 |
| eval               |     1   |     1     |     0       |     0    |     0    |     0      | 100.0%      | 0.0008 |
| conventions        |     1   |     1     |     0       |     0    |     0    |     0      | 100.0%      | 0.0003 |

## Score Distribution by Failure Category

### near-miss (22 queries, avg NDCG: 0.580)

| Metric                  | Min    | Median | Max    | Mean   |
|-------------------------|--------|--------|--------|--------|
| Score at position 1     | 0.0164 | 0.0320 | 0.0328 | 0.0278 |
| Gap (pos 1 vs pos 2)    | 0.0000 | 0.0005 | 0.0161 | 0.0052 |
| Score of first correct  | 0.0159 | 0.0164 | 0.0325 | 0.0211 |
| Gap to correct          | 0.0000 | 0.0012 | 0.0161 | 0.0066 |

### buried (10 queries, avg NDCG: 0.336)

| Metric                  | Min    | Median | Max    | Mean   |
|-------------------------|--------|--------|--------|--------|
| Score at position 1     | 0.0164 | 0.0317 | 0.0328 | 0.0288 |
| Gap (pos 1 vs pos 2)    | 0.0001 | 0.0006 | 0.0167 | 0.0039 |
| Score of first correct  | 0.0147 | 0.0157 | 0.0296 | 0.0170 |
| Gap to correct          | 0.0010 | 0.0158 | 0.0178 | 0.0118 |

### absent (2 queries, avg NDCG: 0.062)

| Metric                  | Min    | Median | Max    | Mean   |
|-------------------------|--------|--------|--------|--------|
| Score at position 1     | 0.0307 | 0.0317 | 0.0328 | 0.0317 |
| Gap (pos 1 vs pos 2)    | 0.0030 | 0.0087 | 0.0143 | 0.0087 |

### unjudged-winner (11 queries, avg NDCG: 0.340)

| Metric                  | Min    | Median | Max    | Mean   |
|-------------------------|--------|--------|--------|--------|
| Score at position 1     | 0.0164 | 0.0323 | 0.0328 | 0.0306 |
| Gap (pos 1 vs pos 2)    | 0.0000 | 0.0008 | 0.0147 | 0.0020 |
| Score of first correct  | 0.0159 | 0.0288 | 0.0323 | 0.0243 |
| Gap to correct          | 0.0000 | 0.0022 | 0.0167 | 0.0060 |

## Unjudged Audit

These queries have a document at position 1 with no judgment. Grade them
via `ledger eval:judge` before trusting the failure classification.

| Query | Top Doc ID | Tags |
|-------|------------|------|
| how does Ledger process a search query end to end | 152 | conceptual, ledger |
| how does chunking work for embeddings | 160 | conceptual, ledger |
| how does Ledger's audit log track document changes | 152 | conceptual, ledger |
| what is the query cache for | 152 | conceptual, ledger |
| how does Ledger protect sensitive documents with access control | 144 | conceptual, security |
| document_create RPC | 152 | exact-term, technical |
| Ledger text-embedding-3-small embedding model | 152 | exact-term, technical |
| Ledger keyword search websearch_to_tsquery GIN index | 152 | exact-term, technical |
| soft delete deleted_at document_purge | 162 | exact-term, technical |
| ledger architecture all sections | 144 | multi-doc, ledger |
| what is the right way to write a custom skill | 163 | conceptual, custom-skills |

## Worst Offenders

Queries with the largest gap between expected and actual ranking (excluding absent and out-of-scope).

| Query | Category | Position | Top Doc (grade) | Score Gap |
|-------|----------|----------|-----------------|-----------|
| Ledger Cohere reranker integration | buried | 10 | 149 (g0) | 0.0178 |
| all feedback and behavioral rules | buried | 6 | 135 (g0) | 0.0176 |
| user profile | buried | 5 | 129 (g0) | 0.0166 |
| ledger embeddings specification | buried | 6 | 22 (g1) | 0.0161 |
| agent Chase persona | near-miss | 2 | 11 (g0) | 0.0161 |
| all custom skills definitions and evals | buried | 8 | 58 (g0) | 0.0159 |
| code review skills and evaluation results | near-miss | 3 | 9 (g0) | 0.0159 |
| CSS over DOM manipulation rule | near-miss | 3 | 65 (g0) | 0.0159 |
| AMR vineyard project | near-miss | 2 | 7 (g0) | 0.0159 |
| naming convention system rule document names | buried | 5 | 129 (g0) | 0.0156 |

## Hypotheses

Ranked by estimated impact (number of queries affected). These are generated
from the data patterns above and need human review before acting on them.

*Hypotheses will be written manually after reviewing the data above.*
*The script produces the data; Adrian and Charlie interpret it together.*