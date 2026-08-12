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
`job-radar serve` currently provides a read-only static server over the
generated briefings (loopback-only, path-contained). That is a viewer, not an
application. A real dashboard would add:
- [ ] Next.js app over the same SQLite database
- [ ] Kanban by status; scoring explainability visible per job
- [ ] Status changes and notes from the browser instead of the CLI
- [ ] Read-only first; no action taken without an explicit click

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
- **The scoring `analysis_threshold` gate is a blunt cost control.** A job just
  below it never gets an LLM read even if it's unusual.
- **No retry queue for failed analyses.** A failure is logged and skipped; the
  next run retries it because nothing was cached.
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
