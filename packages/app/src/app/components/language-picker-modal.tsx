import { For } from "solid-js";
import { CheckCircle2, Circle } from "lucide-solid";
import { LANGUAGE_OPTIONS, type Language, useTranslate } from "../../i18n";

import Button from "./button";
import ModalShell from "./modal-shell";
import ModalHeader from "./modal-header";

export type LanguagePickerModalProps = {
  open: boolean;
  currentLanguage: Language;
  onSelect: (language: Language) => void;
  onClose: () => void;
};

export default function LanguagePickerModal(props: LanguagePickerModalProps) {
  const translate = useTranslate();

  return (
    <ModalShell open={props.open} onClose={props.onClose} size="sm">
      <div class="p-6">
        <ModalHeader title={translate("settings.language")} showClose={false} />

        <div class="mt-4 space-y-2">
          <For each={LANGUAGE_OPTIONS}>
            {(option) => (
              <button
                class={`w-full p-3 rounded-xl text-left transition-all ${
                  props.currentLanguage === option.value
                    ? "bg-gray-4 text-gray-12 border-2 border-gray-7"
                    : "bg-gray-3 text-gray-11 hover:bg-gray-4 border-2 border-transparent"
                }`}
                onClick={() => {
                  props.onSelect(option.value);
                  props.onClose();
                }}
              >
                <div class="flex items-center justify-between gap-2">
                  <div class="flex-1">
                    <div class="font-medium text-sm">{option.nativeName}</div>
                    {option.label !== option.nativeName && (
                      <div class="text-xs text-gray-10 mt-0.5">{option.label}</div>
                    )}
                  </div>
                  <div class="text-gray-10">
                    {props.currentLanguage === option.value
                      ? <CheckCircle2 size={14} class="text-green-11" />
                      : <Circle size={14} />}
                  </div>
                </div>
              </button>
            )}
          </For>
        </div>

        <div class="mt-4">
          <Button variant="ghost" class="w-full" onClick={props.onClose}>
            {translate("common.cancel")}
          </Button>
        </div>
      </div>
    </ModalShell>
  );
}
