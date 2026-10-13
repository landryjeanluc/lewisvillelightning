/** For HTML strings only. Prefer textContent for ordinary DOM updates. */
export const escapeHtml = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** JSON in a script element is HTML raw text, even with application/json. */
export const scriptJson = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c");

export function safeNext(value: string, origin: string): string {
  if (!value.startsWith("/") || /[\\\x00-\x20]/.test(value)) return "/";
  try {
    const url = new URL(value, origin);
    return url.origin === origin ? url.pathname + url.search + url.hash : "/";
  } catch { return "/"; }
}
