export type WorkspaceInfo = {
  id: string;
  name: string;
  path: string;
  preset: string;
  workspaceType: "local" | "remote";
  remoteType?: "veslo" | "opencode" | null;
  baseUrl?: string | null;
  directory?: string | null;
  displayName?: string | null;
  vesloHostUrl?: string | null;
  vesloToken?: string | null;
  vesloWorkspaceId?: string | null;
  vesloWorkspaceName?: string | null;
  missing?: boolean | null;
};

export type ScheduledJobRun = {
  prompt?: string;
  command?: string;
  arguments?: string;
  files?: string[];
  agent?: string;
  model?: string;
  variant?: string;
  title?: string;
  share?: boolean;
  continue?: boolean;
  session?: string;
  runFormat?: string;
  attachUrl?: string;
  port?: number;
};

export type ScheduledJob = {
  scopeId?: string;
  timeoutSeconds?: number;
  invocation?: { command: string; args: string[] };
  slug: string;
  name: string;
  schedule: string;
  prompt?: string;
  attachUrl?: string;
  run?: ScheduledJobRun;
  source?: string;
  workdir?: string;
  createdAt: string;
  updatedAt?: string;
  lastRunAt?: string;
  lastRunExitCode?: number;
  lastRunError?: string;
  lastRunSource?: string;
  lastRunStatus?: string;
};

export type OpencodeConfigFile = {
  path: string;
  exists: boolean;
  content: string | null;
};
