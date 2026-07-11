import { Show, type JSX } from "solid-js";
import { X } from "lucide-solid";

import Button from "./button";

export type ModalHeaderProps = {
  title: string | JSX.Element;
  description?: string | JSX.Element;
  onClose?: () => void;
  showClose?: boolean;
  closeDisabled?: boolean;
  icon?: JSX.Element;
  titleId?: string;
  descriptionId?: string;
};

export default function ModalHeader(props: ModalHeaderProps) {
  const showClose = () => props.showClose !== false;

  return (
    <div class="flex items-start justify-between gap-4">
      <div class="flex items-start gap-4 min-w-0">
        <Show when={props.icon}>
          {props.icon}
        </Show>
        <div class="min-w-0">
          <h3 id={props.titleId} class="text-lg font-semibold text-gray-12">
            {props.title}
          </h3>
          <Show when={props.description}>
            <p id={props.descriptionId} class="text-sm text-gray-11 mt-1">
              {props.description}
            </p>
          </Show>
        </div>
      </div>
      <Show when={showClose() && props.onClose}>
        <Button
          variant="ghost"
          class="shrink-0 !p-2"
          onClick={props.onClose}
          disabled={props.closeDisabled}
        >
          <X size={16} />
        </Button>
      </Show>
    </div>
  );
}
