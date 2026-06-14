import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { Check, ChevronDown, Folder, FolderPlus, MessageCircle } from "lucide-solid";

import type { ComposerTargetOption } from "../../types";
import { useTranslate } from "../../../i18n";
import { useOutsideClick } from "./use-outside-click";

export type ComposerTargetPickerProps = {
  options: ComposerTargetOption[];
  activeTargetId: string | null;
  disabled?: boolean;
  onSelect: (targetId: string) => void;
};

const TargetIcon = (props: { kind: ComposerTargetOption["kind"]; class?: string }) => {
  const iconClass = () => props.class ?? "h-4 w-4";
  return (
    <Show
      when={props.kind === "workspace"}
      fallback={
        <Show when={props.kind === "choose-workspace"} fallback={<MessageCircle class={iconClass()} aria-hidden="true" />}>
          <FolderPlus class={iconClass()} aria-hidden="true" />
        </Show>
      }
    >
      <Folder class={iconClass()} aria-hidden="true" />
    </Show>
  );
};

export default function ComposerTargetPicker(props: ComposerTargetPickerProps) {
  let rootRef: HTMLDivElement | undefined;
  let buttonRef: HTMLButtonElement | undefined;
  const [open, setOpen] = createSignal(false);
  const translate = useTranslate();

  const activeOption = createMemo(() => {
    const options = props.options;
    return options.find((option) => option.id === props.activeTargetId) ?? options[0] ?? null;
  });

  const selectOption = (targetId: string) => {
    props.onSelect(targetId);
    setOpen(false);
    buttonRef?.focus();
  };

  useOutsideClick(() => open(), () => rootRef, () => setOpen(false));

  createEffect(() => {
    if (!open()) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      buttonRef?.focus();
    };
    window.addEventListener("keydown", handleKeyDown);
    onCleanup(() => window.removeEventListener("keydown", handleKeyDown));
  });

  return (
    <div ref={rootRef} class="relative inline-flex">
      <button
        ref={buttonRef}
        type="button"
        data-testid="composer-target-picker"
        disabled={props.disabled}
        aria-haspopup="menu"
        aria-expanded={open()}
        onClick={() => {
          if (props.disabled) return;
          setOpen((current) => !current);
        }}
        class="font-product type-ui-sm inline-flex max-w-[min(22rem,calc(100vw-2rem))] items-center gap-2 rounded-lg border border-dls-border bg-gray-2 px-2.5 py-1.5 font-medium text-dls-text shadow-sm transition-colors hover:bg-dls-hover focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.2)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Show when={activeOption()}>{(option) => <TargetIcon kind={option().kind} class="h-3.5 w-3.5 shrink-0 text-dls-secondary" />}</Show>
        <span class="min-w-0 truncate">{activeOption()?.label ?? ""}</span>
        <ChevronDown class={`h-3.5 w-3.5 shrink-0 text-dls-secondary transition-transform ${open() ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>

      <Show when={open()}>
        <div
          role="menu"
          class="absolute left-0 top-full z-30 mt-2 w-[min(22rem,calc(100vw-2rem))] max-h-[min(24rem,calc(100vh-10rem))] overflow-y-auto overscroll-contain rounded-lg border border-gray-6 bg-gray-1 shadow-xl backdrop-blur-md"
        >
          <For each={props.options}>
            {(option) => {
              const selected = () => option.id === activeOption()?.id;
              return (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected()}
                  data-testid="composer-target-option"
                  data-composer-target-kind={option.kind}
                  data-composer-target-id={option.id}
                  data-composer-target-directory={option.kind === "workspace" ? (option.directory ?? "") : undefined}
                  disabled={props.disabled}
                  onClick={() => selectOption(option.id)}
                  class="flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-dls-hover focus:bg-dls-hover focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-gray-6 bg-gray-2 text-dls-secondary">
                    <TargetIcon kind={option.kind} class="h-4 w-4" />
                  </span>
                  <span class="min-w-0 flex-1">
                    <span class="flex min-w-0 items-center gap-2">
                      <span class="truncate font-product type-ui-sm font-semibold text-dls-text">{option.label}</span>
                      <Show when={option.draftStatus === "draft"}>
                        <span
                          data-testid="composer-target-draft-badge"
                          class="shrink-0 rounded-md border border-amber-7 bg-amber-3 px-1.5 py-0.5 font-product text-[11px] font-semibold leading-4 text-amber-11"
                        >
                          {translate("session.target_draft_badge")}
                        </span>
                      </Show>
                    </span>
                    <Show when={option.kind !== "workspace" && option.description.trim()}>
                      {(description) => (
                        <span class="mt-0.5 block break-words font-product type-ui-xs text-dls-secondary">{description()}</span>
                      )}
                    </Show>
                  </span>
                  <span class="flex h-5 w-5 shrink-0 items-center justify-center text-dls-accent">
                    <Show when={selected()}>
                      <Check class="h-4 w-4" aria-hidden="true" />
                    </Show>
                  </span>
                </button>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}
