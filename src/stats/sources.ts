/**
 * Per-source scorecard.
 *
 * Boards were added because the companies seemed interesting, not because they
 * post roles that match. This turns that into a measurement, with one rule
 * running through it: a source is only condemned on evidence, and a small
 * sample is not evidence.
 */

export interface SourceRow {
  source: string;
  /** Postings ingested, ever. */
  ingested: number;
  /** ...that cleared the hard filters. */
  passed: number;
  /** ...that were paid for. */
  analyzed: number;
  /** ...that the analyst recommended applying to. */
  applies: number;
  /** ...that were actually applied to. */
  appliedTo: number;
  /** ...that have since left their board. */
  closed: number;
}

export type SourceVerdict = "productive" | "watch" | "retire" | "insufficient data";

export interface SourceScore extends SourceRow {
  /** Share of ingested postings that clear the filters. */
  passRate: number;
  /**
   * Share of FILTER-PASSING postings that were ever analyzed.
   *
   * The most informative column, and the least obvious. Selection is by rank,
   * so this measures whether a source's jobs can compete once they are in the
   * pool - not whether they are eligible. A source that passes everything and
   * is never selected is inflating the pool without contributing to it.
   */
  selectionRate: number;
  /** Share of analyses that came back apply. */
  applyRate: number;
  verdict: SourceVerdict;
  why: string;
}

export interface SourcePolicy {
  /**
   * Analyses a source needs before a zero-apply record means anything.
   *
   * This is the guard against the obvious mistake. At a baseline apply rate
   * around 8%, six analyses returning zero applies is the expected outcome
   * roughly 60% of the time - it is not evidence of a bad source, it is a
   * small number. Condemning on it would retire a board for being unlucky.
   */
  minAnalyzedForVerdict: number;
  /** Apply rate below this, with enough analyses, is a retirement case. */
  retireBelowApplyRate: number;
  /**
   * Selection rate below this means a source's jobs pass filters and then
   * never rank well enough to be worth buying. Pool inflation.
   */
  watchBelowSelectionRate: number;
  /**
   * Filter-passing jobs a source needs before its SELECTION rate is evidence.
   *
   * Selection evidence needs a different threshold from apply evidence,
   * because it is free. Analysing a job costs money, so a source can sit at
   * "insufficient data" forever if its jobs never rank - which is exactly the
   * situation the selection rate is describing. Judging it on how its jobs
   * RANK escapes that trap without spending anything.
   */
  minPassedForSelectionVerdict: number;
}

export function scoreSources(rows: readonly SourceRow[], policy: SourcePolicy): SourceScore[] {
  const div = (a: number, b: number): number => (b > 0 ? a / b : 0);

  return rows
    .map((r): SourceScore => {
      const passRate = div(r.passed, r.ingested);
      const selectionRate = div(r.analyzed, r.passed);
      const applyRate = div(r.applies, r.analyzed);

      let verdict: SourceVerdict;
      let why: string;

      // Checked BEFORE the small-sample guard, on purpose. A source whose jobs
      // never rank can never accumulate enough analyses to be judged on
      // applies, so deferring to that guard would park it at "insufficient
      // data" permanently. How its jobs rank is evidence in its own right, and
      // it is evidence that costs nothing to gather.
      const floodsWithoutRanking =
        r.passed >= policy.minPassedForSelectionVerdict && selectionRate < policy.watchBelowSelectionRate;

      if (floodsWithoutRanking) {
        verdict = "retire";
        why =
          `passes ${(passRate * 100).toFixed(0)}% of what it sends (${r.passed} jobs) and only ` +
          `${(selectionRate * 100).toFixed(1)}% of those ever rank high enough to analyse. It fills ` +
          `the pool without competing in it, and will never earn a fair apply sample as a result`;
      } else if (r.analyzed < policy.minAnalyzedForVerdict) {
        // The important branch. Never retire on a sample too small to mean
        // anything, however tempting the zero looks.
        verdict = "insufficient data";
        why =
          `only ${r.analyzed} analysed, need ${policy.minAnalyzedForVerdict} before a zero-apply ` +
          `record is evidence rather than a small number`;
        if (r.passed > 0 && selectionRate < policy.watchBelowSelectionRate) {
          why += `; passes ${(passRate * 100).toFixed(0)}% of what it sends but only ` +
            `${(selectionRate * 100).toFixed(1)}% of those ever rank high enough to analyse`;
        }
      } else if (applyRate < policy.retireBelowApplyRate) {
        verdict = "retire";
        why = `${r.applies} applies from ${r.analyzed} analyses (${(applyRate * 100).toFixed(1)}%)`;
      } else if (selectionRate < policy.watchBelowSelectionRate) {
        verdict = "watch";
        why = `productive when analysed, but only ${(selectionRate * 100).toFixed(1)}% of its ` +
          `filter-passing jobs ever rank high enough to be`;
      } else {
        verdict = "productive";
        why = `${r.applies} applies from ${r.analyzed} analyses (${(applyRate * 100).toFixed(1)}%)`;
      }

      return { ...r, passRate, selectionRate, applyRate, verdict, why };
    })
    .sort((a, b) => b.applies - a.applies || b.analyzed - a.analyzed);
}
