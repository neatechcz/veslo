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
  error?: string;
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
  return Boolean(modelInfo?.modalities?.input?.includes("image") || modelInfo?.attachment);
};

const NON_VISION_IMAGE_ERROR =
  "The selected model cannot inspect image attachments. Switch to a model with image input and send again.";

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
    error: NON_VISION_IMAGE_ERROR,
  };
}
