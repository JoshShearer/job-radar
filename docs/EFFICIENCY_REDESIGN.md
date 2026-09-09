# Efficiency & Cost Redesign — 2026-09-08

What I would change to make the pipeline cheaper and more effective, measured against
`data/job-radar.sqlite` and the source tree on 2026-09-08. Companion to
`docs/ARCHITECTURE_AUDIT.md` (2026-08-24); every number below was re-measured, not
carried over.

---

## 1. The thesis: spend flows opposite to decisions

Lifetime model spend is **$23.43**, and `analyze` is **84%** of it ($19.72 / 430 calls).
Here is where that money went, joined against what actually happened to each job:

| Analyst verdict | Jobs | Cost | Applications it produced |
|---|---:|---:|---:|
| `skip` | 263 | **$12.07** | **0** |
| `network_or_watch` | 44 | $2.02 | 16 |
| `apply` | 18 | $0.83 | 11 |
| `apply_and_outreach` | 4 | $0.18 | 4 |

And here is where the applications came from:

| What the 43 submitted applications had | Count |
|---|---:|
| `network_or_watch` verdict | 16 |
| never analyzed at all | 12 |
| `apply` | 11 |
| `apply_and_outreach` | 4 |

**61% of all model spend bought the word "skip" and produced zero applications.
$1.01 of spend produced every verdict-backed application.** Meanwhile 28 of 43
applications went out against no verdict or a negative one.

Those two tables are mirror images. This is not a "make the calls cheaper" problem —
it is a problem of *paying full price for the decisions that don't matter and nothing
for the ones that do*. Every recommendation below follows from that.

Supporting utilization numbers:

- 13,674 jobs indexed → 1,978 pass hard filters (14%) → 329 analyzed → **33 acted on**.
  Analysis utilization is **10%**; 242 analyzed jobs still sit at `NEW`, 54 closed
  before anyone looked.
- Per analysis: 2,445 input / 1,262 output tokens. At Opus-5 rates ($5/$25 per M),
  **output is 72% of the per-call cost.** The lever is how much the model *writes*,
  not how much it reads.

---

## 2. The single highest-value change: the two-tier gate was benchmarked against the wrong question

`src/analysis/detail.ts` implements `deservesDossier`, `triageOnlyAnalysis` and
`buildTriageJsonSchema`. The run log says it has executed **zero times**:
`SUM(dossiers) = 0, SUM(triageOnly) = 0`. It is off because
`config/career-profile.yaml` records a failed benchmark:

```
apply-vs-not agreement   17/21 = 81.0%   (bar: 92%)
missed applies           0
invented applies         4
```

**The bar measured verdict accuracy. Triage is not a verdict — it is a router.**
The only decision triage makes is *does this job earn the expensive second call*, and
that policy is on the very next line of the same config block:

```yaml
dossier_for: [apply_and_outreach, apply, network_or_watch]
```

Now re-read the four "invented applies" recorded in the config comment. Every one of
them was `network_or_watch` at baseline and got promoted to `apply`/`apply_and_outreach`:

| Company | Baseline | Triage | Baseline routes to | Triage routes to |
|---|---|---|---|---|
| Sanity | `network_or_watch` | `apply_and_outreach` | dossier | dossier |
| Samsara | `network_or_watch` | `apply` | dossier | dossier |
| Hightouch | `network_or_watch` | `apply` | dossier | dossier |
| Deepgram | `network_or_watch` | `apply` | dossier | dossier |

**All four route identically.** `network_or_watch` already earns a dossier. Combined
with `missed applies: 0`, triage's routing agreement on that sample is **21/21 = 100%**,
and the production verdict would be unchanged in every case — because the dossier still
runs and still produces the final verdict.

The 81% number is real, but it answers "could triage replace the dossier?" (no — the
config comment is right that the forced `risks`/`missingRequirements` fields do real
conservatism work). It does not answer "can triage decide who gets a dossier?", which
is the only thing the code actually uses it for.

