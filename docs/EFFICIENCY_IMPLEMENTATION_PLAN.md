# Efficiency Redesign — Implementation Plan (rev. 4, 2026-09-09)

Implementation-ready work items for `docs/EFFICIENCY_REDESIGN.md`, in the format of
`docs/ARCHITECTURE_REFACTOR_BACKLOG.md`.

**Revision 4.** Four rounds of adversarial review: rev. 1 had six defects, rev. 2 fixed
those and added three, rev. 3 fixed those and added one. Every line reference below was
read in the source tree on 2026-09-09, and the one semantic the design now turns on was
executed rather than assumed.

The recurring failure was **specifying a mechanism without tracing what feeds it** —
`deterministicNote`, `analyzedSample`, and (in rev. 3) a code comment I paraphrased
instead of testing.

## What rev. 3 got wrong

| # | Rev. 3 claim | Reality |
|---|---|---|
| 10 | The stored analysis must become a `discriminatedUnion` on `tier`, because `model/job.ts:153-160` forbids loosening `AnalysisSchema` | Misreading. That comment objects to **`.optional()`-with-defaults** ("a FULL response that simply forgot `strengths` would validate"). Verified against the repo's Zod 4.4.3: `.nullable()` **rejects a missing key**, `.optional()` accepts it. `.nullable()` has no such failure mode. |
| 11 | "Renderers at `cli.ts:1440` and `daily.ts:331` branch on `tier`" | Understated. Under a union, **~26** sites read dossier-only fields (`daily.ts:338-363`, `cli.ts:1444-1463`, `prepare.ts:48-52`) — a refactor described as two lines. |

Rev. 4 drops the union. The correct change is smaller than rev. 3's **and** smaller than
the "cheap two-scalar union" the review suggested: `.nullable()` on the two scalars, with
the full-response validator re-requiring them.

## What rev. 2 got wrong

| # | Rev. 2 claim | Reality |
|---|---|---|
| 7 | EFF-4: hash `buildSystemPrompt` + `deterministicNote` | Worse than what it replaces. `deterministicNote` carries `fitScore`/`applicationRoi` (`analyzer.ts:430`), which `project()` recomputes from calibration on every scoring run (`rescore.ts:90-104`). Cache would invalidate continuously. |
| 8 | EFF-1: gate on ">=40 apply-class baselines" | Unsatisfiable. Only **22** apply-class analyses exist, and `analyzedSample` (`repo.ts:716-740`) hard-codes the apply-vs-not split. |
| 9 | EFF-0: make the two fields `.nullable()` on `AnalysisSchema` | Forbidden by documented precedent. `model/job.ts:153-160` rejects loosening `AnalysisSchema` precisely because it makes "malformed output is rejected, never stored" go quietly soft. |

## What rev. 1 got wrong

| # | Rev. 1 claim | Reality |
|---|---|---|
| 1 | "`Analysis` is structurally assignable to `TriageVerdict`" | False. `AnalysisSchema.lane` is `z.string()` (`model/job.ts:92`); `triageSchemaFor().lane` is a literal enum (`model/job.ts:166`). Would fail `npm run typecheck`. |
| 2 | EFF-1 is "a benchmark change plus a config flip — no analyzer work" | False. The cache key has no tier (`analyzer.ts:269`), so triage stubs are cached under the dossier's key. |
| 3 | EFF-1 ships safely today | False. `triageOnlyAnalysis` fabricates `interviewProbability: 0` / `competitionEstimate: "moderate"` (`model/job.ts:182-194`), rendered at `cli.ts:1440` and `daily.ts:331`. |
| 4 | EFF-4(a): hash `buildSystemPrompt` in place of `profileVersion` | Incomplete. `deterministicNote` (`analyzer.ts:429-436`) is scoring-config-derived and lives in the **user** prompt. |
| 5 | EFF-2 retention is safe because filtered jobs are "ineligible by construction" | False. `rescore.ts` re-filters **every** row (`repo.ts:419-422` is `SELECT * FROM jobs`) and reads `descriptionClean` (`filters.ts:28`, `score.ts:53`). |
| 6 | EFF-3 "throws when a paid response carries no usage" | Discards paid work and can park a good job (`failures.ts:74-76`). |

