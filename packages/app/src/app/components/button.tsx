import { splitProps } from "solid-js";
import type { JSX } from "solid-js";

type ButtonProps = JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "outline" | "ghost" | "danger";
};

export default function Button(props: ButtonProps) {
  const [local, rest] = splitProps(props, ["variant", "class", "disabled", "title", "type"]);
  const variant = () => local.variant ?? "primary";

  const base =
    "font-product type-ui-md inline-flex items-center justify-center gap-1.5 rounded-[var(--dls-radius)] border px-4 py-2 font-medium transition-colors duration-150 active:scale-[0.98] focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.2)] disabled:cursor-not-allowed disabled:opacity-50";

  const variants: Record<NonNullable<ButtonProps["variant"]>, string> = {
    primary: "border-transparent bg-dls-accent text-[#001932] hover:bg-[var(--dls-accent-hover)]",
    outline: "border-[var(--dls-accent-border)] bg-transparent text-dls-accent hover:bg-[var(--dls-accent-tint)]",
    ghost: "border-transparent bg-transparent text-[var(--dls-button-ghost)] hover:bg-[var(--dls-accent-tint)] hover:text-dls-accent",
    danger: "border-transparent bg-red-9 text-white hover:bg-red-10",
  };

  return (
    <button
      {...rest}
      type={local.type ?? "button"}
      disabled={local.disabled}
      aria-disabled={local.disabled}
      title={local.title}
      class={`${base} ${variants[variant()]} ${local.class ?? ""}`.trim()}
    />
  );
}
