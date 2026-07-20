import type { JSX } from "solid-js";

type Props = {
  size?: number;
  class?: string;
};

export default function VesloLogo(props: Props): JSX.Element {
  return (
    <img
      src="/veslo-logo.svg"
      alt="Veslo"
      width={props.size ?? 24}
      height={props.size ?? 24}
      class={`inline-block ${props.class ?? ""}`}
    />
  );
}
