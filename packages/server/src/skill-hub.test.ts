import { afterEach, expect, test } from "bun:test";
import { listHubSkills } from "./skill-hub.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("listHubSkills uses openwork hub repo by default", async () => {
  const calls: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    void init;
    const url = String(input);
    calls.push(url);
    return new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const items = await listHubSkills();

  expect(items).toEqual([]);
  expect(calls[0]).toContain("api.github.com/repos/different-ai/openwork-hub/contents/skills?ref=main");
});
