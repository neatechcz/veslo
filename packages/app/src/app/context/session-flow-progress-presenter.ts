type SessionFlowProgressOwner = "send" | "create" | "runtime";

type SessionFlowProgressStartEvent =
  | { type: "runtime.connecting"; owner?: SessionFlowProgressOwner }
  | { type: "runtime.recovering"; owner?: SessionFlowProgressOwner }
  | { type: "session.creating"; owner?: SessionFlowProgressOwner }
  | { type: "session.loading"; owner?: SessionFlowProgressOwner }
  | { type: "conversation.running"; owner?: SessionFlowProgressOwner };

export type SessionFlowProgressEvent =
  | SessionFlowProgressStartEvent
  | { type: "flow.idle"; owner?: SessionFlowProgressOwner };

export type SessionFlowProgressPresenter = {
  emit: (event: SessionFlowProgressEvent) => void;
};

export type SessionFlowProgressPresenterOptions = {
  now?: () => number;
  setBusy: (value: boolean) => void;
  setBusyLabel: (value: string | null) => void;
  setBusyStartedAt: (value: number | null) => void;
  setCreatingSession: (value: boolean) => void;
};

const labelByEventType = {
  "runtime.connecting": "status.connecting",
  "runtime.recovering": "status.connecting",
  "session.creating": "status.creating_task",
  "session.loading": "status.loading_session",
  "conversation.running": "status.running",
} satisfies Record<Exclude<SessionFlowProgressEvent["type"], "flow.idle">, string>;

export function createSessionFlowProgressPresenter(
  options: SessionFlowProgressPresenterOptions,
): SessionFlowProgressPresenter {
  const now = options.now ?? (() => Date.now());
  const activeByOwner = new Map<string, { label: string; creatingSession: boolean; sequence: number }>();
  let sequence = 0;
  let activeStartedAt: number | null = null;

  const renderActive = (startedNow: boolean) => {
    const entries = Array.from(activeByOwner.values());
    const current = entries.reduce((latest, entry) =>
      entry.sequence > latest.sequence ? entry : latest,
    );
    options.setBusy(true);
    options.setBusyLabel(current.label);
    if (startedNow) {
      options.setBusyStartedAt(activeStartedAt);
    }
    options.setCreatingSession(entries.some((entry) => entry.creatingSession));
  };

  const start = (event: SessionFlowProgressStartEvent) => {
    const startedNow = activeByOwner.size === 0;
    if (startedNow) {
      activeStartedAt = now();
    }
    activeByOwner.set(event.owner ?? "flow", {
      label: labelByEventType[event.type],
      creatingSession: event.type === "session.creating" || event.type === "session.loading",
      sequence: sequence += 1,
    });
    renderActive(startedNow);
  };

  const idle = () => {
    activeByOwner.clear();
    activeStartedAt = null;
    options.setCreatingSession(false);
    options.setBusy(false);
    options.setBusyLabel(null);
    options.setBusyStartedAt(null);
  };

  return {
    emit(event) {
      if (event.type === "flow.idle") {
        if (event.owner && activeByOwner.size > 0) {
          activeByOwner.delete(event.owner);
          if (activeByOwner.size > 0) {
            renderActive(false);
            return;
          }
        }
        idle();
        return;
      }
      start(event);
    },
  };
}
