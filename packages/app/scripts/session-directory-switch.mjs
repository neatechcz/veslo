import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
const dirA = join(root, "private-workspace");
const dirB = join(root, "chosen-folder");

function normalizeMacOSTempPath(input) {
  return resolve(input).replace(/^\/private\/var(?=\/|$)/, "/var").replace(/[\\/]+$/, "");
}

const port = await findFreePort();
await mkdir(dirA, { recursive: true });
const server = await spawnOpencodeServe({ directory: dirA, port });

try {
  const clientA = makeClient({ baseUrl: server.baseUrl, directory: dirA });
  await waitForHealthy(clientA);

  const agents = await clientA.app.agents({ directory: dirA });
  const agent = agents[0]?.id || agents[0]?.name;
  assert.ok(agent, "expected at least one agent for shell execution");

  const sessionA = await clientA.session.create({ title: "Directory switch A", directory: dirA });
  assert.ok(sessionA?.id, "expected a session id");

  cpSync(dirA, dirB, { recursive: true });

  await clientA.session.shell({
    sessionID: sessionA.id,
    directory: dirB,
    agent,
    command: "node -e \"require('node:fs').writeFileSync('pinned.txt', 'pinned')\"",
  });

  assert.equal(
    existsSync(join(dirA, "pinned.txt")),
    true,
    "existing OpenCode session must stay pinned to its creation directory",
  );
  assert.equal(
    existsSync(join(dirB, "pinned.txt")),
    false,
    "per-request directory override must not retarget an existing OpenCode session; Veslo must create a new session when the workspace directory changes",
  );
  assert.equal(readFileSync(join(dirA, "pinned.txt"), "utf8"), "pinned");

  const reopenedA = await clientA.session.get({ sessionID: sessionA.id, directory: dirB });
  assert.equal(reopenedA.id, sessionA.id);
  assert.equal(
    normalizeMacOSTempPath(reopenedA.directory),
    normalizeMacOSTempPath(dirA),
    "session.get with a different directory must still report the original pinned session directory",
  );

  const clientB = makeClient({ baseUrl: server.baseUrl, directory: dirB });
  const sessionB = await clientB.session.create({ title: "Directory switch B", directory: dirB });
  assert.ok(sessionB?.id, "expected a second session id");

  await clientB.session.shell({
    sessionID: sessionB.id,
    directory: dirB,
    agent,
    command: "node -e \"require('node:fs').writeFileSync('bound.txt', 'bound')\"",
  });

  assert.equal(
    existsSync(join(dirB, "bound.txt")),
    true,
    "a second OpenCode session created for dirB must execute in dirB on the shared server process",
  );
  assert.equal(
    existsSync(join(dirA, "bound.txt")),
    false,
    "per-session directory binding must isolate dirB commands from dirA on the shared server process",
  );
  assert.equal(readFileSync(join(dirB, "bound.txt"), "utf8"), "bound");

  const reopenedB = await clientB.session.get({ sessionID: sessionB.id, directory: dirB });
  assert.equal(reopenedB.id, sessionB.id);
  assert.equal(
    normalizeMacOSTempPath(reopenedB.directory),
    normalizeMacOSTempPath(dirB),
    "session B must store dirB as its pinned directory",
  );

  console.log(
    JSON.stringify({
      ok: true,
      baseUrl: server.baseUrl,
      sessionID: sessionA.id,
      sessionBID: sessionB.id,
      oldDirectory: dirA,
      newDirectory: dirB,
      storedDirectory: reopenedA.directory,
      sessionBStoredDirectory: reopenedB.directory,
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
