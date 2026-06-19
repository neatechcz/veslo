import { afterEach, expect, test } from "bun:test";
import { listHubSkills } from "../skill-hub.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("listHubSkills uses the default openwork hub repo and caches catalogs per repo", async () => {
  const calls: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    void init;
    const url = String(input);
    calls.push(url);
    if (url.includes("/repos/example/custom-hub/contents/skills")) {
      return Response.json([{ type: "dir", name: "hub-skill" }]);
    }
    if (url.includes("raw.githubusercontent.com/example/custom-hub/main/skills/hub-skill/SKILL.md")) {
      return new Response(
        [
          "---",
          "name: hub-skill",
          "description: Custom hub skill",
          "when: Use for custom hub catalog checks.",
          "---",
          "",
          "# Hub skill",
          "",
        ].join("\n"),
        {
          status: 200,
          headers: { "content-type": "text/markdown" },
        },
      );
    }
    return new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const items = await listHubSkills();
  const customItems = await listHubSkills({ owner: "example", repo: "custom-hub", ref: "main" });
  const cachedItems = await listHubSkills();
  const cachedCustomItems = await listHubSkills({ owner: "example", repo: "custom-hub", ref: "main" });

  expect(items).toEqual([]);
  expect(cachedItems).toEqual([]);
  expect(customItems).toEqual([
    {
      name: "hub-skill",
      description: "Custom hub skill",
      trigger: "Use for custom hub catalog checks.",
      source: {
        owner: "example",
        repo: "custom-hub",
        ref: "main",
        path: "skills/hub-skill",
      },
    },
  ]);
  expect(cachedCustomItems).toEqual(customItems);
  expect(calls[0]).toContain("api.github.com/repos/different-ai/openwork-hub/contents/skills?ref=main");
  expect(
    calls.filter((url) => url.includes("api.github.com/repos/different-ai/openwork-hub/contents/skills?ref=main")),
  ).toHaveLength(1);
  expect(
    calls.filter((url) => url.includes("api.github.com/repos/example/custom-hub/contents/skills?ref=main")),
  ).toHaveLength(1);
  expect(
    calls.filter((url) => url.includes("raw.githubusercontent.com/example/custom-hub/main/skills/hub-skill/SKILL.md")),
  ).toHaveLength(1);
});
