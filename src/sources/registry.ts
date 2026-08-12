import type { JobSource } from "./types.js";
import type { SourcesConfig } from "../config/schema.js";
import { GreenhouseSource } from "./greenhouse.js";
import { LeverSource } from "./lever.js";
import { AshbySource } from "./ashby.js";
import { RemoteOkSource } from "./remoteok.js";

/**
 * Build the active source list from config.
 *
 * Adding a source means: write an adapter implementing JobSource, add a config
 * block in config/sources.yaml + its schema entry, and register it here. No
 * other file needs to change - normalization, dedupe, filtering, and scoring
 * all operate on the shared SourceJob shape.
 */
export function buildSources(config: SourcesConfig): JobSource[] {
  const sources: JobSource[] = [];
  const s = config.sources;

  if (s.greenhouse.enabled && s.greenhouse.boards.length) {
    sources.push(new GreenhouseSource(s.greenhouse.boards));
  }
  if (s.lever.enabled && s.lever.boards.length) {
    sources.push(new LeverSource(s.lever.boards));
  }
  if (s.ashby.enabled && s.ashby.boards.length) {
    sources.push(new AshbySource(s.ashby.boards));
  }
  if (s.remoteok.enabled) {
    sources.push(new RemoteOkSource());
  }

  return sources;
}

/** Board endpoints, for `job-radar sources` to health-check. */
export function listBoardEndpoints(config: SourcesConfig): { label: string; url: string }[] {
  const out: { label: string; url: string }[] = [];
  const s = config.sources;

  if (s.greenhouse.enabled) {
    for (const b of s.greenhouse.boards) {
      out.push({
        label: `greenhouse:${b.token}`,
        url: `https://boards-api.greenhouse.io/v1/boards/${b.token}/jobs?content=false`,
      });
    }
  }
  if (s.lever.enabled) {
    for (const b of s.lever.boards) {
      out.push({ label: `lever:${b.token}`, url: `https://api.lever.co/v0/postings/${b.token}?mode=json` });
    }
  }
  if (s.ashby.enabled) {
    for (const b of s.ashby.boards) {
      out.push({
        label: `ashby:${b.token}`,
        url: `https://api.ashbyhq.com/posting-api/job-board/${b.token}`,
      });
    }
  }
  if (s.remoteok.enabled) {
    out.push({ label: "remoteok", url: "https://remoteok.com/api" });
  }

  return out;
}
