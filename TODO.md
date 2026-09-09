# Job Radar — roadmap

Phase 1 is complete and running. This is what comes next, roughly in value order.

---

## Phase 2 — research, materials, outreach

### More sources
- [ ] Workable public API (`https://apply.workable.com/api/v1/widget/accounts/{token}`)
- [ ] SmartRecruiters public postings API
- [ ] Recruitee, Personio, Teamtailor public endpoints
- [ ] YC Work at a Startup (check terms before implementing)
- [ ] We Work Remotely RSS (verified reachable; RSS parser needed)
- [x] **`job-radar discover <company>`** — done. Probes all three ATS platforms,
      dedupes against existing config, prints a pasteable line.
- [ ] Have `discover --add` write straight into `config/sources.yaml` under the
      right ATS group, instead of printing a line to paste by hand.
- [ ] Several on-lane companies have no public ATS at all (Ahrefs, Semrush,
      Botify, Payload, Framer, Statsig, Clerk, Deel, Whatnot, Rippling —
      confirmed by `discover`). They sit in `watchlist` and need a research
      path rather than an ingestion one.

### Company research (`job-radar research <job-id>`)
- [ ] Pull public signals: funding announcements, headcount trend, tech stack
- [ ] Detect the company's own SEO posture from public pages only — and never
      claim a finding that wasn't actually observed
- [ ] Cache research per company, not per job (companies repeat across postings)
- [ ] Populate the `company_stage` / `company_size_estimate` / `industry` columns,
      which currently exist in the schema but are never filled

### Resume selection and tailoring (`job-radar resume <job-id>`)
- [ ] Store base resume variants: Senior Full-Stack, Technical SEO/Growth,
      AI-enabled Product, Proptech/3D
- [ ] Select the best base variant per job and explain why
- [ ] Produce 3–5 strategic edits, not a rewrite: summary revision, skill
      ordering, bullet reordering, terminology alignment, missing-but-supported
      keywords, bullets to emphasize, bullets to cut
- [ ] Keep source resumes separate from generated variants (`resumes/` is gitignored)
- [ ] Hard rule to carry over: never fabricate, never keyword-stuff

### Compensation strategy (`job-radar comp <job-id>`)
- [ ] Full negotiation prep: employment type, published range, estimated budget,
      company size/stage, leverage by interview stage, W-2 vs contract economics
- [ ] Recommend whether to ask for their range first
- [ ] Separate target / anchor / walk-away, with wording options
- [ ] Never emit "ask for exactly $X" without the reasoning around it

### Outreach (`job-radar outreach <job-id>`)
- [ ] Identify roles worth contacting (titles only — never invent a person)
- [ ] Draft messages under ~120 words that reference something real
- [ ] No fake familiarity, no begging, no "I'd love to connect"
- [ ] Human review before anything is sent. Never auto-send.

### Reverse job search (`job-radar reverse`)
- [ ] Search on skill combinations rather than titles: `"Payload CMS" hiring`,
      `"Next.js" "technical SEO"`, `"Three.js" proptech`, `"digital twin" React`
- [ ] Goal is finding companies *before* becoming applicant #300

---

## Phase 3 — intelligence and analytics

### Interview preparation (`job-radar interview prep <job-id>`)
- [ ] Likely questions, role-specific technical areas, company-specific topics
- [ ] STAR story inventory built from actual history — never invented
- [ ] Weaknesses they may probe; questions to ask them
- [ ] Post-interview analysis: strongest/weakest answers, interviewer concerns,
      surprises, comp signals, likelihood of progressing, what to practice
- [ ] Feed new questions back into the interview database

### Company opportunity detection
- [ ] Flag companies showing: recent funding, rapid hiring, web-platform rebuild,
      matching stack, content-heavy site, marketplace model, weak web performance,
      3D/proptech/spatial product, IoT platform, AI product
- [ ] Generate an opportunity hypothesis with observed evidence only
- [ ] Explicit guard: never fabricate a claim about someone's site

### Advanced analytics
- [ ] Conversion by lane, by source, by company size — which lane actually converts
- [ ] Time-to-response distribution; auto-detect ghosting after N days
- [ ] Which signals correlate with reaching a screen (make scoring self-correcting)
- [ ] Report on `job_events` history: roles whose salary or description moved

### Web dashboard
Staged deliberately, rather than one jump to a framework.

**Shipped (JOB-7).** `reports/latest.html` is a generated dashboard: top-line
tiles, the funnel with per-stage conversion and its sample size, the tool's own
diagnosis of its data quality, what is in flight with age, and applications and
replies per week from `job_events`. No framework, no build step, no new runtime,
served by the existing loopback-only viewer. Read-only.

**Still open: the interactive version.** Everything below needs a server that
can accept a write, which is a different architecture and a different security
conversation than a generated file:
- [ ] Next.js app over the same SQLite database
- [ ] Kanban by status; scoring explainability visible per job
- [ ] Status changes and notes from the browser instead of the CLI
- [ ] Read-only first; no action taken without an explicit click

Worth revisiting once the funnel has enough volume that the static page stops
answering the question. Below ~15 applications it says so itself.

---

## Shipped 2026-09-09 — the efficiency batch (JOB-39 … JOB-45)

From `docs/EFFICIENCY_IMPLEMENTATION_PLAN.md`. All seven merged.

- [x] **Warn before preparing an application the analyst said to skip** (JOB-39) — done.
  `resume tailor` and `apply` read the standing verdict before spending and stop on an
  unendorsed posting, quoting the analyst's own reasoning. `--override` proceeds and records
  `overrodeVerdict` on the run. Never hard-blocks; the autofill report carries the verdict
  into the last document read before submitting. 22 of 43 past applications would have been
  flagged.
