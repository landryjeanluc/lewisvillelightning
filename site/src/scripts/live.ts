/**
 * Admin-authored content lives in the API, not in the static build, so a post
 * or a bio is live the moment it is saved — no rebuild, no deploy.
 *
 * Every helper fails quiet: if the API is unreachable the page keeps whatever
 * the static build rendered rather than collapsing into an error.
 */
export async function api<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch("/api" + path, { credentials: "same-origin" });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

/** Minimal, safe markdown: bold, italics, links, lists, paragraphs. */
export function md(src: string): string {
  const esc = (s: string) =>
    s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
  const lines = esc(src).split(/\r?\n/);
  const out: string[] = [];
  let list = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^[-*]\s+/.test(line)) {
      if (!list) { out.push("<ul>"); list = true; }
      out.push(`<li>${inline(line.replace(/^[-*]\s+/, ""))}</li>`);
      continue;
    }
    if (list) { out.push("</ul>"); list = false; }
    if (!line) continue;
    if (/^###\s+/.test(line)) out.push(`<h4>${inline(line.slice(4))}</h4>`);
    else if (/^##\s+/.test(line)) out.push(`<h3>${inline(line.slice(3))}</h3>`);
    else if (/^#\s+/.test(line)) out.push(`<h3>${inline(line.slice(2))}</h3>`);
    else out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push("</ul>");
  return out.join("");

  function inline(s: string): string {
    return s
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|\W)\*([^*]+)\*/g, "$1<em>$2</em>")
      // only http(s) links, and never javascript: — this text came from a form
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noopener">$1</a>');
  }
}

export const niceDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-CA",
    { weekday: "short", month: "long", day: "numeric", year: "numeric" });
