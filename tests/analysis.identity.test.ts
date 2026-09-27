import { describe, it, expect } from "vitest";
import { computeAnalysisIdentity, staleAnalysisFields } from "../src/analysis/identity.js";
import type { CareerProfile } from "../src/config/schema.js";
import type { NormalizedJob } from "../src/model/job.js";

/**
 * `computeAnalysisIdentity`/`staleAnalysisFields` are the vocabulary JOB-51
 * introduces: a content address for the INPUTS an analysis was formed
 * against (title/location/employment/compensation/evidence), separate from
 * `materialHash` (the description alone). These pin each hash independently
 * so a bug in one cannot hide behind the others agreeing.
 */

function profile(over: Partial<CareerProfile> = {}): CareerProfile {
  return {
    identity: { name: "Jane Doe", headline: "Senior Engineer", years_experience: 10 },
    compensation: {
      currency: "USD",
      target_min: 160_000,
      target_max: 180_000,
      acceptable_min: 140_000,
      reject_below_max: 120_000,
      stretch_min: 180_000,
      stretch_max: 220_000,
      contract_min_hourly: 90,
      contract_max_hourly: 140,
      prefer_employment_type: "full_time",
    },
    location: {
      home_metro: "Seattle",
      remote_ok: true,
      hybrid_metros: [],
      onsite_ok_metros: [],
      relocation_ok: false,
      work_authorization_blockers: [],
    },
    lanes: { frontend: { label: "Frontend", weight: 1 } },
    ...over,
  } as unknown as CareerProfile;
}

function job(over: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    id: "j1",
    externalId: "ext-1",
    source: "greenhouse",
    board: "greenhouse:acme",
    ats: "greenhouse",
    sourceUrl: "https://example.test/j1",
    applicationUrl: null,
    company: "Acme",
    title: "Senior Engineer",
    location: "Remote",
    remoteStatus: "remote",
    employmentType: "full_time",
    seniority: "senior",
    datePosted: null,
    dateDiscovered: new Date().toISOString(),
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: "USD",
    salaryPeriod: null,
    descriptionClean: "We need a Senior Engineer.",
    descriptionHash: "hash-1",
    materialHash: "material-1",
    department: null,
    team: null,
    companySizeEstimate: null,
    companyStage: null,
    industry: null,
    ...over,
  } as NormalizedJob;
}

