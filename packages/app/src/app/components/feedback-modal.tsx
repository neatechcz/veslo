import { Show, createEffect, createSignal, createUniqueId, onCleanup } from "solid-js";
import { X } from "lucide-solid";

import { currentLocale, t } from "../../i18n";

import Button from "./button";
import TextInput from "./text-input";

export type FeedbackFormValues = {
  title: string;
  description: string;
};

export type FeedbackModalProps = {
  open: boolean;
  onClose: () => void;
  onSubmit: (values: FeedbackFormValues) => void;
};

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function FeedbackModal(props: FeedbackModalProps) {
  let dialogRef: HTMLDivElement | undefined;
  let titleInputRef: HTMLInputElement | undefined;

  const [title, setTitle] = createSignal("");
  const [description, setDescription] = createSignal("");
  const translate = (key: string) => t(key, currentLocale());
  const canSubmit = () => title().trim().length > 0 && description().trim().length > 0;
  const titleId = createUniqueId();
  const descriptionId = createUniqueId();
  const noteId = createUniqueId();

  createEffect(() => {
    if (!props.open) return;

    setTitle("");
    setDescription("");

    const getFocusableElements = () =>
      dialogRef
        ? Array.from(dialogRef.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        : [];

    const focusInitialField = () => {
      if (titleInputRef) {
        titleInputRef.focus();
        titleInputRef.select();
        return;
      }
      dialogRef?.focus();
    };

    const focusInsideDialog = (target: "first" | "last") => {
      const focusableElements = getFocusableElements();
      const firstFocusable = focusableElements[0];
      const lastFocusable = focusableElements[focusableElements.length - 1];

      if (!firstFocusable || !lastFocusable) {
        dialogRef?.focus();
        return;
      }

      if (target === "last") {
        lastFocusable.focus();
        return;
      }

      firstFocusable.focus();
    };

    const previouslyFocusedElement =
      typeof document !== "undefined" && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        props.onClose();
        return;
      }

      if (event.key !== "Tab") return;

      const focusableElements = getFocusableElements();
      const firstFocusable = focusableElements[0];
      const lastFocusable = focusableElements[focusableElements.length - 1];
      const activeElement =
        typeof document !== "undefined" && document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;

      if (!focusableElements.length) {
        event.preventDefault();
        dialogRef?.focus();
        return;
      }

      if (!activeElement || !dialogRef || !dialogRef.contains(activeElement)) {
        event.preventDefault();
        focusInsideDialog(event.shiftKey ? "last" : "first");
        return;
      }

      if (event.shiftKey && activeElement === firstFocusable) {
        event.preventDefault();
        lastFocusable.focus();
        return;
      }

      if (!event.shiftKey && activeElement === lastFocusable) {
        event.preventDefault();
        firstFocusable.focus();
      }
    };

    const handleFocusIn = (event: FocusEvent) => {
      const activeElement = event.target;
      if (!(activeElement instanceof HTMLElement)) return;
      if (dialogRef && dialogRef.contains(activeElement)) return;
      focusInsideDialog("first");
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("focusin", handleFocusIn, true);

    requestAnimationFrame(() => {
      focusInitialField();
    });

    onCleanup(() => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("focusin", handleFocusIn, true);
      if (previouslyFocusedElement?.isConnected) {
        previouslyFocusedElement.focus();
      }
    });
  });

  const submit = () => {
    if (!canSubmit()) return;
    props.onSubmit({
      title: title().trim(),
      description: description().trim(),
    });
  };

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-[70] flex items-center justify-center bg-gray-1/70 p-4 backdrop-blur-sm">
        <div
          ref={dialogRef}
          class="w-full max-w-xl overflow-hidden rounded-2xl border border-gray-6/70 bg-gray-2 shadow-2xl"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={`${descriptionId} ${noteId}`}
          tabIndex={-1}
        >
          <div class="p-6">
            <div class="flex items-start justify-between gap-4">
              <div>
                <h3 id={titleId} class="text-lg font-semibold text-gray-12">{translate("feedback.modal_title")}</h3>
                <p id={descriptionId} class="mt-1 text-sm text-gray-11">{translate("feedback.modal_description")}</p>
              </div>
              <Button
                variant="ghost"
                class="!p-2 rounded-full"
                onClick={props.onClose}
                title={translate("common.cancel")}
                aria-label={translate("common.cancel")}
              >
                <X size={16} />
              </Button>
            </div>

            <div class="mt-6 space-y-4">
              <TextInput
                ref={titleInputRef}
                label={translate("feedback.title_label")}
                value={title()}
                onInput={(event) => setTitle(event.currentTarget.value)}
                placeholder={translate("feedback.title_placeholder")}
                class="bg-gray-3"
              />

              <label class="block">
                <div class="mb-1 font-product type-ui-xs font-medium text-dls-secondary">
                  {translate("feedback.description_label")}
                </div>
                <textarea
                  rows={5}
                  value={description()}
                  onInput={(event) => setDescription(event.currentTarget.value)}
                  placeholder={translate("feedback.description_placeholder")}
                  class="font-reading type-ui-md w-full resize-y rounded-lg border border-dls-border bg-gray-3 px-3 py-2 text-dls-text placeholder:text-dls-secondary shadow-sm focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.2)]"
                />
              </label>

              <p id={noteId} class="rounded-xl border border-dls-border bg-dls-hover px-3 py-2 text-sm text-dls-secondary">
                {translate("feedback.technical_note")}
              </p>
            </div>

            <div class="mt-6 flex justify-end gap-2">
              <Button variant="outline" onClick={props.onClose}>
                {translate("common.cancel")}
              </Button>
              <Button onClick={submit} disabled={!canSubmit()}>
                {translate("feedback.submit")}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}
