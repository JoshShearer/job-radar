# Job Radar

A local-first job intelligence pipeline. It discovers, normalizes, deduplicates, filters, scores, analyzes, ranks, and tracks senior engineering opportunities so that the scarce resource — attention — goes to the roles where you have a real advantage.

It is deliberately **not** a mass-application bot. Every application, message, and compensation number goes through a human. The system's job is to make sure the human is looking at the right ten roles instead of the wrong two hundred.

The optimization target is **qualified conversations per week**, not applications per day.

---

## What it does

```
DISCOVER → NORMALIZE → DEDUPE → FILTER → SCORE → RESEARCH → RANK → RECOMMEND
                                                                        ↓
                                        TRACK OUTCOME ← PREPARE MATERIAL
                                              ↓
                                        LEARN FROM RESULTS
```

On a real run against the shipped config: **5,548 postings fetched → 539 duplicates collapsed → 638 pass hard filters → 28 analyzed → 1 Priority A and 3 Priority B.**

A single-digit actionable slate out of five and a half thousand postings is the intended output. If the briefing is long, the filters are too loose.

---

## Quick start

```bash
npm install
cp .env.example .env          # add ANTHROPIC_API_KEY for the analysis stage
npm run cli -- sources        # health-check every configured job board
npm run radar                 # ingest + score + write today's briefing
```

`npm run radar` is the daily driver. It writes `reports/YYYY-MM-DD.md` and `reports/latest.md` and prints the briefing to stdout.

The pipeline runs end to end **without an API key**. Only the `analyze` stage calls Claude; everything else — ingestion, dedupe, filtering, scoring, ranking, reporting, tracking — is deterministic and free.

---

## Architecture

```
src/
├── cli.ts                 Command surface (commander)
├── config/
│   ├── schema.ts          Zod schemas for both YAML config files
│   └── load.ts            Loading, caching, cross-field coherence checks
├── sources/               One adapter per provider; all emit the same SourceJob
│   ├── types.ts           SourceJob contract + shared date/interval helpers
│   ├── greenhouse.ts      Public board API
│   ├── lever.ts           Public postings API
│   ├── ashby.ts           Public posting API (structured compensation)
│   ├── remoteok.ts        Public JSON feed (attribution required)
│   └── registry.ts        Config → active adapter list
├── pipeline/
│   ├── normalize.ts       SourceJob → NormalizedJob; all classification lives here
│   ├── dedupe.ts          Exact → content-hash → bounded fuzzy matching
│   ├── filters.ts         Hard filters (reject on evidence, never on absence)
│   ├── score.ts           Explainable fit + Application ROI
│   ├── ingest.ts          Orchestrates discover → normalize → dedupe → persist
│   └── rescore.ts         Re-filters and re-scores the whole index
├── analysis/
│   ├── schema.ts          JSON Schema for structured output
│   ├── prompt.ts          Cached system prefix + per-job turn
│   └── analyzer.ts        Claude call, validation, caching, cost accounting
├── report/daily.ts        The daily briefing
├── stats/funnel.ts        Conversion rates + bottleneck diagnosis
├── db/                    SQLite schema, migrations, repository
├── model/                 Job + status types, analysis contract
└── lib/                   html, salary, location, seniority, http, hash, log
```

**The design rule that matters most:** adapters are dumb. They map a provider payload onto `SourceJob` and do no judgement. Every classification — remote status, seniority, salary, employment type — happens once, in `normalize.ts`, so a Greenhouse job and a Remote OK job describing the same role are treated identically.

---

## Installation

Requires Node 20+ (developed on 24).

```bash
git clone <your-fork> job-radar
cd job-radar
npm install
cp .env.example .env
```

`better-sqlite3` compiles a native module on install; if that fails you need build tools (`build-essential` on Debian/Ubuntu).

---

## Configuration

### `config/career-profile.yaml`

Everything about *you* lives here. Change your search strategy without touching application code.

| Section | Controls |
|---|---|
| `compensation` | Target/acceptable/stretch bands, hard floor, contract fallback |
| `location` | Remote/hybrid/onsite rules, acceptable metros, work-auth blockers |
| `lanes` | The four role families and how much of the slate each should win |
| `seniority` | Which titles are accepted and which are rejected outright |
| `target_titles` | Title phrases that earn a bonus, per lane |
| `signals` | Keyword → points → lane. The core of scoring |
| `combos` | **Combination bonuses — the differentiation engine** |
| `negative_signals` | Technologies that subtract points (but never reject) |
| `hard_exclude_titles` | Wrong specialty or wrong function → reject |
| `scoring` / `roi` | Weights, thresholds, normalization |
| `report` | Caps on how many roles reach the daily briefing |

