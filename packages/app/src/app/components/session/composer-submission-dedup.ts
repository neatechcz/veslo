import type { ComposerDraft } from "../../types";

function textFingerprint(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b1;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${value.length}:${first >>> 0}:${second >>> 0}`;
}

function partFingerprint(draft: ComposerDraft): string[] {
  return draft.parts.map((part) => {
    if (part.type === "text") return `text:${textFingerprint(part.text)}`;
    if (part.type === "agent") return `agent:${textFingerprint(part.name)}`;
    if (part.type === "file") return `file:${textFingerprint(part.path)}:${textFingerprint(part.label ?? "")}`;
    return [
      "paste",
      textFingerprint(part.id),
      textFingerprint(part.label),
      textFingerprint(part.text),
      String(part.lines),
    ].join(":");
  });
}

function fingerprintForDraft(draft: ComposerDraft): string {
  return JSON.stringify({
    mode: draft.mode,
    parts: partFingerprint(draft),
    command: draft.command
      ? [textFingerprint(draft.command.name), textFingerprint(draft.command.arguments)]
      : null,
    attachmentIds: draft.attachments.map((attachment) => textFingerprint(attachment.id)),
  });
}

/**
 * Prevents one unchanged composer draft from being admitted more than once
 * while its first send is still being handed to the runtime. This is local to
 * a Composer instance: subsequent, changed drafts can still enter the normal
 * server-owned queue while a run is streaming.
 */
export function createComposerSubmissionDeduplication() {
  const pendingFingerprints = new Set<string>();

  return {
    acquire(draft: ComposerDraft): string | null {
      const fingerprint = fingerprintForDraft(draft);
      if (pendingFingerprints.has(fingerprint)) return null;
      pendingFingerprints.add(fingerprint);
      return fingerprint;
    },
    release(fingerprint: string): void {
      pendingFingerprints.delete(fingerprint);
    },
  };
}
