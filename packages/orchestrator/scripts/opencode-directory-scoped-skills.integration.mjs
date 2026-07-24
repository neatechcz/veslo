import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..", "..");
const defaultBinary = join(
  repoRoot,
  "packages",
  "desktop",
  "src-tauri",
  "sidecars",
  process.platform === "win32" ? "opencode.exe" : "opencode",
);
const opencodeBinary = process.env.VESLO_OPENCODE_BINARY?.trim() || defaultBinary;
const artifactDir = resolve(
  process.env.VESLO_OPENCODE_COMPAT_ARTIFACT_DIR?.trim() ||
    join(repoRoot, ".tmp", "runtime-oracle", `bundled-opencode-directory-skills-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`),
);
const GATE_SCHEMA_VERSION = "veslo-opencode-directory-skills/v3";

function tail(value, maxChars = 6_000) {
  return value.length > maxChars ? value.slice(-maxChars) : value;
}

function skillMarkdown(name, description, body = description) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function findFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = createTcpServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Unable to allocate a TCP port"));
      server.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

async function writeSkill(root, pathSegments, name, description, body = description) {
  const directory = join(root, ...pathSegments, name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), skillMarkdown(name, description, body), "utf8");
}

async function writeEffectiveSkill(workspace, name, marker) {
  return writeSkill(
    workspace,
    [".opencode", ".veslo", "runtime-skills", "current"],
    name,
    `effective-marker-${marker}`,
    `effective skill body ${marker}`,
  );
}

async function writeRawProjectSkill(workspace, name, marker) {
  return writeSkill(
    workspace,
    [".opencode", "skills"],
    name,
    `raw-marker-${marker}`,
    `raw project skill body ${marker}`,
  );
}

async function writeExternalProjectSkill(workspace, rootName, name, marker) {
  return writeSkill(
    workspace,
    [rootName, "skills"],
    name,
    `${rootName}-marker-${marker}`,
    `${rootName} project skill body ${marker}`,
  );
}

async function prepareWorkspace(workspace, marker) {
  await mkdir(join(workspace, "packages", "foo"), { recursive: true });
  await writeEffectiveSkill(workspace, "same-name", marker);
  await writeEffectiveSkill(workspace, "managed-same-name", `managed-${marker}`);
  await writeRawProjectSkill(workspace, `raw-omitted-${marker.toLowerCase()}`, marker);
  // This represents an unmanaged duplicate of a managed entry. The direct
  // OpenCode probe cannot prove Veslo's manifest/marker logic, but it records
  // which source would win if native project discovery were still visible.
  await writeRawProjectSkill(workspace, "managed-same-name", `raw-managed-${marker}`);
  await writeExternalProjectSkill(workspace, ".claude", `claude-project-${marker.toLowerCase()}`, marker);
  await writeExternalProjectSkill(workspace, ".agents", `agents-project-${marker.toLowerCase()}`, marker);
  await writeFile(
    join(workspace, "opencode.jsonc"),
    `// A raw project config must not be able to add engine skill roots.\n${JSON.stringify({ skills: { paths: [".opencode/skills"] } }, null, 2)}\n`,
    "utf8",
  );
}

async function prepareAmbientUserRoots(homeRoot) {
  await writeSkill(homeRoot, [".claude", "skills"], "global-claude", "global-claude-marker");
  await writeSkill(homeRoot, [".agents", "skills"], "global-agents", "global-agents-marker");
  await writeSkill(homeRoot, [".agent", "skills"], "global-agent", "global-agent-marker");
  await writeSkill(homeRoot, [".config", "opencode", "skills"], "global-opencode", "global-opencode-marker");
}

async function waitFor(check, label, timeoutMs = 30_000) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));
  }
  throw new Error(`${label} timed out: ${lastError instanceof Error ? lastError.message : String(lastError ?? "no matching result")}`);
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

