import { describe, it, expect } from "vitest";
import { markdownToHtml } from "../src/report/html.js";

describe("markdownToHtml", () => {
  it("produces a self-contained document with no external requests", () => {
    const html = markdownToHtml("# Title\n\nBody.", "Job Radar");
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain("<style>");
    // No CDN, no remote fonts, no scripts - the report must work offline and
    // must not tell anyone what you are looking at.
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\/[^"']*\.(js|css|woff2?)/i);
    expect(html).not.toMatch(/<link[^>]+href=["']https?:/i);
  });

  it("escapes HTML in the source before any transform runs", () => {
    const html = markdownToHtml("# T\n\n<img src=x onerror=alert(1)>", "T");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("escapes a malicious job title without breaking the page", () => {
    const html = markdownToHtml("### 1. <script>alert(1)</script> - Acme", "T");
    expect(html).not.toMatch(/<script>alert/);
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders headings, cards, lists and tables", () => {
    const md = [
      "# JOB RADAR",
      "",
      "## PRIORITY A",
      "",
      "### 1. Senior Engineer - Acme",
      "",
      "| | |",
      "|---|---|",
      "| **Fit** | 88 |",
      "",
      "Strengths:",
      "",
      "- Next.js is the primary stack",
      "",
    ].join("\n");
    const html = markdownToHtml(md, "T");
    expect(html).toContain("<h1>JOB RADAR</h1>");
    expect(html).toContain("<h2>PRIORITY A</h2>");
    expect(html).toContain('<section class="job">');
    expect(html).toContain("</section>");
    expect(html).toContain("<table>");
    expect(html).toContain("<strong>Fit</strong>");
    expect(html).toContain("<li>Next.js is the primary stack</li>");
    // The separator row must not become a table row.
    expect(html).not.toContain("<td>---</td>");
  });

  it("links bare URLs exactly once", () => {
    const html = markdownToHtml("Apply: https://example.com/jobs/1", "T");
    expect(html).toContain('<a href="https://example.com/jobs/1"');
    expect((html.match(/<a href="https:\/\/example\.com\/jobs\/1"/g) ?? []).length).toBe(1);
  });

  it("does not double-wrap an existing markdown link", () => {
    const html = markdownToHtml("See [Remote OK](https://remoteok.com).", "T");
    expect(html).toContain('<a href="https://remoteok.com" rel="noreferrer">Remote OK</a>');
    expect(html).not.toMatch(/<a href="<a/);
  });

  it("colour-codes compensation bands", () => {
    const html = markdownToHtml("Compensation: GREEN", "T");
    expect(html).toContain('<span class="GREEN">GREEN</span>');
  });

  it("keeps code blocks verbatim", () => {
    const html = markdownToHtml("```\nnpm run radar\n```", "T");
    expect(html).toContain("<pre><code>");
    expect(html).toContain("npm run radar");
  });

  it("supports both colour schemes", () => {
    const html = markdownToHtml("# T", "T");
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain("color-scheme: light dark");
  });

  it("closes every job card it opens", () => {
    const md = "### 1. A - X\n\ntext\n\n### 2. B - Y\n\ntext\n";
    const html = markdownToHtml(md, "T");
    const open = (html.match(/<section class="job">/g) ?? []).length;
    const close = (html.match(/<\/section>/g) ?? []).length;
    expect(open).toBe(2);
    expect(close).toBe(2);
  });
});
