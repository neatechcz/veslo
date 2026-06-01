import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type LiveFeedbackYouTrackConfig = {
  projectKey: string;
  baseUrl: string | null;
  token: string | null;
  requestTimeoutMs: number;
  pollTimeoutMs: number;
  pollIntervalMs: number;
  fetchImpl?: typeof fetch;
};

export type YouTrackIssue = {
  id: string;
  summary: string | null;
  url: string | null;
  description?: string | null;
};

export type LiveFeedbackArtifact = {
  runId: string;
  title: string;
  expectedSummary: string;
  description: string;
  submittedAt: string;
  denAuth: {
    denApiBase: string | null;
    orgId: string | null;
    userEmail: string | null;
  } | null;
  youtrackIssue?: YouTrackIssue;
};

type YouTrackRestIssue = {
  idReadable?: string;
  id?: string;
  summary?: string | null;
  description?: string | null;
};

function readPositiveNumber(raw: string | undefined, fallback: number, label: string) {
  const parsed = Number(raw ?? String(fallback));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }
  return parsed;
}

function trimBaseUrl(value: string | null) {
  return value?.trim().replace(/\/+$/, "") || null;
}

function buildIssueUrl(baseUrl: string, issueId: string) {
  return `${trimBaseUrl(baseUrl)}/issue/${encodeURIComponent(issueId)}`;
}

export function buildYouTrackFeedbackQuery(projectKey: string, title: string) {
  const escapedTitle = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `project: ${projectKey} "${escapedTitle}"`;
}

export function extractYouTrackIssues(result: unknown, baseUrl = "https://youtrack.example.test"): YouTrackIssue[] {
  if (!Array.isArray(result)) return [];

  return result.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const issue = entry as YouTrackRestIssue;
    const id = issue.idReadable ?? issue.id;
    if (!id) return [];
    const normalizedIssue: YouTrackIssue = {
      id,
      summary: issue.summary ?? null,
      url: buildIssueUrl(baseUrl, id),
    };
    if (issue.description) {
      normalizedIssue.description = issue.description;
    }
    return [normalizedIssue];
  });
}

export function resolveLiveFeedbackYouTrackConfig(
  env: NodeJS.ProcessEnv = process.env,
): LiveFeedbackYouTrackConfig {
  return {
    projectKey: env.E2E_YOUTRACK_PROJECT_KEY?.trim() || env.YOUTRACK_PROJECT_KEY?.trim() || "VSLO",
    baseUrl: trimBaseUrl(env.E2E_YOUTRACK_URL?.trim() || env.YOUTRACK_URL?.trim() || null),
    token: env.E2E_YOUTRACK_TOKEN?.trim() || env.YOUTRACK_TOKEN?.trim() || null,
    requestTimeoutMs: readPositiveNumber(env.E2E_YOUTRACK_TIMEOUT_MS ?? env.YOUTRACK_TIMEOUT_MS, 20_000, "E2E_YOUTRACK_TIMEOUT_MS"),
    pollTimeoutMs: readPositiveNumber(env.E2E_YOUTRACK_POLL_TIMEOUT_MS, 180_000, "E2E_YOUTRACK_POLL_TIMEOUT_MS"),
    pollIntervalMs: readPositiveNumber(env.E2E_YOUTRACK_POLL_INTERVAL_MS, 5_000, "E2E_YOUTRACK_POLL_INTERVAL_MS"),
  };
}

export function assertYouTrackRestConfigAvailable(config: Pick<LiveFeedbackYouTrackConfig, "baseUrl" | "token">) {
  if (!config.baseUrl || !config.token) {
    throw new Error("YouTrack REST config is missing. Set E2E_YOUTRACK_URL and E2E_YOUTRACK_TOKEN for the live feedback smoke.");
  }
}

export async function searchYouTrackFeedbackIssue(config: LiveFeedbackYouTrackConfig, title: string) {
  assertYouTrackRestConfigAvailable(config);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const params = new URLSearchParams({
      fields: "id,idReadable,summary,description",
      query: buildYouTrackFeedbackQuery(config.projectKey, title),
      $top: "10",
    });
    const response = await (config.fetchImpl ?? fetch)(new URL(`/api/issues?${params}`, config.baseUrl ?? ""), {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${config.token}`,
      },
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`YouTrack REST search failed with HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    const expectedSummary = `[Bug] ${title}`;
    return extractYouTrackIssues(JSON.parse(text), config.baseUrl ?? undefined)
      .find((issue) => issue.summary === expectedSummary || issue.summary?.includes(title)) ?? null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function waitForYouTrackFeedbackIssue(config: LiveFeedbackYouTrackConfig, title: string) {
  const deadline = Date.now() + config.pollTimeoutMs;
  let lastError: string | null = null;

  while (Date.now() < deadline) {
    try {
      const issue = await searchYouTrackFeedbackIssue(config, title);
      if (issue) return issue;
      lastError = null;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }

  const suffix = lastError ? ` Last YouTrack REST error: ${lastError}` : "";
  throw new Error(`Timed out waiting for a YouTrack issue for feedback title "${title}".${suffix}`);
}

export function writeLiveFeedbackArtifact(artifact: LiveFeedbackArtifact) {
  const outputDir = join(process.cwd(), ".tmp-live-feedback-youtrack");
  mkdirSync(outputDir, { recursive: true });
  const outputPath = join(outputDir, "latest.json");
  writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return outputPath;
}
