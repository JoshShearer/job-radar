/** Plain records read from a previous Job Radar database. */
export interface LegacyJob {
  id: string;
  source: string;
  boardId: string;
  externalId: string;
  ats: string | null;
  sourceUrl: string;
  applicationUrl: string | null;
  company: string;
  title: string;
  location: string;
  remoteStatus: string;
  employmentType: string;
  datePosted: string | null;
  firstSeen: string;
  lastSeen: string;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string;
  salaryPeriod: string | null;
  description: string;
  department: string | null;
  team: string | null;
  status: string;
  statusChangedAt: string | null;
  notes: string | null;
  analysisJson: string | null;
  analysisModel: string | null;
  analyzedAt: string | null;
}

export interface LegacyData {
  jobs: LegacyJob[];
  sources: Array<{ jobId: string; source: string; externalId: string; url: string; firstSeen: string; lastSeen: string }>;
  statusEvents: Array<{ jobId: string; from: string | null; to: string; at: string; note: string | null }>;
  emails: Array<{ messageId: string; source: string; from: string; subject: string; receivedAt: string; kinds: string; evidence: string | null; resolution: string; jobId: string | null; appliedStatus: string | null; note: string | null; seenAt: string }>;
  receipts: Array<{ purpose: string; jobId: string | null; model: string; tier: string | null; usageKnown: boolean; input: number; cacheWrite: number; cacheRead: number; output: number; outcome: string; price: number; at: string }>;
  runs: Array<{ command: string; startedAt: string; finishedAt: string | null; ok: boolean; stats: Record<string, unknown> | null }>;
  interviews: Array<Record<string, unknown>>;
}

