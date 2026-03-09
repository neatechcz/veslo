import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findFreePort,
  makeClient,
  spawnOpencodeServe,
  waitForHealthy,
} from "./_util.mjs";

const root = mkdtempSync(join(tmpdir(), "veslo-session-directory-switch-"));
const dirA = join(root, "private-workspace");
const dirB = join(root, "chosen-folder");

const port = await findFreePort();
await mkdir(dirA, { recursive: true });
const server = await spawnOpencodeServe({ directory: dirA, port });

try {
  const clientA = makeClient({ baseUrl: server.baseUrl, directory: dirA });
  await waitForHealthy(clientA);

  const agents = await clientA.app.agents({ directory: dirA });
  const agent = agents[0]?.id || agents[0]?.name;
  assert.ok(agent, "expected at least one agent for shell execution");

  const session = await clientA.session.create({ title: "Directory switch", directory: dirA });
  assert.ok(session?.id, "expected a session id");

  cpSync(dirA, dirB, { recursive: true });

  await clientA.session.shell({
    sessionID: session.id,
    directory: dirB,
    agent,
    command: "printf 'switched' > switched.txt",
  });

  assert.equal(existsSync(join(dirA, "switched.txt")), false, "command must not write into the old folder");
  assert.equal(existsSync(join(dirB, "switched.txt")), true, "command must write into the new folder");
  assert.equal(readFileSync(join(dirB, "switched.txt"), "utf8"), "switched");

  const reopened = await clientA.session.get({ sessionID: session.id, directory: dirB });
  assert.equal(reopened.id, session.id);
  assert.equal(reopened.directory, dirA, "OpenCode still stores the original session directory");

  console.log(
    JSON.stringify({
      ok: true,
      baseUrl: server.baseUrl,
      sessionID: session.id,
      oldDirectory: dirA,
      newDirectory: dirB,
      storedDirectory: reopened.directory,
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