Two attacks on rev. 1 **failed**, and the plan is unchanged where they landed:

- `dossier_min_fit: 70` does not inflate the dossier count — only **1 of 263** skips clears
  70, and still only 1 at a triage-inflated 64. The ~58% savings estimate stands.
- EFF-5 does not increase spend. 1,255 eligible unanalyzed jobs, ~30 new/day → ~$12.55
  one-time backfill plus ~$9/month, against ~$28/month at the current rate.

---

## Sequencing

| PR | Items | Depends on | Gate |
|---|---|---|---|
| 1 | EFF-0 | — | `npm test`; no behaviour change |
| 2 | EFF-1 | EFF-0 | `benchmark-triage --mode routing`: 0 missed dossiers |
| 3 | EFF-2, EFF-3 | — | `npm test`; backup verified before migration |
| 4 | EFF-4 | EFF-0 (shares the cache key) — ship **immediately after** it | cache hit rate observable |
| 5 | EFF-5 | EFF-1, and `MATCH-001` | gate refuses/overrides correctly |

**EFF-0 and EFF-4 both change the cache key**, so each orphans it. Keep them as separate
PRs for revertability, but ship EFF-4 directly after EFF-0 so only one warm-up period is
lost rather than two. The cost either way is nil — the cache has served 3 lifetime hits —
but there is no reason to spend it twice.

**EFF-0 is new and blocks EFF-1.** Rev. 1 had no such item because it assumed the
two-stage path was safe to switch on. It is not: the three defects it carries are
correctness and truthfulness bugs that exist in `main` today, dormant only because
`two_stage: false`.

The dependency in rev. 1's table (EFF-4 → EFF-1, "same call site") was wrong — EFF-1 does
not touch the cache key. Both now depend on **EFF-0**, which is where the key actually
changes.

---

## EFF-0 — Make the two-stage path safe to switch on

**Priority:** P1 · **Blocks:** EFF-1, EFF-5 · **Effect:** none visible; removes three
latent defects.

**Problem:** `two_stage` is wired (`analyzer.ts:245-263`) but carries three defects that
only manifest when it is enabled.

**(a) The cache has no tier.** `analyzer.ts:268-272` runs for both branches:

```
repo.saveAnalysis(job.id, result.analysis, opts.model);
const key = repo.cacheKey(job.descriptionHash, job.title, job.company, opts.model, profileVersion);
repo.putCachedAnalysis(key, ...);
```

`cacheKey` (`repo.ts:1104`) takes no tier and `analysis_cache` (`schema.ts:127-135`) has
no tier column, so a triage stub is stored under the key a dossier would use. The read at
`analyzer.ts:185` then returns the stub forever. This makes EFF-5 structurally impossible
and is silent: nothing distinguishes a triage stub from a dossier that genuinely found no
strengths.

**(b) Fabricated values reach rendered output.** `triageOnlyAnalysis`
(`model/job.ts:182-194`) sets `interviewProbability: 0` and
`competitionEstimate: "moderate"`. Both render — `cli.ts:1440`,
`report/daily.ts:331`. With `two_stage: true`, ~80% of analyzed jobs would display
*"Interview probability 0% | competition moderate"* as an analyst judgement. The
function's own comment claims "nothing was invented to fill the gap", but `"moderate"` is
an invented value, not an empty one. This is CLAUDE.md's first non-negotiable, and it
would also silently corrupt `MATCH-004`, which calibrates `interviewProbability` against
outcomes.

**(c) `deservesDossier` cannot take an `Analysis`.** `detail.ts:29-32` reads only
`recommendation` and `fitScore`, but its parameter is the full `TriageVerdict`, whose
`lane` is a literal enum. The benchmark needs to evaluate it against baseline `Analysis`
values.

**Change:**
- Add `tier: "triage" | "full"` to `cacheKey` (`repo.ts:1104`) and a `tier` column to
  `analysis_cache` via `COLUMN_MIGRATIONS` (additive — allowed by `db/index.ts:48`).
