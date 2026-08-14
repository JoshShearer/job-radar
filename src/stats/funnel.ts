import type { JobRepo } from "../db/repo.js";
import { FUNNEL_STAGES, stagesReached, type FunnelStage, type Status } from "../model/status.js";

export interface FunnelReport {
  stageCounts: Record<FunnelStage, number>;
  conversions: { from: FunnelStage; to: FunnelStage; rate: number | null; n: number }[];
  hypotheses: string[];
  sampleWarning: string | null;
}

/**
 * Funnel analytics with an explicit guard against overfitting.
 *
 * The failure mode this is built to avoid is confident nonsense from four data
 * points. Every diagnosis below states the sample size it is based on, and no
 * bottleneck is named at all until the relevant stage has enough volume to
 * distinguish a real pattern from noise.
 */
export function buildFunnel(repo: JobRepo): FunnelReport {
  const statusCounts = repo.statusCounts();

  const stageCounts = Object.fromEntries(FUNNEL_STAGES.map((s) => [s, 0])) as Record<FunnelStage, number>;
  for (const [status, count] of Object.entries(statusCounts)) {
    for (const stage of stagesReached(status as Status)) {
      stageCounts[stage] += count;
    }
  }

  // Interview records are the authoritative source for late-stage progress:
  // a job marked REJECTED tells us nothing about how far it got, but the
  // interview log does.
  const interviewStages = repo.interviewStageCounts();
  const bump = (stage: FunnelStage, n: number) => {
    stageCounts[stage] = Math.max(stageCounts[stage], n);
  };
  bump("SCREEN", countAny(interviewStages, ["Recruiter Screen"]));
  bump("INTERVIEW", countAny(interviewStages, ["Hiring Manager", "Technical", "Take-home", "Panel"]));
  bump("FINAL", countAny(interviewStages, ["Final"]));
  bump("OFFER", countAny(interviewStages, ["Offer"]));

  const conversions: FunnelReport["conversions"] = [];
  for (let i = 0; i < FUNNEL_STAGES.length - 1; i++) {
    const from = FUNNEL_STAGES[i]!;
    const to = FUNNEL_STAGES[i + 1]!;
    const n = stageCounts[from];
    conversions.push({ from, to, rate: n > 0 ? stageCounts[to] / n : null, n });
  }

  const { hypotheses, sampleWarning } = diagnose(stageCounts);
  return { stageCounts, conversions, hypotheses, sampleWarning };
}

function countAny(counts: Record<string, number>, keys: string[]): number {
  return keys.reduce((a, k) => a + (counts[k] ?? 0), 0);
}

/**
 * Minimum observations before a stage's conversion rate is worth reading.
 *
 * Exported because the dashboard gates its trend chart on the same floor. Two
 * copies of this number would eventually disagree, and the failure is silent
 * and contradictory: a page drawing a chart directly under its own warning that
 * the numbers are noise.
 */
export const MIN_SAMPLE = {
  applied: 15,
  screen: 6,
  technical: 4,
  final: 3,
};

