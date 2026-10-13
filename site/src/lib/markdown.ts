import { Marked } from "marked";
import sanitizeHtml from "sanitize-html";

const marked = new Marked({ gfm: true, breaks: true });

/** Sanitize generated HTML too: escaping source HTML does not reject
 * Markdown javascript: links. Remote images are excluded to prevent tracking. */
export function renderMarkdown(body: string): string {
  return sanitizeHtml(marked.parse(body, { async: false }), {
    allowedTags: ["p", "br", "strong", "em", "s", "blockquote", "ul", "ol", "li",
      "h2", "h3", "h4", "pre", "code", "hr", "a", "table", "thead", "tbody", "tr", "th", "td"],
    allowedAttributes: { a: ["href", "title", "rel"] },
    allowedSchemes: ["https", "http"],
    allowProtocolRelative: false,
    transformTags: { a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer" }) },
  });
}
