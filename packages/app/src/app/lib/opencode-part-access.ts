import type { Part } from "@opencode-ai/sdk/v2/client";

export type PartObject = Record<string, unknown>;

export function partRecord(part: Part): PartObject {
  return part as unknown as PartObject;
}

export function partStringField(part: Part, key: string): string {
  const value = partRecord(part)[key];
  return typeof value === "string" ? value : "";
}

export function partObjectField(part: Part, key: string): PartObject {
  const value = partRecord(part)[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as PartObject
    : {};
}

export function partText(part: Part): string {
  return partStringField(part, "text");
}

export function toolNameFromPart(part: Part): string {
  if (part.type !== "tool") return "";
  return partStringField(part, "tool");
}

export function toolStateFromPart(part: Part): PartObject {
  if (part.type !== "tool") return {};
  return partObjectField(part, "state");
}

export function toolInputFromPart(part: Part): PartObject {
  const value = toolStateFromPart(part).input;
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
