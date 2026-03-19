export const resolveShortComposerDisclaimer = (disclaimer: string): string => {
  const text = disclaimer.trim();
  if (!text) return "";

  const match = text.match(/^[\s\S]*?[.!?。！？]/u);
  if (match?.[0]) {
    return match[0].trim();
  }

  return text;
};
