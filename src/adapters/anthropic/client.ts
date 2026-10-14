import Anthropic from "@anthropic-ai/sdk";
import type { ModelClient, ModelRequest } from "../../ports/io.js";

/**
 * The raw paid API. Owns nothing but the request shape: budgets, receipts,
 * caching and validation live in the gateway (app/gateway.ts), which is the
 * only caller.
 *
 * The system prompt is marked for prompt caching: it is the large stable half
 * of every request in a pass.
 */
export class AnthropicClient implements ModelClient {
  private readonly client: Anthropic;
  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  static fromEnv(): AnthropicClient | null {
    const key = process.env.ANTHROPIC_API_KEY;
    return key ? new AnthropicClient(key) : null;
  }

  async create(req: ModelRequest): Promise<unknown> {
    return this.client.messages
      .stream({
        model: req.model,
        max_tokens: req.maxOutputTokens,
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        output_config: {
          ...(supportsEffort(req.model) ? { effort: req.effort as "low" | "medium" | "high" | "xhigh" | "max" } : {}),
          format: { type: "json_schema", schema: req.jsonSchema },
        },
        messages: [{ role: "user", content: req.user }],
      })
      .finalMessage();
  }
}

/** Haiku-class models reject the effort parameter. */
export function supportsEffort(model: string): boolean {
  return !/^claude-haiku/.test(model);
}