**Change:** add a routing mode to `analysis/benchmark.ts` that scores
`deservesDossier(triage) == deservesDossier(baseline)` instead of verdict equality, with
recall on apply-class baselines as the blocking metric and precision as a cost report.
Re-run it. On the existing sample it passes at 100%. Then flip `two_stage: true`.

This keeps the JOB-31 precedent intact — the switch is still gated on a benchmark, and
a failed benchmark still blocks it. It corrects what the benchmark measures.

**Savings:** 80% of analyzed jobs come back `skip`. Those stop at triage.

| | now | with routing triage on Sonnet-5 |
|---|---:|---:|
| skip path (80%) | $0.0459 | ~$0.0103 |
| dossier path (20%) | $0.0459 | ~$0.0562 |
| **blended per job** | **$0.0459** | **~$0.0195** |

**~58% off the analyze bill**, with an unchanged final verdict on every job that
reaches a human.

---

## 3. Make analysis pull-based, not batch

Analysis currently runs as a speculative batch enrichment of the top-K index. 10% of it
is ever used. Three decisions need three different levels of evidence, and today two of
them are overpaying:

| Decision | Evidence it needs | Cost |
|---|---|---|
| What ranks on today's slate? | deterministic score — already exists, already free | $0 |
| Is this worth a human's attention? | triage verdict | ~$0.010 |
| Should I apply, and with what angle? | full dossier | ~$0.046 |

**Change:** `analyze` runs triage across the eligible slate (cheap enough to run wide),
and the dossier fires on *intent* — when a job is shortlisted, or as the first step of
the `MATCH-001` gate inside `resume tailor` / `apply`. The dossier then has ~100%
utilization by construction, instead of 10%.

This also closes the discipline gap from a different side than the backlog proposes.
`MATCH-001` blocks applying without a verdict; making the dossier part of the prepare
path means the verdict *exists* exactly when it is needed, so the gate is a check rather
than a wall the human routes around — which is the behaviour that produced 12 applications
to never-analyzed jobs.

---

## 4. Cut what the model writes, not what it reads

Output is 72% of per-call cost. Two concrete cuts:

- **`skip` does not need 1,262 tokens.** Once triage handles skips, cap the triage
  schema to verdict + fit + one-line reason (~150 tokens). The prose case for not
  applying is the single largest line item in the tool and nobody reads it.
- **The dossier's description budget is 7,000 chars** (`DESCRIPTION_CHAR_BUDGET`), but
  input is only 28% of the bill. Leave it alone — trimming input is the lever people
  reach for and it is the wrong one here. Documented so it does not get "optimized"
  later.

---

## 5. Fix the cache — it has a 0.7% hit rate

`analysis_cache` holds 430 rows and has served **3 hits**. Two causes, both fixable:

**a) The key invalidates on the whole profile.** `cacheKey` is
`sha256(descriptionHash|title|company|model|profileVersion)`. Any edit to
`career-profile.yaml` invalidates every entry — and the profile is edited constantly
(13 `personal.yaml` backups between 2026-08-14 and 2026-08-19 alone). Content-address **the rendered system
prompt** (`buildSystemPrompt(profile)`) instead of a profile version string. Edits to
config that don't change the prompt then stop costing money.

**b) `description_hash` churns on noise.** 4,349 `description_changed` events across
13,674 jobs; one ClickUp posting changed **32 times**. Greenhouse and Ashby both average
0.33 changes per job. Employers are not rewriting postings 32 times in three weeks —
this is boilerplate, ordering and tracking-parameter drift, and a byte-level hash cannot
tell it from a real requirements change. **89 of 430 cache rows are already orphaned**
(their `description_hash` matches no live job) — roughly **$4 of analysis that can never
be reused**.

**Change:** keep `description_hash` for the event log, but key the cache on a
*material* hash — normalized token multiset of the requirements/responsibilities/comp
regions, ignoring order and boilerplate. Deterministic string work, no model, consistent
with the determinism boundary. Re-analysis then fires when the job actually changed.

