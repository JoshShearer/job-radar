import { progressRank, type ApplicationState } from "./machines.js";

/**
 * Funnel analytics that refuse to diagnose on noise. Stage counts come from
 * the FURTHEST stage each application ever reached (from its event history),
 * not from where it ended up, so a rejection after an interview still counts
 * as reaching the interview.
 */
export const FUNNEL_STAGES = ["discovered", "eligible", "submitted", "screen", "interview", "final", "offer"] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

export const MIN_SAMPLE = { submitted: 15, screen: 6, interview: 4, final: 3 } as const;

export interface FunnelReport {
  counts: Record<FunnelStage, number>;
  conversions: Array<{ from: FunnelStage; to: FunnelStage; rate: number | null; n: number }>;
  hypotheses: string[];
  sampleWarning: string | null;
}

export function buildFunnel(input: { discovered: number; eligible: number; furthest: readonly ApplicationState[] }): FunnelReport {
  const reached = (s: ApplicationState) => input.furthest.filter((f) => progressRank(f) >= progressRank(s)).length;
  const counts: Record<FunnelStage, number> = {
    discovered: input.discovered,
    eligible: input.eligible,
    submitted: input.furthest.length,
    screen: reached("screen"),
    interview: reached("interview"),
    final: reached("final"),
    offer: reached("offer"),
  };
  const conversions: FunnelReport["conversions"] = [];
  for (let i = 0; i < FUNNEL_STAGES.length - 1; i++) {
    const from = FUNNEL_STAGES[i]!;
    const to = FUNNEL_STAGES[i + 1]!;
    const n = counts[from];
    conversions.push({ from, to, rate: n > 0 ? counts[to] / n : null, n });
  }
  return { counts, conversions, ...diagnose(counts) };
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/** "100% (n=1)", never a bare 100%; "n/a" for an empty stage; "<1%" for a real rate that rounds to zero. */
export function formatRate(rate: number | null, n: number): string {
  if (rate === null || n === 0) return "n/a";
  if (rate > 0 && rate < 0.005) return `<1% (n=${n})`;
  return `${pct(rate)} (n=${n})`;
}

function diagnose(s: Record<FunnelStage, number>): { hypotheses: string[]; sampleWarning: string | null } {
  if (s.submitted < MIN_SAMPLE.submitted) {
    return {
      hypotheses: [],
      sampleWarning: `Only ${s.submitted} submitted application(s). Below ~${MIN_SAMPLE.submitted} conversion rates are noise, so no bottleneck is diagnosed yet.`,
    };
  }
  const h: string[] = [];
  const aToS = s.screen / s.submitted;
  const sToI = s.screen ? s.interview / s.screen : 0;
  const iToF = s.interview ? s.final / s.interview : 0;
  const fToO = s.final ? s.offer / s.final : 0;
  if (aToS < 0.08) {
    h.push(
      `TARGETING OR POSITIONING: ${s.screen} screens from ${s.submitted} applications (${pct(aToS)}). Check what you applied to: if most lacked an endorsing assessment or were weeks old, the problem is selection, not the resume.`,
    );
  } else if (aToS > 0.25) {
    h.push(`Targeting is working: ${pct(aToS)} of applications reach a screen. Consider fewer, higher-ROI applications and more outreach.`);
  }
  if (s.screen >= MIN_SAMPLE.screen && sToI < 0.4) {
    h.push(`RECRUITER SCREEN: ${s.interview} advanced from ${s.screen} screens (${pct(sToI)}). Usually compensation surfaced early, an unclear summary, or a scope mismatch.`);
  }
  if (s.interview >= MIN_SAMPLE.interview && iToF < 0.4) {
    h.push(`TECHNICAL STAGE: ${s.final} finals from ${s.interview} interviews (${pct(iToF)}). Look for a repeated topic in the interview log.`);
  }
  if (s.final >= MIN_SAMPLE.final && fToO < 0.34) {
    h.push(`CLOSING: ${s.offer} offers from ${s.final} finals (${pct(fToO)}). The resume is not the problem at this stage.`);
  }
  if (aToS >= 0.15 && s.final >= MIN_SAMPLE.final && s.offer === 0) {
    h.push(`STOP OPTIMIZING THE RESUME. The top of the funnel is healthy; the losses are at the end.`);
  }
  if (!h.length) h.push(`No bottleneck stands out at current volume (${s.submitted} applications, ${s.screen} screens, ${s.offer} offers).`);
  return { hypotheses: h, sampleWarning: null };
}