function directoryHeaders(directory) {
  return directory ? { "x-opencode-directory": encodeURIComponent(directory) } : {};
}

async function requestJson(baseUrl, pathname, input = {}) {
  const url = new URL(pathname, baseUrl);
  if (input.directory) url.searchParams.set("directory", input.directory);
  const response = await fetch(url, {
    method: input.method ?? "GET",
    headers: {
      ...(input.body === undefined ? {} : { "content-type": "application/json" }),
      ...directoryHeaders(input.directory),
      ...(input.headers ?? {}),
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
    signal: input.signal ?? AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body, url: url.toString() };
}

async function fetchSkills(baseUrl, directory) {
  const result = await requestJson(baseUrl, "/skill", { directory });
  if (!result.response.ok) throw new Error(`GET ${result.url} failed (${result.response.status}): ${JSON.stringify(result.body)}`);
  if (!Array.isArray(result.body)) throw new Error(`Unexpected /skill payload: ${JSON.stringify(result.body)}`);
  return result.body.map((item) => ({
    name: item?.name,
    description: item?.description ?? null,
    location: item?.location ?? null,
    content: item?.content ?? null,
  }));
}

function findSkill(skills, name) {
  return skills.find((skill) => skill.name === name) ?? null;
}

function hasSkill(skills, name) {
  return skills.some((skill) => skill.name === name);
}

function summarizeSkills(skills) {
  return skills.map(({ name, description, location }) => ({ name, description, location }));
}

function extractSessionDirectory(session) {
  const candidates = [
    session?.directory,
    session?.info?.directory,
    session?.session?.directory,
    session?.data?.directory,
  ];
  return candidates.find((value) => typeof value === "string" && value.length > 0) ?? null;
}

async function createSession(baseUrl, directory, title) {
  const result = await requestJson(baseUrl, "/session", {
    method: "POST",
    directory,
    body: { title },
  });
  if (!result.response.ok || typeof result.body?.id !== "string") {
    throw new Error(`Session create failed for ${directory}: ${result.response.status} ${JSON.stringify(result.body)}`);
  }
  return result.body;
}

async function getSession(baseUrl, directory, sessionId) {
  const result = await requestJson(baseUrl, `/session/${encodeURIComponent(sessionId)}`, { directory });
  if (!result.response.ok) throw new Error(`Session read failed for ${sessionId}: ${result.response.status} ${JSON.stringify(result.body)}`);
  return result.body;
}

async function promptAsync(baseUrl, directory, sessionId, text) {
  const result = await requestJson(baseUrl, `/session/${encodeURIComponent(sessionId)}/prompt_async`, {
    method: "POST",
    directory,
    body: {
      model: { providerID: "deterministic", modelID: "oracle" },
      parts: [{ type: "text", text }],
    },
  });
  if (result.response.status !== 204) {
    throw new Error(`Prompt ${text} failed: ${result.response.status} ${JSON.stringify(result.body)}`);
  }
}

async function abortSession(baseUrl, directory, sessionId) {
  const result = await requestJson(baseUrl, `/session/${encodeURIComponent(sessionId)}/abort`, {
    method: "POST",
    directory,
  });
  if (![200, 204].includes(result.response.status)) {
    throw new Error(`Abort ${sessionId} failed: ${result.response.status} ${JSON.stringify(result.body)}`);
  }
  return result.response.status;
}

function createDeterministicProvider() {
  const requests = [];
  const active = new Set();
  let maxConcurrency = 0;
  const server = createHttpServer(async (request, response) => {
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: "oracle", object: "model", owned_by: "veslo" }] }));
      return;
    }
    if (request.url !== "/v1/chat/completions") {
      response.writeHead(404);
      response.end();
      return;
    }

    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const serialized = JSON.stringify(body);
    const text = serialized.match(/(?:prompt|text)[^\w]*(?:[^\"]*\")?([^\"]+)/i)?.[1] ?? serialized;
    const entry = {
      id: requests.length + 1,
      text,
      serialized,
      startedAt: Date.now(),
      finishedAt: null,
    };
    requests.push(entry);
    active.add(entry.id);
    maxConcurrency = Math.max(maxConcurrency, active.size);

    const delayMs = serialized.includes("[hold]") ? 1_200 : 180;
    try {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.write(`data: ${JSON.stringify({ id: `oracle-${entry.id}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: `reply:${entry.id}` }, finish_reason: null }] })}\n\n`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
      response.write(`data: ${JSON.stringify({ id: `oracle-${entry.id}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    } finally {
      active.delete(entry.id);
      entry.finishedAt = Date.now();
    }
  });

  return {
    server,
    requests,
    activeCount: () => active.size,
    maxConcurrency: () => maxConcurrency,
  };
}

async function startOpenCode(input) {
  const logs = { stdout: "", stderr: "" };
  await mkdir(input.configRoot, { recursive: true });
  const configPath = join(input.configRoot, "opencode.jsonc");
  const projectInstructionPath = input.projectInstructionMarker
    ? join(input.configRoot, "AGENTS.md")
    : undefined;
  if (projectInstructionPath) {
    await writeFile(projectInstructionPath, `${input.projectInstructionMarker}\n`, "utf8");
  }
  // This is the sanitized mirror that Veslo supplies through OPENCODE_CONFIG.
  // Its lack of `skills` is intentional and part of the Gate B contract.
  await writeFile(configPath, `${JSON.stringify({ "$schema": "https://opencode.ai/config.json" }, null, 2)}\n`, "utf8");
  const inheritedConfig = {
    mcp: { inherited: { enabled: false } },
    skills: {
      paths: [input.inheritedSkillsRoot],
      urls: ["https://example.test/unmanaged-skills"],
    },
  };
  const { skills: _ignoredInheritedSkills, ...inheritedWithoutSkills } = inheritedConfig;
  const configContent = {
    ...inheritedWithoutSkills,
    model: "deterministic/oracle",
    provider: {
      deterministic: {
        npm: "@ai-sdk/openai-compatible",
        name: "Veslo deterministic directory-scope provider",
        options: { baseURL: `http://127.0.0.1:${input.providerPort}/v1`, apiKey: "oracle" },
        models: { oracle: { name: "Veslo deterministic compatibility model" } },
      },
    },
    ...(projectInstructionPath ? { instructions: [projectInstructionPath] } : {}),
    skills: { paths: [".opencode/.veslo/runtime-skills/current"] },
  };
  const child = spawn(opencodeBinary, ["serve", "--hostname", "127.0.0.1", "--port", String(input.port)], {
    cwd: input.workspaceA,
    env: {
      ...process.env,
      HOME: input.homeRoot,
      USERPROFILE: input.homeRoot,
      OPENCODE_CONFIG_DIR: input.configRoot,
      XDG_CONFIG_HOME: input.configRoot,
      XDG_DATA_HOME: input.dataRoot,
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "1",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_CONFIG: configPath,
      ...(input.hardened ? { OPENCODE_PURE: "1" } : {}),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(configContent),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { logs.stdout += chunk; });
  child.stderr.on("data", (chunk) => { logs.stderr += chunk; });
  const baseUrl = `http://127.0.0.1:${input.port}`;
  const health = await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`OpenCode exited with ${child.exitCode}: ${tail(logs.stderr)}`);
    const result = await requestJson(baseUrl, "/global/health", { signal: AbortSignal.timeout(1_000) });
    return result.response.ok ? result.body : null;
  }, `OpenCode ${input.profile} health`);
  return { child, baseUrl, logs, health, profile: input.profile };
}

