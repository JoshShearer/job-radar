import { describe, expect, it } from "vitest";
import { matchesTerm, termPattern } from "../src/domain/text/terms.js";

/**
 * These tests name the bug. Every "must not" below was a real, measured
 * mis-scoring on the live index at the time of writing.
 */
describe("matchesTerm - phantom substring credit", () => {
  it("does not score 'storage' as the AI term 'rag'", () => {
    // 1,023 of 1,590 filter-passing jobs matched "rag" by substring; only 41
    // actually say it. "storage", "leverage" and "average" all contain r-a-g.
    expect(matchesTerm("experience with cloud storage", "rag")).toBe(false);
    expect(matchesTerm("leverage our platform", "rag")).toBe(false);
    expect(matchesTerm("above average latency", "rag")).toBe(false);
    expect(matchesTerm("we use rag pipelines", "rag")).toBe(true);
  });

  it("does not score 'riot' or 'patriot' as 'iot'", () => {
    expect(matchesTerm("riot games", "iot")).toBe(false);
    expect(matchesTerm("patriot software", "iot")).toBe(false);
    expect(matchesTerm("iot sensor fleet", "iot")).toBe(true);
  });

  it("does not penalize 'trust' as the negative signal 'rust'", () => {
    // The worst of the set: 832 substring matches against 59 real ones. Every
    // posting saying "trusted by" was being docked points for Rust.
    expect(matchesTerm("trusted by thousands", "rust")).toBe(false);
    expect(matchesTerm("we build trust", "rust")).toBe(false);
    expect(matchesTerm("rust and go services", "rust")).toBe(true);
  });

  it("does not penalize 'scalable' or 'scaling' as the negative signal 'scala'", () => {
    // 624 substring matches, 43 real. Left-anchoring alone does NOT fix this
    // one - "scalable" starts on the same boundary - which is why the trailing
    // edge is anchored too.
    expect(matchesTerm("scalable distributed systems", "scala")).toBe(false);
    expect(matchesTerm("scaling to millions", "scala")).toBe(false);
    expect(matchesTerm("scala and akka", "scala")).toBe(true);
  });

  it("does not score 'expression' or 'expressed' as 'express'", () => {
    expect(matchesTerm("regular expression parsing", "express")).toBe(false);
    expect(matchesTerm("expressed interest", "express")).toBe(false);
    expect(matchesTerm("node and express", "express")).toBe(true);
  });

  it("does not score 'laws' or 'flaws' as 'aws'", () => {
    expect(matchesTerm("employment laws", "aws")).toBe(false);
    expect(matchesTerm("design flaws", "aws")).toBe(false);
    expect(matchesTerm("aws lambda", "aws")).toBe(true);
  });

  it("does not score 'rapid' or 'capital' as 'api'", () => {
    expect(matchesTerm("rapid iteration", "api")).toBe(false);
    expect(matchesTerm("capital markets", "api")).toBe(false);
  });
});

