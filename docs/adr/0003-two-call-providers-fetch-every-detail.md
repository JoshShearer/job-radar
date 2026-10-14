# Two-call providers fetch every listed posting's detail, every sweep

> Decided 2026-10-14 (JOB-71). Applies to `src/adapters/ats/workable.ts` and `src/adapters/ats/smartrecruiters.ts`.

Greenhouse, Lever and Ashby return a board's descriptions inline: one request per board.
Workable and SmartRecruiters do not. Their public list endpoints carry no description, so a
posting costs a second request to its detail endpoint:

| Provider | List | Detail |
|---|---|---|
| Workable | `apply.workable.com/api/v1/widget/accounts/{token}` | `apply.workable.com/api/v1/accounts/{token}/jobs/{shortcode}` |
| SmartRecruiters | `api.smartrecruiters.com/v1/companies/{id}/postings?limit=100&offset=N` (paged until `totalFound`) | `api.smartrecruiters.com/v1/companies/{id}/postings/{postingId}` |

## Decision

Each sweep lists the whole board, then fetches the detail of **every** listed posting, in
sequence, through the ordinary polite transport. There is no cap, no prefilter and no host
special-casing; the per-host floor (`delay_ms`, never below the 500 ms code floor) applies to
every request. If any detail fetch fails, or a detail has no description text, the adapter
throws and the sweep records the whole board as failed (its postings are left as they were).
A SmartRecruiters page that comes back empty before `totalFound` is reached also fails the board.

Workable's list repeats a multi-location posting once per location under one shortcode; the
adapter fetches that detail once (the detail carries every location).

## Why not the cheaper options

- **Cap per company per pass, drain across passes.** Posting lifecycle is derived from sweeps:
  absence from a *complete* sweep means the posting closed. A capped sweep would either be
  recorded as complete (and read every unfetched posting as closed) or never be complete.
- **Fetch details only for postings that survive the deterministic prefilters.** The prefilters
  read the description (remote status falls back to it, seniority and keywords come from it), and
  a posting stored without its description would change its payload and material hash the moment
  the description arrived: a fetch artefact would look like a material change.
- **Cache descriptions by shortcode / posting id.** Adapters are dumb and cannot reach the store;
  a cache needs a new port and its own invalidation story (a provider edits a description without
  changing the id). Unchanged postings already cost nothing downstream: the payload hash is the
  same, so no new version, snapshot or assessment is bought. Only wall clock is spent.

The cost is wall clock, which is cheap at night and bounded by board size. That is why
`config.example/sources.yaml` ships both providers enabled with no boards, and why small boards
are preferred (the curation rationale already down-ranks companies with hundreds of open roles).

## Measured (2026-10-14, `delay_ms: 1200`, `npm run cli -- sweep --source <provider>`, wall clock including CLI start-up)

- Workable `futurae`: 3 list rows, 1 unique posting, 2 requests: **4.2 s** (6.7 s before the
  per-shortcode de-duplication, when it fetched the same detail three times).
- SmartRecruiters `Vitol`: 34 postings, 35 requests: **58.9 s**.

So roughly `(postings + pages) x delay_ms`. A 336-posting SmartRecruiters company would take
about seven minutes; providers sweep in parallel, so it does not delay the other providers.

## Known limit

An unknown SmartRecruiters company identifier answers HTTP 200 with `totalFound: 0`, exactly like
a company with no openings. The adapter maps both to an empty board (not an error), and
`jr sources` reports both as live. Check a new identifier against the company's
`jobs.smartrecruiters.com/{id}` page before adding it.
