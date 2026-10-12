import { Marked } from "marked";

/**
 * News bodies arrive from Spordle, i.e. from outside this repo. Markdown is
 * rendered, but any raw HTML in the source is escaped rather than passed
 * through — a news post must never be able to inject script into the site.
 */
const marked = new Marked({ gfm: true, breaks: true });

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function renderMarkdown(body: string): string {
  return marked.parse(escapeHtml(body), { async: false }) as string;
}
