import assert from "node:assert/strict";
import test from "node:test";

import { createComputed, createRoot, createSignal } from "solid-js";

import { createAppRouteSync } from "../../context/app-route-sync.js";
import type { OnboardingStep } from "../../types.js";

function solidRuntimeSupportsEffects(): boolean {
  let observed = 0;
  createRoot((dispose) => {
    const [value, setValue] = createSignal(0);
    createComputed(() => { observed = value(); });
    setValue(1);
    dispose();
  });
  return observed === 1;
}

const behaviorTestOptions = solidRuntimeSupportsEffects()
  ? {}
  : { skip: "Solid's Node server condition does not run effects; use the test:reactivity script." };

async function flushEffects(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("route lifecycle reacts to startup paths and removes its hash listener on disposal", behaviorTestOptions, async () => {
  const [pathname, setPathname] = createSignal("/session/sess-a");
  const [onboardingStep] = createSignal<OnboardingStep>("welcome");
  const sessionRoutes: string[] = [];
  const navigations: string[] = [];
  const listeners = new Set<() => void>();
  const windowTarget = {
    location: { hash: "#/dashboard/settings" },
    addEventListener: (_type: "hashchange", listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: "hashchange", listener: () => void) => listeners.delete(listener),
  };
  let dispose: () => void = () => {};

  createRoot((rootDispose) => {
    dispose = rootDispose;
    const routeSync = createAppRouteSync({
      pathname,
      navigate: (to) => navigations.push(to),
      isTauriRuntime: () => true,
      creatingSession: () => false,
    });
    routeSync.startStartupRouteSync({
      onboardingStep,
      activeSessionId: () => null,
      onSessionRoute: ({ rawPath }) => sessionRoutes.push(rawPath),
    });
    routeSync.startHashRouteSync(windowTarget);
  });

  try {
    await flushEffects();
    assert.deepEqual(sessionRoutes, ["/session/sess-a"]);
    assert.equal(listeners.size, 1);

    setPathname("/session/sess-b");
    await flushEffects();
    assert.deepEqual(sessionRoutes, ["/session/sess-a", "/session/sess-b"]);

    for (const listener of listeners) listener();
    assert.deepEqual(navigations, ["/dashboard/settings"]);
  } finally {
    dispose();
  }

  setPathname("/session/sess-c");
  await flushEffects();
  assert.deepEqual(sessionRoutes, ["/session/sess-a", "/session/sess-b"]);
  assert.equal(listeners.size, 0, "disposed route lifecycle must remove its hash listener");
});