- [x] **Make the two-stage analysis path safe to enable** (JOB-40) — done. The cache key
  gained a `tier`, so a triage stub and a dossier can no longer collide; `interviewProbability`
  and `competitionEstimate` are nullable and render as `not assessed (triage only)` instead of
  a fabricated `0% / moderate`; the application-pack prompt says it has no dossier rather than
  asserting empty strengths.
- [x] **Benchmark triage as a router, then switch two-tier on** (JOB-41) — done.
  `benchmark-triage --mode routing` measures whether triage can decide *who earns* a dossier,
  which is what the code actually uses it for. Measured 0 missed dossiers across 45 baselines
  → `two_stage: true`. The verdict-accuracy question still fails (88.9% vs a 92% bar) and that
  finding stands.
- [x] **Drop the unread `description_raw` column** (JOB-42) — done. 254 MB → 130 MB. A
  separate `applyDestructiveMigrations` runs only from the new `job-radar migrate`, which backs
  up and verifies the copy's size first. `applyColumnMigrations` stays additive-only.
- [x] **One usage envelope on every paid call, with jobId** (JOB-43) — done. `readUsage` is the
  single chokepoint; one `usage` key across every command that spends, so one SQL query totals
  tokens. A response with no usage is flagged and counted, never thrown on — throwing would
  consume one of the job's two analysis attempts. Purged 1,098 runaway dashboard run rows.
- [x] **Repair the analysis cache** (JOB-44) — done. Was 3 lifetime hits on 430 rows. The key
  now uses `materialHash` (order-independent token multiset) instead of a byte hash, and
  `evidenceVersion` instead of the whole profile. Measured across 13,615 real descriptions:
  every cosmetic perturbation tested is now stable where the byte hash changed on all of them.
- [x] **Dossier on intent, triage on the slate** (JOB-45) — done. `analyze --slate` selects
  379 jobs against 10 for the default pass. The dossier fetch hangs off the JOB-39 gate rather
  than a second place that decides whether to spend. See the follow-on below.

### Follow-on work this batch revealed

- [ ] **The dossier-on-intent path is currently unreachable.** `dossier_for` is
  `[apply_and_outreach, apply, network_or_watch]`, a superset of the verdicts that endorse
  applying — so every endorsed job already gets its dossier during the `analyze` pass and the
  gate's fetch can never fire. Confirmed: 0 such jobs exist in the index and none can.
  Completing JOB-45's intent means narrowing `dossier_for` so triage runs wide and the dossier
  really is bought on intent. That is its own change and needs its own measurement — narrowing
  it invalidates the routing benchmark, which measured against the current policy.
- [ ] **The two-tier cost saving is unproven.** JOB-41 projected ~$0.046/job → ~$0.020/job. The
  first two-tier pass measured **$0.0474/job against a $0.0459/job single-stage baseline** — no
  reduction. Two of six jobs earned dossiers and pay for both calls, and the `dossier_min_fit:
  70` safety valve fired more often than the ticket's model assumed (it predicted 1 in 263
  skips). Judge over several daily passes before counting the saving.
- [ ] **The analysis cache hit rate is not yet observable.** Both JOB-40 and JOB-44 changed the
  key, so the existing rows were invalidated once by design. Check `analysis_cache` against
  `fromCache` in run stats after a week of daily passes.
- [ ] **`analyzedSample` draws only from already-analyzed jobs**, which passed the old top-K
  selection. Under `--slate`, triage runs across a broader, lower-ranked pool the routing gate
  has never seen.
- [ ] **A single `--slate` pass covers 379 of 1,075 eligible**, capped by the per-company
  diversity limits. Successive daily passes drain the rest; there is no one-shot backfill.

---

## Known limitations of the current build

- **Company size is proxied by open-role count in the index.** Real, cheap, and
  directionally right, but a 30-person company that posts 40 roles looks large.
  Replace with real headcount data when a source exists.
- **`research_notes`, `resume_version`, `outreach_priority`** columns exist in the
  schema and are not yet written by any command.
- **Cross-run dedupe uses the exact key only.** Within a batch there are three
  passes; across runs, a syndicated duplicate that arrives on a later day with a
  different title will not merge into the earlier record.
- ~~**The scoring `analysis_threshold` gate is a blunt cost control.**~~ Fixed in
  JOB-32: the gate is retired and `analyze` selects the top K by rank. Spend is
  bounded by `--limit` and `max_spend_per_run_usd`.
- ~~**No retry queue for failed analyses.**~~ Fixed in JOB-34: the failure kind and
  reason are recorded, and a job that has failed `analysis_max_attempts` times is not
  bought again. A materially changed description clears the record and earns a fresh
  pair of attempts (JOB-44).
- **Lever `salaryRange` is mapped but was null on every board tested**, so that
  path is implemented against the documented shape rather than an observed one.
- **Calibration corrects the symptom, not the cause.** The measured 0.75x
  correction is applied uniformly to every unanalyzed job, but the bias is
  almost certainly not uniform: it is probably worst on senior-title roles at
  large companies and mildest on small-company roles in-lane. A per-lane or
  per-company-size correction would be more accurate than one global ratio.
  Better still, feed the observed analysis scores back into the individual
  signal weights so the keyword engine actually improves.
- **Nothing re-analyzes a job when the calibration shifts materially.** A job
  analyzed when the correction was 0.9x is not revisited when it moves to 0.7x.
  Low impact today, worth revisiting if the ratio drifts far.

---

## Deliberate non-goals

- Auto-applying to jobs
- Auto-sending any message to any human
- Defeating anti-bot protections, CAPTCHAs, rate limits, or paywalls
- Scraping anything behind authentication
- Optimizing for applications-per-day rather than qualified conversations
