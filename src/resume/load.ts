import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { PROJECT_ROOT } from "../config/load.js";
import { ResumeSchema, type Resume } from "./schema.js";

export function resumePath(): string {
  return process.env.JOB_RADAR_RESUME ?? resolve(PROJECT_ROOT, "config", "resume.yaml");
}

export function resumeExists(file = resumePath()): boolean {
  return existsSync(file);
}

export function loadResume(file = resumePath()): Resume {
  if (!existsSync(file)) {
    throw new Error(
      `No master resume at ${file}.\n` +
        `Start one with:  npm run cli -- resume import <your-resume.txt>\n` +
        `or scaffold a blank one with:  npm run cli -- resume init`,
    );
  }
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${file} is not valid YAML: ${(err as Error).message}`);
  }
  const parsed = ResumeSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`${file} failed validation:\n${issues}`);
  }
  return parsed.data;
}

export function saveResume(resume: Resume, file = resumePath()): void {
  const header =
    "# Master resume: the single source of truth for what you have actually done.\n" +
    "#\n" +
    "# Tailored resumes are a SELECTION from this file. Generated output must cite\n" +
    "# the bullet ids it came from, and those citations are checked, so anything\n" +
    "# missing here can never appear in an application.\n" +
    "#\n" +
    "# Two fields carry weight:\n" +
    "#   verified: false  -> the bullet is never selected. Use it for anything you\n" +
    "#                       could not substantiate under questioning.\n" +
    "#   skills: [...]    -> what the bullet is EVIDENCE for. Untagged bullets can\n" +
    "#                       never match a job requirement.\n" +
    "#\n" +
    "# This file is gitignored.\n\n";
  writeFileSync(file, header + stringifyYaml(resume, { lineWidth: 100 }), "utf8");
}
