type ShutdownLogger = {
  info?: (
    message: string,
    attributes?: Record<string, unknown>,
    component?: string,
  ) => void;
  debug?: (
    message: string,
    attributes?: Record<string, unknown>,
    component?: string,
  ) => void;
  warn?: (
    message: string,
    attributes?: Record<string, unknown>,
    component?: string,
  ) => void;
};

type CloseableServer = {
  close: (callback?: (error?: Error) => void) => unknown;
};

type ShutdownStopReport = {
  outcome: "exit_observed" | "exit_unconfirmed";
  childKind?: "direct" | "wsl";
  engineOwnerId?: string;
};

type ShutdownEnginePool = {
  killAll: () => Promise<ShutdownStopReport[]>;
};

type ShutdownSharedEngine = {
  dispose: () => Promise<ShutdownStopReport | null> | ShutdownStopReport | null;
};

export type ShutdownAttribution = {
  reason: string;
  caller: string;
};

export type OrchestratorShutdownOptions = {
  server: CloseableServer;
  pool: ShutdownEnginePool;
  sharedOpenCodeEngine?: ShutdownSharedEngine | null;
  clearSharedEngineLivenessTimer?: () => void;
  persistShutdownState: () => Promise<void>;
  exitProcess?: (code: number) => never | void;
  logger?: ShutdownLogger;
  context?: Record<string, unknown>;
  closeServerTimeoutMs?: number;
};

const DEFAULT_CLOSE_SERVER_TIMEOUT_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref?.();
    }
  });
}

function beginServerClose(
  server: CloseableServer,
  logger?: ShutdownLogger,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) {
        logger?.warn?.(
          "Daemon server close reported an error",
          { error: error.message },
          "veslo-orchestrator-router",
        );
      }
      resolve();
    };

    try {
      server.close(finish);
    } catch (error) {
      logger?.warn?.(
        "Daemon server close failed",
        { error: error instanceof Error ? error.message : String(error) },
        "veslo-orchestrator-router",
      );
      finish();
    }
  });
}

async function waitForServerClose(
  closePromise: Promise<void>,
  timeoutMs: number,
  logger?: ShutdownLogger,
): Promise<void> {
  if (timeoutMs <= 0) {
    logger?.debug?.(
      "Daemon shutdown skipped server close wait",
      { timeoutMs },
      "veslo-orchestrator-router",
    );
    return;
  }
  const timedOut = await Promise.race([
    closePromise.then(() => false),
    sleep(timeoutMs).then(() => true),
  ]);
  if (timedOut) {
    logger?.warn?.(
      "Daemon server close timed out after engine shutdown",
      { timeoutMs },
      "veslo-orchestrator-router",
    );
  } else {
    logger?.debug?.(
      "Daemon server closed",
      {},
      "veslo-orchestrator-router",
    );
  }
}

export function createOrchestratorShutdown(
  options: OrchestratorShutdownOptions,
): (attribution?: ShutdownAttribution) => Promise<void> {
  let shutdownPromise: Promise<void> | null = null;

  return (attribution?: ShutdownAttribution) => {
    if (!shutdownPromise) {
      shutdownPromise = runOrchestratorShutdown(options, attribution);
    }
    return shutdownPromise;
  };
}

async function runOrchestratorShutdown(
  options: OrchestratorShutdownOptions,
  attribution?: ShutdownAttribution,
): Promise<void> {
  const context = {
    ...(options.context ?? {}),
    ...(attribution ?? {}),
  };
  const cleanupErrors: string[] = [];
  const persistShutdownState = async (stage: string): Promise<void> => {
    try {
      await options.persistShutdownState();
    } catch (error) {
      cleanupErrors.push(
        `${stage}:persistShutdownState:${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  options.logger?.info?.(
    "Daemon shutting down",
    context,
    "veslo-orchestrator-router",
  );

  const serverClosed = beginServerClose(options.server, options.logger);
  options.clearSharedEngineLivenessTimer?.();
  await persistShutdownState("pre-cleanup");

  options.logger?.debug?.(
    "Daemon shutdown stopping engines",
    {},
    "veslo-orchestrator-router",
  );
  try {
    const reports = await options.pool.killAll();
    for (const report of reports) {
      if (report.outcome === "exit_unconfirmed") {
        cleanupErrors.push(`pool.killAll:exit_unconfirmed:${report.engineOwnerId ?? "unknown"}`);
      }
    }
  } catch (error) {
    cleanupErrors.push(`pool.killAll:${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const report = await options.sharedOpenCodeEngine?.dispose();
    if (report?.outcome === "exit_unconfirmed") {
      cleanupErrors.push(`sharedOpenCodeEngine.dispose:exit_unconfirmed:${report.engineOwnerId ?? "unknown"}`);
    }
  } catch (error) {
    cleanupErrors.push(`sharedOpenCodeEngine.dispose:${error instanceof Error ? error.message : String(error)}`);
  }
  options.logger?.debug?.(
    "Daemon shutdown engines stopped",
    {},
    "veslo-orchestrator-router",
  );

  await waitForServerClose(
    serverClosed,
    options.closeServerTimeoutMs ?? DEFAULT_CLOSE_SERVER_TIMEOUT_MS,
    options.logger,
  );

  options.logger?.debug?.(
    "Daemon shutdown persisting state",
    {},
    "veslo-orchestrator-router",
  );
  await persistShutdownState("post-cleanup");
  if (cleanupErrors.length > 0) {
    options.logger?.warn?.(
      "Daemon shutdown cleanup had errors",
      { ...context, errors: cleanupErrors },
      "veslo-orchestrator-router",
    );
  }
  options.logger?.debug?.(
    "Daemon shutdown exiting",
    {},
    "veslo-orchestrator-router",
  );
  (options.exitProcess ?? process.exit)(0);
}
