import { expect } from "@wdio/globals";

import { navigateToHash } from "../helpers/app-launcher.js";
import { startFeedbackServer } from "../helpers/feedback-server.js";

type FeedbackAuth = {
  denApiBase: string;
  token: string;
  orgId: string;
  user: { id: string; email: string; name: string };
  org: { id: string; name: string; slug: string; role: string };
};

type CapturedDenAuthState = {
  localAuth: string | null;
  localKeepSignedIn: string | null;
  sessionAuth: string | null;
};

function buildAuth(baseUrl: string): FeedbackAuth {
  return {
    denApiBase: baseUrl,
    token: "e2e-feedback-token",
    orgId: "org-e2e-feedback",
    user: {
      id: "user-e2e-feedback",
      email: "feedback@example.com",
      name: "Feedback Tester",
    },
    org: {
      id: "org-e2e-feedback",
      name: "E2E Feedback Org",
      slug: "e2e-feedback-org",
      role: "admin",
    },
  };
}

async function seedDenAuth(baseUrl: string): Promise<void> {
  const auth = buildAuth(baseUrl);
  await browser.execute((value) => {
    localStorage.setItem("veslo.den.auth", JSON.stringify(value));
  }, auth);
}

async function captureDenAuthState(): Promise<CapturedDenAuthState> {
  return browser.execute(() => ({
    localAuth: localStorage.getItem("veslo.den.auth"),
    localKeepSignedIn: localStorage.getItem("veslo.den.keepSignedIn"),
    sessionAuth: sessionStorage.getItem("veslo.den.auth"),
  }));
}

async function restoreDenAuthState(state: CapturedDenAuthState | null): Promise<void> {
  if (!state) return;
  await browser.execute((value) => {
    if (value.localAuth === null) {
      localStorage.removeItem("veslo.den.auth");
    } else {
      localStorage.setItem("veslo.den.auth", value.localAuth);
    }

    if (value.localKeepSignedIn === null) {
      localStorage.removeItem("veslo.den.keepSignedIn");
    } else {
      localStorage.setItem("veslo.den.keepSignedIn", value.localKeepSignedIn);
    }

    if (value.sessionAuth === null) {
      sessionStorage.removeItem("veslo.den.auth");
    } else {
      sessionStorage.setItem("veslo.den.auth", value.sessionAuth);
    }
  }, state);
}

async function waitForFeedbackModal(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const title = await $('//*[@role="dialog"]//*[normalize-space()="Report a bug"]');
      return await title.isExisting();
    },
    {
      timeout: 10_000,
      interval: 100,
      timeoutMsg: "Feedback modal did not open",
    },
  );
}

async function openFeedbackModal(): Promise<void> {
  const feedbackButton = await $('//button[normalize-space()="Feedback" or @aria-label="Feedback" or @data-tooltip="Feedback"]');
  await feedbackButton.waitForExist({ timeout: 10_000 });
  await browser.execute((element) => {
    (element as HTMLElement).click();
  }, feedbackButton);
  await waitForFeedbackModal();
}

async function fillFeedbackForm(title: string, description: string): Promise<void> {
  const titleInput = await $('//label[normalize-space()="Title"]/following::input[1]');
  const descriptionInput = await $('//label[normalize-space()="Description"]/following::textarea[1]');

  await titleInput.waitForEnabled({ timeout: 10_000 });
  await descriptionInput.waitForEnabled({ timeout: 10_000 });

  await titleInput.setValue(title);
  await descriptionInput.setValue(description);
}

async function submitFeedback(): Promise<void> {
  const submitButton = await $('//button[normalize-space()="Send bug report"]');
  await submitButton.waitForClickable({ timeout: 10_000 });
  await submitButton.click();
}

async function expectFeedbackSubmission({
  server,
  viewRoute,
  expectedView,
  title,
  description,
}: {
  server: Awaited<ReturnType<typeof startFeedbackServer>>;
  viewRoute: string;
  expectedView: string;
  title: string;
  description: string;
}): Promise<void> {
  await navigateToHash(viewRoute);
  await seedDenAuth(server.baseUrl);
  await browser.refresh();
  await browser.waitUntil(
    async () => (await browser.getUrl()).includes(`#${viewRoute}`),
    { timeout: 5_000, timeoutMsg: `Route ${viewRoute} did not load` },
  );

  await openFeedbackModal();
  await fillFeedbackForm(title, description);
  await submitFeedback();

  await server.waitForRequests(server.requests.length + 1);
  const request = server.requests.at(-1);
  expect(request).toBeDefined();
  expect(request?.headers["content-type"]).toContain("application/json");
  expect(request?.headers.authorization).toBe("Bearer e2e-feedback-token");
  expect(request?.headers["x-veslo-org-id"]).toBe("org-e2e-feedback");

  const body = request?.body as Record<string, unknown>;
  expect(body.title).toBe(title);
  expect(body.description).toBe(description);
  expect(body.view).toBe(expectedView);

  await browser.waitUntil(
    async () => {
      const modalTitle = await $('//*[@role="dialog"]//*[normalize-space()="Report a bug"]');
      return !(await modalTitle.isExisting());
    },
    {
      timeout: 10_000,
      interval: 100,
      timeoutMsg: "Feedback modal did not close after submit",
    },
  );
}

describe("Feedback bug report flow", () => {
  let server: Awaited<ReturnType<typeof startFeedbackServer>> | undefined;
  let originalDenAuthState: CapturedDenAuthState | null = null;

  before(async () => {
    server = await startFeedbackServer();
    originalDenAuthState = await captureDenAuthState();
  });

  after(async () => {
    await restoreDenAuthState(originalDenAuthState);
    await server?.close();
  });

  it("submits from the dashboard and session views", async () => {
    const dashboardTitle = `Dashboard bug ${Date.now()}`;
    const sessionTitle = `Session bug ${Date.now() + 1}`;
    expect(server).toBeDefined();
    if (!server) return;

    await expectFeedbackSubmission({
      server,
      viewRoute: "/dashboard",
      expectedView: "dashboard",
      title: dashboardTitle,
      description: "Dashboard feedback from the E2E spec.",
    });

    await expectFeedbackSubmission({
      server,
      viewRoute: "/session",
      expectedView: "session",
      title: sessionTitle,
      description: "Session feedback from the E2E spec.",
    });

    expect(server.requests).toHaveLength(2);
  });
});
