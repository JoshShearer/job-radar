import { chromium } from "playwright";
import type { PdfRenderer } from "../../ports/io.js";

/** Render HTML to PDF with the Chromium that already ships for form filling. */
export class PlaywrightPdf implements PdfRenderer {
  async render(html: string): Promise<Uint8Array> {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: "load" });
      return await page.pdf({ format: "Letter", printBackground: true });
    } finally {
      await browser.close();
    }
  }
}
