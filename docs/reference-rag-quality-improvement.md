# Production RAG System — Quality Improvement

> How to make search better over time using data, not guesses. Covers tuning levers, A/B testing methodology, interpreting results, and implementation pitfalls. Companion to `reference-rag-system-architecture.md` which provides the system overview.

---

## Levers to Pull

Ordered by typical impact (highest first):

| Lever | What to test | What improves | Typical impact |
|---|---|---|---|
| **Reranker** | None vs cross-encoder | Precision, first-result accuracy | Biggest single gain |
| **Chunk context enrichment** | With vs without context prepend | Recall, precision | 49% fewer failed retrievals |
| **Chunking strategy** | Recursive vs semantic vs header-based | All metrics | Varies by content type |
| **Embedding model** | OpenAI vs Voyage vs BGE-M3 | Precision, cost | Model-dependent |
| **Chunk size** | 256 vs 512 vs 1024 tokens | Recall | Smaller = more precise, more chunks |
| **Similarity threshold** | 0.2 vs 0.25 vs 0.3 | Precision/recall tradeoff | Lower = more results, more noise |
| **RRF k** | 20 vs 60 vs 100 | How vector vs keyword contributes | Subtle |
| **Top-K** | 5 vs 10 vs 20 | Precision vs coverage | More = more context, more noise |
| **Chunk overlap** | 0% vs 10% vs 20% | Recall at boundaries | Small effect |

## How to Run an A/B Test

```
1. BASELINE
   Run golden dataset with current settings
   Record: precision, recall, first-result accuracy
   Save as baseline score

2. CHANGE ONE VARIABLE
   Example: threshold from 0.25 → 0.20
   Keep everything else identical

3. RUN AGAIN
   Same golden dataset, same metrics
   Record: new precision, recall, first-result accuracy

4. COMPARE
   Better across the board → deploy the change
   Better on some, worse on others → investigate which queries improved/degraded
   Worse across the board → reject, revert

5. UPDATE BASELINE
   If deployed, the new scores become the baseline for the next test
```

## Interpreting Results

| Result | What it means | What to do |
|---|---|---|
| Precision went up, recall stayed same | Less noise in results without losing coverage | Deploy, clear win |
| Recall went up, precision went down | Finding more docs but also more irrelevant ones | Might need reranking to filter noise |
| First-result accuracy went up | Top result improved, agents will perform better | Deploy, high-value improvement |
| Zero-result rate went down | Fewer failed searches | Deploy, users were hitting dead ends |
| All metrics went down | The change made things worse | Revert immediately |
| Mixed results by query type | Some types improved, others degraded | Consider per-type settings or different approach |

## Priority Order for a New System

1. **Start with defaults** — recursive chunking at 512 tokens, hybrid search, threshold 0.25
2. **Add eval first** — auto-logging + golden dataset before optimizing anything
3. **Add reranking** — biggest single improvement, low effort
4. **Add chunk context enrichment** — second biggest improvement, needs LLM calls at ingestion
5. **Tune threshold** — use eval data to find the sweet spot
6. **Experiment with chunk size** — only if eval shows boundary issues
7. **Try different embedding models** — only if precision is still low after above

## Implementation Pitfalls

Lessons learned from building and tuning production RAG systems.

**Threshold and enrichment are coupled.** After enabling chunk context enrichment, re-sweep the threshold immediately. Enriched embeddings shift the similarity score distribution upward. Relevant chunks score higher because the context summary adds dimensions aligned with typical queries. The old threshold will be too permissive, letting noise through that the enrichment didn't help. In one system, the optimal threshold moved from 0.25 to 0.38 after enabling enrichment, resulting in +20% first-result accuracy.

**Golden dataset must evolve with the pipeline.** A golden dataset written for 2000-char paragraph chunks may not properly test 1000-char recursive chunks. When you change chunking strategy, review the golden dataset. Some expected document IDs may need updating, and you'll likely need more test cases. At 50 cases, confidence intervals are ±8-13%, making it impossible to detect real improvements under ~10%. At 100+ cases, CIs shrink to ±5-8%, and at 150+ to ±3-6%.

**Postgres function overloading creates duplicates.** `CREATE OR REPLACE FUNCTION` with new parameters creates a *second* function with a different signature. It doesn't replace the old one. You end up with two overloads that Postgres may call ambiguously. Always `DROP FUNCTION` the old signature explicitly before creating the new one. Check with:

```sql
SELECT proname, pronargs FROM pg_proc
WHERE proname = 'your_function' AND pronamespace = 'public'::regnamespace;
```

If you see two rows, drop the one you don't want.

**Structural typing vs SDK overloads.** If your codebase uses structural types to avoid importing heavy SDK packages (good practice for test speed), be careful with complex APIs like OpenAI's `chat.completions.create`. The SDK has multiple overloaded signatures that can't be captured in a simple structural interface. Use `(...args: any[]) => PromiseLike<YourReturnType>` and accept the type safety trade-off at the boundary. The alternative is importing the full SDK into every test file.

**Re-sweep after every pipeline change, not just enrichment.** Any change to chunking (strategy, size, overlap), embedding model, or hybrid search weights can shift the optimal threshold. The sweep is cheap (5-6 eval runs) and the threshold is the fastest lever to pull. Build a sweep command into your CLI so it's always one command away.