The file is validated on load. Beyond per-field types, `load.ts` runs **cross-field coherence checks**: lane weights must sum to ~1.0, ROI weights must sum to ~1.0, compensation bands must be ordered correctly, and every signal must reference a lane that exists. A typo that would silently disable a filter fails loudly at startup instead.

### `config/sources.yaml`

Which boards to pull, and how politely. Every board token shipped in the file was verified live (HTTP 200 with a non-empty job list). Re-check them any time with `npm run cli -- sources`.

### Environment variables

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Required only for `analyze` |
| `JOB_RADAR_MODEL` | Analysis model (default `claude-opus-5`) |
| `JOB_RADAR_EFFORT` | Reasoning effort: `low`…`max` (default `medium`) |
| `JOB_RADAR_DB` | Database path override |
| `JOB_RADAR_PROFILE` / `JOB_RADAR_SOURCES` | Config path overrides |
| `JOB_RADAR_REPORTS` | Report output directory |
| `JOB_RADAR_CONTACT` | Appended to the outbound User-Agent so source operators can reach you |

---

## Commands

```bash
npm run cli -- ingest                      # fetch, normalize, dedupe, store
npm run cli -- ingest --source ashby lever # restrict to specific sources
npm run cli -- score                       # re-filter and re-score everything
npm run cli -- analyze --limit 10          # Claude analysis on the top unanalyzed jobs
npm run cli -- analyze --dry-run           # show what would be analyzed, no API calls
npm run cli -- daily                       # ingest + score + briefing  (= npm run radar)
npm run cli -- daily --no-ingest           # re-report on stored data
npm run cli -- daily --analyze             # full pass including the LLM stage
npm run cli -- top --limit 20              # ranked table
npm run cli -- top --all --lane growth_seo # include reviewed jobs, filter by lane
npm run cli -- show <job-id>               # full detail (id or unique prefix)
npm run cli -- status <job-id> APPLIED     # move a job through the funnel
npm run cli -- stats                       # conversion rates + bottleneck diagnosis
npm run cli -- sources                     # health-check every board
npm run cli -- interview add --company X --role Y --stage Technical
npm run cli -- interview list
npm run cli -- backup                      # checkpoint + copy the SQLite file
npm test                                   # 151 tests
```

Job IDs accept unique prefixes: `show 5cc58b` works as well as the full id.

---

## How scoring works

Two numbers come out, and they answer **different questions**:

**`fitScore` (0–100)** — "how well does this role match what I can actually do?" Honest match quality. Lane priorities are deliberately *not* applied, so a great proptech role still reads as a great role.

**`applicationRoi` (0–100)** — "is this worth my time this week?" This folds in lane priority, applicant competition, compensation probability, recency, and how reachable a human is.

That separation is the point. A 95% match at a famous company with 5,000 applicants **should** rank below an 88% match at a 40-person company where your background is unusual — and here it does.

### The pipeline

1. **Positive signals** — each keyword scores its weight, doubled when it appears in the title. Title and body hits take the *stronger* placement rather than summing, so repetition doesn't inflate a score.
2. **Title match bonus** — the title matching a target role family earns a flat bonus, once per lane.
3. **Combination bonuses** — the differentiation engine. `Payload CMS + Next.js`, `technical SEO + TypeScript`, `React + Three.js + proptech`, `IoT + web platform`. These are where an unusual advantage actually lives, and they are weighted accordingly.
4. **Negative signals** — subtract points, doubled in the title. A technology in the title *is* the job; the same word in the body is usually an adjacent team.
5. **Freshness** — decays linearly from full points to zero between the configured day thresholds.
6. **Normalize** — divide and clamp to 0–100.

### Competition proxy

Company size is approximated by **how many open roles that company has in your own index** — a company with 600 listings is a large employer with heavy inbound applicant flow; one with 12 is not. It's imperfect, but it's real data already on hand, which beats guessing at headcount. Posting age reduces the score further, because applicants accumulate over time.

### Explainability

Scoring never emits a bare number. Every job carries the reasoning:

```
Fit = 79   Application ROI = 83   Lane: Senior Full-Stack / Platform

Strong matches:
  * COMBO: IoT + web platform - LoopString connects TypeScript cloud apps to Linux edge devices.
  * COMBO: AI agents + product engineering - Agent architecture with human-in-the-loop design.
  * Title matches target role "staff software engineer"
  * ai agent
  * typescript

Weaknesses:
  * Wants rust (no direct evidence in profile)

Compensation: GREEN - Range top $213k reaches the stretch band.
Competition proxy: 61/100 (262 open roles at this company in the index).
```

---

## Hard filters

The governing principle: **reject on evidence, never on absence of evidence.**

