# Resumes

Everything in this directory except this file is **gitignored**. Resumes contain
personal contact information and should not be committed.

## Layout

```
resumes/
├── README.md              (this file, committed)
├── base/                  your source resumes — never generated, never edited by tooling
│   ├── full-stack.md
│   ├── growth-seo.md
│   ├── ai-product.md
│   └── proptech-3d.md
└── generated/             per-job tailored variants (Phase 2)
```

## The four positioning variants

Keep the source of truth here, one file per lane. The tailoring stage selects a
base variant per job and proposes strategic edits against it — it does not
rewrite from scratch, and it must never modify a file under `base/`.

1. **Senior Full-Stack** — TypeScript/React/Next.js/Node, PostgreSQL, AWS,
   architecture and system ownership.
2. **Technical SEO / Growth Engineering** — 200+ measured experiments,
   programmatic SEO, Search Console/GA4 pipelines, Core Web Vitals, indexation
   diagnostics. Usually the strongest differentiation.
3. **AI-enabled Product Engineer** — LLM APIs, agents, RAG, tool calling,
   evaluation, human-in-the-loop design. Positioned as a senior engineer who
   uses AI systems effectively while owning architecture and production quality
   — not as an ML researcher.
4. **Proptech / 3D / IoT** — Three.js/WebGL with React, digital twins,
   MQTT/Node-RED, Linux edge devices, real-time systems.

## Rules for any generated variant

- Never fabricate experience, employers, metrics, or technologies.
- Never keyword-stuff. If a term does not describe real work, it does not go in.
- Prefer 3–5 strategic edits over a full rewrite.
- Keep the base files immutable; write variants to `generated/`.
