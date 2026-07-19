import { Show } from "solid-js";

import type { ManagedAiServerReloadPresentation } from "../../context/managed-ai-runtime-config";

export type ManagedAiServerReloadBannerProps = {
  presentation: ManagedAiServerReloadPresentation;
  widthClass: string;
  pendingLabel: string;
  reloadingLabel: string;
};

export default function ManagedAiServerReloadBanner(props: ManagedAiServerReloadBannerProps) {
  return (
    <Show when={props.presentation.kind !== "idle"}>
      <div
        class="border-b border-blue-6/50 bg-blue-2/70 px-6 py-2"
        data-testid="session-managed-ai-config-status"
        data-managed-ai-config-status={props.presentation.kind}
        aria-live="polite"
      >
        <div class={`mx-auto flex w-full ${props.widthClass} items-center gap-2 rounded-lg border border-blue-6/60 bg-blue-1/85 px-3 py-2 text-xs text-blue-11 shadow-sm`}>
          <svg
            aria-hidden="true"
            class={props.presentation.kind === "reloading" ? "h-3.5 w-3.5 shrink-0 animate-spin" : "h-3.5 w-3.5 shrink-0"}
            fill="none"
            height="14"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            viewBox="0 0 24 24"
            width="14"
          >
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
          <span>
            {props.presentation.kind === "reloading" ? props.reloadingLabel : props.pendingLabel}
          </span>
        </div>
      </div>
    </Show>
  );
}
