import type { ComposerDraft } from "../types";

export type ComposerTargetConflictDecision =
  | { kind: "none" }
  | { kind: "use-current" }
  | { kind: "load-destination" }
  | { kind: "conflict"; currentPreview: string; destinationPreview: string };

const compactWhitespace = (text: string) => text.replace(/\s+/g, " ").trim();

export function composerDraftHasMeaningfulContent(draft: ComposerDraft | null | undefined): boolean {
  if (!draft) {
    return false;
  }

  if (draft.text.trim() || (draft.resolvedText ?? "").trim()) {
    return true;
  }

  if (draft.attachments.length > 0) {
    return true;
  }

  return draft.parts.some((part) => part.type !== "text" || part.text.trim().length > 0);
}

export function draftPreviewText(draft: ComposerDraft | null | undefined): string {
  if (!draft) {
    return "";
  }

  const text = compactWhitespace(draft.text) || compactWhitespace(draft.resolvedText ?? "");
  if (text) {
    return text;
  }

  const attachmentName = draft.attachments[0]?.name.trim();
  if (attachmentName) {
    return attachmentName;
  }

  return draft.parts.some((part) => part.type !== "text") ? "Příloha nebo odkaz" : "";
}

function draftEquivalenceSignature(draft: ComposerDraft | null | undefined): string {
  if (!draft) {
    return "";
  }

  return JSON.stringify({
    mode: draft.mode,
    text: compactWhitespace(draft.text),
    resolvedText: compactWhitespace(draft.resolvedText ?? ""),
    command: draft.command
      ? {
          name: draft.command.name,
          arguments: draft.command.arguments,
        }
      : null,
    parts: draft.parts.map((part) => {
      if (part.type === "text") {
        return { type: part.type, text: compactWhitespace(part.text) };
      }
      if (part.type === "agent") {
        return { type: part.type, name: part.name };
      }
      if (part.type === "file") {
        return { type: part.type, path: part.path, label: part.label ?? "" };
      }
      return {
        type: part.type,
        id: part.id,
        label: part.label,
        text: part.text,
        lines: part.lines,
      };
    }),
    attachments: draft.attachments.map((attachment) => ({
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
      kind: attachment.kind,
    })),
  });
}

export function resolveComposerTargetConflict(input: {
  current: ComposerDraft;
  destination: ComposerDraft | null;
}): ComposerTargetConflictDecision {
  const currentHasContent = composerDraftHasMeaningfulContent(input.current);
  const destinationHasContent = composerDraftHasMeaningfulContent(input.destination);

  if (!currentHasContent && !destinationHasContent) {
    return { kind: "none" };
  }

  if (currentHasContent && !destinationHasContent) {
    return { kind: "use-current" };
  }

  if (!currentHasContent && destinationHasContent) {
    return { kind: "load-destination" };
  }

  const currentPreview = draftPreviewText(input.current);
  const destinationPreview = draftPreviewText(input.destination);

  if (draftEquivalenceSignature(input.current) === draftEquivalenceSignature(input.destination)) {
    return { kind: "load-destination" };
  }

  return { kind: "conflict", currentPreview, destinationPreview };
}
