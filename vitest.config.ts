import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    // A developer shell that exports these must never make `npm test` spend:
    // JR_ALLOW_MODEL=1 would let the claude-cli provider run, and a key would
    // let the api one. Empty, not unset, so a project .env cannot fill them in.
    env: { JR_ALLOW_MODEL: "", ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "" },
  },
});
