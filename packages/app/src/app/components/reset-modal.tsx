import { Match, Show, Switch } from "solid-js";

import { useTranslate, type Language } from "../../i18n";

import Button from "./button";
import TextInput from "./text-input";
import ModalShell from "./modal-shell";
import ModalHeader from "./modal-header";
import ModalFooter from "./modal-footer";

export type ResetModalProps = {
  open: boolean;
  mode: "onboarding" | "all";
  text: string;
  busy: boolean;
  canReset: boolean;
  hasActiveRuns: boolean;
  language: Language;
  onClose: () => void;
  onConfirm: () => void;
  onTextChange: (value: string) => void;
};

export default function ResetModal(props: ResetModalProps) {
  const translate = useTranslate(() => props.language);

  const title = () => (
    <Switch>
      <Match when={props.mode === "onboarding"}>{translate("settings.reset_onboarding_title")}</Match>
      <Match when={true}>{translate("settings.reset_app_data_title")}</Match>
    </Switch>
  );

  return (
    <ModalShell open={props.open} onClose={props.onClose} size="lg">
      <div class="p-6">
        <ModalHeader
          title={title()}
          description={<span innerHTML={translate("settings.reset_confirmation_hint")} />}
          onClose={props.onClose}
          closeDisabled={props.busy}
        />

        <div class="mt-6 space-y-4">
          <div class="rounded-xl bg-gray-1/20 border border-gray-6 p-3 text-xs text-gray-11">
            <Switch>
              <Match when={props.mode === "onboarding"}>
                {translate("settings.reset_onboarding_warning")}
              </Match>
              <Match when={true}>{translate("settings.reset_app_data_warning")}</Match>
            </Switch>
          </div>

          <Show when={props.hasActiveRuns}>
            <div class="text-xs text-red-11">{translate("settings.reset_stop_active_runs")}</div>
          </Show>

          <TextInput
            label={translate("settings.reset_confirmation_label")}
            placeholder={translate("settings.reset_confirmation_placeholder")}
            value={props.text}
            onInput={(e) => props.onTextChange(e.currentTarget.value)}
            disabled={props.busy}
          />
        </div>

        <ModalFooter>
          <Button variant="outline" onClick={props.onClose} disabled={props.busy}>
            {translate("settings.reset_cancel")}
          </Button>
          <Button variant="danger" onClick={props.onConfirm} disabled={!props.canReset}>
            {translate("settings.reset_confirm_button")}
          </Button>
        </ModalFooter>
      </div>
    </ModalShell>
  );
}
