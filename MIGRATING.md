# Migrating a version 1 checkout to version 2

Version 2 replaces the code, the config layout and the database. Your v1 data is imported, not converted in place: the v1 database is only ever read, so the old install stays recoverable until you delete it.

**Do step 1 before you pull.** Pulling v2 deletes v1's tracked config files (`config/career-profile.yaml`, `config/sources.yaml`), and the import needs them. Your untracked personal files (`config/resume.yaml`, `config/personal.yaml`, `.env`, `data/`, `applications/`) are left on disk by the pull, and v2's `.gitignore` keeps them out of commits.

## 1. Set the v1 files aside (on the v1 checkout, before pulling)

```bash
cd ~/Dev/job-radar                     # your v1 checkout
systemctl --user stop job-radar-daily.timer 2>/dev/null || true   # no v1 pass mid-copy
mkdir -p legacy-v1
cp -a config legacy-v1/config          # career-profile, sources, resume, personal
mkdir -p legacy-v1/data
cp -a data/job-radar.sqlite legacy-v1/data/   # plus -wal/-shm if present
ls legacy-v1/config legacy-v1/data
```

`legacy-v1/` is ignored by v2's `.gitignore`. Keep it until you are satisfied with the import.

## 2. Pull version 2

```bash
git pull                               # or: git checkout main && git pull
npm ci
npx playwright install chromium
```

`.env` (your `ANTHROPIC_API_KEY`) carries over unchanged.

## 3. Import

```bash
npm run cli -- import-legacy --db legacy-v1/data/job-radar.sqlite --old-root legacy-v1
npm run cli -- check
npm run cli -- evaluate
npm run cli -- sweep                   # the first sweep re-observes every board
npm run cli -- evaluate
```

What the import does:

- `career-profile.yaml` and `sources.yaml` become `config/search/strategy.yaml`, `config/candidate/preferences.yaml`, `config/policy/evaluation.yaml`, `config/operations.yaml` and `config/sources.yaml`. `resume.yaml` becomes the evidence ledger `config/candidate/evidence.yaml`; `personal.yaml` is copied to `config/candidate/personal.yaml`.
- Every job, its posting links and its status history come across as events at their original times. Pursuit decisions (REVIEWED, SAVED, SKIPPED, APPLY) and application outcomes are separate machines now; APPLY means "preparing", and only APPLIED is a submission.
- Imported assessments are kept for reference and never count as current. Until enough new assessments exist, they still calibrate the ranking.
- Model spend history is imported into the one ledger.
- Nothing is inferred open or closed until the first sweep.

Read the notes it prints. On the 2026-10-14 trial against a real v1 database (16,309 jobs) they were:

- **Automatic GHOSTED outcomes.** v1 marked applications ghosted after 30 days without ever reading mail. They are imported, flagged `system`, and listed by `jr apps --events`. Void any that were wrong: `jr void application <event-id> --reason "..."`.
- **Contested posting links.** v1's content dedupe sometimes linked one posting to two different jobs. Each posting stays with the job it belongs to; unclaimed ones are re-matched by the next sweep.
- **Corrections.** A status moved back to APPLIED by hand in v1 voids the state it undid.
- **Unconfirmed submissions** (if any): an application whose v1 history starts with a later state, such as a rejection read from mail, is imported as `UNCONFIRMED`. Void it if you never submitted.

The trial took about 25 s for the import, about 3 min for the first sweep of 217 boards, and about 45 s per `evaluate`.

## 4. Schedule

```bash
deploy/install-timer.sh
```

This disables v1's `job-radar-daily.timer` if it is installed, and installs `jr-daily.timer` (backup, then sweep, mail, evaluate and the briefing; it spends nothing unless you add `--assess` to the unit).

## 5. Check, then tidy up

```bash
npm run cli -- apps                    # your applications and their states
npm run cli -- top                     # the ranked list
npm run cli -- serve                   # the local web UI
```

v1's application documents stay in `applications/`; v2 writes new ones under `artifacts/`. When you are satisfied, `legacy-v1/` and `data/job-radar.sqlite` can be deleted. Until then, the tag `v1-final` and those files are a complete way back.

## Rolling back

```bash
systemctl --user disable --now jr-daily.timer
mv config config-v2                    # v2's untracked config would block the checkout
git checkout v1-final
cp -a legacy-v1/config/. config/       # resume.yaml and personal.yaml (the tracked files are back already)
npm ci
deploy/install-timer.sh                # the v1 installer, from the v1 tree
```

The v1 database was never written by v2.
