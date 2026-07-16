import { untrack } from "solid-js";

import { captureFatalRenderError } from "../lib/error-monitoring";

type RendererErrorFallbackProps = {
  error: unknown;
  restart: () => Promise<void> | void;
  reload: () => void;
};

type RendererRecoveryActionOptions = {
  restart: () => Promise<void> | void;
  reload: () => void;
};

export function createRendererRecoveryAction({
  restart,
  reload,
}: RendererRecoveryActionOptions): () => void {
  return () => {
    void Promise.resolve()
      .then(restart)
      .catch(() => {
        try {
          reload();
        } catch {
          // There is no safer in-app recovery action after a failed reload.
        }
      });
  };
}

export function RendererErrorFallback(props: RendererErrorFallbackProps) {
  // Solid ErrorBoundary fallbacks do not apply later signal updates reliably.
  // Capture once while this dedicated fallback is created so the support ID is
  // present in its initial DOM; this is intentionally not a reactive memo.
  const incidentId = untrack(() => captureFatalRenderError(props.error));

  return (
    <main
      class="min-h-screen bg-dls-bg text-dls-text flex items-center justify-center px-6"
      data-testid="renderer-error-recovery"
      role="alert"
    >
      <section class="max-w-md rounded-xl border border-dls-border bg-dls-panel p-6 shadow-lg">
        <h1 class="text-lg font-semibold">Veslo needs to restart</h1>
        <p class="mt-2 text-sm text-dls-secondary">
          The interface encountered an unexpected rendering error. Restarting reloads the application safely.
        </p>
        {incidentId ? (
          <p class="mt-3 text-xs text-dls-secondary" data-testid="renderer-error-incident-id">
            Incident ID: {incidentId}
          </p>
        ) : null}
        <button
          class="mt-5 rounded-md bg-dls-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dls-accent"
          data-testid="renderer-error-restart"
          onClick={() => {
            createRendererRecoveryAction({
              restart: props.restart,
              reload: props.reload,
            })();
          }}
          type="button"
        >
          Restart Veslo
        </button>
      </section>
    </main>
  );
}
