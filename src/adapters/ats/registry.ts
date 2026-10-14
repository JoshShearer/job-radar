import type { Sources } from "../../domain/config/schema.js";
import type { SourceAdapter } from "../../ports/io.js";
import { AshbyAdapter } from "./ashby.js";
import { GreenhouseAdapter } from "./greenhouse.js";
import { LeverAdapter } from "./lever.js";
import { RemoteOkAdapter } from "./remoteok.js";

export function buildAdapters(config: Sources): SourceAdapter[] {
  const s = config.sources;
  const out: SourceAdapter[] = [];
  if (s.greenhouse.enabled && s.greenhouse.boards.length) out.push(new GreenhouseAdapter(s.greenhouse.boards));
  if (s.lever.enabled && s.lever.boards.length) out.push(new LeverAdapter(s.lever.boards));
  if (s.ashby.enabled && s.ashby.boards.length) out.push(new AshbyAdapter(s.ashby.boards));
  if (s.remoteok.enabled) out.push(new RemoteOkAdapter());
  return out;
}
