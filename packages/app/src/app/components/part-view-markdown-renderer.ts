import { marked } from "marked";

import { renderCodeSpanWithLink, renderInlineTextWithLinks } from "./part-view-link-utils";

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const isSafeUrl = (url: string) => {
  const normalized = (url || "").trim().toLowerCase();
  if (normalized.startsWith("javascript:")) return false;
  // Allow data:image/* URIs (base64-encoded images from AI models) but block
  // other data: schemes (e.g. data:text/html) which could be used for XSS.
  if (normalized.startsWith("data:")) return normalized.startsWith("data:image/");
  return true;
};

export function createCustomRenderer(tone: "light" | "dark") {
  const renderer = new marked.Renderer();
  const codeBlockClass =
    tone === "dark"
      ? "bg-gray-12/10 border-gray-11/20 text-gray-12"
      : "bg-gray-1/80 border-gray-6/70 text-gray-12";
  const inlineCodeClass =
    tone === "dark"
      ? "bg-gray-12/15 text-gray-12"
      : "bg-gray-2/70 text-gray-12";

  renderer.html = ({ text }) => escapeHtml(text);

  renderer.text = function (token) {
    const record = token as { text?: string; tokens?: unknown[] };
    const nestedTokens = Array.isArray(record.tokens) ? record.tokens : [];
    if (nestedTokens.length > 0) {
      const parser = (this as { parser?: { parseInline?: (items: unknown[]) => string } }).parser;
      if (parser?.parseInline) {
        return parser.parseInline(nestedTokens as unknown[]);
      }
    }

    return renderInlineTextWithLinks(typeof record.text === "string" ? record.text : "");
  };

  renderer.code = ({ text, lang }) => {
    const language = lang || "";
    return `
      <div class="rounded-2xl border px-4 py-3 my-4 ${codeBlockClass}">
        ${
          language
            ? `<div class="text-[10px] uppercase tracking-[0.2em] text-gray-9 mb-2">${escapeHtml(language)}</div>`
            : ""
        }
        <pre class="overflow-x-auto whitespace-pre text-[13px] leading-relaxed font-mono"><code>${escapeHtml(
          text,
        )}</code></pre>
      </div>
    `;
  };

  renderer.codespan = ({ text }) => {
    return renderCodeSpanWithLink(
      text,
      `rounded-md px-1.5 py-0.5 text-[13px] font-mono ${inlineCodeClass}`,
    );
  };

  renderer.link = ({ href, title, text }) => {
    const safeHref = isSafeUrl(href) ? escapeHtml(href ?? "#") : "#";
    const safeTitle = title ? escapeHtml(title) : "";
    return `
      <a
        href="${safeHref}"
        target="_blank"
        rel="noopener noreferrer"
        class="underline underline-offset-2 text-dls-accent hover:text-[var(--dls-accent-hover)]"
        ${safeTitle ? `title="${safeTitle}"` : ""}
      >
        ${text}
      </a>
    `;
  };

  renderer.image = ({ href, title, text }) => {
    const safeHref = isSafeUrl(href) ? escapeHtml(href ?? "") : "";
    const safeTitle = title ? escapeHtml(title) : "";
    return `
      <img
        src="${safeHref}"
        alt="${escapeHtml(text || "")}"
        ${safeTitle ? `title="${safeTitle}"` : ""}
        class="max-w-full h-auto rounded-lg my-4"
      />
    `;
  };

  return renderer;
}
