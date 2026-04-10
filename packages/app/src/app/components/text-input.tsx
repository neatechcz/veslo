import { splitProps, JSX } from "solid-js";

type TextInputProps = JSX.InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  hint?: string;
};

export default function TextInput(props: TextInputProps) {
  const [local, rest] = splitProps(props, ["label", "hint", "class", "ref"]);

  return (
    <label class="block">
      {local.label ? (
        <div class="mb-1 font-product type-ui-xs font-medium text-dls-secondary">{local.label}</div>
      ) : null}
      <input
        {...rest}
        ref={local.ref}
        class={`font-reading type-ui-md w-full rounded-lg bg-dls-surface px-3 py-2 text-dls-text placeholder:text-dls-secondary border border-dls-border shadow-sm focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.2)] ${
          local.class ?? ""
        }`.trim()}
      />
      {local.hint ? <div class="mt-1 font-product type-ui-sm text-dls-secondary">{local.hint}</div> : null}
    </label>
  );
}