function diagnose(s: Record<FunnelStage, number>): { hypotheses: string[]; sampleWarning: string | null } {
  const hypotheses: string[] = [];
  let sampleWarning: string | null = null;

  if (s.APPLIED < MIN_SAMPLE.applied) {
    sampleWarning =
      `Only ${s.APPLIED} applications logged. Below ~${MIN_SAMPLE.applied} the conversion rates are noise, ` +
      `so no bottleneck is diagnosed yet. Keep marking outcomes with \`status <job-id> APPLIED\`.`;
    return { hypotheses, sampleWarning };
  }

  const appliedToScreen = s.APPLIED > 0 ? s.SCREEN / s.APPLIED : 0;
  const screenToInterview = s.SCREEN > 0 ? s.INTERVIEW / s.SCREEN : 0;
  const interviewToFinal = s.INTERVIEW > 0 ? s.FINAL / s.INTERVIEW : 0;
  const finalToOffer = s.FINAL > 0 ? s.OFFER / s.FINAL : 0;

  // Bottleneck 1: targeting / resume / positioning.
  if (appliedToScreen < 0.08) {
    hypotheses.push(
      `TARGETING OR POSITIONING: ${s.SCREEN} screens from ${s.APPLIED} applications (${pct(appliedToScreen)}). ` +
        `Industry-typical is 10-20% for well-targeted senior applications. The likely causes, in order: ` +
        `applying to roles where you are not differentiated, resume not matching the posting's language, ` +
        `or applying too late after posting. Check the ROI scores on what you actually applied to - if they ` +
        `were mostly below 70, the problem is target selection, not the resume.`,
    );
  } else if (appliedToScreen > 0.25) {
    hypotheses.push(
      `Targeting is working: ${pct(appliedToScreen)} of applications convert to a screen. ` +
        `Consider raising the bar - apply to fewer, higher-ROI roles and spend the saved time on outreach.`,
    );
  }

  // Bottleneck 2: recruiter screen.
  if (s.SCREEN >= MIN_SAMPLE.screen && screenToInterview < 0.4) {
    hypotheses.push(
      `RECRUITER SCREEN: ${s.INTERVIEW} advanced from ${s.SCREEN} screens (${pct(screenToInterview)}). ` +
        `The screen is usually lost on one of three things: compensation stated too early or too high, ` +
        `an unclear 60-second summary of what you do, or a seniority/scope mismatch surfacing late. ` +
        `Review your logged compensation conversations - \`job-radar interview list\`.`,
    );
  }

  // Bottleneck 3: technical.
  if (s.INTERVIEW >= MIN_SAMPLE.technical && interviewToFinal < 0.4) {
    hypotheses.push(
      `TECHNICAL STAGE: ${s.FINAL} finals from ${s.INTERVIEW} technical interviews (${pct(interviewToFinal)}). ` +
        `Look at the questions logged in the interview database for a repeated topic. If the same area ` +
        `appears in multiple 'uncertainty_areas' entries, that is the thing to drill.`,
    );
  }

  // Bottleneck 4: closing.
  if (s.FINAL >= MIN_SAMPLE.final && finalToOffer < 0.34) {
    hypotheses.push(
      `CLOSING: ${s.OFFER} offers from ${s.FINAL} finals (${pct(finalToOffer)}). ` +
        `At this point the resume is definitively not the problem - you are getting to the end and losing there. ` +
        `The usual causes are compensation misalignment surfacing late, references, or a final-round fit ` +
        `conversation going sideways. This is where to focus, not on more applications.`,
    );
  }

  // The classic misdiagnosis, called out explicitly.
  if (appliedToScreen >= 0.15 && s.FINAL >= MIN_SAMPLE.final && s.OFFER === 0) {
    hypotheses.push(
      `STOP OPTIMIZING THE RESUME. ${s.APPLIED} applications produced ${s.SCREEN} screens and ${s.FINAL} finals ` +
        `with ${s.OFFER} offers. The top of the funnel is healthy. Everything upstream is working and the ` +
        `problem is at the end: interviewing, closing, references, compensation, or final-stage role fit.`,
    );
  }

  if (hypotheses.length === 0) {
    hypotheses.push(
      `No bottleneck stands out at current volume (${s.APPLIED} applications, ${s.SCREEN} screens, ` +
        `${s.OFFER} offers). Rates are within normal variance.`,
    );
  }

  return { hypotheses, sampleWarning };
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/** Render the funnel as a terminal-friendly block. */
export function renderFunnel(report: FunnelReport, statusCounts: Record<string, number>): string {
  const L: string[] = [];
  L.push("FUNNEL");
  L.push("------");
  for (const stage of FUNNEL_STAGES) {
    L.push(`  ${stage.padEnd(12)} ${String(report.stageCounts[stage]).padStart(5)}`);
  }
  L.push("");
  L.push("CONVERSION");
  L.push("----------");
  for (const c of report.conversions) {
    const rate = c.rate == null ? "  n/a" : `${(c.rate * 100).toFixed(0).padStart(4)}%`;
    L.push(`  ${`${c.from} -> ${c.to}`.padEnd(28)} ${rate}   (n=${c.n})`);
  }
  L.push("");
  L.push("STATUS BREAKDOWN");
  L.push("----------------");
  for (const [status, count] of Object.entries(statusCounts).sort((a, b) => b[1] - a[1])) {
    L.push(`  ${status.padEnd(12)} ${String(count).padStart(5)}`);
  }
  L.push("");
  L.push("DIAGNOSIS");
  L.push("---------");
  if (report.sampleWarning) {
    L.push(`  ! ${wrap(report.sampleWarning, 4)}`);
    L.push("");
  }
  for (const h of report.hypotheses) {
    L.push(`  * ${wrap(h, 4)}`);
    L.push("");
  }
  return L.join("\n");
}

function wrap(text: string, indent: number): string {
  const width = 92 - indent;
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + w).length > width) {
      lines.push(line.trimEnd());
      line = "";
    }
    line += `${w} `;
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines.join(`\n${" ".repeat(indent)}`);
}
