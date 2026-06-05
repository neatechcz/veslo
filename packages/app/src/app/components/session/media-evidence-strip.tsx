import { For, Show, createMemo, createSignal } from "solid-js";
import { Download, ExternalLink, Image as ImageIcon, X } from "lucide-solid";

import { currentLocale, t } from "../../../i18n";
import type { MediaEvidence } from "./media-evidence-model.js";

export type MediaEvidenceStripProps = {
  evidence: MediaEvidence[];
};

const tr = (key: string, replacements?: Record<string, string>) => {
  let value = t(key, currentLocale());
  if (!replacements) return value;
  for (const [name, replacement] of Object.entries(replacements)) {
    value = value.replaceAll(`{${name}}`, replacement);
  }
  return value;
};

function kindLabel(kind: MediaEvidence["kind"]): string {
  return kind === "created" ? tr("session.media_evidence_created") : tr("session.media_evidence_analyzed");
}

function detailMeta(item: MediaEvidence): string {
  return [kindLabel(item.kind), item.mime, item.status].filter(Boolean).join(" · ");
}

function downloadName(item: MediaEvidence): string {
  return item.title.trim() || "media-evidence";
}

export default function MediaEvidenceStrip(props: MediaEvidenceStripProps) {
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [failedPreviewIds, setFailedPreviewIds] = createSignal<ReadonlySet<string>>(new Set());
  const visibleEvidence = createMemo(() => props.evidence.slice(0, 3));
  const overflowCount = createMemo(() => Math.max(0, props.evidence.length - visibleEvidence().length));
  const selected = createMemo(() => props.evidence.find((item) => item.id === selectedId()) ?? null);
  const canPreview = (item: MediaEvidence) =>
    item.status === "available" && Boolean(item.src) && !failedPreviewIds().has(item.id);
  const markPreviewFailed = (id: string) => {
    setFailedPreviewIds((current) => {
      if (current.has(id)) return current;
      const next = new Set(current);
      next.add(id);
      return next;
    });
  };
  const openOverflow = () => {
    setSelectedId(props.evidence[visibleEvidence().length]?.id ?? visibleEvidence()[0]?.id ?? null);
  };

  return (
    <Show when={props.evidence.length > 0}>
      <div class="mt-2 flex items-center gap-1.5" data-testid="media-evidence-strip">
        <For each={visibleEvidence()}>
          {(item) => (
            <button
              type="button"
              class="group relative h-12 w-12 overflow-hidden rounded-lg border border-gray-6 bg-gray-2 text-gray-9 transition-colors hover:border-gray-8 hover:text-gray-12"
              title={`${item.title} · ${detailMeta(item)}`}
              aria-label={`${item.title} · ${detailMeta(item)}`}
              data-testid="media-evidence-tile"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setSelectedId(item.id);
              }}
            >
              <Show
                when={canPreview(item)}
                fallback={(
                  <div class="flex h-full w-full items-center justify-center bg-gray-3">
                    <ImageIcon size={18} />
                  </div>
                )}
              >
                <img
                  src={item.src}
                  alt={item.title}
                  class="h-full w-full object-cover"
                  loading="lazy"
                  onError={() => markPreviewFailed(item.id)}
                />
              </Show>
              <span class="absolute bottom-0 left-0 right-0 truncate bg-gray-12/70 px-1 py-0.5 text-[9px] font-medium text-gray-1">
                {kindLabel(item.kind)}
              </span>
            </button>
          )}
        </For>

        <Show when={overflowCount() > 0}>
          <button
            type="button"
            class="h-12 min-w-12 rounded-lg border border-gray-6 bg-gray-2 px-2 text-xs font-semibold text-gray-10 transition-colors hover:border-gray-8 hover:text-gray-12"
            data-testid="media-evidence-tile"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              openOverflow();
            }}
          >
            +{overflowCount()}
          </button>
        </Show>
      </div>

      <Show when={selected()}>
        {(item) => (
          <div
            class="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-4 py-6"
            role="dialog"
            aria-modal="true"
            aria-labelledby="media-evidence-detail-title"
            data-testid="media-evidence-detail"
            onClick={() => setSelectedId(null)}
          >
            <div
              class="max-h-full w-full max-w-3xl overflow-hidden rounded-2xl border border-gray-6 bg-gray-1 shadow-xl"
              onClick={(event) => event.stopPropagation()}
            >
              <div class="flex items-start gap-3 border-b border-gray-6 px-4 py-3">
                <div class="min-w-0 flex-1">
                  <div id="media-evidence-detail-title" class="truncate text-sm font-semibold text-gray-12" title={item().title}>
                    {item().title}
                  </div>
                  <div class="mt-0.5 text-xs text-gray-10">{detailMeta(item())}</div>
                </div>
                <button
                  type="button"
                  class="rounded-lg p-1.5 text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12"
                  aria-label={tr("session.media_evidence_close")}
                  title={tr("session.media_evidence_close")}
                  onClick={() => setSelectedId(null)}
                >
                  <X size={16} />
                </button>
              </div>

              <div class="max-h-[70vh] overflow-auto p-4">
                <div class="flex min-h-56 items-center justify-center overflow-hidden rounded-xl border border-gray-6 bg-gray-2">
                  <Show
                    when={canPreview(item())}
                    fallback={(
                      <div class="flex min-h-56 flex-col items-center justify-center gap-2 px-4 text-gray-9">
                        <ImageIcon size={32} />
                        <span class="text-xs">{detailMeta(item())}</span>
                      </div>
                    )}
                  >
                    <img
                      src={item().src}
                      alt={item().title}
                      class="max-h-[64vh] max-w-full object-contain"
                      onError={() => markPreviewFailed(item().id)}
                    />
                  </Show>
                </div>

                <Show when={item().path}>
                  {(path) => (
                    <div class="mt-3 truncate font-mono text-[11px] text-gray-10" title={path()}>
                      {path()}
                    </div>
                  )}
                </Show>

                <Show when={item().src}>
                  {(src) => (
                    <div class="mt-3 flex flex-wrap items-center gap-2">
                      <a
                        class="inline-flex items-center gap-1.5 rounded-lg border border-gray-6 bg-gray-2 px-2.5 py-1.5 text-xs font-medium text-gray-11 transition-colors hover:border-gray-8 hover:text-gray-12"
                        href={src()}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <ExternalLink size={13} />
                        {tr("session.media_evidence_open")}
                      </a>
                      <a
                        class="inline-flex items-center gap-1.5 rounded-lg border border-gray-6 bg-gray-2 px-2.5 py-1.5 text-xs font-medium text-gray-11 transition-colors hover:border-gray-8 hover:text-gray-12"
                        href={src()}
                        download={downloadName(item())}
                      >
                        <Download size={13} />
                        {tr("session.media_evidence_download")}
                      </a>
                    </div>
                  )}
                </Show>
              </div>
            </div>
          </div>
        )}
      </Show>
    </Show>
  );
}
