import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const scriptPath = resolve(__dirname, "./tauri-before-dev.mjs");
const desktopRoot = resolve(__dirname, "..");

const wait = (ms) => new Promise((resolvePromise) => {
  setTimeout(resolvePromise, ms);
});

async function withFakeViteServer({ identity = null } = {}, handler) {
  const server = createServer((req, res) => {
    if (req.url === "/@vite/client") {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end("import.meta.hot = { on(){}, send(){}, accept(){}, dispose(){} }; // @vite/client");
      return;
    }

    if (req.url === "/__veslo-dev-server") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ identity }));
      return;
    }

    const marker = identity === null ? "" : '<meta name="veslo-dev-server" content="1" />';
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><html><head><title>Fake Vite</title>${marker}</head><body><div id="root">fake</div></body></html>`);
  });

  await new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", resolvePromise);
  });

  const address = server.address();
  assert.ok(address && typeof address === "object", "Expected fake Vite server to bind to a TCP port");

  try {
    await handler(address.port);
  } finally {
    await new Promise((resolvePromise, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePromise();
      });
    });
  }
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  await Promise.race([
    waitForExit(child),
    wait(5_000).then(() => {
      child.kill("SIGKILL");
      return waitForExit(child);
    }),
  ]);
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve([child.exitCode, child.signalCode]);
  }

  return once(child, "exit");
}

test("tauri-before-dev rejects unrelated Vite-like servers that do not serve Veslo", async () => {
  await withFakeViteServer({}, async (port) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: desktopRoot,
      env: {
        ...process.env,
        PORT: String(port),
        VESLO_SIDECAR_FORCE_BUILD: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    const append = (chunk) => {
      output += chunk.toString();
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);

    try {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if (
          output.includes("Port") ||
          output.includes("UI dev server already running")
        ) {
          break;
        }
        await wait(100);
      }

      assert.match(
        output,
        new RegExp(`\\[veslo\\] Port ${port} is in use, but it does not look like a Vite dev server\\.`),
      );
      const [exitCode] = await waitForExit(child);
      assert.notEqual(exitCode, 0, "Expected tauri-before-dev to fail fast instead of reusing a foreign Vite server");
    } finally {
      await stopProcess(child);
    }
  });
});

test("tauri-before-dev rejects a marked Veslo server from another checkout", async () => {
  await withFakeViteServer({ identity: "another-checkout" }, async (port) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: desktopRoot,
      env: {
        ...process.env,
        PORT: String(port),
        VESLO_SIDECAR_FORCE_BUILD: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    const append = (chunk) => {
      output += chunk.toString();
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    try {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && !output.includes("another checkout")) {
        await wait(100);
      }
      assert.match(output, new RegExp(`\\[veslo\\] Port ${port} is serving a Veslo dev server from another checkout`));
      const [exitCode] = await waitForExit(child);
      assert.notEqual(exitCode, 0, "Expected tauri-before-dev to reject a marked server from another checkout");
    } finally {
      await stopProcess(child);
    }
  });
});
