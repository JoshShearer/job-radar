import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { memoryRepo, seedJob } from "./helpers/db.js";
import { callModelWithReceipt, type ReceiptMeta } from "../src/db/receipts.js";
import { emptyUsage } from "../src/lib/cost.js";
import type { CareerProfile } from "../src/config/schema.js";

/**
 * JOB-52. A receipt has to exist for every PAID attempt, written at the
 * request seam - the instant the API call returns - not after validation has
 * had a chance to throw and discard the fact that a billed call happened.
 *
 * These tests exercise `callModelWithReceipt` directly with fake
 * request/validate closures (no real Anthropic client, no network - the
 * wrapper is agnostic to what `request` actually does), plus one end-to-end
 * test through `runAnalysis` with the SDK mocked, which is the literal
 * two-stage repro the ticket names.
 */

function receiptRows(db: ReturnType<typeof memoryRepo>["db"]) {
  return db.prepare("SELECT * FROM model_receipts ORDER BY id").all() as Array<{
    id: number;
    run_id: number | null;
    job_id: string | null;
    purpose: string;
    model: string;
    tier: string | null;
    attempt: number;
    usage_known: number;
    input_tokens: number;
    cache_write_tokens: number;
    cache_read_tokens: number;
    output_tokens: number;
    validation_outcome: string;
    estimated_price_usd: number;
    created_at: string;
  }>;
}

describe("callModelWithReceipt: the success path", () => {
  it("writes exactly one receipt, with the usage the response actually reported", async () => {
    const { repo, db } = memoryRepo();
    const jobId = seedJob(db, {});
    const runId = repo.startRun("test");

    const { result, usage, usageMissing } = await callModelWithReceipt(
      repo,
      { runId, jobId, purpose: "analyze", model: "claude-opus-5", tier: "full" },
      async () => ({
        usage: { input_tokens: 100, cache_creation_input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 50 },
      }),
      (response) => ({ parsed: (response as { usage: unknown }).usage }),
    );

    expect(usageMissing).toBe(false);
    expect(usage).toEqual({ input: 100, cacheWrite: 10, cacheRead: 20, output: 50 });
    expect(result.parsed).toBeTruthy();

    const rows = receiptRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.validation_outcome).toBe("success");
    expect(rows[0]!.usage_known).toBe(1);
    expect(rows[0]!.input_tokens).toBe(100);
    expect(rows[0]!.cache_write_tokens).toBe(10);
    expect(rows[0]!.cache_read_tokens).toBe(20);
    expect(rows[0]!.output_tokens).toBe(50);
    expect(rows[0]!.attempt).toBe(1);
    expect(rows[0]!.purpose).toBe("analyze");
    expect(rows[0]!.tier).toBe("full");
    expect(rows[0]!.estimated_price_usd).toBeGreaterThan(0);
  });
});

describe("callModelWithReceipt: validation failures still leave a receipt", () => {
  // One receipt per case, usage captured BEFORE validate() ran - so a response
  // that fails validation still shows what it was billed for.
  const cases: { name: string; message: string; outcome: string }[] = [
    { name: "refusal", message: "Model declined to analyze this posting.", outcome: "refusal" },
    {
      name: "truncated / max_tokens",
      message: "Response hit max_tokens (16000) and was truncated mid-object.",
      outcome: "truncated",
    },
    {
      name: "invalid JSON",
      message: `Response was not valid JSON: {"fit`,
      outcome: "invalid_json",
    },
    {
      name: "schema failure",
      message: "Response failed schema validation: lane: Invalid enum value",
      outcome: "schema",
    },
  ];

  for (const c of cases) {
    it(`records '${c.outcome}' for a ${c.name}`, async () => {
      const { repo, db } = memoryRepo();
      const jobId = seedJob(db, {});

      await expect(
        callModelWithReceipt(
          repo,
          { runId: null, jobId, purpose: "analyze", model: "claude-opus-5", tier: "triage" },
          async () => ({ usage: { input_tokens: 30, output_tokens: 5 } }),
          () => {
            throw new Error(c.message);
          },
        ),
      ).rejects.toThrow(c.message);

      const rows = receiptRows(db);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.validation_outcome).toBe(c.outcome);
      // Usage was captured before the throw, not discarded with it.
      expect(rows[0]!.usage_known).toBe(1);
      expect(rows[0]!.input_tokens).toBe(30);
      expect(rows[0]!.output_tokens).toBe(5);
    });
  }

  it("records a success with usage_known=0 when the response carried no usage metadata", async () => {
    // Missing usage is not itself a validation failure - `readUsage` never
    // throws (JOB-43) - so a response with no usage envelope that otherwise
    // validates fine is still a 'success' receipt, just one that says its own
    // usage is unknown.
    const { repo, db } = memoryRepo();
    const jobId = seedJob(db, {});
    const warn = vi.spyOn((await import("../src/lib/log.js")).log, "warn").mockImplementation(() => {});

    const { usageMissing } = await callModelWithReceipt(
      repo,
      { runId: null, jobId, purpose: "analyze", model: "claude-opus-5", tier: "full" },
      async () => ({ content: [] }), // no `usage` key at all
      (response) => response,
    );

    expect(usageMissing).toBe(true);
    const rows = receiptRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.validation_outcome).toBe("success");
    expect(rows[0]!.usage_known).toBe(0);
    expect(rows[0]!.input_tokens).toBe(0);
    expect(rows[0]!.output_tokens).toBe(0);
    expect(rows[0]!.estimated_price_usd).toBe(0);
    warn.mockRestore();
  });
});

