import { Show, type ComponentProps, type JSX } from "solid-js";

import SidebarStatusControls from "../components/sidebar-status-controls";
import SidebarDashboardNav from "../components/session/sidebar-dashboard-nav";
import WorkspaceSessionList from "../components/session/workspace-session-list";

type SidebarStyle = JSX.CSSProperties | string;

export type SessionLeftSidebarProps = {
  dockedVisible: boolean;
  overlayOpen: boolean;
  resizing: boolean;
  dockedStyle: SidebarStyle;
  overlayStyle: SidebarStyle;
  resizeLabel: string;
  updatePill?: JSX.Element;
  workspaceSessionListProps: ComponentProps<typeof WorkspaceSessionList>;
  dashboardNavProps: ComponentProps<typeof SidebarDashboardNav>;
  statusControlsProps: ComponentProps<typeof SidebarStatusControls>;
  onCloseOverlay: () => void;
  onStartResize: (event: PointerEvent) => void;
};

function sidebarClass(resizing: boolean) {
  return `relative flex shrink-0 flex-col bg-dls-sidebar border-r border-gray-6/70 p-3 pt-12 ${
    resizing ? "cursor-col-resize" : ""
  }`;
}

function overlaySidebarClass(resizing: boolean) {
  return `fixed inset-y-0 left-0 z-[45] flex flex-col bg-dls-sidebar border-r border-gray-6/80 p-3 pt-12 shadow-xl shadow-gray-12/20 ${
    resizing ? "cursor-col-resize" : ""
  }`;
}

function SidebarOverlayBackdrop(props: { onClose: () => void }) {
  return (
    <div
      class="fixed inset-0 z-40 bg-gray-12/20 backdrop-blur-[1px]"
      onClick={() => props.onClose()}
    />
  );
}

function SidebarResizeHandle(props: {
  label: string;
  onStartResize: (event: PointerEvent) => void;
}) {
  return (
    <div
      class="absolute inset-y-0 right-0 w-2 cursor-col-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label={props.label}
      onPointerDown={(event) => props.onStartResize(event)}
    />
  );
}

function SessionLeftSidebarContent(props: {
  updatePill?: JSX.Element;
  workspaceSessionListProps: ComponentProps<typeof WorkspaceSessionList>;
  dashboardNavProps: ComponentProps<typeof SidebarDashboardNav>;
  statusControlsProps: ComponentProps<typeof SidebarStatusControls>;
}) {
  return (
    <>
      <div class="flex min-h-0 flex-1 flex-col">
        <Show when={props.updatePill}>{props.updatePill}</Show>
        <div class="min-h-0 flex-1">
          <WorkspaceSessionList {...props.workspaceSessionListProps} />
        </div>
        <SidebarDashboardNav {...props.dashboardNavProps} />
      </div>
      <SidebarStatusControls {...props.statusControlsProps} />
    </>
  );
}

function LeftSidebarFrame(props: {
  style: SidebarStyle;
  resizing: boolean;
  resizeLabel: string;
  updatePill?: JSX.Element;
  workspaceSessionListProps: ComponentProps<typeof WorkspaceSessionList>;
  dashboardNavProps: ComponentProps<typeof SidebarDashboardNav>;
  statusControlsProps: ComponentProps<typeof SidebarStatusControls>;
  onStartResize: (event: PointerEvent) => void;
}) {
  return (
    <aside data-testid="session-left-sidebar" data-sidebar-mode="docked" class={sidebarClass(props.resizing)} style={props.style}>
      <SessionLeftSidebarContent
        updatePill={props.updatePill}
        workspaceSessionListProps={props.workspaceSessionListProps}
        dashboardNavProps={props.dashboardNavProps}
        statusControlsProps={props.statusControlsProps}
      />
      <SidebarResizeHandle
        label={props.resizeLabel}
        onStartResize={props.onStartResize}
      />
    </aside>
  );
}

function LeftSidebarOverlay(props: SessionLeftSidebarProps) {
  return (
    <Show when={props.overlayOpen}>
      <SidebarOverlayBackdrop onClose={props.onCloseOverlay} />
      <aside
        data-testid="session-left-sidebar"
        data-sidebar-mode="overlay"
        class={overlaySidebarClass(props.resizing)}
        style={props.overlayStyle}
        onClick={(event) => event.stopPropagation()}
      >
        <SessionLeftSidebarContent
          updatePill={props.updatePill}
          workspaceSessionListProps={props.workspaceSessionListProps}
          dashboardNavProps={props.dashboardNavProps}
          statusControlsProps={props.statusControlsProps}
        />
        <SidebarResizeHandle
          label={props.resizeLabel}
          onStartResize={props.onStartResize}
        />
      </aside>
    </Show>
  );
}

export default function SessionLeftSidebar(props: SessionLeftSidebarProps) {
  return (
    <>
      <Show when={props.dockedVisible}>
        <LeftSidebarFrame
          style={props.dockedStyle}
          resizing={props.resizing}
          resizeLabel={props.resizeLabel}
          updatePill={props.updatePill}
          workspaceSessionListProps={props.workspaceSessionListProps}
          dashboardNavProps={props.dashboardNavProps}
          statusControlsProps={props.statusControlsProps}
          onStartResize={props.onStartResize}
        />
      </Show>
      <LeftSidebarOverlay {...props} />
    </>
  );
}