A missing salary, an unlabeled location, or an unfamiliar tool is *not* a rejection — those are handled by scoring, which down-ranks. Only things positively known to disqualify a role become filters:

- Wrong specialty **named in the title** (iOS, embedded, Java, SAP…)
- Wrong function named in the title (marketing manager, recruiter, PM…)
- Below senior
- Location unworkable — onsite/hybrid outside Austin, or remote scoped to a region you can't work in
- Work authorization you can't satisfy (clearances)
- Mandatory domain experience you don't have (ML research, PhD)
- **Published** compensation below the hard floor
- Internship / part-time

The most important distinction in the whole system: **a technology in the TITLE is the core job; the same technology in the body is usually a nice-to-have.** Title exclusions reject. Body mentions only subtract points. Senior engineers learn tools; they do not change specialty.

`UNKNOWN` compensation never rejects. Most small companies where you'd be differentiated don't publish a range, and treating silence as a negative systematically filters out the best lane.

---

## Compensation model

Salary parsing is deterministic and heavily tested — no LLM. The hard part isn't finding numbers, it's *not* finding the wrong ones: job descriptions are full of dollar figures that aren't compensation (`401(k)`, `$50B processed`, `$500 wellness stipend`, `10,000 customers`).

The parser requires a compensation cue **nearer to the number than any anti-cue**, and rejects anything outside a plausible band for its detected period. Period detection picks the **nearest** cue rather than a fixed precedence — without that, every annual range that happens to mention an hourly contractor rate later in the paragraph gets mislabeled hourly.

Bands, compared against annualized figures (hourly × 2080):

| Band | Meaning |
|---|---|
| `GREEN` | Comfortably reaches the target |
| `YELLOW` | Could plausibly reach it, or total package may compensate |
| `RED` | Strong evidence it's below the acceptable range |
| `UNKNOWN` | Insufficient information — **not a rejection** |

---

## Claude analysis

The only stage that costs money, so it's built around not spending it twice:

- **Deterministic prefilters run first.** Only jobs that passed hard filters and clear `analysis_threshold` are eligible.
- **Content-addressed caching.** Analyses are keyed on a hash of description + title + company + model + profile. An unchanged job is never re-analyzed. Change the profile and the key changes, so re-analysis happens exactly when it should.
- **Prompt caching.** The candidate profile is a stable system prefix marked `cache_control: ephemeral`, so the large invariant half of each request bills at cache-read rates after the first call.
- **Truncated descriptions** to a fixed character budget.
- **Structured output** via a hand-written JSON Schema, then re-validated with Zod before anything touches the database. Malformed output is rejected, not stored.

If a job's description changes on a later ingest, its cached analysis and score are invalidated automatically.

Output includes fit, ROI, lane, recommendation, strengths, risks, missing requirements (each labeled *mandatory domain* vs *learnable tool*), differentiation, compensation read, interview probability, competition estimate, and outreach target **titles** — never invented names.

Measured on a real run of 28 jobs with `claude-opus-5` at `medium` effort: **100% prompt-cache hit rate, ~$0.048/job.** `analyze` reports uncached / cache-write / cache-read / output tokens separately and warns if the cache is never read, since caching is what makes analyzing a large slate affordable.

### The analysis overrules the keyword engine

Where the two layers disagree, the analysis wins — `reconcileWithAnalysis` maps its recommendation onto priority and blends ROI 70/30 toward it.

This is not deference for its own sake. Keyword matching structurally **cannot read level or scale**. A posting demanding "10+ years of large-scale distributed systems and 3+ years as an org-wide technical lead" contains every right technology word and is still a two-level mismatch. That exact case occurred on the first live run: the keyword engine scored it 96 and made it Priority A; the analysis scored it 33 and said skip.

Hard-filter rejections still stand regardless. The analysis cannot make an onsite-in-Seattle role workable.

Expect the deterministic layer to run optimistic. Across 28 live analyses it over-scored consistently — that is the layer's known limitation, and the second layer exists to correct it.

---

## Status tracking and funnel analytics

```
NEW → REVIEWED → SAVED/APPLY → APPLIED → CONTACTED → SCREEN
    → INTERVIEW → FINAL → OFFER
    (or SKIPPED / REJECTED / WITHDRAWN / GHOSTED)
```

`stats` computes conversion between adjacent funnel stages and diagnoses the bottleneck — but **refuses to diagnose below ~15 applications**, reporting a sample warning instead. Confident nonsense from four data points is worse than no diagnosis.

Once there's volume, it distinguishes the failure modes that call for opposite responses:

- 50 applications → 2 screens ⇒ targeting/positioning problem
- 30 applications → 10 screens → 7 technicals → 4 finals → 0 offers ⇒ **stop optimizing the resume**; the problem is closing

