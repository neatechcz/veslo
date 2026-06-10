import assert from "node:assert/strict";
import test from "node:test";

import { clearDenAuth, writeDenAuth, writeDenKeepSignedIn } from "../../lib/den-auth.js";
import {
  FEEDBACK_CAPTURE_SELECTOR,
  captureFeedbackSurface,
  submitFeedbackReport,
  type FeedbackCaptureResult,
  type FeedbackRuntimeContext,
} from "../../lib/feedback.js";

class MemoryStorage implements Storage {
  #map = new Map<string, string>();

  get length(): number {
    return this.#map.size;
  }

  clear(): void {
    this.#map.clear();
  }

  getItem(key: string): string | null {
    return this.#map.has(key) ? this.#map.get(key)! : null;
  }

  key(index: number): string | null {
    return Array.from(this.#map.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.#map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#map.set(key, String(value));
  }
}

function installDomStorage() {
  const localStorage = new MemoryStorage();
  const sessionStorage = new MemoryStorage();
  const previousWindow = globalThis.window;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage,
      sessionStorage,
    },
  });

  return {
    restore() {
      if (previousWindow === undefined) {
        Reflect.deleteProperty(globalThis, "window");
        return;
      }
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: previousWindow,
      });
    },
  };
}

const TEST_CONTEXT: FeedbackRuntimeContext = {
  view: "session",
  pathname: "/session/ses_123",
  tab: "scheduled",
  settingsTab: "settings",
  selectedSessionId: "ses_123",
  activeWorkspaceId: "workspace_local_1",
  vesloServerWorkspaceId: "veslo_workspace_1",
  activeWorkspaceType: "local",
  activeWorkspaceRoot: "/tmp/veslo/workspace",
  locale: "cs",
  appVersion: "2026.4.0",
  platform: "macOS",
};

function installAuthenticatedDenState() {
  writeDenKeepSignedIn(false);
  writeDenAuth({
    denApiBase: "https://den.example/base/",
    token: "den-token-123",
    orgId: "org_123",
    user: {
      id: "usr_123",
      name: "Vaclav Soukup",
      email: "vaclav@example.com",
    },
    org: {
      id: "org_123",
      name: "Veslo",
      slug: "veslo",
      role: "owner",
    },
  });
}

