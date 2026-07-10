# Testing & Metrics Plan — What to Test and How, Before Publishing

**Purpose:** define exactly what "ready to publish" means for Continuum, and
lay out metrics strong enough to speak for the product on their own —
credible because the methodology is disclosed, not because a number sounds big.

**Grounded against:** agentmemory's own published benchmark structure
(`benchmark/LONGMEMEVAL.md`, `QUALITY.md`, `SCALE.md`, `COMPARISON.md`), which
uses: Recall@5, Recall@10, and Mean Reciprocal Rank (MRR) against a fixed
benchmark dataset with a baseline comparison; a token-cost projection stated
in real dollars per year; p50 retrieval latency in milliseconds; and a raw
test count — with an explicit, published note on which numbers are their own
measurement versus borrowed from a different paper on a different dataset.

Continuum measures a different domain (code symbol retrieval + local session
memory, not long-term semantic recall), so the exact metrics differ — but the
**structure** — a fixed, repeatable test set; a stated baseline; an honestly
labeled methodology — is what's being adapted here, not their numbers.

**The one rule this whole document exists to enforce:** every number that
ships in a README, a comparison table, or a launch post must have a script
behind it that anyone can re-run and get the same result. If a number can't
be regenerated on demand, it doesn't get published. This project has already
had to walk back one fabricated metric before — this plan exists so that
doesn't happen again.

---

## Part 1 — Correctness testing (must pass before anything else matters)

Metrics are worthless if the underlying product is broken. This comes first.

### 1.1 Close the coverage gaps that map directly to real bugs found this cycle

Current coverage is uneven in exactly the places where real defects were
found and fixed this session — that's not a coincidence, it's the reason they
went unnoticed for as long as they did.

| File | Current coverage | Why it matters | Target |
|---|---|---|---|
| `FileWatcher.ts` | ~0% | Owns file deletion, orphan sweep, reindex — the exact logic behind the stale-symbol bugs fixed this session | ≥ 70% |
| `src/cli/index.ts` (`init`, `status`) | ~0% | The install path every real user goes through first; the hook `DB_PATH` bug lived here, undetected, until manually reproduced | ≥ 70% |
| `ContextGenerator.ts` | ~4% | New this cycle; only exercised by manual testing so far | ≥ 70% |
| `SchemaReader.ts` + adapters | ~0–8% | Needs a real or containerized MSSQL/Postgres/MySQL instance to test meaningfully — acceptable to defer with a documented reason, not silently skip | Document why, or add a mock-connection test |

**How to run:** `npm run test:coverage` — the report already exists and already
shows these numbers; this section is about closing them, not discovering them.

### 1.2 Regression tests for every bug found this session, one test per bug

Each of these was found by manual reproduction, not by an existing test —
meaning none of them would be caught if reintroduced. Each needs a permanent
automated test:

- **Stale symbol/FTS leak on file deletion** — delete a file, assert its
  symbols and FTS rows are both gone (not just the `files` row).
- **Orphan sweep on startup** — remove a file from disk while the server is
  down, restart, assert it's purged from the index without a reindex call.
- **Hook `DB_PATH` routing** — run `continuum init`, assert the generated hook
  command's `DB_PATH` matches that project's own `.continuum/knowledge.db`,
  not any other path.
- **Project root resolution precedence** — set `CLAUDE_PROJECT_DIR` and launch
  from an unrelated working directory; assert the resolved root is
  `CLAUDE_PROJECT_DIR`, not `process.cwd()`.
- **Ranked search returns results** — insert a known symbol, query it through
  the FTS path specifically (not the LIKE fallback), assert a non-empty,
  correctly ranked result. (This is the exact bug that went unnoticed because
  the LIKE fallback silently masked it — the test must isolate the FTS path.)

### 1.3 Isolation correctness — the test that matters most for credibility

This is the single most important correctness test Continuum can publish,
because it's the exact failure mode a comparable tool has shipped in
production (a cross-tenant memory leak, publicly documented in that project's
own changelog).

**Test:** create two separate project directories, each with its own
`continuum init`. Populate each with distinct, non-overlapping symbol names
and session decisions. Run every search and session tool against each
project's server instance. **Assert zero results from Project A ever appear
when querying Project B, and vice versa — across every tool, not just search.**

This should be a standing, permanent test, not a one-time check — it is the
concrete proof behind the "physical isolation, not a filter that can be
forgotten" claim.

---

## Part 2 — The metrics worth publishing

Each metric below states: what it proves, exactly how to measure it, what
data it runs against, and — critically — how it will be labeled so nobody
mistakes a self-measured number for an independently verified one.

### 2.1 Symbol search accuracy — Recall@5, Recall@10, MRR

**What it proves:** when a developer searches for a function they know
exists, does Continuum actually find it, and how far down the results does it
land.

**Methodology:**
1. Take a real, already-indexed codebase (the project's own 138k-symbol
   production index is a legitimate corpus — large, real, not synthetic).
2. Generate a fixed query set: sample N known symbol names (suggest N=200 for
   a credible sample size), including exact names, partial names, and
   camelCase fragments (e.g. `user` for `getUserById`) to reflect how people
   actually search.
3. For each query, run `search_symbols` and record the rank of the correct
   symbol in the results (or "not found").
