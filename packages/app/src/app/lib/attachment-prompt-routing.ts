import type { ComposerAttachment, ComposerDraft, ModelRef, ProviderListItem } from "../types";

export type StagedSessionAttachment = {
  name: string;
  kind: ComposerAttachment["kind"];
  mimeType: string;
  relativePath: string;
  absolutePath: string;
};

type RouteStagedAttachmentsForModelInput = {
  draft: ComposerDraft;
  stagedAttachments: StagedSessionAttachment[];
  model: ModelRef;
  providers: ProviderListItem[];
};

type RouteStagedAttachmentsForModelResult = {
  draft: ComposerDraft;
  system?: string;
};

const appendPathsToText = (base: string | undefined, paths: string[]) => {
  if (!paths.length) return base;

  const trimmed = (base ?? "").trim();
  return trimmed ? `${trimmed}\n${paths.join("\n")}` : paths.join("\n");
};

const appendPathsToDraft = (draft: ComposerDraft, relativePaths: string[]): ComposerDraft => {
  if (!relativePaths.length) return draft;

  return {
    ...draft,
    resolvedText: appendPathsToText(draft.resolvedText ?? draft.text, relativePaths),
    command: draft.command
      ? {
          ...draft.command,
          arguments: appendPathsToText(draft.command.arguments, relativePaths) ?? "",
        }
      : draft.command,
  };
};

const modelSupportsInlineImages = (model: ModelRef, providers: ProviderListItem[]) => {
  const provider = providers.find((entry) => entry.id === model.providerID);
  const modelInfo = provider?.models?.[model.modelID];
  return Boolean(modelInfo?.modalities?.input?.includes("image"));
};

const buildNonVisionImageFallback = (absolutePaths: string[]) => {
  const instructions = [
    "The user attached image files, but the selected model cannot inspect inline images directly.",
    "Keep the user-visible attachment in context, but inspect the image by calling the read tool on these exact absolute paths:",
    ...absolutePaths.map((path) => `- ${path}`),
    "Treat those files as the canonical image inputs for the user's latest request.",
    "Do not use glob, find, ls, search, or guess alternative screenshot paths.",
    "Do not tell the user the image is unavailable when the exact file path is listed above.",
  ];

  return instructions.join("\n");
};

export function routeStagedAttachmentsForModel(
  input: RouteStagedAttachmentsForModelInput,
): RouteStagedAttachmentsForModelResult {
  const stagedImages = input.stagedAttachments.filter((attachment) => attachment.kind === "image");
  const usesPathBasedAttachments = input.draft.mode === "shell" || Boolean(input.draft.command);
  const stagedPathsForPrompt = input.stagedAttachments
    .filter((attachment) => attachment.kind !== "image" || usesPathBasedAttachments)
    .map((attachment) => attachment.relativePath);

  const nextDraft = appendPathsToDraft(input.draft, stagedPathsForPrompt);
  if (!stagedImages.length) {
    return { draft: nextDraft };
  }

  if (usesPathBasedAttachments || modelSupportsInlineImages(input.model, input.providers)) {
    return { draft: nextDraft };
  }

  return {
    draft: nextDraft,
    system: buildNonVisionImageFallback(stagedImages.map((attachment) => attachment.absolutePath)),
  };
}
