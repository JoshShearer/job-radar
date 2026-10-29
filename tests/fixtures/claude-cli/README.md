Envelopes from `claude -p --output-format json` (claude 2.1.312, claude.ai subscription).

`success.observed.json` and `truncation.observed.json` follow the probes recorded on the JOB-73
ticket and plan (2026-10-29). Only these figures are recorded observations:

- success: `is_error: false`, `num_turns: 2`, `stop_reason: "tool_use"`, `total_cost_usd: 0.00068`,
  usage input 2 / cache_creation 1156 / cache_read 0 / output 891, a `structured_output` object.
- truncation (exit 1, `CLAUDE_CODE_MAX_OUTPUT_TOKENS=300`): `is_error: true`,
  `terminal_reason: "api_error"`, `num_turns: 4`, `output_tokens: 1200`, `structured_output: null`,
  `result` starting `API Error: Claude's response exceeded the 300 output token maximum`.

Everything else in them is filler in the observed field names: `subtype`, durations, the
truncation envelope's input/cache figures and cost, the tail of its `result` text, ids. The
success `result` / `structured_output` are replaced with a value for the test schema
(`{ "answer": "hi", "score": 5 }`).

`error.synthetic.json` and `refusal.synthetic.json` are SYNTHETIC: no CLI error other than
truncation, and no CLI refusal, was observed.
