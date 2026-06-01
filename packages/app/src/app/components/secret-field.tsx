import { Show, createSignal } from "solid-js";

import Button from "./button";
import { currentLocale, t } from "../../i18n";

export type SecretFieldProps = {
  label: string;
  value: string | undefined | null;
  hint?: string;
  onCopy?: (value: string) => void;
  copyLabel?: string;
  copiedLabel?: string;
  copied?: boolean;
};

export default function SecretField(props: SecretFieldProps) {
  const [visible, setVisible] = createSignal(false);
  const hasValue = () => Boolean(props.value);

  const displayValue = () => {
    if (!hasValue()) return "—";
    return visible() ? props.value! : "••••••••••••";
  };

  return (
    <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
      <div class="min-w-0">
        <div class="text-xs font-medium text-gray-11">{props.label}</div>
        <div class="text-xs text-gray-7 font-mono truncate">{displayValue()}</div>
        <Show when={props.hint}>
          <div class="text-[11px] text-gray-8 mt-1">{props.hint}</div>
        </Show>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <Button
          variant="outline"
          class="text-xs h-8 py-0 px-3"
          onClick={() => setVisible((prev) => !prev)}
          disabled={!hasValue()}
        >
          {visible() ? t("common.hide", currentLocale()) : t("common.show", currentLocale())}
        </Button>
        <Show when={props.onCopy}>
          <Button
            variant="outline"
            class="text-xs h-8 py-0 px-3"
            onClick={() => props.onCopy?.(props.value ?? "")}
            disabled={!hasValue()}
          >
            {props.copied ? (props.copiedLabel ?? t("common.copied", currentLocale())) : (props.copyLabel ?? t("common.copy", currentLocale()))}
          </Button>
        </Show>
      </div>
    </div>
  );
}
