import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..", "..");
const defaultBinary = join(repoRoot, "packages", "desktop", "src-tauri", "sidecars", process.platform === "win32" ? "opencode.exe" : "opencode");
const opencodeBinary = process.env.VESLO_OPENCODE_BINARY?.trim() || defaultBinary;

function tail(value, maxChars = 4_000) {
  return value.length > maxChars ? value.slice(-maxChars) : value;
}

async function findFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Unable to allocate a TCP port"));
      server.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

async function writeSkill(root, name, description = name) {
  const directory = join(root, ".opencode", ".veslo", "runtime-skills", "current", name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${description}\n`, "utf8");
}

async function writeRawProjectSkill(root, name) {
  const directory = join(root, ".opencode", "skills", name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n\n${name}\n`, "utf8");
}

async function waitForServer(baseUrl, process, logs) {
  const started = Date.now();
  let latest;
  while (Date.now() - started < 30_000) {
    if (process.exitCode !== null) {
      throw new Error(`OpenCode exited before becoming ready (${process.exitCode})\n${tail(logs.stderr)}`);
    }
    try {
      const response = await fetch(`${baseUrl}/skill`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
      latest = new Error(`HTTP ${response.status}`);
    } catch (error) {
      latest = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`OpenCode did not become ready: ${String(latest)}\n${tail(logs.stderr)}`);
}

async function fetchSkills(baseUrl, directory) {
  const url = new URL("/skill", baseUrl);
  url.searchParams.set("directory", directory);
  const response = await fetch(url, {
    headers: { "x-opencode-directory": encodeURIComponent(directory) },
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`GET ${url} failed (${response.status}): ${body}`);
  const parsed = JSON.parse(body);
  if (!Array.isArray(parsed)) throw new Error(`Unexpected /skill payload: ${body}`);
  return parsed.map((item) => ({ name: item.name, location: item.location }));
}

function names(skills) {
  return skills.map((skill) => skill.name).sort();
}

const root = await mkdtemp(join(tmpdir(), "veslo-opencode-directory-skills-"));
const workspaceA = join(root, "workspace-a");
const workspaceB = join(root, "workspace-b");
const configHome = join(root, "config");
const port = await findFreePort();
const baseUrl = `http://127.0.0.1:${port}`;
const logs = { stdout: "", stderr: "" };

await mkdir(workspaceA, { recursive: true });
await mkdir(workspaceB, { recursive: true });
await mkdir(configHome, { recursive: true });
await writeSkill(workspaceA, "veslo-a-only");
await writeSkill(workspaceB, "veslo-b-only");
await writeRawProjectSkill(workspaceA, "raw-project-leak-a");
await writeRawProjectSkill(workspaceB, "raw-project-leak-b");

const server = spawn(opencodeBinary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: workspaceA,
  env: {
    ...process.env,
    OPENCODE_CONFIG_DIR: configHome,
    XDG_CONFIG_HOME: configHome,
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    // This path is deliberately relative. OpenCode must resolve it against
    // the request's directory, never against this process's initial cwd.
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ skills: { paths: [".opencode/.veslo/runtime-skills/current"] } }),
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
server.stdout.setEncoding("utf8");
server.stderr.setEncoding("utf8");
server.stdout.on("data", (chunk) => { logs.stdout += chunk; });
server.stderr.on("data", (chunk) => { logs.stderr += chunk; });

try {
  await waitForServer(baseUrl, server, logs);
  const [skillsA, skillsB] = await Promise.all([
    fetchSkills(baseUrl, workspaceA),
    fetchSkills(baseUrl, workspaceB),
  ]);

  assert.equal(names(skillsA).includes("veslo-a-only"), true, `workspace A missed its own view: ${JSON.stringify(skillsA)}`);
  assert.equal(names(skillsB).includes("veslo-b-only"), true, `workspace B missed its own view: ${JSON.stringify(skillsB)}`);
  assert.equal(names(skillsA).includes("veslo-b-only"), false, `workspace A leaked workspace B: ${JSON.stringify(skillsA)}`);
  assert.equal(names(skillsB).includes("veslo-a-only"), false, `workspace B leaked workspace A: ${JSON.stringify(skillsB)}`);
  assert.equal(names(skillsA).includes("raw-project-leak-a"), false, `workspace A exposed raw project skills: ${JSON.stringify(skillsA)}`);
  assert.equal(names(skillsB).includes("raw-project-leak-b"), false, `workspace B exposed raw project skills: ${JSON.stringify(skillsB)}`);
  assert.equal(skillsA.some((skill) => skill.name === "veslo-a-only" && skill.location.startsWith(workspaceA)), true, "workspace A skill must resolve inside workspace A");
  assert.equal(skillsB.some((skill) => skill.name === "veslo-b-only" && skill.location.startsWith(workspaceB)), true, "workspace B skill must resolve inside workspace B");

  await writeSkill(workspaceA, "veslo-a-fresh");
  const refreshedA = await fetchSkills(baseUrl, workspaceA);
  // OpenCode 1.17.13 caches skill discovery by directory. This is not an
  // assertion because the compatibility gate must record the shipped binary's
  // behavior: a false result rejects directory-scoped hot updates and keeps
  // Veslo on the safe legacy process-view fallback.
  const freshWithoutDirectoryDisposal = names(refreshedA).includes("veslo-a-fresh");

  console.log(JSON.stringify({
    ok: true,
    directoryScopedHotUpdateCompatible: freshWithoutDirectoryDisposal,
    fallbackRequired: !freshWithoutDirectoryDisposal,
    opencodeBinary,
    workspaceA: skillsA,
    workspaceB: skillsB,
    refreshedA,
  }, null, 2));
} finally {
  if (server.exitCode === null) {
    server.kill("SIGTERM");
    await Promise.race([once(server, "exit"), new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000))]);
  }
  if (server.exitCode === null) server.kill("SIGKILL");
  await rm(root, { recursive: true, force: true });
}
