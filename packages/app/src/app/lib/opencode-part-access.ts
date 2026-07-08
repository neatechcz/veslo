import type { Part } from "@opencode-ai/sdk/v2/client";

type PartObject = Record<string, unknown>;

function partObject(part: Part): PartObject {
  return part as unknown as PartObject;
}

export function partText(part: Part): string {
  const value = partObject(part).text;
  return typeof value === "string" ? value : "";
}

export function toolNameFromPart(part: Part): string {
  if (part.type !== "tool") return "";
  const value = partObject(part).tool;
  return typeof value === "string" ? value : "";
}

export function toolStateFromPart(part: Part): PartObject {
  if (part.type !== "tool") return {};
  const value = partObject(part).state;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as PartObject
    : {};
}

export function toolOutputSizeFromPart(part: Part): number {
  const output = toolStateFromPart(part).output;
  if (typeof output === "string") return output.length;
  if (Array.isArray(output)) return output.length;
  return 0;
}
