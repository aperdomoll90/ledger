# First-Result Accuracy Diagnostic

> Date: 2026-04-16
> Type: Investigation (diagnostic only, no code changes to pipeline)
> Context: First-result accuracy stuck at 65.9%, target 85%. 19-point gap.

## Problem Statement

Run 16 (latest baseline) shows first-result accuracy at 65.9%. The metric has
plateaued in the 63-66% range since Session 33, when chunking and context
enrichment pushed it from 44% to 65%. The reranker was tested (S44b) and does
not help this metric (-0.7%). We need to understand WHY 34% of queries get the
wrong document at position 1 before choosing an intervention.

## Goal

Produce a structured diagnostic report that classifies every failing query by
failure mode, identifies patterns by tag and score distribution, and generates
ranked hypotheses for intervention. No pipeline changes.

## Data Source

- Table: `eval_runs`, row where `id = 16`
- Column: `per_query_results` (JSONB array, one entry per test case)
- Each entry contains: `ITestResultProps` shape (see `src/lib/eval/eval.ts:32`)
  - `testCase`: `{ id, query, tags, judgments: [{ document_id, grade }] }`
  - `returnedIds`: top-10 document IDs in ranked order
  - `returnedScores`: corresponding RRF fusion scores
  - `hit`: boolean (any grade >= 2 in top 10)
  - `firstResultHit`: boolean (position 1 has grade >= 2)
  - `position`: 1-indexed position of first grade >= 2 result (null if absent)
  - `reciprocalRank`: 1/position (0 if absent)
  - `normalizedDiscountedCumulativeGain`: NDCG for this query

Also available on the same row:
- `missed_queries`: queries with no grade >= 2 results
- `results_by_tag`: per-tag hit/firstHit counts
- `score_calibration`: relevant vs irrelevant score distributions

## Phase 1: Failure Classification

### Taxonomy

Every query is classified into exactly one category. Classification is applied
in priority order (first match wins). This matters because a query could have
`position = 3` (would be "near miss") but also have an unjudged doc at position
1 (unjudged winner). Unjudged winner takes priority because we cannot trust the
failure classification if position 1 was never graded.

| Priority | Category           | Condition                                         | Interpretation                    |
|----------|--------------------|---------------------------------------------------|-----------------------------------|
| 1        | **Out-of-scope**   | Tags include `out-of-scope`                       | Excluded from first-result metric |
| 2        | **Top-1 correct**  | `firstResultHit === true`                         | Working as intended               |
| 3        | **Unjudged winner**| `returnedIds[0]` has no entry in `testCase.judgments` | Judgment gap, needs manual review |
| 4        | **Near miss**      | `position` is 2 or 3                              | Ranking signal, close to correct  |
| 5        | **Buried**         | `position` is 4-10                                | Retrieved but ranking failed      |
| 6        | **Absent**         | `hit === false` (no grade >= 2 in top 10)         | Retrieval failure                 |

### Unjudged Winner Detection

For queries where `firstResultHit === false`, check whether `returnedIds[0]`
exists in `testCase.judgments`. If it does not, the top result was never graded.
It might be correct (judgment gap) or irrelevant. These queries need manual
review via `ledger eval:judge` before we can trust the failure classification.

### Output

Summary table:

```
Category           Count    %      Cumulative %
Top-1 correct      ~95      66%    66%
Near miss          ~??      ??%    ??%
Buried             ~??      ??%    ??%
Unjudged winner    ~??      ??%    ??%
Absent             ~3       ~2%    ~100%
Out-of-scope       ~5       n/a    (excluded)
```

## Phase 2: Score Distribution Analysis

For each failure category (excluding top-1 correct and out-of-scope):

### Metrics Collected

| Metric                     | Source                                    | Purpose                                           |
|----------------------------|-------------------------------------------|---------------------------------------------------|
| Score at position 1        | `returnedScores[0]`                       | System confidence in top pick                     |
| Score gap (pos 1 vs pos 2) | `returnedScores[0] - returnedScores[1]`   | Decisiveness of ranking                           |
| Score of first correct     | `returnedScores[position - 1]`            | How high correct doc scored                       |
| Score gap to correct       | `returnedScores[0] - returnedScores[position - 1]` | How far off the correct doc was        |
| NDCG                       | `normalizedDiscountedCumulativeGain`      | Overall ranking quality for this query            |

### Interpretation Guide

- **Small gap (< 0.002) + near miss**: ranking is a coin flip. RRF weight
  tuning or a small boost could fix these.
- **Large gap + near miss**: system is confidently wrong. Harder problem,
  likely needs better embedding or cross-encoder.
- **Score clustering**: if many results have near-identical scores, the ranking
  is essentially random within that cluster.

## Phase 3: Tag-Level Breakdown

Cross-reference failure categories with tags. For each of the 19 tags:

- Failure category distribution (e.g., "conceptual: 60% near-miss, 20% buried")
- Average score at position 1
- Average score gap
- Count of unjudged winners

### Expected High-Value Findings

Based on prior devlog analysis, likely patterns:
- `conceptual` queries: lower first-result accuracy than `exact-term`
- `multi-doc` queries: may have more near-misses (multiple valid top results)
- Project-specific tags (`ledger`, `atelier`, etc.): may cluster differently

## Phase 4: Diagnostic Report

### Report Structure

Saved to `docs/analysis/first-result-accuracy-run16.md`:

1. **Executive summary**: one paragraph, key finding, primary failure mode
2. **Failure taxonomy table**: counts and percentages per category
3. **Tag heatmap**: tags (rows) vs failure categories (columns), counts
4. **Score analysis**: per-category score distributions (min, median, max, mean)
5. **Unjudged audit**: list of queries where position 1 has no judgment.
   Format: query text, returned doc ID, tags. These are action items for
   manual grading.
6. **Worst offenders**: 10 queries with largest gap between expected and actual
   ranking. Format: query, expected doc at position N, actual doc at position 1,
   score gap.
7. **Hypotheses**: ranked list of candidate interventions based on patterns
   observed. Each hypothesis includes: what to change, which failure category
   it would fix, estimated impact (number of queries affected), and complexity.

## Implementation

### Approach

One-off TypeScript script at `src/scripts/diagnose-first-result.ts`.

- Connects to Supabase, loads run 16 `per_query_results`
- Runs classification, score analysis, and tag breakdown (all in-memory)
- Writes markdown report to `docs/analysis/first-result-accuracy-run16.md`
- No dependencies beyond what's already in the project (Supabase client, fs)

### Not In Scope

- Changes to the search pipeline
- Changes to eval scoring logic
- Re-running evaluations
- Automated remediation

The script produces understanding. Decisions about what to fix come after
reviewing the report with Adrian.

## Success Criteria

- Every query in run 16 classified into exactly one failure category
- Unjudged winners identified (these are immediate action items)
- At least 3 ranked hypotheses for intervention, grounded in data
- Report is readable and actionable without running any code
