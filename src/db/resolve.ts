import type { JobRepo } from "./repo.js";
import type { EnrichedJob } from "../model/job.js";
import { isInFlight } from "../model/status.js";

export type Resolution = { job: EnrichedJob } | { job: null; message: string };

/**
 * Resolve a job from whatever a human typed.
 *
 * Order: exact id, then unique id prefix (`repo.get` does both), then - only
 * where the caller opts in - a company name. Ambiguity is never resolved by
 * picking one; the candidates come back in the message and the command stops.
 *
 * Company matching is deliberately NOT offered to `apply` or `autofill`. A
 * wrong id there costs a re-run; a wrong company spends a paid model call, or
 * types the candidate's personal details into a different employer's form.
 * Company names collide far more readily than generated ids do, and the house
 * rule elsewhere in this codebase - see `chooseOption` - is to refuse a
 * near-match rather than guess at it.
 *
 * Lives here rather than in `cli.ts` because it decides which job gets written
 * to, and `cli.ts` executes its command tree on import, so nothing there can be
 * tested.
 */
export function resolveJob(repo: JobRepo, query: string, opts: { byCompany?: boolean } = {}): Resolution {
  const byId = repo.get(query);
  if (byId) return { job: byId };

  if (!opts.byCompany) {
    return { job: null, message: `No job matches "${query}". Use \`job-radar top\` to list ids.` };
  }

  const matches = repo.findByCompany(query);
  if (matches.length === 0) {
    return {
      job: null,
      message: `No job matches "${query}" by id or company. Try \`job-radar inflight\` or \`job-radar top\`.`,
    };
  }

  // A company name means the role you have going there. One employer had 20
  // open postings in the index and a single application in flight; "status
  // vercel SCREEN" is unambiguous to a human and only ambiguous to a naive
  // match. Narrowing to in-flight first is what makes this path usable at all -
  // without it, any employer posting more than one role falls back to an id.
  const live = matches.filter((j) => isInFlight(j.status));
  const unique = live.length === 1 ? live[0] : matches.length === 1 ? matches[0] : undefined;
  if (unique) return { job: unique };

  // Still ambiguous: several live roles at one employer, or none live and
  // several postings. List them and stop.
  const candidates = live.length > 1 ? live : matches;
  const shown = candidates
    .slice(0, 10)
    .map((j) => `  ${j.id}  ${j.status.padEnd(9)} ${j.company} - ${clip(j.title, 46)}`);
  const more = candidates.length > 10 ? `\n  ...and ${candidates.length - 10} more` : "";
  const what = live.length > 1 ? `${live.length} roles in flight` : `${matches.length} jobs`;
  return {
    job: null,
    message: `"${query}" matches ${what}. Re-run with one of these ids:\n${shown.join("\n")}${more}`,
  };
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}...` : s;
}