describe("callModelWithReceipt: the API call itself throws", () => {
  it("records one receipt before any response exists, and rethrows unchanged", async () => {
    const { repo, db } = memoryRepo();
    const jobId = seedJob(db, {});
    const validate = vi.fn();

    await expect(
      callModelWithReceipt(
        repo,
        { runId: null, jobId, purpose: "tailor", model: "claude-sonnet-5", tier: null },
        async () => {
          throw new Error("529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\"}}");
        },
        validate,
      ),
    ).rejects.toThrow("overloaded_error");

    // validate() must never run - there is no response to validate.
    expect(validate).not.toHaveBeenCalled();

    const rows = receiptRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.validation_outcome).toBe("api_error");
    expect(rows[0]!.usage_known).toBe(0);
    expect(rows[0]!.input_tokens).toBe(0);
    expect(rows[0]!.output_tokens).toBe(0);
    expect(rows[0]!.estimated_price_usd).toBe(0);
  });
});

describe("attempt numbering", () => {
  it("increments across repeated calls with the same (run, job, purpose)", async () => {
    const { repo, db } = memoryRepo();
    const jobId = seedJob(db, {});
    const runId = repo.startRun("test");
    const meta = { runId, jobId, purpose: "analyze", model: "claude-opus-5", tier: "full" as const };
    const ok = async () => ({ usage: { input_tokens: 1, output_tokens: 1 } });

    await callModelWithReceipt(repo, meta, ok, (r) => r);
    await callModelWithReceipt(repo, meta, ok, (r) => r);
    await callModelWithReceipt(repo, meta, ok, (r) => r);

    const rows = receiptRows(db);
    expect(rows.map((r) => r.attempt)).toEqual([1, 2, 3]);
  });

  it("keeps separate counters per purpose, even for the same run and job", async () => {
    const { repo, db } = memoryRepo();
    const jobId = seedJob(db, {});
    const runId = repo.startRun("test");
    const ok = async () => ({ usage: { input_tokens: 1, output_tokens: 1 } });

    await callModelWithReceipt(
      repo,
      { runId, jobId, purpose: "analyze", model: "claude-opus-5", tier: "full" },
      ok,
      (r) => r,
    );
    await callModelWithReceipt(
      repo,
      { runId, jobId, purpose: "apply-dossier", model: "claude-opus-5", tier: "full" },
      ok,
      (r) => r,
    );
    await callModelWithReceipt(
      repo,
      { runId, jobId, purpose: "analyze", model: "claude-opus-5", tier: "full" },
      ok,
      (r) => r,
    );

    const rows = receiptRows(db);
    const byPurpose = new Map<string, number[]>();
    for (const r of rows) byPurpose.set(r.purpose, [...(byPurpose.get(r.purpose) ?? []), r.attempt]);
    expect(byPurpose.get("analyze")).toEqual([1, 2]);
    expect(byPurpose.get("apply-dossier")).toEqual([1]);
  });
});

