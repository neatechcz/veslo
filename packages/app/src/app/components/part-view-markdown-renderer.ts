import { marked } from "marked";

import { renderCodeSpanWithLink } from "./part-view-link-utils";

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const copyIconHtml = `
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    data-lucide="copy"
    aria-hidden="true"
  >
    <rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect>
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path>
  </svg>
`;

const isSafeUrl = (url: string) => {
  const normalized = (url || "").trim().toLowerCase();
  if (normalized.startsWith("javascript:")) return false;
  // Allow data:image/* URIs (base64-encoded images from AI models) but block
  // other data: schemes (e.g. data:text/html) which could be used for XSS.
  if (normalized.startsWith("data:")) return normalized.startsWith("data:image/");
  return true;
};

export function createCustomRenderer(tone: "light" | "dark", options?: { copyCodeLabel?: string }) {
  const renderer = new marked.Renderer();
  const copyCodeLabel = options?.copyCodeLabel ?? "Copy";
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

    // Let marked handle URL autolinks via GFM — no custom link detection in prose text.
    // File paths in backticks are still detected via renderer.codespan().
    return escapeHtml(typeof record.text === "string" ? record.text : "");
  };

  renderer.code = ({ text, lang }) => {
    const language = lang || "";
    return `
      <div data-testid="part-view-code-block" data-markdown-code-block class="group/code-block relative rounded-2xl border px-4 py-3 my-4 ${codeBlockClass}">
        ${
          language
            ? `<div class="text-[10px] uppercase tracking-[0.2em] text-gray-9 mb-2">${escapeHtml(language)}</div>`
            : ""
        }
        <button
          type="button"
          data-testid="part-view-code-copy"
          data-markdown-code-copy
          class="absolute right-4 top-4 z-10 shrink-0 rounded p-1 text-dls-secondary opacity-0 pointer-events-none transition-colors transition-opacity hover:bg-dls-hover hover:text-dls-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.24)] group-hover/code-block:opacity-100 group-hover/code-block:pointer-events-auto group-focus-within/code-block:opacity-100 group-focus-within/code-block:pointer-events-auto select-none"
          title="${escapeHtml(copyCodeLabel)}"
          aria-label="${escapeHtml(copyCodeLabel)}"
        >
          ${copyIconHtml}
        </button>
        <pre class="overflow-x-auto whitespace-pre pr-8 text-[13px] leading-relaxed font-mono"><code>${escapeHtml(
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
