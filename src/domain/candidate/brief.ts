import type { Preferences, Strategy } from "../config/schema.js";
import { verifiedClaims, type Evidence } from "./evidence.js";
import { hashInput } from "../../kernel/hash.js";

/**
 * The candidate as every model prompt sees them, rendered from the evidence
 * ledger and stated preferences. There is no other description of the
 * candidate anywhere in the codebase: correct a claim in the ledger and the
 * next prompt says the corrected thing.
 *
 * Claims are listed with their ids so the model can cite them.
 */
export function renderCandidateBrief(e: Evidence, prefs: Preferences, strategy: Strategy): string {
  // Deliberately no "N years of experience" line computed from today's date:
  // the brief is part of every assessment's input address, and a value that
  // moves with the calendar would invalidate (and re-buy) every assessment
  // each month. Role dates below carry the same information, stably.
  const L: string[] = [];
  L.push(`Name: ${e.basics.name}`);
  if (e.basics.location) L.push(`Location: ${e.basics.location}`);
  for (const h of e.basics.headlines) L.push(`Headline (${h.id}): ${h.text}`);
  for (const s of e.basics.summaries) L.push(`Summary (${s.id}): ${s.text}`);
  L.push("");
  L.push("## Skills the candidate claims");
  const byLevel = new Map<string, string[]>();
  for (const s of e.skills) byLevel.set(s.level, [...(byLevel.get(s.level) ?? []), s.name]);
  for (const level of ["expert", "strong", "working", "familiar"]) {
    const names = byLevel.get(level);
    if (names?.length) L.push(`- ${level}: ${names.join(", ")}`);
  }
  L.push("");
  L.push("## Experience (verified claims only; cite by id)");
  const claims = verifiedClaims(e);
  for (const r of e.experience) {
    L.push(`### ${r.id}: ${r.title}, ${r.company} (${r.start} to ${r.end ?? "present"})${r.context ? ` - ${r.context}` : ""}`);
    for (const c of claims.filter((x) => x.ownerId === r.id)) L.push(`- [${c.claim.id}] ${c.claim.text}`);
  }
  if (e.projects.length) {
    L.push("");
    L.push("## Projects");
    for (const p of e.projects) {
      L.push(`### ${p.id}: ${p.name}${p.context ? ` - ${p.context}` : ""}`);
      for (const c of claims.filter((x) => x.ownerId === p.id)) L.push(`- [${c.claim.id}] ${c.claim.text}`);
    }
  }
  if (e.education.length) {
    L.push("");
    L.push("## Education");
    for (const ed of e.education) L.push(`- ${[ed.credential, ed.school, ed.year].filter(Boolean).join(", ")}`);
  }
  if (e.certifications.length) {
    L.push("");
    L.push("## Certifications");
    for (const c of e.certifications) L.push(`- ${[c.name, c.year].filter(Boolean).join(", ")}`);
  }

  const c = prefs.compensation;
  L.push("");
  L.push("## What the candidate is looking for");
  L.push(`Preferred employment: ${c.prefer_employment_type.replace("_", " ")}`);
  L.push(`Base compensation target: ${c.currency} ${c.target_min.toLocaleString("en-US")}-${c.target_max.toLocaleString("en-US")}`);
  L.push(`Acceptable from about ${c.acceptable_min.toLocaleString("en-US")}; stretch band ${c.stretch_min.toLocaleString("en-US")}-${c.stretch_max.toLocaleString("en-US")}`);
  L.push(`Contract fallback: ${c.contract_min_hourly}-${c.contract_max_hourly}/hour`);
  const loc = prefs.location;
  L.push(
    `Remote: ${loc.remote_ok ? "yes" : "no"}. Hybrid only in: ${loc.hybrid_metros.join(", ") || "none"}. ` +
      `Onsite only in: ${loc.onsite_ok_metros.join(", ") || "none"}. Relocation: ${loc.relocation_ok ? "yes" : "no"}.`,
  );
  for (const n of prefs.notes) L.push(`- ${n}`);
  L.push("");
  L.push("Target lanes:");
  for (const [key, lane] of Object.entries(strategy.lanes)) {
    L.push(`- ${key}: ${lane.label} (search priority ${Math.round(lane.weight * 100)}%)`);
  }
  return L.join("\n");
}

/** Content address of the brief's inputs, for derivation keys. */
export function briefInputs(e: Evidence, prefs: Preferences, strategy: Strategy) {
  return hashInput({ e, prefs, lanes: strategy.lanes });
}