describe("computeAnalysisIdentity", () => {
  it("changes titleHash, and only titleHash, when the title moves", () => {
    const p = profile();
    const a = computeAnalysisIdentity(job(), p);
    const b = computeAnalysisIdentity(job({ title: "Director of Engineering" }), p);
    expect(b.titleHash).not.toBe(a.titleHash);
    expect(b.locationHash).toBe(a.locationHash);
    expect(b.employmentHash).toBe(a.employmentHash);
    expect(b.compensationHash).toBe(a.compensationHash);
    expect(b.evidenceHash).toBe(a.evidenceHash);
  });

  it("changes locationHash on a location change, and on a remote-status change alone", () => {
    const p = profile();
    const a = computeAnalysisIdentity(job(), p);
    expect(computeAnalysisIdentity(job({ location: "Seattle, WA" }), p).locationHash).not.toBe(a.locationHash);
    // Same location string, different classification - the analyst was shown
    // "(classified: remote)" vs "(classified: onsite)", a different fact.
    expect(computeAnalysisIdentity(job({ remoteStatus: "onsite" }), p).locationHash).not.toBe(a.locationHash);
  });

  it("changes employmentHash on an employment-type change, nothing else", () => {
    const p = profile();
    const a = computeAnalysisIdentity(job(), p);
    const b = computeAnalysisIdentity(job({ employmentType: "contract" }), p);
    expect(b.employmentHash).not.toBe(a.employmentHash);
    expect(b.titleHash).toBe(a.titleHash);
    expect(b.locationHash).toBe(a.locationHash);
    expect(b.compensationHash).toBe(a.compensationHash);
  });

  it("changes compensationHash when salary min, max, currency, or period moves", () => {
    const p = profile();
    const a = computeAnalysisIdentity(job(), p);
    expect(computeAnalysisIdentity(job({ salaryMin: 150_000 }), p).compensationHash).not.toBe(a.compensationHash);
    expect(
      computeAnalysisIdentity(job({ salaryMin: 150_000, salaryMax: 180_000 }), p).compensationHash,
    ).not.toBe(computeAnalysisIdentity(job({ salaryMin: 150_000 }), p).compensationHash);
    expect(computeAnalysisIdentity(job({ salaryCurrency: "GBP" }), p).compensationHash).not.toBe(a.compensationHash);
    expect(computeAnalysisIdentity(job({ salaryPeriod: "year" }), p).compensationHash).not.toBe(a.compensationHash);
  });

  it("does not fold salary min and max together into an ambiguous string", () => {
    // Without a separator, salaryMin=1 / salaryMax=23 and salaryMin=12 /
    // salaryMax=3 could hash the same "123". The pipe delimiter prevents that.
    const p = profile();
    const x = computeAnalysisIdentity(job({ salaryMin: 1, salaryMax: 23 }), p);
    const y = computeAnalysisIdentity(job({ salaryMin: 12, salaryMax: 3 }), p);
    expect(x.compensationHash).not.toBe(y.compensationHash);
  });

  it("changes evidenceHash when the profile's system prompt moves, independent of any job field", () => {
    const a = computeAnalysisIdentity(job(), profile());
    const b = computeAnalysisIdentity(job(), profile({ identity: { name: "John Smith", headline: "", years_experience: 5 } }));
    expect(b.evidenceHash).not.toBe(a.evidenceHash);
    expect(b.titleHash).toBe(a.titleHash);
    expect(b.locationHash).toBe(a.locationHash);
    expect(b.employmentHash).toBe(a.employmentHash);
    expect(b.compensationHash).toBe(a.compensationHash);
  });

  it("is a pure function of its inputs - same job and profile, same identity", () => {
    const p = profile();
    const j = job();
    expect(computeAnalysisIdentity(j, p)).toEqual(computeAnalysisIdentity(j, p));
  });
});

describe("staleAnalysisFields", () => {
  const p = profile();
  const current = computeAnalysisIdentity(job(), p);

  it("reports nothing stale when every stored hash agrees", () => {
    expect(staleAnalysisFields(current, current)).toEqual([]);
  });

  it("names exactly the field that moved", () => {
    const movedTitle = computeAnalysisIdentity(job({ title: "Director of Engineering" }), p);
    expect(staleAnalysisFields(current, movedTitle)).toEqual(["title"]);

    const movedLocation = computeAnalysisIdentity(job({ location: "Onsite" }), p);
    expect(staleAnalysisFields(current, movedLocation)).toEqual(["location"]);

    const movedEmployment = computeAnalysisIdentity(job({ employmentType: "contract" }), p);
    expect(staleAnalysisFields(current, movedEmployment)).toEqual(["employment"]);

    const movedComp = computeAnalysisIdentity(job({ salaryMin: 200_000 }), p);
    expect(staleAnalysisFields(current, movedComp)).toEqual(["compensation"]);

    const movedEvidence = computeAnalysisIdentity(job(), profile({ identity: { name: "New Name", headline: "", years_experience: 1 } }));
    expect(staleAnalysisFields(current, movedEvidence)).toEqual(["evidence"]);
  });

  it("names every field that moved when more than one does", () => {
    const moved = computeAnalysisIdentity(job({ title: "Director", employmentType: "contract" }), p);
    expect(staleAnalysisFields(current, moved).sort()).toEqual(["employment", "title"]);
  });

  it("treats a null stored value as stale - unverifiable, not fresh", () => {
    // The legacy-row case: JOB-51's migration backfills nothing, so a
    // pre-existing analyzed row has every snapshot hash NULL. That must read
    // as "cannot confirm this still matches", not as "matches by default".
    expect(
      staleAnalysisFields(
        { titleHash: null, locationHash: null, employmentHash: null, compensationHash: null, evidenceHash: null },
        current,
      ),
    ).toEqual(["title", "location", "employment", "compensation", "evidence"]);
  });

  it("treats a single null field as stale even when every other field agrees", () => {
    const partial = { ...current, compensationHash: null };
    expect(staleAnalysisFields(partial, current)).toEqual(["compensation"]);
  });
});
