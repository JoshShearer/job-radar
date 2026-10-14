/** Derived, never stored: every command computes the same name from the same inputs. */
function slug(raw: string): string {
  return raw.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
}

export function documentBase(personName: string, company: string, kind: "Resume" | "Cover_Letter"): string {
  return [slug(personName), kind, slug(company)].filter(Boolean).join("_").slice(0, 120).replace(/_+$/, "");
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
