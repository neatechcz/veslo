import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { expect } from "@wdio/globals";

import { navigateToHash } from "../helpers/app-launcher.js";

type FeedbackRequest = {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
};

function waitForRoute(hashFragment: string, timeout = 10_000): Promise<void> {
  return browser.waitUntil(async () => (await browser.getUrl()).includes(hashFragment), {
    timeout,
    timeoutMsg: `Route did not change to ${hashFragment} within ${timeout}ms`,
  });
}

function createFeedbackStubServer() {
  const requests: FeedbackRequest[] = [];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let rawBody = "";

    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      rawBody += chunk;
    });
    req.on("end", () => {
      const body = rawBody.trim() ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body,
      });

      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ feedbackId: `fb_${requests.length}` }));
    });
  });

  return {
    requests,
    async start() {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Feedback stub server did not bind to an IPv4 port.");
      }
      return `http://127.0.0.1:${address.port}`;
    },
    async stop() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
    reset() {
      requests.length = 0;
    },
  };
}

async function seedDenAuth(denApiBase: string) {
  await browser.execute((baseUrl: string) => {
    const auth = {
      denApiBase: baseUrl,
      token: "den-token-e2e",
      orgId: "org-e2e",
      user: {
        id: "user-e2e",
        email: "feedback@example.com",
        name: "Feedback Tester",
      },
      org: {
        id: "org-e2e",
        name: "E2E Org",
        slug: "e2e-org",
        role: "owner",
      },
    };

    window.localStorage.setItem("veslo.den.auth", JSON.stringify(auth));
    window.localStorage.setItem("veslo.den.keepSignedIn", "1");
  }, denApiBase);
}

async function openFeedbackModal() {
  const feedbackButton = await $('//button[normalize-space()="Feedback" or @aria-label="Feedback" or @title="Feedback"]');
  await feedbackButton.waitForDisplayed({ timeout: 10_000 });
  await feedbackButton.click();

  const dialog = await $('[role="dialog"]');
  await dialog.waitForDisplayed({ timeout: 10_000 });
  return dialog;
}

async function submitFeedback(title: string, description: string) {
  const dialog = await openFeedbackModal();
  const titleInput = await dialog.$("input");
  const descriptionInput = await dialog.$("textarea");
  const submitButton = await dialog.$('//button[normalize-space()="Odeslat hlášení" or normalize-space()="Send bug report"]');

  await titleInput.waitForDisplayed({ timeout: 10_000 });
  await descriptionInput.waitForDisplayed({ timeout: 10_000 });

  await titleInput.setValue(title);
  await descriptionInput.setValue(description);
  await submitButton.waitForEnabled({ timeout: 10_000 });
  await submitButton.click();

  await dialog.waitForDisplayed({ timeout: 10_000, reverse: true });
}

function feedbackPosts(requests: FeedbackRequest[]) {
  return requests.filter((request) => request.method === "POST" && request.url === "/v1/feedback");
}

async function waitForExactFeedbackPostCount(requests: FeedbackRequest[], count: number) {
  let stableSince: number | null = null;

  await browser.waitUntil(() => {
    const postCount = feedbackPosts(requests).length;
    if (postCount !== count) {
      stableSince = null;
      return false;
    }

    if (stableSince == null) {
      stableSince = Date.now();
      return false;
    }

    return Date.now() - stableSince >= 400;
  }, {
    timeout: 15_000,
    interval: 100,
    timeoutMsg: `Expected exactly ${count} feedback POST(s), saw ${feedbackPosts(requests).length}.`,
  });

  const posts = feedbackPosts(requests);
  expect(posts.length).toBe(count);
  return posts;
}

function expectCommonPayload(
  request: FeedbackRequest,
  expected: {
    title: string;
    description: string;
    view: string;
    pathname: string;
  },
) {
  expect(request.method).toBe("POST");
  expect(request.url).toBe("/v1/feedback");
  expect(request.headers.authorization).toBe("Bearer den-token-e2e");
  expect(request.headers["x-veslo-org-id"]).toBe("org-e2e");

  expect(request.body.title).toBe(expected.title);
  expect(request.body.description).toBe(expected.description);
  expect(request.body.userId).toBe("user-e2e");
  expect(request.body.userEmail).toBe("feedback@example.com");
  expect(request.body.orgId).toBe("org-e2e");
  expect(request.body.orgName).toBe("E2E Org");

  const context = request.body.context as Record<string, unknown>;
  expect(context.view).toBe(expected.view);
  expect(context.pathname).toBe(expected.pathname);

  const screenshotStatus = request.body.screenshotStatus;
  expect(["captured", "failed"]).toContain(String(screenshotStatus));
  if (screenshotStatus === "captured") {
    expect(String(request.body.screenshotMimeType)).toBe("image/jpeg");
    expect(String(request.body.screenshotDataUrl)).toContain("data:image/jpeg");
  }
}

describe("Global feedback bug reporting", () => {
  const feedbackStub = createFeedbackStubServer();
  let denApiBase = "";

  before(async () => {
    denApiBase = await feedbackStub.start();
  });

  after(async () => {
    await feedbackStub.stop();
  });

  beforeEach(async () => {
    feedbackStub.reset();
    await seedDenAuth(denApiBase);
  });

  it("submits bug feedback from the dashboard view", async () => {
    await navigateToHash("/dashboard/settings");
    await waitForRoute("#/dashboard/settings");

    await submitFeedback("Dashboard feedback", "Dashboard bug reproduction steps.");
    const posts = await waitForExactFeedbackPostCount(feedbackStub.requests, 1);

    expectCommonPayload(posts[0]!, {
      title: "Dashboard feedback",
      description: "Dashboard bug reproduction steps.",
      view: "dashboard",
      pathname: "/dashboard/settings",
    });
  });

  it("submits bug feedback from the session view", async () => {
    await navigateToHash("/session");
    await waitForRoute("#/session");

    await submitFeedback("Session feedback", "Session bug reproduction steps.");
    const posts = await waitForExactFeedbackPostCount(feedbackStub.requests, 1);

    expectCommonPayload(posts[0]!, {
      title: "Session feedback",
      description: "Session bug reproduction steps.",
      view: "session",
      pathname: "/session",
    });
  });
});