4. Compute:
   - **Recall@5** — % of queries where the correct symbol appears in the top 5
   - **Recall@10** — same, top 10
   - **MRR** — mean of `1/rank` across all queries (rewards ranking it #1 over #5)
5. **Run the same query set through the LIKE-only fallback path** as the
   baseline, exactly as agentmemory compared against a BM25-only baseline —
   this proves the FTS+LIKE merge actually improves on either alone, not just
   that search "works."

**Publish as:** *"Recall@5: X% (baseline LIKE-only: Y%) — our own measurement,
against our own indexed corpus of N symbols, query set of M terms."* State the
corpus size and query set size in the same sentence as the number — a
percentage with no denominator disclosed is not a credible metric.

### 2.2 Retrieval latency — p50 and p95, from real logged data

**What it proves:** search stays fast as the index grows, not just on a toy
repo.

**Methodology:** this doesn't need a new harness — `tool_usage.duration_ms`
already logs every real tool call. Query it directly:

```sql
SELECT tool_name,
       AVG(duration_ms) as mean_ms,
       -- p50/p95 via percentile calculation over duration_ms
       COUNT(*) as call_count
FROM tool_usage
WHERE tool_name IN ('search_symbols', 'smart_search', 'get_session')
GROUP BY tool_name;
```

Run this against the real production database (138k symbols, months of real
usage) — not a fresh empty one. A latency number measured on an empty
database proves nothing about real-world use.

**Publish as:** *"p50 latency: Xms, p95: Yms, measured across N real tool
calls against a M-symbol, K-file production index."*

### 2.3 Token efficiency — measured, not argued

This is the metric this project has already gotten wrong once (an earlier,
fabricated "tokens saved" formula that had to be replaced). It does not get
published again without a real comparison behind it.

**Methodology:**
1. Define a fixed set of realistic tasks (suggest 8–10): e.g. "find where
   authentication is handled," "what does this file depend on," "resume this
   session after a compaction."
2. Run each task twice: once with an AI given only ordinary file-reading
   tools (the baseline), once with the same AI given Continuum's tools.
3. Record actual token counts for each run (available directly from the
   model API's usage reporting — this is not an estimate once the comparison
   actually happens).
4. Report the **distribution** (min/median/max reduction across the task
   set), not a single flattering number cherry-picked from the best case.

**Publish as:** *"Across N representative tasks, token usage was reduced by a
median of X% (range: Y%–Z%) compared to file-reading tools alone. Methodology
and raw task list: [link]."* Publish the task list and raw numbers alongside
the percentage — exactly the transparency agentmemory applies when they
disclose which of their own numbers come from a different dataset.

### 2.4 Test coverage — the plain, undecorated number

**What it proves:** baseline engineering discipline, no interpretation needed.

**Methodology:** `npm test` and `npm run test:coverage`, run as part of CI on
every commit, not just before a publish event.

**Publish as:** *"N tests passing, X% line coverage"* — stated exactly as
agentmemory states their own "1,423+ tests passing," with no adjustment or
selective inclusion.

### 2.5 Stale-data correctness — a metric specific to Continuum's own history

**What it proves:** the reconciliation logic (orphan sweep, delete-triggered
cleanup) fixed this session actually holds under real conditions, not just in
the one manual test that found the original bug.

**Methodology:** delete a controlled batch of files (suggest 50) from a real
indexed project while the server is offline, restart, and measure:
- How many orphaned symbol rows remain (target: 0)
- How many orphaned FTS rows remain (target: 0)
- Time taken to reconcile on startup, for a repo of realistic size

**Publish as:** *"0 stale symbol rows after N file deletions across M restart
cycles"* — a zero is a genuinely strong, checkable claim, and it's exactly the
class of bug that was silently wrong in this project before this cycle.

### 2.6 Isolation guarantee — the comparison that names the real risk directly

**What it proves:** ties directly to the Part 1.3 test above, but stated as a
metric rather than a pass/fail test, for use in any comparison against
tools that use logical (filter-based) rather than physical isolation.

**Publish as:** *"0 cross-project result leaks across N isolation test runs.
Isolation is enforced by physical file separation — there is no shared table
or filter to misconfigure."* This is a rare case where the *absence* of a
number (zero) is the entire, sufficient claim.

---

## Part 3 — The comparison table

A table naming specific competitors needs the exact same discipline as any
other published number: every cell must be either directly tested, or
sourced from that project's own public documentation with the source noted.

| Capability | Continuum | Competitor A | Competitor B | Source |
|---|---|---|---|---|
| Recall@5 (own methodology, not comparable across rows without the same corpus) | (§2.1 result) | not published | (their published number, if any) | link each |
| p50 latency | (§2.2 result) | — | — | — |
| Physical vs. logical isolation | Physical (§2.6) | Logical (documented leak in their changelog) | — | link their changelog entry |
| Test count | (§2.4 result) | (their published count) | — | link their repo |

**Rule:** if a competitor's number can't be verified from their own public
source, don't put a number in that cell — write "not published" rather than
guess or omit the row entirely.

---

## Part 4 — Publish gate

Continuum should not be published until:

- [ ] Every regression test in Part 1.2 exists and passes
- [ ] The isolation test in Part 1.3 passes
- [ ] Coverage on `FileWatcher.ts`, `cli/index.ts`, and `ContextGenerator.ts` meets the targets in 1.1
- [ ] At least §2.1 (search accuracy), §2.2 (latency), and §2.4 (test count) have been measured and the raw methodology is committed alongside the numbers — not just the headline percentage
- [ ] §2.3 (token efficiency) is either measured with real numbers, or explicitly stated as "not yet benchmarked" — never implied without a number behind it
- [ ] Every number in any public-facing comparison table has a linked, re-runnable source

If a metric can't clear its own bar in this document, the honest move is to
publish without it and label the gap — not to publish a number that wouldn't
survive someone else re-running the same test.
