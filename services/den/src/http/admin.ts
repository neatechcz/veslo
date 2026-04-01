import express from "express"
import { OrgRole } from "../db/schema.js"

export type AdminSessionOrganization = {
  id: string
  name: string
  slug: string
  ownerUserId: string
  role: (typeof OrgRole)[number]
}

export type AdminSessionSnapshot = {
  user: {
    id: string
    email: string | null
    emailVerified: boolean
    name: string | null
  }
  platformAdmin: boolean
  activeOrgId: string | null
  organizations: AdminSessionOrganization[]
}

export type AdminUserMembership = {
  membershipId: string
  orgId: string
  orgName: string
  orgSlug: string
  role: (typeof OrgRole)[number]
}

export type AdminUserRecord = {
  id: string
  name: string
  email: string
  emailVerified: boolean
  platformAdmin: boolean
  disabled?: boolean
  memberships: AdminUserMembership[]
}

export type AdminRouteDeps = {
  getSessionSnapshot: (req: express.Request, res: express.Response) => Promise<AdminSessionSnapshot | null>
  listUsers?: (req: express.Request, res: express.Response) => Promise<AdminUserRecord[] | null>
  createUser?: (req: express.Request, res: express.Response) => Promise<AdminUserRecord | null>
  updateUser?: (req: express.Request, res: express.Response) => Promise<AdminUserRecord | null>
  disableUser?: (req: express.Request, res: express.Response) => Promise<AdminUserRecord | null>
  enableUser?: (req: express.Request, res: express.Response) => Promise<AdminUserRecord | null>
  deleteUser?: (req: express.Request, res: express.Response) => Promise<{ ok: true } | null>
}

export function serializeAdminSessionSnapshot(input: AdminSessionSnapshot) {
  return {
    user: input.user,
    platformAdmin: input.platformAdmin,
    activeOrgId: input.activeOrgId,
    organizations: input.organizations,
  }
}

export function serializeAdminUser(input: AdminUserRecord) {
  return {
    id: input.id,
    name: input.name,
    email: input.email,
    emailVerified: input.emailVerified,
    platformAdmin: input.platformAdmin,
    disabled: input.disabled === true,
    memberships: input.memberships,
  }
}

export function createAdminRouter(deps: AdminRouteDeps) {
  const router = express.Router()

  router.get("/session", async (req, res) => {
    const snapshot = await deps.getSessionSnapshot(req, res)
    if (!snapshot) {
      return
    }

    res.json(serializeAdminSessionSnapshot(snapshot))
  })

  router.get("/users", async (req, res) => {
    if (!deps.listUsers) {
      res.status(501).json({ error: "not_implemented" })
      return
    }

    const users = await deps.listUsers(req, res)
    if (!users) {
      return
    }

    res.json({
      users: users.map((entry) => serializeAdminUser(entry)),
    })
  })

  router.post("/users", async (req, res) => {
    if (!deps.createUser) {
      res.status(501).json({ error: "not_implemented" })
      return
    }

    const created = await deps.createUser(req, res)
    if (!created) {
      return
    }

    res.status(201).json({
      user: serializeAdminUser(created),
    })
  })

  router.patch("/users/:userId", async (req, res) => {
    if (!deps.updateUser) {
      res.status(501).json({ error: "not_implemented" })
      return
    }

    const updated = await deps.updateUser(req, res)
    if (!updated) {
      return
    }

    res.json({
      user: serializeAdminUser(updated),
    })
  })

  router.post("/users/:userId/disable", async (req, res) => {
    if (!deps.disableUser) {
      res.status(501).json({ error: "not_implemented" })
      return
    }

    const updated = await deps.disableUser(req, res)
    if (!updated) {
      return
    }

    res.json({
      user: serializeAdminUser(updated),
    })
  })

  router.post("/users/:userId/enable", async (req, res) => {
    if (!deps.enableUser) {
      res.status(501).json({ error: "not_implemented" })
      return
    }

    const updated = await deps.enableUser(req, res)
    if (!updated) {
      return
    }

    res.json({
      user: serializeAdminUser(updated),
    })
  })

  router.delete("/users/:userId", async (req, res) => {
    if (!deps.deleteUser) {
      res.status(501).json({ error: "not_implemented" })
      return
    }

    const deleted = await deps.deleteUser(req, res)
    if (!deleted) {
      return
    }

    res.status(204).end()
  })

  return router
}
