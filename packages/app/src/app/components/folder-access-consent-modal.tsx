import { FolderOpen, ShieldCheck } from "lucide-solid";

import { currentLocale, t } from "../../i18n";
import Button from "./button";
import ModalError from "./modal-error";
import ModalFooter from "./modal-footer";
import ModalHeader from "./modal-header";
import ModalShell from "./modal-shell";
import { useFocusTrap } from "./use-modal-focus";

export type FolderAccessConsentModalProps = {
  open: boolean;
  requestedPath: string;
  pickerStartPath: string;
  accessMode: "read";
  duration: "workspace";
  error?: string | null;
  onChooseFolder: () => void;
  onCancel: () => void;
};

const titleId = "folder-access-consent-title";
const descriptionId = "folder-access-consent-description";

export default function FolderAccessConsentModal(props: FolderAccessConsentModalProps) {
  let dialogRef: HTMLDivElement | undefined;
  let chooseFolderRef: HTMLButtonElement | undefined;
  const translate = (key: string) => t(key, currentLocale());

  const accessLabel = () =>
    props.accessMode === "read" ? translate("folder_access.access_read_only") : props.accessMode;
  const durationLabel = () =>
    props.duration === "workspace" ? translate("folder_access.duration_workspace") : props.duration;

  useFocusTrap(() => props.open, () => dialogRef, {
    onClose: () => props.onCancel(),
    getInitialFocus: () => chooseFolderRef,
  });

  return (
    <ModalShell
      open={props.open}
      onClose={props.onCancel}
      layer="elevated"
      backdrop="medium"
      size="md"
      ariaLabelledBy={titleId}
      ariaDescribedBy={descriptionId}
    >
      <div ref={dialogRef} data-testid="folder-access-consent-modal" class="p-6" tabIndex={-1}>
        <ModalHeader
          titleId={titleId}
          descriptionId={descriptionId}
          title={translate("folder_access.title")}
          description={translate("folder_access.body_intro")}
          showClose={false}
          icon={(
            <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-3 text-blue-11">
              <ShieldCheck size={20} />
            </div>
          )}
        />

        <div class="mt-5 space-y-4">
          <div>
            <div class="text-xs font-semibold uppercase tracking-wide text-gray-10">
              {translate("folder_access.requested_path_label")}
            </div>
            <div
              data-testid="folder-access-requested-path"
              class="mt-2 break-all rounded-lg border border-gray-6 bg-gray-1 px-3 py-2 font-mono text-xs text-gray-12"
            >
              {props.requestedPath}
            </div>
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
            <div class="rounded-lg border border-gray-6 bg-gray-1 px-3 py-2">
              <div class="text-xs font-semibold uppercase tracking-wide text-gray-10">
                {translate("folder_access.access_label")}
              </div>
              <div data-testid="folder-access-mode" class="mt-1 text-sm font-medium text-gray-12">
                {accessLabel()}
              </div>
            </div>
            <div class="rounded-lg border border-gray-6 bg-gray-1 px-3 py-2">
              <div class="text-xs font-semibold uppercase tracking-wide text-gray-10">
                {translate("folder_access.duration_label")}
              </div>
              <div data-testid="folder-access-duration" class="mt-1 text-sm font-medium text-gray-12">
                {durationLabel()}
              </div>
            </div>
          </div>

          <div
            data-testid="folder-access-picker-start"
            class="rounded-lg border border-blue-6/50 bg-blue-2/60 px-3 py-2 text-sm leading-6 text-gray-11"
          >
            {translate("folder_access.picker_guidance").replace("{path}", props.pickerStartPath)}
          </div>

          <ModalError
            error={
              props.error === "invalid_selection"
                ? translate("folder_access.invalid_selection")
                : props.error ?? null
            }
          />
        </div>

        <ModalFooter>
          <Button data-testid="folder-access-cancel" variant="outline" onClick={props.onCancel}>
            {translate("folder_access.cancel")}
          </Button>
          <Button ref={chooseFolderRef} data-testid="folder-access-choose-folder" onClick={props.onChooseFolder}>
            <FolderOpen size={16} />
            {translate("folder_access.choose_folder")}
          </Button>
        </ModalFooter>
      </div>
    </ModalShell>
  );
}
