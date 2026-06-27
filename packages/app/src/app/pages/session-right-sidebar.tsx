import { Show, type ComponentProps } from "solid-js";

import SidebarAdvancedNav from "../components/session/sidebar-advanced-nav";
import ArtifactsPanel from "../components/session/artifacts-panel";
import SessionCapabilitiesPanel from "../components/session/session-capabilities-panel";

export type SessionRightSidebarProps = {
  dockedVisible: boolean;
  overlayOpen: boolean;
  developerMode: boolean;
  advancedNavProps: ComponentProps<typeof SidebarAdvancedNav>;
  artifactsPanelProps: ComponentProps<typeof ArtifactsPanel>;
  sessionCapabilitiesPanelProps: ComponentProps<typeof SessionCapabilitiesPanel>;
  onCloseOverlay: () => void;
};

export function rightSidebarOverlayClass() {
  return "fixed inset-y-0 right-0 z-[45] flex w-[min(280px,calc(100vw-32px))] max-w-[280px] flex-col bg-dls-sidebar border-l border-gray-6/80 p-3 pt-12 shadow-xl shadow-gray-12/20";
}

function RightSidebarOverlayBackdrop(props: { onClose: () => void }) {
  return (
    <div
      class="fixed inset-0 z-40 bg-gray-12/20 backdrop-blur-[1px]"
      onClick={() => props.onClose()}
    />
  );
}

function RightSidebarContent(props: {
  developerMode: boolean;
  advancedNavProps: ComponentProps<typeof SidebarAdvancedNav>;
  artifactsPanelProps: ComponentProps<typeof ArtifactsPanel>;
  sessionCapabilitiesPanelProps: ComponentProps<typeof SessionCapabilitiesPanel>;
}) {
  return (
    <div class="flex-1 overflow-y-auto space-y-5 pt-2">
      <Show when={props.developerMode}>
        <div class="space-y-1 mb-2">
          <SidebarAdvancedNav {...props.advancedNavProps} />
        </div>
      </Show>

      <ArtifactsPanel {...props.artifactsPanelProps} />
      <SessionCapabilitiesPanel {...props.sessionCapabilitiesPanelProps} />
    </div>
  );
}

function RightDockedSidebar(props: SessionRightSidebarProps) {
  return (
    <Show when={props.dockedVisible}>
      <aside class="w-[280px] flex shrink-0 flex-col bg-dls-sidebar border-l border-gray-6/70 p-3 pt-12">
        <RightSidebarContent
          developerMode={props.developerMode}
          advancedNavProps={props.advancedNavProps}
          artifactsPanelProps={props.artifactsPanelProps}
          sessionCapabilitiesPanelProps={props.sessionCapabilitiesPanelProps}
        />
      </aside>
    </Show>
  );
}

function RightOverlaySidebar(props: SessionRightSidebarProps) {
  return (
    <Show when={props.overlayOpen}>
      <RightSidebarOverlayBackdrop onClose={props.onCloseOverlay} />
      <aside
        class={rightSidebarOverlayClass()}
        onClick={(event) => event.stopPropagation()}
      >
        <RightSidebarContent
          developerMode={props.developerMode}
          advancedNavProps={props.advancedNavProps}
          artifactsPanelProps={props.artifactsPanelProps}
          sessionCapabilitiesPanelProps={props.sessionCapabilitiesPanelProps}
        />
      </aside>
    </Show>
  );
}

export default function SessionRightSidebar(props: SessionRightSidebarProps) {
  return (
    <>
      <RightDockedSidebar {...props} />
      <RightOverlaySidebar {...props} />
    </>
  );
}