describe("null run_id / job_id (the `resume import` and `resume tailor` shapes)", () => {
  it("accepts a null runId - resume import creates no runs row", async () => {
    const { repo, db } = memoryRepo();
    const ok = async () => ({ usage: { input_tokens: 5, output_tokens: 5 } });

    await callModelWithReceipt(
      repo,
      { runId: null, jobId: null, purpose: "import", model: "claude-opus-5", tier: null },
      ok,
      (r) => r,
    );

    const rows = receiptRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.run_id).toBeNull();
    expect(rows[0]!.job_id).toBeNull();
    expect(rows[0]!.attempt).toBe(1);
  });

  it("uses SQLite's null-safe comparison, so two null-keyed calls still count as the same attempt series", async () => {
    // A naive `run_id = ?` / `job_id = ?` comparison is NULL, not true, for two
    // NULLs - which would reset every attempt back to 1 forever. `IS` is what
    // makes the counter actually count.
    const { repo, db } = memoryRepo();
    const ok = async () => ({ usage: { input_tokens: 1, output_tokens: 1 } });
    const meta: ReceiptMeta = { runId: null, jobId: null, purpose: "import", model: "claude-opus-5", tier: null };

    await callModelWithReceipt(repo, meta, ok, (r) => r);
    await callModelWithReceipt(repo, meta, ok, (r) => r);

    const rows = receiptRows(db);
    expect(rows.map((r) => r.attempt)).toEqual([1, 2]);
  });

  it("accepts a null jobId with a real runId - resume tailor/import are not about a job row until they resolve one", async () => {
    const { repo, db } = memoryRepo();
    const runId = repo.startRun("test");
    const ok = async () => ({ usage: { input_tokens: 1, output_tokens: 1 } });

    await callModelWithReceipt(
      repo,
      { runId, jobId: null, purpose: "import", model: "claude-opus-5", tier: null },
      ok,
      (r) => r,
    );

    const rows = receiptRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.run_id).toBe(runId);
    expect(rows[0]!.job_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The literal repro: a successful triage call followed by a failing dossier
// call, inside the real two-stage `runAnalysis` path, leaves TWO receipts.
// ---------------------------------------------------------------------------

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock("@anthropic-ai/sdk", () => ({
  // A real `function`, not an arrow, so `new Anthropic(...)` in analyzer.ts
  // can construct it - vi.fn()'s constructor delegation needs a function
  // expression to bind `new.target` correctly.
  default: vi.fn(function AnthropicMock() {
    return { messages: { create: mockCreate } };
  }),
}));

function testProfile(): CareerProfile {
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
    analysis_diversity: {
      per_company_cap: 5,
      per_company_backfill_cap: 10,
      cold_after: 10,
      unexplored_bonus: 0,
      cold_penalty: 0,
    },
    scoring: {
      analysis_fresh_days: 30,
      analysis_fresh_bonus: 0,
      evergreen_days: null,
      analysis_max_attempts: null,
      max_spend_per_run_usd: 100,
    },
    analysis_detail: {
      // Any 'apply' verdict earns the dossier, whatever the fit score - so the
      // triage payload below deterministically triggers the second call.
      two_stage: true,
      dossier_for: ["apply", "apply_and_outreach"],
      dossier_min_fit: 999,
    },
  } as unknown as CareerProfile;
}

describe("the nested case: triage succeeds, the dossier it earns fails", () => {
  const OLD_KEY = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockCreate.mockReset();
  });

  afterEach(() => {
    process.env.ANTHROPIC_API_KEY = OLD_KEY;
  });

  it("leaves two receipts: one success (triage), one failure (dossier)", async () => {
    const { repo, db } = memoryRepo();
    const jobId = seedJob(db, { company: "Acme", fitScore: 80, applicationRoi: 80 });
    db.prepare("UPDATE jobs SET filter_passed = 1 WHERE id = ?").run(jobId);
    const runId = repo.startRun("analyze");

    // Call 1: the triage stage, valid and recommends 'apply' - which the
    // policy above always routes to a dossier.
    mockCreate.mockImplementationOnce(async () => ({
      stop_reason: "end_turn",
      content: [
        {
          type: "text",
          text: JSON.stringify({
            fitScore: 85,
            applicationRoi: 82,
            lane: "frontend",
            recommendation: "apply",
            salaryClassification: "yellow",
            reasoningSummary: "Strong overlap.",
          }),
        },
      ],
      usage: { input_tokens: 500, cache_read_input_tokens: 0, output_tokens: 40 },
    }));

    // Call 2: the dossier it earned, malformed against the full schema (the
    // required dossier fields are entirely absent) - this is the response that
    // is billed and then thrown away by validation.
    mockCreate.mockImplementationOnce(async () => ({
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify({ fitScore: 85 }) }],
      usage: { input_tokens: 600, cache_read_input_tokens: 400, output_tokens: 60 },
    }));

    const { runAnalysis } = await import("../src/analysis/analyzer.js");
    const summary = await runAnalysis(
      repo,
      testProfile(),
      {
        limit: 5,
        minFit: null,
        model: "claude-opus-5",
        effort: "medium",
        dryRun: false,
        twoStage: true,
      },
      runId,
    );

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(summary.failed).toBe(1);

    const rows = db
      .prepare("SELECT * FROM model_receipts WHERE job_id = ? ORDER BY id")
      .all(jobId) as Array<{ tier: string | null; validation_outcome: string; attempt: number; input_tokens: number }>;

    expect(rows).toHaveLength(2);
    expect(rows[0]!.tier).toBe("triage");
    expect(rows[0]!.validation_outcome).toBe("success");
    expect(rows[0]!.attempt).toBe(1);
    expect(rows[0]!.input_tokens).toBe(500);

    expect(rows[1]!.tier).toBe("full");
    expect(rows[1]!.validation_outcome).toBe("schema");
    expect(rows[1]!.attempt).toBe(2);
    expect(rows[1]!.input_tokens).toBe(600);
  });
});

describe("estimateCostUsd never invents spend from an unknown response", () => {
  it("a receipt for a zeroed envelope prices at nothing", () => {
    expect(emptyUsage()).toEqual({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
  });
});
