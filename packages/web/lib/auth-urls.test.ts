import assert from "node:assert/strict";
import test from "node:test";

test("buildAuthCallbackUrl preserves full desktop onboarding query context", async () => {
  const moduleUrl = new URL("./auth-urls.ts", import.meta.url);
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        search: "?desktopOnboarding=1&tid=dat_123&state=state_abc",
      },
    },
  });

  try {
    const { buildAuthCallbackUrl } = await import(moduleUrl.href);
    const url = new URL(buildAuthCallbackUrl("/verify-email"));
    assert.equal(url.pathname, "/verify-email");
    assert.equal(url.searchParams.get("desktopOnboarding"), "1");
    assert.equal(url.searchParams.get("tid"), "dat_123");
    assert.equal(url.searchParams.get("state"), "state_abc");
  } finally {
    if (previousWindow === undefined) {
      Reflect.deleteProperty(globalThis, "window");
    } else {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: previousWindow,
      });
    }
  }
});
