import { Show, createSignal, createUniqueId } from "solid-js";

import { useTranslate } from "../../i18n";

import Button from "./button";
import TextInput from "./text-input";
import ModalShell from "./modal-shell";
import ModalHeader from "./modal-header";
import ModalFooter from "./modal-footer";
import ModalError from "./modal-error";
import { useFocusTrap } from "./use-modal-focus";

export type FeedbackFormValues = {
  title: string;
  description: string;
};

export type FeedbackModalProps = {
  open: boolean;
  error: string | null;
  successIssueId: string | null;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (values: FeedbackFormValues) => void;
};

export default function FeedbackModal(props: FeedbackModalProps) {
  let dialogRef: HTMLDivElement | undefined;
  let titleInputRef: HTMLInputElement | undefined;

  const [title, setTitle] = createSignal("");
  const [description, setDescription] = createSignal("");
  const translate = useTranslate();
  const canSubmit = () => !props.successIssueId && title().trim().length > 0 && description().trim().length > 0;
  const titleId = createUniqueId();
  const descriptionId = createUniqueId();
  const noteId = createUniqueId();
  const successId = createUniqueId();

  useFocusTrap(() => props.open, () => dialogRef, {
    onClose: () => props.onClose(),
    getInitialFocus: () => titleInputRef,
    onOpen: () => {
      setTitle("");
      setDescription("");
    },
  });

  const submit = () => {
    if (!canSubmit() || props.submitting) return;
    props.onSubmit({
      title: title().trim(),
      description: description().trim(),
    });
  };

  return (
    <ModalShell
      open={props.open}
      onClose={props.onClose}
      layer="top"
      backdrop="medium"
      size="lg"
      closeOnBackdrop={false}
      ariaLabelledBy={titleId}
      ariaDescribedBy={`${descriptionId} ${noteId} ${successId}`}
    >
      <div ref={dialogRef} class="p-6" tabIndex={-1}>
        <ModalHeader
          title={translate("feedback.modal_title")}
          description={translate("feedback.modal_description")}
          onClose={props.onClose}
          titleId={titleId}
          descriptionId={descriptionId}
        />

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

          <Show when={props.successIssueId}>
            {(issueId) => (
              <p id={successId} role="status" class="rounded-xl border border-dls-border bg-gray-3 px-3 py-2 text-sm text-dls-text">
                {translate("feedback.success_message", { issueId: issueId() })}
              </p>
            )}
          </Show>

          <ModalError error={props.error} />
        </div>

        <ModalFooter>
          <Button variant="outline" onClick={props.onClose}>
            {translate(props.successIssueId ? "common.close" : "common.cancel")}
          </Button>
          <Button onClick={submit} disabled={props.submitting || !canSubmit()}>
            {translate("feedback.submit")}
          </Button>
        </ModalFooter>
      </div>
    </ModalShell>
  );
}
