# Job Radar

A local-first job intelligence pipeline: it ingests postings from public feeds, scores them
deterministically, spends money on model analysis for only the best-ranked few, and prepares
— never sends — applications for a human.

Several terms below are near-synonyms in ordinary English but denote different things here.
Collapsing them has caused real regressions, which is why they are pinned.

## Language

### Scoring and selection

**Fit score**:
The deterministic keyword-engine score for a job, stored as `fit_score`. Reliable in
*relative* terms and unreliable in absolute terms — its mean absolute error against the
analyst is 26.6 points. Never gate on its absolute value.
_Avoid_: score, match score, relevance

**Rank**:
A job's position in the index ordered by fit score. Not a stored value — an ordering. The
rank is reliable where the fit score is not, which is why analysis selects the top K by rank
rather than by a threshold (see ADR-0001).
_Avoid_: using "score" and "rank" interchangeably

**Eligible**:
A job that passed the deterministic hard filters, recorded as `filter_passed`. Eligibility
is a floor on what *may* be analyzed, not a decision that anything will be.
_Avoid_: qualified, passing

**Selected**:
An eligible job that analysis actually chose to spend money on, by rank and within the
budget. Eligible is a much larger set than selected.
_Avoid_: shortlisted, picked

**Analysis** (or **verdict**):
The model's structured judgement of a job, validated against a schema before storage. It
overrules the keyword engine where they disagree.
_Avoid_: AI score, rating

**Lane**:
A career track defined in `config/career-profile.yaml`, carrying weights that sum to 1.
Describes what kind of role a job is, not how good it is.
_Avoid_: category, track, priority

**Watchlist**:
A company with no public feed, held for manual research. A watchlist entry is not a source
and produces no jobs.
_Avoid_: backlog, queue

### Resume and requirements

**Covered / partial / gap**:
The three states of a requirement against the career profile. `covered` — evidenced.
`partial` — right technology, wrong scope. `gap` — no evidence at all. The middle state is
what prevents over-claiming and must never be collapsed into a yes/no.
_Avoid_: match/no-match, met/unmet

**Qualifier**:
An attribute a requirement asks for beyond the raw skill — leadership, open source,
enterprise scale, migration, public speaking. Each must be evidenced *independently* of the
skill match. Using a library is not contributing to it.
_Avoid_: modifier, attribute

**Verified bullet**:
A bullet in `config/resume.yaml` marked `verified: true`. Only verified bullets are ever
selectable into a rendered resume; `verified: false` means never.
_Avoid_: approved, confirmed

**Rewrite** and **revert**:
A rewrite is a model's replacement wording for a master bullet. A revert is what provenance
enforcement does when that rewrite introduces a technology or a number the master did not
have: the master wording is restored. Reverting is always available, so overreaching can
only produce a worse resume, never a false one.
_Avoid_: rejecting, failing, correcting

### Applications

**Fill** and **submit**:
`autofill` fills — it types into an employer's form. It never submits, never ticks a
checkbox, never affirms an attestation, never answers a demographic question. The two words
are not two ends of one action; the second one is never taken by this system.
_Avoid_: apply, complete, send

**Unknown** and **default**:
An unset value in `config/personal.yaml` is unknown, never a default. Answering "no
sponsorship needed" on behalf of someone who needs it is a false statement on a job
application, not a mis-ranking.
_Avoid_: empty, blank, unspecified
