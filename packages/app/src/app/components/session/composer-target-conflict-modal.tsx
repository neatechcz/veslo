import { Show, createUniqueId } from "solid-js";
import { X } from "lucide-solid";

import type { ComposerTargetConflict, ComposerTargetSwitchResolution } from "../../types";
import { useTranslate } from "../../../i18n";
import Button from "../button";
import ModalShell from "../modal-shell";

export type ComposerTargetConflictModalProps = {
  conflict: ComposerTargetConflict | null;
  onResolve: (resolution: ComposerTargetSwitchResolution) => void;
  onCancel: () => void;
};

export default function ComposerTargetConflictModal(props: ComposerTargetConflictModalProps) {
  const translate = useTranslate();
  const titleId = createUniqueId();
  const descriptionId = createUniqueId();

  return (
    <ModalShell
      open={Boolean(props.conflict)}
      onClose={props.onCancel}
      layer="elevated"
      backdrop="medium"
      size="lg"
      ariaLabelledBy={titleId}
      ariaDescribedBy={descriptionId}
      class="max-h-[calc(100vh-2rem)]"
    >
      <Show when={props.conflict}>
        {(conflict) => (
          <div data-testid="composer-target-conflict-modal" class="flex max-h-[calc(100vh-2rem)] flex-col p-6">
            <div class="flex items-start justify-between gap-4">
              <div class="min-w-0">
                <h2 id={titleId} class="font-product text-xl font-semibold leading-7 text-dls-text">
                  {translate("session.target_conflict_title", { name: conflict().targetLabel })}
                </h2>
                <p id={descriptionId} class="mt-2 font-product type-ui-sm text-dls-secondary">
                  {translate("session.target_conflict_description")}
                </p>
              </div>
              <div class="flex shrink-0 items-center gap-2">
                <span class="max-w-28 text-right font-product type-ui-xs text-dls-secondary sm:max-w-none">
                  {translate("session.target_conflict_escape_hint")}
                </span>
                <button
                  type="button"
                  onClick={props.onCancel}
                  aria-label={translate("session.target_conflict_escape_hint")}
                  class="inline-flex h-8 w-8 items-center justify-center rounded-lg text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.2)]"
                >
                  <X class="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            </div>

            <div class="mt-5 grid min-h-0 gap-4 md:grid-cols-2">
              <section class="flex min-w-0 flex-col rounded-lg border border-dls-border bg-gray-3 p-4">
                <h3 class="font-product type-ui-xs font-semibold uppercase text-dls-secondary">
                  {translate("session.target_conflict_current")}
                </h3>
                <div class="mt-3 min-h-[8rem] flex-1 overflow-auto rounded-lg border border-gray-6 bg-gray-1 p-3 font-reading type-ui-sm leading-6 text-dls-text">
                  <pre class="m-0 whitespace-pre-wrap break-words font-inherit">{conflict().currentPreview}</pre>
                </div>
                <Button
                  variant="outline"
                  data-testid="composer-target-use-current"
                  class="mt-4 w-full"
                  onClick={() => props.onResolve("use-current")}
                >
                  {translate("session.target_conflict_use_current")}
                </Button>
              </section>

              <section class="flex min-w-0 flex-col rounded-lg border border-dls-border bg-gray-3 p-4">
                <h3 class="font-product type-ui-xs font-semibold uppercase text-dls-secondary">
                  {translate("session.target_conflict_existing", { name: conflict().targetLabel })}
                </h3>
                <div class="mt-3 min-h-[8rem] flex-1 overflow-auto rounded-lg border border-gray-6 bg-gray-1 p-3 font-reading type-ui-sm leading-6 text-dls-text">
                  <pre class="m-0 whitespace-pre-wrap break-words font-inherit">{conflict().destinationPreview}</pre>
                </div>
                <Button
                  variant="primary"
                  data-testid="composer-target-load-existing"
                  class="mt-4 w-full"
                  onClick={() => props.onResolve("load-existing")}
                >
                  {translate("session.target_conflict_load_existing")}
                </Button>
              </section>
            </div>
          </div>
        )}
      </Show>
    </ModalShell>
  );
}
