# First-Result Accuracy Diagnostic: Run 16

> Generated: 2026-04-17
> Run date: 2026-04-16T03:01:51.826117+00:00
> Queries: 144 (132 scored, 12 out-of-scope)
> First-result accuracy: 65.9%

## Executive Summary

45 of 132 queries (34.1%) do not have the best result at position 1. The dominant failure mode is **near miss (position 2-3)**. 12 queries have unjudged documents at position 1 and need manual review before the classification is trustworthy.

## Failure Taxonomy

| Category        | Count | %     | Description                             |
|-----------------|-------|-------|-----------------------------------------|
| Top-1 correct   |    87  | 65.9% | Position 1 has grade >= 2               |
| Near miss       |    21  | 15.9% | First correct at position 2-3           |
| Buried          |    10  |  7.6% | First correct at position 4-10          |
| Unjudged winner |    12  |  9.1% | Top doc never graded (judgment gap)     |
| Absent          |     2  |  1.5% | No grade >= 2 doc in top 10             |
| Out-of-scope    |    12  | n/a   | Excluded from metric                    |

## Tag Breakdown

Sorted by first-result accuracy (worst first).

| Tag                | Total | Correct | Near Miss | Buried | Absent | Unjudged | 1st-Result% | Avg Gap  |
|--------------------|-------|---------|-----------|--------|--------|----------|-------------|----------|
| security           |     2   |     0     |     1       |     0    |     0    |     1      | 0.0%        | 0.0004 |
| technical          |     9   |     3     |     1       |     0    |     0    |     5      | 33.3%       | 0.0036 |
| custom-skills      |     7   |     3     |     2       |     1    |     0    |     1      | 42.9%       | 0.0074 |
| project            |     8   |     4     |     3       |     1    |     0    |     0      | 50.0%       | 0.0043 |
| conceptual         |    28   |    14     |     5       |     4    |     0    |     5      | 50.0%       | 0.0033 |
| ledger             |    29   |    15     |     5       |     4    |     0    |     5      | 51.7%       | 0.0028 |
| exact-term         |    17   |    10     |     1       |     1    |     0    |     5      | 58.8%       | 0.0064 |
| atelier            |    10   |     6     |     3       |     0    |     1    |     0      | 60.0%       | 0.0055 |
| multi-doc          |    12   |     8     |     1       |     2    |     0    |     1      | 66.7%       | 0.0035 |
| simple             |    63   |    46     |    12       |     3    |     1    |     1      | 73.0%       | 0.0056 |
| system             |     4   |     3     |     0       |     1    |     0    |     0      | 75.0%       | 0.0092 |
| cross-domain       |    12   |     9     |     2       |     0    |     1    |     0      | 75.0%       | 0.0046 |
| persona            |    41   |    32     |     5       |     3    |     1    |     0      | 78.0%       | 0.0065 |
| workspace          |     5   |     4     |     1       |     0    |     0    |     0      | 80.0%       | 0.0036 |
| starbrite          |     5   |     5     |     0       |     0    |     0    |     0      | 100.0%      | 0.0033 |
| general            |    10   |    10     |     0       |     0    |     0    |     0      | 100.0%      | 0.0054 |
| eval               |     1   |     1     |     0       |     0    |     0    |     0      | 100.0%      | 0.0008 |
| conventions        |     1   |     1     |     0       |     0    |     0    |     0      | 100.0%      | 0.0003 |

## Score Distribution by Failure Category

### near-miss (21 queries, avg NDCG: 0.578)

| Metric                  | Min    | Median | Max    | Mean   |
|-------------------------|--------|--------|--------|--------|
| Score at position 1     | 0.0164 | 0.0320 | 0.0328 | 0.0275 |
| Gap (pos 1 vs pos 2)    | 0.0000 | 0.0005 | 0.0161 | 0.0055 |
| Score of first correct  | 0.0159 | 0.0164 | 0.0323 | 0.0207 |
| Gap to correct          | 0.0000 | 0.0005 | 0.0161 | 0.0068 |

### buried (10 queries, avg NDCG: 0.334)

| Metric                  | Min    | Median | Max    | Mean   |
|-------------------------|--------|--------|--------|--------|
| Score at position 1     | 0.0164 | 0.0317 | 0.0328 | 0.0288 |
| Gap (pos 1 vs pos 2)    | 0.0001 | 0.0007 | 0.0167 | 0.0040 |
| Score of first correct  | 0.0152 | 0.0159 | 0.0296 | 0.0172 |
| Gap to correct          | 0.0010 | 0.0158 | 0.0176 | 0.0117 |

### absent (2 queries, avg NDCG: 0.062)

| Metric                  | Min    | Median | Max    | Mean   |
|-------------------------|--------|--------|--------|--------|
| Score at position 1     | 0.0307 | 0.0317 | 0.0328 | 0.0317 |
| Gap (pos 1 vs pos 2)    | 0.0030 | 0.0087 | 0.0143 | 0.0087 |

### unjudged-winner (12 queries, avg NDCG: 0.394)

| Metric                  | Min    | Median | Max    | Mean   |
|-------------------------|--------|--------|--------|--------|
| Score at position 1     | 0.0164 | 0.0325 | 0.0328 | 0.0309 |
| Gap (pos 1 vs pos 2)    | 0.0000 | 0.0006 | 0.0141 | 0.0017 |
| Score of first correct  | 0.0154 | 0.0164 | 0.0325 | 0.0231 |
| Gap to correct          | 0.0000 | 0.0022 | 0.0171 | 0.0077 |

## Unjudged Audit

These queries have a document at position 1 with no judgment. Grade them
via `ledger eval:judge` before trusting the failure classification.

| Query | Top Doc ID | Tags |
|-------|------------|------|
| ledger error log | 159 | simple, ledger |
| what happens when I search for something | 144 | conceptual, ledger |
| how does chunking work for embeddings | 160 | conceptual, ledger |
| what is the query cache for | 152 | conceptual, ledger |
| how to protect sensitive documents | 144 | conceptual, security |
| RRF fusion reciprocal rank | 161 | exact-term, technical |
| document_create RPC | 152 | exact-term, technical |
| Cohere Rerank cross-encoder | 140 | exact-term, technical |
| websearch_to_tsquery tsvector GIN | 152 | exact-term, technical |
| soft delete deleted_at document_purge | 162 | exact-term, technical |
| ledger architecture all sections | 144 | multi-doc, ledger |
| what is the right way to write a custom skill | 163 | conceptual, custom-skills |

## Worst Offenders

Queries with the largest gap between expected and actual ranking (excluding absent and out-of-scope).

| Query | Category | Position | Top Doc (grade) | Score Gap |
|-------|----------|----------|-----------------|-----------|
| all feedback and behavioral rules | buried | 6 | 135 (g0) | 0.0176 |
| user profile | buried | 5 | 129 (g0) | 0.0166 |
| how does the audit trail work | buried | 4 | 149 (g0) | 0.0164 |
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