- **`.nullable()` on the two fabricating scalars, and nothing else.**
  `interviewProbability` and `competitionEstimate` become `.nullable()` on
  `AnalysisSchema`; `analysisSchemaFor` — the validator for full responses at
  `analyzer.ts:499` — re-requires both as non-null. `buildTriageJsonSchema` already omits
  them (not in `TRIAGE_FIELDS`, `analysis/schema.ts:127`), and they stay in the full JSON
  Schema `required` list (`analysis/schema.ts:90-105`), so the double validation CLAUDE.md
  requires is intact on the full path.

  **Why this does not violate `model/job.ts:153-160`.** That comment rejects making
  dossier fields *optional*, because "a FULL response that simply forgot `strengths` would
  validate and store an empty array". Executed against the repo's Zod 4.4.3:

  | shape | key missing | key `null` |
  |---|---|---|
  | `z.number().nullable()` | **rejected** | accepted |
  | `z.number().optional()` | accepted | — |

  `.nullable()` keeps the key **required**. A full response that forgot the field still
  fails, so the failure mode the comment guards against cannot occur. Rev. 3 escalated to
  a `discriminatedUnion` on the strength of a paraphrase of that comment; the union would
  have forced narrowing at ~26 sites (`daily.ts:338-363`, `cli.ts:1444-1463`,
  `prepare.ts:48-52`) to solve a problem two fields have.
- **The list fields keep their empty arrays.** `model/job.ts:176-181` already defends
  this and is right: an empty list is not an invented value, the way
  `competitionEstimate: "moderate"` is. Only the two scalars fabricate, so only the two
  scalars change.
- Add a storage-level `tier` (`"triage" | "full"`) written by the analyzer, **not** part
  of `buildAnalysisJsonSchema` — the model never emits it. Missing reads as `"full"`.
- `triageOnlyAnalysis` sets both scalars to `null` and `tier: "triage"`.
- Renderers at `cli.ts:1440` and `daily.ts:331` print `not assessed (triage only)` when
  the value is null.
- **`src/analysis/prepare.ts:44-53` needs an explicit branch**, and this is the item rev. 3
  missed entirely. `priorAnalysis` guards only on `analysis` being present, then reads
  `.differentiation`, `.strengths`, `.risks`, `.missingRequirements` and
  `.salaryReasoning` unconditionally. Fed a triage stub it would tell the pack model
  `Strengths:` / `Risks:` / `Missing:` — empty, as fact — in the prompt that writes the
  **application pack a human sends**. Extend the existing ternary to three ways, matching
  the branch already beside it: `"No dossier yet - triage only. Work from the posting."`
  This is the `EFF-5` failure mode showing up one layer earlier, and it is a real defect
  today the moment `two_stage` is enabled, independent of `EFF-5`.
- Narrow `deservesDossier`'s parameter to
  `Pick<TriageVerdict, "recommendation" | "fitScore">`. `Analysis` satisfies that. Do not
  widen `TriageVerdict.lane` — `model/job.ts:86-91` explains that `AnalysisSchema.lane` is
  deliberately `z.string()` so a lane retired from config still deserialises on historical
  rows.
- **Backfill:** the 329 existing stored analyses have no `tier`. Read a missing `tier` as
  `"full"`. This is provably correct rather than a guess — `SUM(triageOnly)` over the
  whole run log is **0**, so no triage-only analysis has ever been written.

**Acceptance:** with `two_stage: true` in a fixture run, a triage-only job and a dossier
job for the same posting occupy distinct cache rows; `show` and the daily briefing render
`not assessed (triage only)` and never `0%`; the application pack built from a triage stub
says so instead of asserting empty strengths; a full response missing `strengths`,
`interviewProbability` or `competitionEstimate` is still rejected; `npm test` and
`npm run typecheck` pass.

