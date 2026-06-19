import { resolve } from "node:path";

import type { ManagedSkillSource, ResourceOwner } from "./types.js";

export const LOCAL_USER_RESOURCE_OWNER_ID = "local";
export const PLATFORM_RESOURCE_OWNER_ID = "veslo-platform";

const clean = (value: string | null | undefined): string => String(value ?? "").trim();

const normalizedRoot = (root: string | null | undefined): string | undefined => {
  const trimmed = clean(root);
  return trimmed ? resolve(trimmed).replace(/\\/g, "/") : undefined;
};

const withOptionalFields = (
  owner: ResourceOwner,
  input: { label?: string | null; root?: string | null },
): ResourceOwner => {
  const label = clean(input.label);
  const root = normalizedRoot(input.root);
  return {
    ...owner,
    ...(label ? { label } : {}),
    ...(root ? { root } : {}),
  };
};

export function workspaceResourceOwner(input: {
  workspaceId?: string | null;
  label?: string | null;
  root?: string | null;
}): ResourceOwner {
  const root = normalizedRoot(input.root);
  return withOptionalFields(
    {
      kind: "workspace",
      id: clean(input.workspaceId) || (root ? `root:${root}` : "workspace"),
    },
    input,
  );
}

export function localUserResourceOwner(input: {
  userId?: string | null;
  label?: string | null;
  root?: string | null;
} = {}): ResourceOwner {
  return withOptionalFields(
    {
      kind: "user",
      id: clean(input.userId) || LOCAL_USER_RESOURCE_OWNER_ID,
    },
    input,
  );
}

export function organizationResourceOwner(input: {
  orgId?: string | null;
  label?: string | null;
}): ResourceOwner {
  return withOptionalFields(
    {
      kind: "organization",
      id: clean(input.orgId) || "organization",
    },
    input,
  );
}

export function platformResourceOwner(input: {
  platformId?: string | null;
  label?: string | null;
} = {}): ResourceOwner {
  return withOptionalFields(
    {
      kind: "platform",
      id: clean(input.platformId) || PLATFORM_RESOURCE_OWNER_ID,
    },
    input,
  );
}

export function managedSkillSourceResourceOwner(
  source: ManagedSkillSource,
  input: {
    userId?: string | null;
    orgId?: string | null;
    workspaceId?: string | null;
    workspaceRoot?: string | null;
    label?: string | null;
  } = {},
): ResourceOwner {
  if (source === "personal") {
    return localUserResourceOwner({ userId: input.userId, label: input.label });
  }
  if (source === "workspace") {
    return workspaceResourceOwner({
      workspaceId: input.workspaceId,
      root: input.workspaceRoot,
      label: input.label,
    });
  }
  if (source === "organization") {
    return organizationResourceOwner({ orgId: input.orgId, label: input.label });
  }
  return platformResourceOwner({ label: input.label });
}

export function resourceOwnerKey(owner: ResourceOwner): string {
  return `${owner.kind}:${owner.id}`;
}
