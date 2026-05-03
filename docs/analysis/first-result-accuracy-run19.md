# First-Result Accuracy Diagnostic: Run 19

> Generated: 2026-04-17
> Run date: 2026-04-17T03:24:59.851462+00:00
> Queries: 144 (132 scored, 12 out-of-scope)
> First-result accuracy: 66.7%

## Executive Summary

44 of 132 queries (33.3%) do not have the best result at position 1. The dominant failure mode is **near miss (position 2-3)**. All top-1 documents have been judged.

## Failure Taxonomy

| Category        | Count | %     | Description                             |
|-----------------|-------|-------|-----------------------------------------|
| Top-1 correct   |    88  | 66.7% | Position 1 has grade >= 2               |
| Near miss       |    23  | 17.4% | First correct at position 2-3           |
| Buried          |    19  | 14.4% | First correct at position 4-10          |
| Unjudged winner |     0  |  0.0% | Top doc never graded (judgment gap)     |
| Absent          |     2  |  1.5% | No grade >= 2 doc in top 10             |
| Out-of-scope    |    12  | n/a   | Excluded from metric                    |

## Tag Breakdown

Sorted by first-result accuracy (worst first).

| Tag                | Total | Correct | Near Miss | Buried | Absent | Unjudged | 1st-Result% | Avg Gap  |
|--------------------|-------|---------|-----------|--------|--------|----------|-------------|----------|
| security           |     2   |     0     |     1       |     1    |     0    |     0      | 0.0%        | 0.0074 |
| technical          |     9   |     3     |     1       |     5    |     0    |     0      | 33.3%       | 0.0023 |
| custom-skills      |     7   |     3     |     3       |     1    |     0    |     0      | 42.9%       | 0.0074 |
| project            |     8   |     4     |     3       |     1    |     0    |     0      | 50.0%       | 0.0043 |
| ledger             |    29   |    15     |     7       |     6    |     1    |     0      | 51.7%       | 0.0027 |
| conceptual         |    28   |    16     |     5       |     6    |     1    |     0      | 57.1%       | 0.0038 |
| multi-doc          |    12   |     7     |     2       |     3    |     0    |     0      | 58.3%       | 0.0035 |
| exact-term         |    17   |    10     |     1       |     6    |     0    |     0      | 58.8%       | 0.0056 |
| atelier            |    10   |     7     |     2       |     0    |     1    |     0      | 70.0%       | 0.0055 |
| simple             |    63   |    46     |    13       |     4    |     0    |     0      | 73.0%       | 0.0053 |
| system             |     4   |     3     |     0       |     1    |     0    |     0      | 75.0%       | 0.0092 |
| cross-domain       |    12   |     9     |     2       |     0    |     1    |     0      | 75.0%       | 0.0046 |
| persona            |    41   |    32     |     5       |     4    |     0    |     0      | 78.0%       | 0.0062 |
| workspace          |     5   |     4     |     1       |     0    |     0    |     0      | 80.0%       | 0.0036 |
| starbrite          |     5   |     5     |     0       |     0    |     0    |     0      | 100.0%      | 0.0033 |
| general            |    10   |    10     |     0       |     0    |     0    |     0      | 100.0%      | 0.0054 |
| eval               |     1   |     1     |     0       |     0    |     0    |     0      | 100.0%      | 0.0008 |
| conventions        |     1   |     1     |     0       |     0    |     0    |     0      | 100.0%      | 0.0003 |

## Score Distribution by Failure Category

### near-miss (23 queries, avg NDCG: 0.592)

| Metric                  | Min    | Median | Max    | Mean   |
|-------------------------|--------|--------|--------|--------|
| Score at position 1     | 0.0164 | 0.0320 | 0.0328 | 0.0273 |
| Gap (pos 1 vs pos 2)    | 0.0000 | 0.0003 | 0.0161 | 0.0050 |
| Score of first correct  | 0.0159 | 0.0164 | 0.0325 | 0.0211 |
| Gap to correct          | 0.0000 | 0.0005 | 0.0161 | 0.0062 |

### buried (19 queries, avg NDCG: 0.350)

| Metric                  | Min    | Median | Max    | Mean   |
|-------------------------|--------|--------|--------|--------|
| Score at position 1     | 0.0164 | 0.0315 | 0.0328 | 0.0294 |
| Gap (pos 1 vs pos 2)    | 0.0000 | 0.0005 | 0.0167 | 0.0031 |
| Score of first correct  | 0.0147 | 0.0161 | 0.0306 | 0.0200 |
| Gap to correct          | 0.0010 | 0.0149 | 0.0176 | 0.0093 |

### absent (2 queries, avg NDCG: 0.117)

| Metric                  | Min    | Median | Max    | Mean   |
|-------------------------|--------|--------|--------|--------|
| Score at position 1     | 0.0313 | 0.0320 | 0.0328 | 0.0320 |
| Gap (pos 1 vs pos 2)    | 0.0012 | 0.0021 | 0.0030 | 0.0021 |

## Worst Offenders

Queries with the largest gap between expected and actual ranking (excluding absent and out-of-scope).

| Query | Category | Position | Top Doc (grade) | Score Gap |
|-------|----------|----------|-----------------|-----------|
| all feedback and behavioral rules | buried | 6 | 135 (g0) | 0.0176 |
| document_create RPC | buried | 5 | 152 (g1) | 0.0167 |
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