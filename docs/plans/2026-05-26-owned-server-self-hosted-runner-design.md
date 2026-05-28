# Owned Server Self-Hosted Runner Design

## Context

`Deploy Owned Server` currently runs on GitHub-hosted runners and SSHes into the
owned production server. The workflow validates configuration and sets up SSH, but
the deploy step times out connecting from GitHub-hosted infrastructure to
`62.109.146.43:22`. SSH from the operator machine succeeds, so the blocker is the
network path from GitHub-hosted runners to the owned server.

## Decision

Run the production deploy job on a repository-scoped self-hosted GitHub Actions
runner installed on the owned server and labeled `veslo-owned-server`.

The runner connects outbound to GitHub over HTTPS. The deploy job no longer needs
inbound SSH from GitHub-hosted infrastructure, and it can run Docker Compose
commands locally on the host using the same server-side env file and production
checkout path.

## Workflow Shape

- `Deploy Owned Server` remains manual-only with `workflow_dispatch`.
- The deploy job runs on `[self-hosted, linux, x64, veslo-owned-server]`.
- The job validates only local deploy values: app directory, env file, deploy
  branch, and repo URL.
- The job updates a stable checkout, builds the Compose services, runs Den and AI
  Gateway migrations, starts the stack, and verifies local plus public health.
- SSH secrets remain harmless if present, but they are no longer required for the
  active production deploy path.

## Operations

The owned server runs a GitHub runner under the `neatech` account from
`/home/neatech/actions-runner-veslo`. The runner should be installed as a user
service when possible. If service installation is unavailable, the runner can be
started in a persistent user session until a proper service manager setup is
added.

Production secrets stay in the server-side env file and GitHub secrets. No server
private key or production env value is committed.
