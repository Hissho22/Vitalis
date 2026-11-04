import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

export async function renderSafeMarkdown(markdown: string): Promise<string> {
  const html = await marked.parse(markdown);
  return sanitizeHtml(html, {
    allowedTags: [
      "a",
      "blockquote",
      "br",
      "code",
      "del",
      "em",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "li",
      "ol",
      "p",
      "pre",
      "strong",
      "table",
      "tbody",
      "td",
      "th",
      "thead",
      "tr",
      "ul",
    ],
    allowedAttributes: { a: ["href", "rel"], code: ["class"] },
    allowedClasses: { code: ["language-*"] },
    allowedSchemes: ["http", "https", "mailto"],
  });
}
