import { useTranslate } from "../../i18n";

import Button from "./button";
import TextInput from "./text-input";
import ModalShell from "./modal-shell";
import ModalHeader from "./modal-header";
import ModalFooter from "./modal-footer";
import { useModalFocus } from "./use-modal-focus";

export type RenameModalProps = {
  open: boolean;
  title: string;
  busy: boolean;
  canSave: boolean;
  onClose: () => void;
  onSave: () => void;
  onTitleChange: (value: string) => void;
  titleKey: string;
  descriptionKey: string;
  labelKey: string;
  placeholderKey: string;
};

export default function RenameModal(props: RenameModalProps) {
  let inputRef: HTMLInputElement | undefined;
  const translate = useTranslate();

  useModalFocus(() => props.open, () => inputRef, { select: true });

  return (
    <ModalShell open={props.open} onClose={props.onClose}>
      <div class="p-6">
        <ModalHeader
          title={translate(props.titleKey)}
          description={translate(props.descriptionKey)}
          onClose={props.onClose}
        />

        <div class="mt-6">
          <TextInput
            ref={inputRef}
            label={translate(props.labelKey)}
            value={props.title}
            onInput={(e) => props.onTitleChange(e.currentTarget.value)}
            placeholder={translate(props.placeholderKey)}
            class="bg-gray-3"
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
              event.preventDefault();
              if (props.canSave) props.onSave();
            }}
          />
        </div>

        <ModalFooter>
          <Button variant="outline" onClick={props.onClose} disabled={props.busy}>
            {translate("common.cancel")}
          </Button>
          <Button onClick={props.onSave} disabled={!props.canSave}>
            {translate("common.save")}
          </Button>
        </ModalFooter>
      </div>
    </ModalShell>
  );
}
