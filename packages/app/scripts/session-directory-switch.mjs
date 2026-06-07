import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  findFreePort,
  makeClient,
  spawnOpencodeServe,
  waitForHealthy,
} from "./_util.mjs";

const root = mkdtempSync(join(tmpdir(), "veslo-session-directory-switch-"));
const dirA = join(root, "workspace-a");
const dirB = join(root, "workspace-b");

function normalizeMacOSTempPath(input) {
  return resolve(input).replace(/^\/private\/var(?=\/|$)/, "/var").replace(/[\\/]+$/, "");
}

async function withTimeout(label, promise, timeoutMs = 10_000) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

const port = await findFreePort();
await mkdir(dirA, { recursive: true });
await mkdir(dirB, { recursive: true });
const server = await spawnOpencodeServe({ directory: dirA, port });

try {
  const clientA = makeClient({ baseUrl: server.baseUrl, directory: dirA });
  const clientB = makeClient({ baseUrl: server.baseUrl, directory: dirB });
  await waitForHealthy(clientA);

  const sessionA = await withTimeout(
    "session.create for workspace A",
    clientA.session.create({ title: "Workspace A", directory: dirA }),
  );
  assert.ok(sessionA?.id, "expected a session id for workspace A");

  const sessionB = await withTimeout(
    "session.create for workspace B",
    clientB.session.create({ title: "Workspace B", directory: dirB }),
  );
  assert.ok(sessionB?.id, "expected a session id for workspace B");
  assert.notEqual(sessionA.id, sessionB.id, "expected distinct sessions for distinct workspace roots");

  const reopenedA = await withTimeout(
    "session.get for workspace A while directory B is requested",
    clientA.session.get({ sessionID: sessionA.id, directory: dirB }),
  );
  assert.equal(reopenedA.id, sessionA.id);
  assert.equal(
    normalizeMacOSTempPath(reopenedA.directory),
    normalizeMacOSTempPath(dirA),
    "OpenCode stores the original directory for session A",
  );

  const reopenedB = await withTimeout(
    "session.get for workspace B",
    clientB.session.get({ sessionID: sessionB.id, directory: dirB }),
  );
  assert.equal(reopenedB.id, sessionB.id);
  assert.equal(
    normalizeMacOSTempPath(reopenedB.directory),
    normalizeMacOSTempPath(dirB),
    "OpenCode stores the original directory for session B",
  );

  console.log(
    JSON.stringify({
      ok: true,
      baseUrl: server.baseUrl,
      sessionAID: sessionA.id,
      sessionBID: sessionB.id,
      workspaceA: dirA,
      workspaceB: dirB,
      storedDirectoryA: reopenedA.directory,
      storedDirectoryB: reopenedB.directory,
    }),
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ ok: false, error: message, stderr: server.getStderr() }));
  process.exitCode = 1;
} finally {
  await server.close();
  rmSync(root, { recursive: true, force: true });
}