**Behaviour change while `two_stage: false`:** exactly one — adding `tier` to the hash
orphans all 430 cache rows. Rev. 2 claimed "no behaviour change", which was wrong. The
cost is nil: the cache has served **3 lifetime hits**. EFF-4 will orphan them again for
the same reason. No analysis is lost; `jobs.analysis_json` is untouched.

**Tests:** cache-key test asserting tier participates in the hash; a test that a
triage-only analysis round-trips with null scalars and never renders `0%`; **a test that
`analysisSchemaFor` rejects a full response omitting `interviewProbability`** — the
regression test for rev. 3's misreading; a test that the full schema still rejects a
response missing `strengths`; a test that a stored row with no `tier` reads back as
`full`; a `prepare.ts` test asserting a triage stub produces the no-dossier branch rather
than empty strength/risk lines; a test that `deservesDossier` accepts a baseline
`Analysis`.

---

## EFF-1 — Benchmark triage as a router, then switch two-tier on

**Priority:** P1 · **Depends on:** EFF-0 · **Effect:** ~58% off the analyze bill.

**Problem:** unchanged from rev. 1, and it survived review. `deservesDossier` /
`triageOnlyAnalysis` / `buildTriageJsonSchema` are implemented and wired, and the run log
shows `SUM(dossiers)=0, SUM(triageOnly)=0`. The feature is off because `benchmark-triage`
scored 81% against a 92% bar. That bar measures **verdict accuracy**; the code uses triage
only as a **router**. All four recorded "invented applies" were `network_or_watch → apply`,
and `dossier_for: [apply_and_outreach, apply, network_or_watch]` routes both to a dossier.
Routing agreement on that sample is 21/21, with `missedApplies: 0`.

**Change:**
- `src/analysis/benchmark.ts`: add `mode: "verdict" | "routing"`. In routing mode compute
  `deservesDossier(baseline, policy)` vs `deservesDossier(triage, policy)` per row, using
  the narrowed parameter from EFF-0.
- Extend `TriageBenchmarkRow` with `baselineRoutesToDossier`, `triageRoutesToDossier`,
  `agreesOnRouting`; extend `TriageBenchmark` with `routingAgreementRate`,
  `missedDossiers` (blocking) and `extraDossiers` (a cost line, not a failure).
- `benchmarkTriage` takes the `DossierPolicy` from `profile.analysis_detail`.
- `src/cli.ts`: `benchmark-triage --mode routing`, defaulting to `verdict` so the existing
  JOB-31 gate is unchanged for anyone invoking it the old way.
- Report `extraDossiers` as estimated added spend per 100 jobs.

**Blocking metric:** `missedDossiers` must be **0**. A missed dossier silently demotes a
role below a human's attention; an extra dossier costs $0.046. Not symmetric, and the gate
must not treat them as if they were.

**The blocking class is dossier-routing baselines, not apply-class.** Rev. 2 required
"≥40 apply-class baselines" and that gate is **unsatisfiable**: only 22 apply-class
analyses exist in the whole index (18 `apply` + 4 `apply_and_outreach`, both before and
after the `filter_passed = 1` restriction the sampler applies). It also carried the wrong
class over from verdict mode. For a router, the population that matters is baselines that
**route to a dossier** — `apply` + `apply_and_outreach` + `network_or_watch` = **66
available**, plus the 1 skip clearing `dossier_min_fit`.

Require **≥40 dossier-routing baselines**. Zero misses out of 40 bounds the true miss rate
near 7% (rule of three); the recorded run's 12 apply-class baselines bounded it only at
~25%, which rev. 1's unexamined "≥25" never acknowledged.

**The sampler needs a routing-aware split, and it must call `deservesDossier`.**
`analyzedSample` (`repo.ts:716-740`) hard-codes `IN ('apply','apply_and_outreach')` versus
`NOT IN`, which is the verdict-mode balance. Add a `split: "apply" | "dossier"` parameter,
defaulting to `"apply"` so the JOB-31 verdict benchmark is untouched.