async function runProfile(input) {
  const port = await findFreePort();
  const runtime = await startOpenCode({ ...input, port });
  try {
    const [skillsA, skillsB] = await Promise.all([
      fetchSkills(runtime.baseUrl, input.workspaceA),
      fetchSkills(runtime.baseUrl, input.workspaceB),
    ]);
    const expectedA = findSkill(skillsA, "same-name");
    const expectedB = findSkill(skillsB, "same-name");
    const managedA = findSkill(skillsA, "managed-same-name");
    const managedB = findSkill(skillsB, "managed-same-name");
    const rawA = hasSkill(skillsA, "raw-omitted-a");
    const rawB = hasSkill(skillsB, "raw-omitted-b");
    const inheritedConfigSkillVisible = hasSkill(skillsA, "inherited-config-skill") || hasSkill(skillsB, "inherited-config-skill");
    const externalNames = [
      "claude-project-a",
      "claude-project-b",
      "agents-project-a",
      "agents-project-b",
      "global-claude",
      "global-agents",
      "global-agent",
      "global-opencode",
    ];
    const externalVisible = externalNames.filter((name) => hasSkill(skillsA, name) || hasSkill(skillsB, name));
    const expectedSameName =
      expectedA?.description === "effective-marker-A" &&
      expectedB?.description === "effective-marker-B" &&
      expectedA.location?.startsWith(input.workspaceA) &&
      expectedB.location?.startsWith(input.workspaceB);
    const expectedManaged =
      managedA?.description === "effective-marker-managed-A" &&
      managedB?.description === "effective-marker-managed-B" &&
      managedA.location?.startsWith(input.workspaceA) &&
      managedB.location?.startsWith(input.workspaceB);
    let projectInstructionVisible = null;
    if (input.projectInstructionMarker) {
      const before = input.provider.requests.length;
      const session = await createSession(runtime.baseUrl, input.workspaceA, "normal projection instructions");
      await promptAsync(runtime.baseUrl, input.workspaceA, session.id, "normal projection instructions probe");
      const providerRequests = await waitFor(
        () => input.provider.requests.slice(before).some((entry) => entry.serialized.includes("normal projection instructions probe"))
          ? input.provider.requests.slice(before)
          : null,
        "normal config projection prompt",
      );
      projectInstructionVisible = providerRequests.some((entry) => entry.serialized.includes(input.projectInstructionMarker));
    }

    return {
      runtime,
      summary: {
        profile: input.profile,
        pid: runtime.child.pid ?? null,
        opencodeVersion: runtime.health?.version ?? null,
        sameNameIsolated: expectedSameName,
        managedOverlayWins: expectedManaged,
        rawOmittedVisible: { a: rawA, b: rawB },
        inheritedConfigSkillVisible,
        externalVisible,
        projectInstructionVisible,
        skillsA: summarizeSkills(skillsA),
        skillsB: summarizeSkills(skillsB),
      },
    };
  } catch (error) {
    await stop(runtime.child);
    throw error;
  }
}

