# Production RAG Evaluation — Complete Reference

> Everything needed to build a production-grade evaluation system for RAG. Covers metrics (with formulas), golden dataset design, component-level evaluation, feedback loops, infrastructure, automation, and common pitfalls. Companion to `reference-rag-system-architecture.md` (Section 4) which provides the overview.

---

## Table of Contents

- [Why Eval Matters](#why-eval-matters)
- [Evaluation Levels](#evaluation-levels)
  - [Level 1: Retrieval Quality](#level-1-retrieval-quality)
  - [Level 2: Generation Quality](#level-2-generation-quality)
  - [Level 3: End-to-End](#level-3-end-to-end)
- [Retrieval Metrics Deep Dive](#retrieval-metrics-deep-dive)
  - [Hit Rate](#hit-rate)
  - [First-Result Accuracy](#first-result-accuracy)
  - [Mean Reciprocal Rank (MRR)](#mean-reciprocal-rank-mrr)
  - [Recall](#recall)
  - [Precision](#precision)
  - [Normalized Discounted Cumulative Gain (NDCG)](#normalized-discounted-cumulative-gain-ndcg)
  - [Mean Average Precision (MAP)](#mean-average-precision-map)
  - [Zero-Result Rate](#zero-result-rate)
  - [Latency](#latency)
  - [Choosing Your Metrics](#choosing-your-metrics)
- [Generation Metrics](#generation-metrics)
  - [Faithfulness](#faithfulness)
  - [Answer Relevancy](#answer-relevancy)
  - [LLM-as-Judge](#llm-as-judge)
- [Golden Dataset](#golden-dataset)
  - [What Makes a Good Test Case](#what-makes-a-good-test-case)
  - [Query Categories](#query-categories)
  - [Building From Zero](#building-from-zero)
  - [Sizing Guidelines](#sizing-guidelines)
  - [Growing the Dataset](#growing-the-dataset)
  - [Anti-Patterns](#golden-dataset-anti-patterns)
- [Component-Level Evaluation](#component-level-evaluation)
  - [Chunking Eval](#chunking-eval)
  - [Embedding Eval](#embedding-eval)
  - [Search Eval](#search-eval)
  - [Reranking Eval](#reranking-eval)
- [Eval Runner Architecture](#eval-runner-architecture)
  - [Pure Computation Layer](#pure-computation-layer)
  - [Persistence Layer](#persistence-layer)
  - [Orchestration Layer](#orchestration-layer)
- [Run Comparison and Regression Detection](#run-comparison-and-regression-detection)
  - [Auto-Compare](#auto-compare)
  - [Severity Levels](#severity-levels)
  - [Statistical Significance](#statistical-significance)
- [Feedback Systems](#feedback-systems)
  - [Explicit Feedback](#explicit-feedback)
  - [Implicit Signals](#implicit-signals)
  - [Feedback to Golden Set Pipeline](#feedback-to-golden-set-pipeline)
- [Production Infrastructure](#production-infrastructure)
  - [Database Schema](#database-schema)
  - [Aggregation Pipeline](#aggregation-pipeline)
  - [Scheduled Automation](#scheduled-automation)
  - [CI/CD Integration](#cicd-integration)
- [A/B Testing for RAG](#ab-testing-for-rag)
  - [What to Test](#what-to-test)
  - [Testing Protocol](#testing-protocol)
  - [Interpreting Results](#interpreting-results)
- [Eval Cost](#eval-cost)
- [Common Pitfalls](#common-pitfalls)
- [Tools](#tools)

---

## Why Eval Matters

Without evaluation, every change to your RAG system is a guess. You change the chunking strategy and "it seems better" — but did recall actually improve or did you just test the one query you were thinking about? Eval gives you a number. Numbers can be compared, tracked, and used to make decisions.

**The eval maturity ladder:**

| Level | What you have          | What you know                                            |
|-------|------------------------|----------------------------------------------------------|
| 0     | Nothing                | Nothing — "it seems to work"                             |
| 1     | Auto-logging           | How many searches happen, latency, zero-result rate      |
| 2     | Golden dataset + runner | Precision, recall, hit rate — repeatable scores          |
| 3     | Stored runs + comparison | "Is this version better or worse than last week?"       |
| 4     | Regression detection   | Automatic alerts when quality drops                      |
| 5     | Feedback loop          | Production failures become test cases automatically      |
| 6     | CI/CD gating           | Bad changes can't deploy — eval blocks them              |

Most teams stop at level 2. Production-grade starts at level 3.

---

## Evaluation Levels

### Level 1: Retrieval Quality

**Question:** Did search find the right documents?

This is the foundation. If retrieval fails, nothing downstream matters — the LLM can't generate a good answer from bad context.

| Metric                | What it measures                                       | Target |
|-----------------------|--------------------------------------------------------|--------|
| Hit rate              | % of queries that found at least one expected document | > 90%  |
| First-result accuracy | % of queries where #1 result was the correct document  | > 85%  |
| MRR                   | Average ranking quality (where the right doc appears)  | > 0.7  |
| Recall                | % of all expected documents that were actually found   | > 90%  |
| Zero-result rate      | % of queries that returned nothing                     | < 5%   |

### Level 2: Generation Quality

**Question:** Did the AI give a good answer using what it found?

Only applies if your system generates answers (not just retrieves documents). Requires LLM-based evaluation (LLM-as-judge).

| Metric           | What it measures                                                | Target |
|------------------|-----------------------------------------------------------------|--------|
| Faithfulness     | Is the answer grounded in retrieved context? (no hallucination) | > 85%  |
| Answer relevancy | Does the answer address the actual question?                    | > 80%  |

### Level 3: End-to-End

**Question:** Did the user get what they needed?

The hardest to measure. Requires feedback mechanisms.

| Signal            | How captured                                           | Quality                |
|-------------------|--------------------------------------------------------|------------------------|
| Explicit feedback | User says "right" or "wrong"                           | High accuracy, low volume |
| Implicit signals  | Zero results, retries, low scores, result not used     | Lower accuracy, high volume |

---

## Retrieval Metrics Deep Dive

### Hit Rate

**What:** Percentage of queries where at least one expected document appeared anywhere in the results.

**Formula:**

```
hit_rate = queries_with_at_least_one_hit / total_queries × 100
```

**Example:** 56 test queries. 50 returned at least one expected doc. Hit rate = 89.3%.

**When it matters:** Always — this is the most basic "is search working?" metric.

**Limitation:** Doesn't distinguish between finding the right doc at position 1 vs position 10. A system with 90% hit rate might still be useless if the right doc is always buried at the bottom.

---

### First-Result Accuracy

**What:** Percentage of queries where the #1 result was one of the expected documents.

**Formula:**

```
first_result_accuracy = queries_where_top_result_is_expected / total_queries × 100
```

**When it matters:** Critical when agents act on the top result without reviewing others. If your agent reads only the first search result, this metric determines how often it gets the right context.

**Limitation:** Binary — position 1 gets full credit, position 2 gets zero. Use MRR for a smoother ranking signal.

---

### Mean Reciprocal Rank (MRR)

**What:** Average of the reciprocal of the position where the first correct result appears. Captures *where* the right document appears, not just *whether* it appears.

**Formula:**

```
reciprocal_rank(query) = 1 / position_of_first_correct_result
                       = 0  if no correct result found

MRR = average(reciprocal_rank) across all queries
```

**Example:**

| Query | First correct at position | Reciprocal rank |
|-------|---------------------------|-----------------|
| q1    | 1                         | 1/1 = 1.000     |
| q2    | 3                         | 1/3 = 0.333     |
| q3    | not found                 | 0               |
| q4    | 2                         | 1/2 = 0.500     |

MRR = (1.0 + 0.333 + 0 + 0.5) / 4 = **0.458**

**Interpretation:**

| MRR   | Meaning                                                          |
|-------|------------------------------------------------------------------|
| 1.0   | Perfect — correct doc always at position 1                       |
| 0.5   | Right doc averages position 2                                    |
| 0.33  | Right doc averages position 3                                    |
| < 0.2 | Right doc usually below position 5 — likely useless for agents   |

**When it matters:** When you care about ranking quality, not just retrieval. Two systems with identical hit rate can have very different MRR — the one with higher MRR puts the right doc closer to the top.

---

### Recall

**What:** Percentage of all expected documents across all queries that were actually found in results.

**Formula:**

```
recall = total_expected_docs_found / total_expected_docs × 100
```

**Example:** 56 queries expect a total of 95 document appearances (some queries expect multiple docs). 70 of those were actually found. Recall = 73.7%.

**When it matters:** For multi-document queries — "find all docs about authentication" expects 3 docs, but search only finds 2. Hit rate says "success" (at least one found), recall says "67% — missed one."

**Limitation:** Doesn't penalize irrelevant results. A system that returns everything has 100% recall but terrible precision.

---

### Precision

**What:** Percentage of returned results that are actually relevant.

**Formula:**

```
precision = relevant_results_returned / total_results_returned × 100
```

**When it matters:** When result count matters — agents that process all results waste tokens on irrelevant context. High precision means less noise.

**Limitation:** Requires knowing which results are relevant (not just which are expected). Harder to annotate than recall.

**Note:** For most RAG systems with a golden dataset of expected documents, recall and hit rate are more practical than precision. Precision requires labeling every result as relevant/irrelevant, not just checking if expected docs appeared.

---

### Normalized Discounted Cumulative Gain (NDCG)

**What:** Measures ranking quality with graded relevance (not just relevant/irrelevant). Documents at higher positions contribute more to the score.

**Formula:**

```
DCG  = Σ (relevance_i / log2(position_i + 1))    for each result
IDCG = DCG of the ideal ranking (most relevant first)
NDCG = DCG / IDCG
```

**When it matters:** When you have graded relevance (highly relevant, somewhat relevant, marginally relevant) rather than binary (relevant/not). More common in web search than RAG systems.

**For most RAG systems:** MRR is simpler and sufficient. Use NDCG only if you need graded relevance scoring.

---

### Mean Average Precision (MAP)

**What:** Average of the precision at each position where a relevant document appears.

**Formula:**

```
average_precision(query) = Σ (precision_at_k × is_relevant_at_k) / total_relevant_for_query

MAP = average(average_precision) across all queries
```

**When it matters:** Multi-document queries where you care about finding all relevant docs and ranking them well. MAP rewards systems that put all relevant docs near the top.

**For most RAG systems:** MRR + recall covers 90% of use cases. MAP adds value when many queries expect 3+ relevant documents.

---

### Zero-Result Rate

**What:** Percentage of queries that returned no results at all.

**Formula:**

```
zero_result_rate = queries_with_zero_results / total_queries × 100
```

**When it matters:** Always — a search that returns nothing is a complete failure. The user gets no information. High zero-result rate means either the content doesn't exist, the chunking is too aggressive, or the threshold is too high.

**Target:** < 5%. Above 10% is critical.

---

### Latency

**What:** Time from query submission to results returned (milliseconds).

**What to track:**

| Percentile | What it tells you              | Target  |
|------------|--------------------------------|---------|
| p50        | Typical experience             | < 500ms |
| p95        | Worst-case for most users      | < 2s    |
| p99        | Tail latency — outliers        | < 5s    |

**Components to break down:**
- Embedding generation (OpenAI API call) — usually 100-400ms
- Vector search (HNSW) — usually 5-50ms
- Keyword search (GIN) — usually 5-20ms
- RRF fusion — <1ms
- Reranking (if used) — 50-500ms depending on model

---

### Choosing Your Metrics

Not every metric matters for every system. Choose based on how your system is used:

| System type                           | Primary metrics                    | Secondary               |
|---------------------------------------|------------------------------------|-------------------------|
| **Agent reads top result only**       | First-result accuracy, MRR         | Hit rate, latency       |
| **Agent reads top 3-5 results**       | Hit rate, MRR, recall              | Precision, latency      |
| **Agent uses all results as context** | Recall, zero-result rate           | Precision, latency      |
| **User browses results**              | MRR, NDCG                         | Precision, recall       |
| **Generation pipeline (RAG + LLM)**  | Faithfulness, answer relevancy     | All retrieval metrics   |

**Start with:** Hit rate + first-result accuracy + recall + MRR + zero-result rate. Add others as needed.

---

## Generation Metrics

Only relevant if your RAG system generates answers, not just retrieves documents. These require LLM-based evaluation (an LLM judges the output of another LLM).

### Faithfulness

**What:** Is the answer grounded in the retrieved context, or did the LLM hallucinate?

**How to measure (LLM-as-judge):**

```
Prompt:
  Given the following context and answer, identify any claims
  in the answer that are NOT supported by the context.

  Context: {retrieved_chunks}
  Answer: {generated_answer}

  For each claim, mark as SUPPORTED or UNSUPPORTED.

  faithfulness = supported_claims / total_claims
```

**Target:** > 85%. Below 70% means the system is actively misleading users.

### Answer Relevancy

**What:** Does the answer actually address the question, or did it go off-topic?

**How to measure (LLM-as-judge):**

```
Prompt:
  Given the question and the answer, rate how well the answer
  addresses the question on a scale of 1-5.

  Question: {query}
  Answer: {generated_answer}

  5 = Directly and completely answers the question
  4 = Mostly answers the question with minor gaps
  3 = Partially relevant but missing key information
  2 = Tangentially related but doesn't answer the question
  1 = Completely irrelevant

  answer_relevancy = avg(scores) / 5
```

### LLM-as-Judge

Using an LLM to evaluate another LLM's output. The standard approach for generation quality metrics.

**Best practices:**

| Practice                         | Why                                                                                   |
|----------------------------------|---------------------------------------------------------------------------------------|
| Use a stronger model as judge    | GPT-4/Claude as judge for GPT-3.5 outputs — weaker models miss subtle errors          |
| Use structured output            | Parse scores from JSON, not free text — avoids parsing failures                        |
| Run multiple judgments            | 3 judgments per case, take majority — reduces noise                                    |
| Include reference answer         | When available, give the judge the expected answer for comparison                      |
| Evaluate atomic claims           | Break answer into individual claims and judge each — more precise than holistic scoring |

**Cost:** LLM-as-judge is expensive. Each evaluation case requires 1-3 LLM calls. A 56-case golden dataset with 3 judgments per case = 168 LLM calls per eval run. Budget accordingly.

**When to skip:** If your system only retrieves documents (no answer generation), skip generation metrics entirely. Focus on retrieval quality.

---

## Golden Dataset

The foundation of repeatable evaluation. Without it, you're testing ad-hoc queries and hoping they're representative.

### What Makes a Good Test Case

```
{
  "query":            "How does hybrid search combine results?",
  "expected_doc_ids": [139],
  "tags":             ["technical", "search"],
  "expected_answer":  "Hybrid search uses RRF fusion..."  // optional
}
```

| Field              | Required? | Purpose                                                       |
|--------------------|-----------|---------------------------------------------------------------|
| `query`            | Yes       | The search query — should be realistic, not synthetic-sounding |
| `expected_doc_ids` | Yes       | Which document(s) should appear in results                    |
| `tags`             | Yes       | Categories for per-type analysis                              |
| `expected_answer`  | No        | Only needed for generation quality eval                       |

**A good test case:**
- Uses natural language a real user/agent would type
- Has unambiguous expected documents (you can objectively verify)
- Is tagged for category analysis
- Tests one thing (simple) or a specific combination (multi-doc, cross-domain)

### Query Categories

| Category        | What it tests                                                     | Example                                              |
|-----------------|-------------------------------------------------------------------|------------------------------------------------------|
| **simple**      | Direct lookup — query maps clearly to one document                | "What is the database schema?"                       |
| **conceptual**  | Meaning-based — requires understanding, not keyword match         | "How does the system remember things?"               |
| **exact-term**  | Specific identifiers — tests keyword search                       | "pgvector HNSW ef_construction"                      |
| **multi-doc**   | Expects multiple documents in results                             | "Code review skills and evaluation results"          |
| **cross-domain** | Spans categories/domains                                         | "How do agents interact with the knowledge base?"    |
| **out-of-scope** | No answer exists — should return nothing or low-confidence results | "What is the recipe for chocolate cake?"             |
| **adversarial** | Tricky queries that might fool the system                         | "Not about databases" (should not match DB docs)     |
| **paraphrase**  | Same question, different wording — tests semantic understanding   | "DB layout" vs "database schema"                     |
| **temporal**    | Asks about recent/changing state                                  | "What was changed last session?"                     |

### Building From Zero

| Phase                    | What to do                                                                                                           | Volume  |
|--------------------------|----------------------------------------------------------------------------------------------------------------------|---------|
| **1. Seed**              | Write 30-50 test cases by hand from real use cases. Use actual queries from your search logs if available.            | 30-50   |
| **2. Cover categories**  | Ensure every category above has at least 3-5 cases. Look for gaps.                                                   | 50-80   |
| **3. Expand critical paths** | Add more cases for your most important query types (whatever users search most).                                  | 80-100  |
| **4. Add edge cases**    | Out-of-scope, adversarial, paraphrase variants.                                                                      | 100-120 |
| **5. Synthetic expansion** | Use LLM to generate variations: "Given this query, generate 3 paraphrases." Human-review each.                    | 120-200 |

### Sizing Guidelines

| Corpus size | Golden dataset size  | Why                                             |
|-------------|----------------------|-------------------------------------------------|
| < 50 docs   | 30-50 test cases     | Small corpus — exhaustive coverage possible     |
| 50-200 docs | 50-100 test cases    | 1-2 test cases per document                     |
| 200-1000 docs | 100-200 test cases | Cover every category, sample documents          |
| 1000+ docs  | 200-500 test cases   | Statistical significance requires volume        |

**Rule of thumb:** minimum 5 test cases per query category, minimum 30 total. Below that, random variation dominates and metrics are unreliable.

### Growing the Dataset

The golden dataset should grow from production data, not just manual curation:

```
Production search
       │
       ▼
Auto-logged to search_evaluations
       │
       ▼
Weekly review:
  - Zero-result queries → new out-of-scope or missing-content cases
  - Low-score queries → investigate and add as test cases
  - Explicit "wrong result" feedback → add as test cases
  - Repeated searches (same user, rephrased) → paraphrase category
       │
       ▼
Human labels expected docs → add to eval_golden_dataset
       │
       ▼
Next eval run uses expanded dataset
```

**Monthly growth target:** 5-10 new test cases from production failures. After 6 months you should have 80-120 production-sourced cases supplementing the original seed set.

### Golden Dataset Anti-Patterns

| Anti-pattern                        | Why it's bad                                                                          | Fix                                                                                      |
|-------------------------------------|---------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------|
| All queries are simple lookups      | Doesn't test conceptual search, the hardest part                                      | Add conceptual, multi-doc, cross-domain categories                                       |
| Expected docs are wrong             | Eval score is meaningless if labels are incorrect                                      | Review labels quarterly — docs get updated, IDs change                                   |
| No out-of-scope cases               | Can't detect false positives — system returns nonsense confidently                    | Add 5-10% out-of-scope queries                                                           |
| Synthetic queries without review    | LLM-generated queries are often too clean or too weird                                | Human review every synthetic case                                                        |
| Never updated                       | Corpus changes but test cases don't — testing against stale expectations              | Review after every major content change                                                  |
| Testing with same data used to tune | Overfitting — eval says great, production says otherwise                              | Hold out 20% of cases for validation (never tune against them)                           |

---

## Component-Level Evaluation

End-to-end metrics tell you *what's* wrong. Component-level eval tells you *where*.

### Chunking Eval

**Question:** Are chunks the right size and splitting at the right boundaries?

| Signal                              | How to check                                                                | What it means                                                       |
|-------------------------------------|-----------------------------------------------------------------------------|---------------------------------------------------------------------|
| Boundary cuts                       | Manual review — do chunks break mid-sentence, mid-paragraph?                | Bad splits lose context                                             |
| Chunk size distribution             | Histogram of chunk lengths                                                  | Very short chunks (<50 tokens) may lack context; very long (>1000) may be too broad |
| Expected doc found but wrong chunk  | Eval returns right doc but matched on irrelevant chunk                      | Content is there but chunking isn't creating good search units      |

**How to test chunking changes:**
1. Re-chunk all documents with new strategy
2. Re-embed all chunks
3. Run eval suite
4. Compare recall and MRR — chunking affects which chunks match, changing ranking

### Embedding Eval

**Question:** Is the embedding model capturing meaning well?

| Signal                                    | How to check                                                                                      |
|-------------------------------------------|---------------------------------------------------------------------------------------------------|
| Similar queries return different results  | Paraphrase test — "DB schema" and "database structure" should return same docs                    |
| Unrelated queries return same results     | Adversarial test — "recipe for cookies" should not match database docs                            |
| Cosine similarity distribution            | Plot scores — bimodal (relevant clusters vs irrelevant) is good; uniform is bad                   |

**How to compare embedding models:**
1. Keep everything else constant (chunking, search, threshold)
2. Re-embed all chunks with new model
3. Run eval suite
4. Compare MRR and recall — embedding quality directly affects ranking

### Search Eval

**Question:** Is the search pipeline (vector + keyword + fusion) finding the right docs?

This is what the standard eval runner measures. Key levers:

| Lever     | What to test                      | Eval metric to watch                                                   |
|-----------|-----------------------------------|------------------------------------------------------------------------|
| Threshold | 0.15 vs 0.20 vs 0.25 vs 0.30     | Zero-result rate (lower threshold = fewer zeros, more noise)           |
| RRF k     | 20 vs 60 vs 100                   | MRR (k affects how much keyword vs vector contributes)                 |
| Top-K     | 5 vs 10 vs 20                     | Recall (more results = more chances to find expected docs)             |
| Search mode | Vector only vs keyword only vs hybrid | All metrics (hybrid should beat either alone)                      |

### Reranking Eval

**Question:** Does reranking improve the order of results?

**Protocol:**
1. Run eval without reranker — record MRR and first-result accuracy
2. Add reranker to pipeline
3. Run eval again — same golden dataset
4. Compare MRR (should increase) and latency (will increase)

**What a good reranker does:** Takes position-3 hits and moves them to position-1. Hit rate stays the same (same docs found), but MRR and first-result accuracy jump.

**What to watch:** Reranking adds latency (50-500ms per query). If latency matters, the MRR gain must justify the cost.

---

## Eval Runner Architecture

Separate concerns into three layers:

```
┌─────────────────────────────────────────────┐
│  Pure Computation Layer                      │
│  Types, scoring, metrics, formatting         │
│  No I/O — testable with unit tests           │
│                                              │
│  scoreTestCase()  computeMetrics()           │
│  formatReport()   compareRuns()              │
└──────────────────────┬──────────────────────┘
                       │
┌──────────────────────▼──────────────────────┐
│  Persistence Layer                           │
│  Save/load eval runs to database             │
│  Thin — just serialization + DB calls        │
│                                              │
│  saveEvalRun()  loadPreviousRun()            │
└──────────────────────┬──────────────────────┘
                       │
┌──────────────────────▼──────────────────────┐
│  Orchestration Layer                         │
│  Load golden dataset, run queries, wire      │
│  computation + persistence + comparison      │
│                                              │
│  eval-search.ts (thin script)                │
└─────────────────────────────────────────────┘
```

### Pure Computation Layer

All scoring and metric computation as pure functions. No database calls, no side effects. This is where unit tests live.

**Key functions:**

| Function        | Input                                 | Output                                             |
|-----------------|---------------------------------------|----------------------------------------------------|
| `scoreTestCase` | Test case + search results + timing   | Scored result (hit, position, MRR, etc.)           |
| `computeMetrics` | Array of scored results              | Aggregate metrics (hit rate, MRR, recall, etc.)    |
| `formatReport`  | Metrics                               | Human-readable string                              |
| `compareRuns`   | Current metrics + previous metrics    | Comparison with severity level                     |

**Why separate:** Testable without a database. You can write 20 unit tests covering edge cases (out-of-scope, multi-doc, zero results) without any I/O.

### Persistence Layer

Save eval runs and load previous runs. Thin wrapper around database operations.

**What to store per run:**

| Field             | Why                                                           |
|-------------------|---------------------------------------------------------------|
| Config snapshot   | Reproduce any run — threshold, model, chunking, RRF k        |
| Aggregate metrics | The headline numbers — hit rate, MRR, recall                  |
| Per-tag breakdown | Which categories improved/regressed                           |
| Per-query results | Drill into specific failures                                  |
| Missed queries    | Action list — what to fix next                                |

### Orchestration Layer

The script that wires everything together. Should be ~50-80 lines:

```
1. Load previous run (for comparison)
2. Load golden dataset from database
3. For each test case:
   a. Run search
   b. Score the result
   c. Print progress
4. Compute aggregate metrics
5. Print report
6. Save run to database
7. Compare against previous run
8. Print comparison + severity
```

---

## Run Comparison and Regression Detection

### Auto-Compare

After every eval run, automatically compare against the previous run. The output should make "better or worse?" instantly obvious:

```
COMPARISON:
  hit_rate:              88.5% → 92.0%  (+3.5%)
  first_result_accuracy: 46.2% → 55.0%  (+8.8%)
  recall:                73.7% → 80.0%  (+6.3%)
  mrr:                   0.583 → 0.650  (+0.067)
  zero_result_rate:       0.0% →  0.0%  (unchanged)
  avg_response_time_ms:  958   → 1024   (+66ms)

  Verdict: ALL IMPROVED
```

### Severity Levels

| Severity     | Condition                                | Action                            |
|--------------|------------------------------------------|-----------------------------------|
| **ok**       | All metrics stable or improved           | Deploy confidently                |
| **warning**  | Any metric dropped > 2% from previous run | Investigate — may be noise or real |
| **block**    | Any metric dropped > 5% from baseline    | Do not deploy — revert the change |
| **critical** | Hit rate < 80% or zero-result rate > 10% | Something is broken — fix immediately |

**Inverted metrics:** For zero-result rate and latency, *lower* is better. A comparison function must account for this — a decrease in zero-result rate is an improvement, not a regression.

### Statistical Significance

With small golden datasets (< 100 cases), random variation can produce 2-3% swings between runs even with no actual change. Before reacting to a regression:

**Quick check:** Run the eval twice with no changes. If the metrics differ by more than 1-2%, your dataset is too small for that precision level.

**Rules of thumb:**

| Golden dataset size | Meaningful difference |
|---------------------|-----------------------|
| 30-50 cases         | > 5% change           |
| 50-100 cases        | > 3% change           |
| 100-200 cases       | > 2% change           |
| 200+ cases          | > 1% change           |

**If you need formal testing:** Bootstrap confidence intervals — resample your test cases with replacement 1000 times, compute metrics on each resample, check if the confidence intervals of two runs overlap. If they don't overlap, the difference is real.

---

## Feedback Systems

### Explicit Feedback

Users or agents mark results as relevant/irrelevant. Most accurate signal but lowest volume.

**Implementation:** Add a feedback field to search evaluations, plus an API endpoint/MCP tool to record it:

| Field            | What                                          |
|------------------|-----------------------------------------------|
| `search_eval_id` | FK to the original search_evaluations row     |
| `feedback`       | relevant, irrelevant, partial                 |
| `agent`          | Who gave the feedback                         |

### Implicit Signals

Patterns that suggest search quality without explicit feedback:

| Signal              | What it means                                        | How to detect                                    |
|---------------------|------------------------------------------------------|--------------------------------------------------|
| Zero results        | Total search failure                                 | `result_count = 0`                               |
| Repeated search     | User retried with different words — first search failed | Same agent, same session, <5 min apart        |
| Low top score       | Best result barely matched                           | `results[0].score < 0.3`                         |
| Result not used     | Agent searched but didn't use any result             | Requires downstream tracking                     |
| Immediate re-search | Search → different search in <10 seconds             | Timestamp analysis                               |

### Feedback to Golden Set Pipeline

Production failures should become test cases:

```
1. Weekly: query search_evaluations for:
   - Zero-result queries (> 3 occurrences)
   - Queries with explicit "irrelevant" feedback
   - Queries with low scores (top result < 0.3)

2. Human review:
   - Is there a document that SHOULD match this query?
   - If yes → create golden dataset entry (query + expected_doc_id)
   - If no → is the query out-of-scope? Add as out-of-scope test case
   - If no → is content missing? Flag as content gap (different problem)

3. Insert into eval_golden_dataset

4. Next eval run uses the expanded dataset
```

---

## Production Infrastructure

### Database Schema

Three tables support the eval system:

| Table                            | Purpose                               | Retention                    |
|----------------------------------|---------------------------------------|------------------------------|
| `search_evaluations`             | Raw search logs (every search)        | 30 days (aggregated then purged) |
| `search_evaluation_aggregates`   | Daily summaries                       | Indefinite                   |
| `eval_golden_dataset`            | Test cases                            | Indefinite (growing)         |
| `eval_runs`                      | Stored eval results                   | Indefinite                   |

See `reference-rag-database-schemas.md` for full CREATE TABLE SQL.

### Aggregation Pipeline

Raw search logs are high-volume. Aggregate daily, then purge raw rows:

```
search_evaluations (raw, per-query)
         │
         ▼  aggregate_search_evaluations(p_date)  — daily cron
search_evaluation_aggregates (one row per day)
         │
         ▼  cleanup_search_evaluations(p_older_than)  — daily cron, after aggregation
[raw rows older than 30 days deleted]
```

**What the aggregate captures per day:**
- Total search count
- Average result count, response time, score
- Zero-result count and rate
- Searches by mode (vector/keyword/hybrid)
- Top document types in results
- Feedback breakdown (relevant/irrelevant/partial/none)

### Scheduled Automation

| Job                | Frequency                 | What it does                                                           |
|--------------------|---------------------------|------------------------------------------------------------------------|
| Aggregation        | Daily                     | `aggregate_search_evaluations()` — crunch raw logs                     |
| Raw cleanup        | Daily (after aggregation) | `cleanup_search_evaluations('30 days')` — delete old raw rows          |
| Eval suite         | Weekly or on code change  | Run golden dataset, save to `eval_runs`, compare to previous           |
| Golden set growth  | Monthly                   | Review production failures, add new test cases                         |
| Label validation   | Quarterly                 | Review expected_doc_ids — docs change, IDs shift                       |

### CI/CD Integration

For automated deployments, the eval runner can gate changes:

```
Code change committed
         │
         ▼
Run eval suite (golden dataset)
         │
         ▼
Compare against baseline
         │
    ┌────┴────┐
    ▼         ▼
 All metrics    Any metric
 stable or      dropped > 5%
 improved       from baseline
    │               │
    ▼               ▼
 Deploy          Block deploy
 Update          Alert team
 baseline        Investigate
```

**Baseline vs previous run:** Comparison against baseline (a manually-blessed checkpoint) is more stable than comparing to the previous run. Baselines are updated after deliberate improvements, not after every run.

---

## A/B Testing for RAG

### What to Test

Ordered by typical impact (highest first):

| Lever                  | What to change                           | What improves                    | Typical impact                   |
|------------------------|------------------------------------------|----------------------------------|----------------------------------|
| Reranker               | None vs cross-encoder                    | Precision, first-result accuracy | Biggest single gain              |
| Contextual retrieval   | With vs without context prepend on chunks | Recall, precision               | ~49% fewer failed retrievals     |
| Chunking strategy      | Paragraph vs recursive vs semantic       | All metrics                      | Varies by content type           |
| Embedding model        | OpenAI vs Voyage vs BGE-M3              | Precision, cost                  | Model-dependent                  |
| Chunk size             | 256 vs 512 vs 1024 tokens               | Recall                           | Smaller = more precise           |
| Similarity threshold   | 0.15 vs 0.20 vs 0.25 vs 0.30            | Precision/recall tradeoff        | Lower = more results, more noise |
| RRF k                  | 20 vs 60 vs 100                          | Vector vs keyword weight         | Subtle                           |
| Top-K                  | 5 vs 10 vs 20                            | Coverage vs noise                | More = more context              |
| Chunk overlap          | 0% vs 10% vs 20%                        | Recall at boundaries             | Small effect                     |

### Testing Protocol

```
1. BASELINE
   Run golden dataset with current settings
   Save run to eval_runs (this is the baseline)

2. CHANGE ONE VARIABLE
   Example: threshold from 0.25 → 0.20
   Keep everything else identical

3. RUN EVAL
   Same golden dataset, same metrics
   Save run to eval_runs

4. COMPARE
   Auto-compare shows diff for every metric
   Look at per-tag breakdown — did all categories improve or just some?

5. DECIDE
   All improved → deploy, update baseline
   Mixed → investigate which queries improved/degraded
   All worse → revert, try a different lever

6. NEVER CHANGE TWO THINGS AT ONCE
   If you change threshold AND chunking, you can't tell which
   one caused the improvement. One variable at a time.
```

### Interpreting Results

| Result                         | What it means                                          | What to do                                                |
|--------------------------------|--------------------------------------------------------|-----------------------------------------------------------|
| Precision up, recall same      | Less noise without losing coverage                     | Deploy — clear win                                        |
| Recall up, precision down      | Finding more docs but also more irrelevant ones        | Add reranking to filter noise                             |
| First-result accuracy up       | Top result improved — agents perform better            | Deploy — high-value improvement                           |
| Zero-result rate down          | Fewer failed searches                                  | Deploy — users were hitting dead ends                     |
| All metrics down               | The change made things worse                           | Revert immediately                                        |
| Mixed by query type            | Some categories improved, others degraded              | Consider per-category settings                            |
| MRR up, hit rate same          | Right docs moving higher in results                    | Deploy — ranking improvement                              |
| Latency up significantly       | New component (reranker) adding delay                  | Evaluate if MRR gain justifies the latency cost           |

---

## Eval Cost

Running eval has real costs. Budget for them:

| Component                                  | Cost per eval run          | Notes                                                |
|--------------------------------------------|----------------------------|------------------------------------------------------|
| **Embedding API calls**                    | 1 call per test case       | ~$0.001 per query (text-embedding-3-small)           |
| **Search queries**                         | N database queries         | Minimal — internal to your infrastructure            |
| **LLM-as-judge** (generation eval only)    | 1-3 calls per test case    | ~$0.01-0.10 per case depending on model              |
| **Total (retrieval only, 56 cases)**       | ~$0.06                     | Negligible                                           |
| **Total (with generation eval, 56 cases)** | ~$1-6                      | Per run — weekly = $4-24/month                       |

**Optimization:** Cache query embeddings. If the same golden dataset query is run weekly, the embedding is identical each time. Query cache eliminates repeat API calls.

---

## Common Pitfalls

| Pitfall                                  | Why it happens                                                                                                  | Fix                                                                                    |
|------------------------------------------|-----------------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------|
| **Eval without baseline**                | Ran eval once, got 85% hit rate — is that good? No reference point.                                             | Always save your first run as the baseline before changing anything                    |
| **Tuning against full dataset**          | Used all 56 cases to tune threshold, then "eval'd" against the same 56 — of course it improved                 | Hold out 20% of cases — never tune against them                                        |
| **Ignoring per-tag breakdown**           | Overall hit rate went up 3%, but conceptual queries dropped 10%                                                 | Always check tag-level metrics, not just aggregate                                     |
| **Measuring the wrong level**            | Obsessing over retrieval metrics when the real problem is generation quality                                     | Match eval level to where failures happen                                              |
| **Not re-validating labels**             | Expected doc IDs from 3 months ago — documents have been renamed, merged, deleted                               | Review labels quarterly                                                                |
| **Comparing against wrong baseline**     | Compared to previous run (which was also broken) instead of last-known-good                                     | Maintain a blessed baseline separately from recent runs                                |
| **Treating small differences as real**   | "Hit rate went from 88.5% to 86.0% — regression!" With 56 cases that's 1 extra miss.                           | Know your statistical precision (see significance section)                             |
| **Eval as afterthought**                 | Built search, chunking, reranking — then tried to add eval. Had to retrofit everything.                         | Add eval before optimizing. Measure, then improve.                                     |
| **Console-only reporting**               | Results printed and gone. No history, no comparison.                                                            | Store every run to database from day one                                               |

---

## Tools

| Tool              | What it does                                                          | Best for                                     |
|-------------------|-----------------------------------------------------------------------|----------------------------------------------|
| **RAGAS**         | LLM-based metrics (faithfulness, relevancy), synthetic test generation | Generation quality eval                      |
| **DeepEval**      | Golden dataset synthesis, CI/CD integration, pytest plugin            | CI/CD gating, synthetic data                 |
| **LangSmith**     | Tracing + evaluation in one platform, dataset management              | Full observability + eval                    |
| **Arize Phoenix** | Embedding visualization, drift detection, production monitoring       | Monitoring + debugging                       |
| **TruLens**       | Feedback functions, groundedness checks, dashboard                    | Generation grounding eval                    |
| **Braintrust**    | Prompt playground, eval framework, logging                            | Prompt iteration + eval                      |
| **Built-in**      | eval_runs table + eval runner script                                  | Retrieval eval without external dependencies |

**When to use external tools vs built-in:**

| Situation                                    | Use                                                     |
|----------------------------------------------|---------------------------------------------------------|
| Retrieval-only system, < 200 docs            | Built-in (eval_runs table + runner script)              |
| Need generation quality metrics              | RAGAS or DeepEval (LLM-as-judge built in)               |
| Need CI/CD gating                            | DeepEval (pytest plugin) or built-in (script in CI)     |
| Need embedding visualization                 | Arize Phoenix                                           |
| Need full observability + eval               | LangSmith or Langfuse                                   |
| Budget-constrained                           | Built-in (free, no external dependencies)               |