In `dossier` mode, **do not** reimplement the routing rule as a SQL `IN` list against
`dossier_for`. `deservesDossier` (`detail.ts:29-32`) routes on `dossier_for` **or**
`fitScore >= dossier_min_fit`, so an `IN` list silently mislabels every skip that clears
the fit floor — 1 row today, but the entire point of a routing benchmark is routing
fidelity, and a gate that disagrees with the function it gates is not measuring anything.
Select the candidate rows in SQL (`analysis_json IS NOT NULL AND filter_passed = 1`, ~329
rows), parse, then partition in JS with `deservesDossier` itself. The corpus is small
enough that this is free.

Keep the existing top-up behaviour. The comment there explains the balance in verdict
terms ("a missed apply hides a role forever, an invented apply wastes an afternoon"); the
routing analogue is that a missed dossier hides a role and an extra one costs $0.046 —
same asymmetry, same reason to sample both sides.

**Sampling bias — a known limitation.** `analyzedSample` draws from already-analyzed jobs,
which passed the old top-K-by-rank selection. Under EFF-5 triage runs across the whole
eligible slate, a broader and lower-ranked pool the benchmark never sees. Record this in
the config comment; do not claim the gate covers it. Re-run the routing benchmark on a
slate-drawn sample once EFF-5 has produced one.

**Then:** set `two_stage: true`, replacing the comment block with the routing result.
**Keep the existing verdict-mode numbers** — they remain the correct answer to "can triage
replace the dossier?" (no), and deleting them invites re-running that experiment in two
years.

**Acceptance:** `benchmark-triage --mode routing` reports 0 missed dossiers on ≥40
dossier-routing baselines; a subsequent `analyze` pass reports non-zero `triageOnly` and
`dossiers`; cost per analyzed job drops from ~$0.046 toward ~$0.020; verdicts on
dossier-earning jobs are unchanged.

**Tests:** routing comparison over fixture rows, asserting the four config-documented
cases all route identically; a test that `missedDossiers` is populated when triage demotes
a dossier-routing baseline; a sampler test asserting `split: "dossier"` draws from
`dossier_for` and that `split: "apply"` is unchanged.

**Risk:** do not bundle a model downgrade into this PR. Model tiering for triage is
`COST-002`'s question and stays there.

---

## EFF-2 — Drop `description_raw`

**Priority:** P2 · **Effect:** 265 MB → ~150 MB.

