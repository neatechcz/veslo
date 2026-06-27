import type { JSX } from "solid-js";

export type SessionCenterProps = {
  searchBanner: JSX.Element;
  reloadBanner: JSX.Element;
  transcript: JSX.Element;
  todoPanel: JSX.Element;
  composerArea: JSX.Element;
  conflictModal: JSX.Element;
};

type SessionCenterSlotProps = {
  children: JSX.Element;
};

function SessionCenterRoot(props: SessionCenterSlotProps) {
  return (
    <main class="flex-1 flex flex-col overflow-hidden bg-gray-1 pt-12">
      {props.children}
    </main>
  );
}

function SessionCenterTopChrome(props: {
  searchBanner: JSX.Element;
  reloadBanner: JSX.Element;
}) {
  return (
    <>
      {props.searchBanner}
      {props.reloadBanner}
    </>
  );
}

function SessionCenterTranscriptRegion(props: SessionCenterSlotProps) {
  return <>{props.children}</>;
}

function SessionCenterBottomStack(props: {
  todoPanel: JSX.Element;
  composerArea: JSX.Element;
}) {
  return (
    <>
      {props.todoPanel}
      {props.composerArea}
    </>
  );
}

function SessionCenterModalLayer(props: {
  conflictModal: JSX.Element;
}) {
  return <>{props.conflictModal}</>;
}

export function createSessionCenterSlots(props: SessionCenterProps) {
  return {
    topChrome: (
      <SessionCenterTopChrome
        searchBanner={props.searchBanner}
        reloadBanner={props.reloadBanner}
      />
    ),
    transcriptRegion: (
      <SessionCenterTranscriptRegion>
        {props.transcript}
      </SessionCenterTranscriptRegion>
    ),
    bottomStack: (
      <SessionCenterBottomStack
        todoPanel={props.todoPanel}
        composerArea={props.composerArea}
      />
    ),
    modalLayer: (
      <SessionCenterModalLayer
        conflictModal={props.conflictModal}
      />
    ),
  };
}

export default function SessionCenter(props: SessionCenterProps) {
  const slots = createSessionCenterSlots(props);

  return (
    <SessionCenterRoot>
      {slots.topChrome}
      {slots.transcriptRegion}
      {slots.bottomStack}
      {slots.modalLayer}
    </SessionCenterRoot>
  );
}
