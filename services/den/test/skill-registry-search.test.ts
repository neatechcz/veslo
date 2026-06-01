import assert from "node:assert/strict"
import { once } from "node:events"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"

import { errorMiddleware } from "../src/http/errors.js"
import { buildSkillRegistryPackageArchive } from "../src/skills/packages.js"
import { InMemorySkillRegistryStore } from "../src/skills/store.js"

type TestSession = {
  userId: string
  orgId?: string | null
  orgRole?: "member" | "owner" | null
  isPlatformAdmin?: boolean
}

async function startServer() {
  process.env.DATABASE_URL ??= "mysql://root:root@localhost:3306/veslo_test"
  process.env.BETTER_AUTH_SECRET ??= "0123456789abcdef0123456789abcdef"
  process.env.BETTER_AUTH_URL ??= "http://localhost:8788"

  const { createSkillRegistryRouter } = await import("../src/skills/routes.js")
  const app = express()
  app.use(express.json({ limit: "2mb" }))
  app.use(
    "/v1",
    createSkillRegistryRouter({
      store: new InMemorySkillRegistryStore(),
      resolveContext: async (req, res) => {
        const userId = req.header("x-test-user-id")
        if (!userId) {
          res.status(401).json({ error: "unauthorized" })
          return null
        }
        return {
          userId,
          orgId: req.header("x-test-org-id") ?? null,
          orgRole: req.header("x-test-org-role") === "owner" ? "owner" : "member",
          isPlatformAdmin: req.header("x-test-platform-admin") === "1",
        }
      },
    }),
  )
  app.use(errorMiddleware)

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")
  const { port } = server.address() as AddressInfo

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => {
      server.close()
      await once(server, "close")
    },
  }
}

async function jsonRequest(baseUrl: string, path: string, init: RequestInit & { session?: TestSession } = {}) {
  const headers = new Headers(init.headers)
  headers.set("content-type", "application/json")
  headers.set("x-test-user-id", init.session?.userId ?? "user_1")
  if (init.session?.orgId) headers.set("x-test-org-id", init.session.orgId)
  if (init.session?.orgRole) headers.set("x-test-org-role", init.session.orgRole)
  if (init.session?.isPlatformAdmin) headers.set("x-test-platform-admin", "1")

  const response = await fetch(`${baseUrl}${path}`, { ...init, headers })
  const body = await response.json().catch(() => null)
  return { response, body }
}

function packageArchive(name: string) {
  return buildSkillRegistryPackageArchive({
    metadata: {
      name,
      description: "Creates meeting minutes from client call notes.",
      trigger: "Use when preparing meeting minutes, action items, and follow-up summaries.",
      tags: ["meetings", "minutes"],
      language: "en",
    },
    files: [
      {
        path: "SKILL.md",
        bytes: Buffer.from(
          [
            "---",
            `name: ${name}`,
            "description: Meeting minutes generator",
            "---",
            "",
            "# Meeting minutes",
            "",
            "Use this skill to turn meeting notes into a structured client-ready summary.",
            "",
          ].join("\n"),
          "utf8",
        ),
        mediaType: "text/markdown",
        executable: false,
      },
    ],
  })
}

test("Czech query expansion finds an English meeting-minutes skill", async () => {
  const server = await startServer()
  try {
    const { body: createdSkill } = await jsonRequest(server.baseUrl, "/skills", {
      method: "POST",
      body: JSON.stringify({
        scope: "user",
        name: "meeting-minutes",
        description: "Creates meeting minutes from notes",
      }),
    })
    await jsonRequest(server.baseUrl, `/skills/${createdSkill.skill.id}/versions`, {
      method: "POST",
      body: JSON.stringify({ package: packageArchive("meeting-minutes") }),
    })

    const { response, body } = await jsonRequest(
      server.baseUrl,
      "/skills/search?q=zapis%20ze%20schuzky&language=cs",
    )

    assert.equal(response.status, 200)
    assert.deepEqual(body.skills.map((skill: { slug: string }) => skill.slug), ["meeting-minutes"])
  } finally {
    await server.close()
  }
})