**Problem:** `description_raw` is 114 MB and is **written but never read** — the only
references are the write path (`repo.ts:181,215,240`), the type (`model/job.ts:38`), the
200 KB truncation (`normalize.ts:73`) and the row mapper (`repo.ts:1255`).
`deploy/job-radar-daily.service` backs the database up on every daily pass (#44), so this
is paid for daily, forever.

**Change:**
- Remove `description_raw` from the schema, the row/`EnrichedJob` types, the insert and
  update statements, and the row mapper. Stop computing it in `normalize.ts` rather than
  computing and discarding it.
- Add a **destructive** migration step. `applyColumnMigrations` is explicitly
  additive-only (`db/index.ts:48`) and stays that way; add a separate version-gated
  `applyDestructiveMigrations(db)` running `ALTER TABLE jobs DROP COLUMN description_raw`
  (verified supported — bundled SQLite is 3.53.4), guarded by a `PRAGMA table_info` check.
- **Take a backup first** via `src/lib/backup.ts`. Run the step from an explicit
  `job-radar migrate` command, **not** from `openDb()` — `openDb` is on the hot path for
  every command and every test, and a backup plus `VACUUM` there would be a hazard.
  `VACUUM` also cannot run inside a transaction.
- `VACUUM` once, inside that command, so the file actually shrinks.

**Acceptance:** database under ~160 MB after migration + vacuum; `npm test` passes;
`ingest` on a fresh database and on the migrated one produce identical scoring output for
the same fixture payloads.

**Tests:** migration test building an old-shape table, running the destructive step, and
asserting the column is gone and the row count is unchanged.

### Dropped from rev. 1: retention-nulling of filtered descriptions

Rev. 1 proposed nulling `description_clean` for the 11,696 `filter_passed=0` jobs, worth a
further ~81 MB, on the grounds that they are "ineligible for analysis by construction".
**That is wrong and the item is withdrawn.**

`runScoring` calls `repo.allForScoring()`, which is `SELECT * FROM jobs` with no exclusion
(`repo.ts:419-422`), then re-runs `applyFilters` and `scoreJob` on every row
(`rescore.ts:47-48`); both read `job.descriptionClean` (`filters.ts:28`, `score.ts:53`).
The comment at `rescore.ts:34-37` states the intent directly: *"This runs over everything
rather than only new jobs, because editing career-profile.yaml must re-rank the whole
index."*

So the failure is: loosen a filter in config — the documented tuning workflow — run
`score`, and all 11,696 nulled jobs re-score against an empty body, score 0, and stay
excluded permanently. Silent, because they were already excluded. That is data loss
wearing retention's clothes, and it breaks a documented invariant to buy 81 MB. Not worth
it. If the database becomes a real problem later, the answer is archiving whole rows to a
side table, not hollowing out live ones.

---

## EFF-3 — One usage envelope, `jobId` on every paid run, purge dead run rows

**Priority:** P2 · **Effect:** makes `COST-001` enforceable rather than conventional.

**Problem:** token fields are named inconsistently — `analyze` writes
`inputTokens`/`outputTokens`; `resume-tailor`/`apply` write
`input`/`cacheWrite`/`cacheRead`/`output`. `estimatedCostUsd` is common, so dollar totals
work but no single query totals tokens. Same shape of gap that let the $17 day record $0.
Separately, `runs` carries 1,098 dead dashboard rows from 2026-08-14.

**Change:**
- One `TokenUsage` envelope under a single `usage` key from every command that spends.
  `src/lib/cost.ts` already defines `TokenUsage` — reuse it.
- Route the Anthropic call sites through one helper. **On a response with no usage, keep
  the result and fail the run loudly** — set `ok = 0`, log an error naming the job, and
  surface it in the summary. Do **not** throw.
- Purge the 2026-08-14 dashboard rows. The mechanism that caused them is already fixed
  (`cli.ts:101`, `report/watch.ts:172`), and exactly one dashboard run has been logged
  since; this is cleanup, not a fix.
- Add `jobId` to `analyze` / `resume-tailor` / `apply` run stats, enabling
  `spend --per-app` (`OBS-007`).

**Why not throw** (rev. 1 said "throws"): the response is valid and already paid for.
Throwing discards it and routes into `classifyAnalysisFailure`, where anything not
classified `api` counts against the job (`failures.ts:74-76`) and consumes one of its two
attempts — so a metadata gap could park a perfectly analysable job. That inverts the
intent of the attempt budget, which exists to stop re-buying *deterministic* failures.
The backlog's COST-001 wording — "throws (or loudly flags the run)" — permits both;
loud-flag is the correct branch here.

**Acceptance:** a stubbed usage-less response marks the run failed and names the job,
while the analysis is still saved; one SQL query totals tokens across every command;
`runs` contains no zero-stat dashboard rows.

**Tests:** unit test on the loud-flag path asserting the analysis is persisted **and** the
run is marked not-ok; a shape test asserting every spending command emits the same `usage`
key; a test that the usage-less path does not increment `analysis_failures`.

---

## EFF-4 — Repair the analysis cache

**Priority:** P2 · **Depends on:** EFF-0 · **Effect:** recovers a cache with a 0.7% hit
rate (3 hits / 430).

**Problem:** two independent invalidation bugs.

**(a) Over-invalidation.** `cacheKey(descriptionHash, title, company, model, profileVersion)`
(`repo.ts:1104`) invalidates every entry on any edit to `career-profile.yaml`, and the
profile is edited constantly (13 `personal.yaml` backups between 2026-08-14 and
2026-08-19 alone).

**(b) Churn.** `descriptionHash = sha256(descriptionClean)` (`normalize.ts:51`) is a
byte-level hash over the whole cleaned description. 4,349 `description_changed` events
across 13,674 jobs; one ClickUp posting changed 32 times; Greenhouse and Ashby both
average 0.33 changes per job. 89 of 430 cache rows are already orphaned.

**Change:**
- (a) Replace `profileVersion` with
  `sha256(buildSystemPrompt(profile) + stableNote)`, where `stableNote` is the
  **calibration-stable** half of `deterministicNote`: `lane`, `compensationBand`,
  `compensationNote`, `positiveSignals`, `negativeSignals`.

  **Extract the note builder rather than duplicating it.** `deterministicNote` is
  currently built inline inside `analyzeOne` (`analyzer.ts:429-436`), while the cache key
  is computed in the outer loop (`analyzer.ts:185`) — so `stableNote` is not reachable
  where it is needed. Lift the construction into one function returning both halves. It
  must apply the **same truncation the model sees** — `positiveSignals.slice(0, 12)` and
  `negativeSignals.slice(0, 8)` (`analyzer.ts:432-433`). Hashing the untruncated arrays
  would invalidate the key on a signal change past the cut that never reached the prompt,
  which is the over-invalidation EFF-4 exists to remove. One function makes that drift
  impossible; two copies guarantee it eventually.

  This is narrower than both previous revisions, and each exclusion is traced:

  - Rev. 1 hashed only the system prompt. Too narrow — it misses the scoring-config
    signals that reach the model through the **user** turn (`analyzer.ts:429-436`), so a
    signal or comp-band change would silently reuse an analysis computed under different
    evidence.
  - Rev. 2 hashed the whole `deterministicNote`. Too wide, and actively harmful:
    the note leads with `fitScore` and `applicationRoi` (`analyzer.ts:430`), and
    `project()` (`calibration.ts:131-140`) rewrites exactly those two from the calibration
    on every scoring run (`rescore.ts:90-104`). Calibration moves whenever a new analysis
    lands, so those numbers churn for every un-analyzed job — which is precisely the
    population the cache serves, since `needingAnalysis` only offers jobs with no
    `analysis_json`. Rev. 2's key would have invalidated the cache continuously, worse
    than the `profileVersion` it replaced.
  - `project()` touches **only** `fitScore` and `applicationRoi` — verified at
    `calibration.ts:136-139` — so the remaining five fields are calibration-stable.
    `reconcileWithAnalysis` (`score.ts:402`) also leaves `lane` alone, and in any case
    only runs for jobs that already have an analysis and are therefore never cache
    candidates.
  - Do not hash the whole user prompt: it embeds the description, which would defeat (b).

  **The trade, stated:** a cached analysis may have been produced while the model was
  shown a different calibrated `fitScore` than the current one. That is acceptable — the
  prompt labels those numbers "evidence, not a conclusion" and instructs the model to
  correct them — but it is a real loosening and belongs in the commit message, not
  buried.
- (b) Add a `materialHash` alongside `descriptionHash`: a normalized token multiset over
  the description, ordering and boilerplate removed. Key the **cache** on `materialHash`;
  keep `descriptionHash` for `job_events` so the change history stays byte-exact.
  Deterministic string work, no model. Add the column via `COLUMN_MIGRATIONS` (additive)
  and backfill all 13,674 rows from the stored `description_clean` in the same pass — the
  input is already present, so no re-fetch is needed.
- Invalidate the cached analysis on a **material** change only.

**Acceptance:** replaying the 4,349 recorded description changes against the material hash
reclassifies the large majority as immaterial; a scoring-weight edit still invalidates;
an unrelated config edit does not.

**Tests:** fixtures for reorder-only, boilerplate-only and genuine-requirements-change
descriptions, asserting the first two are immaterial and the third is not; a test that a
signal or comp-band change alters the key via `stableNote`; and — the regression test for
rev. 2's defect — a test that **recomputing the calibration does not change the cache
key**.

**Risk:** a material-change test that is too lax reuses a stale verdict after a real
rewrite. Bias the normalizer toward calling things material — a false "material" costs
$0.046, a false "immaterial" costs a wrong verdict. Same asymmetry as EFF-1, resolved the
same way.

**Note:** this changes the cache key again, orphaning whatever EFF-0 left — which is why
it ships directly after EFF-0. Same justification: 3 lifetime hits.

---

## EFF-5 — Dossier on intent, triage on the slate

**Priority:** P2 · **Depends on:** EFF-1 (and EFF-0's cache tier), plus `MATCH-001` ·
**Effect:** dossier utilization 10% → ~100%.

**Problem:** `analyze` runs as a speculative batch enrichment of the top-K index. Of 329
analyzed jobs, 242 still sit at `NEW` and 54 closed before anyone looked — **10%
utilization**. Meanwhile 12 of 43 applications went to jobs never analyzed at all, because
the verdict was absent when it was needed.

**Change:** three tiers matching the three real decisions.

| Decision | Evidence | Where |
|---|---|---|
| What ranks on today's slate? | deterministic score | already free |
| Worth a human's attention? | triage verdict | `analyze`, run wide |
| Apply, and with what angle? | full dossier | on intent |

- `analyze` runs triage across the eligible slate rather than top-K.
- The dossier fires on **intent**: when a job is shortlisted, or as the first step of the
  `MATCH-001` gate in `resume tailor` / `apply`. Reuse the existing gate helper — do not
  add a second place that decides whether to spend.
- The dossier lookup must request `tier: "full"` (EFF-0). Without that the cache returns
  the triage stub and the dossier is never fetched.

**Cost, stated rather than asserted.** Rev. 1 called the wide pass "cheap enough to run
wide" without arithmetic. Measured: 1,255 eligible unanalyzed jobs and ~30 new
filter-passing jobs/day. Backfill ≈ **$12.55** one-time; steady state ≈ **$9/month**, plus
dossiers on intent (~40/month × $0.046 ≈ $1.84). Against ~$28/month at the current rate
this is a reduction — but the one-time backfill costs roughly the entire savings EFF-1
produces in its first months, and it will exceed `max_spend_per_run_usd`, so it is a
multi-run backfill. Plan it as one.

**Acceptance:** preparing an application on a triage-only job fetches its dossier as part
of the gate; no prepared application lacks a dossier; `analyze` covers materially more of
the eligible pool than the current top-K pass.

**Tests:** gate fixture where the job has a triage stub but no dossier — asserts the
dossier is fetched (not served from cache), the verdict is applied, and a `skip` still
refuses without `--override`.

**Dependency note:** composes with `MATCH-001`, does not replace it. `MATCH-001` supplies
the gate helper and the override-with-reason mechanism; EFF-5 hangs the dossier fetch off
it.

---

## What this does not touch

- **Determinism boundary, provenance enforcement, autofill refusals.** None on the cost
  path; all load-bearing.
- **`resume tailor` on Opus-5.** It decides which bullets are true of this candidate.
  Wrong there is a correctness failure, not a style one — and it is $2.32 lifetime.
- **The description budget / input tokens.** Input is 28% of the bill. The intuitive lever
  and the wrong one; `EFFICIENCY_REDESIGN.md` §4 records why.
- **Any absolute fit gate as a spend control.** Retired in JOB-32 on measured grounds.
- **Model tiering for triage.** `COST-002`, after EFF-1 has been observed.
- **The triage schema.** `TRIAGE_FIELDS` (`analysis/schema.ts:127`) is already six fields
  and the comment above it explains why `reasoningSummary` stays. Rev. 1's "cap the triage
  output schema" item was unnecessary and is withdrawn.

## Bounding the whole thing

The cost prize is roughly $12 against $23.43 spent to date, and EFF-5's backfill consumes
much of it up front. **That is not the reason to do this.** EFF-0 removes three latent
correctness and truthfulness defects; EFF-1 and EFF-5 move spend to where the decisions
are; EFF-3 keeps the next $17 day visible. Cost efficiency here is a proxy for targeting
discipline, which `ARCHITECTURE_AUDIT.md` §1 identifies as the actual problem.

None of it substitutes for **`OBS-001`**. Every item above optimizes a funnel whose output
is still unmeasured, and if only one thing gets done this month it should be `OBS-001`.