describe("matchesTerm - inflections still count", () => {
  // Anchoring both edges without this would LOSE signal: measured on the same
  // corpus, plain \b..\b dropped "APIs" (-219 jobs), "engineering" (-418),
  // "agents" (-166) and "large language models" (32 -> 4).
  it("matches the plural", () => {
    expect(matchesTerm("design clean apis", "api")).toBe(true);
    expect(matchesTerm("autonomous agents", "agent")).toBe(true);
    expect(matchesTerm("early stage startups", "startup")).toBe(true);
  });

  it("matches the gerund and -es plural", () => {
    expect(matchesTerm("platform engineering team", "engineer")).toBe(true);
    expect(matchesTerm("a/b testing at scale", "a/b test")).toBe(true);
  });

  it("matches inflections of multi-word terms", () => {
    expect(matchesTerm("serving large language models", "large language model")).toBe(true);
    expect(matchesTerm("hiring solutions engineers", "solutions engineer")).toBe(true);
    expect(matchesTerm("we run vector databases", "vector database")).toBe(true);
  });

  it("matches the agentive -er form, which hard exclusions depend on", () => {
    // Regression: "machine learning research" stopped catching "Machine
    // Learning Researcher", and two ML research postings that had always been
    // filtered out started passing.
    expect(matchesTerm("machine learning researcher, audio", "machine learning research")).toBe(true);
    expect(matchesTerm("senior ml researcher", "ml research")).toBe(true);
    expect(matchesTerm("marketing leader", "marketing lead")).toBe(true);
    expect(matchesTerm("we run a crawler", "crawl")).toBe(true);
  });

  it("does not allow -ed, which would re-admit 'expressed' as 'express'", () => {
    expect(matchesTerm("expressed interest", "express")).toBe(false);
  });

  it("does not treat an unrelated suffix as an inflection", () => {
    // "scalable" is not an inflection of "scala"; "expression" is not one of
    // "express". This is the line that separates this from left-anchoring.
    expect(matchesTerm("scalable", "scala")).toBe(false);
    expect(matchesTerm("expression", "express")).toBe(false);
    expect(matchesTerm("ragged edges", "rag")).toBe(false);
  });
});

describe("matchesTerm - punctuated and multi-word terms keep working", () => {
  it("handles dots, slashes and plus signs literally", () => {
    expect(matchesTerm("built with next.js", "next.js")).toBe(true);
    // The dot must be escaped, not treated as "any character".
    expect(matchesTerm("nextXjs", "next.js")).toBe(false);
    expect(matchesTerm("ci/cd pipelines", "ci/cd")).toBe(true);
    expect(matchesTerm("a/b test framework", "a/b test")).toBe(true);
    expect(matchesTerm("c++ systems work", "c++")).toBe(true);
  });

  it("handles a leading non-word character", () => {
    // ".net" must not require a word boundary before the dot, or it never
    // matches at the start of a phrase.
    expect(matchesTerm(".net developer", ".net")).toBe(true);
    expect(matchesTerm("asp.net shop", ".net")).toBe(true);
  });

  it("keeps digit-led terms from matching inside longer numbers", () => {
    expect(matchesTerm("0 to 1 product work", "0 to 1")).toBe(true);
    expect(matchesTerm("10 to 15 people", "0 to 1")).toBe(false);
    expect(matchesTerm("3d rendering", "3d")).toBe(true);
  });

  it("preserves a term that deliberately carries its own spaces", () => {
    // " go " is a hand-rolled boundary in the config: bare \bgo\b would match
    // the English verb in "go-to-market" and dock points for it. Because the
    // term's edges are spaces, no boundary is added and it behaves as before.
    expect(matchesTerm("we use go and rust", " go ")).toBe(true);
    expect(matchesTerm("go-to-market motion", " go ")).toBe(false);
    expect(matchesTerm("ready to go", " go ")).toBe(false);
  });

  it("is case insensitive", () => {
    expect(matchesTerm("Kubernetes AND Terraform", "kubernetes")).toBe(true);
    expect(matchesTerm("RAG pipeline", "rag")).toBe(true);
  });
});

describe("termPattern", () => {
  it("returns the same compiled instance for a repeated term", () => {
    // Scoring runs every term against every job in the index; recompiling per
    // job would make this the slowest thing in the pipeline.
    expect(termPattern("kubernetes")).toBe(termPattern("kubernetes"));
  });

  it("is not stateful across calls", () => {
    // A cached /g regex would carry lastIndex between jobs and start returning
    // false for text it already matched.
    const text = "rag pipelines and rag evaluation";
    expect(matchesTerm(text, "rag")).toBe(true);
    expect(matchesTerm(text, "rag")).toBe(true);
    expect(matchesTerm(text, "rag")).toBe(true);
  });

  it("handles an empty or whitespace term without matching everything", () => {
    expect(matchesTerm("anything at all", "")).toBe(false);
    expect(matchesTerm("anything at all", "   ")).toBe(false);
  });
});
