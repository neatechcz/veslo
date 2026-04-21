import { Show } from "solid-js";

export type ModalErrorProps = {
  error: string | null | undefined;
};

export default function ModalError(props: ModalErrorProps) {
  return (
    <Show when={props.error}>
      <p role="alert" class="rounded-xl border border-red-7/30 bg-red-1/50 px-3 py-2 text-sm text-red-11">
        {props.error}
      </p>
    </Show>
  );
}
