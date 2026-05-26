# Owned Server Ops Admin Workflow Design

## Context

`Grant Veslo Platform Admin` is a manual production operation that grants a Veslo user
the `platform_admin` role. It still runs on a GitHub-hosted runner and connects
to a database through `DEN_DATABASE_URL`.

Production Den now runs on the owned-server Compose stack. Production database
access should stay on the owned server rather than depending on externally
reachable database credentials from GitHub-hosted runners.

## Decision

Run `Grant Veslo Platform Admin` on the `veslo-owned-server` self-hosted runner and
execute the existing role-grant script inside the running `den` Compose service.

The workflow keeps its existing dry-run/apply behavior. It validates the stable
server checkout and env file, defines the same Compose command used by the
deploy workflow, and runs Node from `/app/services/den` inside the container so
`DATABASE_URL` and `mysql2` come from the production service environment.

## Non-Goals

- Do not move CI, release, signing, or desktop build workflows onto the owned
  server.
- Do not remove Render rollback configuration from Compose templates in this
  change.
- Do not delete GitHub secrets in this change; secret cleanup is an operator
  settings action.
