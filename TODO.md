# TODO

Open items for version 2, as of the migration (2026-10-14). Each one was observed, not guessed; the evidence is in the line. Linear (team JOB) is the tracker of record; this file is the short list.

## Measure

- **Two-stage routing is unmeasured on v2.** `jr benchmark-triage --mode routing` needs 40 dossiers bought independently of triage (`jr assess --single-stage`), about $4 at 2026-10 prices. Until then, two-stage is on by v1's 2026-09-09 measurement only.
- **Calibration runs on imported v1 assessments** (255 on the real index) until enough v2 assessments exist. Check `jr evaluate`'s calibration line after a few assessed passes; it reports how many pairs are imported.

## Ranking quality

- **Locations named only in the title are not read.** Cloudflare and others put the city in the title ("Senior Customer Engineer, Named - Toronto Canada") and only "Hybrid" in the location field, so such roles are eligible and warned "location unknown". v1 behaved the same. A title-location rule must not misfire on titles like "Majors - Southwest".
- **The search strategy's negative signal `go` matches "go-to-market"** (a GTM posting showed "Wants go"). Inherited from v1's config; `golang` in `config/search/strategy.yaml` would fix it.
- **Four configured boards return 404**: greenhouse amplitude, hightouch, clickhouse; ashby commonroom. They have probably moved ATS: `jr discover <company>`.

## Form filling

- **"Are you subject to any employment agreements...?" is classified as the current-employer question** (live, GitLab, 2026-10-14) and offered "ShroomSpy" against Yes/No. Harmless (no confident match, left for the human), but a classification miss.

## Performance

- **`jr evaluate` takes ~45 s and ~1.2 GB over 18k opportunities, and a repeat run is no faster.** The snapshot memo is not what dominates. Profile before the index doubles.

## Materials

- **Honest gap statements are refused** ("I don't have a claim evidencing Terraform...") because the verifier cannot safely parse negation; the affected form answers are left for the human. By design (strictness costs polish, never truth). A separate, explicitly typed "gap" item the model can emit, rendered from a fixed template, would recover them without loosening the verifier.
- The candidate's own `resume.yaml` summary ends with "Contact details in source: ..." which renders on every resume. That is ledger content, not a code issue: edit `config/candidate/evidence.yaml`.

## Untested live

- **Gmail** has not run against a real mailbox (`.eml` ingestion is tested).
