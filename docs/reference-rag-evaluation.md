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
- [Building Your Eval System Step by Step](#building-your-eval-system-step-by-step)
- [Eval Runner Architecture](#eval-runner-architecture)
  - [Pure Computation Layer](#pure-computation-layer)
  - [Persistence Layer](#persistence-layer)
  - [Orchestration Layer](#orchestration-layer)
- [Ledger Implementation](#ledger-implementation)
  - [File Map](#file-map)
  - [What Triggers It](#what-triggers-it)
  - [End-to-End Flow](#end-to-end-flow)
  - [Current Gaps](#current-gaps)
  - [Using Eval to Tune Search](#using-eval-to-tune-search)
- [Run Comparison and Regression Detection](#run-comparison-and-regression-detection)
  - [Auto-Compare](#auto-compare)
  - [Severity Levels](#severity-levels)
  - [Statistical Significance](#statistical-significance)
- [Advanced Analysis](#advanced-analysis)
  - [Confidence Intervals (Bootstrap)](#confidence-intervals-bootstrap)
  - [Score Calibration](#score-calibration)
  - [Coverage Analysis](#coverage-analysis)
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

**What:** Measures ranking quality across *all* result positions. Unlike MRR (which only cares about the first correct result), NDCG penalizes systems that find the right documents but rank them poorly.

**Formula:**

```
DCG  = Σ (relevance_i / log2(position_i + 2))    for each result (0-indexed)
IDCG = DCG of the ideal ranking (all relevant docs first)
NDCG = DCG / IDCG                                (0 to 1 scale)
```

The `log2(position + 2)` is the "discount" — results lower in the list contribute less to the score. Position is 0-indexed, so we add 2 to avoid `log2(1) = 0`.

**Example — why NDCG catches what MRR misses:**

A query expects docs [5, 10, 15]. Search returns them at positions 1, 8, 9.

| Metric | Score  | What it tells you                                       |
|--------|--------|---------------------------------------------------------|
| MRR    | 1.0    | "Perfect" — doc 5 was at position 1                     |
| NDCG   | ~0.65  | "Not great" — docs 10 and 15 were buried at positions 8-9 |

MRR says everything is fine because it only checks the first hit. NDCG reveals that the other relevant documents are poorly ranked — an agent using multiple results would get bad context.

**Binary vs graded relevance:**

NDCG works with both:

| Relevance model | How it works                                                  | When to use                       |
|-----------------|---------------------------------------------------------------|-----------------------------------|
| **Binary**      | Relevance = 1 if doc is in expected list, 0 otherwise         | Most RAG systems, golden datasets with expected_doc_ids |
| **Graded**      | Relevance = 0 (irrelevant), 1 (related), 2 (exact match)     | When you can distinguish "close" from "perfect" answers |

Binary NDCG is valuable even without graded relevance — it catches multi-document ranking issues that MRR misses entirely. Start with binary, upgrade to graded when your golden dataset supports it.

**Interpretation:**

| NDCG    | Meaning                                                     |
|---------|-------------------------------------------------------------|
| 1.0     | Perfect — all relevant docs ranked at the top               |
| 0.8+    | Good — relevant docs mostly near the top                    |
| 0.5-0.8 | Fair — relevant docs found but some ranked poorly           |
| < 0.5   | Poor — relevant docs consistently buried in results         |

**When it matters:** Always for multi-document queries (queries expecting 2+ results). For single-document queries, NDCG equals MRR. If most of your queries expect a single document, MRR is sufficient and NDCG adds little. If you have multi-document queries, add NDCG.

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

| System type                           | Primary metrics                    | Secondary                |
|---------------------------------------|------------------------------------|--------------------------|
| **Agent reads top result only**       | First-result accuracy, MRR         | Hit rate, latency        |
| **Agent reads top 3-5 results**       | Hit rate, MRR, NDCG, recall        | Precision, latency       |
| **Agent uses all results as context** | Recall, NDCG, zero-result rate     | Precision, latency       |
| **User browses results**              | MRR, NDCG                          | Precision, recall        |
| **Generation pipeline (RAG + LLM)**   | Faithfulness, answer relevancy     | All retrieval metrics    |
| **Multi-doc queries common**          | NDCG, recall                       | MRR, hit rate            |

**Start with:** Hit rate + first-result accuracy + recall + MRR + zero-result rate. Add NDCG when you have multi-document queries. Add confidence intervals when you need to know if metric changes are real.

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

#### What a reranker is

A reranker sits between search and the final results. Search finds 20 candidate documents fast (using embeddings and keywords). The reranker then reads each candidate alongside the original query and re-scores them based on whether they actually answer the question — not just whether they contain similar words. It reorders the list and returns the top 10.

It doesn't find new documents. It doesn't remove documents. It doesn't change their content. It just puts them in a better order.

```
Without reranker:   Query → fast search → top 10 (dumb ranking)
With reranker:      Query → fast search → top 20 → reranker reads each one → top 10 (smart ranking)
```

#### Where it sits in the pipeline

```
Query → Embed (OpenAI) → Vector search + Keyword search → RRF fusion → Top 20 candidates
  → RERANKER (cross-encoder) → Re-score each candidate → Return top 10
```

The reranker is a language model trained on millions of "query + document" pairs labeled relevant or not. It reads both texts together (unlike embeddings which encode them separately) and scores how well the document answers the query. This is slower (one model call per candidate) but much more accurate than comparing number arrays.

#### Why you'd want one

When eval shows that relevant and irrelevant documents score almost the same (small score separation), search is finding the right docs but ranking them poorly. A reranker fixes ranking without needing to change embeddings, chunks, or search logic.

#### Eval protocol

1. Run eval without reranker — record MRR and first-result accuracy
2. Add reranker to pipeline
3. Run eval again — same golden dataset
4. Compare MRR (should increase) and latency (will increase)

**What a good reranker does:** Takes position-3 hits and moves them to position-1. Hit rate stays the same (same docs found), but MRR and first-result accuracy jump.

**What to watch:** Reranking adds latency (50-500ms per query). If latency matters, the MRR gain must justify the cost.

#### Data privacy concern

Most hosted reranker APIs (Cohere, Jina, etc.) use your data for model training on their free tiers. If your documents contain sensitive or personal content, this matters. Options:

- **Paid API tier** — most providers stop using your data for training on paid plans. Verify per provider.
- **Self-hosted model** — run an open-source cross-encoder locally (e.g. `cross-encoder/ms-marco-MiniLM-L-6-v2`, ~80MB). No data leaves your machine, but requires CPU/GPU resources. On CPU-only machines expect ~200-500ms per rerank for 20 candidates — usable but slower than hosted APIs.
- **No discrete GPU** — without NVIDIA/CUDA, local models run on CPU only (10-20x slower than GPU). Integrated GPUs (AMD Radeon, Intel Iris) have limited ML framework support.

Always check the provider's data usage policy before sending document content through their API.

---

## Building Your Eval System Step by Step

If you're starting from scratch or hardening an existing eval, build these pieces in order. Each step depends on the one before it.

### Step 1: Metrics

Before you can store or compare anything, you need to compute it. Define the scoring functions that take search results and produce numbers — hit rate, recall, MRR (Mean Reciprocal Rank), first-result accuracy, zero-result rate.

These should be **pure functions** — no database, no API calls, just input and output. This makes them testable with unit tests and reusable by any consumer (script, CLI command, CI pipeline).

**Why first:** Every later step stores, compares, or displays metrics. If metrics aren't defined yet, there's nothing to store or compare. If you add a metric *after* you start storing runs, the early runs won't have it and comparisons won't work cleanly.

### Step 2: Persistence

Right now your eval prints numbers to the terminal. Close the terminal, numbers are gone. Next week you run it again — you have no idea what last week's numbers were.

Build two functions:
- **Save** — after computing metrics, write them to a database table. Every run becomes a row: timestamp, config snapshot, metrics, per-query detail.
- **Load** — fetch the most recent row. This is how you'll answer "what were the numbers last time?"

Think of it like a test report that gets filed, not thrown away. You can go back to any previous run and see exactly what the scores were, what config was used, which queries failed.

**Why second:** The next step (comparison) needs stored runs to compare against. Can't compare if there's nothing stored.

### Step 3: Comparison and Regression Detection

After every eval run, automatically answer: **"Did things get better or worse?"**

Load the previous run (Step 2), diff every metric against the current run, and assign a severity:

| Severity     | When                                             | What to do                   |
|--------------|--------------------------------------------------|------------------------------|
| **ok**       | All metrics stable or improved                   | Deploy confidently           |
| **warning**  | Any metric dropped more than 2%                  | Investigate — might be noise |
| **block**    | Any metric dropped more than 5%                  | Do NOT deploy — revert       |
| **critical** | Hit rate below 80% or zero-result rate above 10% | Something is broken          |

Watch out for **inverted metrics** — for most metrics higher is better (hit rate, recall, MRR). But for zero-result rate and response time, *lower* is better. A drop in zero-result rate is an improvement, not a regression. Your comparison function needs to know which direction is "good" for each metric.

**Why third:** Depends on Step 2 — needs stored runs to compare against. But the comparison logic itself is pure computation (like Step 1), so it belongs in the same module as scoring and metrics.

### Step 4: Integration

Steps 1-3 built the pieces. Now connect them into your eval runner script.

Before:
1. Load golden dataset
2. Run each query through search
3. Score results
4. Print report

After:
1. **Load previous run** (Step 2)
2. Load golden dataset
3. Run each query through search
4. Score results (now includes all metrics from Step 1)
5. Print report
6. **Save run to database** (Step 2)
7. **Compare against previous run and print diff** (Step 3)

Your runner script should be thin orchestration — 50-80 lines that wire together the computation, persistence, and comparison modules. No business logic in the script itself.

**Why fourth:** Can't wire things together until they exist.

### Step 5: Live Verification

Run the eval script against your real database and verify the full pipeline:
- Run once → prints metrics, saves to database, reports "no previous run found"
- Run again → prints metrics, saves a second run, shows comparison (all unchanged)
- Check database → two rows with matching metrics

**Why last:** Steps 1-4 were tested with mocked databases (fast, free, repeatable). Step 5 proves it works against the real database with real data. Unit tests catch logic bugs, live verification catches integration bugs.

### The Pattern

These 5 steps follow a common sequence: **data → storage → analysis → integration → verification**. Each layer builds on the previous one. You can't compare runs if you can't store them. You can't store useful runs if you're missing metrics. You can't trust the integration without testing it live.

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

## Ledger Implementation

How Ledger's eval system maps to the architecture above. This section documents what exists, what triggers it, and how data flows through the system.

### File Map

```
┌─────────────────────────────────────────────────────────┐
│  src/scripts/eval-search.ts    ← orchestrator, the only │
│  npx tsx src/scripts/eval-search.ts    file with I/O    │
├─────────────────────────────────────────────────────────┤
│  src/lib/eval/eval.ts          ← scoring + metrics      │
│  src/lib/eval/eval-store.ts    ← save/load runs to DB   │
├─────────────────────────────────────────────────────────┤
│  src/lib/search/ai-search.ts   ← the actual search      │
│  (searchHybrid)                  being evaluated         │
└─────────────────────────────────────────────────────────┘
```

- **eval.ts** — pure functions, zero I/O. Types (`IGoldenTestCaseProps`, `ITestResultProps`, `IEvalMetricsProps`), scoring (`scoreTestCase`), aggregation (`computeMetrics`), formatting (`formatReport`). Fully unit-testable.
- **eval-store.ts** — persistence layer. `saveEvalRun()` writes to `eval_runs`, `loadPreviousRun()` reads the most recent run.
- **eval-search.ts** — orchestration script. Wires golden dataset loading, search execution, scoring, and persistence together.
- **tests/eval.test.ts** — unit tests for scoring, metrics, and report formatting.
- **tests/eval-store.test.ts** — unit tests for persistence (mocked Supabase).

### What Triggers It

Manual execution only:

```bash
npx tsx src/scripts/eval-search.ts
```

No CLI command, no cron, no CI integration. It's a developer tool invoked by hand.

### End-to-End Flow

**Step 1 — Load golden test cases from Supabase.**

The script queries `eval_golden_dataset` (56 rows). Each row is a query + the doc IDs that should come back:

```
"how does auth work?"  →  expected: [42, 99]    tags: [conceptual]
"pgvector HNSW"        →  expected: [137]        tags: [exact-term]
"pizza recipes"        →  expected: []            tags: [out-of-scope]
```

These were manually inserted — no seed file in the repo. The table has a GIN index on `tags` for filtering.

**Step 2 — For each test case, run an actual search.**

The script calls `searchHybrid()` from `ai-search.ts` — the same function the MCP server uses in production. The eval tests the real search path:

```
Query: "how does auth work?"
          │
          ▼
   getOrCacheQueryEmbedding()
          │
          ├─ Check query_cache table (by normalized text)
          ├─ Cache hit → return cached 1536-dim vector
          └─ Cache miss → call OpenAI text-embedding-3-small, cache result
          │
          ▼
   supabase.rpc('match_documents_hybrid')
          │
          ├─ Vector path: cosine similarity against document_chunks.embedding
          ├─ Keyword path: GIN full-text search against documents.search_vector
          └─ RRF fusion: score = 1/(60 + vector_rank) + 1/(60 + keyword_rank)
          │
          ▼
   Returns ISearchResultProps[] (top 10 by fused score)
```

Each search also fire-and-forget logs to `search_evaluations` — same as production. The eval adds no special instrumentation.

**Step 3 — Score each result.**

`scoreTestCase()` (in `eval.ts`) takes the golden test case + search results and computes:

| Field             | What it captures                                           |
|-------------------|------------------------------------------------------------|
| `hit`             | Did any expected doc appear in results?                    |
| `firstResultHit`  | Was the #1 result one of the expected docs?                |
| `position`        | Where did the first expected doc appear? (null if missed)  |
| `reciprocalRank`  | `1 / (position + 1)` — feeds into MRR                     |
| `expectedFound`   | How many of the expected docs were found                   |
| `expectedTotal`   | How many expected docs the test case has                   |

For out-of-scope cases (empty `expected_doc_ids`), a "hit" means the search correctly returned nothing.

**Step 4 — Aggregate.**

`computeMetrics()` takes all scored results and produces:

| Metric                | What it answers                                               |
|-----------------------|---------------------------------------------------------------|
| `hitRate`             | What % of queries found at least one right doc?               |
| `firstResultAccuracy` | What % of queries had the right doc ranked #1?                |
| `recall`              | Of all expected docs across all queries, what % found?        |
| `mrr`                 | On average, how high is the first correct result ranked?      |
| `zeroResultRate`      | How often does search return nothing at all?                  |
| `outOfScopeAccuracy`  | How often do garbage queries correctly get no results?        |
| `tagStats`            | All of the above, broken down by tag                          |
| `missed`              | The actual test cases that failed (for debugging)             |

**Step 5 — Persist + report.**

- `eval-store.ts` saves the run to `eval_runs` (metrics + config snapshot as JSONB).
- `formatReport()` outputs a human-readable table to stdout.

### Current Gaps

| Gap                          | Impact                                                                            |
|------------------------------|-----------------------------------------------------------------------------------|
| No baseline comparison       | `loadPreviousRun()` exists but the script doesn't show deltas between runs        |
| No search mode selection     | Always runs hybrid — can't isolate vector-only or keyword-only weaknesses         |
| No per-case timing isolation | `responseTimeMs` includes embedding cache lookup, making timing noisy across runs |
| Golden set only in Supabase  | No local fixture — if the DB is down or data drifts, eval breaks silently         |
| No NDCG                      | MRR only scores the first hit — doesn't penalize poor ranking of other results    |

### Using Eval to Tune Search

The eval system doesn't tune anything automatically. It provides the feedback loop that makes tuning informed instead of blind.

**Without eval:** "I changed the similarity threshold from 0.25 to 0.3... I think search is better now?"

**With eval:** "Threshold 0.25 → hit rate 88.5%, MRR 0.65. Threshold 0.3 → hit rate 82%, MRR 0.71. Losing hits but ranking improves. Wrong tradeoff — revert."

#### What you can tune and what to watch

| Knob                                       | Metrics that reveal impact                  |
|--------------------------------------------|---------------------------------------------|
| Similarity threshold (0.25)                | Hit rate, zero-result rate                  |
| RRF k value (60)                           | MRR, first-result accuracy                  |
| Chunk size (2000 chars)                    | Recall, hit rate                            |
| Chunk overlap (200 chars)                  | Recall (especially multi-doc queries)       |
| Embedding model (text-embedding-3-small)   | Everything — the biggest lever              |
| Search mode (hybrid/vector/keyword)        | Per-tag stats show which mode wins where    |

**Similarity threshold** — how picky search is. Higher = fewer results but more relevant. Lower = more results but some garbage. If you're getting too many empty searches, lower it. If you're getting junk results, raise it. Tune by adjusting the `threshold` parameter in search calls (currently 0.25).

**RRF k value** — controls how much being #1 matters vs #5 in the ranking. Low k = #1 result dominates. High k = top 5 are treated more equally. Affects which doc lands on top, not whether it shows up at all. Tune by adjusting `rrf_k` in hybrid search calls (currently 60).

**Chunk size** — how big the pieces are when a document gets sliced up for search. Too big and the important part gets buried in surrounding text. Too small and context gets lost. If search can't find docs you know are there, try different sizes. Tune by adjusting `DEFAULT_MAX_CHUNK_CHARS` in `src/lib/search/embeddings.ts` (currently 2000). Requires re-chunking and re-embedding all documents.

**Chunk overlap** — how much neighboring chunks share at their edges. Without it, a key sentence can get split between two chunks and neither matches well. More overlap = fewer missed splits, but more data to store. Tune by adjusting `DEFAULT_OVERLAP_CHARS` in `src/lib/search/embeddings.ts` (currently 200). Requires re-chunking and re-embedding all documents.

**Embedding model** — the thing that turns text into numbers so search can compare meaning. Better model = better everything. But changing it means re-processing every document in the database. Expensive, high effort, highest payoff. Tune by changing `EMBEDDING_MODEL` in `src/lib/search/embeddings.ts` (currently `text-embedding-3-small`). Requires re-embedding all documents and chunks.

**Search mode** — vector finds meaning ("how does auth work?"), keyword finds exact words ("pgvector HNSW"). Hybrid runs both. The per-tag stats show you which mode actually helps for which kind of query. Tune by choosing which search function to call: `searchByVector`, `searchByKeyword`, or `searchHybrid` in `src/lib/search/ai-search.ts`.

#### The tuning cycle

```
Change something (e.g. chunk size 2000 → 1500)
        │
        ▼
Run eval (npx tsx src/scripts/eval-search.ts)
        │
        ▼
Compare against previous run in eval_runs
        │
        ▼
Numbers went up? Keep the change.
Numbers went down? Revert.
Numbers mixed? Check per-tag breakdown to understand why.
```

Every run is saved with its config snapshot (`eval_runs.config` JSONB), so you can look back and determine which combination of settings produced the best results.

#### Reading the metrics together

No single metric tells the full story. Read them as a group:

| Scenario                                    | What it means                                              |
|---------------------------------------------|------------------------------------------------------------|
| Hit rate high, first-result accuracy low     | Finding the right docs but ranking them poorly             |
| Hit rate high, recall low                    | Finding one expected doc but missing the rest              |
| MRR high, hit rate low                       | When we find something, it ranks well — but we miss often  |
| Zero-result rate climbing                    | Threshold too aggressive, or new query patterns unhandled  |
| One tag underperforming                      | That category needs more golden test cases or tuning       |

### Embedding Cache Coupling

First run after a cache flush: 56 OpenAI API calls (~$0.01, ~3-5s extra latency). Subsequent runs: all cache hits, significantly faster. Timing metrics are not comparable across fresh vs. warm runs unless cache state is accounted for.

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

**If you need formal testing:** Bootstrap confidence intervals (see below).

---

## Advanced Analysis

Three analysis tools that go beyond metrics — they help you understand *why* results are the way they are and *where* to improve.

### Confidence Intervals (Bootstrap)

**What it is:** A range around each metric that tells you how much uncertainty there is due to the limited size of your golden dataset. "Hit rate is 88.5% ± 4.2%" means the true value is somewhere between 84.3% and 92.7% with 95% probability.

**Why it matters:** Without confidence intervals, you can't tell if a 2% metric change is real or random noise from a small dataset. The intervals quantify this — if two runs' intervals overlap, the difference isn't statistically meaningful.

**How bootstrap resampling works:**

```
1. Take your N test results
2. Randomly pick N results WITH REPLACEMENT (same result can be picked twice)
3. Compute metrics on this resampled set
4. Repeat 1000 times
5. Sort the 1000 metric values
6. The 2.5th percentile = lower bound, 97.5th percentile = upper bound
7. That's your 95% confidence interval
```

"With replacement" means each resample is slightly different — some test cases appear twice, others are missing. This simulates "what if our golden dataset were different?" and shows how sensitive the metrics are to the specific test cases we chose.

**How to read the output:**

```
Hit rate:              88.5% (±4.2%, 95% CI: 84.3–92.7%)
First-result accuracy: 46.2% (±6.8%, 95% CI: 39.4–53.0%)
MRR:                   0.601 (±0.052, 95% CI: 0.549–0.653)
```

The `±` value is half the interval width. Wide intervals (±5%+) mean your dataset is too small for precise measurement at that level. Narrow intervals (±1-2%) mean the metric is reliable.

**When to act on a metric change:**

| Previous run interval | Current run value | Conclusion                        |
|-----------------------|-------------------|-----------------------------------|
| 85.0–92.0%            | 90.0%             | Within interval — no real change  |
| 85.0–92.0%            | 80.0%             | Below interval — real regression  |
| 85.0–92.0%            | 95.0%             | Above interval — real improvement |

**Implementation notes:**
- 1000 iterations is standard — more is slower with diminishing returns
- Bootstrap assumes test cases are independent (each query doesn't affect others)
- Works with any sample size, but intervals are wider with fewer cases
- Deterministic seed optional — use for reproducible CI in automated pipelines

### Score Calibration

**What it is:** Analysis of how similarity scores are distributed for relevant vs irrelevant results. Answers: "are scores meaningful, or is everything scoring about the same?"

**What good calibration looks like:**

```
Relevant scores:    mean=0.82, range=[0.65–0.95]    ← high
Irrelevant scores:  mean=0.35, range=[0.10–0.55]    ← low
Score separation:   0.47                             ← big gap = good
```

There's a clear gap between relevant and irrelevant scores. A threshold anywhere from 0.55 to 0.65 would cleanly separate them.

**What bad calibration looks like:**

```
Relevant scores:    mean=0.52, range=[0.30–0.70]    ← overlaps with irrelevant
Irrelevant scores:  mean=0.45, range=[0.25–0.65]    ← overlaps with relevant
Score separation:   0.07                             ← tiny gap = bad
```

Scores overlap — the system can't distinguish relevant from irrelevant by score alone. This means threshold tuning won't help much; the problem is in the embeddings or chunking.

**Key metrics:**

| Metric          | What it tells you                                          | What to do if bad                    |
|-----------------|------------------------------------------------------------|--------------------------------------|
| **Separation**  | Gap between relevant mean and irrelevant mean              | Low: improve embeddings or chunking  |
| **Overlap**     | Do the score ranges overlap?                               | Yes: threshold can't cleanly split   |
| **Relevant min** | Lowest score of a relevant result                         | Very low: some relevant docs have weak embeddings |
| **Irrelevant max** | Highest score of an irrelevant result                  | Very high: some irrelevant docs are confusingly similar |

**When to use:** Before threshold tuning. If separation is low, adjusting the threshold won't help — the problem is upstream (embeddings, chunking, or document content). If separation is high, threshold tuning is the right lever.

### Coverage Analysis

**What it is:** Shows which parts of your knowledge base are well-tested by the golden dataset and which are blind spots.

**What it reports:**

| Metric                   | What it tells you                                           |
|--------------------------|-------------------------------------------------------------|
| **Queries per tag**      | Which query categories have enough test cases (5+ = good)   |
| **Unique docs tested**   | How many distinct documents appear in expected_doc_ids       |
| **Undertested tags**     | Tags with fewer than 3 test cases — results for these are unreliable |
| **Out-of-scope count**   | How many negative test cases you have (5-10% is good)        |

**Example output:**

```
COVERAGE ANALYSIS:
  Total queries:         56 (52 normal, 4 out-of-scope)
  Unique docs tested:    38 of ~130 (29%)
  Tags covered:          10

    simple: 19 queries
    conceptual: 13 queries
    exact-term: 10 queries
    technical: 9 queries
    persona: 8 queries
    multi-doc: 6 queries
    atelier: 5 queries
    cross-domain: 4 queries
    workspace: 3 queries
    security: 2 queries       ← undertested
    custom-skills: 1 queries  ← undertested
```

**What to do with coverage gaps:**
- Tags with < 3 queries: add more test cases for those categories
- Documents never tested: write queries that should find them
- High % of docs untested: grow the golden dataset (target 1-2 queries per document)
- Few out-of-scope cases: add queries that should return nothing (5-10% of total)

**When to use:** Monthly, when growing the golden dataset. Coverage analysis tells you *where* to add test cases, not just *how many*.

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

Four tables support the eval system, organized into two independent subsystems:

| Table                            | Purpose                               | Retention                        |
|----------------------------------|---------------------------------------|----------------------------------|
| `search_evaluations`             | Raw search logs (every search)        | 30 days (aggregated then purged) |
| `search_evaluation_aggregates`   | Daily summaries                       | Indefinite                       |
| `eval_golden_dataset`            | Test cases (the answer key)           | Indefinite (growing)             |
| `eval_runs`                      | Stored eval results (the grade)       | Indefinite                       |

See `reference-rag-database-schemas.md` for full CREATE TABLE SQL.

#### Two subsystems

**Subsystem 1 — Production monitoring (passive, automatic).** Records what happens in real searches. Has no concept of "correct" or "incorrect" — just raw data.

- `search_evaluations` — one row per search, inserted silently on every search call (fire-and-forget). Stores the query text, search mode, returned doc IDs + scores, and latency. This is the raw flight recorder.
- `search_evaluation_aggregates` — one row per day, created by a daily cron job that crunches the raw rows into totals: search count, avg latency, zero-result rate, breakdown by mode. Keeps trends queryable without unbounded table growth.

```
Every search ──► search_evaluations (raw, 50+ rows/day)
                        │
                  daily cron job
                        │
                        ▼
              search_evaluation_aggregates (1 row/day)
```

**Subsystem 2 — Controlled evaluation (manual, on-demand).** Tests whether search results are *correct* by comparing against known-good answers.

- `eval_golden_dataset` — the answer key. Hand-curated test cases: "if someone asks X, they should find documents Y." Does not grow automatically — new cases are added manually when new failure modes are discovered.
- `eval_runs` — the graded exam. One row per eval execution, containing all metrics (hit rate, MRR, recall), the config snapshot (threshold, model, RRF k), and full per-query detail. The historical record of search quality over time.

```
eval_golden_dataset (test cases, static)
        │
  eval script runs each through search
        │
        ▼
  score + aggregate
        │
        ▼
  eval_runs (1 row per run, historical)
```

#### How they connect

The two subsystems are independent but designed to feed each other:

1. Spot a pattern in `search_evaluations` (e.g. a query that keeps returning zero results)
2. Figure out what it *should* return
3. Add it to `eval_golden_dataset`
4. Next eval run catches it, `eval_runs` tracks whether it's fixed

The first two tables record what *actually happens*. The last two test whether what happens is *correct*.

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
