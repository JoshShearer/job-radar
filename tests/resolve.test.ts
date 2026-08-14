import { describe, it, expect } from "vitest";
import { resolveJob } from "../src/db/resolve.js";
import { memoryRepo, seedJob } from "./helpers/db.js";

describe("resolveJob", () => {
  it("resolves an exact id and a unique id prefix", () => {
    const { repo, db } = memoryRepo();
    const id = seedJob(db, { id: "abc123def456" });

    expect(resolveJob(repo, "abc123def456").job?.id).toBe(id);
    expect(resolveJob(repo, "abc123").job?.id).toBe(id);
  });

  it("refuses a company name unless the caller opts in", () => {
    const { repo, db } = memoryRepo();
    seedJob(db, { company: "Acme", companyNormalized: "acme", status: "APPLIED" });

    const r = resolveJob(repo, "acme");
    expect(r.job).toBeNull();
    // `apply` and `autofill` take this branch: a wrong company there spends a
    // paid model call or types personal data into another employer's form.
    expect(r.job === null && r.message).toContain("No job matches");
  });

  it("resolves a company name to the one role in flight there", () => {
    const { repo, db } = memoryRepo();
    seedJob(db, { id: "new1", company: "Acme", companyNormalized: "acme", status: "NEW" });
    seedJob(db, { id: "new2", company: "Acme", companyNormalized: "acme", status: "NEW" });
    const live = seedJob(db, { id: "live", company: "Acme", companyNormalized: "acme", status: "APPLIED" });

    // Three postings at one employer, one application. A human saying "acme"
    // means the application; only a naive matcher finds this ambiguous.
    expect(resolveJob(repo, "acme", { byCompany: true }).job?.id).toBe(live);
  });

  it("refuses when several roles at one employer are in flight", () => {
    const { repo, db } = memoryRepo();
    seedJob(db, { id: "a", company: "Acme", companyNormalized: "acme", status: "APPLIED" });
    seedJob(db, { id: "b", company: "Acme", companyNormalized: "acme", status: "SCREEN" });

    const r = resolveJob(repo, "acme", { byCompany: true });
    expect(r.job).toBeNull();
    const message = r.job === null ? r.message : "";
    expect(message).toContain("2 roles in flight");
    // The candidates have to carry ids, or the refusal is a dead end.
    expect(message).toContain("a");
    expect(message).toContain("b");
  });

  it("resolves a single posting even when nothing is in flight", () => {
    const { repo, db } = memoryRepo();
    const only = seedJob(db, { company: "Acme", companyNormalized: "acme", status: "NEW" });
    expect(resolveJob(repo, "acme", { byCompany: true }).job?.id).toBe(only);
  });

  it("refuses several postings at an employer with nothing in flight", () => {
    const { repo, db } = memoryRepo();
    seedJob(db, { company: "Acme", companyNormalized: "acme", status: "NEW" });
    seedJob(db, { company: "Acme", companyNormalized: "acme", status: "NEW" });

    const r = resolveJob(repo, "acme", { byCompany: true });
    expect(r.job).toBeNull();
    expect(r.job === null && r.message).toContain("2 jobs");
  });

  it("does not let a company name shadow an id prefix", () => {
    const { repo, db } = memoryRepo();
    const byId = seedJob(db, { id: "acme999", company: "Zzz", companyNormalized: "zzz", status: "NEW" });
    seedJob(db, { company: "Acme", companyNormalized: "acme", status: "APPLIED" });

    // The id is checked first and matches exactly, so it wins.
    expect(resolveJob(repo, "acme999", { byCompany: true }).job?.id).toBe(byId);
  });

  it("says so when nothing matches at all", () => {
    const { repo } = memoryRepo();
    const r = resolveJob(repo, "nothing", { byCompany: true });
    expect(r.job).toBeNull();
    expect(r.job === null && r.message).toContain("inflight");
  });
});