test("submitFeedbackReport posts authenticated feedback payload with captured screenshot and shell context", async () => {
  const dom = installDomStorage();
  const calls: Array<{ url: string; method: string; headers: Headers; body: Record<string, unknown> }> = [];

  installAuthenticatedDenState();

  try {
    const result = await submitFeedbackReport({
      title: "Sidebar stopped responding",
      description: "The left sidebar stopped reacting after switching sessions.",
      context: TEST_CONTEXT,
      captureSurface: async (): Promise<FeedbackCaptureResult> => ({
        status: "captured",
        dataUrl: "data:image/jpeg;base64,abc123",
        mimeType: "image/jpeg",
      }),
      fetchImpl: async (input, init) => {
        calls.push({
          url: String(input),
          method: init?.method ?? "GET",
          headers: new Headers(init?.headers as HeadersInit | undefined),
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        });

        return new Response(JSON.stringify({
          feedbackId: "fb_123",
          status: "projected",
          youtrackIssueId: "VSLO-4321",
          youtrackIssueUrl: "https://youtrack.example/issue/VSLO-4321",
        }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://den.example/base/v1/feedback");
    assert.equal(calls[0]?.method, "POST");
    assert.equal(calls[0]?.headers.get("authorization"), "Bearer den-token-123");
    assert.equal(calls[0]?.headers.get("x-veslo-org-id"), "org_123");

    assert.deepEqual(calls[0]?.body, {
      title: "Sidebar stopped responding",
      description: "The left sidebar stopped reacting after switching sessions.",
      userId: "usr_123",
      userEmail: "vaclav@example.com",
      orgId: "org_123",
      orgName: "Veslo",
      context: TEST_CONTEXT,
      screenshotStatus: "captured",
      screenshotDataUrl: "data:image/jpeg;base64,abc123",
      screenshotMimeType: "image/jpeg",
    });
    assert.deepEqual(result, {
      feedbackId: "fb_123",
      status: "projected",
      youtrackIssueId: "VSLO-4321",
      youtrackIssueUrl: "https://youtrack.example/issue/VSLO-4321",
    });
  } finally {
    clearDenAuth();
    dom.restore();
  }
});

test("submitFeedbackReport falls back to screenshotStatus=failed when surface capture throws", async () => {
  const dom = installDomStorage();
  const calls: Array<{ body: Record<string, unknown> }> = [];

  installAuthenticatedDenState();

  try {
    await submitFeedbackReport({
      title: "Composer froze",
      description: "The composer stayed stuck after I pressed enter.",
      context: TEST_CONTEXT,
      captureSurface: async () => {
        throw new Error("capture failed");
      },
      fetchImpl: async (_input, init) => {
        calls.push({
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        });

        return new Response(JSON.stringify({
          feedbackId: "fb_456",
          status: "projected",
          youtrackIssueId: "VSLO-456",
          youtrackIssueUrl: "https://youtrack.example/issue/VSLO-456",
        }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.body.screenshotStatus, "failed");
    assert.equal(calls[0]?.body.screenshotDataUrl, null);
    assert.equal(calls[0]?.body.screenshotMimeType, null);
  } finally {
    clearDenAuth();
    dom.restore();
  }
});

test("submitFeedbackReport translates missing feedback route on the Den host into an actionable error", async () => {
  const dom = installDomStorage();

  installAuthenticatedDenState();

  try {
    await assert.rejects(
      submitFeedbackReport({
        title: "Feedback route missing",
        description: "The configured Den host does not expose feedback persistence.",
        context: TEST_CONTEXT,
        captureSurface: async (): Promise<FeedbackCaptureResult> => ({
          status: "captured",
          dataUrl: "data:image/jpeg;base64,missing-route",
          mimeType: "image/jpeg",
        }),
        fetchImpl: async () =>
          new Response("<!DOCTYPE html><html><body><pre>Cannot POST /v1/feedback</pre></body></html>", {
            status: 404,
            headers: { "Content-Type": "text/html" },
          }),
      }),
      /feedback reporting is not enabled on this Den host yet/i,
    );
  } finally {
    clearDenAuth();
    dom.restore();
  }
});

test("submitFeedbackReport requires Den auth before attempting capture or POST", async () => {
  const dom = installDomStorage();
  let captureCalls = 0;
  let fetchCalls = 0;

  try {
    await assert.rejects(
      submitFeedbackReport({
        title: "No auth",
        description: "This should fail before submit.",
        context: TEST_CONTEXT,
        captureSurface: async () => {
          captureCalls += 1;
          return {
            status: "captured",
            dataUrl: "data:image/jpeg;base64,should-not-run",
            mimeType: "image/jpeg",
          };
        },
        fetchImpl: async () => {
          fetchCalls += 1;
          return new Response("{}");
        },
      }),
      /sign in to Den/i,
    );

    assert.equal(captureCalls, 0);
    assert.equal(fetchCalls, 0);
  } finally {
    clearDenAuth();
    dom.restore();
  }
});

test("captureFeedbackSurface captures the marked page shell root instead of the full app root", async () => {
  const calls: Array<{ selector: string; target: object }> = [];
  const root = { nodeName: "DIV" } as object as HTMLElement;

  const fakeDocument = {
    querySelector(selector: string) {
      calls.push({ selector, target: root });
      return root;
    },
  } as Pick<Document, "querySelector"> as Document;

  const result = await captureFeedbackSurface({
    document: fakeDocument,
    html2canvasImpl: async (element) => {
      assert.equal(element, root);
      return {
        toDataURL: (mimeType: string, quality?: number) => {
          assert.equal(mimeType, "image/jpeg");
          assert.equal(typeof quality, "number");
          return "data:image/jpeg;base64,capture";
        },
      } as HTMLCanvasElement;
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.selector, FEEDBACK_CAPTURE_SELECTOR);
  assert.deepEqual(result, {
    status: "captured",
    dataUrl: "data:image/jpeg;base64,capture",
    mimeType: "image/jpeg",
  });
});
