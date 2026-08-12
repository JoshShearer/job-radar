import { describe, it, expect } from "vitest";
import { htmlToText, decodeEntities, decodeEntitiesDeep, truncateWords } from "../src/lib/html.js";

describe("decodeEntities", () => {
  it("decodes named entities", () => {
    expect(decodeEntities("a &amp; b &lt;c&gt;")).toBe("a & b <c>");
  });
  it("decodes numeric entities", () => {
    expect(decodeEntities("&#65;&#66;")).toBe("AB");
    expect(decodeEntities("&#x41;")).toBe("A");
  });
  it("leaves unknown entities alone", () => {
    expect(decodeEntities("&notarealentity;")).toBe("&notarealentity;");
  });
});

describe("decodeEntitiesDeep", () => {
  it("handles the double-escaping Greenhouse serves", () => {
    expect(decodeEntitiesDeep("&amp;lt;p&amp;gt;")).toBe("<p>");
  });
});

describe("htmlToText", () => {
  it("strips tags", () => {
    expect(htmlToText("<p>Hello <strong>world</strong></p>")).toBe("Hello world");
  });

  it("turns list items into bullets", () => {
    const out = htmlToText("<ul><li>TypeScript</li><li>React</li></ul>");
    expect(out).toContain("- TypeScript");
    expect(out).toContain("- React");
  });

  it("drops script and style content entirely", () => {
    const out = htmlToText("<p>Keep</p><script>var secret = 1;</script><style>.a{}</style>");
    expect(out).toContain("Keep");
    expect(out).not.toContain("secret");
    expect(out).not.toContain(".a{}");
  });

  it("separates paragraphs with a blank line and never more", () => {
    // Paragraphs get a blank line; list items get a single newline. That
    // hierarchy is what makes the text readable to both the keyword scorer
    // and the model. What must never happen is unbounded blank-line runs.
    const out = htmlToText("<p>One</p><p>Two</p><p>Three</p>");
    expect(out).toBe("One\n\nTwo\n\nThree");
    expect(out).not.toMatch(/\n{3,}/);
  });

  it("collapses runaway blank lines from nested empty markup", () => {
    const out = htmlToText("<div><p>One</p><div></div><div></div><p>Two</p></div>");
    expect(out).not.toMatch(/\n{3,}/);
    expect(out).toContain("One");
    expect(out).toContain("Two");
  });

  it("handles double-escaped Greenhouse content end to end", () => {
    const out = htmlToText("&amp;lt;p&amp;gt;We use &amp;lt;b&amp;gt;Next.js&amp;lt;/b&amp;gt;&amp;lt;/p&amp;gt;");
    expect(out).toBe("We use Next.js");
  });

  it("returns empty string for null/undefined", () => {
    expect(htmlToText(null)).toBe("");
    expect(htmlToText(undefined)).toBe("");
  });
});

describe("truncateWords", () => {
  it("leaves short text alone", () => {
    expect(truncateWords("short", 100)).toBe("short");
  });
  it("cuts long text on a word boundary and marks it", () => {
    const out = truncateWords("word ".repeat(100), 50);
    expect(out.length).toBeLessThan(80);
    expect(out).toContain("[...truncated]");
  });
});
