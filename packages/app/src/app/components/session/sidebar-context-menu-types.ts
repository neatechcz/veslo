export type SidebarMenuItem = {
  kind: "item";
  id: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
};

type SidebarMenuSeparator = { kind: "separator" };

type SidebarMenuLabel = { kind: "label"; label: string };

export type SidebarMenuEntry = SidebarMenuItem | SidebarMenuSeparator | SidebarMenuLabel;

export type SidebarMenuPlacement =
  | { x: number; y: number; anchorEl?: undefined }
  | { anchorEl: HTMLElement; x?: number; y?: number };
