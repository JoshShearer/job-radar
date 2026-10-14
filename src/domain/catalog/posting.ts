import type { Period } from "../text/salary.js";
import type { RemoteStatus } from "../text/location.js";
import type { EmploymentType, SeniorityLevel } from "../text/seniority.js";

/**
 * What a source adapter emits. Adapters are dumb: they map a provider payload
 * onto these fields and classify nothing. This is the FACT that gets stored;
 * everything judgemental is derived from it.
 */
export interface RawPosting {
  provider: string;
  /** Employer board identity: `greenhouse:acme`, or the bare provider for a single feed. */
  boardId: string;
  externalId: string;
  sourceUrl: string;
  applicationUrl: string | null;
  company: string;
  title: string;
  locationRaw: string;
  workplaceType?: string | null;
  isRemote?: boolean | null;
  employmentTypeRaw?: string | null;
  datePosted: string | null;
  descriptionHtml: string;
  descriptionPlain?: string | null;
  department?: string | null;
  team?: string | null;
  salary?: { min?: number | null; max?: number | null; currency?: string; period?: Period | null } | null;
}

/** A posting after deterministic normalization. Derived, never stored as truth. */
export interface PostingSnapshot {
  boardId: string;
  provider: string;
  externalId: string;
  sourceUrl: string;
  applicationUrl: string | null;
  company: string;
  title: string;
  location: string;
  remoteStatus: RemoteStatus;
  employmentType: EmploymentType;
  seniority: SeniorityLevel;
  datePosted: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string;
  salaryPeriod: Period | null;
  description: string;
  /** Byte-level hash of `description`. Exact history. */
  descriptionHash: string;
  /** Token-multiset hash. What "the posting changed materially" means. */
  materialHash: string;
  department: string | null;
  team: string | null;
}

export interface Opportunity {
  id: string;
  snapshot: PostingSnapshot;
  firstSeen: string;
  lastSeen: string;
  aliases: Array<{ boardId: string; externalId: string; url: string }>;
}
