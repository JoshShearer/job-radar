# /verify override - job-radar

The verification target in `project.md` is the CLI itself. After the gates, determine the
affected area from `git diff --name-only origin/main...HEAD` and run the matching command. This
is the step that separates a green suite from working software (`CLAUDE.md` "Verification").

| Changed area | Command | What counts as pass |
|---|---|---|
| `src/adapters/ats/`, `src/adapters/http/`, `src/app/sweep.ts` | `npm run cli -- sources`, then `sweep --source <provider>` | Every configured board returns HTTP 200 with a non-empty list; no board aborted the sweep |
| `src/domain/catalog/`, `src/domain/evaluation/`, `src/app/evaluate.ts` | `npm run cli -- evaluate`, then `top` | Completes; eligible/priority counts and the calibration line move in the expected direction |
| `src/app/briefing.ts`, `src/ui/reports/`, `src/ui/web/` | `npm run cli -- report`, then `serve --port <free port>` | Briefing renders; Remote OK attribution present when that source is enabled; web UI answers on 127.0.0.1 only |
| `src/app/gateway.ts`, `src/app/assess*.ts`, `src/domain/llm/`, `src/domain/budget/` | `npm run cli -- assess --dry-run`, then a small `assess --limit 2 --max-spend 0.5` (**costs money**: say so, and only in an interactive session) | Completes; unchanged postings come from cache; `spend` matches the run's reported total |
| `src/domain/materials/`, `src/domain/candidate/`, `src/app/materials.ts` | `npm run cli -- evidence lint`, `evidence match <id>`, then `render <id>` (free) | `match` returns three states, not two; `repairs.md` and `pack-review.md` show nothing fabricated survived |
| `src/domain/browser/`, `src/adapters/browser/`, `src/app/fill.ts` | `npm test`, then `npm run cli -- fill <id> --headless` on a real posting (interactive only) | Form filled, **submit never clicked**, checkboxes untouched, demographics and attestations refused, unconfident dropdowns blank with options reported |
| `src/domain/config/`, `src/adapters/fs/config-loader.ts` | `npm run cli -- check` | Config loads; a bad key is an error, not a silent no-op |
| `src/adapters/sqlite/` | `npm run cli -- stats` against a copy of a real database | Migration clean, no data loss |
| `src/app/mail.ts`, `src/adapters/mail/` | `npm run cli -- mail scan --dry-run` | Pagination complete; nothing written on a dry run |

Record the exact command and its outcome. If the area cannot be exercised without the owner's
personal data (`config/candidate/evidence.yaml`, `config/candidate/personal.yaml`) and those files
are absent, say so plainly rather than reporting the step as passed.

**Ports.** The owner's own `jr serve` may hold the default 4180, serving real data. Never
`npm run serve`; run `npm run cli -- serve --port <p>` on a port `ss -Hltn "sport = :<p>"` shows
free, and confirm the server reports `<p>` before grading it.

**Statuses.** There is no `In Review` (`tickets.md`): the pre-merge state is In Progress with an
open PR.
