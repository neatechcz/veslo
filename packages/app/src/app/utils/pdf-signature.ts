const PDF_HEADER = "%PDF-";

const decodePrefixText = (prefix: Uint8Array): string => {
  if (!prefix.length) return "";
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(prefix);
  return decoded.replace(/^\uFEFF/, "").trimStart().toLowerCase();
};

export const looksLikeHtmlDocumentPrefix = (prefix: Uint8Array): boolean => {
  const text = decodePrefixText(prefix);
  if (!text) return false;
  return (
    text.startsWith("<!doctype html") ||
    text.startsWith("<html") ||
    text.startsWith("<?xml") ||
    text.startsWith("<head") ||
    text.startsWith("<body")
  );
};

export const looksLikePdfDocumentPrefix = (prefix: Uint8Array): boolean => {
  if (!prefix.length) return false;
  if (looksLikeHtmlDocumentPrefix(prefix)) return false;

  const headerBytes = new TextEncoder().encode(PDF_HEADER);
  const maxOffset = Math.max(0, Math.min(prefix.length - headerBytes.length, 1024));

  for (let offset = 0; offset <= maxOffset; offset += 1) {
    let matched = true;
    for (let index = 0; index < headerBytes.length; index += 1) {
      if (prefix[offset + index] !== headerBytes[index]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }

  return false;
};
