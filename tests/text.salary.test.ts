import { describe, it, expect } from "vitest";
import {
  parseSalary,
  mergeSalary,
  assessCompensation,
  annualize,
  formatSalary,
  NO_SALARY,
} from "../src/domain/text/salary.js";

const TARGETS = {
  targetMin: 160_000,
  targetMax: 180_000,
  acceptableMin: 145_000,
  rejectBelowMax: 135_000,
  stretchMin: 190_000,
};

describe("parseSalary - annual ranges", () => {
  it("parses a comma-formatted dollar range", () => {
    const s = parseSalary("The salary range for this role is $160,000 - $200,000 per year.");
    expect(s.confidence).toBe("published");
    expect(s.period).toBe("year");
    expect(s.min).toBe(160_000);
    expect(s.max).toBe(200_000);
  });

  it("parses k-suffixed ranges", () => {
    const s = parseSalary("Base salary: $150k–$185k annually, plus equity.");
    expect(s.min).toBe(150_000);
    expect(s.max).toBe(185_000);
    expect(s.period).toBe("year");
  });

  it("parses a single annual figure with no range", () => {
    const s = parseSalary("Compensation is $175,000 per year.");
    expect(s.min).toBe(175_000);
    expect(s.max).toBeNull();
  });

  it("handles numbers without a currency symbol", () => {
    const s = parseSalary("Annual salary range: 140,000 to 190,000 USD");
    expect(s.period).toBe("year");
    expect(s.min).toBe(140_000);
    expect(s.max).toBe(190_000);
  });
});

describe("parseSalary - hourly", () => {
  it("parses an hourly range", () => {
    const s = parseSalary("This contract pays $85 - $110 per hour.");
    expect(s.period).toBe("hour");
    expect(s.min).toBe(85);
    expect(s.max).toBe(110);
  });

  it("parses a slash-notation hourly rate", () => {
    const s = parseSalary("Rate: $95/hr depending on experience.");
    expect(s.period).toBe("hour");
    expect(s.min).toBe(95);
  });
});

describe("parseSalary - rejects non-compensation numbers", () => {
  it("ignores 401(k) matching", () => {
    const s = parseSalary("We offer a 401(k) with company match up to $5,000.");
    expect(s.confidence).toBe("none");
  });

  it("ignores company revenue and funding figures", () => {
    const s = parseSalary("We process $50,000,000 in payments and raised $200,000 in seed funding.");
    expect(s.confidence).toBe("none");
  });

  it("ignores stipends", () => {
    const s = parseSalary("Enjoy a $500 annual wellness stipend and a $1,000 home office budget.");
    expect(s.confidence).toBe("none");
  });

  it("ignores customer counts", () => {
    const s = parseSalary("We serve 250,000 customers across 40 countries.");
    expect(s.confidence).toBe("none");
  });

  it("returns none for empty input", () => {
    expect(parseSalary("").confidence).toBe("none");
    expect(parseSalary(null).confidence).toBe("none");
  });

  it("rejects implausibly low annual figures", () => {
    const s = parseSalary("Annual salary of $12,000.");
    expect(s.confidence).toBe("none");
  });
});

describe("parseSalary - mixed content", () => {
  it("prefers the annual band when both annual and hourly appear", () => {
    const s = parseSalary(
      "The base salary range is $170,000 - $210,000 per year. Contractors are paid $90 per hour.",
    );
    expect(s.period).toBe("year");
    expect(s.min).toBe(170_000);
    expect(s.max).toBe(210_000);
  });

  it("picks compensation out of a long benefits paragraph", () => {
    const text = `
      We offer excellent benefits including a 401(k) with up to $6,000 match,
      a $1,200 learning budget, and unlimited PTO. The salary range for this
      position is $165,000 to $195,000 depending on experience. We have over
      3,000 employees.
    `;
    const s = parseSalary(text);
    expect(s.min).toBe(165_000);
    expect(s.max).toBe(195_000);
  });
});

describe("annualize", () => {
  it("converts hourly to annual at 2080 hours", () => {
    expect(annualize(100, "hour")).toBe(208_000);
  });
  it("passes annual through unchanged", () => {
    expect(annualize(175_000, "year")).toBe(175_000);
  });
  it("converts monthly", () => {
    expect(annualize(15_000, "month")).toBe(180_000);
  });
});

describe("mergeSalary", () => {
  it("prefers structured data over parsed text", () => {
    const parsed = parseSalary("salary range $100,000 - $120,000 per year");
    const merged = mergeSalary({ min: 180_000, max: 220_000, period: "year", currency: "USD" }, parsed);
    expect(merged.min).toBe(180_000);
    expect(merged.max).toBe(220_000);
  });

  it("falls back to parsed text when structured data is implausible", () => {
    const parsed = parseSalary("salary range $160,000 - $190,000 per year");
    // 0.5 is an equity percentage that some boards put in a salary field.
    const merged = mergeSalary({ min: 0.5, max: 1.5, period: "year", currency: "USD" }, parsed);
    expect(merged.min).toBe(160_000);
  });

  it("falls back to parsed text when structured data is absent", () => {
    const parsed = parseSalary("salary range $160,000 - $190,000 per year");
    const merged = mergeSalary({ min: null, max: null }, parsed);
    expect(merged.min).toBe(160_000);
  });
});

describe("assessCompensation", () => {
  it("marks a range reaching the target GREEN", () => {
    const r = assessCompensation(parseSalary("Salary: $160,000 - $185,000 per year"), TARGETS);
    expect(r.band).toBe("GREEN");
  });

  it("marks a stretch range GREEN", () => {
    const r = assessCompensation(parseSalary("Salary: $200,000 - $240,000 per year"), TARGETS);
    expect(r.band).toBe("GREEN");
  });

  it("marks a range between acceptable and target YELLOW", () => {
    const r = assessCompensation(parseSalary("Salary: $140,000 - $150,000 per year"), TARGETS);
    expect(r.band).toBe("YELLOW");
  });

  it("marks a range below the hard floor RED", () => {
    const r = assessCompensation(parseSalary("Salary: $95,000 - $115,000 per year"), TARGETS);
    expect(r.band).toBe("RED");
  });

  it("returns UNKNOWN rather than rejecting when nothing is published", () => {
    const r = assessCompensation(NO_SALARY, TARGETS);
    expect(r.band).toBe("UNKNOWN");
    expect(r.reason).toMatch(/ask for their range/i);
  });

  it("annualizes an hourly contract rate before comparing", () => {
    // $95/hr * 2080 = $197,600, which clears the stretch floor.
    const r = assessCompensation(parseSalary("Contract rate: $95 per hour"), TARGETS);
    expect(r.annualMax ?? r.annualMin).toBe(197_600);
    expect(r.band).toBe("GREEN");
  });
});

describe("formatSalary", () => {
  it("formats an annual range", () => {
    expect(formatSalary(parseSalary("salary $160,000 - $180,000 per year"))).toBe("$160k-$180k");
  });
  it("formats an hourly range", () => {
    expect(formatSalary(parseSalary("$85 - $110 per hour"))).toBe("$85-$110/hr");
  });
  it("reports missing data plainly", () => {
    expect(formatSalary(NO_SALARY)).toBe("not published");
  });
});