That second case is called out explicitly, because it's the most common misdiagnosis in a job search.

---

## Data retention

Nothing overwrites history. The `jobs` row holds current state; `job_events` is append-only and records how it got there — `discovered`, `description_changed`, `salary_changed`, `status_changed`, `analyzed`. `job_sources` keeps **every** URL a canonical job was seen at, since syndication is the norm.

That history is itself signal: a role whose salary quietly moved, or whose description was rewritten, tells you something about the company's hiring.

---

## Deduplication

Jobs are syndicated aggressively — the same opening appears on the company's Greenhouse board, on Remote OK, and on aggregators, each with a different id and a slightly different title. Three passes, cheapest first:

1. **Exact key** — normalized company + normalized title + location bucket
2. **Content hash** — identical description at the same company (a repost under a new title is still one opportunity)
3. **Bounded fuzzy** — Jaccard token similarity ≥ 0.85 within the same company and location bucket

Deliberately deterministic; an LLM is not involved and shouldn't be. Dedupe runs over every job on every ingest, must be reproducible, and a hash comparison is both cheaper and more correct than a judgement call.

Level markers are preserved on purpose: `Engineer II` and `Engineer III` are different roles with different pay, and collapsing them would hide one.

---

## Adding a job source

1. Write an adapter in `src/sources/` implementing `JobSource`, emitting `SourceJob[]`.
2. Catch your own errors and record them on `ctx.stats` — **one failing source must never abort a run.**
3. Add a config block to `config/sources.yaml` and its schema entry in `src/config/schema.ts`.
4. Register it in `src/sources/registry.ts`.
5. Add a test in `tests/sources.test.ts` pinning the real payload shape.

No other file changes. Normalization, dedupe, filtering, and scoring all operate on the shared shape.

---

## Legal and ethical constraints

These are load-bearing, not decoration:

- **Only public, documented endpoints.** Greenhouse, Lever, and Ashby public board APIs; Remote OK's public JSON feed. No authentication is bypassed, no CAPTCHAs solved, no robots protections circumvented, no paywalls touched, no anti-bot systems defeated.
- **Rate limiting is not optional.** `PoliteFetcher` serializes requests per host with a configurable delay, honors `Retry-After`, and backs off on 429/5xx. It cannot be configured to zero delay.
- **Remote OK attribution is a condition of use.** Their API terms require a followed link back and naming them as the source. The generated report does this automatically. If you strip that attribution, disable the source in `config/sources.yaml` rather than quietly violating the terms.
- **Never invent experience.** The analysis prompt forbids fabricating employers, metrics, technologies, or people's names, and forbids claiming to have inspected a company's site or codebase. Outreach targets are role titles only.

If a company has no public feed, it goes in `watchlist` and gets researched by hand.

---

## Backing up the database

```bash
npm run cli -- backup                 # → data/backups/job-radar-<timestamp>.sqlite
npm run cli -- backup --out ~/Dropbox/job-radar
```

The command checkpoints the write-ahead log before copying, so the backup is complete rather than a torn snapshot. `data/` is gitignored — the database contains your application history and never belongs in the repo.

---

## Testing

```bash
npm test          # 151 tests
npm run typecheck
```

Coverage is concentrated where correctness actually matters and bugs would be silent:

- **Salary parsing** — ranges, k-suffixes, hourly, annualization, and the false-positive cases (401k, revenue, stipends, customer counts)
- **Location** — remote/hybrid/onsite classification, metro rules, non-US geo-blocking
- **Seniority and employment type**
- **Deduplication** — syndication, level preservation, stability
- **Hard filters** — every reject reason, plus the things that must *not* reject
- **Scoring** — lane assignment, combos, determinism, bounds, small-company-beats-big-company ranking
- **Source adapters** — mocked against real observed payload shapes, including failure isolation
- **The shipped config itself** — lane and ROI weights must sum correctly

External services are mocked. The suite runs offline in under a second.

---

## Status

**Phase 1 is complete, running, and verified end to end against live sources and the live API.** See `TODO.md` for what's next.

Implemented: TypeScript project, SQLite schema, normalized job model, four sources, deduplication, hard filters, explainable scoring, structured Claude analysis with two-layer reconciliation, daily markdown report, manual status tracking, funnel metrics, interview database, 151 tests.

A representative full run: 5,548 fetched → 539 duplicates collapsed → 638 pass hard filters → 28 analyzed → **1 Priority A, 3 Priority B.** A single-digit actionable slate out of five thousand postings is the intended output, not a bug.

Not yet implemented: company research, resume tailoring, outreach drafting, reverse company search, opportunity detection, web dashboard.

---

## License

Private. Contains a personal career profile.
