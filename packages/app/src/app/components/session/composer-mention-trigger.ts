export type ComposerMentionTrigger = {
  start: number;
  end: number;
  query: string;
};

export function findMentionTrigger(text: string, caretOffset: number): ComposerMentionTrigger | null {
  const offset = Math.max(0, Math.min(caretOffset, text.length));
  const beforeCaret = text.slice(0, offset);
  const atIndex = beforeCaret.lastIndexOf("@");

  if (atIndex === -1) return null;
  if (atIndex > 0 && !/\s/.test(beforeCaret[atIndex - 1] ?? "")) return null;

  const query = beforeCaret.slice(atIndex + 1);
  if (/\s/.test(query)) return null;

  return {
    start: atIndex,
    end: offset,
    query,
  };
}
