import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toStructuredOutputSchema } from "../src/domain/llm/structured.js";
import { dossierSchema } from "../src/domain/evaluation/assessment.js";

type Node = { description?: string; properties?: Record<string, Node>; items?: Node };

describe("structured output schema", () => {
  it("restates every stripped constraint in the description, so the model is told the limit it is validated against", () => {
    const js = toStructuredOutputSchema(
      z.object({
        tags: z.array(z.string()).max(8).describe("Short tags."),
        score: z.number().int().min(0).max(100),
        code: z.string().min(2).max(4),
      }),
    ) as Node;
    expect(JSON.stringify(js)).not.toMatch(/"maxItems"|"maximum"|"minimum"|"maxLength"/);
    expect(js.properties!.tags!.description).toBe("Short tags. At most 8 items.");
    expect(js.properties!.score!.description).toMatch(/between 0 and 100/);
    expect(js.properties!.code!.description).toMatch(/2 to 4 characters/);
  });

  it("the real assessment schema tells the model its list limits", () => {
    const js = JSON.stringify(toStructuredOutputSchema(dossierSchema(["platform"])));
    expect(js).toMatch(/At most 8 items/);
  });
});
