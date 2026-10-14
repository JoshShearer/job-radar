# Job Radar

A local-first job search assistant: it sweeps public job boards, ranks postings deterministically, spends money on model judgement only for the best-ranked few, prepares honest application material from the candidate's own evidence, fills forms in an ordinary browser, and reads application mail. It never submits, never sends, and never claims anything the evidence does not.

Several terms below are near-synonyms in ordinary English but denote different things here. Collapsing them has caused real regressions, which is why they are pinned.

## Language

### Records

**Fact**:
Something observed or decided, stored append-only: a posting version, a sweep, a pursuit or application event, a model call, a mail message. Never updated; a mistaken event is corrected by a **void**, which keeps the record.
_Avoid_: row, status

**Derivation**:
A value computed from inputs (a model's assessment, a resume plan, a parsed posting), stored under the hash of exactly those inputs. "Current" means "the answer to the request we would make now"; staleness needs no code.
_Avoid_: cache entry, analysis column

**Read model**:
A table rebuilt whole from facts and derivations, never edited: the **ranking**.
_Avoid_: index, jobs table

### Catalog

**Posting**:
What one board lists under one external id, at one moment. Observed as **posting versions**.
_Avoid_: job (ambiguous: a posting or an opportunity)

**Opportunity**:
One real role, which may be posted on several boards or in several locations. Its postings are its **aliases**. Judged on its best variant: a role acceptable in one location is not rejected because another alias is elsewhere.
_Avoid_: job, listing

**Posting state**:
`open`, `missing` (not listed by the latest complete sweep, not yet for long), `closed`, or `unknown` (no complete sweep of its board). Derived from sweeps, never set by hand.
_Avoid_: status, active

**Watchlist**:
A company with no public feed, held for manual research. Not a source; produces no postings.

### Evaluation

**Eligible**:
Passed the deterministic hard filters (location, work authorization, exclusions). A floor on what *may* be assessed, not a decision that anything will be.
_Avoid_: qualified, passing

**Keyword fit** (raw fit):
The deterministic score. Reliable in *relative* terms, unreliable in absolute ones. Never gate on its absolute value.
_Avoid_: score, match score

**Calibration** and **projected fit**:
Calibration measures how far keyword fit drifts from the analyst (median ratio over postings that have both) and projects that correction onto unassessed postings, so one ranking compares like with like. Below its sample floor it is reported, not applied. Raw, projected and analyst scores are separate fields; one never overwrites another.

**Rank** and **selected**:
Rank is position in the ranking. Assessment selects by rank, spread across companies, within budgets (ADR-0001). Selected is a much smaller set than eligible.

**Assessment** (verdict):
The model's structured judgement of a posting, at one of two **tiers**: **triage** (cheap) and **dossier** (full). Two-stage routing buys a dossier only when triage earns one. A **legacy assessment** (imported from v1) is never current.
_Avoid_: AI score, rating, analysis

**Lane**:
A career track in `config/search/strategy.yaml`. Describes what kind of role a posting is, not how good it is.
_Avoid_: category, priority

**Priority** (A-D):
A band from projected or analyst fit and ROI, set in `config/policy/evaluation.yaml`.

### Pursuit and outcomes

**Pursuit**:
The candidate's own decisions about an opportunity: `new`, `reviewed`, `shortlisted`, `preparing`, `skipped`, `applied`. Only a human's explicit yes records `applied`.
_Avoid_: status

**Application**:
What happened after a submission, as employers reported it: `submitted`, `contacted`, `screen`, `interview`, `final`, `offer`, `rejected`, `withdrawn`, `ghosted`. State is a fold over events in the order they **occurred**, not the order they were recorded.
_Avoid_: status, stage (stage is one value of it)

**Ghosted** and **silence**:
Silence becomes a ghosting *suggestion* only when mail coverage spans it. Without coverage the funnel says "unobserved". Nothing writes `ghosted` automatically.

### Candidate and materials

**Evidence ledger** and **claim**:
`config/candidate/evidence.yaml` is the only source of claims about the candidate. A claim has an id, text, skills, a **scope** (`used` < `contributed` < `built` < `owned` < `led`), and `verified`. `verified: false` means never cite it.
_Avoid_: resume, bullet (a bullet is a rendering of a claim)

**Covered / partial / gap**:
A requirement against the evidence. `partial` (right technology, wrong scope) is what prevents over-claiming; never collapse it into yes/no.

**Qualifier**:
What a requirement asks beyond the raw skill: leadership, team size, org-wide reach, scale, open source, migration, speaking, seniority title, revenue impact, awards. Each must be evidenced independently. Using a library is not contributing to it.

**Verify**, **revert** and **refuse**:
Every outbound sentence is verified against the claims it cites (allowlist: numbers with units, technologies, scope, qualifiers, names). A failing resume rewrite is **reverted** to the candidate's own wording; a failing pack sentence is **refused** and listed; a form answer with any refused sentence is not used. Uncited text may only frame interest or intent.
_Avoid_: rejecting, correcting, fixing

**Generation**:
One immutable directory of material for one opportunity (a resume, or a **pack**: cover letter and form answers). Re-rendering writes a new generation; a sent one is never overwritten. A pack is used by `fill` only after it is **approved**.

### Applying

**Fill** and **submit**:
`jr fill` types into an employer's form. It never submits, never ticks a checkbox, never affirms an attestation, never answers a demographic question. The second word is never this system's action.
_Avoid_: apply, complete, send

**Unknown** and **default**:
An unset value in `personal.yaml` is unknown, never a default, and a drafted pack answer does not fill it either. Answering "no sponsorship needed" for someone who needs it is a false statement on a job application.
_Avoid_: empty, blank
