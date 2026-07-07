import type { JSX } from "solid-js";

import { AlertTriangle } from "lucide-solid";

import Button from "./button";
import ModalShell from "./modal-shell";
import ModalHeader from "./modal-header";
import ModalFooter from "./modal-footer";

export type ConfirmModalProps = {
  open: boolean;
  title: string;
  message: string | JSX.Element;
  confirmLabel: string;
  cancelLabel: string;
  variant?: "danger" | "warning";
  onConfirm: () => void;
  onCancel: () => void;
  onClose?: () => void;
};

export default function ConfirmModal(props: ConfirmModalProps) {
  const variant = () => props.variant ?? "warning";

  const icon = (
    <div
      class="shrink-0 w-10 h-10 rounded-full flex items-center justify-center"
      classList={{
        "bg-amber-3/50 text-amber-11": variant() === "warning",
        "bg-red-3/50 text-red-11": variant() === "danger",
      }}
    >
      <AlertTriangle size={20} />
    </div>
  );

  return (
    <ModalShell open={props.open} onClose={props.onClose ?? props.onCancel} layer="elevated" backdrop="medium" size="sm">
      <div class="p-6">
        <ModalHeader
          title={props.title}
          description={props.message}
          showClose={false}
          icon={icon}
        />

        <ModalFooter>
          <Button variant="outline" onClick={props.onCancel}>
            {props.cancelLabel}
          </Button>
          <Button
            variant={variant() === "danger" ? "danger" : "primary"}
            onClick={props.onConfirm}
          >
            {props.confirmLabel}
          </Button>
        </ModalFooter>
      </div>
    </ModalShell>
  );
}