const root = await mkdtemp(join(tmpdir(), "veslo-opencode-directory-skills-"));
const workspaceA = join(root, "workspace-a");
const workspaceB = join(root, "workspace-b");
const homeRoot = join(root, "home");
const providerRoot = join(root, "provider-state");
const configRoot = join(root, "config");
const dataRoot = join(root, "data");
const inheritedSkillsRoot = join(root, "inherited-config-skills");
const provider = createDeterministicProvider();
let hardenedRuntime = null;
let normalRuntime = null;
const result = {
  ok: false,
  schema: GATE_SCHEMA_VERSION,
  opencodeBinary,
  capabilityFingerprint: null,
  gateA: null,
  gateB: null,
  gateC: null,
  fallbackRequired: true,
  errors: [],
};

try {
  await Promise.all([
    mkdir(workspaceA, { recursive: true }),
    mkdir(workspaceB, { recursive: true }),
    mkdir(homeRoot, { recursive: true }),
    mkdir(providerRoot, { recursive: true }),
    mkdir(configRoot, { recursive: true }),
    mkdir(dataRoot, { recursive: true }),
    mkdir(inheritedSkillsRoot, { recursive: true }),
  ]);
  await Promise.all([
    prepareWorkspace(workspaceA, "A"),
    prepareWorkspace(workspaceB, "B"),
    prepareAmbientUserRoots(homeRoot),
    writeSkill(inheritedSkillsRoot, [], "inherited-config-skill", "inherited-config-marker"),
  ]);

  const providerPort = await findFreePort();
  await new Promise((resolveListen, reject) => provider.server.listen(providerPort, "127.0.0.1", (error) => error ? reject(error) : resolveListen()));
  const binarySha256 = await sha256File(opencodeBinary);

  const hardened = await runProfile({
    profile: "hardened",
    hardened: true,
    workspaceA,
    workspaceB,
    homeRoot,
    configRoot: join(configRoot, "hardened"),
    dataRoot: join(dataRoot, "hardened"),
    inheritedSkillsRoot,
    providerPort,
  });
  hardenedRuntime = hardened.runtime;

  const normal = await runProfile({
    profile: "normal-veslo-effective-manifest",
    hardened: false,
    workspaceA,
    workspaceB,
    homeRoot,
    configRoot: join(configRoot, "normal"),
    dataRoot: join(dataRoot, "normal"),
    inheritedSkillsRoot,
    providerPort,
    provider,
    projectInstructionMarker: "normal-projected-workspace-instructions",
  });
  normalRuntime = normal.runtime;

  result.capabilityFingerprint = {
    binaryPath: opencodeBinary,
    binarySha256,
    reportedVersion: hardened.summary.opencodeVersion,
    platform: process.platform,
    arch: process.arch,
    gateSchemaVersion: GATE_SCHEMA_VERSION,
    launchProfiles: {
      hardened: { disableProjectConfig: true, disableExternalSkills: true, relativeSkillsPath: ".opencode/.veslo/runtime-skills/current" },
      normal: { disableProjectConfig: true, disableExternalSkills: true, sanitizedConfigSnapshot: true, relativeSkillsPath: ".opencode/.veslo/runtime-skills/current" },
    },
  };

  // Gate A uses the hardened profile for a closed, workspace-local relative
  // overlay. It proves the OpenCode process/instance capability; Gate B checks
  // whether that profile matches Veslo's policy contract.
  const baseUrl = hardenedRuntime.baseUrl;
  const [sessionA, sessionB] = await Promise.all([
    createSession(baseUrl, workspaceA, "directory A"),
    createSession(baseUrl, workspaceB, "directory B"),
  ]);
  const providerStart = provider.requests.length;
  await Promise.all([
    promptAsync(baseUrl, workspaceA, sessionA.id, "prompt-A [hold]"),
    promptAsync(baseUrl, workspaceB, sessionB.id, "prompt-B [hold]"),
  ]);
  const concurrentRequests = await waitFor(
    () => provider.requests.slice(providerStart).filter((entry) => entry.serialized.includes("prompt-")).length >= 2
      ? provider.requests.slice(providerStart)
      : null,
    "A/B concurrent provider requests",
  );
  const sessionReadWithB = await getSession(baseUrl, workspaceB, sessionA.id);
  const sessionAResolvedDirectory = extractSessionDirectory(sessionReadWithB);
  const abortStatus = await abortSession(baseUrl, workspaceA, sessionA.id);
  const unaffectedB = await getSession(baseUrl, workspaceB, sessionB.id);
  const nestedSkills = await fetchSkills(baseUrl, join(workspaceA, "packages", "foo"));
  const concurrentSerialized = concurrentRequests.map((entry) => entry.serialized);
  const providerSawA = concurrentSerialized.some((value) => value.includes("prompt-A"));
  const providerSawB = concurrentSerialized.some((value) => value.includes("prompt-B"));
  const providerSawSkillDescriptions = {
    a: concurrentSerialized.some((value) => value.includes("effective-marker-A")),
    b: concurrentSerialized.some((value) => value.includes("effective-marker-B")),
  };
  const sessionPinned = sessionAResolvedDirectory === workspaceA;
  const gateACore = hardened.summary.sameNameIsolated &&
    providerSawA &&
    providerSawB &&
    providerSawSkillDescriptions.a &&
    providerSawSkillDescriptions.b &&
    provider.maxConcurrency() > 1 &&
    sessionPinned;
  result.gateA = {
    passed: gateACore,
    profile: hardened.summary.profile,
    pid: hardened.summary.pid,
    sameNameIsolated: hardened.summary.sameNameIsolated,
    concurrentPromptExecution: provider.maxConcurrency() > 1,
    providerSawPromptMarkers: { a: providerSawA, b: providerSawB },
    providerSawSkillDescriptions,
    sessionPinning: {
      sessionId: sessionA.id,
      requestedDirectory: workspaceB,
      resolvedDirectory: sessionAResolvedDirectory,
      passed: sessionPinned,
    },
    abortIsolation: {
      abortStatus,
      unaffectedBSessionId: unaffectedB?.id ?? null,
      passed: unaffectedB?.id === sessionB.id,
    },
    nestedDirectory: {
      directory: join(workspaceA, "packages", "foo"),
      sameNameDescription: findSkill(nestedSkills, "same-name")?.description ?? null,
      createsRootEquivalentView: findSkill(nestedSkills, "same-name")?.description === "effective-marker-A",
    },
    eventRouting: {
      status: "not-covered-by-raw-opencode-probe",
      requiredFollowUp: "Veslo event router must prove directory-or-immutable-session identity for every lifecycle event",
    },
  };

  // Gate B records policy closure for both isolated profiles. The production
  // pooled profile keeps project agents/commands/plugins through a separate
  // Veslo config projection, never through raw project skill discovery.
  const hardenedPolicyClosed =
    hardened.summary.sameNameIsolated &&
    hardened.summary.managedOverlayWins &&
    !hardened.summary.rawOmittedVisible.a &&
    !hardened.summary.rawOmittedVisible.b &&
    !hardened.summary.inheritedConfigSkillVisible &&
    hardened.summary.externalVisible.length === 0;
  const normalPolicyClosed =
    normal.summary.sameNameIsolated &&
    normal.summary.managedOverlayWins &&
    !normal.summary.rawOmittedVisible.a &&
    !normal.summary.rawOmittedVisible.b &&
    !normal.summary.inheritedConfigSkillVisible &&
    normal.summary.externalVisible.length === 0 &&
    normal.summary.projectInstructionVisible === true;
  result.gateB = {
    passed: hardenedPolicyClosed && normalPolicyClosed,
    hardened: { closed: hardenedPolicyClosed, ...hardened.summary },
    normalPooledProjection: {
      policyClosed: normalPolicyClosed,
      projectRuntimeProjectionRequired: true,
      ...normal.summary,
    },
    mixedProfilePlacement: {
      passed: false,
      status: "requires-veslo-placement-implementation",
      requirement: "normal and hardened launch-policy profiles must never share one OpenCode process",
    },
  };

  // Gate C proves only the upstream disposal capability. Admission draining for
  // an active A run is Veslo-owned and is intentionally reported separately.
  const disposalSessionA = await createSession(baseUrl, workspaceA, "disposal A");
  const disposalSessionB = await createSession(baseUrl, workspaceB, "disposal B");
  const beforeA = await fetchSkills(baseUrl, workspaceA);
  const beforeB = await fetchSkills(baseUrl, workspaceB);
  await writeEffectiveSkill(workspaceA, "same-name", "A2");
  const staleA = await fetchSkills(baseUrl, workspaceA);
  const bProviderStart = provider.requests.length;
  await promptAsync(baseUrl, workspaceB, disposalSessionB.id, "prompt-B-disposal [hold]");
  await waitFor(
    () => provider.requests.slice(bProviderStart).some((entry) => entry.serialized.includes("prompt-B-disposal")) ? true : null,
    "B provider stream before A disposal",
  );
  const pidBeforeDisposal = hardenedRuntime.child.pid ?? null;
  const disposal = await requestJson(baseUrl, "/instance/dispose", { method: "POST", directory: workspaceA });
  assert.equal(disposal.response.ok, true, `A disposal failed: ${disposal.response.status} ${JSON.stringify(disposal.body)}`);
  const refreshedA = await waitFor(async () => {
    const skills = await fetchSkills(baseUrl, workspaceA);
    return findSkill(skills, "same-name")?.description === "effective-marker-A2" ? skills : null;
  }, "A fresh skill view after directory disposal");
  const afterB = await fetchSkills(baseUrl, workspaceB);
  const reusedA = await getSession(baseUrl, workspaceA, disposalSessionA.id);
  const bStillRunningDuringDisposal = provider.activeCount() > 0;
  const aAfterDisposalProviderStart = provider.requests.length;
  await promptAsync(baseUrl, workspaceA, disposalSessionA.id, "prompt-A-after-disposal");
  const aAfterDisposalRequest = await waitFor(
    () => provider.requests.slice(aAfterDisposalProviderStart).find((entry) => entry.serialized.includes("prompt-A-after-disposal")) ?? null,
    "A prompt after directory disposal",
  );
  const pidAfterDisposal = hardenedRuntime.child.pid ?? null;
  const gateCUpstreamPassed =
    pidBeforeDisposal === pidAfterDisposal &&
    findSkill(beforeA, "same-name")?.description === "effective-marker-A" &&
    findSkill(staleA, "same-name")?.description === "effective-marker-A" &&
    findSkill(refreshedA, "same-name")?.description === "effective-marker-A2" &&
    findSkill(beforeB, "same-name")?.description === "effective-marker-B" &&
    findSkill(afterB, "same-name")?.description === "effective-marker-B" &&
    extractSessionDirectory(reusedA) === workspaceA &&
    aAfterDisposalRequest.serialized.includes("effective-marker-A2");
  result.gateC = {
    passed: false,
    upstreamDirectoryDisposalPassed: gateCUpstreamPassed,
    pidBeforeDisposal,
    pidAfterDisposal,
    disposalStatus: disposal.response.status,
    aRevision: {
      before: findSkill(beforeA, "same-name")?.description ?? null,
      staleBeforeDispose: findSkill(staleA, "same-name")?.description ?? null,
      afterDispose: findSkill(refreshedA, "same-name")?.description ?? null,
    },
    bRevision: {
      before: findSkill(beforeB, "same-name")?.description ?? null,
      afterADispose: findSkill(afterB, "same-name")?.description ?? null,
      providerStreamObservedDuringDispose: bStillRunningDuringDisposal,
    },
    reusedSession: {
      id: disposalSessionA.id,
      resolvedDirectory: extractSessionDirectory(reusedA),
      promptSawNewSkillDescription: aAfterDisposalRequest.serialized.includes("effective-marker-A2"),
    },
    activeRunAdmission: {
      status: "requires-veslo-admission-implementation",
      requirement: "a reload for active A must drain/defer before disposal while B continues",
    },
  };

  result.fallbackRequired = !(result.gateA.passed && result.gateB.passed && result.gateC.passed);
  result.ok = true;
} catch (error) {
  result.errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  await stop(normalRuntime?.child);
  await stop(hardenedRuntime?.child);
  await new Promise((resolveClose) => provider.server.close(() => resolveClose()));
  await mkdir(artifactDir, { recursive: true });
  await writeFile(join(artifactDir, "opencode-directory-scoped-skills.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await rm(root, { recursive: true, force: true });
}

console.log(JSON.stringify({ ...result, artifactDir }, null, 2));
if (!result.ok) process.exitCode = 1;
