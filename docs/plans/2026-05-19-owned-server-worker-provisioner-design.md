# Owned Server Worker Provisioner Design

## Goal

Move Den cloud worker provisioning from Render-managed web services to worker containers on the owned Veslo server, while keeping Render available as rollback until the migration is verified.

## Architecture

Den keeps ownership of product state, auth, billing checks, worker tokens, audit events, and database rows. A new internal `worker-manager` service owns host-level Docker operations.

The production flow is:

1. Den receives a cloud worker create request.
2. Den stores the worker and token rows with status `provisioning`.
3. Den calls the internal worker manager API with the worker id, display name, and generated tokens.
4. Worker manager creates a labeled Docker volume and container.
5. Worker manager waits for `/health` on the worker container.
6. Den records the returned owned-server URL and marks the worker `healthy`.

Den never mounts the Docker socket. Only `worker-manager` mounts it.

## Den Provisioner Modes

Den supports these modes during migration:

- `stub`: local/dev placeholder URLs.
- `render`: existing Render worker provisioning and rollback path.
- `owned-server`: internal worker-manager provisioning on the owned server.

Production should switch from `render` to `owned-server` only after a staging worker can be created, reached through the public wildcard worker domain, and deleted cleanly.

## Internal API

All internal API requests require:

```http
Authorization: Bearer <OWNED_WORKER_MANAGER_TOKEN>
```

Requests without a matching bearer token return `401`.

### `POST /workers`

Creates or reconciles one owned worker container.

Request:

```json
{
  "workerId": "uuid",
  "name": "Display name",
  "hostToken": "host token",
  "clientToken": "client token",
  "image": "veslo-owned-server-worker-runtime:local"
}
```

Response:

```json
{
  "worker": {
    "id": "uuid",
    "provider": "owned-server",
    "url": "https://uuid.workers.veslo.work",
    "status": "healthy",
    "containerName": "veslo-worker-uuid",
    "health": {
      "ok": true
    }
  }
}
```

If the worker already exists, the manager returns the existing container state and URL instead of creating a duplicate.

### `GET /workers/:id`

Returns the current manager view of one worker.

Response:

```json
{
  "worker": {
    "id": "uuid",
    "provider": "owned-server",
    "url": "https://uuid.workers.veslo.work",
    "status": "healthy",
    "containerName": "veslo-worker-uuid",
    "dockerState": "running",
    "health": {
      "ok": true
    }
  }
}
```

Missing workers return `404`.

### `DELETE /workers/:id`

Stops and removes the managed worker container. The default production delete behavior removes the container and the dedicated worker volume because Den currently treats worker deletion as permanent deletion.

Future suspend behavior can stop the container while retaining the volume, but suspend is not part of the first cutover contract.

Successful deletes return `204`. Missing workers also return `204` so Den cleanup remains idempotent.

## Docker Contract

Worker manager creates one worker container per Den worker id.

Container naming:

- `veslo-worker-<workerId>`

Volume naming:

- `veslo-worker-<workerId>-workspace`

Labels:

- `veslo.role=worker`
- `veslo.managed-by=worker-manager`
- `veslo.worker-id=<workerId>`
- `veslo.worker-name=<display name>`

Environment:

- `VESLO_TOKEN=<clientToken>`
- `VESLO_HOST_TOKEN=<hostToken>`
- `DEN_WORKER_ID=<workerId>`
- `NODE_ENV=production`

Runtime command:

```bash
veslo serve --workspace /workspace --veslo-host 0.0.0.0 --veslo-port 8787 --opencode-host 127.0.0.1 --opencode-port 4096 --connect-host 127.0.0.1 --cors '*' --approval manual --allow-external --veslo-server-bin /app/packages/server/dist/cli.js --no-veslo-code-router --verbose
```

The owned-server worker runtime image is built from the checked-out repository sources. It builds `veslo-server` and `veslo-orchestrator`, installs Bun for the compiled server/orchestrator runtime path, and exposes a local `veslo` wrapper inside the image. It does not depend on a published `veslo-orchestrator` npm package.

The worker container exposes port `8787` on the internal Docker network. It does not publish a host port.

## Health Semantics

Worker manager treats a worker as healthy only when both conditions are true:

- Docker reports the container as running.
- `GET /health` on the worker container returns a 2xx response.

If Docker reports the container as running but `/health` is not ready yet, the status is `provisioning`.

If Docker reports the container as exited, missing, or unhealthy after startup timeout, the API returns an error and Den records the provisioning failure.

## URL Allocation And Proxying

Owned worker URLs use:

```text
https://<workerId>.workers.veslo.work
```

Caddy owns public TLS and forwards all `*.workers.veslo.work` traffic to `worker-manager`.

Worker manager reverse-proxies public worker requests to the worker container selected by the hostname. This keeps lifecycle and routing in one service and avoids rewriting Caddy configuration for every worker.

DNS requires a wildcard record for:

```text
*.workers.veslo.work
```

pointing at the owned server.

## Compose Wiring

Owned-server Compose adds:

- `worker-manager`
- Docker socket mount on `worker-manager` only.
- An internal Docker network shared by `worker-manager` and worker containers.
- Caddy wildcard route for `*.workers.veslo.work`.

Den receives:

- `PROVISIONER_MODE=owned-server`
- `OWNED_WORKER_MANAGER_URL=http://worker-manager:8790`
- `OWNED_WORKER_MANAGER_TOKEN=<shared internal secret>`
- `OWNED_WORKER_PUBLIC_DOMAIN_SUFFIX=workers.veslo.work`

Render values stay in the environment until Phase 7 so rollback remains a config change.

## Verification

Local verification:

1. Den owned-server provisioner tests pass.
2. Worker manager auth, create, health, proxy target resolution, and delete tests pass.
3. Owned-server Compose config renders successfully.

Server staging verification:

1. Deploy with `PROVISIONER_MODE=owned-server` in staging.
2. Create one cloud worker through Den.
3. Confirm Den returns a URL under `workers.veslo.work`.
4. Confirm the worker URL `/health` returns 2xx.
5. Delete the worker through Den.
6. Confirm the worker container and workspace volume are removed.

## Rollback

If owned-worker provisioning fails before Phase 7, switch Den back to:

```text
PROVISIONER_MODE=render
```

and keep the Render worker environment values in place.
