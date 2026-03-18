type ToggleIconProps = {
  class?: string;
  size?: number;
};

const baseProps = {
  fill: "none",
  stroke: "currentColor",
  "stroke-width": 1.8,
  "stroke-linecap": "round",
  "stroke-linejoin": "round",
} as const;

export function LeftSidebarToggleIcon(props: ToggleIconProps) {
  const size = props.size ?? 18;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      class={props.class}
      aria-hidden="true"
      {...baseProps}
    >
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="M7 8V16" />
    </svg>
  );
}

export function RightSidebarToggleIcon(props: ToggleIconProps) {
  const size = props.size ?? 18;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      class={props.class}
      aria-hidden="true"
      {...baseProps}
    >
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="M17 8V16" />
    </svg>
  );
}
