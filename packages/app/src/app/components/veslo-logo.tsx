import type { JSX } from "solid-js";

type Props = {
  size?: number;
  class?: string;
};

export default function VesloLogo(props: Props): JSX.Element {
  const size = props.size ?? 24;
  return (
    <img
      src="/veslo-logo.svg"
      alt="Veslo"
      width={size}
      height={size}
      class={`inline-block ${props.class ?? ""}`}
    />
  );
}
