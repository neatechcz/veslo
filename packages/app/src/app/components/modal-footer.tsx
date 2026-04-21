import type { JSX } from "solid-js";

export type ModalFooterProps = {
  children: JSX.Element;
  bordered?: boolean;
};

export default function ModalFooter(props: ModalFooterProps) {
  return (
    <div
      class={
        props.bordered
          ? "flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-6 bg-gray-2/50"
          : "mt-6 flex justify-end gap-2"
      }
    >
      {props.children}
    </div>
  );
}