---

## 6. Storage: the database is 9x larger than it needs to be

265 MB, of which the `jobs` table is 241 MB.

- **`description_raw` is 114 MB and is written but never read.** The only references in
  `src/` are the write path in `repo.ts`, the field definition in `model/job.ts`, and
  the 200 KB truncation in `normalize.ts`. Nothing consumes it. Drop the column.
- **166 MB of description text belongs to the 11,696 jobs that failed hard filters** and
  are therefore ineligible for analysis by construction. Keep the rows — dedupe and
  reposting history need them — and null the description after the retention window.

265 MB → roughly 30 MB. This matters more than it looks: `deploy/job-radar-daily.service`
backs the database up on every daily pass (#44), so it is a 9x cut to backup I/O and
retention, every day, forever.

---

## 7. Run-log hygiene, so cost stays auditable

- **1,099 of 1,596 `runs` rows are `dashboard` renders** carrying `{"file": "..."}` and
  no usage. The run log is 69% noise. Don't open a run for read-only render commands.
- **Token fields are named inconsistently across commands**: `analyze` writes
  `inputTokens`/`outputTokens`; `resume-tailor`/`apply` write `input`/`cacheWrite`/
  `cacheRead`/`output`. `estimatedCostUsd` is common, so *dollar* totals work, but no
  single query totals *tokens* across the tool. That is the same class of gap that made
  the $17 day invisible — a shape convention rather than a mechanism.

**Change:** one `usage` envelope emitted by a single wrapper around the Anthropic client,
which throws when a paid response carries no usage (this is `COST-001`, and normalizing
the shape is what makes it enforceable rather than conventional). Add `jobId` while
there, so per-application attribution works going forward.

---

## 8. What I would *not* change

- **The determinism boundary, provenance enforcement, and the autofill refusals.** These
  are the strongest parts of the codebase and none of them are on the cost path.
- **`resume tailor` staying on Opus-5.** It decides which bullets are true of this
  candidate. Being wrong is a correctness failure, not a style one, and it is $2.32
  lifetime. The `PACK_MODEL = sonnet` split is already the right call and the reasoning
  in `analyzer.ts` is correct.
- **Trimming input tokens / the description budget.** Input is 28% of the bill. This is
  the intuitive lever and the wrong one.
- **Reintroducing an absolute fit gate as a spend control.** Retired in JOB-32 for good
  measured reasons; triage routing is the replacement, and it gates on a *verdict*
  rather than on a keyword score with a 26.6-point mean absolute error.

---

## 9. Order of work

| # | Change | Effort | Effect |
|---|---|---|---|
| 1 | Re-run `benchmark-triage` in routing mode; flip `two_stage: true` | S | −58% analyze spend |
| 2 | Drop `description_raw`; retention-null filtered descriptions | S | 265 MB → ~30 MB |
| 3 | Normalize run-stats usage envelope + `jobId`; stop logging dashboard runs | S | makes COST-001 enforceable |
| 4 | Cache key on rendered prompt + material description hash | M | recovers a dead cache |
| 5 | Dossier on intent, triage on the slate | M | 10% → ~100% dossier utilization |
| 6 | Cap triage output schema | S | cuts the largest line item |

Items 1–3 are a single afternoon and carry most of the cost win. Item 5 is the one that
changes outcomes rather than the bill, and it composes with `MATCH-001` from the backlog
rather than competing with it.

**Caveat that bounds all of this:** at current volume the total prize is roughly $12 of
the $23.43 spent to date. The reason to do it is not the money — it is that items 1 and 5
put the spend where the decisions are, and item 3 is what keeps the next $17 day visible.
Cost efficiency here is a proxy for targeting discipline, which is the actual problem
(`ARCHITECTURE_AUDIT.md` §1). None of this substitutes for `OBS-001` — switching the
outcome loop on is still the highest-value change in the backlog, because everything here
optimizes a funnel whose output is currently unmeasured.
