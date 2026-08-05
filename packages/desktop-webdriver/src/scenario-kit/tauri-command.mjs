export async function invokeTauriCommand(browser, command, args = {}) {
  const result = await browser.executeAsync((requestedCommand, requestedArgs, done) => {
    const invoke = window.__TAURI_INTERNALS__?.invoke ?? window.__TAURI__?.core?.invoke;
    if (typeof invoke !== "function") {
      done({ ok: false, error: "tauri_invoke_unavailable" });
      return;
    }
    Promise.resolve(invoke(requestedCommand, requestedArgs)).then(
      (value) => done({ ok: true, value }),
      (error) => done({ ok: false, error: String(error) }),
    );
  }, command, args);
  if (!result?.ok) throw new Error(`Tauri command ${command} failed: ${result?.error ?? "unknown error"}`);
  return result.value;
}

export async function restartVesloServerWorker(browser) {
  const before = await invokeTauriCommand(browser, "veslo_server_info");
  const stopped = await invokeTauriCommand(browser, "veslo_server_e2e_kill_child");
  if (stopped?.running !== false || stopped?.lifecycleStatus !== "exited") {
    throw new Error("Test-only server worker control did not stop the managed child.");
  }
  const restarted = await invokeTauriCommand(browser, "veslo_server_restart");
  const previousGeneration = String(before?.instanceId ?? "").trim();
  const nextGeneration = String(restarted?.instanceId ?? "").trim();
  if (!previousGeneration || !nextGeneration || previousGeneration === nextGeneration) {
    throw new Error("Server worker restart did not publish a distinct worker generation.");
  }
  return { before, stopped, restarted, previousGeneration, nextGeneration };
}
