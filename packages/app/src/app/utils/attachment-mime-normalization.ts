import JSZip from "jszip";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOCX_DOCUMENT_XML_PATH = "word/document.xml";

const XML_ENTITY_REPLACEMENTS: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
};

const decodeXmlEntities = (value: string) =>
  value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (_full, token: string) => {
    if (token.startsWith("#x") || token.startsWith("#X")) {
      const codePoint = Number.parseInt(token.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : _full;
    }
    if (token.startsWith("#")) {
      const codePoint = Number.parseInt(token.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : _full;
    }
    return XML_ENTITY_REPLACEMENTS[token] ?? _full;
  });

const extractDocxText = (documentXml: string) =>
  decodeXmlEntities(
    documentXml
      .replace(/<w:tab\b[^>]*\/>/gi, "\t")
      .replace(/<(?:w:br|w:cr)\b[^>]*\/>/gi, "\n")
      .replace(/<\/w:p>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const isDocxFile = (file: File) =>
  file.type === DOCX_MIME || file.name.toLowerCase().endsWith(".docx");

const toTxtFilename = (name: string) => {
  const trimmed = name.trim();
  if (!trimmed) return "attachment.txt";
  const withoutDocx = trimmed.replace(/\.docx$/i, "");
  return `${withoutDocx || "attachment"}.txt`;
};

export const maybeConvertDocxToTextAttachment = async (file: File): Promise<File> => {
  if (!isDocxFile(file)) return file;

  try {
    const archive = await JSZip.loadAsync(await file.arrayBuffer());
    const documentXmlEntry = archive.file(DOCX_DOCUMENT_XML_PATH);
    if (!documentXmlEntry) return file;

    const documentXml = await documentXmlEntry.async("string");
    const extractedText = extractDocxText(documentXml);
    if (!extractedText) return file;

    return new File([extractedText], toTxtFilename(file.name), { type: "text/plain" });
  } catch {
    return file;
  }
};
